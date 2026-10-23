// Tests for tmux/health.sh, the status line's health light. Run with:
// node --test test/*.test.js
//
// It runs against a throwaway tmux server and a temporary HOME, so it never
// reads your tmux, your sidebar daemon or your relay.

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "health-")));
const home = path.join(tmp, "home");
const socket = path.join(tmp, "tmux.sock");
fs.mkdirSync(path.join(home, ".local/state/tmux-sidebar"), { recursive: true });
fs.mkdirSync(path.join(home, ".local/state/slack-relay"), { recursive: true });
execFileSync("tmux", ["-S", socket, "-f", "/dev/null", "new-session", "-d", "-s", "health", "cat"]);
const tmux = (...args) => execFileSync("tmux", ["-S", socket, ...args], { encoding: "utf8" }).trimEnd();
const serverPid = tmux("display", "-p", "#{pid}");
after(() => {
  tmux("kill-server");
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("the light is dark while all is well, and names each thing that quietly stopped", () => {
  const light = () =>
    execFileSync("bash", [path.join(__dirname, "../tmux/health.sh")], {
      encoding: "utf8",
      env: { ...process.env, HOME: home, TMUX: `${socket},${serverPid},0` },
    });
  const sidebarLock = path.join(home, ".local/state/tmux-sidebar/daemon.pid");
  const relayLock = path.join(home, ".local/state/slack-relay/relay.lock");
  const events = path.join(home, ".local/state/slack-relay/events.jsonl");
  const now = Math.floor(Date.now() / 1000);

  // All well: a save a minute ago, the sidebar daemon (this test's process) running, the relay stopped on purpose.
  tmux("set", "-g", "@continuum-save-last-timestamp", String(now - 60));
  fs.writeFileSync(sidebarLock, String(process.pid));
  assert.equal(light(), "");

  // Saves stopped twelve minutes ago.
  tmux("set", "-g", "@continuum-save-last-timestamp", String(now - 12 * 60));
  assert.equal(light(), "#[fg=colour196,bold] ● saves 12m old #[default]");
  tmux("set", "-g", "@continuum-save-last-timestamp", String(now));

  // The sidebar daemon gone, and the relay crashed (its events file left behind).
  fs.writeFileSync(sidebarLock, "999999");
  fs.writeFileSync(events, "");
  fs.writeFileSync(relayLock, "999999 slack-relay");
  assert.equal(light(), "#[fg=colour196,bold] ● sidebar down, relay down #[default]");

  // The sidebar turned off isn't down; the relay running isn't either.
  tmux("set", "-g", "@sidebar_on", "off");
  fs.writeFileSync(relayLock, `${process.pid} slack-relay`);
  assert.equal(light(), "");
});
