// Whether you're at the Mac, the one way everything here tells: the Slack
// relay (lib/slack-relay/presence.js), to hold its notices while you're at
// the computer, and the sidebar daemon, to pause its lookups while you're
// away. Each decides how long idle counts as away for it; what idle is, is
// decided here.
//
// macOS keeps the time since the last keyboard or mouse input (HIDIdleTime, in
// nanoseconds, on IOHIDSystem), and marks the console session locked
// (CGSSessionScreenIsLocked on the IORegistry's root) while the lock screen is
// up; ioreg reads both without any permission. A locked screen is away at
// once, however recently a key was pressed.

const { execFile } = require("node:child_process");

const ioreg = (args) =>
  new Promise((resolve) =>
    execFile("ioreg", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }, (err, out) => resolve(err ? undefined : out)),
  );

// Milliseconds since the last input, or undefined when it can't be read.
const readIdleMs = async () => {
  const ns = (await ioreg(["-c", "IOHIDSystem", "-d", "4"]))?.match(/"HIDIdleTime" = (\d+)/)?.[1];
  return ns ? Number(ns) / 1e6 : undefined;
};

// Whether the lock screen is up, or undefined when it can't be read.
const readLocked = async () => {
  const out = await ioreg(["-n", "Root", "-d", "1"]);
  return out === undefined ? undefined : /"CGSSessionScreenIsLocked"\s*=\s*Yes/.test(out);
};

// Both at once: { idleMs, locked }, either undefined when unknown.
const readPresence = async () => {
  const [idleMs, locked] = await Promise.all([readIdleMs(), readLocked()]);
  return { idleMs, locked };
};

// Away, by a reading and how long idle counts as away for the one asking.
const awayBy = ({ idleMs, locked }, afterMs) => locked === true || (idleMs ?? 0) >= afterMs;

module.exports = { readIdleMs, readLocked, readPresence, awayBy };
