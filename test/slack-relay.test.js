// Tests for bin/slack-relay. Run with: node --test test/*.test.js
//
// Nothing here touches your real tabs, Slack, or ~/.claude. Before the relay is
// loaded, HOME points at a temporary directory and TMUX at a tmux server of
// the tests' own, which every plain `tmux` command then talks to; the tests
// refuse to run unless that is so. Its "Claude" panes run a copy of cat named
// like a Claude Code version, so the relay takes them for Claude and typing
// into one just echoes. Slack is two stand-ins put in place of the relay's
// Haiku sessions, and `claude` on the PATH is a script that fails, so no
// real session can start by accident.

const { test, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "slack-relay-test-")));
const home = path.join(tmp, "home");
const fakeBin = path.join(tmp, "bin");
const fakeClaude = path.join(fakeBin, "2.1.0");
const socket = path.join(tmp, "tmux.sock");
fs.mkdirSync(path.join(home, ".claude/sessions"), { recursive: true });
fs.mkdirSync(path.join(home, ".claude/projects/-work"), { recursive: true });
fs.mkdirSync(fakeBin);
fs.copyFileSync("/bin/cat", fakeClaude);
// A copied system binary is killed on launch until it is signed again.
execFileSync("codesign", ["-s", "-", "-f", fakeClaude], { stdio: "ignore" });
fs.writeFileSync(path.join(fakeBin, "claude"), "#!/bin/sh\necho 'no real claude in tests' >&2\nexit 1\n", { mode: 0o755 });

const realTmux = process.env.TMUX;
delete process.env.TMUX;
execFileSync("tmux", ["-S", socket, "-f", "/dev/null", "new-session", "-d", "-s", "test", "-x", "200", "-y", "50", fakeClaude]);
execFileSync("tmux", ["-S", socket, "set", "-g", "default-command", fakeClaude]);
const serverPid = execFileSync("tmux", ["-S", socket, "display", "-p", "#{pid}"], { encoding: "utf8" }).trim();
Object.assign(process.env, {
  HOME: home,
  TMUX: `${socket},${serverPid},0`,
  TMUX_TMPDIR: tmp,
  PATH: `${fakeBin}:${process.env.PATH}`,
  LC_ALL: "en_US.UTF-8",
});
delete process.env.TMUX_PANE;

const tmux = (...args) => execFileSync("tmux", args, { encoding: "utf8" }).trimEnd();
assert.equal(tmux("display", "-p", "#{socket_path}"), socket, "tmux is not the tests' own server");
assert.notEqual(tmux("display", "-p", "#{socket_path}"), realTmux?.split(",")[0]);
assert.equal(os.homedir(), home);

const relay = require("../bin/slack-relay");
assert.ok(relay.STATE_DIR.startsWith(home));

const SEND = "mcp__claude_ai_Slack__slack_send_message";
const READ_CHANNEL = "mcp__claude_ai_Slack__slack_read_channel";
const READ_THREAD = "mcp__claude_ai_Slack__slack_read_thread";
const ADD_REACTION = "mcp__claude_ai_Slack__slack_add_reaction";

// What the poster stand-in was asked to post, and to react to, in order.
let posts;
let reactions;
let nextTs;
beforeEach(() => {
  posts = [];
  reactions = [];
  nextTs = Math.floor(Date.now() / 1000);
  relay.slack.poster = {
    call: async (prompt, expect) => {
      if (expect === ADD_REACTION) {
        reactions.push({ ts: prompt.match(/message_ts (\S+),/)[1], emoji: prompt.match(/emoji (\w+)/)[1] });
        return [{ name: ADD_REACTION, input: {}, raw: "{\"ok\":true}" }];
      }
      const body = JSON.parse(prompt.slice(prompt.indexOf("\n\n") + 2));
      const thread = prompt.match(/thread_ts (\d+\.\d+)/)?.[1];
      const broadcast = /reply_broadcast true/.test(prompt);
      const ts = `${nextTs++}.000100`;
      posts.push({ body, thread, broadcast, ts, outgoing: fs.readFileSync(relay.OUTGOING_FILE, "utf8") });
      return [{ name: SEND, input: { message: body }, raw: JSON.stringify({ message_context: { message_ts: ts } }) }];
    },
  };
  relay.slack.reader = {
    call: async () => {
      throw new Error("this test reads nothing from Slack");
    },
  };
  relay.ownerOnly();
});

after(() => {
  try {
    execFileSync("tmux", ["-S", socket, "kill-server"], { stdio: "ignore" });
  } catch {}
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("parseMessages reads channel and thread output", () => {
  const channel = [
    "=== Message from Me (U1) at 2026-10-09 10:00:00 EDT ===",
    "Message TS: 1791578631.637999",
    "3: run the tests",
    "and report",
    "Thread: 2 replies (latest: 2026-10-09 16:41:01 EDT)",
    "=== Message from Me (U1) at 2026-10-09 10:01:00 EDT ===",
    "Message TS: 1791578700.000100",
    ":robot_face: Sent to tab 3.",
    "*Sent using* <@U2|Claude>",
  ].join("\n");
  const messages = relay.parseMessages(channel);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].ts, "1791578631.637999");
  assert.equal(messages[0].text, "3: run the tests\nand report");
  assert.equal(messages[0].latestReply, new Date(2026, 9, 9, 16, 41, 1).getTime() / 1000);
  assert.equal(messages[1].text, ":robot_face: Sent to tab 3.");
  assert.equal(messages[1].latestReply, undefined);
  assert.equal(messages[0].byClaude, false);
  assert.equal(messages[1].byClaude, true);

  // The second part of a long reply has no 🤖, only the signature.
  const continued = relay.parseMessages("=== Message from Me (U1) at x ===\nMessage TS: 1791578900.000100\nthe rest of a long answer\n*Sent using* <@U2|Claude>");
  assert.equal(continued[0].text, "the rest of a long answer");
  assert.equal(continued[0].byClaude, true);

  const thread = "=== THREAD REPLIES ===\n--- Reply 1 of 1 ---\nFrom: Me\nMessage TS: 1791578800.000200\nyes";
  const replies = relay.parseMessages(thread);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].ts, "1791578800.000200");
  assert.match(replies[0].text, /yes$/);
});

