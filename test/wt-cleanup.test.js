// Tests for bin/wt-cleanup. Run with: node --test test/*.test.js
//
// Each test makes a repository of its own in a temporary directory, with a
// real worktree, and runs wt-cleanup in it with a stand-in fzf on the PATH
// that picks every row marked untracked, as you would to clear out what git
// has no record of. HOME and git's
// global config are temporary too, so nothing reads or changes yours.

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const script = path.join(__dirname, "../bin/wt-cleanup");
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wt-cleanup-test-")));
const bin = path.join(tmp, "bin");
fs.mkdirSync(bin);
// Picks every untracked row it is shown, and keeps them all to look at.
fs.writeFileSync(path.join(bin, "fzf"), `#!/bin/sh\n[ "$1" = --version ] && exit 0\ntee '${path.join(tmp, "rows.txt")}' | grep '	untracked'\n`, { mode: 0o755 });
const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: tmp, GIT_CONFIG_GLOBAL: path.join(tmp, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1" };
fs.writeFileSync(env.GIT_CONFIG_GLOBAL, "[user]\n\tname = Test\n\temail = test@example.com\n");
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

let repos = 0;

test("a live worktree is never deleted, even listed under a different case, and a directory with a .git is refused", () => {
  const repo = path.join(tmp, `repo-${repos++}`);
  execFileSync("git", ["init", "-q", "-b", "main", repo], { env });
  execFileSync("git", ["-C", repo, "commit", "-q", "--allow-empty", "-m", "first"], { env });
  const worktrees = path.join(repo, ".claude/worktrees");
  execFileSync("git", ["-C", repo, "worktree", "add", "-q", "-b", "live", path.join(worktrees, "live")], { env });
  // A worktree git has lost track of, still with its .git file, and a plain
  // directory left behind.
  fs.mkdirSync(path.join(worktrees, "lost"));
  fs.writeFileSync(path.join(worktrees, "lost", ".git"), "gitdir: /nowhere\n");
  fs.mkdirSync(path.join(worktrees, "leftover"));

  // Case-insensitive disks, as macOS's are by default, take .Claude for .claude.
  const caseInsensitive = fs.existsSync(path.join(repo, ".CLAUDE"));
  const subpath = caseInsensitive ? ".Claude/worktrees" : ".claude/worktrees";
  const run = spawnSync(script, [subpath], { cwd: repo, env, encoding: "utf8" });

  const rows = fs.readFileSync(path.join(tmp, "rows.txt"), "utf8").trim().split("\n");
  assert.deepEqual(rows.map((row) => row.split("\t")[1].split(/\s+/)[0]).sort(), ["tracked", "untracked", "untracked"], "the live worktree is known for what it is");
  assert.ok(rows.every((row, i) => row.startsWith(`${i}\t`)), "each row is picked by its index");
  assert.ok(fs.existsSync(path.join(worktrees, "live")), "the live worktree isn't among them, so it stays");
  assert.ok(fs.existsSync(path.join(worktrees, "lost")), "a directory with a .git is never deleted as untracked");
  assert.match(run.stderr, /Not removing \.claude\/worktrees\/lost: it has a \.git/);
  assert.ok(!fs.existsSync(path.join(worktrees, "leftover")), "a plain directory left behind is");
  assert.equal(run.status, 1, "and it says something was refused");
});
