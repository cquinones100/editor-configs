// Part of bin/slack-relay; see the comment at the top of that file.

const { execFileSync } = require("node:child_process");
const { log, tryTmux } = require("./util");
const { react, createCanvas, canvasTitle } = require("./post");
const { label } = require("./tabs");

// ── Diffs ───────────────────────────────────────────────────────────────────

// What a tab's branch changes, for `diff`: its commits since it left the
// default branch, and everything changed since then, committed or not, as a
// summary in the thread and the whole diff in a canvas. Read with git in the
// tab's directory; nothing is typed into the tab.
const DIFF_CANVAS_CHARS = 20_000;

const changesIn = (dir) => {
  const git = (...args) =>
    execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 }).trimEnd();
  try {
    git("rev-parse", "--git-dir");
  } catch {
    return { error: `${dir} isn't in a git repository.` };
  }
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  const bases = ["origin/HEAD", "origin/main", "origin/master", "main", "master"];
  const baseRef = bases.find((ref) => {
    try {
      git("rev-parse", "--verify", "--quiet", ref);
      return true;
    } catch {
      return false;
    }
  });
  const base = baseRef ? git("merge-base", "HEAD", baseRef) : "HEAD";
  return {
    branch,
    baseRef: baseRef?.replace(/^origin\//, "") ?? "HEAD",
    commits: base === "HEAD" ? [] : git("log", "--format=%h %s", `${base}..HEAD`).split("\n").filter(Boolean),
    shortstat: git("diff", "--shortstat", base).trim(),
    stat: git("diff", "--stat=72", base),
    full: git("diff", base),
    untracked: git("ls-files", "--others", "--exclude-standard").split("\n").filter(Boolean),
  };
};

const diff = async (state, tab, reply, request) => {
  react(state, request, "eyes").catch((err) => log(`👀 failed: ${err.message}`));
  const name = label(tab);
  const dir = tryTmux(["display-message", "-p", "-t", tab.id, "#{pane_current_path}"]);
  if (!dir) return reply(`${name} no longer exists.`);
  const changes = changesIn(dir);
  if (changes.error) return reply(changes.error);
  const { branch, baseRef, commits, shortstat, stat, full, untracked } = changes;
  if (!full && !untracked.length) return reply(`${name} has no changes on \`${branch}\` against \`${baseRef}\`.`);
  const summary =
    `${name}, branch \`${branch}\`: ${commits.length} commit${commits.length === 1 ? "" : "s"} on top of \`${baseRef}\`` +
    (shortstat ? `, ${shortstat}` : "") +
    (untracked.length ? `, and ${untracked.length} new file${untracked.length === 1 ? "" : "s"} not yet added` : "") +
    ".";
  const shown = full.length > DIFF_CANVAS_CHARS ? `${full.slice(0, DIFF_CANVAS_CHARS)}\n… (the rest is cut; ${full.length} characters in all)` : full;
  const content = [
    `Branch \`${branch}\`, against \`${baseRef}\`, ${new Date().toLocaleString()}.`,
    ...(commits.length ? ["## Commits", ...commits.map((c) => `- ${c.replace(/^(\S+)/, "\`$1\`")}`)] : []),
    ...(untracked.length ? ["## New files not yet added", ...untracked.map((file) => `- \`${file}\``)] : []),
    ...(full ? ["## Changes", "````diff", shown, "````"] : []),
  ].join("\n\n");
  const statLines = stat.split("\n");
  const brief = statLines.length > 15 ? [...statLines.slice(0, 14), "…", statLines.at(-1)].join("\n") : stat;
  try {
    const canvas = await createCanvas(canvasTitle(state, `Diff: ${tab.name} (${branch})`), content);
    return reply(`${summary}${brief ? `\n\`\`\`\n${brief}\n\`\`\`` : ""}\n<${canvas.url}|The whole diff in a canvas>`);
  } catch (err) {
    log(err.message);
    return reply(`${summary}${brief ? `\n\`\`\`\n${brief}\n\`\`\`` : ""}\nI couldn't make a canvas for the whole diff.`);
  }
};

module.exports = { DIFF_CANVAS_CHARS, changesIn, diff };