test("chunks splits long text at line breaks and keeps code blocks whole", () => {
  assert.deepEqual(relay.chunks("short"), ["short"]);
  const text = "intro\n```\n" + Array.from({ length: 400 }, (_, i) => `line ${i} of the output`).join("\n") + "\n```\nend";
  const parts = relay.chunks(text);
  assert.ok(parts.length > 1);
  parts.forEach((part) => {
    assert.ok(part.length <= relay.MAX_POST_CHARS + 4);
    assert.equal((part.match(/```/g) ?? []).length % 2, 0, "every part opens and closes its code block");
  });
  assert.equal(parts.join("\n").replace(/\n```\n```\n/g, "\n"), text);
});

test("a wide fetchMessages reads only threads with new replies, and only what is new", async () => {
  const cursor = "1791578000.000100";
  const quiet = "1791577000.000100";
  const busy = "1791577500.000100";
  const state = {
    dm: { channel: "D1", user: "U1" },
    cursor,
    threads: { [quiet]: "1791577900.000100", [busy]: "1791577600.000100" },
  };
  const stamp = (ts) => {
    const d = new Date(Number(ts) * 1000);
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };
  const channelText = [
    `=== Message from Me (U1) at x ===\nMessage TS: ${quiet}\n:robot_face: an alert\nThread: 1 replies (latest: ${stamp(1791577800)} EDT)`,
    `=== Message from Me (U1) at x ===\nMessage TS: ${busy}\n:robot_face: another alert\nThread: 2 replies (latest: ${stamp(1791577700)} EDT)`,
    `=== Message from Me (U1) at x ===\nMessage TS: ${cursor}\nalready handled`,
    `=== Message from Me (U1) at x ===\nMessage TS: 1791578100.000100\n2: hello`,
  ].join("\n");
  const asked = [];
  relay.slack.reader = {
    call: async (prompt, expect) => {
      asked.push({ prompt, expect });
      if (expect === READ_CHANNEL) {
        assert.match(prompt, new RegExp(`oldest ${Number(quiet) - 1}`));
        return [{ name: READ_CHANNEL, input: {}, raw: JSON.stringify({ messages: channelText }) }];
      }
      return [{
        name: READ_THREAD,
        input: { message_ts: busy },
        raw: JSON.stringify({
          messages: `=== THREAD REPLIES ===\n--- Reply 1 of 2 ---\nMessage TS: 1791577600.000100\nold reply\n--- Reply 2 of 2 ---\nMessage TS: 1791577700.000100\nnew reply`,
        }),
      }];
    },
  };
  const { messages } = await relay.fetchMessages(state, { wide: true });
  assert.equal(asked.length, 2);
  assert.match(asked[1].prompt, new RegExp(`message_ts ${busy}`));
  assert.doesNotMatch(asked[1].prompt, new RegExp(quiet));
  assert.deepEqual(messages, [
    { ts: "1791578100.000100", text: "2: hello", byClaude: false, thread_ts: null },
    { ts: "1791577700.000100", text: "new reply", byClaude: false, thread_ts: busy },
  ]);
});

test("a narrow fetchMessages reads from the cursor only", async () => {
  const state = {
    dm: { channel: "D1", user: "U1" },
    cursor: "1791578000.000100",
    threads: { "1791577000.000100": "1791577000.000100" },
  };
  const asked = [];
  relay.slack.reader = {
    call: async (prompt, expect) => {
      asked.push(prompt);
      return [{ name: READ_CHANNEL, input: {}, raw: JSON.stringify({ messages: "=== Message from Me (U1) at x ===\nMessage TS: 1791578100.000100\nstatus" }) }];
    },
  };

  const { messages } = await relay.fetchMessages(state, { wide: false });

  assert.equal(asked.length, 1);
  assert.match(asked[0], /oldest 1791578000\.000100,/);
  assert.deepEqual(messages, [{ ts: "1791578100.000100", text: "status", byClaude: false, thread_ts: null }]);
});

test("turnFrom shows the last prompt, the reply, and a tool count", () => {
  const file = path.join(home, ".claude/projects/-work/turn.jsonl");
  const sent = new Date(Date.now() - 5 * 60_000).toISOString();
  fs.writeFileSync(file, [
    { type: "user", message: { content: "an earlier prompt" } },
    { type: "assistant", message: { content: [{ type: "text", text: "earlier reply" }] } },
    { type: "user", timestamp: sent, message: { content: [{ type: "text", text: "run   the\ntests" }] } },
    { type: "user", isMeta: true, message: { content: "meta" } },
    { type: "assistant", message: { content: [{ type: "text", text: "Running them." }, { type: "tool_use", id: "t1" }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } },
    { type: "assistant", isSidechain: true, message: { content: [{ type: "text", text: "a subagent" }] } },
    { type: "assistant", message: { content: [{ type: "text", text: "All pass." }] } },
  ].map((entry) => JSON.stringify(entry)).join("\n"));

  assert.equal(relay.turnFrom(file), "_(prompt sent 5m ago)_\n> run   the\n> tests\n\nRunning them.\n\nAll pass.\n\n_(ran 1 tool)_");
  assert.ok(relay.turnFrom(file, "run the tests"));
  assert.equal(relay.turnFrom(file, "something else"), undefined);
  assert.equal(relay.turnFrom(path.join(tmp, "missing.jsonl")), undefined);
});

test("transcriptFor follows parked sessions to the end of the chain", () => {
  const window = tmux("new-window", "-d", "-P", "-F", "#{window_id}", fakeClaude);
  const panePid = tmux("display", "-p", "-t", window, "#{pane_pid}");
  const sessions = path.join(home, ".claude/sessions");
  // The tab's session was parked into job A, which was itself parked into job
  // B. The jobs need live processes; this test's own will do.
  fs.writeFileSync(path.join(sessions, `${panePid}.json`), JSON.stringify({ pid: Number(panePid), sessionId: "tab", parkedJobId: "A" }));
  fs.writeFileSync(path.join(sessions, "900001.json"), JSON.stringify({ pid: process.pid, sessionId: "job-a", jobId: "A", parkedJobId: "B" }));
  fs.writeFileSync(path.join(sessions, "900002.json"), JSON.stringify({ pid: process.pid, sessionId: "job-b", jobId: "B" }));
  // A dead job with the same ID is not the one.
  fs.writeFileSync(path.join(sessions, "900003.json"), JSON.stringify({ pid: 999999, sessionId: "dead", jobId: "B" }));
  ["tab", "job-a", "job-b", "dead"].forEach((id) => fs.writeFileSync(path.join(home, `.claude/projects/-work/${id}.jsonl`), ""));

  assert.equal(relay.transcriptFor(window), path.join(home, ".claude/projects/-work/job-b.jsonl"));

  // A chain that loops back on itself ends rather than spinning.
  fs.writeFileSync(path.join(sessions, "900002.json"), JSON.stringify({ pid: process.pid, sessionId: "job-b", jobId: "B", parkedJobId: "A" }));
  assert.equal(relay.transcriptFor(window), path.join(home, ".claude/projects/-work/job-b.jsonl"));

  ["900001", "900002", "900003", panePid].forEach((pid) => fs.rmSync(path.join(sessions, `${pid}.json`)));
  tmux("kill-window", "-t", window);
});

test("a top-level request is typed into the tab and goes on in the tab's home thread", async () => {
  const [window, index] = tmux("new-window", "-d", "-P", "-F", "#{window_id}\t#{window_index}", fakeClaude).split("\t");
  // tmux takes a moment to see the pane's command as the fake Claude.
  await new Promise((resolve) => setTimeout(resolve, 300));
  const state = { dm: { channel: "D1", user: "U1" }, threads: {}, alerts: {}, reported: {}, following: {} };
  const ts = `${Math.floor(Date.now() / 1000)}.000001`;

  await relay.handle(state, { ts, text: `${index}: hello from slack`, thread_ts: null });
  await new Promise((resolve) => setTimeout(resolve, 200));

  assert.match(tmux("capture-pane", "-p", "-t", window), /hello from slack/);
  // The tab's home thread starts, and "Sent to" goes in it, shown in the main DM too.
  assert.equal(posts.length, 2);
  const homeThread = posts[0].ts;
  assert.match(posts[0].body, new RegExp(`^🤖 Tab ${index}, .*\\. This is its thread`));
  assert.equal(posts[0].thread, undefined);
  assert.equal(state.homes[window].ts, homeThread);
  assert.equal(posts[1].thread, homeThread);
  assert.equal(posts[1].broadcast, true);
  assert.match(posts[1].body, new RegExp(`^🤖 Sent to tab ${index}, `));
  assert.equal(state.alerts[homeThread].window, window);
  assert.equal(state.alerts[posts[1].ts].window, window);
  assert.equal(state.following[window].text, "hello from slack");
  assert.equal(state.following[window].thread, homeThread);
  assert.equal(state.following[window].request, ts);

  // The next request reuses the home thread.
  await relay.handle(state, { ts: `${Math.floor(Date.now() / 1000)}.000017`, text: `${index}: and again`, thread_ts: null });
  assert.equal(posts.length, 3);
  assert.equal(posts[2].thread, homeThread);
  tmux("kill-window", "-t", window);
});

test("a reply under an alert goes to the alert's tab", async () => {
  const [window, index] = tmux("new-window", "-d", "-P", "-F", "#{window_id}\t#{window_index}", fakeClaude).split("\t");
  // tmux takes a moment to see the pane's command as the fake Claude.
  await new Promise((resolve) => setTimeout(resolve, 300));
  const alert = `${Math.floor(Date.now() / 1000) - 60}.000100`;
  const state = { dm: { channel: "D1", user: "U1" }, threads: {}, alerts: { [alert]: { window, index: Number(index), name: "work" } }, reported: {}, following: {} };

  await relay.handle(state, { ts: `${Math.floor(Date.now() / 1000)}.000002`, text: "2", thread_ts: alert });
  await new Promise((resolve) => setTimeout(resolve, 200));

  assert.match(tmux("capture-pane", "-p", "-t", window), /^2$/m);
  assert.equal(posts[0].thread, alert);
  assert.match(posts[0].body, new RegExp(`Sent to tab ${index}, work`));
  tmux("kill-window", "-t", window);
});

test("unrecognised, mistargeted and old messages are not typed anywhere", async () => {
  const [window, index] = tmux("new-window", "-d", "-P", "-F", "#{window_id}\t#{window_index}", fakeClaude).split("\t");
  // tmux takes a moment to see the pane's command as the fake Claude.
  await new Promise((resolve) => setTimeout(resolve, 300));
  const state = { dm: { channel: "D1", user: "U1" }, threads: {}, alerts: {}, reported: {}, following: {} };
  const now = Math.floor(Date.now() / 1000);

  await relay.handle(state, { ts: `${now}.000003`, text: `l: yes`, thread_ts: null });
  await relay.handle(state, { ts: `${now}.000004`, text: `99: yes`, thread_ts: null });
  await relay.handle(state, { ts: `${now - 600}.000005`, text: `${index}: yes`, thread_ts: null });
  await relay.handle(state, { ts: `${now}.000006`, text: "just chatting", thread_ts: "1791500000.000200" });
  await new Promise((resolve) => setTimeout(resolve, 200));

  assert.match(posts[0].body, /I didn't recognise that/);
  assert.match(posts[0].body, new RegExp(`Tabs: .*${index} `));
  assert.equal(posts[1].body, "🤖 No Claude tab 99.");
  assert.match(posts[2].body, /I missed this while I wasn't running/);
  assert.match(posts[3].body, /This thread isn't linked to a tab/);
  assert.equal(posts[3].thread, "1791500000.000200");
  assert.doesNotMatch(tmux("capture-pane", "-p", "-t", window), /yes|chatting/);
  assert.deepEqual(state.following, {});
  tmux("kill-window", "-t", window);
});

test("status lists the Claude tabs with their states", async () => {
  const [window, index] = tmux("new-window", "-d", "-P", "-F", "#{window_id}\t#{window_index}", fakeClaude).split("\t");
  // tmux takes a moment to see the pane's command as the fake Claude.
  await new Promise((resolve) => setTimeout(resolve, 300));
  tmux("set", "-p", "-t", window, "@agent_state", "waiting");
  const state = { dm: { channel: "D1", user: "U1" }, threads: {}, alerts: {}, reported: {}, following: {} };

  await relay.handle(state, { ts: `${Math.floor(Date.now() / 1000)}.000007`, text: "status", thread_ts: null });

  assert.match(posts[0].body, new RegExp(`• Tab ${index}, .*: \\*waiting on you\\*`));
  assert.equal(posts[0].thread, undefined);
  tmux("kill-window", "-t", window);
});

test("new: starts a tab running claude with the prompt", async () => {
  const before = tmux("list-windows", "-F", "#{window_id}").split("\n");
  const state = { dm: { channel: "D1", user: "U1" }, threads: {}, alerts: {}, reported: {}, following: {} };

  const ts = await relay.handle(state, { ts: `${Math.floor(Date.now() / 1000)}.000008`, text: "new: fix the 'login' bug", thread_ts: null });
  await new Promise((resolve) => setTimeout(resolve, 200));

  const window = tmux("list-windows", "-F", "#{window_id}").split("\n").find((id) => !before.includes(id));
  assert.ok(window);
  assert.match(tmux("capture-pane", "-p", "-t", window), /claude 'fix the '\\''login'\\'' bug'/);
  assert.equal(state.alerts[ts].window, window);
  tmux("kill-window", "-t", window);
});

test("newEvents carries on from the saved offset and leaves half-written lines", () => {
  fs.writeFileSync(relay.EVENTS_FILE, `${JSON.stringify({ event: "done", time: 1 })}\n${JSON.stringify({ event: "waiting", time: 2 })}\n{"event":"do`);
  const state = { eventsOffset: 0 };

  assert.deepEqual(relay.newEvents(state).map((e) => e.event), ["done", "waiting"]);
  const offset = state.eventsOffset;
  assert.deepEqual(relay.newEvents(state), []);

  // A restarted relay, with the offset from its state file, reads only what came since.
  fs.appendFileSync(relay.EVENTS_FILE, `ne","time":3}\n`);
  const restarted = { eventsOffset: offset };
  assert.deepEqual(relay.newEvents(restarted).map((e) => e.time), [3]);

  // A file shorter than the offset is a new one, read from the start.
  fs.writeFileSync(relay.EVENTS_FILE, `${JSON.stringify({ event: "done", time: 4 })}\n`);
  assert.deepEqual(relay.newEvents(restarted).map((e) => e.time), [4]);
  fs.rmSync(relay.EVENTS_FILE);
});

test("followUps reports a finished turn once, in the request's thread", async () => {
  const [window, index] = tmux("new-window", "-d", "-P", "-F", "#{window_id}\t#{window_index}", fakeClaude).split("\t");
  // tmux takes a moment to see the pane's command as the fake Claude.
  await new Promise((resolve) => setTimeout(resolve, 300));
  const transcript = path.join(home, ".claude/projects/-work/followed.jsonl");
  fs.writeFileSync(transcript, [
    { type: "user", message: { content: "deploy it" } },
    { type: "assistant", message: { content: [{ type: "text", text: "Deployed." }] } },
  ].map((entry) => JSON.stringify(entry)).join("\n"));
  const now = Math.floor(Date.now() / 1000);
  fs.writeFileSync(relay.EVENTS_FILE, [
    // Before the request was sent, so not its answer.
    { event: "done", time: now - 120, transcript_path: transcript },
    // Another session's turn.
    { event: "done", time: now, transcript_path: path.join(tmp, "other.jsonl") },
    { event: "done", time: now, transcript_path: transcript },
  ].map((entry) => `${JSON.stringify(entry)}\n`).join(""));
  const thread = "1791500000.000300";
  const state = {
    dm: { channel: "D1", user: "U1" }, threads: {}, alerts: {}, reported: {}, eventsOffset: 0,
    following: { [window]: { thread, index: Number(index), name: "work", text: "deploy it", sentAt: Date.now() - 5_000, screen: "", changedAt: 0 } },
  };

  await relay.followUps(state);
  await relay.followUps(state);

  assert.equal(posts.length, 1);
  assert.equal(posts[0].thread, thread);
  assert.equal(posts[0].body, `🤖 tab ${index}, work is done:\n> deploy it\n\nDeployed.`);
  assert.deepEqual(state.following, {});
  assert.equal(state.alerts[posts[0].ts].window, window);
  fs.rmSync(relay.EVENTS_FILE);
  tmux("kill-window", "-t", window);
});

test("a wait shows the screen, so a permission prompt can be answered", async () => {
  const [window, index] = tmux("new-window", "-d", "-P", "-F", "#{window_id}\t#{window_index}", fakeClaude).split("\t");
  // tmux takes a moment to see the pane's command as the fake Claude.
  await new Promise((resolve) => setTimeout(resolve, 300));
  tmux("send-keys", "-t", window, "-l", "Do you want to proceed? 1. Yes 2. No");
  await new Promise((resolve) => setTimeout(resolve, 200));
  const transcript = path.join(home, ".claude/projects/-work/waiting.jsonl");
  fs.writeFileSync(transcript, JSON.stringify({ type: "user", message: { content: "delete the branch" } }));
  fs.writeFileSync(relay.EVENTS_FILE, `${JSON.stringify({ event: "waiting", time: Math.floor(Date.now() / 1000), transcript_path: transcript })}\n`);
  const state = {
    dm: { channel: "D1", user: "U1" }, threads: {}, alerts: {}, reported: {}, eventsOffset: 0,
    following: { [window]: { thread: null, index: Number(index), name: "work", text: "delete the branch", sentAt: Date.now() - 5_000, screen: "", changedAt: 0 } },
  };

  await relay.followUps(state);

  assert.equal(posts.length, 1);
  assert.match(posts[0].body, /is waiting on you/);
  assert.match(posts[0].body, /On screen now:\n```\n[\s\S]*Do you want to proceed\? 1\. Yes 2\. No[\s\S]*\n```$/);
  fs.rmSync(relay.EVENTS_FILE);
  tmux("kill-window", "-t", window);
});

test("alertTabs alerts once per state change, with the screen for a wait", async () => {
  const [window, index] = tmux("new-window", "-d", "-P", "-F", "#{window_id}\t#{window_index}", fakeClaude).split("\t");
  // tmux takes a moment to see the pane's command as the fake Claude.
  await new Promise((resolve) => setTimeout(resolve, 300));
  tmux("set", "-p", "-t", window, "@agent_state", "waiting");
  tmux("set", "-p", "-t", window, "@agent_since", "100");
  tmux("send-keys", "-t", window, "-l", "Allow this edit? 1. Yes 2. No");
  await new Promise((resolve) => setTimeout(resolve, 200));
  const state = { dm: { channel: "D1", user: "U1" }, threads: {}, alerts: {}, reported: {}, following: {} };
  const panePid = tmux("display", "-p", "-t", window, "#{pane_pid}");
  fs.writeFileSync(path.join(home, ".claude/sessions", `${panePid}.json`), JSON.stringify({ pid: Number(panePid), sessionId: "alerted" }));
  fs.writeFileSync(path.join(home, ".claude/projects/-work/alerted.jsonl"), JSON.stringify({ type: "user", message: { content: "edit the config" } }));

  await relay.alertTabs(state);
  await relay.alertTabs(state);
  tmux("set", "-p", "-t", window, "@agent_state", "done");
  tmux("set", "-p", "-t", window, "@agent_since", "200");
  await relay.alertTabs(state);

  // The home thread, then each alert in it with a one-line notice also in the main DM.
  assert.equal(posts.length, 5);
  const homeThread = posts[0].ts;
  assert.match(posts[0].body, /This is its thread/);
  assert.ok(state.threads[homeThread]);
  assert.match(posts[1].body, new RegExp(`^🤖 Tab ${index}, .* is \\*waiting on you\\*`));
  assert.match(posts[1].body, /> edit the config/);
  assert.match(posts[1].body, /On screen now:\n```\n[\s\S]*Allow this edit\? 1\. Yes 2\. No/);
  assert.equal(posts[1].thread, homeThread);
  assert.equal(posts[1].broadcast, false);
  assert.match(posts[2].body, new RegExp(`^🤖 Tab ${index}, .* is \\*waiting on you\\*\\.$`));
  assert.equal(posts[2].thread, homeThread);
  assert.equal(posts[2].broadcast, true);
  assert.match(posts[3].body, /has finished/);
  assert.doesNotMatch(posts[3].body, /On screen now:/);
  assert.match(posts[4].body, /has finished\.$/);
  assert.equal(state.alerts[posts[1].ts].window, window);
  assert.equal(state.alerts[posts[2].ts].thread, homeThread);
  fs.rmSync(path.join(home, ".claude/sessions", `${panePid}.json`));
  tmux("kill-window", "-t", window);
});

test("a long post goes out in parts, each checked against the outgoing file", async () => {
  const state = { dm: { channel: "D1", user: "U1" }, threads: {}, alerts: {} };
  const text = Array.from({ length: 300 }, (_, i) => `line ${i} of a long answer`).join("\n");

  const first = await relay.post(state, text, "1791500000.000400");

  assert.ok(posts.length > 1);
  assert.equal(first, posts[0].ts);
  posts.forEach((p) => {
    assert.equal(p.outgoing, p.body);
    assert.equal(p.thread, "1791500000.000400");
  });
  assert.equal(fs.statSync(relay.OUTGOING_FILE).mode & 0o777, 0o600);
});

test("a part that fails to post is replaced by a note", async () => {
  const state = { dm: { channel: "D1", user: "U1" }, threads: {}, alerts: {} };
  const real = relay.slack.poster.call;
  let refused = false;
  relay.slack.poster.call = async (prompt, expect) => {
    if (!refused && prompt.includes("on screen")) {
      refused = true;
      return [{ name: SEND, input: {}, error: true, raw: "hook error: The message must be exactly the text in the request" }];
    }
    return real(prompt, expect);
  };

  const first = await relay.post(state, "🤖 Tab 1 is waiting, on screen ╭──╮", "1791500000.000500");

  assert.equal(posts.length, 1);
  assert.match(posts[0].body, /didn't post here: Haiku couldn't copy it exactly/);
  assert.equal(first, posts[0].ts);
});

test("the poster's hook lets out only the exact text, and only to the DM", () => {
  const hook = relay.dmOnly({ channel: "D1", user: "U1" }).hooks.PreToolUse[0].hooks[0].command;
  fs.writeFileSync(relay.OUTGOING_FILE, "🤖 exactly this\nand this");
  const exit = (input) => {
    try {
      execFileSync("sh", ["-c", hook], { input: JSON.stringify({ tool_input: input }), stdio: ["pipe", "ignore", "pipe"] });
      return 0;
    } catch (err) {
      return err.status;
    }
  };

  assert.equal(exit({ channel_id: "D1", message: "🤖 exactly this\nand this" }), 0);
  assert.equal(exit({ channel_id: "U1", message: "🤖 exactly this\nand this" }), 0);
  // Spacing may differ; words may not.
  assert.equal(exit({ channel_id: "D1", message: "🤖 exactly  this and this" }), 0);
  assert.equal(exit({ channel_id: "D1", message: "🤖 exactly that\nand this" }), 2);
  assert.equal(exit({ channel_id: "C999", message: "🤖 exactly this\nand this" }), 2);
});

test("state, log and their directory are owner-only", () => {
  fs.chmodSync(relay.STATE_DIR, 0o755);
  relay.saveState({ threads: {} });
  relay.log("a line for the log");
  relay.ownerOnly();

  assert.equal(fs.statSync(relay.STATE_DIR).mode & 0o777, 0o700);
  assert.equal(fs.statSync(relay.STATE_FILE).mode & 0o777, 0o600);
  assert.equal(fs.statSync(relay.LOG_FILE).mode & 0o777, 0o600);
  assert.match(fs.readFileSync(relay.LOG_FILE, "utf8"), /^\S+Z a line for the log$/m);
});

test("lastError finds the reason for the latest crash in the log", () => {
  const since = Date.now();
  fs.appendFileSync(relay.LOG_FILE, `${new Date(since - 60_000).toISOString()} Error: an older crash\n`);
  assert.equal(relay.lastError(since), undefined);
  fs.appendFileSync(relay.LOG_FILE, `${new Date(since + 1).toISOString()} Error: crashed: TypeError: x is undefined\n`);
  assert.equal(relay.lastError(since), "TypeError: x is undefined");
});

test("a busy tab's reply says the message was queued", async () => {
  const [window, index] = tmux("new-window", "-d", "-P", "-F", "#{window_id}\t#{window_index}", fakeClaude).split("\t");
  // tmux takes a moment to see the pane's command as the fake Claude.
  await new Promise((resolve) => setTimeout(resolve, 300));
  tmux("set", "-p", "-t", window, "@agent_state", "working");
  const state = { dm: { channel: "D1", user: "U1" }, threads: {}, alerts: {}, reported: {}, following: {} };
  const ts = `${Math.floor(Date.now() / 1000)}.000009`;

  await relay.handle(state, { ts, text: `${index}: and also this`, thread_ts: null });

  assert.match(posts[1].body, /in the middle of a turn, so Claude Code has queued it/);
  assert.equal(state.following[window].request, ts);
  assert.equal(state.following[window].taken, false);
  tmux("kill-window", "-t", window);
});

test("followUps reacts 👀 once the tab's Claude takes the message, without calling it done", async () => {
  const [window, index] = tmux("new-window", "-d", "-P", "-F", "#{window_id}\t#{window_index}", fakeClaude).split("\t");
  await new Promise((resolve) => setTimeout(resolve, 300));
  tmux("set", "-p", "-t", window, "@agent_state", "working");
  const transcript = path.join(home, ".claude/projects/-work/taken.jsonl");
  fs.writeFileSync(transcript, JSON.stringify({ type: "user", message: { content: "rename   the\nmodule" } }));
  const now = Math.floor(Date.now() / 1000);
  fs.writeFileSync(relay.EVENTS_FILE, [
    { event: "prompt", time: now, transcript_path: transcript, prompt: "something else" },
    { event: "prompt", time: now, transcript_path: transcript, prompt: "rename   the\nmodule" },
  ].map((entry) => `${JSON.stringify(entry)}\n`).join(""));
  const request = `${now - 5}.000100`;
  const state = {
    dm: { channel: "D1", user: "U1" }, threads: {}, alerts: {}, reported: {}, eventsOffset: 0,
    following: { [window]: { thread: request, request, index: Number(index), name: "work", text: "rename the module", sentAt: Date.now() - 5_000, screen: "", changedAt: 0, taken: false, warned: false } },
  };

  await relay.followUps(state);
  await relay.followUps(state);

  assert.deepEqual(reactions, [{ ts: request, emoji: "eyes" }]);
  assert.equal(posts.length, 0);
  assert.equal(state.following[window].taken, true);
  fs.rmSync(relay.EVENTS_FILE);
  tmux("kill-window", "-t", window);
});

test("an idle tab that hasn't taken the message is reported once, with its screen", async () => {
  const [window, index] = tmux("new-window", "-d", "-P", "-F", "#{window_id}\t#{window_index}", fakeClaude).split("\t");
  await new Promise((resolve) => setTimeout(resolve, 300));
  tmux("send-keys", "-t", window, "-l", "Trust this folder? 1. Yes 2. No");
  await new Promise((resolve) => setTimeout(resolve, 200));
  const request = `${Math.floor(Date.now() / 1000) - 40}.000100`;
  const state = {
    dm: { channel: "D1", user: "U1" }, threads: {}, alerts: {}, reported: {}, eventsOffset: 0,
    following: { [window]: { thread: request, request, index: Number(index), name: "work", text: "start", sentAt: Date.now() - relay.PICKUP_WARN_MS - 1_000, screen: "", changedAt: 0, taken: false, warned: false } },
  };

  await relay.followUps(state);
  await relay.followUps(state);

  assert.equal(posts.length, 1);
  assert.equal(posts[0].thread, request);
  assert.match(posts[0].body, new RegExp(`tab ${index}, work hasn't taken your message after 30 seconds`));
  assert.match(posts[0].body, /On screen now:[\s\S]*Trust this folder\? 1\. Yes 2\. No/);
  assert.deepEqual(reactions, []);
  tmux("kill-window", "-t", window);
});

test("agent-state.sh records a taken prompt for the relay, and nothing for a tool call", () => {
  fs.writeFileSync(relay.EVENTS_FILE, "");
  const hook = path.join(__dirname, "../tmux/agent-state.sh");
  const env = { ...process.env, HOME: home };
  delete env.TMUX;
  delete env.TMUX_PANE;

  execFileSync("bash", [hook, "set", "working"], { env, input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "s1", transcript_path: "/t.jsonl", cwd: "/w", prompt: "fix it" }) });
  execFileSync("bash", [hook, "set", "working"], { env, input: JSON.stringify({ hook_event_name: "PostToolUse", session_id: "s1", transcript_path: "/t.jsonl", cwd: "/w" }) });

  const events = fs.readFileSync(relay.EVENTS_FILE, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "prompt");
  assert.equal(events[0].prompt, "fix it");
  assert.equal(events[0].transcript_path, "/t.jsonl");
  fs.rmSync(relay.EVENTS_FILE);
});

test("esc presses Escape in a working tab and stops following it", async () => {
  const [window, index] = tmux("new-window", "-d", "-P", "-F", "#{window_id}\t#{window_index}", fakeClaude).split("\t");
  await new Promise((resolve) => setTimeout(resolve, 300));
  tmux("set", "-p", "-t", window, "@agent_state", "working");
  const state = {
    dm: { channel: "D1", user: "U1" }, threads: {}, alerts: {}, reported: {},
    following: { [window]: { thread: null, index: Number(index), name: "work", text: "long job", sentAt: Date.now(), screen: "", changedAt: 0 } },
  };

  await relay.handle(state, { ts: `${Math.floor(Date.now() / 1000)}.000010`, text: `esc ${index}`, thread_ts: null });
  await new Promise((resolve) => setTimeout(resolve, 200));

  assert.match(tmux("capture-pane", "-p", "-t", window), /\^\[/);
  assert.match(posts[0].body, new RegExp(`^🤖 Pressed Escape in tab ${index}, `));
  assert.deepEqual(state.following, {});
  assert.equal(state.alerts[posts[0].ts].window, window);
  tmux("kill-window", "-t", window);
});

test("esc under an alert interrupts that tab, and leaves an idle tab alone", async () => {
  const [window, index] = tmux("new-window", "-d", "-P", "-F", "#{window_id}\t#{window_index}", fakeClaude).split("\t");
  await new Promise((resolve) => setTimeout(resolve, 300));
  const alert = `${Math.floor(Date.now() / 1000) - 60}.000100`;
  const state = { dm: { channel: "D1", user: "U1" }, threads: {}, alerts: { [alert]: { window, index: Number(index), name: "work" } }, reported: {}, following: {} };

  await relay.handle(state, { ts: `${Math.floor(Date.now() / 1000)}.000011`, text: "esc", thread_ts: alert });
  tmux("set", "-p", "-t", window, "@agent_state", "waiting");
  await relay.handle(state, { ts: `${Math.floor(Date.now() / 1000)}.000012`, text: "ESC", thread_ts: alert });
  await new Promise((resolve) => setTimeout(resolve, 200));

  assert.match(posts[0].body, /isn't in the middle of anything, so I didn't press Escape/);
  assert.equal(posts[0].thread, alert);
  assert.match(posts[1].body, /Pressed Escape in tab \d+, work/);
  assert.equal((tmux("capture-pane", "-p", "-t", window).match(/\^\[/g) ?? []).length, 1);
  tmux("kill-window", "-t", window);
});

test("a finished turn whose reply isn't in the transcript yet waits for it", async () => {
  const [window, index] = tmux("new-window", "-d", "-P", "-F", "#{window_id}\t#{window_index}", fakeClaude).split("\t");
  await new Promise((resolve) => setTimeout(resolve, 300));
  const transcript = path.join(home, ".claude/projects/-work/late.jsonl");
  fs.writeFileSync(transcript, `${JSON.stringify({ type: "user", message: { content: "give me the list" } })}\n`);
  fs.writeFileSync(relay.EVENTS_FILE, `${JSON.stringify({ event: "done", time: Math.floor(Date.now() / 1000), transcript_path: transcript })}\n`);
  const thread = `${Math.floor(Date.now() / 1000) - 5}.000100`;
  const state = {
    dm: { channel: "D1", user: "U1" }, threads: {}, alerts: {}, reported: {}, eventsOffset: 0,
    following: { [window]: { thread, index: Number(index), name: "work", text: "give me the list", sentAt: Date.now() - 5_000, screen: "", changedAt: 0 } },
  };

  // The Stop hook has fired, but the reply hasn't been written yet.
  await relay.followUps(state);
  assert.equal(posts.length, 0);

  fs.appendFileSync(transcript, `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "1. Verify" }] } })}\n`);
  await relay.followUps(state);

  assert.equal(posts.length, 1);
  assert.equal(posts[0].body, `🤖 tab ${index}, work is done:\n> give me the list\n\n1. Verify`);
  assert.deepEqual(state.following, {});

  // A reply that never comes is posted as it is once the wait is over.
  fs.writeFileSync(transcript, `${JSON.stringify({ type: "user", message: { content: "and the rest" } })}\n`);
  fs.appendFileSync(relay.EVENTS_FILE, `${JSON.stringify({ event: "done", time: Math.floor(Date.now() / 1000), transcript_path: transcript })}\n`);
  state.following[window] = { thread, index: Number(index), name: "work", text: "and the rest", sentAt: Date.now() - 5_000, screen: "", changedAt: 0 };
  await relay.followUps(state);
  assert.equal(posts.length, 1);
  state.following[window].ended.at -= 61_000;
  await relay.followUps(state);
  assert.equal(posts.length, 2);
  assert.match(posts[1].body, /\(no reply yet\)$/);
  fs.rmSync(relay.EVENTS_FILE);
  tmux("kill-window", "-t", window);
});

test("each check reads recent threads' new replies alongside the channel", async () => {
  const now = Math.floor(Date.now() / 1000);
  const hot = `${now - 120}.000100`;
  const cold = `${now - 3 * 3600}.000100`;
  const state = {
    dm: { channel: "D1", user: "U1" },
    cursor: `${now - 60}.000100`,
    threads: { [hot]: `${now - 30}.000100`, [cold]: cold },
  };
  const asked = [];
  relay.slack.reader = {
    call: async (prompt) => {
      asked.push(prompt);
      return [
        { name: READ_CHANNEL, input: {}, raw: JSON.stringify({ messages: "" }) },
        {
          name: READ_THREAD,
          input: { message_ts: hot },
          raw: JSON.stringify({
            messages: `=== THREAD PARENT MESSAGE ===\nMessage TS: ${hot}\n:robot_face: Tab 3 is waiting on you\n=== THREAD REPLIES (2 total) ===\n--- Reply 1 of 2 ---\nMessage TS: ${now - 30}.000100\nold\n--- Reply 2 of 2 ---\nMessage TS: ${now - 2}.000100\n1`,
          }),
        },
      ];
    },
  };

  const { messages } = await relay.fetchMessages(state, { wide: false });

  assert.equal(asked.length, 1);
  assert.match(asked[0], new RegExp(`message_ts ${hot}, oldest ${now - 30}\\.000100`));
  assert.doesNotMatch(asked[0], new RegExp(cold));
  assert.deepEqual(messages, [{ ts: `${now - 2}.000100`, text: "1", byClaude: false, thread_ts: hot }]);
});

test("reactions go through their own session", async () => {
  const state = { dm: { channel: "D1", user: "U1" }, threads: {}, alerts: {}, reported: {}, following: {} };
  const reacted = [];
  relay.slack.reactor = { call: async (prompt) => (reacted.push(prompt), [{ name: ADD_REACTION, input: {}, raw: "{}" }]) };
  const transcript = path.join(home, ".claude/projects/-work/react.jsonl");
  fs.writeFileSync(transcript, JSON.stringify({ type: "user", message: { content: "go" } }));
  fs.writeFileSync(relay.EVENTS_FILE, `${JSON.stringify({ event: "prompt", time: Math.floor(Date.now() / 1000), transcript_path: transcript, prompt: "go" })}\n`);
  state.eventsOffset = 0;
  state.following["@999"] = { thread: null, request: "1791500000.000600", index: 9, name: "gone", text: "go", sentAt: Date.now() - 1_000, screen: "", changedAt: 0, taken: false, warned: false };

  await relay.followUps(state);

  assert.equal(reacted.length, 1);
  assert.match(reacted[0], /message_ts 1791500000\.000600, emoji eyes/);
  assert.deepEqual(reactions, []);
  relay.slack.reactor = undefined;
  fs.rmSync(relay.EVENTS_FILE);
});

test("a session hands over Slack's answer before Haiku finishes its turn", async () => {
  // A stand-in for `claude -p` that makes one call per request, answers it at
  // once, and only ends the turn 1.5 seconds later.
  const streamBin = path.join(tmp, "stream-bin");
  fs.mkdirSync(streamBin, { recursive: true });
  fs.writeFileSync(path.join(streamBin, "claude"), `#!${process.execPath}
require("node:readline").createInterface({ input: process.stdin }).on("line", () => {
  const say = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
  say({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "${READ_CHANNEL}", input: {} }] } });
  say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "{}" }] } });
  setTimeout(() => say({ type: "result", usage: {} }), 1500);
});
`, { mode: 0o755 });
  const path_ = process.env.PATH;
  process.env.PATH = `${streamBin}:${path_}`;
  const session = new relay.SlackSession("test reader", [READ_CHANNEL], { hooks: {} });
  try {
    const started = Date.now();
    const first = await session.call("read", READ_CHANNEL, (calls) => calls.some((c) => c.name === READ_CHANNEL));
    const early = Date.now() - started;
    const second = await session.call("read", READ_CHANNEL, (calls) => calls.some((c) => c.name === READ_CHANNEL));
    const both = Date.now() - started;

    assert.equal(first[0].name, READ_CHANNEL);
    assert.equal(second[0].name, READ_CHANNEL);
    assert.ok(early < 1_000, `first answer took ${early}ms`);
    // The second turn still waits for the first to end.
    assert.ok(both >= 1_500, `both took ${both}ms`);
  } finally {
    session.stop();
    process.env.PATH = path_;
  }
});

test("a wide read follows older pages to find replies under old messages", async () => {
  const now = Math.floor(Date.now() / 1000);
  const old = `${now - 20 * 3600}.000100`;
  const state = { dm: { channel: "D1", user: "U1" }, cursor: `${now - 60}.000100`, threads: { [old]: old } };
  const stamp = (ts) => {
    const d = new Date(Number(ts) * 1000);
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };
  const asked = [];
  relay.slack.reader = {
    call: async (prompt) => {
      asked.push(prompt);
      if (asked.length === 1) {
        return [{ name: READ_CHANNEL, input: {}, raw: JSON.stringify({ messages: `=== Message from Me (U1) at x ===\nMessage TS: ${now - 100}.000100\nsomething recent`, pagination_info: "use cursor: `PAGE2`" }) }];
      }
      if (asked.length === 2) {
        return [{ name: READ_CHANNEL, input: {}, raw: JSON.stringify({ messages: `=== Message from Me (U1) at x ===\nMessage TS: ${old}\n:robot_face: an old alert\nThread: 1 replies (latest: ${stamp(now - 5)} EDT)` }) }];
      }
      return [{ name: READ_THREAD, input: { message_ts: old }, raw: JSON.stringify({ messages: `=== THREAD REPLIES ===\n--- Reply 1 of 1 ---\nMessage TS: ${now - 5}.000100\nback to this one` }) }];
    },
  };

  const { messages } = await relay.fetchMessages(state, { wide: true });

  assert.equal(asked.length, 3);
  assert.match(asked[1], /cursor PAGE2/);
  assert.match(asked[2], new RegExp(`message_ts ${old}`));
  assert.deepEqual(messages, [{ ts: `${now - 5}.000100`, text: "back to this one", byClaude: false, thread_ts: old }]);
});

test("progress summarizes what a tab is doing without typing into it", async () => {
  const [window, index] = tmux("new-window", "-d", "-P", "-F", "#{window_id}\t#{window_index}", fakeClaude).split("\t");
  await new Promise((resolve) => setTimeout(resolve, 300));
  tmux("set", "-p", "-t", window, "@agent_state", "working");
  const panePid = tmux("display", "-p", "-t", window, "#{pane_pid}");
  fs.writeFileSync(path.join(home, ".claude/sessions", `${panePid}.json`), JSON.stringify({ pid: Number(panePid), sessionId: "busy" }));
  fs.writeFileSync(path.join(home, ".claude/projects/-work/busy.jsonl"), [
    { type: "user", timestamp: new Date(Date.now() - 4 * 60_000).toISOString(), message: { content: "add the progress command" } },
    { type: "assistant", message: { content: [{ type: "text", text: "Reading the relay first." }, { type: "tool_use", id: "t1", name: "Read", input: { file_path: "bin/slack-relay" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "..." }] } },
    { type: "assistant", message: { content: [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "node --test", description: "Run the tests" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2", is_error: true, content: "1 failing" }] } },
  ].map((entry) => JSON.stringify(entry)).join("\n"));
  // A stand-in summarizer that keeps what it was given and answers.
  const summaryBin = path.join(tmp, "summary-bin");
  const given = path.join(tmp, "summary-input.txt");
  fs.mkdirSync(summaryBin, { recursive: true });
  fs.writeFileSync(path.join(summaryBin, "claude"), `#!/bin/sh\ncat > '${given}'\necho '• Running the tests, one is failing.'\n`, { mode: 0o755 });
  const alert = `${Math.floor(Date.now() / 1000) - 60}.000100`;
  const state = { dm: { channel: "D1", user: "U1" }, threads: {}, alerts: { [alert]: { window, index: Number(index), name: "work" } }, reported: {}, following: {} };
  const request = `${Math.floor(Date.now() / 1000)}.000013`;
  const path_ = process.env.PATH;
  process.env.PATH = `${summaryBin}:${path_}`;
  try {
    await relay.handle(state, { ts: request, text: "progress", thread_ts: alert });
  } finally {
    process.env.PATH = path_;
  }

  assert.deepEqual(reactions, [{ ts: request, emoji: "eyes" }]);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].thread, alert);
  assert.match(posts[0].body, new RegExp(`^🤖 tab ${index}, work is working, on a turn started 4m ago, last activity just now, 2 tools so far\\.\\n• Running the tests, one is failing\\.$`));
  const input = fs.readFileSync(given, "utf8");
  assert.match(input, /The prompt: add the progress command/);
  assert.match(input, /Read: bin\/slack-relay/);
  assert.match(input, /Bash: Run the tests/);
  assert.match(input, /\(that failed: 1 failing\)/);
  assert.doesNotMatch(tmux("capture-pane", "-p", "-t", window), /progress/);
  assert.deepEqual(state.following, {});
  fs.rmSync(path.join(home, ".claude/sessions", `${panePid}.json`));
  tmux("kill-window", "-t", window);
});

test("progress falls back to the last few steps when the summary fails", async () => {
  const [window, index] = tmux("new-window", "-d", "-P", "-F", "#{window_id}\t#{window_index}", fakeClaude).split("\t");
  await new Promise((resolve) => setTimeout(resolve, 300));
  const panePid = tmux("display", "-p", "-t", window, "#{pane_pid}");
  fs.writeFileSync(path.join(home, ".claude/sessions", `${panePid}.json`), JSON.stringify({ pid: Number(panePid), sessionId: "busy2" }));
  fs.writeFileSync(path.join(home, ".claude/projects/-work/busy2.jsonl"), [
    { type: "user", message: { content: "deploy" } },
    { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "make deploy" } }] } },
  ].map((entry) => JSON.stringify(entry)).join("\n"));
  const state = { dm: { channel: "D1", user: "U1" }, threads: {}, alerts: {}, reported: {}, following: {} };

  // The tests' own `claude` always fails.
  await relay.handle(state, { ts: `${Math.floor(Date.now() / 1000)}.000014`, text: `progress ${index}`, thread_ts: null });

  assert.match(posts[0].body, /is idle, last activity just now, 1 tool so far\.\nI couldn't summarize it, so here is what it did last:\n• Bash: make deploy$/);
  fs.rmSync(path.join(home, ".claude/sessions", `${panePid}.json`));
  tmux("kill-window", "-t", window);
});

test("the canvas hook allows only the exact content, and updates only to the relay's canvases", () => {
  const hooks = relay.canvasOnly().hooks.PreToolUse;
  const create = hooks.find((h) => h.matcher.endsWith("create_canvas")).hooks[0].command;
  const update = hooks.find((h) => h.matcher.endsWith("update_canvas")).hooks[0].command;
  fs.writeFileSync(relay.CANVAS_OUTGOING_FILE, "# Done\n\nAll  of it");
  fs.writeFileSync(relay.CANVAS_IDS_FILE, "F0OURS0001\n");
  const exit = (command, input) => {
    try {
      execFileSync("sh", ["-c", command], { input: JSON.stringify({ tool_input: input }), stdio: ["pipe", "ignore", "pipe"] });
      return 0;
    } catch (err) {
      return err.status;
    }
  };

  assert.equal(exit(create, { title: "t", content: "# Done\n\nAll of it" }), 0);
  assert.equal(exit(create, { title: "t", content: "# Done\n\nSome of it" }), 2);
  assert.equal(exit(update, { canvas_id: "F0OURS0001", content: "# Done\n\nAll of it" }), 0);
  assert.equal(exit(update, { canvas_id: "F0THEIRS01", content: "# Done\n\nAll of it" }), 2);
  assert.equal(exit(update, { canvas_id: "F0OURS0001", content: "something else" }), 2);
  // An update's content is in its sections, alongside the deletions.
  assert.equal(exit(update, { canvas_id: "F0OURS0001", sections: [{ edit_type: "delete", section_id: "a" }, { edit_type: "append", section_id: "t", content: "# Done\n\nAll of it" }] }), 0);
  assert.equal(exit(update, { canvas_id: "F0OURS0001", sections: [{ edit_type: "append", section_id: "t", content: "other" }] }), 2);
  const read = hooks.find((h) => h.matcher.endsWith("read_canvas")).hooks[0].command;
  assert.equal(exit(read, { canvas_id: "F0OURS0001" }), 0);
  assert.equal(exit(read, { canvas_id: "F0THEIRS01" }), 2);
  fs.rmSync(relay.CANVAS_IDS_FILE);
});

test("a long answer goes into a canvas, with its opening and a link in the thread", async () => {
  const state = { dm: { channel: "D1", user: "U1", name: "Sam" }, threads: {}, alerts: {} };
  const made = [];
  relay.slack.canvas = {
    call: async (prompt, tool) => {
      made.push({ prompt, tool, content: fs.readFileSync(relay.CANVAS_OUTGOING_FILE, "utf8") });
      return [{ name: tool, input: {}, raw: JSON.stringify({ canvas_id: "F0TEST0001", canvas_url: "https://x.slack.com/docs/T1/F0TEST0001" }) }];
    },
  };
  const answer = "> deploy it\n\n" + Array.from({ length: 120 }, (_, i) => `Step ${i} went fine.`).join("\n");
  try {
    await relay.post(state, `🤖 tab 1, work is done:\n${answer}`, "1791500000.000700", { title: "tab 1, work: deploy it" });
    await relay.post(state, "🤖 a short one\nfits in a message", "1791500000.000700", { title: "short" });
  } finally {
    relay.slack.canvas = undefined;
  }

  assert.equal(made.length, 1);
  assert.equal(made[0].content, answer);
  assert.match(made[0].prompt, /title "Sam's Claude: tab 1, work: deploy it"/);
  assert.equal(posts.length, 2);
  assert.match(posts[0].body, /^🤖 tab 1, work is done:\n> deploy it\n\nStep 0 went fine\.[\s\S]*\n…\n\n<https:\/\/x\.slack\.com\/docs\/T1\/F0TEST0001\|All of it in a canvas>$/);
  assert.ok(posts[0].body.length < 900);
  assert.equal(posts[1].body, "🤖 a short one\nfits in a message");
  assert.match(fs.readFileSync(relay.CANVAS_IDS_FILE, "utf8"), /^F0TEST0001$/m);
  fs.rmSync(relay.CANVAS_IDS_FILE);
});

test("a long answer goes out as messages when the canvas fails", async () => {
  const state = { dm: { channel: "D1", user: "U1" }, threads: {}, alerts: {} };
  relay.slack.canvas = { call: async (prompt, tool) => [{ name: tool, input: {}, error: true, raw: "not allowed on this team" }] };
  const text = `🤖 done:\n${"x".repeat(relay.LONG_POST_CHARS + 10)}`;
  try {
    await relay.post(state, text, "1791500000.000800", { title: "t" });
  } finally {
    relay.slack.canvas = undefined;
  }

  assert.equal(posts.length, 1);
  assert.equal(posts[0].body, text);
});

test("the dashboard is created once, then replaced only when it changes", async () => {
  const [window, index] = tmux("new-window", "-d", "-P", "-F", "#{window_id}\t#{window_index}", fakeClaude).split("\t");
  await new Promise((resolve) => setTimeout(resolve, 300));
  tmux("set", "-p", "-t", window, "@agent_state", "done");
  tmux("set", "-p", "-t", window, "@agent_since", String(Math.floor(Date.now() / 1000) - 120));
  const made = [];
  // Slack answers with the canvas's sections by ID, which change each update.
  let version = 0;
  relay.slack.canvas = {
    call: async (prompt, tool) => {
      made.push({ prompt, tool, content: fs.readFileSync(relay.CANVAS_OUTGOING_FILE, "utf8") });
      version++;
      return [{
        name: tool,
        input: { canvas_id: "F0DASH0001" },
        raw: JSON.stringify({
          canvas_id: "F0DASH0001",
          canvas_url: "https://x.slack.com/docs/T1/F0DASH0001",
          section_id_mapping: { "temp:title": "# Claude tabs", [`temp:intro${version}`]: "Updated…", [`temp:table${version}`]: "|Tab|…" },
        }),
      }];
    },
  };
  const state = { dm: { channel: "D1", user: "U1" }, threads: {}, alerts: {}, reported: {}, following: {} };
  try {
    await relay.refreshDashboard(state, { quick: true });
    await relay.refreshDashboard(state, { quick: true });
    tmux("set", "-p", "-t", window, "@agent_state", "waiting");
    await relay.refreshDashboard(state, { quick: true });
  } finally {
    relay.slack.canvas = undefined;
  }

  assert.equal(made.length, 2);
  assert.match(made[0].prompt, new RegExp(`create_canvas once with title "Claude tabs"`));
  assert.match(made[0].content, new RegExp(`\\| ${index} [^|]* \\| :white_check_mark: finished \\| 2m \\|`));
  // Laid out as before, so each section is replaced where it is.
  const edits = JSON.parse(made[1].prompt.slice(made[1].prompt.indexOf("\n\n") + 2));
  assert.deepEqual(edits.map((e) => [e.edit_type, e.section_id]), [["replace", "temp:intro1"], ["replace", "temp:table1"]]);
  assert.match(edits[0].content, /^Updated /);
  assert.match(edits[1].content, /^\| Tab \| State/);
  assert.equal(made[1].content, edits.map((e) => e.content).join(""));
  assert.deepEqual(Object.keys(state.dashboard.sections), ["temp:title", "temp:intro2", "temp:table2"]);
  assert.match(edits[1].content, new RegExp(`\\| ${index} [^|]* \\| :red_circle: \\*\\*waiting on you\\*\\* \\|`));
  assert.equal(state.dashboard.url, "https://x.slack.com/docs/T1/F0DASH0001");
  fs.rmSync(relay.CANVAS_IDS_FILE);
  tmux("kill-window", "-t", window);
});

test("diff summarizes a tab's branch and puts the whole diff in a canvas", async () => {
  const repo = path.join(tmp, "repo");
  fs.mkdirSync(repo);
  const git = (...args) => execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], { stdio: "ignore" });
  git("init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "app.js"), "one\n");
  git("add", ".");
  git("commit", "-q", "-m", "Start");
  git("switch", "-q", "-c", "feature");
  fs.writeFileSync(path.join(repo, "app.js"), "one\ntwo\n");
  git("commit", "-q", "-am", "Add two");
  fs.writeFileSync(path.join(repo, "app.js"), "one\ntwo\nthree\n");
  fs.writeFileSync(path.join(repo, "notes.md"), "new\n");
  const [window, index] = tmux("new-window", "-d", "-c", repo, "-P", "-F", "#{window_id}\t#{window_index}", fakeClaude).split("\t");
  await new Promise((resolve) => setTimeout(resolve, 300));
  const made = [];
  relay.slack.canvas = {
    call: async (prompt, tool) => {
      made.push({ prompt, content: fs.readFileSync(relay.CANVAS_OUTGOING_FILE, "utf8") });
      return [{ name: tool, input: {}, raw: JSON.stringify({ canvas_id: "F0DIFF0001", canvas_url: "https://x.slack.com/docs/T1/F0DIFF0001" }) }];
    },
  };
  const state = { dm: { channel: "D1", user: "U1" }, threads: {}, alerts: {}, reported: {}, following: {} };
  const request = `${Math.floor(Date.now() / 1000)}.000015`;
  try {
    await relay.handle(state, { ts: request, text: `diff ${index}`, thread_ts: null });
  } finally {
    relay.slack.canvas = undefined;
  }

  assert.deepEqual(reactions, [{ ts: request, emoji: "eyes" }]);
  assert.match(posts[0].body, /branch `feature`: 1 commit on top of `main`, 1 file changed, 2 insertions\(\+\), and 1 new file not yet added\./);
  assert.match(posts[0].body, /app\.js \| 2 \+\+/);
  assert.match(posts[0].body, /<https:\/\/x\.slack\.com\/docs\/T1\/F0DIFF0001\|The whole diff in a canvas>$/);
  assert.match(made[0].prompt, /title "Claude: Diff: [^"]* \(feature\)"/);
  assert.match(made[0].content, /## Commits\n\n- `[0-9a-f]+` Add two/);
  assert.match(made[0].content, /## New files not yet added\n\n- `notes\.md`/);
  assert.match(made[0].content, /````diff\n[\s\S]*\+two\n\+three[\s\S]*\n````$/);
  assert.doesNotMatch(tmux("capture-pane", "-p", "-t", window), /diff/);
  fs.rmSync(relay.CANVAS_IDS_FILE);
  tmux("kill-window", "-t", window);
});

test("slackName takes the name from the profile's first line", async () => {
  relay.slack.canvas = {
    call: async (prompt, tool) => [{ name: tool, input: {}, raw: JSON.stringify({ result: "samdoe (Sam)\nAcme\n\nsam@example.com\nStatus:  \n" }) }],
  };
  try {
    assert.equal(await relay.slackName(), "Sam");
  } finally {
    relay.slack.canvas = undefined;
  }
});

test("a dashboard made before the name was known is renamed with its next update", async () => {
  const made = [];
  relay.slack.canvas = {
    call: async (prompt, tool) => {
      made.push({ prompt, content: fs.readFileSync(relay.CANVAS_OUTGOING_FILE, "utf8") });
      return [{ name: tool, input: {}, raw: JSON.stringify({ canvas_id: "F0DASH0002", section_id_mapping: { "temp:t": "# Sam's Claude tabs", "temp:b": "…" } }) }];
    },
  };
  const state = {
    dm: { channel: "D1", user: "U1", name: "Sam" }, threads: {}, alerts: {}, reported: {}, following: {},
    dashboard: { id: "F0DASH0002", url: "https://x.slack.com/docs/T1/F0DASH0002", body: "\nsame", title: "Claude tabs", sections: { "temp:t": "# Claude tabs", "temp:old": "…" } },
  };
  try {
    await relay.refreshDashboard(state, { quick: true });
    await relay.refreshDashboard(state, { quick: true });
  } finally {
    relay.slack.canvas = undefined;
  }

  assert.equal(made.length, 1);
  const edits = JSON.parse(made[0].prompt.slice(made[0].prompt.indexOf("\n\n") + 2));
  assert.deepEqual(edits[0], { edit_type: "replace", section_id: "temp:t", content: "Sam's Claude tabs" });
  assert.deepEqual(edits[1], { edit_type: "delete", section_id: "temp:old" });
  assert.equal(made[0].content, `Sam's Claude tabs${edits[2].content}`);
  assert.equal(state.dashboard.title, "Sam's Claude tabs");
});

test("optionsIn reads a prompt's numbered choices from the bottom of the screen", () => {
  const permission = [
    "● I'll push the branch.",
    "1. this numbered list is Claude's reply, not the prompt",
    "2. so it is ignored",
    "────────────────────────────────────────",
    " Bash command",
    "   git push origin feature",
    " Do you want to proceed?",
    " ❯ 1. Yes",
    "   2. Yes, and don't ask again for git push commands in /work",
    "   3. No, and tell Claude what to do differently (esc)",
  ].join("\n");
  assert.deepEqual(relay.optionsIn(permission), {
    question: "Bash command git push origin feature Do you want to proceed?",
    options: [
      { n: 1, label: "Yes" },
      { n: 2, label: "Yes, and don't ask again for git push commands in /work" },
      { n: 3, label: "No, and tell Claude what to do differently (esc)" },
    ],
  });

  // A question with a description under each option, in a box.
  const question = [
    "╭──────────────────────────╮",
    "│ Which database for tests? │",
    "│ ❯ 1. Postgres             │",
    "│      The same as production│",
    "│   2. SQLite               │",
    "│      Faster, but different│",
    "╰──────────────────────────╯",
  ].join("\n");
  assert.deepEqual(relay.optionsIn(question).options, [{ n: 1, label: "Postgres" }, { n: 2, label: "SQLite" }]);
  assert.match(relay.optionsIn(question).question, /Which database for tests\?/);

  assert.equal(relay.optionsIn("● Done.\n1. one thing\nthe end"), undefined);
});

test("an answer to a waiting tab's choice presses just the number", async () => {
  const [window, index] = tmux("new-window", "-d", "-P", "-F", "#{window_id}\t#{window_index}", fakeClaude).split("\t");
  await new Promise((resolve) => setTimeout(resolve, 300));
  ["Do you want to proceed?", "❯ 1. Yes", "  2. Yes, and don't ask again", "  3. No (esc)"].forEach((line) => {
    tmux("send-keys", "-t", window, "-l", line);
    tmux("send-keys", "-t", window, "Enter");
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
  tmux("set", "-p", "-t", window, "@agent_state", "waiting");
  const alert = `${Math.floor(Date.now() / 1000) - 30}.000100`;
  const state = { dm: { channel: "D1", user: "U1" }, threads: {}, alerts: { [alert]: { window, index: Number(index), name: "work" } }, reported: {}, following: {} };

  await relay.handle(state, { ts: `${Math.floor(Date.now() / 1000)}.000016`, text: "yes, and", thread_ts: alert });
  await new Promise((resolve) => setTimeout(resolve, 200));

  const lines = tmux("capture-pane", "-p", "-t", window).split("\n").filter((line) => line.trim());
  assert.equal(lines.at(-1), "2");
  assert.equal(lines.filter((line) => line === "2").length, 1, "no Enter after the number");
  assert.match(posts[0].body, new RegExp(`^🤖 Chose 2\\. Yes, and don't ask again in tab ${index}, work\\.`));
  assert.equal(state.following[window].taken, true);
  tmux("kill-window", "-t", window);
});

test("reactions answer a waiting tab: 👍 picks 1, ✋ presses Escape, each once", async () => {
  const [window, index] = tmux("new-window", "-d", "-P", "-F", "#{window_id}\t#{window_index}", fakeClaude).split("\t");
  await new Promise((resolve) => setTimeout(resolve, 300));
  ["Do you want to proceed?", "❯ 1. Yes", "  2. No"].forEach((line) => {
    tmux("send-keys", "-t", window, "-l", line);
    tmux("send-keys", "-t", window, "Enter");
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
  tmux("set", "-p", "-t", window, "@agent_state", "waiting");
  const alert = `${Math.floor(Date.now() / 1000) - 30}.000100`;
  const state = {
    dm: { channel: "D1", user: "U1" }, threads: {}, reported: {}, following: {},
    alerts: { [alert]: { window, index: Number(index), name: "work" } },
    answerable: { [alert]: { window, thread: alert } },
  };

  const answers = relay.answerReactions(state, [{ ts: alert, names: ["eyes", "+1"] }]);
  for (const answer of answers) await answer();
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(answers.length, 1);
  assert.equal(tmux("capture-pane", "-p", "-t", window).split("\n").filter((line) => line.trim()).at(-1), "1");
  assert.match(posts[0].body, /Chose 1\. Yes/);
  assert.deepEqual(relay.answerReactions(state, [{ ts: alert, names: ["eyes", "+1"] }]), []);

  // Escape, from ✋, while it's still marked waiting.
  for (const answer of relay.answerReactions(state, [{ ts: alert, names: ["+1", "raised_hand"] }])) await answer();
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.match(tmux("capture-pane", "-p", "-t", window), /\^\[/);
  assert.match(posts.at(-1).body, /Pressed Escape in tab/);
  tmux("kill-window", "-t", window);
});

test("a 👍 on a tab that is no longer waiting does nothing but say so", async () => {
  const [window, index] = tmux("new-window", "-d", "-P", "-F", "#{window_id}\t#{window_index}", fakeClaude).split("\t");
  await new Promise((resolve) => setTimeout(resolve, 300));
  tmux("set", "-p", "-t", window, "@agent_state", "working");
  const alert = `${Math.floor(Date.now() / 1000) - 30}.000100`;
  const state = { dm: { channel: "D1", user: "U1" }, threads: {}, reported: {}, following: {}, alerts: { [alert]: { window, index: Number(index), name: "work" } } };

  for (const answer of relay.answerReactions(state, [{ ts: alert, names: ["+1"] }])) await answer();

  assert.match(posts[0].body, /isn't waiting on a choice any more, so your :\+1: did nothing/);
  assert.equal(posts[0].thread, alert);
  assert.doesNotMatch(tmux("capture-pane", "-p", "-t", window), /1/);
  tmux("kill-window", "-t", window);
});

test("reactions are read from a waiting message's thread, however old", async () => {
  const now = Math.floor(Date.now() / 1000);
  const thread = `${now - 7200}.000100`;
  const waiting = `${now - 7000}.000100`;
  const state = {
    dm: { channel: "D1", user: "U1" },
    cursor: `${now - 60}.000100`,
    threads: { [thread]: `${now - 6000}.000100` },
    answerable: { [waiting]: { window: "@1", thread } },
  };
  const asked = [];
  relay.slack.reader = {
    call: async (prompt) => {
      asked.push(prompt);
      return [
        { name: READ_CHANNEL, input: {}, raw: JSON.stringify({ messages: "" }) },
        {
          name: READ_THREAD,
          input: { message_ts: thread },
          raw: JSON.stringify({
            messages: `=== THREAD PARENT MESSAGE ===\nMessage TS: ${thread}\n3: deploy\n=== THREAD REPLIES (1 total) ===\n--- Reply 1 of 1 ---\nMessage TS: ${waiting}\n:robot_face: tab 3 is waiting on you\nReactions: eyes (1), +1 (1)\n*Sent using* <@U2|Claude>`,
          }),
        },
      ];
    },
  };

  const { messages, reactions } = await relay.fetchMessages(state, { wide: false });

  assert.match(asked[0], new RegExp(`message_ts ${thread}, oldest ${now - 7001}\\.000100`));
  assert.deepEqual(messages, []);
  assert.deepEqual(reactions, [{ ts: waiting, names: ["eyes", "+1"] }]);
});

test("milestones ping a tab's thread on a commit, a push and failing tests, then CI goes green", async () => {
  const [window, index] = tmux("new-window", "-d", "-P", "-F", "#{window_id}\t#{window_index}", fakeClaude).split("\t");
  await new Promise((resolve) => setTimeout(resolve, 300));
  const panePid = tmux("display", "-p", "-t", window, "#{pane_pid}");
  fs.writeFileSync(path.join(home, ".claude/sessions", `${panePid}.json`), JSON.stringify({ pid: Number(panePid), sessionId: "shipping" }));
  const transcript = path.join(home, ".claude/projects/-work/shipping.jsonl");
  fs.writeFileSync(transcript, `${JSON.stringify({ type: "user", message: { content: "an old turn" } })}\n`);
  // A stand-in gh: a pull request for the branch, whose checks are pending
  // the first time they are read and pass after that.
  const ghBin = path.join(tmp, "gh-bin");
  const reads = path.join(tmp, "gh-reads");
  fs.mkdirSync(ghBin, { recursive: true });
  fs.writeFileSync(path.join(ghBin, "gh"), `#!/bin/sh
case "$2" in
  view) echo '{"number":7,"url":"https://github.com/o/r/pull/7"}' ;;
  checks) if [ -f '${reads}' ]; then echo '[{"name":"lint","bucket":"pass"},{"name":"test","bucket":"pass"}]'; else touch '${reads}'; echo '[{"name":"lint","bucket":"pass"},{"name":"test","bucket":"pending"}]'; exit 8; fi ;;
esac
`, { mode: 0o755 });
  const thread = `${Math.floor(Date.now() / 1000) - 60}.000100`;
  const state = {
    dm: { channel: "D1", user: "U1" }, reported: {}, following: {},
    threads: { [thread]: thread },
    alerts: { [thread]: { window, index: Number(index), name: "work" } },
  };
  const path_ = process.env.PATH;
  process.env.PATH = `${ghBin}:${path_}`;
  try {
    // First sight: followed from here, the old turn is not news.
    await relay.milestones(state);
    assert.equal(posts.length, 0);

    fs.appendFileSync(transcript, [
      { type: "assistant", cwd: tmp, message: { content: [{ type: "tool_use", id: "c1", name: "Bash", input: { command: "git commit -m 'Add two'" } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "c1", content: "[feature abc1234] Add two\n 1 file changed" }] } },
      { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "pnpm test" } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "FAIL app.test.js\nTests: 1 failed, 4 passed" }] } },
      { type: "assistant", message: { content: [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "pnpm test" } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2", content: "Tests: 5 passed" }] } },
      { type: "assistant", message: { content: [{ type: "tool_use", id: "p1", name: "Bash", input: { command: "git push -u origin feature" } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "p1", content: "To github.com:o/r.git\n * [new branch]      feature -> feature" }] } },
    ].map((entry) => `${JSON.stringify(entry)}\n`).join(""));
    await relay.milestones(state);
    // The pull request is looked up with gh in the background; wait for it.
    for (let i = 0; i < 50 && !state.ci?.["https://github.com/o/r/pull/7"]; i++) await new Promise((resolve) => setTimeout(resolve, 100));

    // Pings name the tab as it is called now.
    const name = tmux("display", "-p", "-t", window, "#{window_name}");
    assert.deepEqual(posts.slice(1).map((p) => p.body), [
      `🤖 tab ${index}, ${name}: committed \`abc1234\` Add two on \`feature\``,
      `🤖 tab ${index}, ${name}: tests failed: \`pnpm test\`, ending "Tests: 1 failed, 4 passed"`,
      `🤖 tab ${index}, ${name}: pushed \`feature\``,
    ]);
    // In the tab's home thread, which the first of them started.
    const homeThread = state.homes[window].ts;
    assert.match(posts[0].body, /This is its thread/);
    posts.slice(1).forEach((p) => assert.equal(p.thread, homeThread));
    assert.deepEqual(posts.slice(1).map((p) => p.broadcast), [false, true, false]);
    assert.equal(state.ci["https://github.com/o/r/pull/7"].number, 7);

    await relay.ciTick(state);
    assert.equal(posts.length, 4, "still pending");
    await relay.ciTick(state);
    assert.equal(posts.length, 4, "all passed once; green has to hold for a second read");
    await relay.ciTick(state);
    assert.equal(posts.at(-1).body, `🤖 tab ${index}, ${name}: ✅ <https://github.com/o/r/pull/7|#7> is green (2 checks)`);
    assert.deepEqual(state.ci, {});
  } finally {
    process.env.PATH = path_;
    fs.rmSync(path.join(home, ".claude/sessions", `${panePid}.json`));
    tmux("kill-window", "-t", window);
  }
});

test("a failing check is reported at once, by name", async () => {
  const ghBin = path.join(tmp, "gh-fail-bin");
  fs.mkdirSync(ghBin, { recursive: true });
  fs.writeFileSync(path.join(ghBin, "gh"), `#!/bin/sh\necho '[{"name":"lint","bucket":"fail"},{"name":"test","bucket":"pending"}]'\nexit 1\n`, { mode: 0o755 });
  const state = {
    dm: { channel: "D1", user: "U1" }, threads: {}, alerts: {}, reported: {}, following: {},
    ci: { "https://github.com/o/r/pull/8": { window: "@999", index: 9, name: "gone", cwd: tmp, number: 8, since: Date.now() } },
  };
  const path_ = process.env.PATH;
  process.env.PATH = `${ghBin}:${path_}`;
  try {
    await relay.ciTick(state);
  } finally {
    process.env.PATH = path_;
  }

  assert.equal(posts[0].body, "🤖 tab 9, gone: ❌ <https://github.com/o/r/pull/8|#8> failed: lint (1 still running)");
  assert.equal(posts[0].thread, undefined);
  assert.deepEqual(state.ci, {});
});

test("a stopped relay marks the dashboard out of date", async () => {
  const made = [];
  relay.slack.canvas = {
    call: async (prompt, tool) => {
      made.push(prompt);
      return [{ name: tool, input: {}, raw: JSON.stringify({ canvas_id: "F0DASH0003", section_id_mapping: { "temp:t": "# Claude tabs", "temp:i": "…", "temp:b": "…" } }) }];
    },
  };
  const state = {
    dm: { channel: "D1", user: "U1" }, threads: {}, alerts: {}, reported: {}, following: {},
    dashboard: { id: "F0DASH0003", url: "u", body: "", title: "Claude tabs", sections: { "temp:t": "# Claude tabs", "temp:i": "…", "temp:b": "…" } },
  };
  try {
    await relay.refreshDashboard(state, { quick: true, stopped: true });
  } finally {
    relay.slack.canvas = undefined;
  }

  const edits = JSON.parse(made[0].slice(made[0].indexOf("\n\n") + 2));
  assert.deepEqual(edits[0].section_id, "temp:i");
  assert.match(edits[0].content, /^:warning: The relay stopped at .+, so this is out of date\./);
});

test("a home thread stays watched past the usual limits", () => {
  const now = Math.floor(Date.now() / 1000);
  const homeThread = `${now - 3 * 24 * 3600}.000100`;
  const state = {
    threads: { [homeThread]: homeThread },
    alerts: { [homeThread]: { window: "@5" } },
    homes: { "@5": { ts: homeThread, pid: "1" } },
  };
  Array.from({ length: 40 }, (_, i) => `${now - i}.000100`).forEach((ts) => relay.watchThread(state, ts));

  assert.ok(state.threads[homeThread]);
  assert.ok(state.alerts[homeThread]);
  assert.equal(Object.keys(state.threads).length, 31);
});

test("a turn finished in a tab's home thread also gets a line in the main DM", async () => {
  const [window, index] = tmux("new-window", "-d", "-P", "-F", "#{window_id}\t#{window_index}", fakeClaude).split("\t");
  await new Promise((resolve) => setTimeout(resolve, 300));
  const transcript = path.join(home, ".claude/projects/-work/homed.jsonl");
  fs.writeFileSync(transcript, [
    { type: "user", message: { content: "ship it" } },
    { type: "assistant", message: { content: [{ type: "text", text: "Shipped." }] } },
  ].map((entry) => JSON.stringify(entry)).join("\n"));
  fs.writeFileSync(relay.EVENTS_FILE, `${JSON.stringify({ event: "done", time: Math.floor(Date.now() / 1000), transcript_path: transcript })}\n`);
  const homeThread = `${Math.floor(Date.now() / 1000) - 60}.000100`;
  const state = {
    dm: { channel: "D1", user: "U1" }, threads: { [homeThread]: homeThread }, alerts: {}, reported: {}, eventsOffset: 0,
    homes: { [window]: { ts: homeThread, pid: "1" } },
    following: { [window]: { thread: homeThread, index: Number(index), name: "work", text: "ship it", sentAt: Date.now() - 5_000, screen: "", changedAt: 0 } },
  };

  await relay.followUps(state);

  assert.equal(posts.length, 2);
  assert.equal(posts[0].body, `🤖 tab ${index}, work is done:\n> ship it\n\nShipped.`);
  assert.equal(posts[0].broadcast, false);
  assert.equal(posts[1].body, `🤖 tab ${index}, work is done.`);
  assert.equal(posts[1].thread, homeThread);
  assert.equal(posts[1].broadcast, true);
  fs.rmSync(relay.EVENTS_FILE);
  tmux("kill-window", "-t", window);
});

test("forCanvas separates a list from the line before it, outside code blocks", () => {
  const text = [
    "*Answer with less typing*",
    "1. Shortcuts",
    "",
    "*Know without asking*",
    "2. Fleet view",
    "3. A digest",
    "Some text",
    "- a bullet",
    "  continued",
    "```",
    "intro",
    "4. not a list in code",
    "```",
  ].join("\n");

  assert.equal(relay.forCanvas(text), [
    "*Answer with less typing*",
    "",
    "1. Shortcuts",
    "",
    "*Know without asking*",
    "",
    "2. Fleet view",
    "3. A digest",
    "Some text",
    "",
    "- a bullet",
    "  continued",
    "```",
    "intro",
    "4. not a list in code",
    "```",
  ].join("\n"));
});

test("progress all summarizes every tab at once, or lists their facts if the summary fails", async () => {
  const [first, firstIndex] = tmux("new-window", "-d", "-P", "-F", "#{window_id}\t#{window_index}", fakeClaude).split("\t");
  const [second, secondIndex] = tmux("new-window", "-d", "-P", "-F", "#{window_id}\t#{window_index}", fakeClaude).split("\t");
  await new Promise((resolve) => setTimeout(resolve, 300));
  tmux("set", "-p", "-t", first, "@agent_state", "waiting");
  tmux("set", "-p", "-t", second, "@agent_state", "working");
  const state = { dm: { channel: "D1", user: "U1" }, threads: {}, alerts: {}, reported: {}, following: {} };
  const request = `${Math.floor(Date.now() / 1000)}.000018`;

  // The tests' own claude always fails, so this is the fallback.
  await relay.handle(state, { ts: request, text: "progress all", thread_ts: null });

  assert.deepEqual(reactions, [{ ts: request, emoji: "eyes" }]);
  assert.match(posts[0].body, /^🤖 \d+ Claude tabs?:\nI couldn't summarize them, so here is where each one is:\n/);
  assert.match(posts[0].body, new RegExp(`• tab ${firstIndex}, [^\\n]* is \\*waiting on you\\*`));
  assert.match(posts[0].body, new RegExp(`• tab ${secondIndex}, [^\\n]* is working`));

  const fleetBin = path.join(tmp, "fleet-bin");
  const given = path.join(tmp, "fleet-input.txt");
  fs.mkdirSync(fleetBin, { recursive: true });
  fs.writeFileSync(path.join(fleetBin, "claude"), `#!/bin/sh\ncat > '${given}'\necho '• Tab ${firstIndex}, x: waiting on you to approve a push.'\n`, { mode: 0o755 });
  const path_ = process.env.PATH;
  process.env.PATH = `${fleetBin}:${path_}`;
  try {
    await relay.handle(state, { ts: `${Math.floor(Date.now() / 1000)}.000019`, text: "progress", thread_ts: null });
  } finally {
    process.env.PATH = path_;
  }

  assert.match(posts[1].body, new RegExp(`\\n• Tab ${firstIndex}, x: waiting on you to approve a push\\.$`));
  const input = fs.readFileSync(given, "utf8");
  assert.match(input, new RegExp(`## tab ${firstIndex}, [^\\n]* is \\*waiting on you\\*`));
  assert.match(input, new RegExp(`## tab ${secondIndex}, [^\\n]* is working`));
  tmux("kill-window", "-t", first);
  tmux("kill-window", "-t", second);
});

test("a working tab with nothing new for ten minutes is noted once per stall", async () => {
  const [window, index] = tmux("new-window", "-d", "-P", "-F", "#{window_id}\t#{window_index}", fakeClaude).split("\t");
  await new Promise((resolve) => setTimeout(resolve, 300));
  tmux("set", "-p", "-t", window, "@agent_state", "working");
  tmux("send-keys", "-t", window, "-l", "✻ Running pnpm test… (11m 2s)");
  const panePid = tmux("display", "-p", "-t", window, "#{pane_pid}");
  fs.writeFileSync(path.join(home, ".claude/sessions", `${panePid}.json`), JSON.stringify({ pid: Number(panePid), sessionId: "stalled" }));
  const transcript = path.join(home, ".claude/projects/-work/stalled.jsonl");
  fs.writeFileSync(transcript, [
    { type: "user", message: { content: "run the suite" } },
    { type: "assistant", message: { content: [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "pnpm test" } }] } },
  ].map((entry) => JSON.stringify(entry)).join("\n"));
  const stale = (Date.now() - relay.STUCK_MS - 60_000) / 1000;
  fs.utimesSync(transcript, stale, stale);
  const state = { dm: { channel: "D1", user: "U1" }, threads: {}, alerts: {}, reported: {}, following: {} };
  try {
    await relay.stuckTabs(state);
    await relay.stuckTabs(state);

    // The home thread, the note in it, and a line in the main DM, once.
    assert.equal(posts.length, 3);
    assert.match(posts[1].body, new RegExp(`^🤖 tab ${index}, [^:]*: it's marked working, but nothing has happened for 11m\\.`));
    assert.match(posts[1].body, /What it did last:\n• Bash: pnpm test/);
    assert.match(posts[1].body, /On screen now:\n```\n[\s\S]*Running pnpm test/);
    assert.equal(posts[2].broadcast, true);
    assert.match(posts[2].body, /may be stuck: nothing new for 11m\.$/);

    // It moves on, then stalls again: noted again.
    const later = (Date.now() - relay.STUCK_MS - 120_000) / 1000;
    fs.utimesSync(transcript, later, later);
    await relay.stuckTabs(state);
    assert.equal(posts.length, 5);

    // Not working any more: nothing.
    tmux("set", "-p", "-t", window, "@agent_state", "done");
    await relay.stuckTabs(state);
    assert.equal(posts.length, 5);
    assert.deepEqual(state.stuck, {});
  } finally {
    fs.rmSync(path.join(home, ".claude/sessions", `${panePid}.json`));
    tmux("kill-window", "-t", window);
  }
});

test("a turn ending at a tool call isn't reported until its last words are written", async () => {
  const [window, index] = tmux("new-window", "-d", "-P", "-F", "#{window_id}\t#{window_index}", fakeClaude).split("\t");
  await new Promise((resolve) => setTimeout(resolve, 300));
  const transcript = path.join(home, ".claude/projects/-work/midturn.jsonl");
  fs.writeFileSync(transcript, [
    { type: "user", message: { content: "is idle mode worth it?" } },
    { type: "assistant", message: { content: [{ type: "text", text: "Before answering, I'll check the log." }, { type: "tool_use", id: "g1", name: "Bash", input: { command: "grep" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "g1", content: "no matches" }] } },
  ].map((entry) => `${JSON.stringify(entry)}\n`).join(""));
  fs.writeFileSync(relay.EVENTS_FILE, `${JSON.stringify({ event: "done", time: Math.floor(Date.now() / 1000), transcript_path: transcript })}\n`);
  const thread = `${Math.floor(Date.now() / 1000) - 5}.000100`;
  const state = {
    dm: { channel: "D1", user: "U1" }, threads: {}, alerts: {}, reported: {}, eventsOffset: 0,
    following: { [window]: { thread, index: Number(index), name: "work", text: "is idle mode worth it?", sentAt: Date.now() - 5_000, screen: "", changedAt: 0 } },
  };

  // The Stop hook has fired, but the transcript stops after the tool's result.
  await relay.followUps(state);
  assert.equal(posts.length, 0);
  assert.equal(relay.turnWritten(transcript), false);

  fs.appendFileSync(transcript, `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Mostly, yes." }] } })}\n`);
  assert.equal(relay.turnWritten(transcript), true);
  await relay.followUps(state);

  assert.equal(posts.length, 1);
  assert.match(posts[0].body, /Before answering, I'll check the log\.\n\nMostly, yes\.\n\n_\(ran 1 tool\)_$/);
  fs.rmSync(relay.EVENTS_FILE);
  tmux("kill-window", "-t", window);
});

test("agent-state.sh marks the tab a background job was parked from", async () => {
  const [window] = tmux("new-window", "-d", "-P", "-F", "#{window_id}\t#{window_index}", fakeClaude).split("\t");
  await new Promise((resolve) => setTimeout(resolve, 300));
  const panePid = tmux("display", "-p", "-t", window, "#{pane_pid}");
  const sessions = path.join(home, ".claude/sessions");
  // The tab's Claude is parked into job J; the job runs elsewhere, with no tmux.
  fs.writeFileSync(path.join(sessions, `${panePid}.json`), JSON.stringify({ pid: Number(panePid), sessionId: "front", kind: "interactive", parkedJobId: "J" }));
  fs.writeFileSync(path.join(sessions, "900010.json"), JSON.stringify({ pid: 900010, sessionId: "background", kind: "bg", jobId: "J" }));
  const hook = path.join(__dirname, "../tmux/agent-state.sh");
  // TMUX names the tests' own server; there is no TMUX_PANE, as in a job.
  const env = { ...process.env, HOME: home };
  delete env.TMUX_PANE;
  try {
    execFileSync("bash", [hook, "set", "working"], { env, input: JSON.stringify({ hook_event_name: "PostToolUse", session_id: "background" }) });
    assert.equal(tmux("display", "-p", "-t", window, "#{@agent_state}"), "working");

    // A session parked nowhere is left alone.
    execFileSync("bash", [hook, "set", "waiting"], { env, input: JSON.stringify({ session_id: "somewhere-else" }) });
    assert.equal(tmux("display", "-p", "-t", window, "#{@agent_state}"), "working");
  } finally {
    ["900010", panePid].forEach((pid) => fs.rmSync(path.join(sessions, `${pid}.json`)));
    tmux("kill-window", "-t", window);
  }
});

test("CI isn't called green while new checks are still appearing", async () => {
  // Two checks pass, then a third appears (a workflow that waited for them),
  // runs, and passes: green only once the same checks pass on two reads.
  const ghBin = path.join(tmp, "gh-late-bin");
  const step = path.join(tmp, "gh-late-step");
  fs.mkdirSync(ghBin, { recursive: true });
  fs.writeFileSync(step, "0");
  fs.writeFileSync(path.join(ghBin, "gh"), `#!/bin/sh
n=$(cat '${step}'); echo $((n + 1)) > '${step}'
case $n in
  0) echo '[{"name":"lint","bucket":"pass"},{"name":"build","bucket":"pass"}]' ;;
  1) echo '[{"name":"lint","bucket":"pass"},{"name":"build","bucket":"pass"},{"name":"e2e","bucket":"pending"}]' ;;
  *) echo '[{"name":"lint","bucket":"pass"},{"name":"build","bucket":"pass"},{"name":"e2e","bucket":"pass"}]' ;;
esac
`, { mode: 0o755 });
  const state = {
    dm: { channel: "D1", user: "U1" }, threads: {}, alerts: {}, reported: {}, following: {},
    ci: { "https://github.com/o/r/pull/9": { window: "@998", index: 9, name: "gone", cwd: tmp, number: 9, since: Date.now() } },
  };
  const path_ = process.env.PATH;
  process.env.PATH = `${ghBin}:${path_}`;
  try {
    for (let i = 0; i < 3; i++) await relay.ciTick(state);
    assert.equal(posts.length, 0, "the first all-pass was followed by a new check");
    await relay.ciTick(state);
    assert.equal(posts[0].body, "🤖 tab 9, gone: ✅ <https://github.com/o/r/pull/9|#9> is green (3 checks)");
  } finally {
    process.env.PATH = path_;
  }
});

test("a lagging transcript is waited for until its last text is the hook's final message", async () => {
  const [window, index] = tmux("new-window", "-d", "-P", "-F", "#{window_id}\t#{window_index}", fakeClaude).split("\t");
  await new Promise((resolve) => setTimeout(resolve, 300));
  const transcript = path.join(home, ".claude/projects/-work/lagging.jsonl");
  // Written up to a text whose tool call hasn't been written yet: it ends in
  // text, but not the turn's.
  fs.writeFileSync(transcript, [
    { type: "user", message: { content: "reorder the commits" } },
    { type: "assistant", message: { content: [{ type: "text", text: "Moving main now:" }] } },
  ].map((entry) => `${JSON.stringify(entry)}\n`).join(""));
  fs.writeFileSync(relay.EVENTS_FILE, `${JSON.stringify({ event: "done", time: Math.floor(Date.now() / 1000), transcript_path: transcript, last: "Both are done." })}\n`);
  const thread = `${Math.floor(Date.now() / 1000) - 5}.000100`;
  const state = {
    dm: { channel: "D1", user: "U1" }, threads: {}, alerts: {}, reported: {}, eventsOffset: 0,
    following: { [window]: { thread, index: Number(index), name: "work", text: "reorder the commits", sentAt: Date.now() - 5_000, screen: "", changedAt: 0 } },
  };

  await relay.followUps(state);
  assert.equal(posts.length, 0, "ends in text, but not the final message");

  fs.appendFileSync(transcript, [
    { type: "assistant", message: { content: [{ type: "tool_use", id: "m1", name: "Bash", input: { command: "git branch -f main" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "m1", content: "" }] } },
    { type: "assistant", message: { content: [{ type: "text", text: "Both are done." }] } },
  ].map((entry) => `${JSON.stringify(entry)}\n`).join(""));
  await relay.followUps(state);

  assert.equal(posts.length, 1);
  assert.match(posts[0].body, /Moving main now:\n\nBoth are done\.\n\n_\(ran 1 tool\)_$/);
  fs.rmSync(relay.EVENTS_FILE);
  tmux("kill-window", "-t", window);
});

test("a transcript that never catches up is posted with the hook's final message added", async () => {
  const [window, index] = tmux("new-window", "-d", "-P", "-F", "#{window_id}\t#{window_index}", fakeClaude).split("\t");
  await new Promise((resolve) => setTimeout(resolve, 300));
  const transcript = path.join(home, ".claude/projects/-work/stuck-behind.jsonl");
  fs.writeFileSync(transcript, [
    { type: "user", message: { content: "summarize it" } },
    { type: "assistant", message: { content: [{ type: "text", text: "Reading the log first." }] } },
  ].map((entry) => `${JSON.stringify(entry)}\n`).join(""));
  fs.writeFileSync(relay.EVENTS_FILE, `${JSON.stringify({ event: "done", time: Math.floor(Date.now() / 1000), transcript_path: transcript, last: "Here is the summary." })}\n`);
  const state = {
    dm: { channel: "D1", user: "U1" }, threads: {}, alerts: {}, reported: {}, eventsOffset: 0,
    following: { [window]: { thread: null, index: Number(index), name: "work", text: "summarize it", sentAt: Date.now() - 5_000, screen: "", changedAt: 0 } },
  };

  await relay.followUps(state);
  assert.equal(posts.length, 0);
  state.following[window].ended.at -= 61_000;
  await relay.followUps(state);

  assert.equal(posts[0].body, `🤖 tab ${index}, work is done:\n> summarize it\n\nReading the log first.\n\nHere is the summary.`);
  fs.rmSync(relay.EVENTS_FILE);
  tmux("kill-window", "-t", window);
});

test("agent-state.sh gives the relay a finished turn's final message", () => {
  fs.writeFileSync(relay.EVENTS_FILE, "");
  const env = { ...process.env, HOME: home };
  delete env.TMUX;
  delete env.TMUX_PANE;

  execFileSync("bash", [path.join(__dirname, "../tmux/agent-state.sh"), "set", "done"], {
    env,
    input: JSON.stringify({ hook_event_name: "Stop", session_id: "s2", transcript_path: "/t2.jsonl", cwd: "/w", last_assistant_message: "All done." }),
  });

  const [event] = fs.readFileSync(relay.EVENTS_FILE, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(event.event, "done");
  assert.equal(event.last, "All done.");
  fs.rmSync(relay.EVENTS_FILE);
});

test("milestones count git's own push and commit, not a subcommand's", () => {
  const kinds = (command) => relay.MILESTONE_KINDS.filter(([, pattern]) => pattern.test(command)).map(([kind]) => kind);

  assert.deepEqual(kinds("git push -u origin feature"), ["push"]);
  assert.deepEqual(kinds("git -C ~/repo push"), ["push"]);
  assert.deepEqual(kinds("git -c user.name=x commit -m 'Fix'"), ["commit"]);
  assert.deepEqual(kinds("git add . && git commit -m x && git push"), ["push", "commit"]);
  assert.deepEqual(kinds("git stash push -q -m reorder"), []);
  assert.deepEqual(kinds("git stash push -m x && git commit --amend"), ["commit"]);
});

test("optionsIn ignores a file preview above a real Write prompt", () => {
  // Captured from Claude Code's prompt to create a file.
  const screen = [
    "⏺ Write(hello.txt)",
    "─".repeat(80),
    " Create file",
    " hello.txt",
    "╌".repeat(80),
    "  1 hi",
    "╌".repeat(80),
    " Do you want to create hello.txt?",
    " ❯ 1. Yes",
    "   2. Yes, and allow Claude to edit files in its ~/.claude folder for this session",
    "   3. No",
    " Esc to cancel · Tab to amend",
  ].join("\n");

  assert.deepEqual(relay.optionsIn(screen), {
    question: "Do you want to create hello.txt?",
    options: [
      { n: 1, label: "Yes" },
      { n: 2, label: "Yes, and allow Claude to edit files in its ~/.claude folder for this session" },
      { n: 3, label: "No" },
    ],
  });
});

test("agent-state.sh keeps a wait's start time when it is marked waiting again", async () => {
  const [window] = tmux("new-window", "-d", "-P", "-F", "#{window_id}\t#{window_index}", fakeClaude).split("\t");
  await new Promise((resolve) => setTimeout(resolve, 300));
  const pane = tmux("display", "-p", "-t", window, "#{pane_id}");
  const env = { ...process.env, HOME: home, TMUX_PANE: pane };
  const hook = path.join(__dirname, "../tmux/agent-state.sh");
  try {
    execFileSync("bash", [hook, "set", "waiting"], { env, input: "{}" });
    const since = tmux("display", "-p", "-t", pane, "#{@agent_since}");
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    // The Notification hook, seconds later, for the same prompt.
    execFileSync("bash", [hook, "set", "waiting"], { env, input: "{}" });
    assert.equal(tmux("display", "-p", "-t", pane, "#{@agent_since}"), since);

    execFileSync("bash", [hook, "set", "working"], { env, input: "{}" });
    assert.equal(tmux("display", "-p", "-t", pane, "#{@agent_state}"), "working");
    assert.notEqual(tmux("display", "-p", "-t", pane, "#{@agent_since}"), since);
  } finally {
    tmux("kill-window", "-t", window);
  }
});

test("screen cuts Claude Code's full-width rules to a few characters", async () => {
  const [window] = tmux("new-window", "-d", "-P", "-F", "#{window_id}\t#{window_index}", fakeClaude).split("\t");
  await new Promise((resolve) => setTimeout(resolve, 300));
  tmux("send-keys", "-t", window, "-l", `${"─".repeat(150)} and ${"╌".repeat(40)} but ab-cd stays`);
  await new Promise((resolve) => setTimeout(resolve, 200));

  assert.equal(relay.screen(window), "─── and ╌╌╌ but ab-cd stays");
  tmux("kill-window", "-t", window);
});

test("dialogIn reads the dialogs Claude Code shows before a session starts", () => {
  // Both captured from real tabs.
  const trust = [
    "─".repeat(60),
    " Accessing workspace:",
    " /work/new-repo",
    " Quick safety check: Is this a project you created or one you trust?",
    " Claude Code'll be able to read, edit, and execute files here.",
    " Security guide",
    " ❯ No, exit",
    "   Yes, I trust this folder",
    " Enter to confirm · Esc to cancel",
  ].join("\n");
  assert.deepEqual(relay.dialogIn(trust), {
    question: "Quick safety check: Is this a project you created or one you trust? Claude Code'll be able to read, edit, and execute files here. Security guide",
    options: [{ n: 1, label: "No, exit" }, { n: 2, label: "Yes, I trust this folder" }],
    cursor: 1,
  });

  const mcp = [
    "  New MCP server found in this project: some-server",
    "  MCP servers may execute code or access system resources. All tool calls require approval.",
    "    Use this MCP server",
    "    Use this and all future MCP servers in this project",
    "  ❯ Continue without using this MCP server",
    "  Enter to confirm · Esc to cancel",
  ].join("\n");
  const found = relay.dialogIn(mcp);
  assert.deepEqual(found.options.map((o) => o.label), [
    "Use this MCP server",
    "Use this and all future MCP servers in this project",
    "Continue without using this MCP server",
  ]);
  assert.equal(found.cursor, 3);

  // Not at the bottom of the screen: an old dialog, already answered.
  assert.equal(relay.dialogIn(`${trust}\n● Working on it\n> next\n✻ Thinking`), undefined);
});

test("a dialog before a session starts is alerted once and answered with arrow keys", async () => {
  const [window, index] = tmux("new-window", "-d", "-P", "-F", "#{window_id}\t#{window_index}", fakeClaude).split("\t");
  await new Promise((resolve) => setTimeout(resolve, 300));
  [" Is this a project you trust?", " ❯ No, exit", "   Yes, I trust this folder", " Enter to confirm · Esc to cancel"].forEach((line) => {
    tmux("send-keys", "-t", window, "-l", line);
    tmux("send-keys", "-t", window, "Enter");
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
  const state = { dm: { channel: "D1", user: "U1" }, threads: {}, alerts: {}, reported: {}, following: {} };

  await relay.alertTabs(state);
  await relay.alertTabs(state);

  // The tab's thread, the alert in it, and a notice in the main DM, once.
  assert.equal(posts.length, 3);
  assert.match(posts[1].body, new RegExp(`^🤖 Tab ${index}, .* is showing a dialog before its session starts`));
  assert.match(posts[1].body, /\*Is this a project you trust\?\*\n1\. No, exit \(selected\)\n2\. Yes, I trust this folder\n/);
  assert.equal(posts[2].broadcast, true);
  assert.deepEqual(state.answerable ?? {}, {}, "no reactions on dialogs");

  await relay.handle(state, { ts: `${Math.floor(Date.now() / 1000)}.000020`, text: "yes", thread_ts: posts[1].thread });
  await new Promise((resolve) => setTimeout(resolve, 200));

  assert.match(posts.at(-1).body, /^🤖 Chose "Yes, I trust this folder" in tab/);
  // cat shows the Down arrow as ^[[B; the Enter after it moves the cursor to
  // a new line below.
  const lines = tmux("capture-pane", "-p", "-t", window).split("\n");
  const arrow = lines.findIndex((line) => line === "^[[B");
  assert.ok(arrow >= 0);
  assert.equal(lines.filter((line) => line.includes("^[[B")).length, 1);
  assert.ok(Number(tmux("display", "-p", "-t", window, "#{cursor_y}")) > arrow);
  tmux("kill-window", "-t", window);
});

test("new: starts a Claude in a named repository, worktree or directory, and only on one match", async () => {
  const repo = path.join(tmp, "myapp");
  fs.mkdirSync(repo);
  const git = (...args) => execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], { stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("commit", "-q", "--allow-empty", "-m", "Start");
  git("worktree", "add", "-q", "-b", "abc-214-make-the-thing", path.join(tmp, "myapp-abc-214"));
  git("worktree", "add", "-q", "-b", "abc-300-other-thing", path.join(tmp, "myapp-abc-300"));
  // An open tab in the repository is how the relay knows it is in use.
  const [inRepo] = tmux("new-window", "-d", "-c", repo, "-P", "-F", "#{window_id}\t#{window_index}", fakeClaude).split("\t");
  await new Promise((resolve) => setTimeout(resolve, 300));
  const state = { dm: { channel: "D1", user: "U1" }, threads: {}, alerts: {}, reported: {}, following: {} };
  const ask = (text) => relay.handle(state, { ts: `${Math.floor(Date.now() / 1000)}.${String(Math.random()).slice(2, 8)}`, text, thread_ts: null });
  const opened = () => tmux("list-windows", "-F", "#{window_id}").split("\n");

  const before = opened();
  await ask("new ABC-214: make the thing");
  const window = opened().find((id) => !before.includes(id));
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(tmux("display", "-p", "-t", window, "#{pane_current_path}"), fs.realpathSync(path.join(tmp, "myapp-abc-214")));
  assert.match(tmux("capture-pane", "-p", "-t", window), /claude 'make the thing'/);
  assert.match(posts.at(-1).body, /Started a new Claude in tab \d+, in `.*myapp-abc-214` \(myapp, abc-214-make-the-thing\)\./);

  const beforeRepo = opened();
  await ask("new myapp: look around");
  const repoWindow = opened().find((id) => !beforeRepo.includes(id));
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(tmux("display", "-p", "-t", repoWindow, "#{pane_current_path}"), fs.realpathSync(repo));
  assert.match(posts.at(-1).body, /\(myapp, main\)/);

  const beforeErrors = opened();
  await ask("new abc: which one?");
  assert.match(posts.at(-1).body, /`abc` matches 2 places, so I didn't start anything/);
  await ask("new zzz: nothing");
  assert.match(posts.at(-1).body, /Nothing matches `zzz`/);
  await ask("new ~/no-such-dir: nothing");
  assert.match(posts.at(-1).body, /There's no directory `~\/no-such-dir`/);
  assert.deepEqual(opened(), beforeErrors, "no tab opened for an unclear place");

  [window, repoWindow, inRepo].forEach((id) => tmux("kill-window", "-t", id));
});

test("a session gives up on a turn after its own time limit", async () => {
  // A stand-in for `claude -p` that takes requests and never answers, as the
  // Slack connector does when it stalls.
  const silentBin = path.join(tmp, "silent-bin");
  fs.mkdirSync(silentBin, { recursive: true });
  fs.writeFileSync(path.join(silentBin, "claude"), `#!${process.execPath}\nrequire("node:readline").createInterface({ input: process.stdin }).on("line", () => {});\n`, { mode: 0o755 });
  const path_ = process.env.PATH;
  process.env.PATH = `${silentBin}:${path_}`;
  const session = new relay.SlackSession("quick reader", [READ_CHANNEL], { hooks: {} }, 1, 500);
  try {
    const started = Date.now();
    await assert.rejects(session.call("read", READ_CHANNEL, () => true), /quick reader timed out/);
    const took = Date.now() - started;
    assert.ok(took >= 500 && took < 3_000, `gave up after ${took}ms`);
  } finally {
    session.stop();
    process.env.PATH = path_;
  }
});

test("no stuck notes in the first ten minutes after the Mac wakes", async () => {
  const [window] = tmux("new-window", "-d", "-P", "-F", "#{window_id}\t#{window_index}", fakeClaude).split("\t");
  await new Promise((resolve) => setTimeout(resolve, 300));
  tmux("set", "-p", "-t", window, "@agent_state", "working");
  const panePid = tmux("display", "-p", "-t", window, "#{pane_pid}");
  fs.writeFileSync(path.join(home, ".claude/sessions", `${panePid}.json`), JSON.stringify({ pid: Number(panePid), sessionId: "slept" }));
  const transcript = path.join(home, ".claude/projects/-work/slept.jsonl");
  fs.writeFileSync(transcript, JSON.stringify({ type: "user", message: { content: "long job" } }));
  // Untouched since the Mac went to sleep, hours ago.
  const asleep = (Date.now() - 5 * 60 * 60_000) / 1000;
  fs.utimesSync(transcript, asleep, asleep);
  const state = { dm: { channel: "D1", user: "U1" }, threads: {}, alerts: {}, reported: {}, following: {} };
  try {
    relay.life.wokeAt = Date.now() - 60_000;
    await relay.stuckTabs(state);
    assert.equal(posts.length, 0, "it just woke up");

    relay.life.wokeAt = Date.now() - relay.STUCK_MS - 1_000;
    await relay.stuckTabs(state);
    assert.ok(posts.some((p) => /may be stuck/.test(p.body)), "still nothing ten minutes after waking");
  } finally {
    relay.life.wokeAt = 0;
    fs.rmSync(path.join(home, ".claude/sessions", `${panePid}.json`));
    tmux("kill-window", "-t", window);
  }
});

test("the dispatcher handles each message once, in order, and moves the cursor past everything", async () => {
  const thread = `${Math.floor(Date.now() / 1000) - 60}.000100`;
  const state = { dm: { channel: "D1", user: "U1" }, cursor: "1791700000.000050", threads: { [thread]: thread }, alerts: {}, reported: {}, following: {} };
  const { processMessages, settled } = relay.dispatcher(state);
  const now = Math.floor(Date.now() / 1000);

  // Two overlapping checks: the second sees one message again, and the
  // messages arrive out of order.
  processMessages([
    { ts: `${now}.000002`, text: "98: second", byClaude: false, thread_ts: null },
    { ts: `${now}.000001`, text: "99: first", byClaude: false, thread_ts: null },
  ]);
  processMessages([
    { ts: `${now}.000002`, text: "98: second", byClaude: false, thread_ts: null },
    { ts: `${now}.000003`, text: "🤖 the relay's own post", byClaude: true, thread_ts: null },
    { ts: `${now}.000004`, text: "status", byClaude: false, thread_ts: thread },
  ]);
  await settled();

  assert.deepEqual(posts.map((p) => p.body.split("\n")[0]), ["🤖 No Claude tab 99.", "🤖 No Claude tab 98.", "🤖 Status"]);
  assert.equal(state.cursor, `${now}.000003`, "past the relay's own post too");
  assert.equal(state.threads[thread], `${now}.000004`);
});

test("a message that fails is answered with the error, and the next one still runs", async () => {
  const state = { dm: { channel: "D1", user: "U1" }, cursor: "1791700000.000050", threads: {}, alerts: {}, reported: {}, following: {} };
  const { processMessages, settled } = relay.dispatcher(state);
  const now = Math.floor(Date.now() / 1000);

  processMessages([
    // No text to read, so handling it fails.
    { ts: `${now}.000005`, text: undefined, byClaude: false, thread_ts: "1791700000.000060" },
    { ts: `${now}.000006`, text: "99: after it", byClaude: false, thread_ts: null },
  ]);
  await settled();

  assert.match(posts[0].body, /^🤖 That failed: /);
  assert.equal(posts[0].thread, "1791700000.000060");
  assert.equal(posts.at(-1).body, "🤖 No Claude tab 99.");
});

test("the watchdog restarts a crashed relay, telling it why, until it ends cleanly", async () => {
  // A stand-in relay that logs a crash and exits 1 twice, then exits 0.
  const fake = path.join(tmp, "fake-relay.js");
  const runs = path.join(tmp, "fake-relay-runs.txt");
  fs.writeFileSync(runs, "");
  fs.writeFileSync(fake, `const fs = require("fs");
const n = fs.readFileSync(${JSON.stringify(runs)}, "utf8").split("\\n").filter(Boolean).length + 1;
fs.appendFileSync(${JSON.stringify(runs)}, JSON.stringify(process.env.SLACK_RELAY_RESTARTED ?? "") + "\\n");
if (n <= 2) {
  fs.appendFileSync(${JSON.stringify(relay.LOG_FILE)}, new Date().toISOString() + " Error: crashed: boom " + n + "\\n");
  process.exit(1);
}
process.exit(0);
`);
  let downs = 0;

  const code = await relay.watch({ command: [fake], delays: [10, 10, 10, 10, 10], down: async () => downs++ });

  assert.equal(code, 0);
  assert.equal(downs, 0);
  assert.deepEqual(fs.readFileSync(runs, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)), ["", "boom 1", "boom 2"]);
});

test("the watchdog gives up after five crashes and says the relay is down", async () => {
  const fake = path.join(tmp, "always-crashes.js");
  fs.writeFileSync(fake, `require("fs").appendFileSync(${JSON.stringify(relay.LOG_FILE)}, new Date().toISOString() + " Error: crashed: no network\\n"); process.exit(1);\n`);
  fs.writeFileSync(relay.EVENTS_FILE, "");
  const said = [];

  const code = await relay.watch({ command: [fake], delays: [10, 10, 10, 10, 10], down: async (why) => said.push(why) });

  assert.equal(code, 1);
  assert.deepEqual(said, ["no network"]);
  assert.equal(fs.existsSync(relay.EVENTS_FILE), false, "nothing will read the hooks' events now");
});

test("the watchdog doesn't restart a relay that refused to start", async () => {
  const fake = path.join(tmp, "refuses.js");
  fs.writeFileSync(fake, "process.exit(3);\n");
  let downs = 0;

  const code = await relay.watch({ command: [fake], delays: [10], down: async () => downs++ });

  assert.equal(code, 3);
  assert.equal(downs, 0);
});

test("each Slack session's hook refuses every tool but its own", () => {
  const settings = relay.onlyTools([READ_CHANNEL, READ_THREAD], relay.dmOnly({ channel: "D1", user: "U1" }));
  const [allowlist, ...rest] = settings.hooks.PreToolUse;
  assert.equal(allowlist.matcher, "*");
  assert.equal(rest.length, 2, "the session's own hooks are kept");
  const exit = (tool) => {
    try {
      execFileSync("sh", ["-c", allowlist.hooks[0].command], { input: JSON.stringify({ tool_name: tool, tool_input: {} }), stdio: ["pipe", "ignore", "pipe"] });
      return 0;
    } catch (err) {
      return err.status;
    }
  };

  assert.equal(exit(READ_CHANNEL), 0);
  assert.equal(exit(READ_THREAD), 0);
  assert.equal(exit("ToolSearch"), 0, "it only loads tool definitions");
  assert.equal(exit("mcp__claude_ai_Slack__slack_schedule_message"), 2);
  assert.equal(exit("mcp__claude_ai_Slack__slack_send_message_draft"), 2);
  assert.equal(exit("mcp__claude_ai_Linear__save_issue"), 2);
  assert.equal(exit("Bash"), 2);
});

test("the usage report tallies each kind of session, with the plan's usage, then starts afresh", () => {
  relay.usage.kinds.clear();
  const reader = new relay.SlackSession("reader 2", [], {});
  const poster = new relay.SlackSession("poster", [], {});
  [reader, reader, poster].forEach((session) => {
    session.pending = { uses: new Map(), calls: [], progress() {}, resolve() {} };
    session.event({ type: "result", usage: { input_tokens: 100, cache_read_input_tokens: 2_000_000, cache_creation_input_tokens: 500_000, output_tokens: 3_000 } });
  });
  reader.event({ type: "rate_limit_event", rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.12 }, seven_day: { utilization: 0.3 } } } });

  assert.equal(
    relay.usageReport(5),
    "usage over 5m: reader: 2 turns, 5.0M in (4.0M cached, 1.0M cache writes, 0.0M fresh), 6k out; poster: 1 turns, 2.5M in (2.0M cached, 0.5M cache writes, 0.0M fresh), 3k out; plan: 5h 12%, 7d 30%",
  );
  assert.match(relay.usageReport(5), /^usage over 5m: nothing; plan:/);
});
