const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");

const script = path.join(__dirname, "..", "bin", "codex-review");

test("codex-review on main with no PR reviews the commits not yet on origin, and says so when there are none", () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codex-review-main-")));
  const env = { ...process.env, HOME: tmp, GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e", PATH: `${path.join(tmp, "bin")}:${process.env.PATH}` };
  try {
    // gh finds no PR, as on a repository worked on straight from main.
    fs.mkdirSync(path.join(tmp, "bin"));
    fs.writeFileSync(path.join(tmp, "bin", "gh"), "#!/bin/sh\necho 'no pull requests found for branch \"main\"' >&2\nexit 1\n", { mode: 0o755 });
    const origin = path.join(tmp, "origin.git");
    const work = path.join(tmp, "work");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin], { env });
    execFileSync("git", ["clone", "-q", origin, work], { env, stdio: "ignore" });
    fs.writeFileSync(path.join(work, "a.txt"), "a\n");
    execFileSync("git", ["-C", work, "add", "."], { env });
    execFileSync("git", ["-C", work, "commit", "-q", "-m", "Pushed already"], { env });
    execFileSync("git", ["-C", work, "push", "-q", "origin", "main"], { env, stdio: "ignore" });
    fs.writeFileSync(path.join(work, "b.txt"), "b\n");
    execFileSync("git", ["-C", work, "add", "."], { env });
    execFileSync("git", ["-C", work, "commit", "-q", "-m", "Not pushed yet"], { env });

    const run = spawnSync(script, ["--dry-run", "--reviewer", "claude"], { cwd: work, env, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /Not pushed yet/);
    assert.doesNotMatch(run.stdout, /Pushed already/);

    execFileSync("git", ["-C", work, "push", "-q", "origin", "main"], { env, stdio: "ignore" });
    const none = spawnSync(script, ["--dry-run", "--reviewer", "claude"], { cwd: work, env, encoding: "utf8" });
    assert.notEqual(none.status, 0);
    assert.match(none.stderr, /every commit on main is on origin\/main already; nothing to review/);

    // A pushed commit, named as the base by hand.
    const pushed = spawnSync(script, ["--dry-run", "--reviewer", "claude", "--base", "HEAD~1"], { cwd: work, env, encoding: "utf8" });
    assert.equal(pushed.status, 0, pushed.stderr);
    assert.match(pushed.stdout, /Not pushed yet/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
