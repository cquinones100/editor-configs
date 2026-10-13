// Part of bin/slack-relay; see the comment at the top of that file.

const path = require("node:path");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const { LOG_FILE, MAX_LOG_BYTES, EVENTS_FILE, TAB_POLL_MS, READ_STAGGER_MS, QUIET_AFTER_MS, QUIET_STAGGER_MS, WIDE_POLL_MS } = require("./config");
const { privateFile, log, DONT_RESTART, fail, tryTmux } = require("./util");
const { dmOnly, SEND, findDm, SlackSession, slack, slackSessions, usageReport } = require("./slack");
const { fetchMessages } = require("./read");
const { slackName, post } = require("./post");
const { loadState, saveState } = require("./state");
const { handle } = require("./commands");
const { DASHBOARD_MS, dashboardTitle, refreshDashboard } = require("./dashboard");
const { stuckTabs } = require("./stuck");
const { followUps } = require("./followups");
const { milestones, CI_POLL_MS, ciTick } = require("./milestones");
const { answerReactions } = require("./reactions");
const { alertTabs } = require("./alerts");
const { life, stopRelay, takeLock, ownerOnly } = require("./lifecycle");

// Handles what a check found: each message once (`handled`), however many
// overlapping checks saw it, in ts order, one at a time (`handling`), and
// each answer by reaction after them. The cursor and threads advance past
// everything seen, the relay's own posts included, before anything is acted
// on, so a failure in one message doesn't replay the rest. `settled` is the
// work queued so far, for the tests to wait on.
const dispatcher = (state) => {
  const handled = new Set();
  let handling = Promise.resolve();
  const processMessages = (messages, reactions = []) => {
    const fresh = messages
      .filter((m) => !handled.has(m.ts))
      .sort((a, b) => Number(a.ts) - Number(b.ts));
    fresh.forEach((m) => handled.add(m.ts));
    // Only overlapping checks can repeat a message, so recent ones are enough.
    [...handled].slice(0, Math.max(0, handled.size - 500)).forEach((ts) => handled.delete(ts));
    // Advance past everything seen, ours included, before acting, so a
    // failure in one message does not replay the rest.
    fresh.forEach((m) => {
      if (m.thread_ts && state.threads[m.thread_ts] !== undefined) {
        if (Number(m.ts) > Number(state.threads[m.thread_ts])) state.threads[m.thread_ts] = m.ts;
      } else if (!m.thread_ts && Number(m.ts) > Number(state.cursor)) {
        state.cursor = m.ts;
      }
    });
    const mine = fresh.filter((m) => !m.byClaude);
    if (mine.length) state.lastActivity = Date.now();
    saveState(state);
    mine.forEach((message) => {
      handling = handling.then(async () => {
        try {
          await handle(state, message);
        } catch (err) {
          log(`failed: ${err.message}`);
          await post(state, `🤖 That failed: ${err.message}`, message.thread_ts ?? undefined).catch(() => {});
        }
        saveState(state);
      });
    });
    const answers = answerReactions(state, reactions);
    if (answers.length) {
      state.lastActivity = Date.now();
      saveState(state);
    }
    answers.forEach((answer) => {
      handling = handling.then(async () => {
        await answer().catch((err) => log(`reaction failed: ${err.message}`));
        saveState(state);
      });
    });
  };
  return { processMessages, settled: () => handling };
};

