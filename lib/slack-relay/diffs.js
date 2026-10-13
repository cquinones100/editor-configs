// Part of bin/slack-relay; see the comment at the top of that file.

const { execFileSync } = require("node:child_process");
const { log, tryTmux } = require("./util");
const { react, post, uploadFile } = require("./post");
const { label, paneFor } = require("./tabs");

// ── Diffs ───────────────────────────────────────────────────────────────────

// What a tab's branch changes, for `diff`: its commits since it left the
// default branch, and everything changed since then, committed or not, as a
// summary in the thread and the whole diff as a file under it, which Slack
// shows as a snippet with colors. Read with git in the tab's directory;
// nothing is typed into the tab. A diff past DIFF_FILE_CHARS is cut there.
const DIFF_FILE_CHARS = 1_000_000;

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
    // origin/HEAD is named by the branch it points at (origin/main → main).
    baseRef: (baseRef === "origin/HEAD" ? git("rev-parse", "--abbrev-ref", "origin/HEAD") : baseRef)?.replace(/^origin\//, "") ?? "HEAD",
    commits: base === "HEAD" ? [] : git("log", "--format=%h %s", `${base}..HEAD`).split("\n").filter(Boolean),
    shortstat: git("diff", "--shortstat", base).trim(),
    stat: git("diff", "--stat=72", base),
    full: git("diff", base),
    untracked: git("ls-files", "--others", "--exclude-standard").split("\n").filter(Boolean),
  };
};

const diff = async (state, tab, reply, request, threadTs) => {
  react(state, request, "eyes").catch((err) => log(`👀 failed: ${err.message}`));
  const name = label(tab);
  const dir = tryTmux(["display-message", "-p", "-t", paneFor(tab.id), "#{pane_current_path}"]);
  if (!dir) return reply(`${name} no longer exists.`);
  const changes = changesIn(dir);
  if (changes.error) return reply(changes.error);
  const { branch, baseRef, commits, shortstat, stat, full, untracked } = changes;
  if (!full && !untracked.length) return reply(`${name} has no changes on \`${branch}\` against \`${baseRef}\`.`);
  const summary =
    `**${name}**, branch \`${branch}\`: ${commits.length} commit${commits.length === 1 ? "" : "s"} on top of \`${baseRef}\`` +
    (shortstat ? `, ${shortstat}` : "") +
    (untracked.length ? `, and ${untracked.length} new file${untracked.length === 1 ? "" : "s"} not yet added` : "") +
    ".";
  const shown = full.length > DIFF_FILE_CHARS ? `${full.slice(0, DIFF_FILE_CHARS)}\n… (the rest is cut; ${full.length} characters in all)\n` : full;
  const statLines = stat.split("\n");
  const brief = statLines.length > 15 ? [...statLines.slice(0, 14), "…", statLines.at(-1)].join("\n") : stat;
  const commitList = commits.length ? `\n\n**Commits**\n${commits.slice(0, 10).map((c) => `- \`${c.slice(0, c.indexOf(" "))}\`${c.slice(c.indexOf(" "))}`).join("\n")}${commits.length > 10 ? `\n- …and ${commits.length - 10} more` : ""}` : "";
  const newFiles = untracked.length ? `\n\n**New files not yet added:** ${untracked.slice(0, 10).map((file) => `\`${file}\``).join(", ")}${untracked.length > 10 ? ", …" : ""}` : "";
  const message = `${summary}${commitList}${newFiles}${brief ? `\n\n\`\`\`\n${brief}\n\`\`\`` : ""}`;
  // The summary is a message of its own, in Markdown like every other; the
  // whole diff goes in its thread (a file's own comment only takes Slack's
  // older format).
  const ts = await reply(message);
  if (!full) return ts;
  try {
    await uploadFile(state, {
      filename: `${branch.replace(/[^\w.-]+/g, "-")}.diff`,
      title: `${tab.name} (${branch}) against ${baseRef}`,
      content: shown,
      threadTs: threadTs ?? ts,
    });
  } catch (err) {
    log(err.message);
    await post(state, `🤖 I couldn't upload the whole diff: ${err.message}`, threadTs ?? ts);
  }
  return ts;
};

module.exports = { DIFF_FILE_CHARS, changesIn, diff };
