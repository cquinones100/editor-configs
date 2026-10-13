// Part of bin/slack-relay; see the comment at the top of that file.

const { log, tmux, tryTmux } = require("./util");
const { post } = require("./post");
const { watchThread } = require("./state");
const { claudeTabs, label, resolveTarget, claudePane, transcriptFor, lastTurn, lastPrompt, screen, optionsIn, chosenOption, dialogIn, typeInto } = require("./tabs");
const { progress, fleet } = require("./summaries");
const { diff } = require("./diffs");
const { homeOf } = require("./homes");
const { startedAt, stopRelay } = require("./lifecycle");
const { resolvePlace, shortPath } = require("./places");

// ── Handling messages ───────────────────────────────────────────────────────

const shellQuote = (text) => `'${text.replace(/\s*\n\s*/g, " ").replace(/'/g, "'\\''")}'`;

const handle = async (state, message) => {
  const text = message.text.trim();
  // A reply goes where the message was: in its thread if it came in one, at
  // the top level otherwise. Top-level replies are watched as threads by post.
  const thread = message.thread_ts ?? null;
  if (thread) watchThread(state, thread);
  const reply = (body, options) => post(state, `🤖 ${body}`, thread ?? undefined, options);
  // How long the message waited to be read, the number to watch for speed.
  const waited = ((Date.now() - Number(message.ts) * 1000) / 1000).toFixed(1);
  log(`← ${message.thread_ts ? "thread" : "DM"} (${waited}s after sending): ${text.slice(0, 80)}`);

  // Sent while the relay wasn't running: typing it into a tab now could be long
  // after the moment it was meant for, so it is answered rather than acted on.
  if (!message.fresh && Number(message.ts) * 1000 < startedAt - 60_000) {
    return reply("I missed this while I wasn't running, so I didn't act on it. Send it again if you still want it.");
  }

  // A reply under a tab alert is for that tab.
  const alert = message.thread_ts && state.alerts[message.thread_ts];
  if (alert && /^esc$/i.test(text)) return interrupt(state, { id: alert.window, index: alert.index, name: alert.name }, reply);
  if (alert && /^progress$/i.test(text)) return progress(state, { id: alert.window, index: alert.index, name: alert.name }, reply, message.ts);
  if (alert && /^diff$/i.test(text)) return diff(state, { id: alert.window, index: alert.index, name: alert.name }, reply, message.ts);
  if (alert) return toTab(state, thread, message.request ?? message.ts, { id: alert.window, index: alert.index, name: alert.name }, text, reply);

  if (/^stop$/i.test(text)) {
    await reply("Stopped listening.");
    await stopRelay(state);
    return;
  }

  if (/^(status|\?)$/i.test(text)) {
    const tabs = claudeTabs();
    const words = { waiting: "*waiting on you*", done: "finished", working: "working", idle: "idle" };
    return reply(
      tabs.length
        ? `Status\n${tabs.map((t) => `• Tab ${t.index}, ${t.name}: ${words[t.state] ?? t.state}`).join("\n")}`
        : "No Claude tabs are open.",
    );
  }

  if (/^progress(\s+all)?$/i.test(text)) return fleet(state, reply, message.ts);

  const asked = text.match(/^(progress|diff)\s+(\d+|[A-Za-z][A-Za-z0-9]*-\d+)$/i);
  if (asked) {
    const { tab, error } = resolveTarget(asked[2]);
    if (error) return reply(error);
    return (asked[1].toLowerCase() === "diff" ? diff : progress)(state, tab, reply, message.ts);
  }

  const escape = text.match(/^esc\s+(\d+|[A-Za-z][A-Za-z0-9]*-\d+)$/i);
  if (escape) {
    const { tab, error } = resolveTarget(escape[1]);
    return error ? reply(error) : interrupt(state, tab, reply);
  }

  const targeted = text.match(/^(\d+|[A-Za-z][A-Za-z0-9]*-\d+)\s*:\s*([\s\S]*)$/);
  if (targeted) {
    const { tab, error } = resolveTarget(targeted[1]);
    if (error) return reply(error);
    // `3: ?` answers where it was asked. A request is a conversation with the
    // tab: sent from a thread, it stays there; sent at the top level, it goes
    // on in the tab's home thread, and the main DM gets the "Sent to" line.
    const request = targeted[2].trim();
    if (request === "?" || request === "") return toTab(state, thread, message.ts, tab, request, reply);
    const conversation = thread ?? (await homeOf(state, tab)) ?? message.ts;
    watchThread(state, conversation);
    const broadcast = !thread && conversation !== message.ts;
    return toTab(state, conversation, message.ts, tab, request, (body, options) => post(state, `🤖 ${body}`, conversation, { broadcast, ...options }));
  }

  // New work has to be asked for by name: a new tab running Claude with the
  // prompt, in the directory the relay was started from, or the place named
  // before the colon (a path, a repository, or a worktree's branch; see
  // places.js). The reply says where, so a wrong match is plain. Replies
  // under the confirmation go to that tab.
  const fresh = text.match(/^new(?:\s+([^:\n]+?))?\s*:\s*([\s\S]+)$/i);
  if (fresh) {
    const place = fresh[1] ? resolvePlace(fresh[1].trim()) : { dir: process.cwd(), said: `\`${shortPath(process.cwd())}\`` };
    if (place.error) return reply(place.error);
    const window = tmux(["new-window", "-d", "-c", place.dir, "-P", "-F", "#{window_id}\t#{window_index}"]);
    const [windowId, index] = window.split("\t");
    tmux(["send-keys", "-t", windowId, "-l", "--", `claude ${shellQuote(fresh[2].trim())}`]);
    tmux(["send-keys", "-t", windowId, "Enter"]);
    log(`new: tab ${index} in ${place.dir}`);
    const ts = await reply(`Started a new Claude in tab ${index}, in ${place.said}. This is its thread: reply here, or \`${index}: …\`, to talk to it.`);
    state.alerts[ts] = { window: windowId, index: Number(index), name: "new Claude" };
    // Started from the top level, this message is the new tab's home.
    const pid = tryTmux(["list-panes", "-t", windowId, "-F", "#{pane_pid}"])?.split("\n")[0];
    if (!thread && pid) (state.homes ??= {})[windowId] = { ts, pid };
    return ts;
  }

  // Anything else is not acted on: a typo such as "l: yes" or "1 yes" must not
  // start work or reach a tab by accident. Say what was understood instead.
  const tabs = claudeTabs();
  return reply(
    (thread ? "This thread isn't linked to a tab, so I didn't send that anywhere. " : "I didn't recognise that, so I didn't act on it. ") +
      "Start a message with a tab number or ticket (`3: …`), `new: …` (or `new <repo, ticket or ~/path>: …`) for a new Claude, `progress 3` for what a tab is doing (`progress all` for every tab), `diff 3` for its changes, `esc 3` to interrupt a tab, `?` or `status`, or `stop`." +
      (tabs.length ? `\nTabs: ${tabs.map((t) => `${t.index} ${t.name}`).join(", ")}` : ""),
  );
};

