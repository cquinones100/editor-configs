// Part of bin/slack-relay; see the comment at the top of that file.

const { log } = require("./util");
const { post, update, settleChoice } = require("./post");
const { saveState } = require("./state");
const { claudeTabs, label } = require("./tabs");
const { picks, stillShowing, WELCOME_COMMANDS } = require("./buttons");
const { handle, closeTab } = require("./commands");
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
  if (value.a === "open" || value.a === "new" || value.a === "skill" || value.a === "rename" || value.a.startsWith("screen-") || value.a.startsWith("home-")) {
    return handleScreenPress(state, { value, view, triggerId, thread: message ? message.thread_ts ?? message.ts : undefined });
  }
  // A press on the Home tab has no message, only a value (see pressFrom).
  const thread = message ? message.thread_ts ?? message.ts : undefined;
  const tab = claudeTabs().find((t) => t.id === value.w);
  const target = tab && { window: tab.id, index: tab.index, name: tab.name, thread };
  const as = (text, extra = {}) => handle(state, { ts: message.ts, text, thread_ts: thread, fresh: true, ...extra });
  log(`pressed ${value.a} ${value.n ?? value.c ?? ""} for ${value.w}`);

  if (value.a === "opt" || value.a === "dialog") {
    const option = stillShowing(value)?.option;
    if (!option) return post(state, "🤖 That choice isn't showing any more, so I didn't press anything.", thread);
    state.alerts[thread] ??= target;
    // The other messages showing this prompt lose their buttons; this one is
    // edited below to say what was chosen.
    await settleChoice(state, tab.id, `Answered: ${value.a === "opt" ? `${option.n}. ` : ""}${option.label}`, message.ts);
    await as(String(value.n));
    await update(state, message.ts, `${message.text}\n\n_Chose **${value.a === "opt" ? `${option.n}. ` : ""}${option.label}**._`).catch((err) => log(`couldn't update the pressed message: ${err.message}`));
    return saveState(state);
  }

  if (value.a === "cmd") {
    if (!tab) return post(state, "🤖 That tab is closed.", thread);
    state.alerts[thread] ??= target;
    return as(value.c);
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
    if (!pick) return post(state, "🤖 I no longer have that message. Send it again with the tab's number in front.", thread);
    if (!tab) return post(state, "🤖 That tab is closed.", thread);
    picks.delete(value.p);
    await update(state, message.ts, `🤖 Sent to **${label(tab)}**.`).catch((err) => log(`couldn't update the picker: ${err.message}`));
    return handle(state, { ts: pick.ts, text: `${tab.index}: ${pick.text}`, thread_ts: pick.thread_ts ?? null, fresh: true });
  }
  return undefined;
};

module.exports = { handlePress };
