// Part of bin/slack-relay; see the comment at the top of that file.

const fs = require("node:fs");
const { WINDOW_NAME, LOCK_FILE } = require("./config");
const { fail, tmux, tryTmux } = require("./util");

// ── Commands ────────────────────────────────────────────────────────────────

// The relay marks its own window with @slack_relay rather than relying on the
// window's name, which window-names.sh rewrites from the tab label.
const relayWindow = () =>
  tryTmux(["list-windows", "-a", "-F", "#{window_id}\t#{@slack_relay}"])
    ?.split("\n")
    .map((line) => line.split("\t"))
    .find(([, marked]) => marked === "1")?.[0];

// Whether a relay holds the lock and its process is alive.
const running = () => {
  try {
    process.kill(Number(fs.readFileSync(LOCK_FILE, "utf8").split(" ")[0]), 0);
    return true;
  } catch {
    return false;
  }
};

// An interactive zsh, so ~/.zshrc puts node and claude on the PATH, and the
// tab is left at a shell if the relay stops.
const RUN = "zsh -i -c 'slack-relay run; exec zsh -i'";

// Goes to the relay's tab. A tab left at a shell by a relay that stopped is
// reused, with the relay started in it again. `run` is what the tab runs;
// the tests give it a stand-in. Outside tmux (a Claude job, ssh, cron), the
// running tmux server is used, and the new tab goes in its most recently
// used session; with no server running there is nowhere to put it.
const start = (run = RUN) => {
  if (!process.env.TMUX && tryTmux(["list-sessions"]) === undefined) fail("no tmux server is running; start tmux first");
  const existing = relayWindow();
  if (existing && !running()) tmux(["respawn-pane", "-k", "-t", existing, run]);
  if (existing) {
    tmux(["select-window", "-t", existing]);
    return;
  }
  const window = tmux(["new-window", "-n", WINDOW_NAME, "-P", "-F", "#{window_id}", run]);
  tmux(["set-option", "-w", "-t", window, "@tab_name", "Slack relay"]);
};

const stop = () => {
  const pid = Number(fs.existsSync(LOCK_FILE) ? fs.readFileSync(LOCK_FILE, "utf8").split(" ")[0] : 0);
  if (!pid) fail("the relay is not running");
  try {
    process.kill(pid, "SIGTERM");
    console.log(`Stopping the relay (process ${pid}).`);
  } catch {
    fail(`no process ${pid}; the lock is stale`);
  }
};

module.exports = { relayWindow, running, RUN, start, stop };
