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
const path = require("node:path");
const config = require("./config");
const { snapshot, batch, clientFor, tryTmux } = require("./tmux");
const { tabsFrom, grouped, frozenFrom } = require("./model");
const { sidebarLines, missionLines, missionGrid, missionCardWidth, frame, helpLines, helpModal, HELP, answerLines, peekLines, confirmLines } = require("./render");
const { execFile, spawn } = require("node:child_process");
// A command's success, never through a shell.
const run = (command, args) => new Promise((resolve) => execFile(command, args, { timeout: 30_000 }, (err) => resolve(!err)));
const { promptOf, answer } = require("./answer");
const { reconcile, shq } = require("./panes");
const { parseKeys } = require("./keys");
const { loadPlugins, refreshSection, schedulePlugins, openItem } = require("./plugins");
const { PR_POLL_MS, mergeOf, fetchMerges } = require("./prs");
const { builtInViews, refreshWorktrees, refreshRevived, untabbed } = require("./views");
const { record } = require("./activity");
const { BOARD_POLL_MS, fetchBoard } = require("./prboard");

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
  // Sessions whose sidebar focus moved to another window's sidebar while
  // browsing (see sidebarKey), so the cursor stays where it was.
  browsing: new Set(),
  // Each session's tab layout (see frozenFrom) from when its sidebar took
  // focus, kept until no sidebar there has it, so tabs hold still while you
  // browse them: going to a tab marks it seen, and states change on their own.
  frozen: new Map(),
  // Each session's sidebar / filter, { text, typing }, while its sidebar has
  // focus: the tabs whose title has the text, in every window's sidebar.
  filters: new Map(),
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
      // A window holding a parked pane is not a tab of yours.
      state.tabs = tabs.filter((tab) => !tab.parked);
      [...state.frozen.keys()].filter((session) => !state.tabs.some((t) => t.session === session && t.current && t.sidebarActive)).forEach((session) => state.frozen.delete(session));
      [...state.filters.keys()].filter((session) => !state.frozen.has(session)).forEach((session) => state.filters.delete(session));
      // What changed since the last look, for the Activity view.
      record(state.tabs);
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
// A session's tabs as its sidebar lists them: all, or those whose title has
// its / filter's text.
const filteredTabs = (session) => {
  const text = state.filters.get(session)?.text.trim().toLowerCase();
  return sessionTabs(session).filter((t) => !text || t.name.toLowerCase().includes(text));
};
const sidebarOrder = (session) => grouped(filteredTabs(session), state.frozen.get(session)).flatMap((g) => g.tabs);
// Mission control's order, its stages in turn (see missionGrid).
// The tabs a mission control client shows: all, or those its / filter
// matches by name, number, PR or directory.
const shownTabs = (client) => {
  const text = client?.filter?.text?.trim().toLowerCase();
  if (!text) return state.tabs;
  return state.tabs.filter((t) => [t.name, String(t.index), t.pr && `#${t.pr}`, t.path].some((field) => field?.toLowerCase().includes(text)));
};
const missionOrder = (client) => missionGrid(shownTabs(client)).order;
// Mission control's views after its tabs: the built-in ones (views.js), then
// the plugins'.
const missionViews = () => [...builtInViews(state), ...state.sections];
// The views as one mission control client sees them: the Work map scoped to
// open tabs or to work with no tab (M-j, M-o), and any list narrowed by its /
// filter, which matches an item's title and detail. The PR board isn't.
const viewsFor = (client) => {
  const text = client.filter?.text?.trim().toLowerCase();
  return missionViews().map((section) => {
    const scope = section.title === "Work map" && client.scope;
    if (!scope && (!text || section.board)) return section;
    const items = section.items.filter((item) => (!scope || (scope === "tabs") === Boolean(item.tab)) && (!text || `${item.title} ${item.detail}`.toLowerCase().includes(text)));
    return { ...section, items, title: scope ? `${section.title} · ${scope === "tabs" ? "open tabs" : "no tab"}` : section.title };
  });
};