// The relay itself, run by supervise as a child process.
const relay = async () => {
  if (!process.env.TMUX) fail("not inside tmux; use `slack-relay` to start it in its own tab", DONT_RESTART);
  // A crash is logged, and the exit tells supervise to start it again.
  process.on("uncaughtException", (err) => fail(`crashed: ${err.stack?.split("\n").slice(0, 2).join(" ") ?? err}`));
  process.on("unhandledRejection", (err) => fail(`crashed: ${err?.stack?.split("\n").slice(0, 2).join(" ") ?? err}`));
  ownerOnly();
  takeLock();
  // After a crash, why, from supervise; empty on a normal start.
  const restarted = process.env.SLACK_RELAY_RESTARTED ?? "";
  // Turn the hooks on: they write events only while this file exists. One
  // left by a crashed relay is kept, so no turn that ended meanwhile is lost.
  const keptEvents = fs.existsSync(EVENTS_FILE);
  if (!keptEvents) privateFile(EVENTS_FILE, "");
  // Mark this window as the relay's, so `slack-relay` finds it whatever the
  // tab ends up named, and the relay never reports on itself.
  if (process.env.TMUX_PANE) tryTmux(["set-option", "-w", "-t", process.env.TMUX_PANE, "@slack_relay", "1"]);

  // Awake while the relay runs, and no longer: -w ends it with this process.
  life.caffeinate = spawn("caffeinate", ["-dis", "-w", String(process.pid)], { stdio: "ignore" });

  const state = { threads: {}, alerts: {}, reported: {}, following: {}, answerable: {}, reactedTo: {}, ci: {}, homes: {}, lastPost: {}, ...loadState() };
  // Left by earlier versions: links the parked-job lookup replaced.
  delete state.transcripts;
  // When you last wrote, for the quick checks' pace: a fresh start counts as
  // now, so the relay is quick while you check it came up.
  state.lastActivity = Date.now();
  if (!keptEvents || state.eventsOffset === undefined) state.eventsOffset = 0;
  process.on("SIGTERM", () => stopRelay(state, "🤖 Stopped listening."));
  // Closing the relay's tab sends SIGHUP; that is a stop too, not a crash.
  // The tab's terminal is gone by then, so writing to it must not crash.
  process.stdout.on("error", () => {});
  process.stderr.on("error", () => {});
  process.on("SIGINT", () => stopRelay(state, "🤖 Stopped listening."));
  process.on("SIGHUP", () => stopRelay(state, "🤖 Stopped listening."));
  log("finding your DM…");
  state.dm = state.dm ?? (await findDm());
  slackSessions(state.dm);
  log(`DM ${state.dm.channel}`);
  if (!state.dm.name) {
    state.dm.name = await slackName().catch((err) => log(`couldn't read your Slack name: ${err.message}`));
    saveState(state);
  }
  // The dashboard exists before the start message, which links it.
  await refreshDashboard(state, { quick: true }).catch((err) => log(`dashboard failed: ${err.message}`));

  // Start from now: earlier messages were already handled, or were not meant
  // for the relay. Tabs already waiting are reported straight away. After a
  // crash, carry on from where the last run got to instead, so a message sent
  // during the restart is still answered.
  const kickoff = await post(
    state,
    restarted
      ? `🤖 Relay restarted after a crash (${restarted}). Still listening.`
      : "🤖 Relay listening.\n" +
          "• Each tab has its own thread here, where its alerts, answers and progress go; reply there to talk to it\n" +
          "• `3: <text>` or `ABC-214: <text>`: type into that tab's Claude\n" +
          "• `3: ?`: show that tab's screen\n" +
          "• `status`: every Claude tab and its state\n" +
          "• `new: <prompt>`: start a new Claude tab with it; `new myapp: …`, `new ABC-214: …` or `new ~/code: …` starts it in that repository, worktree or directory\n" +
          "• `progress 3`, or `progress` under an alert: what that tab is doing, without disturbing it; `progress all`: every tab\n" +
          "• `diff 3`, or `diff` under an alert: that tab's branch and changes, the whole diff in a canvas\n" +
          "• `esc 3`, or `esc` under an alert: press Escape in that tab to stop Claude\n" +
          "• On a tab waiting on you: reply with an option's number, or react :+1: for 1, :raised_hand: for Escape, :repeat: for \"continue\"\n" +
          "• `stop`: end" +
          (state.dashboard ? `\nEvery tab, kept up to date: <${state.dashboard.url}|${dashboardTitle(state)}>` : ""),
  );
  state.cursor = restarted && state.cursor ? state.cursor : kickoff;
  saveState(state);
  log("listening; Ctrl-C or `stop` in the DM to end");

  // Tabs: every TAB_POLL_MS, and whenever a hook writes an event, one pass at
  // a time; a pass asked for while one runs runs right after it.
  let tabsBusy = false;
  let tabsAgain = false;
  const tabTick = async () => {
    if (life.stopping || life.leaving) return;
    if (tabsBusy) {
      tabsAgain = true;
      return;
    }
    tabsBusy = true;
    try {
      await followUps(state);
      await alertTabs(state);
      await milestones(state);
      await stuckTabs(state);
    } catch (err) {
      log(`tab check failed: ${err.message}`);
    } finally {
      tabsBusy = false;
    }
    if (tabsAgain) {
      tabsAgain = false;
      tabTick();
    }
  };

  // Slack: a quick check starts every READ_STAGGER_MS on whichever quick
  // reader is free, so a new message waits about a second before a read
  // starts, or every QUIET_STAGGER_MS once you've been quiet for
  // QUIET_AFTER_MS; the wide reader reads wide every WIDE_POLL_MS (see
  // fetchMessages).
  // Overlapping checks see some messages twice, so each message is handled
  // once (`handled`), and in ts order, one at a time (`handling`).
  const { processMessages } = dispatcher(state);
  const busy = new Set();
  let lastStart = 0;
  let lastWide = 0;
  const check = (reader, wide) => {
    busy.add(reader);
    fetchMessages(state, { wide, reader })
      .then(({ messages, reactions }) => processMessages(messages, reactions))
      .catch((err) => log(`${reader.label}: poll failed: ${err.message}`))
      .finally(() => busy.delete(reader));
  };
  const slackTick = () => {
    if (life.stopping || life.leaving) return;
    if (!busy.has(slack.wideReader) && Date.now() - lastWide >= WIDE_POLL_MS) {
      lastWide = Date.now();
      check(slack.wideReader, true);
    }
    const quiet = Date.now() - state.lastActivity > QUIET_AFTER_MS;
    if (Date.now() - lastStart < (quiet ? QUIET_STAGGER_MS : READ_STAGGER_MS)) return;
    const reader = slack.readers.find((r) => !busy.has(r));
    if (!reader) return;
    lastStart = Date.now();
    check(reader, false);
  };

  // A heartbeat that notices the Mac has slept: the relay is frozen while
  // it sleeps (caffeinate stops idle sleep on mains power, not standby or a
  // closed lid), so a gap between beats is how long it was out. Everything
  // that judges by how long nothing has happened (stuck tabs) waits a while
  // after waking, since nothing could happen while it slept.
  let beat = Date.now();
  setInterval(() => {
    const now = Date.now();
    if (now - beat > SLEEP_GAP_MS) {
      life.wokeAt = now;
      log(`woke after ${Math.round((now - beat) / 60_000)}m asleep`);
    }
    beat = now;
  }, 1_000);
  // What the Slack sessions cost, in the log every USAGE_REPORT_MS.
  setInterval(() => log(usageReport(USAGE_REPORT_MS / 60_000)), USAGE_REPORT_MS);
  setInterval(tabTick, TAB_POLL_MS);
  setInterval(slackTick, 200);
  let ciBusy = false;
  setInterval(() => {
    if (ciBusy || life.stopping) return;
    ciBusy = true;
    ciTick(state)
      .catch((err) => log(`CI check failed: ${err.message}`))
      .finally(() => (ciBusy = false));
  }, CI_POLL_MS);
  let dashboardBusy = false;
  setInterval(() => {
    if (dashboardBusy || life.stopping || life.leaving) return;
    dashboardBusy = true;
    refreshDashboard(state)
      .catch((err) => log(`dashboard failed: ${err.message}`))
      .finally(() => (dashboardBusy = false));
  }, DASHBOARD_MS);
  // A hook's event (a prompt taken, a turn ended) is acted on as it lands.
  try {
    fs.watch(EVENTS_FILE, () => tabTick());
  } catch (err) {
    log(`not watching the events file: ${err.message}`);
  }
  tabTick();
  slackTick();
};

