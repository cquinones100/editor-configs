// Tests for tmux/repo-update.sh, which offers new commits on GitHub to
// ~/editor-configs. Run with: node --test test/*.test.js
//
// A throwaway "remote" (a bare repository) and clones of it, in a temporary
// directory with a temporary HOME and no tmux, so nothing touches your own
// repository, tmux or state.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const script = path.join(__dirname, "../tmux/repo-update.sh");

test("the update prompt fast-forwards main on yes, leaves it on no, and refuses when main has commits of its own", () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "repo-update-test-")));
  const repo = path.join(tmp, "editor-configs");
  const env = { ...process.env, HOME: tmp, EDITOR_CONFIGS_DIR: repo, TMUX: "", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" };
  const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  const prompt = (answer) => spawnSync("bash", [script, "prompt"], { env, input: answer, encoding: "utf8" });
  try {
    const origin = path.join(tmp, "origin.git");
    const other = path.join(tmp, "other");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin], { env });
    execFileSync("git", ["clone", "-q", origin, repo], { env, stdio: "ignore" });
    git(repo, "commit", "-q", "--allow-empty", "-m", "start");
    git(repo, "push", "-q", "origin", "main");
    execFileSync("git", ["clone", "-q", origin, other], { env, stdio: "ignore" });
    git(other, "commit", "-q", "--allow-empty", "-m", "Show the new thing");
    git(other, "push", "-q", "origin", "main");
    const theirs = git(other, "rev-parse", "HEAD");
    const mine = git(repo, "rev-parse", "HEAD");
    git(repo, "fetch", "-q", "origin");

    const declined = prompt("n");
    assert.match(declined.stdout, /1 new commit on GitHub:\s+Show the new thing/);
    assert.equal(git(repo, "rev-parse", "main"), mine, "no leaves main where it was");

    const accepted = prompt("y");
    assert.match(accepted.stdout, /Updated to/, accepted.stdout + accepted.stderr);
    assert.equal(git(repo, "rev-parse", "main"), theirs, "yes fast-forwards main");

    git(other, "commit", "-q", "--allow-empty", "-m", "More");
    git(other, "push", "-q", "origin", "main");
    git(repo, "commit", "-q", "--allow-empty", "-m", "Mine, not pushed");
    git(repo, "fetch", "-q", "origin");
    const diverged = prompt("y");
    assert.match(diverged.stdout, /1 commit of your own not on GitHub/);
    assert.equal(git(repo, "log", "-1", "--format=%s", "main"), "Mine, not pushed", "and main is left alone");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