const draw = (client) => {
  let lines;
  let title;
  if (client.kind === "sidebar") {
    const pane = sidebarPane(client);
    if (!pane) return;
    const focused = pane.pane_active === "1";
    // Coming into the sidebar starts on the tab you are in; browsing into
    // another window's sidebar keeps the cursor.
    if (focused && !client.focused && !state.browsing.delete(pane.session_id)) {
      state.frozen.set(pane.session_id, frozenFrom(sessionTabs(pane.session_id)));
      state.cursors.set(pane.session_id, pane.window_id);
    }
    client.focused = focused;
    client.cols = Number(pane.pane_width);
    client.rows = Number(pane.pane_height);
    const cursor = state.cursors.get(pane.session_id) ?? pane.window_id;
    const out = sidebarLines({
      tabs: filteredTabs(pane.session_id),
      frozen: state.frozen.get(pane.session_id),
      sections: state.sections,
      cols: client.cols,
      rows: client.rows,
      view: { focused, cursor, frame: state.frame, here: pane.window_id, filter: state.filters.get(pane.session_id) },
    });
    lines = out.lines;
    client.owners = out.owners;
    title = config.TITLE;
  } else {
    // Tabs close and plugins go while it is open.
    const view = client.view;
    const views = viewsFor(client);
    if (view.view > views.length) view.view = 0;
    const count = view.view === 0 ? shownTabs(client).length : views[view.view - 1].items.length;
    view.cursor = Math.max(0, Math.min(view.cursor, count - 1));
    lines = missionLines({ tabs: shownTabs(client), sections: views, cols: client.cols, rows: client.rows, view: { ...client.view, frame: state.frame, filter: client.filter, note: client.note }, config: state.config });
    // Where clicks land (see missionLines), unless something covers it.
    client.hits = client.confirm || client.answering || client.peek || client.help ? [] : lines.hits ?? [];
    if (client.confirm) lines = confirmLines(client.confirm, client.cols, client.rows);
  }
  // ? shows the view's keys over it, until the next key.
  if (client.answering) lines = answerLines(client.answering, client.cols, client.rows);
  if (client.peek) {
    const out = peekLines(client.peek, client.cols, client.rows);
    lines = out.lines;
    client.peek.most = out.most;
  }
  // The sidebar's ? popup (see openMission) is the keys alone; mission
  // control's are a box over it.
  if (client.helpOnly) lines = helpLines("sidebar", client.cols, client.rows);
  const size = `${client.cols}x${client.rows}`;
  const text = (client.size === size ? "" : "\x1b[2J") + frame(lines, title) + (client.help ? helpModal(client.kind, client.cols, client.rows) : "");
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

// d and L: diffview or lazygit in place of a tab's pane, or for a worktree no
// tab is in, in a popup there (tmux/pane-in-place.sh).
const TOOLS = { d: "diffview", L: "lazygit" };
const INPLACE = () => path.join(path.dirname(config.CLIENT), "pane-in-place.sh");
const openTool = async (key, { tab, dir, client, from, popup }) => {
  const tool = TOOLS[key];
  if (tab) {
    const pane = tab.panes.find((p) => p.pane_active === "1") ?? tab.panes[0];
    await goTo(tab, { client, from, popup });
    if (pane && tab.path) await run(INPLACE(), ["open", tool, pane.pane_id, tab.path, client]);
    return;
  }
  if (!dir || !client) return;
  if (popup) await batch([["display-popup", "-C", "-c", client]]);
  // Not waited on: the script holds until the popup closes.
  spawn(INPLACE(), ["popup", tool, dir, client], { detached: true, stdio: "ignore" }).unref();
};

// `only`, "peek:<window>" or "answer:<window>", opens a smaller popup with
// just that screen for that tab, closed when you are done with it, for the
// sidebar's Space and a; "help", one just big enough for the sidebar's keys,
// for its ?.
const helpSize = () => ["-w", String(Math.max(...HELP.sidebar.map(([k, what]) => k.length + what.length)) + 8), "-h", String(HELP.sidebar.length + 6), "-T", " Keys "];
const openMission = (client, only) => {
  if (!client) return;
  const size = only === "help" ? helpSize() : only ? ["-w", "90%", "-h", "85%", "-T", only.startsWith("peek") ? " Peek " : " Answer "] : ["-B", "-x", "0", "-y", "0", "-w", "100%", "-h", "100%"];
  // Not awaited: tmux holds the command until the popup closes.
  tryTmux(["display-popup", "-c", client, "-E", ...size, `exec ${shq(config.CLIENT)} mission ${shq(config.SOCKET)} ${shq(client)}${only ? ` ${shq(only)}` : ""}`]);
};

// ── Keys ────────────────────────────────────────────────────────────────────

const sidebarKey = async (client, { key, mouse }) => {
  const pane = sidebarPane(client);
  if (!pane) return;
  const session = pane.session_id;
  const order = sidebarOrder(session);
  const at = Math.max(0, order.findIndex((t) => t.id === (state.cursors.get(session) ?? pane.window_id)));
  const tmuxClient = clientFor(state.snap, session);
  // Moving the cursor shows that tab: its window comes to the front, with
  // focus in its own sidebar, so browsing goes on there and Enter or Esc
  // drops into its pane. A window too narrow for a sidebar takes focus itself.
  const move = async (to) => {
    if (!order.length) return;
    const tab = order[Math.max(0, Math.min(order.length - 1, to))];
    state.cursors.set(session, tab.id);
    if (tab.id === pane.window_id) return draw(client);
    if (tab.sidebar) state.browsing.add(session);
    await batch([["select-window", "-t", tab.id], ...(tab.sidebar ? [["select-pane", "-t", tab.sidebar.pane_id]] : [])]);
    nudge();
  };
  const from = pane.window_id;
  // Typing a / filter: letters go into it and the cursor goes to the first
  // tab it leaves; the arrows move, Enter goes to the chosen tab, and Esc
  // clears it.
  const filter = state.filters.get(session);
  const refilter = () => {
    state.cursors.set(session, sidebarOrder(session)[0]?.id ?? pane.window_id);
    drawAll();
  };
  if (filter?.typing && !mouse) {
    if (["Up", "Down", "C-p", "C-n"].includes(key)) return move(at + (key === "Up" || key === "C-p" ? -1 : 1));
    if (key === "Enter") {
      const shown = sidebarOrder(session);
      const chosen = shown.find((t) => t.id === state.cursors.get(session)) ?? shown[0];
      state.filters.delete(session);
      return chosen && goTo(chosen, { client: tmuxClient, from });
    }
    if (key === "Escape" || key === "C-c") state.filters.delete(session);
    else if (key === "BSpace") filter.text = filter.text.slice(0, -1);
    else if (key === "Space") filter.text += " ";
    else if (PRINTABLE.test(key)) filter.text += key;
    return refilter();
  }
  if (mouse) {
    if (mouse.button === 64) return move(at - 1);
    if (mouse.button === 65) return move(at + 1);
    const owner = client.owners?.[mouse.y - 1];
    if (mouse.button === 0 && mouse.press && owner) return goTo(state.tabs.find((t) => t.id === owner), { client: tmuxClient, from });
    // A right click peeks at it, as Space does.
    if (mouse.button === 2 && mouse.press && owner) return openMission(tmuxClient, `peek:${owner}`);
    return;
  }
  switch (key) {
    case "j": case "Down": case "C-n": return move(at + 1);
    case "k": case "Up": case "C-p": return move(at - 1);
    case "g": case "Home": return move(0);
    case "G": case "End": return move(order.length - 1);
    case "Enter": case "l": case "Right": return goTo(order[at], { client: tmuxClient, from });
    case "/":
      state.filters.set(session, { text: filter?.text ?? "", typing: true });
      return refilter();
    case "Escape": case "h": case "Left": case "q": case "C-c":
      // Esc clears a kept filter before it backs out.
      if (filter && key === "Escape") {
        state.filters.delete(session);
        return refilter();
      }
      await batch([["last-pane", "-t", from]]);
      return nudge();
    case "m": case "Tab": return openMission(tmuxClient);
    // Space and a show mission control's peek and answer for the chosen tab.
    case "Space": return order[at] && openMission(tmuxClient, `peek:${order[at].id}`);
    case "a": return order[at]?.claudePane && openMission(tmuxClient, `answer:${order[at].id}`);
    case "p": case ":": return goTo(order[at], { client: tmuxClient, from, key: "M-p" });
    case "d": case "L": return openTool(key, { tab: order[at], client: tmuxClient, from });
    // A new tab running Claude, as M-t opens one, in the chosen tab's directory.
    case "n": return goTo(order[at], { client: tmuxClient, from, key: "M-t" });
    default:
      if (/^[1-9]$/.test(key)) return goTo(sessionTabs(session).find((t) => t.index === Number(key)), { client: tmuxClient, from });
      // Any other Alt or Ctrl key runs in the chosen tab, as if pressed there;
      // C-c backs out, as it closes every popup and tool in place.
      if (/^[MC]-/.test(key)) return goTo(order[at], { client: tmuxClient, from, key });
  }
};

// Keys while answering a tab (a in mission control): an option's number, s to
// submit one that takes several, t to type your own answer, or, with no
// prompt showing, a message typed and sent with Enter. Esc goes back.
const PRINTABLE = /^.$/u;
const answerKey = async (client, key) => {
  const a = client.answering;
  const done = async (said) => {
    a.note = said;
    a.text = "";
    a.typing = false;
    // A question of several shows the next in the same wait.
    a.found = await promptOf(a.tab);
    if (!a.found) client.answering = undefined;
    if (!client.answering && client.only) return client.socket.end();
    draw(client);
    nudge();
  };
  if (key === "Escape" || key === "C-c") {
    client.answering = undefined;
    if (client.only) return client.socket.end();
    return draw(client);
  }
  if (a.typing || !a.found) {
    if (key === "Enter") return done(await answer(a.tab, a.text));
    if (key === "BSpace") a.text = a.text.slice(0, -1);
    else if (key === "Space") a.text += " ";
    else if (PRINTABLE.test(key)) a.text += key;
    return draw(client);
  }
  if (/^[1-9]$/.test(key) || (key === "s" && a.found.multi)) return done(await answer(a.tab, key === "s" ? "submit" : key));
  if (key === "t" && a.found.free) {
    a.typing = true;
    return draw(client);
  }
};

// Keys while peeking at a tab (Space in mission control).
const capture = async (tab) => (await tryTmux(["capture-pane", "-p", "-J", "-t", tab.claudePane ?? tab.panes?.find((p) => p.pane_active === "1")?.pane_id ?? tab.id, "-S", "-200"])) ?? "";
const peekKey = async (client, key) => {
  const peek = client.peek;
  const scrollTo = (to) => {
    peek.scroll = Math.max(0, Math.min(peek.most ?? 0, to));
    draw(client);
  };
  const at = peek.scroll ?? peek.most ?? 0;
  switch (key) {
    case "j": case "Down": return scrollTo(at + 1);
    case "k": case "Up": return scrollTo(at - 1);
    case "C-d": case "PageDown": return scrollTo(at + Math.floor(client.rows / 2));
    case "C-u": case "PageUp": return scrollTo(at - Math.floor(client.rows / 2));
    case "g": case "Home": return scrollTo(0);
    case "G": case "End": return scrollTo(peek.most ?? 0);
    case "s":
      peek.mode = peek.mode === "screen" ? "turn" : "screen";
      if (peek.mode === "screen") peek.screen = await capture(peek.tab);
      peek.scroll = undefined;
      return draw(client);
    case "r":
      if (peek.mode === "screen") peek.screen = await capture(peek.tab);
      return draw(client);
    case "Enter":
      client.peek = undefined;
      return goTo(peek.tab, { client: client.tmuxClient, popup: true });
    case "Escape": case "q": case "Space": case "C-c":
      client.peek = undefined;
      if (client.only) return client.socket.end();
      return draw(client);
  }
};

// Typing a / filter: Enter keeps it, Esc clears it, and the arrows move. In
// M-j or M-o's picker, Enter goes to the chosen row and Esc closes.
const filterKey = async (client, key) => {
  const filter = client.filter;
  const move = { Up: "Up", Down: "Down", "C-p": "Up", "C-n": "Down" }[key];
  if (move || (client.picker && key === "Enter")) {
    filter.typing = false;
    await missionKey(client, { key: move ?? key });
    if (client.filter) filter.typing = true;
    return;
  }
  if (client.picker && (key === "Escape" || key === "C-c")) return client.socket.end();
  if (key === "Enter") filter.typing = false;
  else if (key === "Escape" || key === "C-c") client.filter = undefined;
  else if (key === "BSpace") filter.text = filter.text.slice(0, -1);
  else if (key === "Space") filter.text += " ";
  else if (PRINTABLE.test(key)) filter.text += key;
  client.view.cursor = 0;
  return draw(client);
};

// Closes every Merged tab and removes its worktree: `git worktree remove`
// without force, so one with changes not committed is kept and said, and one
// already gone is pruned. Returns what was done, in words.
const closeMerged = async (tabs) => {
  const kept = [];
  for (const tab of tabs) {
    const parts = tab.path && /^(.*)\/\.claude\/worktrees\/[^/]+$/.exec(tab.path);
    await tryTmux(["kill-window", "-t", tab.id]);
    if (!parts) continue;
    const removed = fs.existsSync(tab.path)
      ? await run("git", ["-C", parts[1], "worktree", "remove", tab.path])
      : await run("git", ["-C", parts[1], "worktree", "prune"]);
    if (!removed) kept.push(tab.path.split("/").pop());
  }
  return `Closed ${tabs.length} merged tab${tabs.length === 1 ? "" : "s"}${kept.length ? `; kept the worktree${kept.length === 1 ? "" : "s"} with uncommitted changes: ${kept.join(", ")}` : ""}.`;
};

// On the PR board, h and l go to the next column with PRs in it, at the same
// row as far as it reaches.
const columnStep = (section, cursor, by) => {
  const starts = section.columns.map((_, i) => section.columns.slice(0, i).reduce((n, c) => n + c.items.length, 0));
  const at = starts.findLastIndex((start, i) => cursor >= start && section.columns[i].items.length);
  const row = cursor - starts[at];
  for (let i = at + by; i >= 0 && i < section.columns.length; i += by) {
    if (section.columns[i].items.length) return starts[i] + Math.min(row, section.columns[i].items.length - 1);
  }
  return cursor;
};

// The mouse in mission control: the wheel moves to the next or last card or
// row (scrolls a peek), a click on a view's name switches to it, and a click on a card or a
// list's row chooses it, a second click on the chosen one going there as
// Enter does. Clicks do nothing while a prompt, a peek or the keys cover it.
const missionMouse = async (client, { button, x, y, press }) => {
  if (button === 64 || button === 65) {
    if (client.answering || client.confirm || client.help || (client.filter?.typing && !client.picker)) return;
    // Card by card on the tabs, as h and l, whose rows j and k move by.
    const cards = client.view.view === 0 && !client.peek;
    const back = cards ? "h" : "k";
    const on = cards ? "l" : "j";
    return missionKey(client, { key: button === 64 ? back : on });
  }
  if (button !== 0 || !press) return;
  const hit = (client.hits ?? []).find((h) => h.y === y && x >= h.x0 && x <= h.x1);
  if (!hit) return;
  const view = client.view;
  if (hit.view !== undefined) {
    if (hit.view === view.view) return;
    view.view = hit.view;
    view.cursor = 0;
    client.scope = undefined;
    return draw(client);
  }
  if (hit.index === view.cursor) return missionKey(client, { key: "Enter" });
  view.cursor = hit.index;
  draw(client);
};

const missionKey = async (client, { key, mouse }) => {
  if (mouse) return missionMouse(client, mouse);
  if (client.answering) return answerKey(client, key);
  if (client.peek) return peekKey(client, key);
  if (client.filter?.typing) return filterKey(client, key);
  if (client.confirm) {
    const { yes } = client.confirm;
    client.confirm = undefined;
    if (key === "y" || key === "Y") client.note = await yes();
    draw(client);
    return nudge();
  }
  // What the last action did stays in the footer until the next key.
  client.note = undefined;
  const view = client.view;
  const section = viewsFor(client)[view.view - 1];
  const order = view.view === 0 ? missionOrder(client) : section.items;
  // j/k move a row in the tabs view, keeping the column as far as the row
  // reaches; stages start new rows, so rows differ in length.
  const { rows } = missionGrid(shownTabs(client), client.cols, missionCardWidth(client.cols, state.config));
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
    const count = missionViews().length + 1;
    view.view = (view.view + by + count) % count;
    view.cursor = 0;
    client.scope = undefined;
    draw(client);
  };
  const close = () => client.socket.end();
  const tab = view.view === 0 ? order[view.cursor] : undefined;
  switch (key) {
    case "h": case "Left": return move(view.view === 0 ? view.cursor - 1 : section?.board ? columnStep(section, view.cursor, -1) : view.cursor);
    case "l": case "Right": return move(view.view === 0 ? view.cursor + 1 : section?.board ? columnStep(section, view.cursor, 1) : view.cursor);
    case "j": case "Down": return move(view.view === 0 ? rowStep(1) : view.cursor + 1);
    case "k": case "Up": return move(view.view === 0 ? rowStep(-1) : view.cursor - 1);
    case "g": case "Home": return move(0);
    case "G": case "End": return move(order.length - 1);
    case "Tab": case "]": return switchView(1);
    case "BTab": case "[": return switchView(-1);
    case "Escape":
      // Esc clears a filter before it closes mission control.
      if (client.filter) {
        client.filter = undefined;
        return draw(client);
      }
      return close();
    case "q": case "C-c": case "M-Space": return close();
    case "/":
      if (section?.board) return;
      client.filter = { text: client.filter?.text ?? "", typing: true };
      return draw(client);
    case "X": {
      const merged = state.tabs.filter((t) => t.merge === "merged" && t.state !== "waiting" && t.state !== "done");
      if (!merged.length) return;
      client.confirm = { text: `Close ${merged.length} merged tab${merged.length === 1 ? "" : "s"} and remove their worktrees? (y/n)`, list: merged.map((t) => `${t.index} ${t.name}`), yes: () => closeMerged(merged) };
      return draw(client);
    }
    case "r":
      if (section && !section.builtIn) refreshSection(section, drawAll, log);
      return draw(client);
    case "Enter": {
      if (tab) return goTo(tab, { client: client.tmuxClient, popup: true });
      const item = order[view.cursor];
      if (!section || !item) return;
      if (!section.builtIn) return openItem(section, item, log);
      // A built-in view's item: its tab, its URL, or a new tab in its directory.
      if (item.tab) return goTo(item.tab, { client: client.tmuxClient, popup: true });
      if (item.url) return run("open", [item.url]);
      // Work with no tab: a tab there, resuming its Claude with claude-here
      // (which an interactive zsh puts on the PATH), as wt-revive does. A
      // closed tab says its own command: its session resumed, or a shell.
      if (item.dir) {
        const command = item.command ?? (item.shell ? undefined : "zsh -i -c 'claude-here; exec zsh -i'");
        const id = (await tryTmux(["new-window", "-P", "-F", "#{window_id}", "-c", item.dir, ...(command ? [command] : [])]))?.trim();
        if (id) await batch([["display-popup", "-C", "-c", client.tmuxClient]]);
        return nudge();
      }
      return;
    }
    case "p": case ":": return tab && goTo(tab, { client: client.tmuxClient, popup: true, key: "M-p" });
    case "d": case "L": {
      const item = tab ? { tab } : order[view.cursor];
      return item && (item.tab || item.dir) && openTool(key, { tab: item.tab, dir: item.dir, client: client.tmuxClient, popup: true });
    }
    case "Space":
      if (!tab) return;
      // A tab without a Claude turn shows its screen.
      client.peek = tab.claude ? { tab, mode: "turn" } : { tab, mode: "screen", screen: await capture(tab) };
      return draw(client);
    case "a":
      if (!tab?.claudePane) return;
      client.answering = { tab, found: await promptOf(tab), text: "", typing: false };
      return draw(client);
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
        // Opened for one tab's peek or answer (see openMission): that screen
        // alone, and closing it closes the popup.
        // M-j and M-o open the Work map scoped to open tabs or to work with
        // no tab, typing a filter, as a picker (see filterKey).
        const [, scope] = /^work:(tabs|untabbed)$/.exec(args[3] ?? "") ?? [];
        if (scope) {
          Object.assign(client, { scope, picker: true, filter: { text: "", typing: true } });
          client.view.view = missionViews().findIndex((s) => s.title === "Work map") + 1;
          // What M-o lists is read again, and drawn when it comes.
          if (scope === "untabbed") refreshRevived().then(() => draw(client));
        }
        if (args[3] === "help") client.helpOnly = true;
        const [, what, id] = /^(peek|answer):(@\d+)$/.exec(args[3] ?? "") ?? [];
        const tab = id && state.tabs.find((t) => t.id === id);
        if (tab && what === "peek") client.peek = tab.claude ? { tab, mode: "turn" } : { tab, mode: "screen", screen: await capture(tab) };
        if (tab && what === "answer") client.answering = { tab, found: await promptOf(tab), text: "", typing: false };
        if (tab) client.only = true;
        else if (what) return socket.end();
        // Clicks and the wheel come as escape sequences, as in the sidebar.
        socket.write("\x1b[?1000h\x1b[?1006h");
      } else {
        return socket.end();
      }
      state.clients.add(client);
      if (kind === "sidebar") await refresh();
      else draw(client);
      if (!data) return;
    }
    for (const key of parseKeys(data)) {
      // The sidebar's ? popup closes on any key.
      if (client.helpOnly) return socket.end();
      // ? in the sidebar opens the keys in a popup over the window, since the
      // sidebar is too narrow for a box over it.
      if (client.kind === "sidebar" && key.key === "?") {
        const pane = sidebarPane(client);
        openMission(pane && clientFor(state.snap, pane.session_id), "help");
        continue;
      }
      // ? shows the keys; the next key only puts the view back.
      if (key.key === "?" || client.help) {
        client.help = key.key === "?" && !client.help;
        draw(client);
        continue;
      }
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
  // The work map's worktrees are read first, so those no tab is in are asked
  // about too.
  const merges = async () => {
    await Promise.all([refreshWorktrees(state.tabs), refreshRevived()]);
    await fetchMerges([...state.tabs, ...untabbed(state.tabs)], () => refresh(), log);
    drawAll();
  };
  const board = () => fetchBoard(state.tabs, () => drawAll(), log);
  // The first ask soon after starting, then every PR_POLL_MS; clearInterval
  // stops a timeout too.
  intervals = [setInterval(refresh, config.POLL_MS), setInterval(spin, config.SPINNER_MS), setInterval(merges, PR_POLL_MS), setTimeout(merges, 2_000), setInterval(board, BOARD_POLL_MS), setTimeout(board, 4_000)];
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

module.exports = { start, stop, refresh, state, draw, sidebarKey, missionKey, goTo, log, accept, viewsFor };
