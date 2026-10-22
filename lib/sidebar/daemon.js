// Part of bin/tmux-sidebar; see the comment at the top of that file.
//
// The one process behind every sidebar and mission control. It reads tmux in
// a single list-panes when something changed (a nudge) or every POLL_MS,
// keeps the sidebar panes in place, and draws each client's frame, writing
// only when a frame differs from the last one sent. Clients connect over a
// Unix socket in a directory only you can read, say which pane or popup they
// are on, and send their keys.

const fs = require("node:fs");
const net = require("node:net");
const config = require("./config");
const { snapshot, batch, clientFor, tryTmux } = require("./tmux");
const { tabsFrom, grouped } = require("./model");
const { sidebarLines, missionLines, missionGrid, missionCardWidth, frame } = require("./render");
const { reconcile, shq } = require("./panes");
const { parseKeys } = require("./keys");
const { loadPlugins, refreshSection, schedulePlugins, openItem } = require("./plugins");
const { PR_POLL_MS, mergeOf, fetchMerges } = require("./prs");

const log = (...parts) => {
  try {
    if (fs.statSync(config.LOG_FILE).size > 1024 * 1024) fs.truncateSync(config.LOG_FILE, 0);
  } catch {}
  try {
    fs.appendFileSync(config.LOG_FILE, `${new Date().toISOString()} ${parts.join(" ")}\n`, { mode: 0o600 });
  } catch {}
};

const state = {
  snap: undefined,
  tabs: [],
  sections: [],
  timers: [],
  config: config.readConfig(),
  configTime: 0,
  clients: new Set(),
  // The sidebar's chosen tab per session, while one has focus.
  cursors: new Map(),
  frame: 0,
  misses: 0,
};

const mtime = (file) => {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
};

// The config is read again, and the plugins loaded again, whenever it changes.
const loadConfig = () => {
  const time = mtime(config.CONFIG_FILE);
  if (time === state.configTime && state.configTime) return;
  state.configTime = time || 1;
  state.config = config.readConfig();
  state.timers.forEach(clearInterval);
  state.sections.forEach((s) => delete require.cache[s.file]);
  state.sections = loadPlugins(state.config, log);
  state.timers = schedulePlugins(state.sections, () => drawAll(), log);
};

// ── Refreshing ──────────────────────────────────────────────────────────────

let running;
let again = false;
const refresh = async () => {
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    do {
      again = false;
      loadConfig();
      try {
        if (fs.statSync(config.NUDGE).size > 4096) fs.truncateSync(config.NUDGE, 0);
      } catch {}
      const snap = await snapshot();
      if (!snap) {
        // No tmux server: the sidebars went with it.
        if (++state.misses >= 3) shutdown("tmux server is gone");
        continue;
      }
      state.misses = 0;
      let tabs = tabsFrom(snap);
      if (await reconcile(snap, tabs, state.config, log)) {
        const after = await snapshot();
        if (after) {
          state.snap = after;
          tabs = tabsFrom(after);
        }
      } else {
        state.snap = snap;
      }
      // Each tab's PR in the merge queue or merged, as last heard (see prs.js).
      tabs.forEach((tab) => Object.assign(tab, mergeOf(tab)));
      state.tabs = tabs;
      drawAll();
    } while (again);
  })();
  try {
    await running;
  } finally {
    running = undefined;
  }
};

let nudgeTimer;
const nudge = () => {
  clearTimeout(nudgeTimer);
  nudgeTimer = setTimeout(refresh, 30);
};

// ── Drawing ─────────────────────────────────────────────────────────────────

const sidebarPane = (client) => state.snap?.panes.find((p) => p.pane_id === client.pane);
const sessionTabs = (session) => state.tabs.filter((t) => t.session === session);
const sidebarOrder = (session) => grouped(sessionTabs(session)).flatMap((g) => g.tabs);
// Mission control's order, its stages in turn (see missionGrid).
const missionOrder = () => missionGrid(state.tabs).order;