// Presses Escape in a tab, which stops Claude mid-turn, or answers "no" to a
// prompt it is waiting on. Only then: in an idle Claude, Escape does nothing
// useful, and a second one opens the rewind menu. The tab is no longer
// followed, since an interrupted turn may never report that it ended; the
// reply is linked to the tab, so `?` under it shows where it stopped.
const interrupt = async (state, tab, reply) => {
  const name = label(tab);
  const { pane, error } = claudePane(tab.id);
  if (error) return reply(error);
  const current = claudeTabs().find((t) => t.id === tab.id);
  if (current?.state !== "working" && current?.state !== "waiting") {
    return reply(`${name} isn't in the middle of anything, so I didn't press Escape.`);
  }
  tmux(["send-keys", "-t", pane, "Escape"]);
  delete state.following[tab.id];
  log(`⎋ ${name}`);
  const ts = await reply(`Pressed Escape in ${name}. \`?\` here shows where it stopped.`);
  state.alerts[ts] = { window: tab.id, index: tab.index, name: tab.name };
  return ts;
};

// `request` is your message, which gets 👀 once the tab's Claude takes it
// (see followUps).
const toTab = async (state, thread, request, tab, text, reply) => {
  const name = label(tab);
  if (text === "?" || text === "") {
    return reply(`Last turn in ${name}:\n${lastTurn(tab.id)}`, { title: `Last turn in ${name}` });
  }
  const { pane, error } = claudePane(tab.id);
  if (error) return reply(error);
  const before = screen(tab.id);
  const current = claudeTabs().find((t) => t.id === tab.id);
  // A tab showing numbered choices gets just the chosen number, which picks it
  // at once. An Enter after it would land on whatever comes next, and if that
  // is another prompt, accept its first option.
  const choice = current?.state === "waiting" ? chosenOption(optionsIn(before), text) : undefined;
  if (choice) {
    tmux(["send-keys", "-t", pane, "-l", "--", String(choice.n)]);
    log(`→ ${name}: chose ${choice.n}. ${choice.label}`);
    // The turn carries on, so it is followed as the prompt it belongs to.
    const file = transcriptFor(tab.id);
    const prompt = (file && lastPrompt(file)?.prompt) || text;
    const target = { window: tab.id, index: tab.index, name: tab.name, thread: thread ?? undefined };
    if (thread) state.alerts[thread] = target;
    state.following[tab.id] = {
      thread, index: tab.index, name: tab.name, text: prompt, request,
      sentAt: Date.now(), screen: before, changedAt: 0, taken: true, warned: false,
    };
    const ts = await reply(`Chose ${choice.n}. ${choice.label} in ${name}. I'll tell you when it's done.`);
    state.alerts[ts] = target;
    return ts;
  }
  // A dialog before the session starts is answered with the arrow keys:
  // up or down to the chosen option, then Enter.
  const dialog = dialogIn(before);
  const picked = dialog && chosenOption(dialog, text);
  if (picked) {
    const moves = picked.n - dialog.cursor;
    Array.from({ length: Math.abs(moves) }).forEach(() => tmux(["send-keys", "-t", pane, moves > 0 ? "Down" : "Up"]));
    tmux(["send-keys", "-t", pane, "Enter"]);
    log(`→ ${name}: chose "${picked.label}" in a dialog`);
    const target = { window: tab.id, index: tab.index, name: tab.name, thread: thread ?? undefined };
    if (thread) state.alerts[thread] = target;
    const ts = await reply(`Chose "${picked.label}" in ${name}.`);
    state.alerts[ts] = target;
    return ts;
  }
  // Typed while Claude is mid-turn, the message waits in Claude Code's queue
  // until the turn ends.
  const busy = current?.state === "working";
  typeInto(pane, text);
  log(`→ ${name}: ${text.slice(0, 80)}`);
  // The conversation now belongs to the tab: replies in the thread it came
  // from, or under this confirmation, go there, and when the tab is done the
  // result is posted in the same place (see followUps).
  const target = { window: tab.id, index: tab.index, name: tab.name, thread: thread ?? undefined };
  if (thread) state.alerts[thread] = target;
  state.following[tab.id] = {
    thread, index: tab.index, name: tab.name, text, request,
    sentAt: Date.now(), screen: before, changedAt: 0, taken: false, warned: false,
  };
  const ts = await reply(
    busy
      ? `Sent to ${name}. It's in the middle of a turn, so Claude Code has queued it. I'll react 👀 when Claude takes it, and tell you when it's done.`
      : `Sent to ${name}. I'll react 👀 when Claude takes it, and tell you when it's done.`,
  );
  state.alerts[ts] = target;
  return ts;
};

module.exports = { shellQuote, handle, interrupt, toTab };
