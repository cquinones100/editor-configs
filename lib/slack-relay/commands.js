// Part of bin/slack-relay; see the comment at the top of that file.

const { execFileSync } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");
const { log, tmux, tryTmux } = require("./util");
const { post, react, offerChoice, settleChoice } = require("./post");
const { watchThread } = require("./state");
const { CLAUDE_PANE, claudeTabs, label, STATE_WORDS, table, relative, claudePane, transcriptFor, lastTurn, lastPrompt, screen, optionsIn, promptText, promptHash, answerFor, answerSaid, answerPrompt, screenAfter, chosenOption, dialogIn, typeInto } = require("./tabs");
const { progress, fleet } = require("./summaries");
const { homeOf, homeThread, threadLink } = require("./homes");
const { startedAt, stopRelay } = require("./lifecycle");
const { resolvePlace, shortPath } = require("./places");
const { download } = require("./files");
const { pickerButtons, optionButtons, dialogButtons } = require("./buttons");
const { closedThreads, cleanupButton } = require("./cleanup");

// ── Handling messages ───────────────────────────────────────────────────────

// What the relay understands, for `help`.
const HELP =
  "**What I understand**\n" +
  "- a reply in a tab's thread: typed into that tab\n" +
  "- in a tab's thread, `progress`, `esc`, `rename <name>` (`rename` alone clears it): just for that tab\n" +
  "- the Home tab: every tab, and Open for one's screen, to message, answer, stop, rename or close it\n" +
  "- `new: …`: a new Claude tab, or `new <repo, ticket or ~/path>: …` to pick where\n" +
  "- `progress`: what every tab is doing\n" +
  "- `cleanup`: delete the threads of closed tabs (asks first)\n" +
  "- `status` or `?`: every tab\n" +
  "- `threads`: each tab's thread\n" +
  "- `help`: this list\n" +
  "- `stop`: end the relay";

const shellQuote = (text) => `'${text.replace(/\s*\n\s*/g, " ").replace(/'/g, "'\\''")}'`;

