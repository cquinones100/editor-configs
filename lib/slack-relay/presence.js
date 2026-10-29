// Part of bin/slack-relay; see the comment at the top of that file.

const { log } = require("./util");
const shared = require("../presence");

// ── Whether you're at the computer ──────────────────────────────────────────

// Idle and locked as lib/presence.js reads them, as the sidebar does: you
// count as away once nothing has been typed or clicked for AWAY_AFTER_MS, or
// at once when the screen is locked. It is read every CHECK_MS, in the
// background, so asking costs nothing.
const AWAY_AFTER_MS = 30_000;
const CHECK_MS = 5_000;

const { readIdleMs } = shared;

// The lines the relay puts in the main DM on its own (a tab waiting on you, a
// dialog, a stall, a failure) are what notify you, and while you're at the
// computer tmux already shows them. So `deliver` sends one at once only when
// you're away, and otherwise holds it, in order, until you have been away
// AWAY_AFTER_MS. Everything else goes into the tabs' threads at once, so they
// are always complete (see notify), and replies to what you send from Slack
// never wait. Held lines live in memory, so a relay that stops drops them.
//
// Writing to the relay from Slack also counts as away, for SLACK_AWAY_MS from
// your latest message: you're on Slack, most likely on your phone,
// even if the Mac was touched a moment ago. Unless the Mac's keyboard or mouse
// was used within TYPED_HERE_MS of it arriving, which means you wrote it in
// Slack on the Mac itself.
const SLACK_AWAY_MS = 5 * 60_000;
const TYPED_HERE_MS = 5_000;

// The tests set `idleMs`, `locked`, `readIdle` and `readLocked`; the relay keeps them current
// with `watch`. Until the first reading, you count as at the computer.
const presence = {
  idleMs: 0,
  locked: false,
  slackUntil: 0,
  held: [],
  flushing: undefined,
  readIdle: readIdleMs,
  readLocked: shared.readLocked,
  away: () => shared.awayBy(presence, AWAY_AFTER_MS) || Date.now() < presence.slackUntil,
  deliver: async (send) => {
    if (presence.away()) return send();
    presence.held.push(send);
    log(`at the Mac: holding a notice (${presence.held.length} held)`);
  },
  // One flush at a time, so held messages go out in order.
  flush: () => {
    presence.flushing ??= (async () => {
      if (presence.held.length) log(`away: sending ${presence.held.length} held message${presence.held.length === 1 ? "" : "s"}`);
      while (presence.held.length) await presence.held.shift()().catch((err) => log(`held message failed: ${err.message}`));
    })().finally(() => (presence.flushing = undefined));
    return presence.flushing;
  },
  // A message from you in Slack has just arrived.
  fromSlack: async () => {
    const idle = await presence.readIdle();
    if (idle !== undefined && idle < TYPED_HERE_MS) return;
    if (Date.now() >= presence.slackUntil) log("away: you wrote from Slack, not the Mac");
    presence.slackUntil = Date.now() + SLACK_AWAY_MS;
    await presence.flush();
  },
  watch: () => {
    const check = async () => {
      const [idle, locked] = await Promise.all([presence.readIdle(), presence.readLocked()]);
      const was = presence.away();
      if (idle !== undefined) presence.idleMs = idle;
      if (locked !== undefined) presence.locked = locked;
      // Each change, with why, so a notice that did or didn't reach the phone
      // can be explained from the log.
      if (presence.away() !== was) {
        const why = presence.locked ? "screen locked" : `idle ${Math.round(presence.idleMs / 1000)}s`;
        log(presence.away() ? `away (${why})` : `at the Mac (${why})`);
      }
      if (presence.away()) await presence.flush();
    };
    check();
    return setInterval(check, CHECK_MS);
  },
};

module.exports = { AWAY_AFTER_MS, CHECK_MS, SLACK_AWAY_MS, TYPED_HERE_MS, readIdleMs, presence };
