// Tests for bin/worktree-from-branch. Run with: node --test test/*.test.js
//
// Each test builds a throwaway "remote" (a bare repository) and a clone of it
// in a temporary directory, so nothing reaches GitHub or your own repositories.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const script = path.join(__dirname, "../bin/worktree-from-branch");

test("a branch that exists nowhere is made off the remote's main as it is now, with no upstream", () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wtb-test-")));
  const env = { ...process.env, HOME: tmp, GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" };
  const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  try {
    const origin = path.join(tmp, "origin.git");
    const clone = path.join(tmp, "clone");
    const other = path.join(tmp, "other");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin], { env });
    execFileSync("git", ["clone", "-q", origin, clone], { env, stdio: "ignore" });
    git(clone, "commit", "-q", "--allow-empty", "-m", "start");
    git(clone, "push", "-q", "origin", "main");
    // main moves on the remote after this clone last fetched, and the clone
    // sits on a branch of its own.
    execFileSync("git", ["clone", "-q", origin, other], { env, stdio: "ignore" });
    git(other, "commit", "-q", "--allow-empty", "-m", "newer");
    git(other, "push", "-q", "origin", "main");
    const newest = git(other, "rev-parse", "HEAD");
    git(clone, "checkout", "-q", "-b", "elsewhere");
    git(clone, "commit", "-q", "--allow-empty", "-m", "unrelated");

    const cdFile = path.join(tmp, "cd");
    execFileSync(process.execPath, [script, "--no-claude", "--cd-file", cdFile, "feature/login"], { cwd: clone, env, stdio: ["ignore", "ignore", "pipe"] });
    const worktree = fs.readFileSync(cdFile, "utf8").trim();
    assert.equal(worktree, path.join(clone, ".claude/worktrees/feature-login"), "flat, the slash made a dash");
    assert.equal(git(worktree, "branch", "--show-current"), "feature/login");
    assert.equal(git(worktree, "rev-parse", "HEAD"), newest, "off the remote's main, fetched first");
    assert.throws(() => git(worktree, "rev-parse", "--abbrev-ref", "@{upstream}"), "with no upstream until its first push");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("a branch only the remote has is checked out tracking it, and a rerun reuses the worktree", () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wtb-test-")));
  const env = { ...process.env, HOME: tmp, GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" };
  const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  try {
    const origin = path.join(tmp, "origin.git");
    const clone = path.join(tmp, "clone");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin], { env });
    execFileSync("git", ["clone", "-q", origin, clone], { env, stdio: "ignore" });
    git(clone, "commit", "-q", "--allow-empty", "-m", "start");
    git(clone, "push", "-q", "origin", "main");
    git(clone, "checkout", "-q", "-b", "feat");
    git(clone, "commit", "-q", "--allow-empty", "-m", "feature");
    const last = git(clone, "rev-parse", "HEAD");
    git(clone, "push", "-q", "origin", "feat");
    git(clone, "checkout", "-q", "main");
    git(clone, "branch", "-q", "-D", "feat");

    const cdFile = path.join(tmp, "cd");
    execFileSync(process.execPath, [script, "--no-claude", "--cd-file", cdFile, "feat"], { cwd: clone, env, stdio: ["ignore", "ignore", "pipe"] });
    const worktree = fs.readFileSync(cdFile, "utf8").trim();
    assert.equal(git(worktree, "rev-parse", "HEAD"), last, "at the remote's branch");
    assert.equal(git(worktree, "rev-parse", "--abbrev-ref", "@{upstream}"), "origin/feat", "tracking it");

    execFileSync(process.execPath, [script, "--no-claude", "--cd-file", cdFile, "feat"], { cwd: worktree, env, stdio: ["ignore", "ignore", "pipe"] });
    assert.equal(fs.readFileSync(cdFile, "utf8").trim(), worktree, "the same worktree, from inside it");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("a branch checked out in the main clone is refused, and a name git rejects never reaches git worktree", () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wtb-test-")));
  const env = { ...process.env, HOME: tmp, GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" };
  try {
    const clone = path.join(tmp, "clone");
    execFileSync("git", ["init", "-q", "-b", "main", clone], { env });
    execFileSync("git", ["-C", clone, "commit", "-q", "--allow-empty", "-m", "start"], { env });

    assert.throws(
      () => execFileSync(process.execPath, [script, "--no-claude", "main"], { cwd: clone, env, encoding: "utf8", stdio: ["ignore", "ignore", "pipe"] }),
      (err) => err.stderr.includes("already checked out in your main clone"),
    );
    assert.throws(
      () => execFileSync(process.execPath, [script, "--no-claude", "-bad"], { cwd: clone, env, encoding: "utf8", stdio: ["ignore", "ignore", "pipe"] }),
      (err) => err.stderr.includes("not a valid branch name"),
    );
    assert.equal(fs.existsSync(path.join(clone, ".claude")), false, "no worktree made");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
