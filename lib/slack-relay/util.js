// Part of bin/slack-relay; see the comment at the top of that file.

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const { LOG_FILE } = require("./config");

// Everything here is the user's own: owner-only, whatever the umask.
const privateFile = (file, text, flag = "w") => fs.writeFileSync(file, text, { mode: 0o600, flag });

// To the tab and to the log file, which outlives the tab and is how a crash
// gets explained (see supervise).
const log = (...parts) => {
  console.log(new Date().toLocaleTimeString(), ...parts);
  try {
    privateFile(LOG_FILE, `${new Date().toISOString()} ${parts.join(" ")}\n`, "a");
  } catch {}
};

// An exit with DONT_RESTART is a mistake in how the relay was started (outside
// tmux, or with another listener running), which a restart would only repeat.
const DONT_RESTART = 3;
const fail = (message, code = 1) => {
  console.error(`Error: ${message}`);
  try {
    privateFile(LOG_FILE, `${new Date().toISOString()} Error: ${message}\n`, "a");
  } catch {}
  process.exit(code);
};

// tmux replaces control characters in its output, tab delimiters included,
// without a UTF-8 locale.
const tmux = (args) =>
  execFileSync("tmux", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, LC_ALL: "en_US.UTF-8" },
  }).trimEnd();

const tryTmux = (args) => {
  try {
    return tmux(args);
  } catch {
    return undefined;
  }
};

module.exports = { privateFile, log, DONT_RESTART, fail, tmux, tryTmux };
