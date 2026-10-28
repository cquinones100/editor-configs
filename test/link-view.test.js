// Tests for tmux/link-view.sh's picker. Run with: node --test test/*.test.js
//
// It reads a pane of a throwaway tmux server, whose socket is in a temporary
// directory under /tmp (a socket's path can't be over 104 bytes on macOS), and
// fzf is a stand-in that keeps what it was given and picks nothing, so nothing
// is opened.

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const tmp = fs.realpathSync(fs.mkdtempSync("/tmp/link-view-"));
const socket = path.join(tmp, "tmux.sock");
const env = { ...process.env, HOME: tmp, TMUX: "" };
after(() => {
  spawnSync("tmux", ["-S", socket, "kill-server"], { env });
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("the picker lists a pane's links newest first, a link written into text with its text", () => {
  const screen = path.join(tmp, "screen.txt");
  fs.writeFileSync(
    screen,
    [
      "See https://plain.example/one.",
      "\x1b[1mThe \x1b]8;;https://linear.app/team/issue/ABC-1\x1b\\\x1b[32mticket title\x1b[0m\x1b]8;;\x1b\\ is linked",
      "again https://plain.example/one and \x1b]8;;https://github.com/o/r/pull/2\x07the PR\x1b]8;;\x07",
      "\x1b]8;;https://same.example/x\x1b\\https://same.example/x\x1b]8;;\x1b\\",
      "",
    ].join("\n"),
  );
  execFileSync("tmux", ["-S", socket, "-f", "/dev/null", "new-session", "-d", "-x", "200", "-y", "20", `cat ${screen}; sleep 60`], { env });
  const bin = path.join(tmp, "bin");
  fs.mkdirSync(bin);
  const given = path.join(tmp, "fzf-input");
  fs.writeFileSync(path.join(bin, "fzf"), `#!/bin/sh\ncat > ${given}\nexit 1\n`, { mode: 0o755 });
  spawnSync("sleep", ["0.5"]);
  const pane = execFileSync("tmux", ["-S", socket, "display", "-p", "#{pane_id}"], { env, encoding: "utf8" }).trim();

  const run = spawnSync("bash", [path.join(__dirname, "../tmux/link-view.sh"), "pick", pane], {
    env: { ...env, TMUX: `${socket},0,0`, PATH: `${bin}:${process.env.PATH}`, LC_ALL: "en_US.UTF-8" },
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  const rows = fs.readFileSync(given, "utf8").trim().split("\n").map((row) => row.replace(/\x1b\[[0-9;]*m/g, "").split("\t"));
  assert.deepEqual(rows, [
    ["https://same.example/x", "https://same.example/x"],
    ["the PR  https://github.com/o/r/pull/2", "https://github.com/o/r/pull/2"],
    ["https://plain.example/one", "https://plain.example/one"],
    ["ticket title  https://linear.app/team/issue/ABC-1", "https://linear.app/team/issue/ABC-1"],
  ]);
});
