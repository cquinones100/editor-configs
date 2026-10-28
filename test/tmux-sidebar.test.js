// Tests for bin/tmux-sidebar. Run with: node --test test/*.test.js
//
// Nothing here touches your real tabs or ~/.claude. Before the sidebar is
// loaded, HOME points at a temporary directory and TMUX at a tmux server of
// the tests' own, which every plain `tmux` command then talks to; the tests
// refuse to run unless that is so. The temporary directory is under /tmp
// rather than the system's temporary directory because a Unix socket's path
// can't be over 104 bytes on macOS. Its sidebar panes run the real zsh client
// against the tests' daemon.

const { test, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync, spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const tmp = fs.realpathSync(fs.mkdtempSync("/tmp/sbt-"));
const home = path.join(tmp, "home");
const socket = path.join(tmp, "tmux.sock");
fs.mkdirSync(path.join(home, ".claude/sessions"), { recursive: true });
fs.mkdirSync(path.join(home, ".claude/projects/-work"), { recursive: true });
fs.mkdirSync(path.join(home, ".config/tmux-sidebar/plugins"), { recursive: true });

// HOME is changed before the server starts, so nothing run in its panes (the
// sidebar client starts tmux/sidebar.sh) ever sees your real one.
const realTmux = process.env.TMUX;
delete process.env.TMUX;
delete process.env.TMUX_PANE;
Object.assign(process.env, { HOME: home, TMUX_TMPDIR: tmp });
execFileSync("tmux", ["-S", socket, "-f", "/dev/null", "new-session", "-d", "-s", "test", "-x", "200", "-y", "50", "-c", tmp, "cat"]);
execFileSync("tmux", ["-S", socket, "set", "-g", "default-command", "cat"]);
execFileSync("tmux", ["-S", socket, "set", "-g", "base-index", "1"]);
const serverPid = execFileSync("tmux", ["-S", socket, "display", "-p", "#{pid}"], { encoding: "utf8" }).trim();
Object.assign(process.env, {
  HOME: home,
  TMUX: `${socket},${serverPid},0`,
  TMUX_TMPDIR: tmp,
  TMUX_SIDEBAR_STATE_DIR: path.join(tmp, "state"),
  TMUX_SIDEBAR_CLIENT: path.join(__dirname, "../tmux/sidebar-pane.zsh"),
  LC_ALL: "en_US.UTF-8",
});
delete process.env.TMUX_PANE;

const tmux = (...args) => execFileSync("tmux", args, { encoding: "utf8" }).trimEnd();
assert.equal(tmux("display", "-p", "#{socket_path}"), socket, "tmux is not the tests' own server");
assert.notEqual(tmux("display", "-p", "#{socket_path}"), realTmux?.split(",")[0]);
assert.equal(os.homedir(), home);

const sidebar = require("../bin/tmux-sidebar");
assert.ok(sidebar.SOCKET.startsWith(tmp));

const config = { ...sidebar.DEFAULTS };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (check, ms = 3_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await wait(50);
  }
  return check();
};
const panes = (target) =>
  tmux("list-panes", "-t", target, "-F", "#{pane_id}\t#{@sidebar}\t#{pane_width}\t#{pane_left}\t#{pane_title}")
    .split("\n")
    .map((line) => {
      const [id, mark, width, left, title] = line.split("\t");
      return { id, sidebar: mark === "1", width: Number(width), left: Number(left), title };
    });

// Each test starts from one window holding one pane, the sidebar on.
beforeEach(() => {
  tmux("set", "-gu", "@sidebar_on");
  tmux("set", "-gu", "@sidebar_hold");
  const windows = tmux("list-windows", "-t", "test", "-F", "#{window_id}").split("\n");
  tmux("new-window", "-t", "test", "-c", tmp);
  windows.forEach((w) => tmux("kill-window", "-t", w));
  fs.rmSync(sidebar.CONFIG_FILE, { force: true });
});

