// Part of bin/tmux-sidebar; see the comment at the top of that file.
//
// What each Claude session in tmux is talking about, read from Claude Code's
// own files and nothing else: no processes, so it can run on every redraw.
// Claude Code writes ~/.claude/sessions/<pid>.json for each process it runs,
// naming its session, the name it was given, and its tmux pane ("main:@27.%28").
// Neither file is documented, so if one changes shape the cards quietly lose
// their text and nothing else is affected.

const fs = require("node:fs");
const path = require("node:path");
const { CLAUDE_DIR } = require("./config");

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
};

// Session files, re-read only when they change.
const sessionCache = new Map();
const sessions = () => {
  const dir = path.join(CLAUDE_DIR, "sessions");
  let names;
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  const seen = new Set(names);
  [...sessionCache.keys()].filter((name) => !seen.has(name)).forEach((name) => sessionCache.delete(name));
  return names.flatMap((name) => {
    const file = path.join(dir, name);
    let mtime;
    try {
      mtime = fs.statSync(file).mtimeMs;
    } catch {
      return [];
    }
    const cached = sessionCache.get(name);
    if (cached?.mtime === mtime) return cached.session ? [cached.session] : [];
    const session = readJson(file);
    sessionCache.set(name, { mtime, session });
    return session ? [session] : [];
  });
};

// pane id -> { sessionId, name, cwd }. A conversation moved into the
// background is carried on by a job whose session file has the parked
// session's parkedJobId as its jobId; the tab shows the job's conversation, as
// agent-state.sh marks the tab with the job's state.
// A headless Claude (entrypoint sdk-cli), such as one a review loop's
// script starts, inherits the tab's TMUX_PANE and names the pane too; the
// tab's own interactive Claude wins it, so the sidebar reads that one's
// transcript, background tasks included.
const headless = (session) => Boolean(session.entrypoint?.startsWith("sdk"));
const sessionsByPane = () => {
  const all = sessions();
  const byPane = new Map();
  [...all].sort((a, b) => Number(headless(b)) - Number(headless(a))).forEach((session) => {
    const pane = /%\d+$/.exec(session.tmux ?? "")?.[0];
    if (!pane || !session.sessionId) return;
    let current = session;
    const seen = new Set([current.sessionId]);
    while (current.parkedJobId) {
      const job = all.find((other) => other.jobId === current.parkedJobId && other.sessionId && !seen.has(other.sessionId));
      if (!job) break;
      seen.add(job.sessionId);
      current = job;
    }
    const named = session.nameSource && session.nameSource !== "derived" ? session.name : undefined;
    byPane.set(pane, { sessionId: current.sessionId, cwd: current.cwd ?? session.cwd, name: named, startedAt: current.startedAt ?? session.startedAt });
  });
  return byPane;
};

// Claude Code keeps a project's transcripts in a directory named after its
// path with every other character turned into "-".
const transcriptFiles = new Map();
const transcriptFor = ({ sessionId, cwd }) => {
  const direct = cwd && path.join(CLAUDE_DIR, "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"), `${sessionId}.jsonl`);
  if (direct && fs.existsSync(direct)) return direct;
  if (transcriptFiles.has(sessionId) && fs.existsSync(transcriptFiles.get(sessionId))) return transcriptFiles.get(sessionId);
  try {
    const projects = path.join(CLAUDE_DIR, "projects");
    const found = fs.readdirSync(projects).map((dir) => path.join(projects, dir, `${sessionId}.jsonl`)).find((file) => fs.existsSync(file));
    if (found) transcriptFiles.set(sessionId, found);
    return found;
  } catch {
    return undefined;
  }
};

