// Part of bin/slack-relay; see the comment at the top of that file.

const { log } = require("./util");
const { post, update, settleChoice } = require("./post");
const { saveState } = require("./state");
const { claudeTabs, label } = require("./tabs");
const { picks, stillShowing, WELCOME_COMMANDS } = require("./buttons");
const { handle, closeTab, forTab, interrupt } = require("./commands");
const { progress } = require("./summaries");
const { stillAsking } = require("./quickreplies");
const { refreshDashboard } = require("./dashboard");
const { closedThreads, deleteThreads, cleanupNote } = require("./cleanup");
const { handleScreenPress } = require("./screens");

// ── Button presses ──────────────────────────────────────────────────────────

// Acts on a press of one of the relay's buttons (see buttons.js), as the
// reply it stands for would be acted on. A choice is pressed only if the tab
// is still showing the very prompt the button was made for; then the
// message's buttons are replaced by what was chosen, so it can't be pressed
// twice.
const handlePress = async (state, { value, message, view, triggerId }) => {
  if (value.a === "refresh") return refreshDashboard(state, { opened: true });
  // Deleting closed tabs' threads: one from its header, or all of them. Only
  // threads recorded as closed are touched (see cleanup.js).
  if (value.a === "delete-thread" || value.a === "cleanup") {
    const result = await deleteThreads(state, value.a === "cleanup" ? closedThreads(state) : [value.t]);
    if (value.a === "cleanup" || result.yours) await post(state, `🤖 ${cleanupNote(result)}`);
    return refreshDashboard(state, { quick: true, opened: true });
  }
  // A command button on the welcome message, answered at the top level as if
  // you had typed it there.
  if (value.a === "do") {
    if (!WELCOME_COMMANDS.includes(value.c) || !message) return undefined;
    return handle(state, { ts: message.ts, text: value.c, thread_ts: null, fresh: true });
  }
  // The Home tab's Open and New tab, the buttons on the screens they open,
  // and Skill under a finished turn, which opens a screen of its own.
  if (value.a === "open" || value.a === "new" || value.a === "skill" || value.a === "skill-chosen" || value.a === "rename" || value.a.startsWith("screen-") || value.a.startsWith("home-")) {
    return handleScreenPress(state, { value, view, triggerId, thread: message ? message.thread_ts ?? message.ts : undefined });
  }
  // A press on the Home tab has no message, only a value (see pressFrom).
  const thread = message ? message.thread_ts ?? message.ts : undefined;
  const tab = claudeTabs().find((t) => t.id === value.w);
  const target = tab && { window: tab.id, index: tab.index, name: tab.name, thread };
  // What a button made for a tab says goes to that tab: the one the button
  // names, not whichever tab the thread was last linked to.
  const as = (text) => forTab(state, tab, { thread, request: message.ts, text });
  const reply = (body, options) => post(state, `🤖 ${body}`, thread, options);
  log(`pressed ${value.a} ${value.n ?? value.c ?? ""} for ${value.w}`);

  if (value.a === "opt" || value.a === "dialog") {
    const option = stillShowing(value)?.option;
    if (!option) return post(state, "🤖 That choice isn't showing any more, so I didn't press anything.", thread);
    state.alerts[thread] ??= target;
    // The other messages showing this prompt lose their buttons; this one is
    // edited below to say what was chosen.
    await settleChoice(state, tab.id, `Answered: ${option.said}`, message.ts);
    await update(state, message.ts, `${message.text}\n\n_Chose **${option.said}**._`).catch((err) => log(`couldn't update the pressed message: ${err.message}`));
    await as(option.answer);
    return saveState(state);
  }

  // Progress and Stop, for the tab the button was made for.
  if (value.a === "cmd") {
    if (!tab) return post(state, "🤖 That tab is closed.", thread);
    state.alerts[thread] ??= target;
    if (value.c === "progress") return progress(state, tab, reply, message.ts);
    if (value.c === "esc") return interrupt(state, tab, reply);
    return as(value.c);
  }

  // A quick reply under a finished turn, typed in as your reply, while it is
  // still the answer to what Claude said last.
  if (value.a === "reply") {
    if (!tab) return post(state, "🤖 That tab is closed.", thread);
    if (!stillAsking(tab, value.k)) return post(state, "🤖 Claude has said more since, so that reply is out of date. I didn't type it.", thread);
    state.alerts[thread] ??= target;
    await update(state, message.ts, `${message.text}\n\n_Replied **${value.t}**._`).catch((err) => log(`couldn't update the pressed message: ${err.message}`));
    return as(value.t);
  }

  // Only the very tab the button was drawn for: same window, same process.
  if (value.a === "close") {
    if (!tab || !tab.pids.includes(value.p)) return post(state, "🤖 That tab has already closed.", thread);
    await closeTab(state, tab);
    if (message) await update(state, message.ts, `🤖 Closed **${label(tab)}**.`).catch((err) => log(`couldn't update the close message: ${err.message}`));
    await refreshDashboard(state, { quick: true, opened: true }).catch((err) => log(`Home tab failed: ${err.message}`));
    return saveState(state);
  }

  if (value.a === "to") {
    const pick = picks.get(value.p);
    if (!pick) return post(state, "🤖 I no longer have that message. Send it again, as a reply in the tab's thread.", thread);
    if (!tab) return post(state, "🤖 That tab is closed.", thread);
    picks.delete(value.p);
    await update(state, message.ts, `🤖 Sent to **${label(tab)}**.`).catch((err) => log(`couldn't update the picker: ${err.message}`));
    return forTab(state, tab, { thread: pick.thread_ts ?? null, request: pick.ts, text: pick.text });
  }
  return undefined;
};

module.exports = { handlePress };
