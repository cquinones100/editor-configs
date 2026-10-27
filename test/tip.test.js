// Tests for tmux/tip.sh, the corner tips. Run with: node --test test/*.test.js
//
// A throwaway tmux server, with no client, and a temporary HOME, so no tip is
// ever drawn on your screen and your own record of shown tips is untouched.

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tip-")));
const socket = path.join(tmp, "tmux.sock");
execFileSync("tmux", ["-S", socket, "-f", "/dev/null", "new-session", "-d", "-s", "tips", "cat"]);
const serverPid = execFileSync("tmux", ["-S", socket, "display", "-p", "#{pid}"], { encoding: "utf8" }).trim();
const env = { ...process.env, HOME: tmp, TMUX: `${socket},${serverPid},0` };
after(() => {
  execFileSync("tmux", ["-S", socket, "kill-server"]);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("a tip is marked shown in its file and as a tmux option, load brings the marks back, and reset clears them", () => {
  const tip = (...args) => execFileSync("bash", [path.join(__dirname, "../tmux/tip.sh"), ...args], { env, encoding: "utf8" });
  const option = (name) => execFileSync("tmux", ["-S", socket, "show", "-gqv", name], { encoding: "utf8" }).trim();
  const file = path.join(tmp, ".local/state/editor-configs/tips");

  // No client to show it on: nothing is drawn, and it isn't counted as shown.
  tip("show", "waiting");
  assert.equal(fs.existsSync(file), false);

  tip("seen", "waiting");
  tip("seen", "waiting");
  assert.equal(fs.readFileSync(file, "utf8"), "waiting\n");
  assert.equal(option("@tip_seen_waiting"), "1");

  execFileSync("tmux", ["-S", socket, "set", "-gu", "@tip_seen_waiting"]);
  tip("load");
  assert.equal(option("@tip_seen_waiting"), "1", "a new tmux server learns what was shown");

  tip("reset");
  assert.equal(fs.existsSync(file), false);
  assert.equal(option("@tip_seen_waiting"), "");
});
