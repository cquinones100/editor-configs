// Tests for setup.sh's parts, which must be safe to run again. Run with:
// node --test test/*.test.js
//
// A temporary HOME whose ~/editor-configs links to this clone, so the links
// land there and never in your own home. The tmux part (which fetches the
// plugins) and the git part (which sets this clone's own config) are left out.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const repo = path.join(__dirname, "..");
const script = path.join(repo, "setup.sh");

test("setup.sh links its parts once, moves a real file aside once, and changes nothing the second time", () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "setup-test-")));
  const env = { ...process.env, HOME: home };
  const parts = ["lazygit", "neovim", "ghostty", "pgcli", "bin", "claude"];
  try {
    fs.symlinkSync(repo, path.join(home, "editor-configs"));
    fs.mkdirSync(path.join(home, ".config/ghostty"), { recursive: true });
    fs.writeFileSync(path.join(home, ".config/ghostty/config"), "theme = mine\n");

    const first = spawnSync("bash", [script, ...parts], { env, encoding: "utf8" });
    assert.equal(first.status, 0, first.stdout + first.stderr);
    assert.match(first.stdout, /ghostty:\n  move .*\.config\/ghostty\/config aside to .*\.bak\.\d+\n  link .*\.config\/ghostty\/config/);
    assert.match(first.stdout, /bin:\n(  link .*\n)*  link .*\.local\/bin\/notes\n/);
    assert.equal(fs.readlinkSync(path.join(home, ".config/nvim")), path.join(home, "editor-configs/nvim"));

    const check = spawnSync("bash", [script, "--check", ...parts], { env, encoding: "utf8" });
    assert.equal(check.stdout, parts.map((p) => `${p}: up to date\n`).join(""), "--check finds nothing left to do");

    const again = spawnSync("bash", [script, ...parts], { env, encoding: "utf8" });
    assert.equal(again.status, 0, again.stderr);
    assert.equal(again.stdout, parts.map((p) => `${p}: up to date\n`).join(""), "a second run changes nothing");
    assert.equal(fs.readdirSync(path.join(home, ".config/ghostty")).filter((f) => f.includes(".bak.")).length, 1, "and moves nothing aside again");

    fs.unlinkSync(path.join(home, ".config/nvim"));
    const pending = spawnSync("bash", [script, "--check", "neovim"], { env, encoding: "utf8" });
    assert.match(pending.stdout, /neovim:\n  would: link .*\.config\/nvim/);
    assert.equal(fs.existsSync(path.join(home, ".config/nvim")), false, "--check links nothing");

    const unknown = spawnSync("bash", [script, "nonsense"], { env, encoding: "utf8" });
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /Unknown part: nonsense/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
