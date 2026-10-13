// Part of bin/slack-relay; see the comment at the top of that file.

const { execFile } = require("node:child_process");
const fs = require("node:fs");
const { log } = require("./util");
const { post } = require("./post");
const { saveState } = require("./state");
const { claudeTabs, label, transcriptFor } = require("./tabs");
const { homeOf } = require("./homes");

// ── Milestones and CI ───────────────────────────────────────────────────────

// One line in a tab's thread when one of its sessions gets somewhere that
// matters: a commit, a push, a pull request opened, or a test run that
// failed. Every Claude tab's transcript is followed from where it was when
// the relay first saw it, and a Bash call that looks like one of those is
// reported when its result comes back. A push or a new pull request also
// starts watching that pull request's CI (see ciTick).
const MILESTONE_KINDS = [
  ["pr", /\bgh\s+pr\s+create\b/],
  // git's own push and commit, after any of git's options (-C dir, -c k=v,
  // --no-pager…), not a subcommand's, such as `git stash push`.
  ["push", /\bgit(?:\s+-[Cc]\s+\S+|\s+--?[\w-]+(?:=\S+)?)*\s+push\b/],
  ["commit", /\bgit(?:\s+-[Cc]\s+\S+|\s+--?[\w-]+(?:=\S+)?)*\s+commit\b/],
  ["test", /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|\b(?:jest|vitest|pytest|rspec|mocha)\b|\bplaywright\s+test\b|\b(?:go|cargo)\s+test\b|\bnode\s+--test\b/],
];
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
    if (url) return `opened <${url[0]}|PR #${url[1]}>`;
    return failed ? `opening a PR failed: ${lastLine}` : undefined;
  }
  if (kind === "test" && failed) return `tests failed: \`${command.split("\n")[0].slice(0, 80)}\`${lastLine ? `, ending "${lastLine}"` : ""}`;
  return undefined;
};

// A tab's news goes in its thread; with `broadcast`, also in the main DM.
const ping = async (state, tab, line, { broadcast = false } = {}) => {
  const home = await homeOf(state, tab);
  log(`ping: ${label(tab)} ${line.slice(0, 80)}`);
  const ts = await post(state, `🤖 ${label(tab)}: ${line}`, home, { broadcast });
  state.alerts[ts] = { window: tab.id, index: tab.index, name: tab.name, thread: home };
  saveState(state);
};

