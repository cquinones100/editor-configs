// Part of bin/tmux-sidebar; see the comment at the top of that file.
//
// What happened across the tabs, for mission control's Activity view: each
// refresh compares every tab with how it was, and a change worth catching up
// on is recorded: a turn finished, Claude started working or asks you
// something, checks started failing, the PR joined the merge queue or merged,
// a tab opened or closed. The newest MAX are kept in memory and in
// activity.jsonl in the state directory, so a restart doesn't lose them.
//
// A tab closing records its directory and Claude session too, for mission
// control's Closed view (closedItems), which reopens one where it was with
// that session resumed.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { STATE_DIR } = require("./config");
const { ago } = require("./text");

const MAX = 200;
const FILE = () => path.join(STATE_DIR, "activity.jsonl");

let events;
// Each tab's last known { state, merge, fail, name, index, path, session,
// seen }, by window ID; undefined until the first refresh, which only takes
// note, so a restart reports nothing.
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
  const event = { at: Date.now(), id: tab.id, index: tab.index, name: tab.name, kind, ...(text ? { text } : {}), ...(kind === "closed" ? { path: tab.path, session: tab.session, lived: tab.lived } : {}) };
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
    const was = last.get(tab.id);
    // Where it was and its Claude session as last seen, for reopening it once
    // it closes, and since when it has been seen.
    const now = { state: doing(tab.state), merge: tab.merge, fail: tab.checks?.fail ?? 0, name: tab.name, index: tab.index, path: tab.path, session: tab.claude?.sessionId, seen: was?.seen ?? Date.now() };
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
  [...last.entries()].filter(([id]) => !seen.has(id)).forEach(([id, was]) => {
    push({ id, index: was.index, name: was.name ?? id, path: was.path, session: was.session, lived: Date.now() - was.seen }, "closed");
    last.delete(id);
  });
};

// How long a turn took: "<1m", "3m", "1h 20m".
const span = (ms) => {
  const m = Math.floor(ms / 60_000);
  return m < 1 ? "<1m" : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ""}`;
};

// Newest first, as the view's items. A tab's turn is one line, at its end:
// its "started working" folded into the "finished" that ended it, saying how
// long it worked and what it started on. A turn still going keeps its
// "started working" line. A question asked in the middle keeps its own.
const ATTENTION = new Set(["finished", "waiting on you", "checks failing"]);
const turns = (events) => {
  const started = new Map();
  const out = [];
  events.forEach((e) => {
    if (e.kind === "started working") {
      started.set(e.id, out.length);
      out.push(e);
    } else if (e.kind === "finished" && started.has(e.id)) {
      const start = out[started.get(e.id)];
      out[started.get(e.id)] = undefined;
      started.delete(e.id);
      out.push({ ...e, kind: `worked ${span(e.at - start.at)} · finished`, finished: true, text: start.text });
    } else {
      if (e.kind === "closed") started.delete(e.id);
      out.push(e);
    }
  });
  return out.filter(Boolean);
};
const activityItems = (tabs) =>
  turns(load()).reverse().map((e) => ({
    title: `${e.kind.padEnd(22)} ${e.index ?? ""} ${e.name}`,
    detail: e.text ?? "",
    state: ATTENTION.has(e.kind) || e.finished ? "attention" : e.kind === "started working" ? "active" : "idle",
    time: e.at,
    tab: tabs.find((t) => t.id === e.id),
  }));

// Mission control's Closed view: the tabs closed most recently first, one
// per Claude conversation, leaving out one a tab has open again, so several
// tabs closed in the same repository are each listed; a tab with no
// conversation, one per directory no tab is open in. A window that came and
// went within seconds (a tool's, before it was marked parked) is left out.
// Enter reopens one there, resuming its Claude session, or with a shell if it
// had none.
const BRIEF_MS = 10_000;
const SESSION = /^[A-Za-z0-9-]+$/;
const home = os.homedir();
const closedItems = (tabs) => {
  const listed = new Set();
  return [...load()]
    .reverse()
    .filter((e) => {
      if (e.kind !== "closed" || !e.path || e.lived < BRIEF_MS) return false;
      const session = SESSION.test(e.session ?? "") ? e.session : undefined;
      const open = session ? tabs.some((t) => t.claude?.sessionId === session) : tabs.some((t) => t.path === e.path);
      const key = session ?? `dir:${e.path}`;
      return !open && !listed.has(key) && listed.add(key);
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
      };
    });
};

// For the tests: forget everything, as a fresh daemon would.
const resetActivity = () => {
  events = undefined;
  last = undefined;
};

module.exports = { record, activityItems, closedItems, resetActivity };
