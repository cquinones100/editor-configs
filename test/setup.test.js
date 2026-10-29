// Tests for setup.sh's parts, which must be safe to run again. Run with:
// node --test test/*.test.js
//
// A temporary HOME whose ~/editor-configs, the name before the rename, links
// to this clone, as an older clone's would: setup.sh links ~/switchboard to
// it, and the links land there and never in your own home. The tmux part (which fetches the
// plugins) and the git part (which sets this clone's own config) are left out.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync, execFileSync } = require("node:child_process");
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
    fs.mkdirSync(path.join(home, ".config/editor-configs"), { recursive: true });
    fs.writeFileSync(path.join(home, ".config/editor-configs/settings.json"), JSON.stringify({ tips: false }));
    fs.mkdirSync(path.join(home, ".config/ghostty"), { recursive: true });
    fs.writeFileSync(path.join(home, ".config/ghostty/config"), "theme = mine\n");

    const first = spawnSync("bash", [script, ...parts], { env, encoding: "utf8" });
    assert.equal(first.status, 0, first.stdout + first.stderr);
    assert.match(first.stdout, /ghostty:\n  move .*\.config\/ghostty\/config aside to .*\.bak\.\d+\n  link .*\.config\/ghostty\/config/);
    assert.match(first.stdout, /bin:\n(  link .*\n)*  link .*\.local\/bin\/notes\n/);
    assert.equal(fs.readlinkSync(path.join(home, ".config/nvim")), path.join(home, "switchboard/nvim"));
    assert.equal(fs.realpathSync(path.join(home, "switchboard")), fs.realpathSync(repo), "~/switchboard leads to the clone");
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, ".config/switchboard/settings.json"), "utf8")), { tips: false }, "and the settings moved to their new folder");

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

test("setup.sh claude merges Switchboard's settings into yours once, keeping yours, and makes a linked settings file your own", () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "setup-claude-")));
  const env = { ...process.env, HOME: home };
  const product = JSON.parse(fs.readFileSync(path.join(repo, "claude/switchboard-settings.json"), "utf8"));
  try {
    fs.symlinkSync(repo, path.join(home, "switchboard"));
    fs.mkdirSync(path.join(home, ".claude"));
    // Yours: a model, a permission, a hook of your own beside an older copy of
    // Switchboard's, and a statusline of your own.
    const yours = {
      model: "sonnet",
      permissions: { allow: ["Bash(make *)", "Bash(git log *)"] },
      statusLine: { type: "command", command: "my-statusline" },
      hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }, { type: "command", command: "bash ~/.config/tmux/agent-state.sh set done" }] }] },
    };
    fs.writeFileSync(path.join(home, ".claude/settings.json"), JSON.stringify(yours));

    const first = spawnSync("bash", [script, "claude"], { env, encoding: "utf8" });
    assert.equal(first.status, 0, first.stdout + first.stderr);
    const merged = JSON.parse(fs.readFileSync(path.join(home, ".claude/settings.json"), "utf8"));
    assert.equal(merged.model, "sonnet");
    assert.deepEqual(merged.statusLine, yours.statusLine, "a statusline of your own stays");
    assert.deepEqual(merged.permissions.allow, ["Bash(make *)", "Bash(git log *)", ...product.permissions.allow.filter((p) => p !== "Bash(git log *)")], "yours first, each rule once");
    assert.deepEqual(merged.permissions.deny, product.permissions.deny);
    assert.deepEqual(merged.hooks.Stop, [{ hooks: [{ type: "command", command: "say done" }] }, ...product.hooks.Stop], "your hook kept, Switchboard's once");
    assert.deepEqual(merged.hooks.PreToolUse, product.hooks.PreToolUse);
    assert.equal(fs.readdirSync(path.join(home, ".claude")).filter((f) => f.startsWith("settings.json.bak.")).length, 1, "a copy of yours left beside it");

    const again = spawnSync("bash", [script, "--check", "claude"], { env, encoding: "utf8" });
    assert.equal(again.stdout, "claude: up to date\n", "nothing left to merge");

    // A settings file linked into the repo, as the whole setup made it, becomes yours.
    fs.rmSync(path.join(home, ".claude/settings.json"));
    fs.symlinkSync(path.join(home, "switchboard/claude/settings.json"), path.join(home, ".claude/settings.json"));
    const linked = spawnSync("bash", [script, "claude"], { env, encoding: "utf8" });
    assert.equal(linked.status, 0, linked.stdout + linked.stderr);
    assert.match(linked.stdout, /make .*settings\.json your own/);
    assert.equal(fs.lstatSync(path.join(home, ".claude/settings.json")).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(path.join(repo, "claude/settings.json"), "utf8"), execFileSync("git", ["-C", repo, "show", "HEAD:claude/settings.json"], { encoding: "utf8" }), "the repo's file untouched");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("setup.sh terminal adds Option as Alt to a Ghostty config of your own once, and leaves one that sets it alone", () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "setup-terminal-")));
  // Ghostty, outside tmux, so nothing reaches Terminal's or iTerm2's preferences.
  const env = { ...process.env, HOME: home, TERM_PROGRAM: "ghostty", TMUX: "", LC_TERMINAL: "" };
  try {
    fs.symlinkSync(repo, path.join(home, "switchboard"));
    fs.mkdirSync(path.join(home, ".config/ghostty"), { recursive: true });
    const config = path.join(home, ".config/ghostty/config");
    fs.writeFileSync(config, "theme = mine\n");
    const first = spawnSync("bash", [script, "terminal"], { env, encoding: "utf8" });
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /add Switchboard's key settings to your Ghostty config/);
    assert.match(fs.readFileSync(config, "utf8"), /^theme = mine\n[\s\S]*\nconfig-file = \?~\/switchboard\/ghostty\/required\n$/);
    assert.match(fs.readFileSync(path.join(repo, "ghostty/required"), "utf8"), /^macos-option-as-alt = true$/m);
    const again = spawnSync("bash", [script, "terminal"], { env, encoding: "utf8" });
    assert.match(again.stdout, /terminal: up to date/, "a second run changes nothing");

    fs.writeFileSync(config, "macos-option-as-alt = left\n");
    const own = spawnSync("bash", [script, "terminal"], { env, encoding: "utf8" });
    assert.match(own.stdout, /terminal: up to date/, "a config that sets it itself is left alone");
    assert.equal(fs.readFileSync(config, "utf8"), "macos-option-as-alt = left\n");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
