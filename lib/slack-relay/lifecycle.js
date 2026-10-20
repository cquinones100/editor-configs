// Part of bin/slack-relay; see the comment at the top of that file.

const fs = require("node:fs");
const { STATE_DIR, STATE_FILE, LOG_FILE, EVENTS_FILE, LOCK_FILE } = require("./config");
const { privateFile, log, DONT_RESTART, fail } = require("./util");
const { update } = require("./post");
const { refreshDashboard } = require("./dashboard");
const { cancelOfflineNote } = require("./offline");

// What the relay is doing as a whole: stopping, leaving (stopping on purpose,
// with a last post and dashboard update first), its caffeinate process, and
// its connection to Slack.
// `wokeAt` is when the Mac last woke from sleep (see run.js's heartbeat).
const life = { stopping: false, leaving: false, caffeinate: undefined, socket: undefined, wokeAt: 0 };

// ── Run ─────────────────────────────────────────────────────────────────────

const startedAt = Date.now();
// Stopping on purpose (`stop`, Ctrl-C, closing the tab, `slack-relay stop`):
// the welcome message is edited to say it stopped, and when, rather than a new
// message posted (a restart edits it back; see sayListening), and the
// dashboard is marked out of date, giving both STOP_GRACE_MS, then shuts down.
const STOP_GRACE_MS = 15_000;
const clock = (ms = Date.now()) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const stoppedText = () => `🤖 **Relay stopped** at ${clock()}. Start it again at the computer with \`slack-relay\` or M-S.`;
const stopRelay = async (state) => {
  if (life.leaving) return;
  life.leaving = true;
  log("stopping");
  // The Home tab says it stopped, and the offline note is cancelled: you know.
  const last = [
    ...(state.dm && state.welcome ? [update(state, state.welcome, stoppedText()).catch((err) => log(`couldn't mark the welcome stopped: ${err.message}`))] : []),
    ...(state.dm ? [refreshDashboard(state, { quick: true, stopped: true }), cancelOfflineNote(state)] : []),
  ];
  await Promise.race([Promise.allSettled(last), new Promise((resolve) => setTimeout(resolve, STOP_GRACE_MS))]);
  shutdown();
};

const shutdown = () => {
  if (life.stopping) return;
  life.stopping = true;
  life.caffeinate?.kill();
  life.socket?.close();
  try {
    fs.unlinkSync(EVENTS_FILE);
  } catch {}
  try {
    if (fs.readFileSync(LOCK_FILE, "utf8").split(" ")[0] === String(process.pid)) fs.unlinkSync(LOCK_FILE);
  } catch {}
  log("stopped");
  process.exit(0);
};

const takeLock = () => {
  try {
    const [pid, who] = fs.readFileSync(LOCK_FILE, "utf8").trim().split(" ");
    if (Number(pid) !== process.pid) {
      process.kill(Number(pid), 0);
      fail(`another listener is running (process ${pid}, ${who}); stop it first`, DONT_RESTART);
    }
  } catch (err) {
    if (err.code !== "ESRCH" && err.code !== "ENOENT") throw err;
  }
  privateFile(LOCK_FILE, `${process.pid} slack-relay\n`);
};

const ownerOnly = () => {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(STATE_DIR, 0o700);
  [STATE_FILE, LOG_FILE, EVENTS_FILE].forEach((file) => {
    try {
      fs.chmodSync(file, 0o600);
    } catch {}
  });
};

module.exports = { life, startedAt, STOP_GRACE_MS, clock, stoppedText, stopRelay, shutdown, takeLock, ownerOnly };