// Keeps the relay running: runs it as a child process and starts it again
// when it crashes, saying so in the DM (the new run posts that). A crash is
// anything but a clean exit: stop, Ctrl-C and closing the tab end it for good.
// After MAX_CRASHES crashes within CRASH_WINDOW_MS it gives up and posts that
// the relay is down. Waits grow between restarts, so a relay that can't
// reach Slack doesn't spin. It can't speak for itself if it is killed too.
const MAX_CRASHES = 5;
const CRASH_WINDOW_MS = 10 * 60_000;
const RESTART_DELAYS_MS = [2_000, 10_000, 30_000, 60_000, 120_000];

// The reason for the last crash, from the log the relay wrote it to.
const lastError = (since) => {
  try {
    return fs.readFileSync(LOG_FILE, "utf8")
      .split("\n")
      .filter((line) => Date.parse(line.split(" ")[0]) >= since && line.includes(" Error: "))
      .at(-1)
      ?.replace(/^\S+ Error: (crashed: )?/, "")
      .slice(0, 300);
  } catch {
    return undefined;
  }
};

const sayDown = async (why) => {
  const state = loadState();
  if (!state.dm) return;
  slack.poster = new SlackSession("poster", [SEND], dmOnly(state.dm));
  try {
    await post(
      { ...state, threads: {}, alerts: {} },
      `🤖 Relay down: it crashed ${MAX_CRASHES} times in ten minutes, most recently with: ${why}. It needs starting again from the computer.`,
    );
  } catch (err) {
    log(`could not say the relay is down: ${err.message}`);
  } finally {
    slack.poster.stop();
  }
};