// What a session has running in the background: commands and agents Claude
// started in the background since its process started (the tool's result
// names the task's ID) that no task notification has reported ended yet. A
// task dies with its process, so one started before that, as a resumed
// conversation's transcript shows, doesn't count. Each transcript is read
// only as far as it has grown since the last look.
//
// The skills that loop in the background are told apart by what their
// background commands run (LOOPS): while one of a loop's commands runs, the
// work is that loop, and its round is how many of them have started since
// its skill last began, so many to a round. A review loop runs codex-review
// twice a round; a CI loop watches the checks once a round, starting again
// after each fix; queue-and-clean watches the merge queue (its watch also
// reads the checks, so it is tested first).
//
// Returns { count, loop }, loop { kind, round } while one runs.
const LOOPS = [
  { kind: "queue", skill: "queue-and-clean", command: /mergeQueueEntry/, perRound: 1 },
  { kind: "review", skill: "review-loop", command: /codex-review/, perRound: 2 },
  { kind: "ci", skill: "ci-loop", command: /gh pr checks/, perRound: 1 },
];
const STARTED = /(?:Command running in background with ID|agentId): ([\w-]+)/g;
const ENDED = /<task-id>([\w-]+)<\/task-id>/g;
const loopOf = (command) => LOOPS.find((loop) => loop.command.test(command))?.kind;
const taskFiles = new Map();
const backgroundWork = (file, since = 0) => {
  if (!file) return { count: 0 };
  let size;
  try {
    size = fs.statSync(file).size;
  } catch {
    return { count: 0 };
  }
  let seen = taskFiles.get(file);
  if (!seen || size < seen.offset) seen = { offset: 0, rest: "", started: new Map(), ended: new Set(), commands: new Map(), loopAt: {} };
  if (size > seen.offset) {
    const fd = fs.openSync(file, "r");
    const chunk = Buffer.alloc(size - seen.offset);
    fs.readSync(fd, chunk, 0, chunk.length, seen.offset);
    fs.closeSync(fd);
    const lines = (seen.rest + chunk.toString("utf8")).split("\n");
    seen.rest = lines.pop();
    seen.offset = size;
    lines.forEach((line) => {
      if (!/background with ID|agentId|<task-id>|run_in_background|review-loop|ci-loop|queue-and-clean/.test(line)) return;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        return;
      }
      const at = Date.parse(entry.timestamp) || 0;
      const content = entry.message?.content ?? "";
      const text = JSON.stringify(content);
      const parts = Array.isArray(content) ? content : [];
      // A loop's skill starting: typed as /<skill>, or run by the Skill tool.
      LOOPS.forEach((loop) => {
        if (entry.type === "user" && text.includes(`<command-name>/${loop.skill}</command-name>`)) seen.loopAt[loop.kind] = at;
      });
      parts.forEach((part) => {
        const skill = part.type === "tool_use" && part.name === "Skill" && LOOPS.find((loop) => loop.skill === part.input?.skill);
        if (skill) seen.loopAt[skill.kind] = at;
        // What each background command runs, by its tool call.
        if (part.type === "tool_use" && part.input?.run_in_background) seen.commands.set(part.id, String(part.input.command ?? part.input.prompt ?? ""));
      });
      if (entry.origin?.kind === "task-notification" || text.includes("<task-notification>")) {
        [...text.matchAll(ENDED)].forEach((m) => seen.ended.add(m[1]));
      } else {
        parts.filter((part) => part.type === "tool_result").forEach((part) => {
          const result = JSON.stringify(part.content ?? "");
          [...result.matchAll(STARTED)].forEach((m) => seen.started.set(m[1], { at, loop: loopOf(seen.commands.get(part.tool_use_id) ?? "") }));
        });
      }
    });
    taskFiles.set(file, seen);
  }
  const running = [...seen.started].filter(([id, task]) => task.at >= since && !seen.ended.has(id));
  const loop = LOOPS.find((l) => running.some(([, task]) => task.loop === l.kind));
  if (!loop) return { count: running.length };
  const runs = [...seen.started.values()].filter((task) => task.loop === loop.kind && task.at >= Math.max(since, seen.loopAt[loop.kind] ?? 0)).length;
  return { count: running.length, loop: { kind: loop.kind, round: Math.max(1, Math.ceil(runs / loop.perRound)) } };
};
const backgroundTasks = (file, since) => backgroundWork(file, since).count;