const draw = (client) => {
  let lines;
  let title;
  if (client.kind === "sidebar") {
    const pane = sidebarPane(client);
    if (!pane) return;
    const focused = pane.pane_active === "1";
    // Coming into the sidebar starts at its first tab, the one that needs you most.
    if (focused && !client.focused) state.cursors.set(pane.session_id, sidebarOrder(pane.session_id)[0]?.id ?? pane.window_id);
    client.focused = focused;
    client.cols = Number(pane.pane_width);
    client.rows = Number(pane.pane_height);
    const cursor = state.cursors.get(pane.session_id) ?? pane.window_id;
    const out = sidebarLines({
      tabs: sessionTabs(pane.session_id),
      sections: state.sections,
      cols: client.cols,
      rows: client.rows,
      view: { focused, cursor, frame: state.frame, here: pane.window_id },
    });
    lines = out.lines;
    client.owners = out.owners;
    title = config.TITLE;
  } else {
    // Tabs close and plugins go while it is open.
    const view = client.view;
    if (view.view > state.sections.length) view.view = 0;
    const count = view.view === 0 ? state.tabs.length : state.sections[view.view - 1].items.length;
    view.cursor = Math.max(0, Math.min(view.cursor, count - 1));
    lines = missionLines({ tabs: state.tabs, sections: state.sections, cols: client.cols, rows: client.rows, view: { ...client.view, frame: state.frame }, config: state.config });
  }
  const size = `${client.cols}x${client.rows}`;
  const text = (client.size === size ? "" : "\x1b[2J") + frame(lines, title);
  client.size = size;
  if (text === client.last) return;
  client.last = text;
  client.socket.write(text);
};

const drawAll = () => state.clients.forEach(draw);

// The spinner turns only where you can see it: a sidebar in the window in
// front of you, or mission control.
const visible = (client) => {
  if (client.kind === "mission") return true;
  const pane = sidebarPane(client);
  return pane && pane.window_active === "1" && pane.session_attached !== "0";
};
const spin = () => {
  if (!state.tabs.some((t) => t.state === "working")) return;
  state.frame++;
  state.clients.forEach((client) => visible(client) && draw(client));
};

// ── Acting on tmux ──────────────────────────────────────────────────────────

// Goes to a tab and puts the cursor in its main pane, from a sidebar (which
// gives focus back to its own window's main pane first) or from mission
// control (whose popup is closed first). `key`, when given, is then pressed
// there, as if typed, so it runs whatever tmux binds it to.
const goTo = async (tab, { client, from, popup, key }) => {
  if (!tab || !state.snap) return;
  // One failed command stops the ones after it, so a client that has gone
  // is left out rather than named.
  const current = state.snap.clients.find((c) => c.name === client);
  const commands = [];
  if (popup && current) commands.push(["display-popup", "-C", "-c", client]);
  if (from) commands.push(["last-pane", "-t", from]);
  commands.push(["select-window", "-t", tab.id]);
  if (tab.sidebarActive && tab.id !== from) commands.push(["last-pane", "-t", tab.id]);
  if (current && current.session !== tab.session) commands.push(["switch-client", "-c", client, "-t", tab.id]);
  await batch(commands);
  if (key && current) await batch([["send-keys", "-K", "-c", client, key]]);
  nudge();
};

const openMission = (client) => {
  if (!client) return;
  // Not awaited: tmux holds the command until the popup closes.
  tryTmux(["display-popup", "-c", client, "-E", "-B", "-x", "0", "-y", "0", "-w", "100%", "-h", "100%", `exec ${shq(config.CLIENT)} mission ${shq(config.SOCKET)} ${shq(client)}`]);
};

// ── Keys ────────────────────────────────────────────────────────────────────

