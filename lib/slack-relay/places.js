// Part of bin/slack-relay; see the comment at the top of that file.

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { tryTmux } = require("./util");

// ── Places ──────────────────────────────────────────────────────────────────

// Where `new <place>: <prompt>` starts its Claude. A place is a directory
// (a path starting ~ or /), or a name looked up among the git repositories
// you work in, found the way M-o (tmux/window-revive.sh) finds them: every
// open tab's, and every one a Claude session has run in over the last
// RECENT_DAYS. A repository's own name picks its main checkout; otherwise the
// name is matched against each worktree's branch and directory, so a ticket
// ID finds its worktree. Exactly one match, or nothing is started.
const RECENT_DAYS = 14;

const git = (dir, ...args) => {
  try {
    return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
};

// Directories Claude sessions have run in recently: the last cwd in each
// recent transcript, read from its end, since some are megabytes long.
const sessionDirs = () => {
  const projects = path.join(os.homedir(), ".claude/projects");
  const since = Date.now() - RECENT_DAYS * 24 * 60 * 60_000;
  let dirs = [];
  try {
    dirs = fs.readdirSync(projects);
  } catch {
    return [];
  }
  return dirs.flatMap((dir) => {
    let files = [];
    try {
      files = fs.readdirSync(path.join(projects, dir)).filter((name) => name.endsWith(".jsonl"));
    } catch {
      return [];
    }
    return files.flatMap((name) => {
      const file = path.join(projects, dir, name);
      try {
        const { mtimeMs, size } = fs.statSync(file);
        if (mtimeMs < since) return [];
        const fd = fs.openSync(file, "r");
        const length = Math.min(size, 65_536);
        const buffer = Buffer.alloc(length);
        fs.readSync(fd, buffer, 0, length, size - length);
        fs.closeSync(fd);
        const cwd = [...buffer.toString("utf8").matchAll(/"cwd":"([^"]*)"/g)].at(-1)?.[1];
        return cwd ? [cwd] : [];
      } catch {
        return [];
      }
    });
  });
};

// Every worktree of every repository in use, as { path, branch, repo, main }.
const places = () => {
  const panes = tryTmux(["list-panes", "-a", "-F", "#{pane_current_path}"])?.split("\n") ?? [];
  const roots = new Set(
    [...new Set([...panes, ...sessionDirs()])].flatMap((dir) => {
      if (!fs.existsSync(dir)) return [];
      const common = git(dir, "rev-parse", "--path-format=absolute", "--git-common-dir");
      // A bare repository has no checkout of its own.
      return common && path.basename(common) === ".git" ? [path.dirname(common)] : [];
    }),
  );
  return [...roots].flatMap((repo) =>
    (git(repo, "worktree", "list", "--porcelain") ?? "")
      .split("\n\n")
      .filter((block) => block.trim() && !/^prunable/m.test(block) && !/^bare$/m.test(block))
      .map((block) => {
        const tree = block.match(/^worktree (.+)$/m)?.[1];
        const branch = block.match(/^branch refs\/heads\/(.+)$/m)?.[1] ?? "(detached)";
        return { path: tree, branch, repo: path.basename(repo), main: tree === repo };
      })
      .filter((place) => place.path),
  );
};

const home = (dir) => dir.replace(/^~(?=\/|$)/, os.homedir());
const shortPath = (dir) => (dir.startsWith(os.homedir()) ? `~${dir.slice(os.homedir().length)}` : dir);
const describe = (place) => `\`${shortPath(place.path)}\` (${place.repo}, ${place.branch})`;

// { dir, said } for a place, or { error } saying why not.
const resolvePlace = (spec) => {
  if (/^[~/]/.test(spec)) {
    const dir = path.resolve(home(spec));
    return fs.existsSync(dir) && fs.statSync(dir).isDirectory()
      ? { dir, said: `\`${shortPath(dir)}\`` }
      : { error: `There's no directory \`${spec}\`, so I didn't start anything.` };
  }
  const all = places();
  const wanted = spec.toLowerCase();
  const repo = all.filter((place) => place.main && place.repo.toLowerCase() === wanted);
  const matches = repo.length
    ? repo
    : all.filter((place) => place.branch.toLowerCase().includes(wanted) || path.basename(place.path).toLowerCase().includes(wanted));
  if (matches.length === 1) return { dir: matches[0].path, said: describe(matches[0]) };
  if (!matches.length) {
    return { error: `Nothing matches \`${spec}\`: no repository by that name, and no worktree whose branch or directory contains it. Nothing started.` };
  }
  return {
    error:
      `\`${spec}\` matches ${matches.length} places, so I didn't start anything. Name one more closely:\n` +
      matches.slice(0, 10).map((place) => `• ${describe(place)}`).join("\n") +
      (matches.length > 10 ? `\n…and ${matches.length - 10} more` : ""),
  };
};

module.exports = { places, resolvePlace, shortPath };