const handle = async (state, message) => {
  let text = message.text.trim();
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

  // Images you attached are downloaded and named at the end of the message,
  // as paths Claude Code can read, and a video by its path and then its
  // stills; a file that can't be passed on is said so.
  for (const file of message.files ?? []) {
    const got = await download(file).catch((err) => ({ error: `I couldn't download ${file.name ?? "that file"}: ${err.message}` }));
    if (got.error) await reply(got.error);
    else if (!got.frames) text = `${text}${text ? " " : ""}[Image: ${got.path}]`;
    else {
      text = `${text}${text ? " " : ""}[Video: ${got.path}]`;
      if (got.frames.length) text += ` Stills from it, in order: ${got.frames.map((frame) => `[Image: ${frame}]`).join(" ")}`;
      else await reply(`I couldn't take stills from ${file.name ?? "that video"}, so the tab gets only its path.`);
    }
  }
  if (!text) return;

  // A reply under a tab alert is for that tab.
  const alert = message.thread_ts && state.alerts[message.thread_ts];
  if (alert && /^esc$/i.test(text)) return interrupt(state, { id: alert.window, index: alert.index, name: alert.name }, reply);
  if (alert && /^progress$/i.test(text)) return progress(state, { id: alert.window, index: alert.index, name: alert.name }, reply, message.ts);
  const renaming = alert && text.match(/^rename(?:\s+([\s\S]+))?$/i);
  if (renaming) return renameTab({ id: alert.window, index: alert.index, name: alert.name }, renaming[1], reply);
  if (alert) return toTab(state, thread, message.request ?? message.ts, { id: alert.window, index: alert.index, name: alert.name }, text, reply);

  if (/^stop$/i.test(text)) {
    await reply("**Stopped listening.**");
    await stopRelay(state);
    return;
  }

  if (/^help$/i.test(text)) return reply(HELP);

  // Deleting can't be undone, so the command only offers the button, which
  // Slack confirms.
  if (/^clean ?up$/i.test(text)) {
    const count = closedThreads(state).length;
    if (!count) return reply("No closed tabs have threads left to delete.");
    return reply(`**${count} closed tab${count === 1 ? " has" : "s have"} a thread.** Delete them? Your own replies in them stay.`, { buttons: [cleanupButton(count)] });
  }

  if (/^(status|\?)$/i.test(text)) {
    const tabs = claudeTabs();
    if (!tabs.length) return reply("**Status**\n\nNo Claude tabs are open.");
    const since = (t) => (t.since ? relative(Date.now() - Number(t.since) * 1000).replace(/ ago$/, "") : "");
    const thread = (t) => (homeThread(state, t) ? threadLink(state, homeThread(state, t), "open") : "—");
    return reply(`**Status**\n\n${table(["Tab", "Name", "State", "For", "Thread"], tabs.map((t) => [`**${t.index}**`, t.name, STATE_WORDS[t.state] ?? t.state, since(t), thread(t)]))}`);
  }

  // Each tab's thread, to find a conversation again: a table like status's,
  // and a note on starting one where there's none.
  if (/^threads$/i.test(text)) {
    const tabs = claudeTabs();
    if (!tabs.length) return reply("**Threads**\n\nNo Claude tabs are open.");
    const rows = tabs.map((t) => [`**${t.index}**`, t.name, STATE_WORDS[t.state] ?? t.state, homeThread(state, t) ? threadLink(state, homeThread(state, t), "open") : "—"]);
    const without = tabs.filter((t) => !homeThread(state, t));
    return reply(
      `**Threads**\n\n${table(["Tab", "Name", "State", "Thread"], rows)}` +
        (without.length ? `\n\n_No thread yet for ${without.map((t) => `tab ${t.index}`).join(", ")}: open it on the Home tab and send it a Message to start one._` : ""),
    );
  }

  if (/^progress(\s+all)?$/i.test(text)) return fleet(state, reply, message.ts);

  // Tabs are never named in a message (no `3: …`): a message reaches a tab
  // only as a reply in its thread, or through a button or a form made for it
  // (see forTab).

  // New work has to be asked for by name: a new tab running Claude with the
  // prompt, in the directory the relay was started from, or the place named
  // before the colon (a path, a repository, or a worktree's branch; see
  // places.js). The reply says where, so a wrong match is plain. Replies
  // under the confirmation go to that tab.
  const fresh = text.match(/^new(?:\s+([^:\n]+?))?\s*:\s*([\s\S]+)$/i);
  if (fresh) {
    const place = fresh[1] ? resolvePlace(fresh[1].trim()) : { dir: process.cwd(), said: `\`${shortPath(process.cwd())}\`` };
    if (place.error) return reply(place.error);
    const window = tmux(["new-window", "-d", "-c", place.dir, "-P", "-F", "#{window_id}\t#{window_index}\t#{pane_id}"]);
    const [windowId, index, pane] = window.split("\t");
    // The pane Claude starts in is the tab's, whatever is opened beside it later.
    tmux(["set-option", "-w", "-t", windowId, CLAUDE_PANE, pane]);
    tmux(["send-keys", "-t", windowId, "-l", "--", `claude ${shellQuote(fresh[2].trim())}`]);
    tmux(["send-keys", "-t", windowId, "Enter"]);
    log(`new: tab ${index} in ${place.dir}`);
    const ts = await reply(`Started a new Claude in tab ${index}, in ${place.said}. This is its thread: reply here to talk to it.`);
    state.alerts[ts] = { window: windowId, index: Number(index), name: "new Claude" };
    // Started from the top level, this message is the new tab's home.
    const pid = tryTmux(["list-panes", "-t", windowId, "-F", "#{pane_pid}"])?.split("\n")[0];
    if (!thread && pid) (state.homes ??= {})[windowId] = { ts, pid };
    return ts;
  }

  // Anything else is not acted on: a message at the top level must not start
  // work or reach a tab by accident. With tabs open, a button per tab offers
  // to send it to one; tapping it is the choice of tab.
  const tabs = claudeTabs();
  if (!tabs.length) return reply(`I didn't recognise that, so **I didn't act on it**, and no Claude tabs are open.\n\n${HELP}`);
  return reply(
    (thread ? "This thread isn't linked to a tab." : "That doesn't name a tab or a command.") +
      " **Send it to a tab?**\n\n_`help` lists what I understand._",
    { buttons: pickerButtons(tabs, { ts: message.ts, text, thread_ts: thread }) },
  );
};

