// Part of bin/slack-relay; see the comment at the top of that file.

const { log, tryTmux } = require("./util");
const { post, update } = require("./post");
const { saveState } = require("./state");
const { headerButtons, deleteThreadButton } = require("./buttons");
const { paneFor } = require("./tabs");

// ── Home threads ────────────────────────────────────────────────────────────

// Each Claude tab has one thread in the DM, its home: its alerts, answers and
// milestones go there, and whatever you reply there is typed into it. The main
// DM only gets one-line notices, posted in the home thread and also sent to
// the conversation (Slack's "also send to channel"), so tapping one opens
// the thread. A home is started the first time there's
// something to say about a tab. It belongs to the window, checked by the
// window's first process, since tmux reuses window IDs after a restart; a
// tab that has closed has none, and its news goes to the top level.
const homing = new Map();
// The first message of a tab's thread, its header: the tab's name, what it is
// doing and since when, and buttons for what you'd ask of it (see
// refreshHomes). Slack's list of threads shows it, so that list shows every
// tab's state.
const HEADER_WORDS = { waiting: "🔴 **Waiting on you**", done: "✅ Finished", working: "🔵 Working", idle: "⚪ Idle" };
const when = (seconds) => {
  const date = new Date(Number(seconds) * 1000);
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return date.toDateString() === new Date().toDateString() ? time : `${date.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
};
const homeText = (tab) =>
  `🤖 **Tab ${tab.index}, ${tab.name}**\n${HEADER_WORDS[tab.state] ?? tab.state ?? ""}${tab.since && /^\d+$/.test(String(tab.since)) ? ` since ${when(tab.since)}` : ""}\n\n` +
  "This is its thread: everything about it goes here, and what you reply here is typed into it.";
const closedText = (home) => `🤖 ~~Tab ${home.label}~~\n⚫ Closed at ${when(Date.now() / 1000)}. Its Claude session has ended.`;
const homeOf = (state, tab) => {
  // Its Claude pane's process, as claudeTabs reports it.
  const pid = tryTmux(["display-message", "-p", "-t", paneFor(tab.id), "#{pane_pid}"]);
  if (!pid) return Promise.resolve(undefined);
  const home = state.homes?.[tab.id];
  if (home && home.pid === pid && state.threads[home.ts] !== undefined) return Promise.resolve(home.ts);
  // One home per tab, however many messages ask for it at once.
  if (!homing.has(tab.id)) {
    const making = (async () => {
      const ts = await post(state, homeText(tab), undefined, { buttons: headerButtons(tab) });
      (state.homes ??= {})[tab.id] = { ts, pid, label: `${tab.index}, ${tab.name}`, shown: headerKey(tab) };
      state.alerts[ts] = { window: tab.id, index: tab.index, name: tab.name };
      saveState(state);
      return ts;
    })().finally(() => homing.delete(tab.id));
    homing.set(tab.id, making);
  }
  return homing.get(tab.id);
};

const isHome = (state, ts) => Object.values(state.homes ?? {}).some((home) => home.ts === ts);

// A tab's thread, if it has one yet.
const homeThread = (state, tab) => {
  const home = state.homes?.[tab.id];
  return home && state.threads[home.ts] !== undefined ? home.ts : undefined;
};

// A link that opens a thread in the DM at its newest message, built the way
// Slack builds a reply's link: the workspace's address, the DM, the message's
// ts without its dot, and the thread it is in. The thread's own first message
// when nothing newer is known. Plain text when the workspace's address isn't.
const threadUrl = (state, ts) => {
  if (!state.dm?.url) return undefined;
  const at = state.latest?.[ts] ?? ts;
  return `${state.dm.url}archives/${state.dm.channel}/p${at.replace(".", "")}?thread_ts=${ts}&cid=${state.dm.channel}`;
};
const threadLink = (state, ts, text) => (threadUrl(state, ts) ? `[${text}](${threadUrl(state, ts)})` : text);

// A tab renamed (a ticket's title arrived, or you named it with M-n),
// renumbered, or in a new state gets its thread's header edited to match, so
// the thread is easy to find in Slack's list of threads and that list shows
// how each tab stands. A header whose session has ended, because its window
// closed or now runs another session, says so and loses its buttons.
const headerKey = (tab) => `${tab.index}|${tab.name}|${tab.state}|${tab.since ?? ""}`;
// A closed tab's thread is recorded as one the relay may delete (see
// cleanup.js), and its header offers to.
const closeHome = async (state, id) => {
  const home = state.homes?.[id];
  if (!home) return;
  delete state.homes[id];
  (state.closedHomes ??= {})[home.ts] = { label: home.label, at: Date.now() };
  saveState(state);
  await update(state, home.ts, closedText(home), [deleteThreadButton(home.ts)]).catch((err) => log(`marking a thread closed failed: ${err.message}`));
};
const refreshHomes = async (state, tabs) => {
  for (const tab of tabs) {
    const home = state.homes?.[tab.id];
    if (!home || state.threads[home.ts] === undefined) continue;
    if (!(tab.pids ?? [String(tab.pid ?? "")]).includes(home.pid)) {
      await closeHome(state, tab.id);
      continue;
    }
    if (home.shown === headerKey(tab)) continue;
    home.label = `${tab.index}, ${tab.name}`;
    home.shown = headerKey(tab);
    await update(state, home.ts, homeText(tab), headerButtons(tab)).catch((err) => log(`updating tab ${tab.index}'s thread header failed: ${err.message}`));
    saveState(state);
  }
};
const renameHomes = refreshHomes;

module.exports = { HEADER_WORDS, homeText, closedText, headerKey, closeHome, refreshHomes, renameHomes, homing, homeOf, isHome, homeThread, threadUrl, threadLink };
