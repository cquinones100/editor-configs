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
  if (state.lastPost) state.lastPost = Object.fromEntries(Object.entries(state.lastPost).filter(([t]) => kept.includes(t)));
  // Alerts posted in a thread live as long as their thread, and one still
  // waiting on an answer as long as it waits.
  state.alerts = Object.fromEntries(
    Object.entries(state.alerts).filter(([t, a]) => kept.includes(t) || kept.includes(a.thread) || state.answerable?.[t]),
  );
  if (state.reactedTo) state.reactedTo = Object.fromEntries(Object.entries(state.reactedTo).filter(([t]) => state.alerts[t]));
};

module.exports = { loadState, saveState, watchThread };