const sidebarKey = async (client, { key, mouse }) => {
  const pane = sidebarPane(client);
  if (!pane) return;
  const session = pane.session_id;
  const order = sidebarOrder(session);
  const at = Math.max(0, order.findIndex((t) => t.id === (state.cursors.get(session) ?? pane.window_id)));
  const move = (to) => {
    if (!order.length) return;
    state.cursors.set(session, order[Math.max(0, Math.min(order.length - 1, to))].id);
    draw(client);
  };
  const tmuxClient = clientFor(state.snap, session);
  const from = pane.window_id;
  if (mouse) {
    if (mouse.button === 64) return move(at - 1);
    if (mouse.button === 65) return move(at + 1);
    const owner = client.owners?.[mouse.y - 1];
    if (mouse.button === 0 && mouse.press && owner) return goTo(state.tabs.find((t) => t.id === owner), { client: tmuxClient, from });
    return;
  }
  switch (key) {
    case "j": case "Down": case "C-n": return move(at + 1);
    case "k": case "Up": case "C-p": return move(at - 1);
    case "g": case "Home": return move(0);
    case "G": case "End": return move(order.length - 1);
    case "Enter": case "l": case "Right": return goTo(order[at], { client: tmuxClient, from });
    case "Escape": case "h": case "Left": case "q":
      await batch([["last-pane", "-t", from]]);
      return nudge();
    case "m": case "Tab": return openMission(tmuxClient);
    case "p": case ":": return goTo(order[at], { client: tmuxClient, from, key: "M-p" });
    default:
      if (/^[1-9]$/.test(key)) return goTo(sessionTabs(session).find((t) => t.index === Number(key)), { client: tmuxClient, from });
      // Any other Alt or Ctrl key runs in the chosen tab, as if pressed there.
      if (/^[MC]-/.test(key)) return goTo(order[at], { client: tmuxClient, from, key });
  }
};

const missionKey = async (client, { key }) => {
  const view = client.view;
  const section = state.sections[view.view - 1];
  const order = view.view === 0 ? missionOrder() : section.items;
  // j/k move a row in the tabs view, keeping the column as far as the row
  // reaches; stages start new rows, so rows differ in length.
  const { rows } = missionGrid(state.tabs, client.cols, missionCardWidth(client.cols, state.config));
  // A card in a shorter box spans several rows, so moving down starts from
  // the last row it is in and moving up from the first.
  const rowStep = (by) => {
    const holding = rows.map((row, i) => (row.cards.includes(view.cursor) ? i : -1)).filter((i) => i >= 0);
    if (!holding.length) return view.cursor;
    const at = by > 0 ? holding.at(-1) : holding[0];
    const next = rows[at + by];
    if (!next) return view.cursor;
    return next.cards[Math.min(rows[at].cards.indexOf(view.cursor), next.cards.length - 1)];
  };
  const move = (to) => {
    view.cursor = Math.max(0, Math.min(order.length - 1, to));
    draw(client);
  };
  const switchView = (by) => {
    const count = state.sections.length + 1;
    view.view = (view.view + by + count) % count;
    view.cursor = 0;
    draw(client);
  };
  const close = () => client.socket.end();
  const tab = view.view === 0 ? order[view.cursor] : undefined;
  switch (key) {
    case "h": case "Left": return move(view.view === 0 ? view.cursor - 1 : view.cursor);
    case "l": case "Right": return move(view.view === 0 ? view.cursor + 1 : view.cursor);
    case "j": case "Down": return move(view.view === 0 ? rowStep(1) : view.cursor + 1);
    case "k": case "Up": return move(view.view === 0 ? rowStep(-1) : view.cursor - 1);
    case "g": case "Home": return move(0);
    case "G": case "End": return move(order.length - 1);
    case "Tab": case "]": return switchView(1);
    case "BTab": case "[": return switchView(-1);
    case "Escape": case "q": case "C-c": case "M-Space": return close();
    case "r":
      if (section) refreshSection(section, drawAll, log);
      return draw(client);
    case "Enter":
      if (tab) return goTo(tab, { client: client.tmuxClient, popup: true });
      if (section && order[view.cursor]) return openItem(section, order[view.cursor], log);
      return;
    case "p": case ":": return tab && goTo(tab, { client: client.tmuxClient, popup: true, key: "M-p" });
    default:
      if (view.view === 0 && /^[1-9]$/.test(key)) {
        const index = order.findIndex((t) => t.index === Number(key));
        return index >= 0 && move(index);
      }
      if (tab && /^[MC]-/.test(key)) return goTo(tab, { client: client.tmuxClient, popup: true, key });
  }
};

// ── Clients ─────────────────────────────────────────────────────────────────

