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
const { execFileSync } = require("node:child_process");
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

test("tabs whose PR is in the merge queue or merged get sections of their own, after the ones that need you", () => {
  const base = { session: "$1", sessionName: "test", panes: [], sidebars: [], since: undefined, command: "zsh" };
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
    a2: { number: 14, state: "OPEN", mergeQueueEntry: null },
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
  assert.deepEqual(sidebar.mergeOf(tabs[2]), {});
  assert.deepEqual(sidebar.mergeOf(gone), { merge: "merged", pr: "15" }, "found by its branch, PR and all");
  // Shown with that PR, the tab is still found by its branch next time.
  assert.deepEqual(sidebar.mergeOf({ ...gone, pr: "15" }), { merge: "merged", pr: "15" });
  // The same answers again change nothing.
  await sidebar.fetchMerges(tabs, () => changed++);
  assert.equal(changed, 1);

  assert.equal(
    sidebar.queryFor(['acme/widgets#1) { x } #', 'a"b/c#2', "acme/widgets@x\" }", "acme/widgets#7"]).query,
    'query { r0: repository(owner: "acme", name: "widgets") { a0: pullRequest(number: 7) { number state mergeQueueEntry { position } } } }',
  );
});

test("a tab whose turn ended with background tasks still running reads as working in the background", () => {
  const file = path.join(home, ".claude/projects/-work/background.jsonl");
  const now = Date.now();
  const started = (id, ms) => JSON.stringify({ type: "user", timestamp: new Date(ms).toISOString(), message: { content: [{ type: "tool_result", content: `Command running in background with ID: ${id}. Output is being written to: /tmp/x` }] } });
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

  const tab = { id: "@9", index: 9, name: "review", state: "background", background: 2, session: "$1", panes: [], sidebars: [] };
  assert.equal(sidebar.stateWords(tab), "working in background · 2 tasks");
  assert.deepEqual(sidebar.grouped([tab, { ...tab, id: "@8", index: 8, state: "done", background: 0 }]).map((g) => [g.title, g.tabs.map((x) => x.id)]), [
    ["Needs you", ["@8"]],
    ["Working", ["@9"]],
  ], "not one that needs you");
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
  assert.deepEqual(sidebar.backgroundWork(file, now - 60_000), { count: 2, loop: { kind: "review", round: 2 } });

  // A CI loop next: its watch, started again after a fix, counts one a round.
  const ci = "info=$(gh pr view 12 --json state); checks=$(gh pr checks 12 --json name,bucket)";
  fs.appendFileSync(file, [
    ended("r2a"), ended("r2b"),
    { type: "user", timestamp: at(3_000), message: { content: "<command-name>/ci-loop</command-name>" } },
    ...run("u5", "ci1", ci, 2_500), ended("ci1"), ...run("u6", "ci2", ci, 1_000),
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  assert.deepEqual(sidebar.backgroundWork(file, now - 60_000), { count: 1, loop: { kind: "ci", round: 2 } });
  // queue-and-clean's watch reads the checks too, but is the queue's.
  fs.appendFileSync(file, [ended("ci2"), ...run("u7", "q1", "gh api graphql -f query='{ pullRequest { mergeQueueEntry { state } } }'; gh pr checks 12 --required", 500)].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  assert.deepEqual(sidebar.backgroundWork(file, now - 60_000), { count: 1, loop: { kind: "queue", round: 1 } });
  // Anything else is plain background work.
  fs.appendFileSync(file, [ended("q1"), ...run("u8", "x1", "sleep 100", 100)].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  assert.deepEqual(sidebar.backgroundWork(file, now - 60_000), { count: 1 });

  const tab = { id: "@9", index: 9, name: "review", state: "background", background: 2, loop: { kind: "review", round: 2 }, session: "$1", panes: [], sidebars: [] };
  assert.equal(sidebar.stateWords({ ...tab, loop: { kind: "ci", round: 3 } }), "CI loop · round 3");
  assert.equal(sidebar.stateWords({ ...tab, loop: { kind: "queue", round: 1 } }), "queue-and-clean · watching");
  assert.equal(sidebar.stateWords(tab), "review loop · round 2");
  const { lines } = sidebar.sidebarLines({ tabs: [tab], sections: [], cols: 40, rows: 12, view: { focused: false, cursor: "@9", frame: 0, here: "@9" } });
  assert.match(lines.join("\n"), /\x1b\[48;5;97m/, "the review loop's own badge color");
});

test("mission control packs its stages side by side, each block under its own header", () => {
  const base = { session: "$1", panes: [], sidebars: [], command: "zsh" };
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

test("a tab flagged by hand needs you, whatever Claude is doing in it, until it is unflagged", async () => {
  const window = tmux("new-window", "-t", "test", "-c", tmp, "-P", "-F", "#{window_id}");
  try {
    tmux("setw", "-t", window, "@flagged", "1");
    let tab = sidebar.tabsFrom(await sidebar.snapshot()).find((x) => x.id === window);
    assert.equal(tab.flagged, true);
    assert.deepEqual(sidebar.grouped([tab]).map((g) => g.title), ["Needs you"]);
    assert.deepEqual(sidebar.missionGrid([tab], 100, 20).shelves[0].blocks.map((b) => b.stage.title), ["Needs you"]);
    assert.match(sidebar.stateWords(tab), /^flagged · /);
    assert.match(sidebar.sidebarLines({ tabs: [tab], sections: [], cols: 40, rows: 10, view: { focused: false, cursor: window, frame: 0, here: window } }).lines.join(""), /⚑/);
    tmux("setw", "-u", "-t", window, "@flagged");
    tab = sidebar.tabsFrom(await sidebar.snapshot()).find((x) => x.id === window);
    assert.deepEqual(sidebar.grouped([tab]).map((g) => g.title), ["Idle"]);
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

  // Into the sidebar from alpha: the cursor starts on the first tab (bravo),
  // so Enter goes there with no move.
  tmux("select-pane", "-t", pane);
  await wait(100);
  await sidebar.refresh();
  tmux("send-keys", "-t", pane, "Enter");
  assert.equal(await until(() => tmux("display", "-p", "-t", "test", "#{window_id}") === second), true);
  // Focus went to bravo's main pane, and alpha's sidebar gave it back too.
  assert.equal(tmux("display", "-p", "-t", second, "#{@sidebar}"), "");
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
  received = "";
  client.write("x");
  assert.ok(await until(() => plain(received).includes("MISSION CONTROL")), "and put away");
  client.write("l\r");
  assert.equal(await until(() => tmux("display", "-p", "-t", "test", "#{window_id}") === first), true);
  client.write("q");
  await until(() => client.destroyed || client.readableEnded);
  client.destroy();
});
