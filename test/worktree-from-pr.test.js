// Tests for bin/worktree-from-pr. Run with: node --test test/*.test.js
//
// Each test builds a throwaway "remote" (a bare repository) and a clone of it
// in a temporary directory, with a stand-in gh on the PATH that answers for
// one pull request, so nothing reaches GitHub or your own repositories.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const script = path.join(__dirname, "../bin/worktree-from-pr");

test("a merged PR whose branch the remote deleted opens from the commits GitHub keeps for it", () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wtpr-test-")));
  const env = { ...process.env, HOME: tmp, GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e", PATH: `${path.join(tmp, "bin")}:${process.env.PATH}` };
  const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  try {
    const origin = path.join(tmp, "origin.git");
    const clone = path.join(tmp, "clone");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin], { env });
    execFileSync("git", ["clone", "-q", origin, clone], { env, stdio: "ignore" });
    git(clone, "commit", "-q", "--allow-empty", "-m", "start");
    git(clone, "push", "-q", "origin", "main");
    git(clone, "checkout", "-q", "-b", "feat");
    fs.writeFileSync(path.join(clone, "f.txt"), "feature\n");
    git(clone, "add", "f.txt");
    git(clone, "commit", "-q", "-m", "feature");
    const last = git(clone, "rev-parse", "HEAD");
    git(clone, "push", "-q", "origin", "feat");
    // Merged on GitHub: its commits kept under refs/pull/7/head, its branch
    // deleted, and no trace of it left in this clone.
    git(origin, "update-ref", "refs/pull/7/head", last);
    git(clone, "push", "-q", "origin", "--delete", "feat");
    git(clone, "checkout", "-q", "main");
    git(clone, "branch", "-q", "-D", "feat");
    git(clone, "fetch", "-q", "--prune");

    fs.mkdirSync(path.join(tmp, "bin"));
    fs.writeFileSync(path.join(tmp, "bin/gh"), `#!/bin/sh\necho '${JSON.stringify({ number: 7, title: "Feature", author: { login: "t" }, headRefName: "feat", isCrossRepository: false, state: "MERGED", url: "https://github.com/o/r/pull/7" })}'\n`, { mode: 0o755 });

    const cdFile = path.join(tmp, "cd");
    execFileSync(process.execPath, [script, "--no-claude", "--cd-file", cdFile, "7"], { cwd: clone, env, stdio: ["ignore", "ignore", "pipe"] });
    const worktree = fs.readFileSync(cdFile, "utf8").trim();
    assert.equal(path.basename(worktree), "pr-7-feat");
    assert.equal(git(worktree, "rev-parse", "HEAD"), last, "at the PR's last commit");
    assert.equal(git(worktree, "branch", "--show-current"), "feat", "on a local branch of the PR's name");
    assert.throws(() => git(worktree, "rev-parse", "--abbrev-ref", "@{upstream}"), "with no upstream to push to");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("a PR URL from another repository is refused, rather than opening this one's PR of that number", () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wtpr-test-")));
  const env = { ...process.env, HOME: tmp, GIT_CONFIG_GLOBAL: "/dev/null", PATH: `${path.join(tmp, "bin")}:${process.env.PATH}` };
  try {
    const clone = path.join(tmp, "clone");
    execFileSync("git", ["init", "-q", clone], { env });
    execFileSync("git", ["-C", clone, "remote", "add", "origin", "git@github.com:acme/widgets.git"], { env });
    fs.mkdirSync(path.join(tmp, "bin"));
    fs.writeFileSync(path.join(tmp, "bin/gh"), `#!/bin/sh\necho '${JSON.stringify({ number: 5, title: "Elsewhere", author: { login: "t" }, headRefName: "x", isCrossRepository: false, state: "OPEN", url: "https://github.com/other/thing/pull/5" })}'\n`, { mode: 0o755 });
    let error = "";
    try {
      execFileSync(process.execPath, [script, "--no-claude", "https://github.com/other/thing/pull/5"], { cwd: clone, env, encoding: "utf8", stdio: ["ignore", "ignore", "pipe"] });
    } catch (err) {
      error = err.stderr;
    }
    assert.match(error, /That PR is in other\/thing, and this clone's remote is acme\/widgets/);
    assert.equal(fs.existsSync(path.join(clone, ".claude/worktrees")), false, "and nothing was made");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
