// Part of bin/slack-relay; see the comment at the top of that file.

const { execFile } = require("node:child_process");
const { log } = require("./util");

// ── Whether you're at the computer ──────────────────────────────────────────

// macOS keeps the time since the last keyboard or mouse input (HIDIdleTime,
// in nanoseconds, on IOHIDSystem), which ioreg reads without any permission.
// You count as away once nothing has been typed or clicked for AWAY_AFTER_MS,
// which is also true of a locked screen. It is read every CHECK_MS, in the
// background, so asking costs nothing.
const AWAY_AFTER_MS = 30_000;
const CHECK_MS = 5_000;

const readIdleMs = () =>
  new Promise((resolve) => {
    execFile("ioreg", ["-c", "IOHIDSystem", "-d", "4"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }, (err, out) => {
      const ns = out?.match(/"HIDIdleTime" = (\d+)/)?.[1];
      resolve(err || !ns ? undefined : Number(ns) / 1e6);
    });
  });

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

// The tests set `idleMs` and `readIdle`; the relay keeps `idleMs` current
// with `watch`. Until the first reading, you count as at the computer.
const presence = {
  idleMs: 0,
  slackUntil: 0,
  held: [],
  flushing: undefined,
  readIdle: readIdleMs,
  away: () => presence.idleMs >= AWAY_AFTER_MS || Date.now() < presence.slackUntil,
  deliver: async (send) => {
    if (presence.away()) return send();
    presence.held.push(send);
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
    presence.slackUntil = Date.now() + SLACK_AWAY_MS;
    await presence.flush();
  },
  watch: () => {
    const check = async () => {
      const idle = await presence.readIdle();
      if (idle !== undefined) presence.idleMs = idle;
      if (presence.away()) await presence.flush();
    };
    check();
    return setInterval(check, CHECK_MS);
  },
};

module.exports = { AWAY_AFTER_MS, CHECK_MS, SLACK_AWAY_MS, TYPED_HERE_MS, readIdleMs, presence };
