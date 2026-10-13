// Part of bin/slack-relay; see the comment at the top of that file.

const fs = require("node:fs");
const { log } = require("./util");
const { post } = require("./post");
const { saveState } = require("./state");
const { claudeTabs, label, transcriptFor } = require("./tabs");
const { homeOf } = require("./homes");
const { presence } = require("./presence");
const { notify } = require("./alerts");

// ── Milestones ──────────────────────────────────────────────────────────────

// One line in a tab's thread when one of its sessions gets somewhere that
// matters: a commit, a push, a pull request opened, or a test run that
// failed. Every Claude tab's transcript is followed from where it was when
// the relay first saw it, and a Bash call that looks like one of those is
// reported when its result comes back.
// gh and git count only where a command starts (a line's start, or after ;
// && || | ( or $( ), so text that only mentions them, such as a prompt in a
// test file, isn't taken for a push.
const AT_COMMAND = String.raw`(?:^|[;&|(]|\$\()\s*`;
const MILESTONE_KINDS = [
  ["pr", new RegExp(`${AT_COMMAND}gh\\s+pr\\s+create\\b`, "m")],
  // git's own push and commit, after any of git's options (-C dir, -c k=v,
  // --no-pager…), not a subcommand's, such as `git stash push`.
  ["push", new RegExp(`${AT_COMMAND}git(?:\\s+-[Cc]\\s+\\S+|\\s+--?[\\w-]+(?:=\\S+)?)*\\s+push\\b`, "m")],
  ["commit", new RegExp(`${AT_COMMAND}git(?:\\s+-[Cc]\\s+\\S+|\\s+--?[\\w-]+(?:=\\S+)?)*\\s+commit\\b`, "m")],
  ["test", /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|\b(?:jest|vitest|pytest|rspec|mocha)\b|\bplaywright\s+test\b|\b(?:go|cargo)\s+test\b|\bnode\s+--test\b/],
];
// A heredoc's body is text handed to a command, not commands, so it is left
// out before matching: writing a file that mentions `git push` pushes nothing.
const HEREDOC = /<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2[ \t]*(?=\n|$)/g;
const milestoneKinds = (command) => {
  const commands = command.replace(HEREDOC, "");
  return MILESTONE_KINDS.filter(([, pattern]) => pattern.test(commands)).map(([kind]) => kind);
};
const followed = new Map();

const milestoneLine = (kind, output, failed, command) => {
  const lastLine = output.trim().split("\n").filter((line) => line.trim()).at(-1)?.trim().slice(0, 200) ?? "";
  if (kind === "commit") {
    const made = output.match(/\[([^\]\s]+)(?: \(root-commit\))? ([0-9a-f]{7,})\] (.+)/);
    if (made) return `committed \`${made[2]}\` ${made[3]} on \`${made[1]}\``;
    return failed ? `a commit failed: ${lastLine}` : undefined;
  }
  if (kind === "push") {
    if (failed) return `a push failed: ${lastLine}`;
    const branch = output.match(/->\s+(\S+)/)?.[1];
    return branch ? `pushed \`${branch}\`` : "pushed";
  }
  if (kind === "pr") {
    const url = output.match(/https:\/\/github\.com\/\S+\/pull\/(\d+)/);
    if (url) return `opened [PR #${url[1]}](${url[0]})`;
    return failed ? `opening a PR failed: ${lastLine}` : undefined;
  }
  if (kind === "test" && failed) return `tests failed: \`${command.split("\n")[0].slice(0, 80)}\`${lastLine ? `, ending "${lastLine}"` : ""}`;
  return undefined;
};

// A tab's news goes in its thread at once. With `broadcast` it also goes to
// the main DM, which notifies you: while you're away, as the same message;
// while you're at the computer, as a line that waits until you're away (see
// notify).
const ping = async (state, tab, line, { broadcast = false } = {}) => {
  const home = await homeOf(state, tab);
  const target = { window: tab.id, index: tab.index, name: tab.name, thread: home };
  log(`ping: ${label(tab)} ${line.slice(0, 80)}`);
  const away = presence.away();
  const ts = await post(state, `🤖 ${label(tab)}: ${line}`, home, { broadcast: broadcast && away });
  state.alerts[ts] = target;
  saveState(state);
  if (broadcast && !away) await notify(state, `🤖 ${label(tab)}: ${line}`, home, target);
};

const milestones = async (state, tabs = claudeTabs()) => {
  for (const tab of tabs) {
    let seen = followed.get(tab.id);
    const file = transcriptFor(tab.id, tab.pid);
    if (!file) continue;
    if (seen?.file !== file) {
      // A transcript first seen (or a tab now on another one) is followed
      // from its end: what happened before is old news.
      let size = 0;
      try {
        size = fs.statSync(file).size;
      } catch {}
      seen = { file, offset: size, pending: new Map() };
      followed.set(tab.id, seen);
      continue;
    }
    let size;
    try {
      size = fs.statSync(seen.file).size;
    } catch {
      continue;
    }
    if (size < seen.offset) seen.offset = size;
    if (size === seen.offset) continue;
    const fd = fs.openSync(seen.file, "r");
    const buffer = Buffer.alloc(size - seen.offset);
    fs.readSync(fd, buffer, 0, buffer.length, seen.offset);
    fs.closeSync(fd);
    const text = buffer.toString("utf8");
    const end = text.lastIndexOf("\n") + 1;
    seen.offset += Buffer.byteLength(text.slice(0, end));
    const lines = [];
    text.slice(0, end).split("\n").filter(Boolean).forEach((raw) => {
      let entry;
      try {
        entry = JSON.parse(raw);
      } catch {
        return;
      }
      (Array.isArray(entry.message?.content) ? entry.message.content : []).forEach((part) => {
        if (entry.type === "assistant" && part.type === "tool_use" && part.name === "Bash") {
          const command = String(part.input?.command ?? "");
          const kinds = milestoneKinds(command);
          if (kinds.length) seen.pending.set(part.id, { kinds, command });
        }
        if (part.type === "tool_result" && seen.pending.has(part.tool_use_id)) {
          const { kinds, command } = seen.pending.get(part.tool_use_id);
          seen.pending.delete(part.tool_use_id);
          const output = Array.isArray(part.content) ? part.content.map((c) => c.text ?? "").join("\n") : String(part.content ?? "");
          kinds.forEach((kind) => {
            const line = milestoneLine(kind, output, Boolean(part.is_error), command);
            if (line) lines.push(line);
          });
        }
      });
    });
    // Failures also show in the main DM; progress stays in the tab's thread.
    for (const line of lines) await ping(state, tab, line, { broadcast: /failed/.test(line) }).catch((err) => log(`ping failed: ${err.message}`));
  }
};

module.exports = { MILESTONE_KINDS, milestoneKinds, followed, milestoneLine, ping, milestones };