// A client's first line says what it is: "sidebar <pane>" or
// "mission <tmux client> <columns> <rows>". Everything after is keys.
const accept = (socket) => {
  const client = { socket, kind: undefined, pending: "" };
  socket.setEncoding("utf8");
  socket.on("error", () => {});
  socket.on("close", () => state.clients.delete(client));
  socket.on("data", async (data) => {
    if (!client.kind) {
      client.pending += data;
      const end = client.pending.indexOf("\n");
      if (end === -1) return;
      const [kind, ...args] = client.pending.slice(0, end).trim().split(/\s+/);
      data = client.pending.slice(end + 1);
      if (kind === "sidebar" && /^%\d+$/.test(args[0])) {
        Object.assign(client, { kind, pane: args[0] });
        // Clicks and the wheel come to the sidebar as escape sequences.
        socket.write("\x1b[2J\x1b[?1000h\x1b[?1006h");
      } else if (kind === "mission") {
        Object.assign(client, { kind, tmuxClient: args[0], cols: Number(args[1]) || 120, rows: Number(args[2]) || 40, view: { view: 0, cursor: 0 } });
      } else {
        return socket.end();
      }
      state.clients.add(client);
      if (kind === "sidebar") await refresh();
      else draw(client);
      if (!data) return;
    }
    for (const key of parseKeys(data)) {
      if (client.kind === "sidebar") await sidebarKey(client, key);
      else await missionKey(client, key);
    }
  });
};

// ── Starting and stopping ──────────────────────────────────────────────────

let server;
let watcher;
let intervals = [];
// Closes everything start opened; the tests call it, and shutdown before it
// exits.
const stop = () => {
  intervals.forEach(clearInterval);
  state.timers.forEach(clearInterval);
  watcher?.close();
  state.clients.forEach((client) => client.socket.destroy());
  try {
    server?.close();
    fs.unlinkSync(config.SOCKET);
  } catch {}
  try {
    if (fs.readFileSync(config.LOCK, "utf8").trim() === String(process.pid)) fs.unlinkSync(config.LOCK);
  } catch {}
};
const shutdown = (why) => {
  log(`stopping: ${why}`);
  stop();
  process.exit(0);
};

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
};

// One daemon at a time: the lock file holds its pid, and one whose process
// has gone is taken over.
const lock = () => {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(config.LOCK, String(process.pid), { flag: "wx", mode: 0o600 });
      return true;
    } catch {
      const pid = Number(fs.readFileSync(config.LOCK, "utf8"));
      if (pid && alive(pid)) return false;
      fs.rmSync(config.LOCK, { force: true });
    }
  }
  return false;
};

const start = () => {
  fs.mkdirSync(config.STATE_DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(config.STATE_DIR, 0o700);
  if (!lock()) return false;
  fs.rmSync(config.SOCKET, { force: true });
  server = net.createServer(accept);
  server.listen(config.SOCKET, () => fs.chmodSync(config.SOCKET, 0o600));
  if (!fs.existsSync(config.NUDGE)) fs.writeFileSync(config.NUDGE, "", { mode: 0o600 });
  watcher = fs.watch(config.STATE_DIR, (_, name) => name === "nudge" && nudge());
  const merges = () => fetchMerges(state.tabs, () => refresh(), log);
  // The first ask soon after starting, then every PR_POLL_MS; clearInterval
  // stops a timeout too.
  intervals = [setInterval(refresh, config.POLL_MS), setInterval(spin, config.SPINNER_MS), setInterval(merges, PR_POLL_MS), setTimeout(merges, 2_000)];
  ["SIGTERM", "SIGINT"].forEach((signal) => process.on(signal, () => shutdown(signal)));
  // Started with nohup from a shell that goes away.
  process.on("SIGHUP", () => {});
  // A mistake in drawing one frame or handling one key is logged, and the
  // sidebars carry on.
  process.on("uncaughtException", (err) => log(`error: ${err.stack ?? err}`));
  process.on("unhandledRejection", (err) => log(`error: ${err?.stack ?? err}`));
  log(`started, pid ${process.pid}`);
  refresh();
  return true;
};

module.exports = { start, stop, refresh, state, draw, sidebarKey, missionKey, goTo, log, accept };
