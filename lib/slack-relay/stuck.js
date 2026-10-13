// Part of bin/slack-relay; see the comment at the top of that file.

const { log } = require("./util");
const { post } = require("./post");
const { saveState } = require("./state");
const { claudeTabs, label, relative, onScreen, transcriptFor, lastActivityAt } = require("./tabs");
const { tabFacts } = require("./summaries");
const { life } = require("./lifecycle");
const { homeOf } = require("./homes");
const { notify } = require("./alerts");
const { stuckButtons } = require("./buttons");

// ── Stuck tabs ──────────────────────────────────────────────────────────────

// A tab marked working whose transcript hasn't changed for STUCK_MS may be
// stuck (or running something long, which the screen usually shows), so its
// thread gets a note with what it did last and its screen, and the main DM a
// line. Once per stall: it is noted again only after it has moved on and
// stalled anew. The quiet is counted from the later of its last activity and
// when it was marked working: the prompt hook marks a tab working a moment
// before Claude Code writes the prompt to the transcript, so a tab idle for
// an hour that has just been sent a prompt would otherwise look stuck for an
// hour.
const STUCK_MS = 10 * 60_000;

const stuckTabs = async (state, tabs = claudeTabs()) => {
  state.stuck ??= {};
  // Just after the Mac wakes, every working tab's transcript looks old: it
  // was asleep too. Stuck means stuck while awake.
  if (Date.now() - life.wokeAt < STUCK_MS) return;
  for (const tab of tabs) {
    if (tab.state !== "working") {
      delete state.stuck[tab.id];
      continue;
    }
    // When it last did anything first, which is cheap (cached until the file
    // changes): reading the whole transcript, which tabFacts does, every
    // second for every working tab cost more than anything else the relay did.
    const began = Number(tab.since ?? 0) * 1000;
    const lastDone = lastActivityAt(transcriptFor(tab.id, tab.pid) ?? "");
    if (!lastDone || Date.now() - Math.max(lastDone, began) < STUCK_MS || state.stuck[tab.id] === lastDone) continue;
    const { facts, activity, lastAt } = tabFacts(tab);
    if (!lastAt || Date.now() - Math.max(lastAt, began) < STUCK_MS || state.stuck[tab.id] === lastAt) continue;
    state.stuck[tab.id] = lastAt;
    saveState(state);
    const idle = relative(Date.now() - Math.max(lastAt, began)).replace(/ ago$/, "");
    const lastly = activity.length ? `\nWhat it did last:\n${activity.slice(-3).map((line) => `• ${line}`).join("\n")}` : "";
    try {
      const home = await homeOf(state, tab);
      const target = { window: tab.id, index: tab.index, name: tab.name, thread: home };
      const note = await post(
        state,
        `🤖 ${label(tab)} may be stuck: it's marked working, but nothing has happened for ${idle}. ${facts}.${lastly}${onScreen(tab.id, "")}`,
        home,
        { buttons: stuckButtons(tab) },
      );
      state.alerts[note] = target;
      // The note is in the thread at once; the line in the main DM, which
      // notifies you, waits while you're at the computer.
      await notify(state, `🤖 ${label(tab)} may be stuck: nothing new for ${idle}.`, home, target);
      log(`stuck: ${label(tab)}`);
    } catch (err) {
      log(`stuck note failed: ${err.message}`);
    }
    saveState(state);
  }
};

module.exports = { STUCK_MS, stuckTabs };
