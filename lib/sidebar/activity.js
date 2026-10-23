// Part of bin/tmux-sidebar; see the comment at the top of that file.
//
// What happened across the tabs, for mission control's Activity view: each
// refresh compares every tab with how it was, and a change worth catching up
// on is recorded: a turn finished, Claude started working or asks you
// something, checks started failing, the PR joined the merge queue or merged,
// a tab opened or closed. The newest MAX are kept in memory and in
// activity.jsonl in the state directory, so a restart doesn't lose them.

const fs = require("node:fs");
const path = require("node:path");
const { STATE_DIR } = require("./config");

const MAX = 200;
const FILE = () => path.join(STATE_DIR, "activity.jsonl");

let events;
// Each tab's last known { state, merge, fail }, by window ID; undefined until
// the first refresh, which only takes note, so a restart reports nothing.
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

const push = (tab, kind, text) => {
  const event = { at: Date.now(), id: tab.id, index: tab.index, name: tab.name, kind, ...(text ? { text } : {}) };
  load().push(event);
  if (events.length > MAX) events.splice(0, events.length - MAX);
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    // Written whole now and then, so the file stays near MAX lines.
    if (fs.existsSync(FILE()) && fs.statSync(FILE()).size > 256 * 1024) fs.writeFileSync(FILE(), events.map((e) => JSON.stringify(e)).join("\n") + "\n", { mode: 0o600 });
    else fs.appendFileSync(FILE(), JSON.stringify(event) + "\n", { mode: 0o600 });
  } catch {}
};

// Background work is still work.
const doing = (state) => (state === "background" ? "working" : state);

const record = (tabs) => {
  load();
  const seen = new Set();
  const first = !last;
  last ??= new Map();
  tabs.forEach((tab) => {
    seen.add(tab.id);
    const now = { state: doing(tab.state), merge: tab.merge, fail: tab.checks?.fail ?? 0 };
    const was = last.get(tab.id);
    last.set(tab.id, now);
    if (first) return;
    if (!was) return push(tab, "opened");
    if (was.state !== now.state) {
      if (now.state === "done") push(tab, "finished");
      else if (now.state === "waiting") push(tab, "waiting on you", tab.wait);
      else if (now.state === "working" && was.state !== "waiting") push(tab, "started working", tab.activity);
    }
    if (now.merge && was.merge !== now.merge) push(tab, now.merge === "merged" ? "merged" : "joined the merge queue", tab.pr && `#${tab.pr}`);
    if (now.fail && !was.fail) push(tab, "checks failing", `✗${now.fail}${tab.pr ? ` on #${tab.pr}` : ""}`);
  });
  if (first) return;
  [...last.keys()].filter((id) => !seen.has(id)).forEach((id) => {
    const gone = events.findLast((e) => e.id === id);
    push({ id, index: gone?.index, name: gone?.name ?? id }, "closed");
    last.delete(id);
  });
};

// Newest first, as the view's items.
const ATTENTION = new Set(["finished", "waiting on you", "checks failing"]);
const activityItems = (tabs) =>
  [...load()].reverse().map((e) => ({
    title: `${e.kind.padEnd(22)} ${e.index ?? ""} ${e.name}`,
    detail: e.text ?? "",
    state: ATTENTION.has(e.kind) ? "attention" : e.kind === "started working" ? "active" : "idle",
    time: e.at,
    tab: tabs.find((t) => t.id === e.id),
  }));

// For the tests: forget everything, as a fresh daemon would.
const resetActivity = () => {
  events = undefined;
  last = undefined;
};

module.exports = { record, activityItems, resetActivity };
