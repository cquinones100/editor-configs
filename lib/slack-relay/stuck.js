// Part of bin/slack-relay; see the comment at the top of that file.

const { log } = require("./util");
const { post } = require("./post");
const { saveState } = require("./state");
const { claudeTabs, label, relative, onScreen } = require("./tabs");
const { tabFacts } = require("./summaries");
const { life } = require("./lifecycle");
const { homeOf } = require("./homes");

// ── Stuck tabs ──────────────────────────────────────────────────────────────

// A tab marked working whose transcript hasn't changed for STUCK_MS may be
// stuck (or running something long, which the screen usually shows), so its
// thread gets a note with what it did last and its screen, and the main DM a
// line. Once per stall: it is noted again only after it has moved on and
// stalled anew.
const STUCK_MS = 10 * 60_000;

const stuckTabs = async (state) => {
  state.stuck ??= {};
  // Just after the Mac wakes, every working tab's transcript looks old: it
  // was asleep too. Stuck means stuck while awake.
  if (Date.now() - life.wokeAt < STUCK_MS) return;
  for (const tab of claudeTabs()) {
    if (tab.state !== "working") {
      delete state.stuck[tab.id];
      continue;
    }
    const { facts, activity, lastAt } = tabFacts(tab);
    if (!lastAt || Date.now() - lastAt < STUCK_MS || state.stuck[tab.id] === lastAt) continue;
    state.stuck[tab.id] = lastAt;
    saveState(state);
    try {
      const home = await homeOf(state, tab);
      const target = { window: tab.id, index: tab.index, name: tab.name, thread: home };
      const lastly = activity.length ? `\nWhat it did last:\n${activity.slice(-3).map((line) => `• ${line}`).join("\n")}` : "";
      const note = await post(
        state,
        `🤖 ${label(tab)} may be stuck: it's marked working, but nothing has happened for ${relative(Date.now() - lastAt).replace(/ ago$/, "")}. ${facts}.${lastly}${onScreen(tab.id, "")}\n\`esc\` here presses Escape; \`progress\` asks what it's doing.`,
        home,
      );
      const notice = await post(state, `🤖 ${label(tab)} may be stuck: nothing new for ${relative(Date.now() - lastAt).replace(/ ago$/, "")}.`, home, { broadcast: true });
      state.alerts[note] = target;
      state.alerts[notice] = target;
      log(`stuck: ${label(tab)}`);
    } catch (err) {
      log(`stuck note failed: ${err.message}`);
    }
    saveState(state);
  }
};

module.exports = { STUCK_MS, stuckTabs };
