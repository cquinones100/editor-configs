const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");

const repo = path.join(__dirname, "..");

test("pre-push refuses a push to main whose tip /review-loop hasn't found clean, and lets other branches through", () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pre-push-")));
  const env = { ...process.env, HOME: tmp, GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" };
  try {
    execFileSync("git", ["init", "-q", "-b", "main", tmp], { env });
    fs.writeFileSync(path.join(tmp, "a.txt"), "a\n");
    execFileSync("git", ["-C", tmp, "add", "."], { env });
    execFileSync("git", ["-C", tmp, "commit", "-q", "-m", "first"], { env });
    const sha = execFileSync("git", ["-C", tmp, "rev-parse", "HEAD"], { env, encoding: "utf8" }).trim();
    const zero = "0".repeat(40);
    const push = (ref) => spawnSync(path.join(repo, ".githooks/pre-push"), ["origin", "url"], { cwd: tmp, env, encoding: "utf8", input: `refs/heads/main ${sha} ${ref} ${zero}\n` });

    const unreviewed = push("refs/heads/main");
    assert.equal(unreviewed.status, 1);
    assert.match(unreviewed.stderr, /hasn't been through \/review-loop/);
    assert.equal(push("refs/heads/feature").status, 0, "another branch isn't asked about");

    fs.writeFileSync(path.join(tmp, ".git/review-loop-clean"), `${sha}\n`);
    assert.equal(push("refs/heads/main").status, 0, "the commit the review found clean");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("this repository's Claude settings run the push guard and the hook guard before every command", () => {
  const settings = JSON.parse(fs.readFileSync(path.join(repo, ".claude/settings.json"), "utf8"));
  const commands = settings.hooks.PreToolUse.filter((h) => h.matcher === "Bash").flatMap((h) => h.hooks.map((x) => x.command));
  assert.ok(commands.some((c) => c.includes("$CLAUDE_PROJECT_DIR/claude/hooks/enforce-push-review.sh")));
  assert.ok(commands.some((c) => c.includes("$CLAUDE_PROJECT_DIR/claude/hooks/enforce-git-hooks-run.sh")), "which keeps core.hooksPath from switching the hook off");
});

test("this repository's push guard blocks git push --no-verify, however it is spelled, but not a dry run or a commit", () => {
  const guard = (command) => spawnSync("bash", [path.join(repo, "claude/hooks/enforce-push-review.sh")], { input: JSON.stringify({ tool_input: { command } }), encoding: "utf8" });
  const commitGuard = (command) => spawnSync("bash", [path.join(repo, "claude/hooks/enforce-git-hooks-run.sh")], { input: JSON.stringify({ tool_input: { command } }), encoding: "utf8" });
  assert.equal(guard("git push --no-verify origin main").status, 2);
  assert.equal(guard("git -C ~/switchboard push -q --no-verify").status, 2);
  assert.equal(guard('git push origin main "--no-verify"').status, 2, "quoted, the shell still passes the flag");
  assert.equal(guard("git push origin main --no\\-verify").status, 2, "escaped, the shell still passes the flag");
  assert.equal(guard("git push origin main --no-verify; echo done").status, 2, "followed by another command");
  assert.equal(guard("git push origin main --no-verify>/dev/null").status, 2, "followed by a redirection");
  assert.equal(guard('git -C "/a/review repo" push origin main --no-verify').status, 2, "in a repository whose path has a space");
  assert.equal(guard("/usr/bin/git push --no-verify origin main").status, 2, "git by its path");
  assert.equal(guard("git push --no-veri origin main").status, 2, "an abbreviation git takes");
  assert.equal(commitGuard("git commit --no-veri -m x").status, 2, "for a commit too");
  assert.equal(commitGuard("git commit --no-verbose -m x").status, 0, "--no-verbose skips nothing");
  assert.equal(guard("git push --no-verbose origin main").status, 0);
  assert.equal(commitGuard('git commit -m "skip with --no-verify, never"').status, 0, "a commit message that mentions it");
  assert.equal(commitGuard("git commit -nm 'x'").status, 2);
  assert.equal(guard("git -c 'core.hooksPath=/dev/null' push origin main").status, 2, "nor switch the hook off for the push");
  assert.equal(guard("GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.HooksPath GIT_CONFIG_VALUE_0=/x git push origin main").status, 2);
  assert.equal(guard("git push -n origin main").status, 0);
  assert.equal(guard("git push -q origin main").status, 0);
  assert.equal(commitGuard("git push --no-verify origin main").status, 0, "the guard every repository gets leaves pushes alone");
});
