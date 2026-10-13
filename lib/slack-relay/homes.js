// Part of bin/slack-relay; see the comment at the top of that file.

const { tryTmux } = require("./util");
const { post } = require("./post");
const { saveState } = require("./state");

// ── Home threads ────────────────────────────────────────────────────────────

// Each Claude tab has one thread in the DM, its home: its alerts, answers,
// milestones and CI results go there, and whatever you reply there is typed
// into it. The main DM only gets one-line notices, posted in the home thread
// and also sent to the conversation (Slack's "also send to channel"), so
// tapping one opens the thread. A home is started the first time there's
// something to say about a tab. It belongs to the window, checked by the
// window's first process, since tmux reuses window IDs after a restart; a
// tab that has closed has none, and its news goes to the top level.
const homing = new Map();
const homeOf = (state, tab) => {
  const pid = tryTmux(["list-panes", "-t", tab.id, "-F", "#{pane_pid}"])?.split("\n")[0];
  if (!pid) return Promise.resolve(undefined);
  const home = state.homes?.[tab.id];
  if (home && home.pid === pid && state.threads[home.ts] !== undefined) return Promise.resolve(home.ts);
  // One home per tab, however many messages ask for it at once.
  if (!homing.has(tab.id)) {
    const making = (async () => {
      const ts = await post(
        state,
        `🤖 Tab ${tab.index}, ${tab.name}. This is its thread: everything about it goes here, and what you reply here is typed into it.`,
      );
      (state.homes ??= {})[tab.id] = { ts, pid };
      state.alerts[ts] = { window: tab.id, index: tab.index, name: tab.name };
      saveState(state);
      return ts;
    })().finally(() => homing.delete(tab.id));
    homing.set(tab.id, making);
  }
  return homing.get(tab.id);
};

const isHome = (state, ts) => Object.values(state.homes ?? {}).some((home) => home.ts === ts);

module.exports = { homing, homeOf, isHome };