const milestones = async (state) => {
  for (const tab of claudeTabs()) {
    let seen = followed.get(tab.id);
    const file = transcriptFor(tab.id);
    if (!file) continue;
    if (seen?.file !== file) {
      // A transcript first seen (or a tab now on another one) is followed
      // from its end: what happened before is old news.
      let size = 0;
      try {
        size = fs.statSync(file).size;
      } catch {}
      seen = { file, offset: size, pending: new Map(), cwd: undefined };
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
    let ciFrom;
    text.slice(0, end).split("\n").filter(Boolean).forEach((raw) => {
      let entry;
      try {
        entry = JSON.parse(raw);
      } catch {
        return;
      }
      if (entry.cwd) seen.cwd = entry.cwd;
      (Array.isArray(entry.message?.content) ? entry.message.content : []).forEach((part) => {
        if (entry.type === "assistant" && part.type === "tool_use" && part.name === "Bash") {
          const command = String(part.input?.command ?? "");
          const kinds = MILESTONE_KINDS.filter(([, pattern]) => pattern.test(command)).map(([kind]) => kind);
          if (kinds.length) seen.pending.set(part.id, { kinds, command, cwd: seen.cwd });
        }
        if (part.type === "tool_result" && seen.pending.has(part.tool_use_id)) {
          const { kinds, command, cwd } = seen.pending.get(part.tool_use_id);
          seen.pending.delete(part.tool_use_id);
          const output = Array.isArray(part.content) ? part.content.map((c) => c.text ?? "").join("\n") : String(part.content ?? "");
          kinds.forEach((kind) => {
            const line = milestoneLine(kind, output, Boolean(part.is_error), command);
            if (line) lines.push(line);
            if ((kind === "push" || kind === "pr") && !part.is_error) ciFrom = cwd ?? seen.cwd;
          });
        }
      });
    });
    // Failures also show in the main DM; progress stays in the tab's thread.
    for (const line of lines) await ping(state, tab, line, { broadcast: /failed/.test(line) }).catch((err) => log(`ping failed: ${err.message}`));
    if (ciFrom) watchCi(state, tab, ciFrom).catch((err) => log(`CI watch failed: ${err.message}`));
  }
};

// CI: after a push or a new pull request, the branch's pull request is
// looked up with gh, then its checks are read every CI_POLL_MS until they
// have all finished (✅ green), one has failed (❌, named), there are none
// after CI_NONE_MS, or CI_LIMIT_MS has passed. Green has to hold for two
// reads in a row with the same checks, since some workflows only start once
// others have finished, and a read between the two would look all done. gh runs in the background, so
// nothing waits on the network.
const CI_POLL_MS = 30_000;
const CI_NONE_MS = 10 * 60_000;
const CI_LIMIT_MS = 60 * 60_000;

const ghJson = (cwd, args) =>
  new Promise((resolve) => {
    // gh exits 8 while checks are pending, with the JSON still printed.
    execFile("gh", args, { cwd, timeout: 30_000, encoding: "utf8" }, (err, stdout) => {
      try {
        resolve(JSON.parse(stdout));
      } catch {
        resolve(undefined);
      }
    });
  });

const watchCi = async (state, tab, cwd) => {
  const pr = await ghJson(cwd, ["pr", "view", "--json", "number,url"]);
  if (!pr?.url) return;
  (state.ci ??= {})[pr.url] = { window: tab.id, index: tab.index, name: tab.name, cwd, number: pr.number, since: Date.now() };
  log(`CI: watching #${pr.number} for ${label(tab)}`);
  saveState(state);
};

const ciTick = async (state) => {
  for (const [url, watch] of Object.entries(state.ci ?? {})) {
    const checks = await ghJson(watch.cwd, ["pr", "checks", String(watch.number), "--json", "name,bucket"]);
    const all = Array.isArray(checks) ? checks : [];
    const failed = all.filter((c) => c.bucket === "fail" || c.bucket === "cancel");
    const pending = all.filter((c) => c.bucket === "pending");
    const age = Date.now() - watch.since;
    const pr = `<${url}|#${watch.number}>`;
    let line;
    const names = all.map((c) => c.name).sort().join("\n");
    if (failed.length) line = `❌ ${pr} failed: ${failed.map((c) => c.name).join(", ")}${pending.length ? ` (${pending.length} still running)` : ""}`;
    else if (all.length && !pending.length) {
      if (watch.settled === names) line = `✅ ${pr} is green (${all.length} check${all.length === 1 ? "" : "s"})`;
      else {
        watch.settled = names;
        saveState(state);
        continue;
      }
    } else if (watch.settled) {
      delete watch.settled;
      saveState(state);
    }
    if (!line && !all.length && age > CI_NONE_MS) line = `${pr} has no checks, so I stopped watching it.`;
    else if (!line && age > CI_LIMIT_MS) line = `${pr} is still running checks after an hour, so I stopped watching it.`;
    if (!line) continue;
    delete state.ci[url];
    saveState(state);
    await ping(state, { id: watch.window, index: watch.index, name: watch.name }, line, { broadcast: true }).catch((err) => log(`CI ping failed: ${err.message}`));
  }
};

module.exports = { MILESTONE_KINDS, followed, milestoneLine, ping, milestones, CI_POLL_MS, CI_NONE_MS, CI_LIMIT_MS, ghJson, watchCi, ciTick };