after(() => {
  sidebar.stop();
  try {
    execFileSync("tmux", ["-S", socket, "kill-server"], { stdio: "ignore" });
  } catch {}
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("keys are named the way tmux names them", () => {
  assert.deepEqual(sidebar.parseKeys("j\x1b[A\x1bp\r\t\x1b[Z\x0c\x1b ").map((k) => k.key), ["j", "Up", "M-p", "Enter", "Tab", "BTab", "C-l", "M-Space"]);
  // A lone Escape arrives on its own; with a key after it, it is Alt.
  assert.deepEqual(sidebar.parseKeys("\x1b").map((k) => k.key), ["Escape"]);
  assert.deepEqual(sidebar.parseKeys("\x1b\t").map((k) => k.key), ["M-Tab"]);
  assert.deepEqual(sidebar.parseKeys("\x1b[<0;5;7M")[0].mouse, { button: 0, x: 5, y: 7, press: true });
});

test("the last turn is the last prompt, what Claude said after it, and the tool call it waits on", () => {
  const lines = [
    { type: "user", message: { content: "first prompt" }, timestamp: "2026-01-01T00:00:00Z" },
    { type: "assistant", message: { content: [{ type: "text", text: "old reply" }] } },
    { type: "user", message: { content: "<command-message>shape</command-message><command-name>/shape</command-name><command-args>CHA-1</command-args>" }, timestamp: "2026-01-01T00:01:00Z" },
    { type: "assistant", message: { content: [{ type: "text", text: "Reading it." }, { type: "tool_use", id: "a", name: "Read", input: { file_path: "/x" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "a", content: "..." }] } },
    { type: "assistant", isSidechain: true, message: { content: [{ type: "text", text: "a subagent" }] } },
    { type: "assistant", message: { content: [{ type: "text", text: "Ready to run the tests." }, { type: "tool_use", id: "b", name: "Bash", input: { command: "npm test\nmore" } }] } },
  ];
  const turn = sidebar.parseTurn(lines.map((l) => JSON.stringify(l)).join("\n"));
  assert.equal(turn.prompt, "/shape CHA-1");
  assert.equal(turn.reply, "Ready to run the tests.");
  assert.equal(turn.tools, 2);
  assert.equal(turn.pending, "Bash: npm test");
  assert.equal(turn.at, Date.parse("2026-01-01T00:01:00Z"));
});

test("a tab's own Claude wins its pane over a headless one that names it too", () => {
  const pane = tmux("display", "-p", "-t", "test:", "#{pane_id}");
  // A review loop's script starts a headless Claude, which inherits the pane.
  fs.writeFileSync(path.join(home, ".claude/sessions/121.json"), JSON.stringify({ pid: 121, sessionId: "own", cwd: "/work", tmux: `test:@9.${pane}`, entrypoint: "cli" }));
  fs.writeFileSync(path.join(home, ".claude/sessions/999.json"), JSON.stringify({ pid: 999, sessionId: "headless", cwd: "/work", tmux: `test:@9.${pane}`, entrypoint: "sdk-cli" }));
  try {
    assert.equal(sidebar.sessionsByPane().get(pane).sessionId, "own");
  } finally {
    ["121", "999"].forEach((pid) => fs.rmSync(path.join(home, `.claude/sessions/${pid}.json`)));
  }
});

test("a tab's conversation is found from the session file that names its pane", () => {
  const pane = tmux("display", "-p", "-t", "test:", "#{pane_id}");
  fs.writeFileSync(path.join(home, ".claude/sessions/111.json"), JSON.stringify({ pid: 111, sessionId: "s1", cwd: "/work", tmux: `test:@9.${pane}`, name: "Login retry", nameSource: "user", startedAt: 1700000000000 }));
  fs.writeFileSync(path.join(home, ".claude/projects/-work/s1.jsonl"), `${JSON.stringify({ type: "user", message: { content: "fix it" } })}\n${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Fixed." }] } })}\n`);
  try {
    const found = sidebar.sessionsByPane().get(pane);
    assert.deepEqual(found, { sessionId: "s1", cwd: "/work", name: "Login retry", startedAt: 1700000000000 });
    assert.equal(sidebar.lastTurn(sidebar.transcriptFor(found)).reply, "Fixed.");
  } finally {
    fs.rmSync(path.join(home, ".claude/sessions/111.json"));
  }
});

test("tabs are ordered by what needs you: waiting longest, finished longest ago, working, then the rest", async () => {
  ["two", "three", "four", "five"].forEach(() => tmux("new-window", "-t", "test", "-c", tmp));
  const now = Math.floor(Date.now() / 1000);
  const mark = (index, state, since) => {
    tmux("set", "-p", "-t", `test:${index}`, "@agent_state", state);
    tmux("set", "-p", "-t", `test:${index}`, "@agent_since", String(since));
    tmux("setw", "-t", `test:${index}`, "@agent", state);
  };
  mark(1, "working", now - 10);
  mark(2, "done", now - 50);
  mark(3, "waiting", now - 20);
  mark(5, "waiting", now - 90);
  const snap = await sidebar.snapshot();
  const order = sidebar.grouped(sidebar.tabsFrom(snap)).flatMap((g) => g.tabs.map((t) => t.index));
  assert.deepEqual(order, [5, 3, 2, 1, 4]);
});

test("every window gets one sidebar on its left, and none once it is turned off", async () => {
  tmux("new-window", "-t", "test", "-c", tmp);
  let snap = await sidebar.snapshot();
  assert.equal(await sidebar.reconcile(snap, sidebar.tabsFrom(snap), config), true);
  tmux("list-windows", "-t", "test", "-F", "#{window_id}").split("\n").forEach((w) => {
    const [left, ...rest] = panes(w);
    assert.equal(left.sidebar, true);
    assert.equal(left.left, 0);
    assert.equal(left.width, config.width);
    assert.equal(rest.filter((p) => p.sidebar).length, 0);
    // Not dimmed like the panes without focus.
    assert.equal(tmux("show", "-pv", "-t", left.id, "window-style"), "bg=terminal");
  });
  // A second look finds nothing to do.
  snap = await sidebar.snapshot();
  assert.equal(await sidebar.reconcile(snap, sidebar.tabsFrom(snap), config), false);

  tmux("set", "-g", "@sidebar_on", "off");
  snap = await sidebar.snapshot();
  await sidebar.reconcile(snap, sidebar.tabsFrom(snap), config);
  assert.equal(tmux("list-panes", "-a", "-F", "#{@sidebar}").split("\n").filter((m) => m === "1").length, 0);
});

test("a sidebar restored as a plain shell gets its client back, and a tab left with only a sidebar closes", async () => {
  // As tmux-resurrect brings one back: a shell with the sidebar's title.
  const restored = tmux("split-window", "-hbf", "-d", "-l", "20", "-t", "test:", "-P", "-F", "#{pane_id}", "cat");
  tmux("select-pane", "-t", restored, "-T", sidebar.TITLE);
  tmux("last-pane", "-t", "test:");
  let snap = await sidebar.snapshot();
  await sidebar.reconcile(snap, sidebar.tabsFrom(snap), config);
  const [left] = panes("test:");
  assert.equal(left.id, restored);
  assert.equal(left.width, config.width);
  assert.match(tmux("display", "-p", "-t", restored, "#{pane_start_command}"), /sidebar-pane\.zsh/);

  const other = tmux("new-window", "-t", "test", "-c", tmp, "-P", "-F", "#{window_id}");
  snap = await sidebar.snapshot();
  await sidebar.reconcile(snap, sidebar.tabsFrom(snap), config);
  const main = panes(other).find((p) => !p.sidebar);
  tmux("kill-pane", "-t", main.id);
  snap = await sidebar.snapshot();
  await sidebar.reconcile(snap, sidebar.tabsFrom(snap), config);
  assert.ok(!tmux("list-windows", "-a", "-F", "#{window_id}").split("\n").includes(other));
});

test("nothing is added while tmux-resurrect is restoring", async () => {
  tmux("set", "-g", "@sidebar_hold", String(Math.floor(Date.now() / 1000)));
  const snap = await sidebar.snapshot();
  assert.equal(await sidebar.reconcile(snap, sidebar.tabsFrom(snap), config), false);
  assert.equal(panes("test:").length, 1);
});

test("frames fill the pane exactly, however long the names", async () => {
  tmux("rename-window", "-t", "test:", "a very long name for a tab, longer than the sidebar is wide, so long it wraps more than three lines 🎉");
  const snap = await sidebar.snapshot();
  const tabs = sidebar.tabsFrom(snap);
  const { lines } = sidebar.sidebarLines({ tabs, sections: [], cols: 30, rows: 12, view: { focused: true, cursor: tabs[0].id, frame: 0, here: tabs[0].id } });
  assert.equal(lines.length, 12);
  lines.forEach((line) => assert.equal(sidebar.width(line), 30, JSON.stringify(line)));
  // The name wraps under itself, cut short after three lines.
  const text = lines.map((line) => line.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ""));
  assert.match(text[3], / \d a very long name for a/);
  assert.match(text[4], /^.{7}tab, longer than the/);
  assert.match(text[5], /…/);
  assert.match(text[6], /cat/);
  const mission = sidebar.missionLines({ tabs, sections: [], cols: 100, rows: 30, view: { view: 0, cursor: 0, frame: 0 }, config });
  assert.equal(mission.length, 30);
  mission.forEach((line) => assert.equal(sidebar.width(line), 100, JSON.stringify(line)));
});

test("a plugin's items are fetched, kept when a later fetch fails, and only named plugins load", async () => {
  fs.writeFileSync(path.join(home, ".config/tmux-sidebar/plugins/demo.js"), `
    let calls = 0;
    module.exports = {
      title: "Demo",
      sidebar: 2,
      async fetch({ options }) {
        if (++calls > 1) throw new Error("service down\\nstack");
        return [{ id: 1, title: "first " + options.word, state: "attention" }, { id: 2, title: "second", state: "idle" }];
      },
    };`);
  const logged = [];
  const sections = sidebar.loadPlugins({ plugins: { demo: { word: "hello" }, "../evil": {}, missing: {} } }, (...parts) => logged.push(parts.join(" ")));
  assert.deepEqual(sections.map((s) => s.name), ["demo"]);
  assert.ok(logged.some((line) => line.includes("missing")));
  let changed = 0;
  await sidebar.refreshSection(sections[0], () => changed++, () => {});
  assert.equal(sections[0].items[0].title, "first hello");
  await sidebar.refreshSection(sections[0], () => changed++, () => {});
  assert.equal(sections[0].error, "service down");
  assert.equal(sections[0].items.length, 2);
  assert.equal(changed, 2);

  const snap = await sidebar.snapshot();
  const tabs = sidebar.tabsFrom(snap);
  const { lines } = sidebar.sidebarLines({ tabs, sections, cols: 40, rows: 20, view: { focused: false, cursor: tabs[0].id, frame: 0, here: tabs[0].id } });
  const text = lines.join("\n").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  assert.match(text, /DEMO 2 ! 1/);
  assert.match(text, /first hello/);
});

// The daemon itself, with the sidebar panes running the real zsh client.
const plain = (text) => text.replace(/\x1b\][^\x07]*\x07|\x1b\[[0-9;?]*[A-Za-z]/g, "");
const sidebarPane = (target) => panes(target).find((p) => p.sidebar)?.id;

test("an idle tab says how long since its pane last printed anything", async () => {
  const tty = tmux("display", "-p", "-t", "test:", "#{pane_tty}");
  const then = new Date(Date.now() - 5 * 60_000);
  fs.utimesSync(tty, then, then);
  const snap = await sidebar.snapshot();
  const [tab] = sidebar.tabsFrom(snap);
  assert.equal(sidebar.stateWords(tab), "idle for 5m · cat");
  // A detail line too long for the sidebar breaks between its parts.
  const { lines } = sidebar.sidebarLines({ tabs: [{ ...tab, pr: "12345" }], sections: [], cols: 26, rows: 8, view: { focused: false, cursor: tab.id, frame: 0, here: tab.id } });
  const text = lines.map((line) => line.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").trimEnd());
  assert.deepEqual(text.slice(4, 6), ["▌     idle for 5m · cat", "▌     #12345"]);
});

test("a tab is named after its own pane's directory, not its sidebar's, while the sidebar has focus", (t) => {
  const work = path.join(tmp, "named-work");
  const elsewhere = path.join(tmp, "named-elsewhere");
  [work, elsewhere].forEach((dir) => fs.mkdirSync(dir, { recursive: true }));
  const window = tmux("new-window", "-d", "-t", "test", "-c", work, "-P", "-F", "#{window_id}");
  t.after(() => tmux("kill-window", "-t", window));
  const side = tmux("split-window", "-hb", "-d", "-t", window, "-c", elsewhere, "-P", "-F", "#{pane_id}");
  tmux("set", "-p", "-t", side, "@sidebar", "1");
  tmux("select-pane", "-t", side);
  execFileSync("bash", [path.join(__dirname, "../tmux/window-names.sh"), "test"]);
  assert.equal(tmux("display", "-p", "-t", window, "#{@tab_label}"), "named-work");
});

test("the status line is about the tab's own pane, not its sidebar, while the sidebar has focus", (t) => {
  const work = path.join(tmp, "status-work");
  const elsewhere = path.join(tmp, "status-elsewhere");
  [work, elsewhere].forEach((dir) => fs.mkdirSync(dir, { recursive: true }));
  const window = tmux("new-window", "-d", "-t", "test", "-c", work, "-P", "-F", "#{window_id}");
  t.after(() => tmux("kill-window", "-t", window));
  const side = tmux("split-window", "-hb", "-d", "-t", window, "-c", elsewhere, "-P", "-F", "#{pane_id}");
  tmux("set", "-p", "-t", side, "@sidebar", "1");
  tmux("select-pane", "-t", side);
  const line = (...flag) => execFileSync("bash", [path.join(__dirname, "../tmux/tab-status.sh"), side, elsewhere, "zsh", "/dev/null", ...flag], { encoding: "utf8" }).replace(/#\[[^\]]*\]/g, "");
  assert.match(line("1"), /^status-work /);
  assert.match(line(), /^status-elsewhere /, "without the flag, the pane it was given");
});

test("tabs with no Claude in them, such as the Slack relay or Notes, are Other, under Idle", () => {
  const base = { session: "$1", sessionName: "test", panes: [], sidebars: [], since: undefined };
  const tabs = [
    { ...base, id: "@1", index: 1, name: "Notes", state: "idle", command: "nvim" },
    { ...base, id: "@2", index: 2, name: "resting", state: "idle", command: "claude", claude: { sessionId: "s" } },
    { ...base, id: "@3", index: 3, name: "Slack relay", state: "idle", command: "node" },
  ];
  assert.deepEqual(sidebar.grouped(tabs).map((g) => [g.title, g.tabs.map((x) => x.name)]), [
    ["Idle", ["resting"]],
    ["Other", ["Notes", "Slack relay"]],
  ]);
  assert.deepEqual(sidebar.staged(tabs).map((g) => g.title), ["Idle", "Other"]);
});

test("a tab between a /loop's ticks is in Loops, after Idle and before Other, and one working is not", () => {
  const base = { session: "$1", sessionName: "test", panes: [], sidebars: [], since: undefined, command: "claude", claude: { sessionId: "s" } };
  const tabs = [
    { ...base, id: "@1", index: 1, name: "Calendar", state: "background", loop: { kind: "scheduled", prompt: "/today", at: Date.now() + 60_000 } },
    { ...base, id: "@2", index: 2, name: "resting", state: "idle" },
    { ...base, id: "@3", index: 3, name: "Notes", state: "idle", command: "nvim", claude: undefined },
    { ...base, id: "@4", index: 4, name: "busy", state: "working", loop: { kind: "scheduled", prompt: "/oncall", at: Date.now() + 60_000 } },
    { ...base, id: "@5", index: 5, name: "reviewing", state: "background", loop: { kind: "review", round: 1 } },
  ];
  assert.deepEqual(sidebar.grouped(tabs).map((g) => [g.title, g.tabs.map((x) => x.name)]), [
    ["Working", ["busy", "reviewing"]],
    ["Idle", ["resting"]],
    ["Loops", ["Calendar"]],
    ["Other", ["Notes"]],
  ]);
});

test("a frozen layout keeps each tab in its group and place while states change", () => {
  const base = { session: "$1", sessionName: "test", panes: [], sidebars: [], since: undefined, command: "zsh", claude: { sessionId: "s" } };
  const before = [
    { ...base, id: "@1", index: 1, name: "one", state: "idle" },
    { ...base, id: "@2", index: 2, name: "two", state: "done", since: 10 },
    { ...base, id: "@3", index: 3, name: "three", state: "working" },
    { ...base, id: "@4", index: 4, name: "four", state: "idle" },
  ];
  const frozen = sidebar.frozenFrom(before);
  // two was seen, four started working, one now waits, and five opened.
  const after = [
    { ...before[0], state: "waiting", since: 20 },
    { ...before[1], state: "idle", since: undefined },
    before[2],
    { ...before[3], state: "working" },
    { ...base, id: "@5", index: 5, name: "five", state: "waiting", since: 5 },
  ];
  assert.deepEqual(sidebar.grouped(after, frozen).map((g) => [g.title, g.tabs.map((x) => x.name)]), [
    ["Needs you", ["two", "five"]],
    ["Working", ["three"]],
    ["Idle", ["one", "four"]],
  ]);
  assert.deepEqual(sidebar.grouped(after).map((g) => [g.title, g.tabs.map((x) => x.name)]), [
    ["Needs you", ["five", "one"]],
    ["Working", ["three", "four"]],
    ["Idle", ["two"]],
  ], "unfrozen, the live order");
});

test("tabs whose PR is in the merge queue or merged get sections of their own, after the ones that need you", () => {
  const base = { session: "$1", sessionName: "test", panes: [], sidebars: [], since: undefined, command: "zsh", claude: { sessionId: "s" } };
  const tabs = [
    { ...base, id: "@1", index: 1, name: "idle one", state: "idle" },
    { ...base, id: "@2", index: 2, name: "queued third", state: "idle", pr: "12", merge: "queued", position: 3 },
    { ...base, id: "@3", index: 3, name: "queued first", state: "working", pr: "13", merge: "queued", position: 1 },
    { ...base, id: "@4", index: 4, name: "landed", state: "idle", pr: "14", merge: "merged" },
    { ...base, id: "@5", index: 5, name: "asking", state: "waiting", pr: "15", merge: "queued", position: 2 },
  ];
  assert.deepEqual(sidebar.grouped(tabs).map((g) => [g.title, g.tabs.map((x) => x.name)]), [
    ["Needs you", ["asking"]],
    ["In merge queue", ["queued first", "queued third"]],
    ["Merged", ["landed"]],
    ["Idle", ["idle one"]],
  ], "waiting stays in Needs you; a queued tab is in the queue even while Claude works; the queue is in queue order");
  assert.equal(sidebar.stateWords(tabs[1]), "in merge queue at 3");
  assert.equal(sidebar.stateWords(tabs[3]), "merged");
  assert.match(sidebar.stateWords(tabs[4]), /^waiting on you · in merge queue at 2$/);
  const { lines } = sidebar.sidebarLines({ tabs, sections: [], cols: 40, rows: 40, view: { focused: false, cursor: "@1", frame: 0, here: "@1" } });
  const text = lines.map((line) => line.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")).join("\n");
  assert.match(text, /IN MERGE QUEUE 2/);
  assert.match(text, /MERGED 1/);
  assert.match(text, / » +2 queued third/, "an idle queued tab wears the queue's badge");
  assert.match(text, / ◆ +4 landed/);
});

test("the tabs' PRs are asked about in one query, a gone worktree's by its branch, and only real names reach it", async (t) => {
  const repo = path.join(tmp, "prs-repo");
  fs.mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "remote", "add", "origin", "git@github.com:acme/widgets.git"]);
  // A stand-in gh: records its query, and answers that 12 is queued at 2, 13
  // merged, 14 neither, and the gone worktree's branch had PR 15, merged.
  const bin = path.join(tmp, "gh-bin");
  fs.mkdirSync(bin, { recursive: true });
  const asked = path.join(tmp, "gh-asked");
  const answer = { data: { r0: {
    a0: { number: 12, state: "OPEN", mergeQueueEntry: { position: 2 } },
    a1: { number: 13, state: "MERGED", mergeQueueEntry: null },
    a2: {
      number: 14, state: "OPEN", mergeQueueEntry: null, reviewDecision: "APPROVED", additions: 340, deletions: 80,
      commits: { nodes: [{ commit: { statusCheckRollup: { contexts: {
        checkRunCountsByState: [{ state: "SUCCESS", count: 10 }, { state: "SKIPPED", count: 2 }, { state: "FAILURE", count: 1 }, { state: "IN_PROGRESS", count: 3 }],
        statusContextCountsByState: [{ state: "PENDING", count: 0 }],
      } } } }] },
    },
    a3: { nodes: [{ number: 15, state: "MERGED", mergeQueueEntry: null }] },
  } } };
  fs.writeFileSync(path.join(bin, "gh"), `#!/bin/sh\nprintf '%s\\n' "$@" > '${asked}'\necho '${JSON.stringify(answer)}'\n`, { mode: 0o755 });
  const path0 = process.env.PATH;
  process.env.PATH = `${bin}:${path0}`;
  t.after(() => (process.env.PATH = path0));

  assert.equal(sidebar.repoOf(repo), "acme/widgets");
  // queue-and-clean deleted this one's worktree, so its label has no PR.
  const gone = { path: path.join(repo, ".claude/worktrees/feat-x") };
  const tabs = [...["12", "13", "14", "13"].map((pr) => ({ pr, path: repo })), gone];
  let changed = 0;
  await sidebar.fetchMerges(tabs, () => changed++);
  const query = fs.readFileSync(asked, "utf8");
  assert.match(query, /r0: repository\(owner: "acme", name: "widgets"\) \{ a0: pullRequest\(number: 12\).* a2: pullRequest\(number: 14\).* a3: pullRequests\(headRefName: "feat-x"/);
  assert.equal((query.match(/number: 13\)/g) || []).length, 1, "each PR asked about once");
  assert.equal(changed, 1);
  assert.deepEqual(sidebar.mergeOf(tabs[0]), { merge: "queued", position: 2 });
  assert.deepEqual(sidebar.mergeOf(tabs[1]), { merge: "merged" });
  // Its checks counted by outcome, its review and its size, for the cards.
  const facts = sidebar.mergeOf(tabs[2]);
  assert.deepEqual(facts, { checks: { pass: 12, fail: 1, pending: 3 }, review: "APPROVED", size: { additions: 340, deletions: 80 } });
  assert.deepEqual(sidebar.prFacts(facts), ["✓12 ✗1 ⏳3", "approved", "+340 −80"]);
  assert.deepEqual(sidebar.mergeOf(gone), { merge: "merged", pr: "15" }, "found by its branch, PR and all");
  // Shown with that PR, the tab is still found by its branch next time.
  assert.deepEqual(sidebar.mergeOf({ ...gone, pr: "15" }), { merge: "merged", pr: "15" });
  // The same answers again change nothing.
  await sidebar.fetchMerges(tabs, () => changed++);
  assert.equal(changed, 1);

  assert.equal(
    sidebar.queryFor(['acme/widgets#1) { x } #', 'a"b/c#2', "acme/widgets@x\" }", "acme/widgets#7"]).query,
    `query { r0: repository(owner: "acme", name: "widgets") { a0: pullRequest(number: 7) { ${sidebar.PR_FIELDS} } } }`,
  );
});

test("a tab whose turn ended with background tasks still running reads as working in the background", () => {
  const file = path.join(home, ".claude/projects/-work/background.jsonl");
  const now = Date.now();
  const started = (id, ms) => JSON.stringify({ type: "assistant", timestamp: new Date(ms).toISOString(), message: { content: [{ type: "tool_use", id: `use-${id}`, name: "Bash", input: { command: "npm test", run_in_background: true } }] } }) + "\n" + JSON.stringify({ type: "user", timestamp: new Date(ms).toISOString(), message: { content: [{ type: "tool_result", tool_use_id: `use-${id}`, content: `Command running in background with ID: ${id}. Output is being written to: /tmp/x` }] } });
  const ended = (id) => JSON.stringify({ type: "user", timestamp: new Date(now).toISOString(), origin: { kind: "task-notification" }, message: { content: `<task-notification>\n<task-id>${id}</task-id>\n<status>completed</status>\n</task-notification>` } });
  fs.writeFileSync(file, [
    started("old1", now - 60_000), // before this process started: died with the last one
    started("done1", now - 5_000),
    ended("done1"),
    started("run1", now - 4_000),
    started("run2", now - 3_000),
  ].join("\n") + "\n");
  const since = now - 10_000;
  assert.equal(sidebar.backgroundTasks(file, since), 2);
  // Read as it grows: one more ends.
  fs.appendFileSync(file, ended("run2") + "\n");
  assert.equal(sidebar.backgroundTasks(file, since), 1);
  fs.appendFileSync(file, ended("run1") + "\n");
  assert.equal(sidebar.backgroundTasks(file, since), 0);

  // A command that outran its timeout and was moved to the background runs on
  // too, and one whose output only quotes those words starts nothing.
  fs.appendFileSync(file, [
    JSON.stringify({ type: "user", timestamp: new Date(now).toISOString(), message: { content: [{ type: "tool_result", tool_use_id: "use-slow", content: "Command did not complete within its 120s timeout and was moved to the background (ID: slow1). Output is being written to: /tmp/x" }] } }),
    JSON.stringify({ type: "user", timestamp: new Date(now).toISOString(), message: { content: [{ type: "tool_result", tool_use_id: "use-grep", content: "log: Command did not complete within its 120s timeout and was moved to the background (ID: quoted1)" }] } }),
  ].join("\n") + "\n");
  assert.equal(sidebar.backgroundTasks(file, since), 1);
  fs.appendFileSync(file, ended("slow1") + "\n");
  assert.equal(sidebar.backgroundTasks(file, since), 0);

  const tab = { id: "@9", index: 9, name: "review", state: "background", background: 2, session: "$1", panes: [], sidebars: [] };
  assert.equal(sidebar.stateWords(tab), "working in background · 2 tasks");
  assert.deepEqual(sidebar.grouped([tab, { ...tab, id: "@8", index: 8, state: "done", background: 0 }]).map((g) => [g.title, g.tabs.map((x) => x.id)]), [
    ["Needs you", ["@8"]],
    ["Working", ["@9"]],
  ], "not one that needs you");
});

test("a Monitor watch runs through its events until it expires, and a tab only watching is in Monitoring", () => {
  const file = path.join(home, ".claude/projects/-work/watch.jsonl");
  const now = Date.now();
  const at = (ms) => new Date(now - ms).toISOString();
  const event = { type: "user", timestamp: at(1_000), origin: { kind: "task-notification" }, message: { content: "<task-notification>\n<task-id>m1</task-id>\n<summary>Monitor event: \"CI\"</summary>\n<event>checks=pending</event>\n</task-notification>" } };
  const entries = [
    { type: "assistant", timestamp: at(5_000), message: { content: [{ type: "tool_use", id: "w1", name: "Monitor", input: { description: "CI on #12", command: "gh pr checks 12", timeout_ms: 1800000 } }] } },
    { type: "user", timestamp: at(5_000), message: { content: [{ type: "tool_result", tool_use_id: "w1", content: "Monitor started (task m1, expires in 30m unless the source ends first; you get one notice at expiry)" }] } },
    event,
  ];
  fs.writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  assert.deepEqual(sidebar.backgroundWork(file, now - 60_000), { count: 1, monitors: ["CI on #12"] }, "an event doesn't end it");

  const tab = { id: "@9", index: 9, name: "watcher", state: "background", background: 1, monitors: ["CI on #12"], session: "$1", panes: [], sidebars: [] };
  assert.deepEqual(sidebar.grouped([tab]).map((g) => g.title), ["Monitoring"]);
  assert.equal(sidebar.stateWords(tab), "monitoring · CI on #12");
  assert.deepEqual(sidebar.grouped([{ ...tab, background: 2 }]).map((g) => g.title), ["Working"], "other work as well is working");

  // A command whose output only quotes those words starts nothing.
  fs.appendFileSync(file, [
    { type: "assistant", timestamp: at(500), message: { content: [{ type: "tool_use", id: "g1", name: "Bash", input: { command: "grep -h 'Monitor started' *.jsonl" } }] } },
    { type: "user", timestamp: at(500), message: { content: [{ type: "tool_result", tool_use_id: "g1", content: "Monitor started (task X, expires in 30m unless…)\nCommand running in background with ID: Y" }] } },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  assert.deepEqual(sidebar.backgroundWork(file, now - 60_000), { count: 1, monitors: ["CI on #12"] }, "quoted, not started");

  fs.appendFileSync(file, JSON.stringify({ type: "user", timestamp: at(0), origin: { kind: "task-notification" }, message: { content: "<task-notification>\n<task-id>m1</task-id>\n<summary>Monitor expired after 30m with no events delivered.</summary>\n</task-notification>" } }) + "\n");
  assert.deepEqual(sidebar.backgroundWork(file, now - 60_000), { count: 0, monitors: [] }, "its expiry ends it");
});

test("a loop running in the background reads as that loop, with its round: review, CI, queue-and-clean", () => {
  const file = path.join(home, ".claude/projects/-work/review.jsonl");
  const now = Date.now();
  const at = (ms) => new Date(now - ms).toISOString();
  const run = (useId, taskId, command, ms) => [
    { type: "assistant", timestamp: at(ms), message: { content: [{ type: "tool_use", id: useId, name: "Bash", input: { command, run_in_background: true } }] } },
    { type: "user", timestamp: at(ms), message: { content: [{ type: "tool_result", tool_use_id: useId, content: `Command running in background with ID: ${taskId}. Output is being written to: /tmp/x` }] } },
  ];
  const ended = (taskId) => ({ type: "user", timestamp: at(0), origin: { kind: "task-notification" }, message: { content: `<task-notification>\n<task-id>${taskId}</task-id>\n<status>completed</status>\n</task-notification>` } });
  const review = "node .claude/skills/review-loop/scripts/codex-review.cjs --base abc --no-fetch";
  const entries = [
    { type: "user", timestamp: at(9_000), message: { content: "<command-name>/review-loop</command-name>\n<command-args></command-args>" } },
    ...run("u1", "r1a", review, 8_000), ...run("u2", "r1b", review, 8_000),
    ended("r1a"), ended("r1b"),
    ...run("u3", "r2a", review, 4_000), ...run("u4", "r2b", review, 4_000),
  ];
  fs.writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  assert.deepEqual(sidebar.backgroundWork(file, now - 60_000), { count: 2, loop: { kind: "review", round: 2 }, monitors: [] });

  // A CI loop next: its watch, started again after a fix, counts one a round.
  const ci = "info=$(gh pr view 12 --json state); checks=$(gh pr checks 12 --json name,bucket)";
  fs.appendFileSync(file, [
    ended("r2a"), ended("r2b"),
    { type: "user", timestamp: at(3_000), message: { content: "<command-name>/ci-loop</command-name>" } },
    ...run("u5", "ci1", ci, 2_500), ended("ci1"), ...run("u6", "ci2", ci, 1_000),
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  assert.deepEqual(sidebar.backgroundWork(file, now - 60_000), { count: 1, loop: { kind: "ci", round: 2 }, monitors: [] });
  // queue-and-clean's watch reads the checks too, but is the queue's.
  fs.appendFileSync(file, [ended("ci2"), ...run("u7", "q1", "gh api graphql -f query='{ pullRequest { mergeQueueEntry { state } } }'; gh pr checks 12 --required", 500)].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  assert.deepEqual(sidebar.backgroundWork(file, now - 60_000), { count: 1, loop: { kind: "queue", round: 1 }, monitors: [] });
  // Anything else is plain background work.
  fs.appendFileSync(file, [ended("q1"), ...run("u8", "x1", "sleep 100", 100)].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  assert.deepEqual(sidebar.backgroundWork(file, now - 60_000), { count: 1, monitors: [] });

  const tab = { id: "@9", index: 9, name: "review", state: "background", background: 2, loop: { kind: "review", round: 2 }, session: "$1", panes: [], sidebars: [] };
  assert.equal(sidebar.stateWords({ ...tab, loop: { kind: "ci", round: 3 } }), "CI loop · round 3");
  assert.equal(sidebar.stateWords({ ...tab, loop: { kind: "queue", round: 1 } }), "queue-and-clean · watching");
  assert.equal(sidebar.stateWords(tab), "review loop · round 2");
  const { lines } = sidebar.sidebarLines({ tabs: [tab], sections: [], cols: 40, rows: 12, view: { focused: false, cursor: "@9", frame: 0, here: "@9" } });
  assert.match(lines.join("\n"), /\x1b\[48;5;97m/, "the review loop's own badge color");
});

test("mission control packs its stages side by side, each block under its own header", () => {
  const base = { session: "$1", panes: [], sidebars: [], command: "zsh", claude: { sessionId: "s" } };
  const tab = (index, name, extra) => ({ ...base, id: `@${index}`, index, name, state: "idle", ...extra });
  const tabs = [
    tab(1, "plain", {}),
    tab(2, "queued b", { merge: "queued", position: 2 }),
    tab(3, "reviewing", { state: "background", background: 2, loop: { kind: "review", round: 2 } }),
    tab(4, "busy", { state: "working" }),
    tab(5, "queued a", { merge: "queued", position: 1 }),
    tab(6, "asking", { state: "waiting" }),
    tab(7, "ci fixing", { state: "background", background: 1, loop: { kind: "ci", round: 1 } }),
    tab(8, "landed", { merge: "merged" }),
    tab(9, "watching the queue", { state: "background", background: 1, loop: { kind: "queue", round: 1 }, merge: "queued", position: 3 }),
  ];
  // Room for three cards a shelf, each box with its two columns of border:
  // stages pack side by side, one box each, and a stage that doesn't fit in
  // the room left starts the next shelf.
  const { order, shelves } = sidebar.missionGrid(tabs, 3 * 22, 20);
  assert.deepEqual(shelves.map((sh) => sh.blocks.map((b) => [b.stage.title, b.cards.map((i) => order[i].name)])), [
    [["Needs you", ["asking"]], ["Working", ["busy"]], ["Review loop", ["reviewing"]]],
    [["CI loop", ["ci fixing"]]],
    [["In merge queue", ["queued a", "queued b", "watching the queue"]]],
    [["Merged", ["landed"]], ["Idle", ["plain"]]],
  ], "a loop is its own stage, but a PR's place in the queue or merged comes first; the queue in queue order");
  // A stage too big for a row is one box of several rows, not two boxes.
  const many = Array.from({ length: 5 }, (_, i) => tab(20 + i, `idle ${i}`, {}));
  const big = sidebar.missionGrid(many, 3 * 22, 20);
  assert.deepEqual(big.shelves.map((sh) => sh.blocks.map((b) => [b.stage.title, b.across, b.rows])), [[["Idle", 3, 2]]]);
  assert.deepEqual(big.rows.map((r) => r.cards.length), [3, 2], "its rows are the rows the keys move through");
  const text = sidebar.missionLines({ tabs, sections: [], cols: 3 * config.cardWidth, rows: 200, view: { view: 0, cursor: 0, frame: 0 }, config })
    .map((line) => line.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").trimEnd());
  // Each block boxed, its title on its top edge.
  const headers = text.filter((line) => line.startsWith("╭─ ")).map((line) => [...line.matchAll(/╭─ ([A-Z -]+ \d+(?: …)?) /g)].map((m) => m[1]));
  const tops = text.filter((line) => line.startsWith("╭─ ")).length;
  assert.equal(text.filter((line) => /^╰─+╯/.test(line)).length, tops, "every box closed");
  assert.deepEqual(headers, [
    ["NEEDS YOU 1", "WORKING 1", "REVIEW LOOP 1"],
    ["CI LOOP 1"],
    ["IN MERGE QUEUE 3"],
    ["MERGED 1", "IDLE 1"],
], "each stage boxed once, its title on its top edge");
  assert.match(text[0], /⋯ 4/, "the header counts the loops as working");
});

test("mission control's cards are as tall as their fullest one needs, emoji count as terminals draw them, and links show as their names", () => {
  const tabs = [1, 2].map((index) => ({ session: "$1", panes: [], sidebars: [], command: "zsh", id: `@${index}`, index, name: `quiet ${index}`, state: "idle", path: "/work" }));
  const mission = sidebar.missionLines({ tabs, sections: [], cols: 3 * config.cardWidth, rows: 60, view: { view: 0, cursor: 0, frame: 0 }, config });
  mission.forEach((line) => assert.equal(sidebar.width(line), 3 * config.cardWidth));
  const text = mission.map((line) => line.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").trimEnd());
  assert.equal(text.findIndex((line) => /^╰─+╯/.test(line)), 8, "a shelf of quiet tabs is as short as a card can be, not stretched down the screen");
  assert.ok(text.slice(9, -1).every((line) => line === ""));
  assert.equal(sidebar.width("✅ done ⚠️"), 10, "symbols drawn as emoji take two columns, with or without their selector");
  assert.equal(
    sidebar.unlinked("Closed [ABC-2204](https://linear.app/acme/issue/ABC-2204/old) after [#4321](https://github.com/acme/app/pull/4321), see <https://acme.slack.com/archives/D0/p1> and https://linear.app/acme/issue/abc-7/x."),
    "Closed ABC-2204 after #4321, see acme.slack.com and ABC-7.",
  );
});

test("an idle Claude tab says only how long, and a PR its name already shows isn't said again", () => {
  const tab = { id: "@9", index: 9, session: "$1", panes: [], sidebars: [], name: "Fix #12 regressions", pr: "12", state: "idle", claude: { sessionId: "s" }, since: Math.floor(Date.now() / 1000) - 300 };
  assert.equal(sidebar.stateWords(tab), "idle for 5m");
  const { lines } = sidebar.sidebarLines({ tabs: [tab], sections: [], cols: 40, rows: 10, view: { focused: false, cursor: tab.id, frame: 0, here: tab.id } });
  assert.equal(lines.join("\n").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").match(/#12/g).length, 1);
});

test("a tab says what Claude is doing and what it waits on, as its hooks recorded them", async () => {
  const window = tmux("new-window", "-t", "test", "-c", tmp, "-P", "-F", "#{window_id}");
  const pane = tmux("display", "-p", "-t", window, "#{pane_id}");
  const since = String(Math.floor(Date.now() / 1000) - 120);
  try {
    tmux("set", "-p", "-t", pane, "@agent_state", "working");
    tmux("set", "-p", "-t", pane, "@agent_since", since);
    tmux("set", "-p", "-t", pane, "@agent_activity", "Run the full test suite");
    tmux("setw", "-t", window, "@agent", "working");
    let tab = sidebar.tabsFrom(await sidebar.snapshot()).find((x) => x.id === window);
    assert.equal(tab.activity, "Run the full test suite");
    assert.equal(sidebar.stateWords(tab), "working 2m · Run the full test suite");

    // In a loop asked for earlier, Claude working between its rounds is the loop's.
    tmux("set", "-p", "-t", pane, "@agent_loop", "review");
    tab = sidebar.tabsFrom(await sidebar.snapshot()).find((x) => x.id === window);
    assert.equal(sidebar.stateWords(tab), "working 2m · review loop · Run the full test suite");
    assert.equal(sidebar.missionGrid([tab]).order.length, 1);
    assert.deepEqual(sidebar.missionGrid([tab], 100, 20).shelves[0].blocks.map((b) => b.stage.title), ["Review loop"]);
    tmux("set", "-pu", "-t", pane, "@agent_loop");

    tmux("set", "-p", "-t", pane, "@agent_state", "waiting");
    tmux("set", "-p", "-t", pane, "@agent_wait", "permission: Bash git push");
    tmux("setw", "-t", window, "@agent", "waiting");
    tab = sidebar.tabsFrom(await sidebar.snapshot()).find((x) => x.id === window);
    assert.equal(sidebar.stateWords(tab), "waiting on you 2m · permission: Bash git push");
  } finally {
    tmux("kill-window", "-t", window);
  }
});

test("pinned tabs come first in Needs you, ahead of ones waiting longer", () => {
  const base = { session: "$1", sessionName: "test", panes: [], sidebars: [], claude: { sessionId: "s" } };
  const tabs = [
    { ...base, id: "@1", index: 1, name: "waiting long", state: "waiting", since: 10 },
    { ...base, id: "@2", index: 2, name: "pinned", state: "idle", pinned: true },
    { ...base, id: "@3", index: 3, name: "done", state: "done", since: 20 },
  ];
  assert.deepEqual(sidebar.grouped(tabs)[0].tabs.map((x) => x.name), ["pinned", "waiting long", "done"]);
  assert.deepEqual(sidebar.staged(tabs)[0].tabs.map((x) => x.name), ["pinned", "waiting long", "done"]);
});

test("a tab pinned by hand needs you, whatever Claude is doing in it, until it is unpinned", async () => {
  const window = tmux("new-window", "-t", "test", "-c", tmp, "-P", "-F", "#{window_id}");
  try {
    tmux("setw", "-t", window, "@pinned", "1");
    let tab = sidebar.tabsFrom(await sidebar.snapshot()).find((x) => x.id === window);
    assert.equal(tab.pinned, true);
    assert.deepEqual(sidebar.grouped([tab]).map((g) => g.title), ["Needs you"]);
    assert.deepEqual(sidebar.missionGrid([tab], 100, 20).shelves[0].blocks.map((b) => b.stage.title), ["Needs you"]);
    assert.match(sidebar.stateWords(tab), /^pinned · /);
    assert.match(sidebar.sidebarLines({ tabs: [tab], sections: [], cols: 40, rows: 10, view: { focused: false, cursor: window, frame: 0, here: window } }).lines.join(""), /📌/);
    tmux("setw", "-u", "-t", window, "@pinned");
    tab = sidebar.tabsFrom(await sidebar.snapshot()).find((x) => x.id === window);
    assert.deepEqual(sidebar.grouped([tab]).map((g) => g.title), ["Other"], "a shell, with no Claude");
  } finally {
    tmux("kill-window", "-t", window);
  }
});

test("M-e opens Notes to the right of the pane, moves the one Notes there from elsewhere, and puts it back in its own tab", () => {
  const script = path.join(__dirname, "../tmux/notes-open.sh");
  const env = { ...process.env, NOTES_OPEN_COMMAND: "cat" };
  const notes = () => tmux("list-panes", "-a", "-F", "#{pane_id} #{@notes_pane} #{window_id}").split("\n").filter((l) => l.split(" ")[1] === "1").map((l) => l.split(" "));
  const first = tmux("new-window", "-d", "-t", "test", "-c", tmp, "-P", "-F", "#{window_id}");
  const second = tmux("new-window", "-d", "-t", "test", "-c", tmp, "-P", "-F", "#{window_id}");
  const paneIn = (w) => tmux("display", "-p", "-t", w, "#{pane_id}");
  const a = paneIn(first);
  const b = paneIn(second);
  try {
    execFileSync("bash", [script, "side", "none", a], { env });
    assert.equal(notes().length, 1);
    assert.equal(notes()[0][2], first, "beside the pane, in its tab");
    const pane = notes()[0][0];

    execFileSync("bash", [script, "side", "none", b], { env });
    assert.deepEqual(notes(), [[pane, "1", second]], "the same Notes, moved");
    assert.equal(tmux("list-panes", "-t", first, "-F", "#{pane_id}"), a, "and gone from where it was");

    execFileSync("bash", [script, "side", "none", b], { env });
    const [, , own] = notes()[0];
    assert.notEqual(own, second, "pressed again, it goes back to a tab of its own");
    assert.equal(tmux("display", "-p", "-t", own, "#{@notes}"), "1");
    execFileSync("bash", [script, "side", "none", pane], { env });
    assert.equal(notes()[0][2], own, "and from there, alone, it stays put");
  } finally {
    [first, second, ...notes().map((n) => n[2])].forEach((w) => { try { tmux("kill-window", "-t", w); } catch {} });
  }
});

test("a tab with Notes beside its pane says so in the sidebar, and the Notes tab itself doesn't", async (t) => {
  const script = path.join(__dirname, "../tmux/notes-open.sh");
  const env = { ...process.env, NOTES_OPEN_COMMAND: "cat" };
  const here = tmux("new-window", "-d", "-t", "test", "-c", tmp, "-P", "-F", "#{window_id}");
  execFileSync("bash", [script, "side", "none", tmux("display", "-p", "-t", here, "#{pane_id}")], { env });
  const notes = tmux("list-panes", "-t", here, "-F", "#{pane_id} #{@notes_pane}").split("\n").find((l) => l.endsWith(" 1")).split(" ")[0];
  t.after(() => [here, tmux("display", "-p", "-t", notes, "#{window_id}")].forEach((w) => { try { tmux("kill-window", "-t", w); } catch {} }));
  let tab = sidebar.tabsFrom(await sidebar.snapshot()).find((x) => x.id === here);
  assert.equal(tab.notesHere, true);
  const text = sidebar.sidebarLines({ tabs: [tab], sections: [], cols: 40, rows: 12, view: { focused: false, cursor: here, frame: 0, here } }).lines.join("").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  assert.match(text, /✎ Notes here/);
  execFileSync("bash", [script, "away", "none", notes], { env });
  const own = tmux("display", "-p", "-t", notes, "#{window_id}");
  const tabs = sidebar.tabsFrom(await sidebar.snapshot());
  assert.equal(tabs.find((x) => x.id === here).notesHere, false, "put away, it's no longer here");
  assert.equal(tabs.find((x) => x.id === own).notesHere, false, "and its own tab isn't marked");
});

test("M-w on Notes beside another pane puts it back in a tab of its own rather than closing it", (t) => {
  const script = path.join(__dirname, "../tmux/notes-open.sh");
  const env = { ...process.env, NOTES_OPEN_COMMAND: "cat" };
  const here = tmux("new-window", "-d", "-t", "test", "-c", tmp, "-P", "-F", "#{window_id}");
  const own = tmux("display", "-p", "-t", here, "#{pane_id}");
  execFileSync("bash", [script, "side", "none", own], { env });
  const notes = tmux("list-panes", "-t", here, "-F", "#{pane_id} #{@notes_pane}").split("\n").find((l) => l.endsWith(" 1")).split(" ")[0];
  t.after(() => [here, tmux("display", "-p", "-t", notes, "#{window_id}")].forEach((w) => { try { tmux("kill-window", "-t", w); } catch {} }));
  execFileSync("bash", [script, "away", "none", notes], { env });
  assert.equal(tmux("list-panes", "-t", here, "-F", "#{pane_id}"), own, "gone from the tab");
  const tab = tmux("display", "-p", "-t", notes, "#{window_id}");
  assert.notEqual(tab, here);
  assert.equal(tmux("display", "-p", "-t", tab, "#{@notes}"), "1", "and in a Notes tab of its own, still running");
});

test("Notes taken from its own tab leaves the tab saying where it went, and comes back into it", async (t) => {
  const script = path.join(__dirname, "../tmux/notes-open.sh");
  const env = { ...process.env, NOTES_OPEN_COMMAND: "cat" };
  // Notes in its own tab, as M-N opens it.
  execFileSync("bash", [script, "none"], { env });
  const find = (option) => tmux("list-panes", "-a", "-F", `#{pane_id} #{window_id} #{${option}}`).split("\n").map((l) => l.split(" ")).find((p) => p[2] === "1");
  const [notes, notesTab] = find("@notes_pane");
  const here = tmux("new-window", "-d", "-t", "test", "-c", tmp, "-P", "-F", "#{window_id}");
  t.after(() => [here, notesTab].forEach((w) => { try { tmux("kill-window", "-t", w); } catch {} }));

  execFileSync("bash", [script, "side", "none", tmux("display", "-p", "-t", here, "#{pane_id}")], { env });
  assert.equal(tmux("display", "-p", "-t", notes, "#{window_id}"), here, "Notes is beside your pane");
  const [standIn, standInTab] = find("@notes_placeholder");
  assert.equal(standInTab, notesTab, "and its tab is still there, with a pane in its place");
  assert.equal(tmux("display", "-p", "-t", notesTab, "#{@notes}"), "1");
  await wait(300);
  assert.match(tmux("capture-pane", "-p", "-t", standIn), /Notes is beside tab \d+/, "saying which tab has it");
  const tabs = sidebar.tabsFrom(await sidebar.snapshot());
  const beside = tabs.find((x) => x.id === here);
  assert.equal(sidebar.stateWords(tabs.find((x) => x.id === notesTab)), `Notes is beside tab ${beside.index} · ${beside.name}`, "and its line in the sidebar says so too");

  execFileSync("bash", [script, "away", "none", notes], { env });
  assert.equal(tmux("display", "-p", "-t", notes, "#{window_id}"), notesTab, "put away, it goes back into its tab");
  assert.equal(find("@notes_placeholder"), undefined, "in the stand-in's place");
});

test("M-e moves Notes, not the sidebar pane sitting first in the Notes tab", (t) => {
  const script = path.join(__dirname, "../tmux/notes-open.sh");
  const env = { ...process.env, NOTES_OPEN_COMMAND: "cat" };
  execFileSync("bash", [script, "none"], { env });
  const [notes, notesTab] = tmux("list-panes", "-a", "-F", "#{pane_id} #{window_id} #{@notes_pane}").split("\n").map((l) => l.split(" ")).find((p) => p[2] === "1");
  const sidebarPane = tmux("split-window", "-bdh", "-l", "10", "-t", notes, "-P", "-F", "#{pane_id}", "cat");
  tmux("set-option", "-p", "-t", sidebarPane, "@sidebar", "1");
  const here = tmux("new-window", "-d", "-t", "test", "-c", tmp, "-P", "-F", "#{window_id}");
  t.after(() => [here, notesTab].forEach((w) => { try { tmux("kill-window", "-t", w); } catch {} }));
  execFileSync("bash", [script, "side", "none", tmux("display", "-p", "-t", here, "#{pane_id}")], { env });
  assert.equal(tmux("display", "-p", "-t", notes, "#{window_id}"), here, "Notes is beside your pane");
  assert.equal(tmux("display", "-p", "-t", sidebarPane, "#{window_id}"), notesTab, "and the sidebar stayed in the Notes tab");
});

test("M-e finds a Notes that lost its marks from the notes lock, rather than starting another", (t) => {
  const notesDir = fs.mkdtempSync(path.join(tmp, "notes-"));
  // A Notes tmux-resurrect brought back: no @notes or @notes_pane, but the
  // lock names its process.
  const restored = tmux("new-window", "-d", "-t", "test", "-c", tmp, "-P", "-F", "#{window_id}", "cat");
  const pane = tmux("display", "-p", "-t", restored, "#{pane_id}");
  fs.writeFileSync(path.join(notesDir, ".notes.lock"), tmux("display", "-p", "-t", pane, "#{pane_pid}"));
  const here = tmux("new-window", "-d", "-t", "test", "-c", tmp, "-P", "-F", "#{window_id}");
  t.after(() => [restored, here].forEach((w) => { try { tmux("kill-window", "-t", w); } catch {} }));
  execFileSync("bash", [path.join(__dirname, "../tmux/notes-open.sh"), "side", "none", tmux("display", "-p", "-t", here, "#{pane_id}")], { env: { ...process.env, NOTES_DIR: notesDir, NOTES_OPEN_COMMAND: "false" } });
  assert.equal(tmux("display", "-p", "-t", pane, "#{window_id}"), here, "the same Notes, moved beside you");
  assert.equal(tmux("display", "-p", "-t", pane, "#{@notes_pane}"), "1", "and marked again");
  const standIn = tmux("list-panes", "-t", restored, "-F", "#{pane_id} #{@notes_placeholder}").split("\n").find((l) => l.endsWith(" 1"));
  assert.ok(standIn, "its tab, which had nothing else, keeps a pane saying where Notes went");
  assert.equal(tmux("display", "-p", "-t", restored, "#{@notes}"), "1", "and is the Notes tab again");
});

test("M-w on a tool in a pane's place closes the tool and brings the pane back, keeping the tab", () => {
  const window = tmux("new-window", "-d", "-t", "test", "-c", tmp, "-P", "-F", "#{window_id}");
  const own = tmux("display", "-p", "-t", window, "#{pane_id}");
  // As pane-in-place.sh leaves it: the tool in the pane's place, the pane parked.
  const tool = tmux("new-window", "-d", "-t", "test", "-P", "-F", "#{pane_id}", "cat");
  tmux("set", "-w", "-t", tool, "@pane_parked", "1");
  tmux("set", "-p", "-t", tool, "@parked_pane", own);
  tmux("swap-pane", "-d", "-s", tool, "-t", own);
  tmux("select-pane", "-t", tool);
  try {
    // M-w names the pane in @confirm_pane, since its popup can't pass it.
    tmux("set", "-gF", "@confirm_pane", tool);
    execFileSync("bash", [path.join(__dirname, "../tmux/confirm.sh"), "Close pane?"], { input: "y", env: { ...process.env, TERM: "xterm" }, stdio: ["pipe", "ignore", "ignore"] });
    const panes = tmux("list-panes", "-t", window, "-F", "#{pane_id}").split("\n");
    assert.deepEqual(panes, [own], "your pane is back in its tab, and the tool is gone");
  } finally {
    tmux("kill-window", "-t", window);
  }
});

test("a window holding a pane parked behind lazygit is not a tab, and gets no sidebar", async () => {
  const window = tmux("new-window", "-d", "-t", "test", "-c", tmp, "-P", "-F", "#{window_id}");
  try {
    tmux("setw", "-t", window, "@pane_parked", "1");
    const snap = await sidebar.snapshot();
    const tab = sidebar.tabsFrom(snap).find((x) => x.id === window);
    assert.equal(tab.parked, true);
    await sidebar.reconcile({ ...snap, on: true }, [tab], { ...config, minWindowWidth: 0 });
    assert.equal(tmux("list-panes", "-t", window, "-F", "#{pane_id}").split("\n").length, 1, "no sidebar added");
  } finally {
    tmux("kill-window", "-t", window);
  }
});

test("a waiting tab is answered from mission control: its options shown, a number pressed in it", async () => {
  // A tab showing a permission prompt, then echoing what is pressed in it.
  const script = path.join(tmp, "prompt.sh");
  fs.writeFileSync(script, "printf 'Do you want to proceed?\\n\\xe2\\x9d\\xaf 1. Yes\\n  2. No, and tell Claude what to do differently\\n'; exec cat\n");
  const window = tmux("new-window", "-d", "-t", "test", "-c", tmp, "-P", "-F", "#{window_id}", `sh ${script}`);
  const pane = tmux("display", "-p", "-t", window, "#{pane_id}");
  tmux("set", "-p", "-t", pane, "@agent_state", "waiting");
  tmux("set", "-p", "-t", pane, "@agent_since", String(Math.floor(Date.now() / 1000)));
  tmux("setw", "-t", window, "@agent", "waiting");
  const sent = [];
  const client = { kind: "mission", socket: { write: (text) => sent.push(text), end() {} }, view: { view: 0, cursor: 0 }, cols: 120, rows: 30, tmuxClient: "none" };
  try {
    await wait(300);
    await sidebar.refresh();
    const order = sidebar.missionGrid(sidebar.state.tabs).order;
    client.view.cursor = order.findIndex((t) => t.id === window);
    assert.ok(client.view.cursor >= 0, "the waiting tab is a card");

    await sidebar.missionKey(client, { key: "a" });
    assert.equal(client.answering.found.question, "Do you want to proceed?");
    assert.deepEqual(client.answering.found.options.map((o) => o.label), ["Yes", "No, and tell Claude what to do differently"]);
    assert.match(plain(sent.at(-1)), /ANSWER .*Do you want to proceed\?.*1 +Yes.*2 +No/s);

    await sidebar.missionKey(client, { key: "2" });
    assert.ok(await until(() => tmux("capture-pane", "-p", "-t", pane).includes("2")), "2 was pressed in the tab");
    assert.equal(client.answering.note, "Chose 2. No, and tell Claude what to do differently");
  } finally {
    tmux("kill-window", "-t", window);
  }
});

test("/ in the sidebar narrows its tabs to those whose title has the text, and Esc brings them back", async (t) => {
  const one = tmux("new-window", "-d", "-t", "test", "-c", tmp, "-n", "findme one", "-P", "-F", "#{window_id}");
  const two = tmux("new-window", "-d", "-t", "test", "-c", tmp, "-n", "other two", "-P", "-F", "#{window_id}");
  t.after(() => [one, two].forEach((w) => tmux("kill-window", "-t", w)));
  tmux("select-window", "-t", one);
  assert.equal(sidebar.start(), true);
  t.after(() => sidebar.stop());
  const pane = await until(() => sidebarPane(one));
  assert.ok(pane, "no sidebar");
  const shown = () => tmux("capture-pane", "-p", "-t", pane);
  assert.ok(await until(() => shown().includes("findme one") && shown().includes("other two")));
  tmux("select-pane", "-t", pane);
  await wait(100);
  await sidebar.refresh();
  tmux("send-keys", "-t", pane, "/");
  tmux("send-keys", "-t", pane, "-l", "findme");
  assert.ok(await until(() => shown().includes("/findme") && !shown().includes("other two")), "only the tab whose title matches");
  assert.ok(shown().includes("findme one"));
  tmux("send-keys", "-t", pane, "Escape");
  assert.ok(await until(() => shown().includes("other two") && !shown().includes("/findme")), "Esc brings them back");
});

test("mission control takes the mouse: a view's name switches to it, a card is chosen and then gone to, the wheel moves", async (t) => {
  const one = tmux("new-window", "-d", "-t", "test", "-c", tmp, "-n", "mouse one", "-P", "-F", "#{window_id}");
  const two = tmux("new-window", "-d", "-t", "test", "-c", tmp, "-n", "mouse two", "-P", "-F", "#{window_id}");
  t.after(() => [one, two].forEach((w) => tmux("kill-window", "-t", w)));
  await sidebar.refresh();
  const client = { kind: "mission", socket: { write() {}, end() {} }, view: { view: 0, cursor: 0 }, cols: 160, rows: 60, tmuxClient: "none" };
  sidebar.draw(client);
  const order = sidebar.missionGrid(sidebar.state.tabs).order;
  const target = order.findIndex((x) => x.id === two);
  const card = client.hits.find((h) => h.index === target);
  assert.ok(card, "the card has somewhere to click");
  const click = (h) => sidebar.missionKey(client, { mouse: { button: 0, x: h.x0 + 1, y: h.y, press: true } });
  await click(card);
  assert.equal(client.view.cursor, target, "a click chooses it");
  await sidebar.missionKey(client, { mouse: { button: target ? 64 : 65, x: 1, y: 3, press: true } });
  assert.notEqual(client.view.cursor, target, "the wheel moves to the next card");
  const viewName = client.hits.find((h) => h.view === 1);
  await click(viewName);
  assert.equal(client.view.view, 1, "a view's name switches to it");
});

test("the sidebar's Space opens a popup with only that tab's peek, closed with it", async (t) => {
  const window = tmux("new-window", "-d", "-t", "test", "-c", tmp, "-P", "-F", "#{window_id}", "sh -c 'seq 1 60; exec cat'");
  t.after(() => tmux("kill-window", "-t", window));
  assert.equal(sidebar.start(), true);
  t.after(() => sidebar.stop());
  await wait(300);
  await sidebar.refresh();

  const popup = net.connect(sidebar.SOCKET);
  let received = "";
  let closed = false;
  popup.on("data", (data) => (received += data));
  popup.on("close", () => (closed = true));
  popup.write(`mission none 100 20 peek:${window}\n`);
  assert.ok(await until(() => /PEEK.*60/s.test(plain(received))), "the peek, at once");
  popup.write("q");
  assert.equal(await until(() => closed), true, "closing the peek closes the popup");

  // A tab that has gone closes it straight away.
  const gone = net.connect(sidebar.SOCKET);
  let goneClosed = false;
  gone.on("close", () => (goneClosed = true));
  gone.write("mission none 100 20 answer:@999999\n");
  assert.equal(await until(() => goneClosed), true);
});

test("Space peeks at a tab from mission control: its screen, or its whole last turn, without going there", async () => {
  const window = tmux("new-window", "-d", "-t", "test", "-c", tmp, "-P", "-F", "#{window_id}", "sh -c 'seq 1 60; exec cat'");
  const sent = [];
  const client = { kind: "mission", socket: { write: (text) => sent.push(text), end() {} }, view: { view: 0, cursor: 0 }, cols: 100, rows: 20, tmuxClient: "none" };
  try {
    await wait(300);
    await sidebar.refresh();
    client.view.cursor = sidebar.missionGrid(sidebar.state.tabs).order.findIndex((t) => t.id === window);
    // No Claude there: its screen, scrolled to the end, and up with k.
    await sidebar.missionKey(client, { key: "Space" });
    assert.equal(client.peek.mode, "screen");
    assert.match(plain(sent.at(-1)), /PEEK.*60/s);
    await sidebar.missionKey(client, { key: "g" });
    assert.match(plain(sent.at(-1)), /PEEK +\d+ .* 1 +2 +3 /s, "g goes to the top");
    await sidebar.missionKey(client, { key: "Escape" });
    assert.equal(client.peek, undefined);
    assert.equal(tmux("display", "-p", "#{window_id}") === window, false, "never went there");
  } finally {
    tmux("kill-window", "-t", window);
  }

  // A Claude tab: its whole last turn, however long.
  const file = path.join(home, ".claude/projects/-work/peeked.jsonl");
  const reply = Array.from({ length: 30 }, (_, i) => `line ${i + 1} of the reply`).join("\n");
  fs.writeFileSync(file, [
    JSON.stringify({ type: "user", message: { content: "explain the change" } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: reply }] } }),
  ].join("\n") + "\n");
  const tab = { id: "@99", index: 9, name: "peeked", state: "done", claude: { sessionId: "peeked", cwd: "/work" }, panes: [], sidebars: [] };
  const top = sidebar.peekLines({ tab, mode: "turn", scroll: 0 }, 80, 40).lines.map(plain).join("\n");
  assert.match(top, /› explain the change[\s\S]*line 1 of the reply[\s\S]*line 30 of the reply/, "the reply in full, not cut to a card");
});

test("/ filters mission control's cards, and X closes every merged tab and removes its worktree", async () => {
  // A repository on "GitHub", with a worktree whose PR has merged.
  const repo = path.join(tmp, "merged-repo");
  const git = (...args) => execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], { stdio: "ignore" });
  fs.mkdirSync(repo, { recursive: true });
  git("init", "-q", "-b", "main");
  git("commit", "-q", "--allow-empty", "-m", "start");
  git("remote", "add", "origin", "git@github.com:acme/merging.git");
  const worktree = path.join(repo, ".claude/worktrees/feat-landed");
  git("worktree", "add", "-q", "-b", "feat-landed", worktree);
  sidebar.known.set("acme/merging#31", { merge: "merged" });
  const landed = tmux("new-window", "-d", "-t", "test", "-c", worktree, "-P", "-F", "#{window_id}");
  tmux("setw", "-t", landed, "@tab_label", "#31 feat landed");
  const other = tmux("new-window", "-d", "-t", "test", "-c", tmp, "-P", "-F", "#{window_id}");
  tmux("setw", "-t", other, "@tab_label", "something else");
  const sent = [];
  const client = { kind: "mission", socket: { write: (text) => sent.push(text), end() {} }, view: { view: 0, cursor: 0 }, cols: 120, rows: 30, tmuxClient: "none" };
  try {
    await sidebar.refresh();
    assert.equal(sidebar.state.tabs.find((x) => x.id === landed).merge, "merged");

    // / then "landed": only that card is left; Esc puts them all back.
    for (const key of ["/", "l", "a", "n", "d", "e", "d", "Enter"]) await sidebar.missionKey(client, { key });
    assert.match(plain(sent.at(-1)), /\/landed/);
    assert.match(plain(sent.at(-1)), /feat landed/);
    assert.doesNotMatch(plain(sent.at(-1)), /something else/);
    await sidebar.missionKey(client, { key: "Escape" });
    assert.match(plain(sent.at(-1)), /something else/);

    // X asks first; n leaves everything as it was.
    await sidebar.missionKey(client, { key: "X" });
    assert.match(plain(sent.at(-1)), /Close 1 merged tab and remove their worktrees\? \(y\/n\)[\s\S]*feat landed/);
    await sidebar.missionKey(client, { key: "n" });
    assert.ok(fs.existsSync(worktree));
    // y closes the tab and removes its worktree, and says so.
    await sidebar.missionKey(client, { key: "X" });
    await sidebar.missionKey(client, { key: "y" });
    assert.ok(!tmux("list-windows", "-a", "-F", "#{window_id}").split("\n").includes(landed), "the tab is closed");
    assert.ok(!fs.existsSync(worktree), "its worktree is removed");
    assert.match(plain(sent.at(-1)), /Closed 1 merged tab\./);
  } finally {
    sidebar.known.delete("acme/merging#31");
    tmux("kill-window", "-t", other);
  }
});

test("a tab in a removed worktree takes its branch's PR, unless its name is about another ticket", () => {
  const repo = path.join(tmp, "gone-repo");
  fs.mkdirSync(repo, { recursive: true });
  execFileSync("git", ["-C", repo, "init", "-q", "-b", "main"]);
  execFileSync("git", ["-C", repo, "remote", "add", "origin", "git@github.com:acme/gone.git"]);
  const gone = path.join(repo, ".claude/worktrees/abc-5-old-work");
  sidebar.known.set("acme/gone@abc-5-old-work", { pr: "50", merge: "merged" });
  try {
    assert.equal(sidebar.mergeOf({ path: gone, name: "ABC-5: Old work" }).merge, "merged", "its own ticket");
    assert.equal(sidebar.mergeOf({ path: gone, name: "a plain name" }).merge, "merged", "no ticket named");
    assert.deepEqual(sidebar.mergeOf({ path: gone, name: "Shaping ABC-9: New work" }), {}, "shaping another ticket now");
  } finally {
    sidebar.known.delete("acme/gone@abc-5-old-work");
  }
});

test("the work map lists every worktree in the tabs' repositories, with its tab or none, its ticket and its PR", async () => {
  const repo = path.join(tmp, "workmap-repo");
  const git = (...args) => execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], { stdio: "ignore" });
  fs.mkdirSync(repo, { recursive: true });
  git("init", "-q", "-b", "main");
  git("commit", "-q", "--allow-empty", "-m", "start");
  git("remote", "add", "origin", "git@github.com:acme/workmap.git");
  const open = path.join(repo, ".claude/worktrees/abc-12-feat-a");
  const forgotten = path.join(repo, ".claude/worktrees/abc-13-feat-b");
  git("worktree", "add", "-q", "-b", "abc-12-feat-a", open);
  git("worktree", "add", "-q", "-b", "abc-13-feat-b", forgotten);
  // Its PR, as GitHub would have said, looked up by its branch.
  sidebar.known.set("acme/workmap@abc-13-feat-b", { pr: "42", merge: "queued", position: 2 });
  const window = tmux("new-window", "-d", "-t", "test", "-c", open, "-P", "-F", "#{window_id}");
  tmux("setw", "-t", window, "@tab_label", "#41 ABC-12: Feat A");
  try {
    await sidebar.refresh();
    const tabs = sidebar.state.tabs;
    await sidebar.refreshWorktrees(tabs);
    assert.deepEqual(sidebar.untabbed(tabs).filter((w) => w.path.startsWith(repo)), [{ path: forgotten, branch: "abc-13-feat-b" }], "asked about by branch");
    const rows = sidebar.workMap(tabs).filter((r) => (r.tab?.path ?? r.dir)?.startsWith(repo));
    assert.deepEqual(rows.map((r) => [r.title, r.detail.replace(tmp, "TMP"), Boolean(r.tab), r.dir?.replace(tmp, "TMP")]), [
      ["ABC-12  Feat A", "tab " + tabs.find((x) => x.id === window).index + " · #41 open · TMP/workmap-repo/.claude/worktrees/abc-12-feat-a", true, undefined],
      ["ABC-13  feat b", "no tab · #42 in merge queue at 2 · TMP/workmap-repo/.claude/worktrees/abc-13-feat-b", false, "TMP/workmap-repo/.claude/worktrees/abc-13-feat-b"],
    ], "the main checkout, with no tab in it, isn't a row");
    assert.ok(sidebar.builtInViews(sidebar.state).some((v) => v.title === "Work map"));
  } finally {
    sidebar.known.delete("acme/workmap@abc-13-feat-b");
    tmux("kill-window", "-t", window);
  }
});

test("the work map adds wt-revive's worktrees with when and what you last asked there, and M-j and M-o open it as a picker", async (t) => {
  // wt-revive's rows: one in a repository no tab is in, one with a tab.
  sidebar.revived.set("/elsewhere/.claude/worktrees/abc-20-old", { tree: "/elsewhere/.claude/worktrees/abc-20-old", repo: "/elsewhere", branch: "abc-20-old", when: 100, age: "3d ago", prompt: "Fix the flaky test" });
  sidebar.revived.set("/elsewhere/.claude/worktrees/abc-21-older", { tree: "/elsewhere/.claude/worktrees/abc-21-older", repo: "/elsewhere", branch: "abc-21-older", when: 50, age: "6d ago", prompt: "(no recent Claude session)" });
  t.after(() => sidebar.revived.clear());
  const rows = sidebar.workMap([]).filter((r) => r.dir?.startsWith("/elsewhere"));
  assert.deepEqual(rows.map((r) => [r.title, r.detail]), [
    ["ABC-20  old", "no tab · no PR · used 3d ago · /elsewhere/.claude/worktrees/abc-20-old · Fix the flaky test"],
    ["ABC-21  older", "no tab · no PR · used 6d ago · /elsewhere/.claude/worktrees/abc-21-older · (no recent Claude session)"],
  ], "most recently used first");

  // M-j: the Work map, open tabs only, a filter typing; Esc closes it.
  const window = tmux("new-window", "-d", "-t", "test", "-c", tmp, "-P", "-F", "#{window_id}");
  t.after(() => tmux("kill-window", "-t", window));
  const client = { kind: "mission", socket: { write() {}, end() { client.ended = true; } }, view: { view: 1, cursor: 0 }, cols: 120, rows: 30, tmuxClient: "none", scope: "tabs", picker: true, filter: { text: "", typing: true } };
  await sidebar.refresh();
  const workMap = sidebar.viewsFor(client).find((v) => v.title.startsWith("Work map"));
  assert.equal(workMap.title, "Work map · open tabs");
  assert.ok(workMap.items.every((item) => item.tab), "no worktree without a tab");
  client.scope = "untabbed";
  assert.deepEqual(sidebar.viewsFor(client).find((v) => v.title.startsWith("Work map")).items.filter((i) => i.dir?.startsWith("/elsewhere")).map((i) => i.title), ["ABC-20  old", "ABC-21  older"]);
  for (const key of ["o", "l", "d", "e"]) await sidebar.missionKey(client, { key });
  assert.deepEqual(sidebar.viewsFor(client).find((v) => v.title.startsWith("Work map")).items.map((i) => i.title), ["ABC-21  older"], "the filter matches title and detail");
  await sidebar.missionKey(client, { key: "Escape" });
  assert.equal(client.ended, true, "Esc closes the picker");
});

test("the work map lists every open tab, lines its rows up in columns, and keeps merged work under a header, removable with x", async (t) => {
  const repo = path.join(tmp, "workmerged-repo");
  const git = (...args) => execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], { stdio: "ignore" });
  fs.mkdirSync(repo, { recursive: true });
  git("init", "-q", "-b", "main");
  git("commit", "-q", "--allow-empty", "-m", "start");
  git("remote", "add", "origin", "git@github.com:acme/workmerged.git");
  const working = path.join(repo, ".claude/worktrees/abc-30-going");
  const done = path.join(repo, ".claude/worktrees/abc-31-done");
  git("worktree", "add", "-q", "-b", "abc-30-going", working);
  git("worktree", "add", "-q", "-b", "abc-31-done", done);
  sidebar.known.set("acme/workmerged@abc-31-done", { pr: "51", merge: "merged" });
  const plainDir = path.join(tmp, "no-repo-here");
  fs.mkdirSync(plainDir, { recursive: true });
  // A tab in a subdirectory of its worktree, and one in no repository.
  fs.mkdirSync(path.join(working, "src"), { recursive: true });
  const inWork = tmux("new-window", "-d", "-t", "test", "-c", path.join(working, "src"), "-P", "-F", "#{window_id}");
  const loose = tmux("new-window", "-d", "-t", "test", "-c", plainDir, "-P", "-F", "#{window_id}");
  tmux("setw", "-t", inWork, "@tab_label", "ABC-30: Going");
  tmux("setw", "-t", loose, "@tab_label", "Slack relay");
  t.after(() => {
    sidebar.known.delete("acme/workmerged@abc-31-done");
    [inWork, loose].forEach((w) => { try { tmux("kill-window", "-t", w); } catch {} });
  });
  await sidebar.refresh();
  await sidebar.refreshWorktrees(sidebar.state.tabs);
  const rows = sidebar.workMap(sidebar.state.tabs).filter((r) => r.group || r.title === "Slack relay" || (r.tab?.path ?? r.dir)?.startsWith(repo));
  assert.deepEqual(rows.map((r) => [r.group ? "header" : r.title, r.merged]), [
    ["ABC-30  Going", false],
    ["Slack relay", false],
    ["header", undefined],
    ["ABC-31  done", true],
  ], "a tab in its worktree's subdirectory is that worktree's; one in no repository is a row of its own; merged work last, under its header");
  assert.deepEqual(rows[3].cells.map((c) => c.replace(tmp, "TMP")), ["ABC-31", "done", "no tab", "#51 merged", ""]);

  // M-j lists every open tab, the one in no repository too.
  const client = { kind: "mission", socket: { write() {}, end() {} }, view: { view: 1, cursor: 0 }, cols: 160, rows: 40, tmuxClient: "none", scope: "tabs" };
  assert.ok(sidebar.viewsFor(client)[0].items.some((i) => i.title === "Slack relay"));

  // The Work map itself: merged work hidden until Enter on its header.
  client.scope = undefined;
  const workMap = () => sidebar.viewsFor(client)[0].items;
  assert.ok(!workMap().some((i) => i.dir === done), "merged work starts hidden");
  client.view.cursor = workMap().findIndex((i) => i.group === "merged");
  assert.match(workMap()[client.view.cursor].title, /^▸ Merged, can be removed$/);
  await sidebar.missionKey(client, { key: "Enter" });
  assert.match(workMap()[client.view.cursor].title, /^▾ /);
  client.view.cursor = workMap().findIndex((i) => i.dir === done);
  assert.ok(client.view.cursor > 0, "and shown once opened");

  // Columns line up, and only the chosen row says where it is.
  const text = sidebar.missionLines({ tabs: sidebar.state.tabs, sections: sidebar.viewsFor(client), cols: 160, rows: 40, view: { ...client.view }, config }).map((line) => line.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ""));
  const chosen = text.find((line) => line.includes("ABC-31"));
  const other = text.find((line) => line.includes("ABC-30"));
  assert.equal(chosen.indexOf("done"), other.indexOf("Going"), "titles start in the same column");
  assert.ok(chosen.includes(done.replace(home, "~")) && !other.includes(working.replace(home, "~")), "the directory on the chosen row only");

  // x asks first, and git keeps a worktree with a file it doesn't track.
  fs.writeFileSync(path.join(done, "notes.txt"), "keep me");
  await sidebar.missionKey(client, { key: "x" });
  assert.match(client.confirm.text, /Remove this merged worktree\?/);
  await sidebar.missionKey(client, { key: "y" });
  assert.match(client.note, /^Kept abc-31-done: /);
  assert.ok(fs.existsSync(done));
  fs.rmSync(path.join(done, "notes.txt"));
  await sidebar.missionKey(client, { key: "x" });
  await sidebar.missionKey(client, { key: "n" });
  assert.ok(fs.existsSync(done), "n keeps it");
  await sidebar.missionKey(client, { key: "x" });
  await sidebar.missionKey(client, { key: "y" });
  assert.equal(client.note, "Removed abc-31-done.");
  assert.ok(!fs.existsSync(done));
});

test("the activity view puts each event's time first", () => {
  const section = { title: "Activity", items: [{ title: "worked 3m · finished 7 feed tab", detail: "", state: "attention", time: Date.now() - 120_000 }], loaded: true, builtIn: true, timeFirst: true };
  const text = sidebar.missionLines({ tabs: [], sections: [section], cols: 80, rows: 10, view: { view: 1, cursor: 0, frame: 0 }, config }).map((line) => line.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ""));
  assert.match(text[1], /^\s+2m ● worked 3m · finished 7 feed tab/);
});

test("the activity feed records what changed across the tabs, newest first, a turn as one line, and keeps it across a restart", () => {
  fs.rmSync(path.join(sidebar.STATE_DIR, "activity.jsonl"), { force: true });
  sidebar.resetActivity();
  const tab = (extra) => ({ id: "@70", index: 7, name: "feed tab", state: "idle", ...extra });
  sidebar.record([tab({})]);
  assert.deepEqual(sidebar.activityItems([]), [], "the first look only takes note");
  sidebar.record([tab({ state: "working", activity: "Run the test suite" })]);
  sidebar.record([tab({ state: "waiting", wait: "asks: Ship it?" })]);
  sidebar.record([tab({ state: "done" })]);
  sidebar.record([tab({ state: "background", pr: "12", checks: { pass: 3, fail: 2, pending: 0 } })]);
  sidebar.record([tab({ state: "idle", pr: "12", merge: "merged" })]);
  sidebar.record([tab({ state: "idle", pr: "12", merge: "merged" }), { id: "@71", index: 8, name: "new tab", state: "idle" }]);
  sidebar.record([{ id: "@71", index: 8, name: "new tab", state: "idle" }]);
  const feed = (tabs) => sidebar.activityItems(tabs).map((i) => [i.title.replace(/\s+/g, " "), i.detail, i.state]);
  const expected = [
    ["closed 7 feed tab", "", "idle"],
    ["opened 8 new tab", "", "idle"],
    ["merged 7 feed tab", "#12", "idle"],
    ["checks failing 7 feed tab", "✗2 on #12", "attention"],
    ["started working 7 feed tab", "", "active"],
    ["worked <1m · finished 7 feed tab", "Run the test suite", "attention"],
    ["waiting on you 7 feed tab", "asks: Ship it?", "attention"],
  ];
  assert.deepEqual(feed([]), expected);
  assert.equal(sidebar.activityItems([{ id: "@71" }])[1].tab?.id, "@71", "an open tab's event goes to it with Enter");
  // A restart reads them back, and its first look reports nothing new.
  sidebar.resetActivity();
  sidebar.record([{ id: "@71", index: 8, name: "new tab", state: "idle" }]);
  assert.deepEqual(feed([]), expected);
});

test("the Closed view lists closed tabs newest first, one per directory, to reopen with their Claude resumed", (t) => {
  fs.rmSync(path.join(sidebar.STATE_DIR, "activity.jsonl"), { force: true });
  sidebar.resetActivity();
  const realNow = Date.now;
  t.after(() => (Date.now = realNow));
  const claude = { id: "@80", index: 3, name: "ABC-1: Feat", state: "idle", path: "/work/abc-1", claude: { sessionId: "1234-abcd" } };
  const shell = { id: "@81", index: 4, name: "scratch", state: "idle", path: "/work/scratch" };
  const again = { id: "@82", index: 5, name: "ABC-1 older", state: "idle", path: "/work/abc-1", claude: { sessionId: "9999" } };
  const tool = { id: "@83", index: 6, name: "lazygit", state: "idle", path: "/work/tool" };
  // Seen a minute ago, so none closed within seconds of opening but the tool.
  Date.now = () => realNow() - 60_000;
  sidebar.record([]);
  sidebar.record([claude, shell, again]);
  Date.now = realNow;
  sidebar.record([claude, shell, again, tool]);
  sidebar.record([claude, shell]);
  sidebar.record([shell]);
  sidebar.record([]);
  const items = sidebar.closedItems([]);
  assert.deepEqual(items.map((i) => [i.title, i.detail, i.dir, i.command, i.shell]), [
    ["scratch", "closed <1m ago · a shell · /work/scratch", "/work/scratch", undefined, true],
    ["ABC-1: Feat", "closed <1m ago · resumes its Claude · /work/abc-1", "/work/abc-1", "zsh -i -c 'claude --resume 1234-abcd; exec zsh -i'", false],
  ], "the newest per directory, and not the tool's window");
  assert.deepEqual(sidebar.closedItems([{ path: "/work/scratch" }]).map((i) => i.title), ["ABC-1: Feat"], "not a directory open again");
  assert.ok(sidebar.builtInViews(sidebar.state).some((v) => v.title === "Closed"));
});

test("the PR board puts each PR in the column for where it stands, and h and l move between columns", async () => {
  const pr = (number, extra) => ({ number, title: `PR ${number}`, url: `https://github.com/acme/w/pull/${number}`, isDraft: false, state: "OPEN", reviewDecision: null, mergedAt: null, repository: { nameWithOwner: "acme/w" }, mergeQueueEntry: null, commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] }, ...extra });
  const columns = sidebar.boardFrom([
    pr(1, { isDraft: true }),
    pr(2, { commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE" } } }] } }),
    pr(3, { reviewDecision: "CHANGES_REQUESTED" }),
    pr(4, { reviewDecision: "APPROVED" }),
    pr(5, { reviewDecision: "APPROVED", mergeQueueEntry: { position: 2 } }),
    pr(6, { state: "MERGED", mergedAt: "2026-10-20T10:00:00Z" }),
    pr(7, { state: "MERGED", mergedAt: "2026-10-21T10:00:00Z" }),
    pr(2, {}),
  ]);
  assert.deepEqual(columns.map((c) => [c.title, c.items.map((i) => i.title)]), [
    ["Draft", ["#1 PR 1"]],
    ["In review", ["#2 PR 2", "#3 PR 3"]],
    ["Approved", ["#4 PR 4"]],
    ["In merge queue", ["#5 PR 5"]],
    ["Merged", ["#7 PR 7", "#6 PR 6"]],
  ], "a PR listed twice once, merged ones newest first");
  assert.deepEqual(columns[1].items.map((i) => [i.detail, i.state]), [["w · ✗ checks", "attention"], ["w · ✓ checks · changes requested", "attention"]]);

  sidebar.board.columns = columns;
  sidebar.board.loaded = true;
  const views = sidebar.builtInViews(sidebar.state);
  const at = views.findIndex((v) => v.board) + 1;
  const sent = [];
  const client = { kind: "mission", socket: { write: (text) => sent.push(text), end() {} }, view: { view: at, cursor: 0 }, cols: 150, rows: 20, tmuxClient: "none" };
  sidebar.draw(client);
  assert.match(plain(sent.at(-1)), /DRAFT 1 +IN REVIEW 2 +APPROVED 1 +IN MERGE QUEUE 1 +MERGED 2/);
  // j down a column, l across at the same row as far as it reaches, h back.
  await sidebar.missionKey(client, { key: "l" });
  await sidebar.missionKey(client, { key: "j" });
  assert.equal(views[at - 1].items[client.view.cursor].title, "#3 PR 3");
  await sidebar.missionKey(client, { key: "l" });
  assert.equal(views[at - 1].items[client.view.cursor].title, "#4 PR 4");
  await sidebar.missionKey(client, { key: "h" });
  assert.equal(views[at - 1].items[client.view.cursor].title, "#2 PR 2");
});

test("the Sessions view lists each Claude session by how full its context is, as the statusline recorded it", () => {
  // The statusline, given what Claude Code gives it, records the context and model.
  const statusline = path.join(__dirname, "../claude/statusline-command.sh");
  const input = JSON.stringify({ session_id: "sess-full", model: { display_name: "Opus" }, workspace: { current_dir: tmp }, context_window: { used_percentage: 86.4 } });
  execFileSync("bash", [statusline], { input, env: { ...process.env, HOME: home } });
  const recorded = path.join(home, ".local/state/tmux-sidebar/context/sess-full");
  assert.equal(fs.readFileSync(recorded, "utf8"), "86.4\tOpus");
  // The sidebar reads them from its own state directory.
  const contextDir = path.join(sidebar.STATE_DIR, "context");
  fs.mkdirSync(contextDir, { recursive: true });
  fs.copyFileSync(recorded, path.join(contextDir, "sess-full"));
  fs.writeFileSync(path.join(contextDir, "sess-light"), "12\tSonnet");
  const hour = Date.now() - 3_600_000;
  const tabs = [
    { id: "@81", index: 1, name: "light", state: "working", claude: { sessionId: "sess-light", cwd: "/work", startedAt: hour } },
    { id: "@82", index: 2, name: "full", state: "working", claude: { sessionId: "sess-full", cwd: "/work", startedAt: hour } },
    { id: "@83", index: 3, name: "no claude", state: "idle" },
  ];
  assert.deepEqual(sidebar.sessionItems(tabs).map((i) => [i.title, i.detail, i.state]), [
    ["2 full", "context 86% · Opus · up 1h", "attention"],
    ["1 light", "context 12% · Sonnet · up 1h", "active"],
  ], "fullest first, a full one needing you, a tab without Claude left out");
});

test("tabs in the sidebar are set apart by a rule", async () => {
  tmux("new-window", "-t", "test", "-c", tmp);
  const snap = await sidebar.snapshot();
  const tabs = sidebar.tabsFrom(snap);
  const { lines, owners } = sidebar.sidebarLines({ tabs, sections: [], cols: 30, rows: 14, view: { focused: false, cursor: tabs[0].id, frame: 0, here: tabs[0].id } });
  const text = lines.map((line) => line.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ""));
  // Header, blank, group title, a tab (name and state), the rule, the next tab.
  assert.equal(text[5], ` ${"─".repeat(28)} `);
  assert.equal(owners[5], undefined);
  assert.equal(owners[6], tabs[1].id);
});

test("the daemon draws the tabs in each sidebar and moves between them with the keys", async (t) => {
  t.after(() => sidebar.stop());
  tmux("rename-window", "-t", "test:", "alpha");
  const second = tmux("new-window", "-t", "test", "-c", tmp, "-P", "-F", "#{window_id}");
  tmux("rename-window", "-t", second, "bravo");
  tmux("set", "-p", "-t", second, "@agent_state", "waiting");
  tmux("set", "-p", "-t", second, "@agent_since", String(Math.floor(Date.now() / 1000) - 60));
  tmux("setw", "-t", second, "@agent", "waiting");
  const first = tmux("list-windows", "-t", "test", "-F", "#{window_id}").split("\n")[0];
  tmux("select-window", "-t", first);
  assert.equal(sidebar.start(), true);

  const pane = await until(() => sidebarPane(first));
  assert.ok(pane, "no sidebar in the first window");
  const screen = await until(() => {
    const text = tmux("capture-pane", "-p", "-t", pane);
    return text.includes("bravo") && text.includes("alpha") && text;
  });
  assert.ok(screen, "the sidebar never drew the tabs");
  // The waiting tab is listed first.
  assert.ok(screen.indexOf("bravo") < screen.indexOf("alpha"));
  assert.match(screen, /waiting on you 1m/);

  // A client attached, as when you are looking at it: without one the daemon
  // hands a sidebar's focus back to its window's main pane. Control mode
  // needs no terminal.
  const viewer = spawn("tmux", ["-S", socket, "-C", "attach", "-t", "test"], { stdio: ["pipe", "ignore", "ignore"] });
  t.after(() => viewer.kill());
  assert.equal(await until(() => tmux("display", "-p", "-t", "test", "#{session_attached}") !== "0"), true);

  // Into the sidebar from alpha: the cursor starts on alpha, the tab you are in.
  const session = tmux("display", "-p", "-t", second, "#{session_id}");
  tmux("select-pane", "-t", pane);
  await wait(100);
  await sidebar.refresh();
  assert.equal(sidebar.state.cursors.get(session), first);
  // Browsing shows each tab as the cursor reaches it: k up to bravo, first as
  // it waits on you, whose window comes to the front with focus in its own
  // sidebar and the cursor still on bravo.
  tmux("send-keys", "-t", pane, "k");
  assert.equal(await until(() => tmux("display", "-p", "-t", "test", "#{window_id}") === second), true, "bravo is in front");
  assert.equal(await until(() => tmux("display", "-p", "-t", second, "#{@sidebar}") === "1"), true, "focus is in bravo's sidebar");
  await sidebar.refresh();
  assert.equal(sidebar.state.cursors.get(session), second, "the cursor stayed on bravo");
  // Enter drops into bravo's pane.
  const bravoSidebar = tmux("display", "-p", "-t", second, "#{pane_id}");
  tmux("send-keys", "-t", bravoSidebar, "Enter");
  // Focus went to bravo's main pane, and alpha's sidebar gave it back too.
  assert.equal(await until(() => tmux("display", "-p", "-t", second, "#{@sidebar}") === ""), true);
  assert.equal(tmux("display", "-p", "-t", "test", "#{window_id}"), second);
  assert.equal(tmux("display", "-p", "-t", first, "#{@sidebar}"), "");

  // Mission control lists both, the waiting one first; l and Enter go to the other.
  const client = net.connect(sidebar.SOCKET);
  let received = "";
  client.on("data", (data) => (received += data));
  client.write("mission none 120 30\n");
  assert.ok(await until(() => plain(received).includes("MISSION CONTROL") && plain(received).includes("alpha")));
  assert.ok(plain(received).indexOf("bravo") < plain(received).indexOf("alpha"));
  // ? shows the keys over it; the next key only puts it back, the cursor where it was.
  received = "";
  client.write("?");
  assert.ok(await until(() => plain(received).includes("choose a card")), "the keys are shown");
  assert.match(plain(received), /MISSION CONTROL[\s\S]*╭─ Keys/, "in a box over mission control, which stays drawn");
  received = "";
  client.write("x");
  assert.ok(await until(() => plain(received).includes("MISSION CONTROL")), "and put away");
  client.write("l\r");
  assert.equal(await until(() => tmux("display", "-p", "-t", "test", "#{window_id}") === first), true);
  client.write("q");
  await until(() => client.destroyed || client.readableEnded);
  client.destroy();
});

test("a self-paced /loop counts as looping until its next wakeup is overdue, and a stop ends it", () => {
  const file = path.join(home, ".claude/projects/-work/loop.jsonl");
  const now = Date.now();
  const at = (ms) => new Date(now - ms).toISOString();
  const wakeup = (ms, input) => ({ type: "assistant", timestamp: at(ms), message: { content: [{ type: "tool_use", id: `s${ms}`, name: "ScheduleWakeup", input }] } });
  fs.writeFileSync(file, JSON.stringify(wakeup(60_000, { delaySeconds: 900, prompt: "/loop /oncall", reason: "quiet" })) + "\n");
  assert.deepEqual(sidebar.backgroundWork(file, now - 120_000), { count: 0, monitors: [], scheduled: { prompt: "/oncall", at: now - 60_000 + 900_000 } });
  assert.deepEqual(sidebar.backgroundWork(file, now - 30_000), { count: 0, monitors: [] }, "scheduled by an earlier process");

  fs.appendFileSync(file, JSON.stringify(wakeup(20_000, { stop: true })) + "\n");
  assert.deepEqual(sidebar.backgroundWork(file, now - 120_000), { count: 0, monitors: [] }, "stopped");

  fs.writeFileSync(file, JSON.stringify(wakeup(30 * 60_000, { delaySeconds: 600, prompt: "/loop /oncall" })) + "\n");
  assert.deepEqual(sidebar.backgroundWork(file, now - 60 * 60_000), { count: 0, monitors: [] }, "overdue, so the loop ended");

  const tab = { id: "@9", index: 9, name: "on call", state: "background", background: 0, monitors: [], loop: { kind: "scheduled", prompt: "/oncall", at: now + 7 * 60_000 + 5_000 }, session: "$1", panes: [], sidebars: [] };
  assert.equal(sidebar.staged([tab])[0].key, "scheduled");
  assert.equal(sidebar.stateWords(tab), "next in 7m · /oncall");
});

test("a cron job Claude created is a loop until CronDelete names it, shown by its prompt's first sentence and next run", () => {
  const file = path.join(home, ".claude/projects/-work/cron.jsonl");
  const now = Date.now();
  const at = (ms) => new Date(now - ms).toISOString();
  const prompt = "Watch the reply to the DM. Read the channel, and act on it.";
  const entries = [
    { type: "assistant", timestamp: at(60_000), message: { content: [{ type: "tool_use", id: "c1", name: "CronCreate", input: { cron: "*/5 * * * *", recurring: true, prompt } }] } },
    { type: "user", timestamp: at(60_000), message: { content: [{ type: "tool_result", tool_use_id: "c1", content: "Scheduled recurring job a03c0408 (*/5 * * * *). Next run: soon. Session-only." }] } },
  ];
  fs.writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  const work = sidebar.backgroundWork(file, now - 120_000);
  assert.equal(work.scheduled.prompt, "Watch the reply to the DM.");
  assert.equal(work.scheduled.at, sidebar.nextCron("*/5 * * * *", now));
  assert.ok(work.scheduled.at > now && work.scheduled.at <= now + 5 * 60_000);

  fs.appendFileSync(file, JSON.stringify({ type: "assistant", timestamp: at(1_000), message: { content: [{ type: "tool_use", id: "c2", name: "CronDelete", input: { id: "a03c0408" } }] } }) + "\n");
  assert.deepEqual(sidebar.backgroundWork(file, now - 120_000), { count: 0, monitors: [] }, "deleted");

  const nine = new Date(2026, 9, 26, 8, 59, 30).getTime();
  assert.equal(sidebar.nextCron("0 9 * * 1-5", nine), new Date(2026, 9, 26, 9, 0).getTime());
  assert.equal(sidebar.nextCron("3-59/5 * * * *", new Date(2026, 9, 26, 16, 9).getTime()), new Date(2026, 9, 26, 16, 13).getTime());
  assert.equal(sidebar.loopName("/loop 5m /babysit-prs"), "/babysit-prs");
});

test("mission control's Settings view lists the options by category, / narrows them to the matching categories, and Enter and Space change one", async () => {
  const settingsFile = path.join(home, ".config/switchboard/settings.json");
  fs.rmSync(settingsFile, { force: true });
  const sent = [];
  const client = { kind: "mission", socket: { write: (text) => sent.push(text), end() {} }, view: { view: 0, cursor: 0 }, cols: 160, rows: 40, tmuxClient: "none" };
  try {
    await sidebar.refresh();
    client.view.view = sidebar.viewsFor(client).findIndex((s) => s.title === "Settings") + 1;
    await sidebar.missionKey(client, { key: "g" });
    const all = plain(sent.at(-1));
    assert.match(all, /NOTIFICATIONS 2[\s\S]*Push notifications +on +A macOS banner[\s\S]*SLACK RELAY 1/);

    // / then "notif": the Notifications header and its two options, and no other category.
    for (const key of ["/", "n", "o", "t", "i", "f", "Enter"]) await sidebar.missionKey(client, { key });
    const items = sidebar.viewsFor(client)[client.view.view - 1].items;
    assert.deepEqual(items.map((i) => i.title), ["Notifications", "Push notifications", "Finished tabs clear"]);
    assert.doesNotMatch(plain(sent.at(-1)), /SIDEBAR|Theme/);

    // Enter on an on/off option turns it off, and only what differs from the default is written.
    await sidebar.missionKey(client, { key: "j" });
    await sidebar.missionKey(client, { key: "Enter" });
    assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, "utf8")), { notifications: false });
    assert.match(plain(sent.at(-1)), /Push notifications +off/);
    // Space on a choice goes to its next one; turning the first back on leaves only that.
    await sidebar.missionKey(client, { key: "Enter" });
    await sidebar.missionKey(client, { key: "j" });
    await sidebar.missionKey(client, { key: "Space" });
    assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, "utf8")), { done_clears: "prompt" });
    assert.match(plain(sent.at(-1)), /Finished tabs clear +on prompt/);
  } finally {
    fs.rmSync(settingsFile, { force: true });
    sidebar.reloadSettings();
  }
});