// The prompt as you typed it: a slash command as "/name args", pasted text
// unwrapped, a background task's report named as one.
const promptText = (entry) => {
  const content = entry.message?.content;
  let text;
  if (typeof content === "string") text = content;
  else if (Array.isArray(content) && !content.some((part) => part.type === "tool_result")) {
    text = content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
  }
  if (!text?.trim()) return undefined;
  if (entry.origin?.kind === "task-notification") return "(a background task finished)";
  const command = /<command-name>([\s\S]*?)<\/command-name>/.exec(text);
  if (command) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1] ?? "";
    return `${command[1].trim()} ${args.trim()}`.trim();
  }
  if (/^<local-command-|^<bash-/.test(text.trim())) return undefined;
  return text.replace(/<pasted_content\b[^>]*>\n?([\s\S]*?)\n?<\/pasted_content\b[^>]*>/g, "$1").trim();
};

// A tool call in a few words, for a turn stopped on one: a permission prompt
// or a question.
const toolText = (part) => {
  const input = part.input ?? {};
  if (part.name === "AskUserQuestion") return input.questions?.[0]?.question ?? "a question";
  const detail = input.command ?? input.file_path ?? input.path ?? input.url ?? input.pattern ?? input.description ?? "";
  return `${part.name}${detail ? `: ${String(detail).split("\n")[0]}` : ""}`;
};

// The last turn from the end of a transcript: { prompt, at, reply, tools,
// pending }, where pending is the tool call the turn is stopped on, if any.
const parseTurn = (text) => {
  const entries = text.split("\n").flatMap((line) => {
    if (!line.startsWith("{")) return [];
    try {
      const entry = JSON.parse(line);
      return entry.isSidechain || entry.isMeta ? [] : [entry];
    } catch {
      return [];
    }
  });
  const start = entries.findLastIndex((entry) => entry.type === "user" && promptText(entry));
  if (start === -1) return undefined;
  const after = entries.slice(start + 1);
  const said = [];
  const calls = new Map();
  after.forEach((entry) => {
    const parts = Array.isArray(entry.message?.content) ? entry.message.content : [];
    if (entry.type === "assistant") {
      parts.forEach((part) => {
        if (part.type === "text" && part.text.trim()) said.push(part.text.trim());
        if (part.type === "tool_use") calls.set(part.id, part);
      });
    } else if (entry.type === "user") {
      parts.filter((part) => part.type === "tool_result").forEach((part) => calls.get(part.tool_use_id) && (calls.get(part.tool_use_id).answered = true));
    }
  });
  const pending = [...calls.values()].filter((call) => !call.answered).at(-1);
  return {
    prompt: promptText(entries[start]),
    at: Date.parse(entries[start].timestamp) || undefined,
    reply: said.at(-1),
    tools: calls.size,
    pending: pending && toolText(pending),
  };
};

// Read from the end, since a transcript can be tens of megabytes: the last
// TAIL bytes, then more while no prompt turns up in them.
const TAIL = 512 * 1024;
const MAX_TAIL = 16 * 1024 * 1024;
const turnCache = new Map();
const lastTurn = (file) => {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return undefined;
  }
  const cached = turnCache.get(file);
  if (cached && cached.size === stat.size && cached.mtime === stat.mtimeMs) return cached.turn;
  let turn;
  const fd = fs.openSync(file, "r");
  try {
    for (let length = TAIL; ; length *= 4) {
      const take = Math.min(length, stat.size);
      const buffer = Buffer.alloc(take);
      fs.readSync(fd, buffer, 0, take, stat.size - take);
      turn = parseTurn(buffer.toString("utf8"));
      if (turn || take === stat.size || length >= MAX_TAIL) break;
    }
  } finally {
    fs.closeSync(fd);
  }
  turnCache.set(file, { size: stat.size, mtime: stat.mtimeMs, turn });
  return turn;
};

module.exports = { sessions, sessionsByPane, transcriptFor, backgroundTasks, backgroundWork, promptText, parseTurn, lastTurn };
