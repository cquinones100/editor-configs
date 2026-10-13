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

const start = () => {
  if (!process.env.TMUX) fail("not inside tmux; start it from a tmux tab");
  const existing = relayWindow();
  if (existing) {
    tmux(["select-window", "-t", existing]);
    return;
  }
  // An interactive zsh, so ~/.zshrc puts node and claude on the PATH, and the
  // tab is left at a shell if the relay stops.
  const window = tmux(["new-window", "-n", WINDOW_NAME, "-P", "-F", "#{window_id}", "zsh -i -c 'slack-relay run; exec zsh -i'"]);
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

module.exports = { relayWindow, start, stop };