// A message for a tab already chosen: by a button or a form made for it, or
// the picker's tab button. It goes straight to that tab, never through a
// thread's link to one, which another message may have repointed. A request
// is a conversation with the tab: sent from a thread, it stays there; sent at
// the top level, it goes on in the tab's home thread, and its answer is also
// sent to the main DM. `?` (or nothing) answers where it was asked.
const forTab = async (state, tab, { thread, request, text }) => {
  const here = thread ?? undefined;
  if (text === "?" || text === "") return toTab(state, thread, request, tab, text, (body, options) => post(state, `🤖 ${body}`, here, options));
  const conversation = thread ?? (await homeOf(state, tab)) ?? request;
  watchThread(state, conversation);
  const broadcast = !thread && conversation !== request;
  return toTab(state, conversation, request, tab, text, (body, options) => post(state, `🤖 ${body}`, conversation, { broadcast, ...options }), { broadcast });
};

// Names a tab, as M-p's "Rename the tab" does: the window's @tab_name, which the tab bar, the
// second status line and the tab's thread (see renameHomes) all show. No name
// clears it, so the tab goes back to its ticket's or directory's name. Then
// the tabs are renamed at once rather than on the next pane focus.
const renameTab = async (tab, name, reply) => {
  const newName = String(name ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
  if (newName) tmux(["set-option", "-w", "-t", tab.id, "@tab_name", newName]);
  else tmux(["set-option", "-wu", "-t", tab.id, "@tab_name"]);
  const session = tryTmux(["display-message", "-p", "-t", tab.id, "#{session_name}"]);
  if (session) {
    try {
      execFileSync(path.join(os.homedir(), ".config/tmux/window-names.sh"), [session], { stdio: "ignore", timeout: 10_000 });
    } catch {}
  }
  log(`renamed tab ${tab.index} to ${newName || "its own name"}`);
  return reply(newName ? `Renamed **tab ${tab.index}** to **${newName}**.` : `**Tab ${tab.index}** has its own name again.`);
};

// Closes a tab's window, ending its Claude session, and says so in its thread
// (or the main DM if it has none). Its thread and alerts are forgotten with
// the window (see alertTabs).
const closeTab = async (state, tab) => {
  tmux(["kill-window", "-t", tab.id]);
  log(`closed ${label(tab)}`);
  delete state.following[tab.id];
  const home = state.homes?.[tab.id]?.ts;
  await post(state, `🤖 Closed **${label(tab)}**.`, home);
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
const toTab = async (state, thread, request, tab, text, reply, { broadcast = false } = {}) => {
  const name = label(tab);
  if (text === "?" || text === "") {
    return reply(`Last turn in ${name}:\n${lastTurn(tab.id)}`, { title: `Last turn in ${name}` });
  }
  const { pane, error } = claudePane(tab.id);
  if (error) return reply(error);
  const before = screen(tab.id);
  const current = claudeTabs().find((t) => t.id === tab.id);
  // A tab showing numbered choices gets just the keys for your answer (see
  // answerPrompt): an option's number picks it at once, and an Enter after it
  // would land on whatever comes next, and if that is another prompt, accept
  // its first option.
  const prompt = current?.state === "waiting" ? optionsIn(before) : undefined;
  const answer = prompt && answerFor(prompt, text);
  if (answer) {
    answerPrompt(pane, prompt, answer);
    const did = answerSaid(answer);
    log(`→ ${name}: ${did}`);
    await settleChoice(state, tab.id, `${did}.`);
    const target = { window: tab.id, index: tab.index, name: tab.name, thread: thread ?? undefined };
    if (thread) state.alerts[thread] = target;
    // Claude Code may still be asking, in the same wait: the next of several
    // questions, the one you ticked an option in, or the review of your
    // answers. No hook says so, so it is posted here, with its buttons.
    const after = await screenAfter(tab.id, before);
    const now = claudeTabs().find((t) => t.id === tab.id);
    const sameWait = now?.state === "waiting" && String(now.since ?? "") === String(current.since ?? "");
    const next = sameWait ? optionsIn(after) : undefined;
    // The same prompt still up after a pick that takes one answer only means
    // Claude Code hasn't drawn what comes next yet.
    if (next && (prompt.multi || promptHash(next) !== promptHash(prompt))) {
      const moved = next.question !== prompt.question;
      const body = `${did} in ${name}.${moved ? " It's asking next:" : ""}\n\n${promptText(next)}`;
      const ts = await reply(body, { buttons: optionButtons(now, next) });
      state.alerts[ts] = target;
      offerChoice(state, tab.id, "wait", ts, `🤖 ${body}`);
      return ts;
    }
    // The turn carries on, so it is followed as the prompt it belongs to.
    const file = transcriptFor(tab.id);
    const asked = (file && lastPrompt(file)?.prompt) || text;
    state.following[tab.id] = {
      thread, index: tab.index, name: tab.name, text: asked, request,
      sentAt: Date.now(), screen: before, changedAt: 0, taken: true, warned: false,
    };
    const ts = await reply(`${did} in ${name}. I'll tell you when it's done.`);
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
    await settleChoice(state, tab.id, `Answered: ${picked.label}`);
    const ts = await reply(`Chose "${picked.label}" in ${name}.`);
    state.alerts[ts] = target;
    return ts;
  }
  // Anything else typed at a choice would be followed by Enter, which accepts
  // whichever option is selected: "cancel" would approve the command. So while
  // a waiting tab shows numbered options, or a dialog is up, only an answer
  // that names an option goes through.
  const options = prompt;
  // The refusal carries the choice's buttons, so the answer is a tap away.
  if (options || dialog) {
    const shown = options ? promptText(options) : `${dialog.options.map((o) => `${o.n}. ${o.label}`).join("\n")}\n_Tap one, or reply with its number or the start of it._`;
    const body = `${name} is showing a choice, and that isn't one of its options, so I didn't type anything.\n\n${shown}`;
    const ts = await reply(body, { buttons: options ? optionButtons(current, options) : dialogButtons(current ?? tab, dialog) });
    offerChoice(state, tab.id, options ? "wait" : "dialog", ts, `🤖 ${body}`);
    return ts;
  }
  // Typed while Claude is mid-turn, the message waits in Claude Code's queue
  // until the turn ends.
  const busy = current?.state === "working";
  typeInto(pane, text);
  log(`→ ${name}: ${text.slice(0, 80)}`);
  // The conversation now belongs to the tab: replies in the thread it came
  // from go there, and when the tab is done the result is posted in the same
  // place (see followUps). Nothing is posted: your message's reaction says
  // where it is (⏳ queued, 👀 taken, ✅ answered).
  const target = { window: tab.id, index: tab.index, name: tab.name, thread: thread ?? undefined };
  if (thread) state.alerts[thread] = target;
  state.following[tab.id] = {
    thread, index: tab.index, name: tab.name, text, request, broadcast,
    sentAt: Date.now(), screen: before, changedAt: 0, taken: false, warned: false,
  };
  // Queued behind a turn: ⏳ on your message until Claude takes it.
  if (busy) await react(state, request, "hourglass_flowing_sand").catch((err) => log(`⏳ failed: ${err.message}`));
  return undefined;
};

module.exports = { forTab, HELP, shellQuote, renameTab, closeTab, handle, interrupt, toTab };
