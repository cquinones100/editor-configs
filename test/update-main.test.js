// Tests for bin/update-main. Run with: node --test test/*.test.js
//
// A throwaway "remote" (a bare repository) and a clone of it with a worktree,
// in a temporary directory, so nothing touches your own repositories.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const script = path.join(__dirname, "../bin/update-main");

test("update-main fast-forwards main where it is checked out, from a worktree on another branch, and leaves a dirty checkout alone", () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "update-main-test-")));
  const env = { ...process.env, HOME: tmp, GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" };
  const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  const run = (cwd) => {
    try {
      return { out: execFileSync(process.execPath, [script], { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), code: 0 };
    } catch (err) {
      return { out: err.stderr, code: err.status };
    }
  };
  try {
    const origin = path.join(tmp, "origin.git");
    const clone = path.join(tmp, "clone");
    const other = path.join(tmp, "other");
    const worktree = path.join(tmp, "worktree");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin], { env });
    execFileSync("git", ["clone", "-q", origin, clone], { env, stdio: "ignore" });
    git(clone, "commit", "-q", "--allow-empty", "-m", "start");
    git(clone, "push", "-q", "origin", "main");
    git(clone, "remote", "set-head", "origin", "-a");
    git(clone, "worktree", "add", "-q", "-b", "feat", worktree);
    // Someone else moves origin's main on.
    execFileSync("git", ["clone", "-q", origin, other], { env, stdio: "ignore" });
    git(other, "commit", "-q", "--allow-empty", "-m", "theirs");
    git(other, "push", "-q", "origin", "main");
    const theirs = git(other, "rev-parse", "HEAD");

    const updated = run(worktree);
    assert.equal(updated.code, 0, updated.out);
    assert.equal(git(clone, "rev-parse", "main"), theirs, "main caught up in the main clone");
    assert.equal(git(worktree, "branch", "--show-current"), "feat", "and the worktree stayed on its branch");
    assert.match(run(worktree).out, /up to date/);

    git(other, "commit", "-q", "--allow-empty", "-m", "more");
    git(other, "push", "-q", "origin", "main");
    fs.writeFileSync(path.join(clone, "x"), "work in progress\n");
    git(clone, "add", "x");
    const dirty = run(worktree);
    assert.equal(dirty.code, 1);
    assert.match(dirty.out, /changes not committed, so it was left/);
    assert.equal(git(clone, "rev-parse", "main"), theirs, "left where it was");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