const supervise = async () => {
  if (!process.env.TMUX) fail("not inside tmux; use `slack-relay` to start it in its own tab");
  ownerOnly();
  try {
    if (fs.statSync(LOG_FILE).size > MAX_LOG_BYTES) fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
  } catch {}
  let child;
  // Closing the tab or a kill ends the relay with it, or, between restarts,
  // ends the wait. Ctrl-C reaches the relay directly, and it stops cleanly.
  ["SIGTERM", "SIGHUP"].forEach((signal) =>
    process.on(signal, () => (child?.exitCode === null && child.signalCode === null ? child.kill(signal) : process.exit(0))),
  );
  process.on("SIGINT", () => {});
  process.exit(await watch({ started: (running) => (child = running) }));
};

// The restart loop: runs `command` (the relay) until it ends on purpose, and
// resolves with the code to exit with. After a crash it waits the next of
// `delays` and starts it again, telling it why (SLACK_RELAY_RESTARTED), and
// after MAX_CRASHES within CRASH_WINDOW_MS it calls `down` with the reason
// and gives up. `started` is told each new child, for signals to reach it.
const watch = async ({ command = [ENTRY, "relay"], delays = RESTART_DELAYS_MS, down = sayDown, started = () => {} } = {}) => {
  const crashes = [];
  let restarted = "";
  for (;;) {
    const since = Date.now();
    const child = spawn(process.execPath, command, {
      stdio: "inherit",
      env: { ...process.env, SLACK_RELAY_RESTARTED: restarted },
    });
    started(child);
    const { code, signal } = await new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
    if (code === 0 || code === DONT_RESTART || ["SIGTERM", "SIGINT", "SIGHUP"].includes(signal)) return code ?? 0;
    const why = lastError(since) ?? (signal ? `killed by ${signal}` : `exit code ${code}`);
    crashes.push(Date.now());
    while (crashes[0] < Date.now() - CRASH_WINDOW_MS) crashes.shift();
    if (crashes.length >= MAX_CRASHES) {
      log(`relay crashed ${crashes.length} times in ten minutes; giving up`);
      await down(why);
      // Nothing will read the hooks' events now.
      try {
        fs.unlinkSync(EVENTS_FILE);
      } catch {}
      return 1;
    }
    const delay = delays[crashes.length - 1];
    log(`relay crashed (${why}); restarting in ${delay / 1000}s`);
    restarted = why;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
};

// The relay is restarted through the command, not this file.
const ENTRY = path.join(__dirname, "../../bin/slack-relay");

const USAGE_REPORT_MS = 5 * 60_000;

// A gap this long between one-second beats means the Mac was asleep.
const SLEEP_GAP_MS = 30_000;

module.exports = { dispatcher, relay, MAX_CRASHES, CRASH_WINDOW_MS, RESTART_DELAYS_MS, lastError, sayDown, supervise, watch };
