// Part of bin/slack-relay; see the comment at the top of that file.

const fs = require("node:fs");
const { STATE_FILE, THREAD_WINDOW_MS, MAX_THREADS } = require("./config");
const { privateFile } = require("./util");

// ── State ───────────────────────────────────────────────────────────────────

const loadState = () => {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
};

const saveState = (state) => {
  privateFile(`${STATE_FILE}.tmp`, JSON.stringify(state, null, 2));
  fs.renameSync(`${STATE_FILE}.tmp`, STATE_FILE);
};

const watchThread = (state, ts) => {
  state.threads[ts] = state.threads[ts] ?? ts;
  const cutoff = Date.now() / 1000 - THREAD_WINDOW_MS / 1000;
  // A tab's home thread is watched for as long as the tab is open.
  const homes = Object.values(state.homes ?? {}).map((home) => home.ts);
  const kept = [
    ...Object.keys(state.threads)
      .filter((t) => Number(t) >= cutoff && !homes.includes(t))
      .sort((a, b) => Number(b) - Number(a))
      .slice(0, MAX_THREADS),
    ...homes.filter((t) => state.threads[t] !== undefined),
  ];
  state.threads = Object.fromEntries(kept.map((t) => [t, state.threads[t]]));
  if (state.latest) state.latest = Object.fromEntries(Object.entries(state.latest).filter(([t]) => kept.includes(t)));
  // Alerts posted in a thread live as long as their thread.
  state.alerts = Object.fromEntries(Object.entries(state.alerts).filter(([t, a]) => kept.includes(t) || kept.includes(a.thread)));
};

// The newest message in a thread, yours or the relay's, so a link to the
// thread can open at its bottom (see threadLink).
const newestIn = (state, thread, ts) => {
  if (Number(ts) > Number(state.latest?.[thread] ?? 0)) (state.latest ??= {})[thread] = ts;
};

module.exports = { loadState, saveState, watchThread, newestIn };
