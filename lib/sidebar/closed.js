// Part of bin/tmux-sidebar; see the comment at the top of that file.
//
// The tabs that closed, for mission control's Closed view (closedItems),
// which reopens one where it was with its Claude session resumed: each
// refresh compares the tabs with how they were, and a tab gone since records
// its name, directory and session. The newest MAX are kept in memory and in
// closed.jsonl in the state directory, so a restart doesn't lose them.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { STATE_DIR } = require("./config");
const { ago } = require("./text");

const MAX = 200;
const FILE = () => path.join(STATE_DIR, "closed.jsonl");

let events;
// Each tab's last known { name, index, path, session, seen }, by window ID;
// undefined until the first refresh, which only takes note, so a restart
// reports nothing.
let last;

const load = () => {
  if (events) return events;
  try {
    events = fs.readFileSync(FILE(), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)).slice(-MAX);
  } catch {
    events = [];
  }
  return events;
};

const push = (event) => {
  load().push(event);
  if (events.length > MAX) events.splice(0, events.length - MAX);
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    // Written whole now and then, so the file stays near MAX lines.
    if (fs.existsSync(FILE()) && fs.statSync(FILE()).size > 64 * 1024) fs.writeFileSync(FILE(), events.map((e) => JSON.stringify(e)).join("\n") + "\n", { mode: 0o600 });
    else fs.appendFileSync(FILE(), JSON.stringify(event) + "\n", { mode: 0o600 });
  } catch {}
};

const record = (tabs) => {
  load();
  const seen = new Set();
  const first = !last;
  last ??= new Map();
  tabs.forEach((tab) => {
    seen.add(tab.id);
    // Where it was and its Claude session as last seen, for reopening it once
    // it closes, and since when it has been seen.
    last.set(tab.id, { name: tab.name, index: tab.index, path: tab.path, session: tab.claude?.sessionId, seen: last.get(tab.id)?.seen ?? Date.now() });
  });
  if (first) return;
  [...last.entries()].filter(([id]) => !seen.has(id)).forEach(([id, was]) => {
    push({ at: Date.now(), id, index: was.index, name: was.name ?? id, kind: "closed", path: was.path, session: was.session, lived: Date.now() - was.seen });
    last.delete(id);
  });
};

// Mission control's Closed view: the tabs closed most recently first, one
// per Claude conversation, leaving out one a tab has open again, so several
// tabs closed in the same repository are each listed; a tab with no
// conversation, one per directory no tab is open in. A window that came and
// went within seconds (a tool's, before it was marked parked) is left out.
// Enter reopens one there, resuming its Claude session, or with a shell if it
// had none. x removes one: its conversation, or a shell's directory, is left
// out from then on up to the time it closed (STATE_DIR/closed-removed.json),
// so it comes back only if it is closed again.
const BRIEF_MS = 10_000;
const SESSION = /^[A-Za-z0-9-]+$/;
const home = os.homedir();
const REMOVED = () => path.join(STATE_DIR, "closed-removed.json");
const removedClosed = () => {
  try {
    return JSON.parse(fs.readFileSync(REMOVED(), "utf8"));
  } catch {
    return {};
  }
};
// Removes a closed tab from the view: { key, at } as closedItems gives it.
// Entries for closings no longer in the log go with it.
const removeClosed = ({ key, at }) => {
  const removed = { ...removedClosed(), [key]: at };
  const oldest = load()[0]?.at ?? 0;
  Object.keys(removed).filter((k) => removed[k] < oldest).forEach((k) => delete removed[k]);
  fs.writeFileSync(`${REMOVED()}.tmp`, JSON.stringify(removed));
  fs.renameSync(`${REMOVED()}.tmp`, REMOVED());
};
const closedItems = (tabs) => {
  const listed = new Set();
  const removed = removedClosed();
  return [...load()]
    .reverse()
    .filter((e) => {
      if (e.kind !== "closed" || !e.path || e.lived < BRIEF_MS) return false;
      const session = SESSION.test(e.session ?? "") ? e.session : undefined;
      const open = session ? tabs.some((t) => t.claude?.sessionId === session) : tabs.some((t) => t.path === e.path);
      const key = session ?? `dir:${e.path}`;
      return !open && !(e.at <= (removed[key] ?? 0)) && !listed.has(key) && listed.add(key);
    })
    .map((e) => {
      const session = SESSION.test(e.session ?? "") ? e.session : undefined;
      return {
        title: e.name,
        detail: [`closed ${ago(Math.floor(e.at / 1000))} ago`, session ? "resumes its Claude" : "a shell", e.path.startsWith(home) ? `~${e.path.slice(home.length)}` : e.path].join(" · "),
        state: "idle",
        time: e.at,
        dir: e.path,
        command: session && `zsh -i -c 'claude --resume ${session}; exec zsh -i'`,
        shell: !session,
        closed: { key: session ?? `dir:${e.path}`, at: e.at },
      };
    });
};

// For the tests: forget everything, as a fresh daemon would.
const resetClosed = () => {
  events = undefined;
  last = undefined;
};

module.exports = { record, closedItems, removeClosed, resetClosed };