test("with the github and linear settings off, mission control has no PRs view and the Work map no PR or ticket", () => {
  const settingsFile = path.join(home, ".config/switchboard/settings.json");
  const tab = { id: "@90", index: 9, name: "Some work", path: path.join(tmp, "nowhere"), pr: "12", state: "idle" };
  try {
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    fs.rmSync(settingsFile, { force: true });
    sidebar.reloadSettings();
    assert.ok(sidebar.builtInViews({ tabs: [] }).some((v) => v.title === "PRs"));
    assert.equal(sidebar.workMap([tab]).find((r) => r.tab === tab).cells[3], "#12 open");

    fs.writeFileSync(settingsFile, JSON.stringify({ github: false, linear: false }));
    sidebar.reloadSettings();
    assert.ok(!sidebar.builtInViews({ tabs: [] }).some((v) => v.title === "PRs"));
    assert.equal(sidebar.workMap([tab]).find((r) => r.tab === tab).cells[3], "");
    assert.deepEqual(sidebar.mergeOf({ path: tab.path, branch: "feat" }), {});
  } finally {
    fs.rmSync(settingsFile, { force: true });
    sidebar.reloadSettings();
  }
});

test("a tab whose transcript can't be read is still listed, and the others with it", async () => {
  tmux("new-window", "-t", "test", "-c", tmp);
  const pane = tmux("display", "-p", "-t", "test:", "#{pane_id}");
  tmux("set", "-p", "-t", pane, "@agent_state", "done");
  tmux("set", "-p", "-t", pane, "@agent_since", String(Math.floor(Date.now() / 1000)));
  // A directory where its transcript should be: reading it throws.
  fs.mkdirSync(path.join(home, ".claude/projects/-work/broken.jsonl"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude/sessions/131.json"), JSON.stringify({ pid: 131, sessionId: "broken", cwd: "/work", tmux: `test:@9.${pane}`, entrypoint: "cli" }));
  const failures = [];
  try {
    const tabs = sidebar.tabsFrom(await sidebar.snapshot(), (tab, err) => failures.push(err.code));
    assert.equal(tabs.length, 2);
    assert.equal(tabs.find((t) => t.claudePane === pane).background, 0);
    assert.deepEqual(failures, ["EISDIR"]);
  } finally {
    fs.rmSync(path.join(home, ".claude/sessions/131.json"));
    fs.rmSync(path.join(home, ".claude/projects/-work/broken.jsonl"), { recursive: true });
  }
});

test("a merged tab's badge says merged while Claude is marked working, and waiting still wins", async () => {
  const snap = await sidebar.snapshot();
  const [tab] = sidebar.tabsFrom(snap);
  const badgeOf = (t) => sidebar.sidebarLines({ tabs: [t], sections: [], cols: 40, rows: 10, view: { focused: false, cursor: t.id, frame: 0, here: t.id } }).lines.join("");
  assert.match(badgeOf({ ...tab, state: "working", merge: "merged" }), /◆/);
  assert.doesNotMatch(badgeOf({ ...tab, state: "working", merge: "merged" }), /⠋/);
  assert.doesNotMatch(badgeOf({ ...tab, state: "waiting", merge: "merged" }), /◆/);
  assert.match(badgeOf({ ...tab, state: "working", merge: "queued" }), /⠋/, "a tab in the merge queue keeps its working spinner");
});
