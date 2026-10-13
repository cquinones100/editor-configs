// Part of bin/slack-relay; see the comment at the top of that file.

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { SCREEN_LINES, VERSION } = require("./config");
const { tmux, tryTmux } = require("./util");

// ── tmux ────────────────────────────────────────────────────────────────────

// One row per window that has a Claude pane: its number, name, the state of
// its most urgent pane, and since when.
const claudeTabs = () => {
  const out = tryTmux([
    "list-panes", "-a", "-F",
    "#{window_id}\t#{window_index}\t#{window_name}\t#{pane_current_command}\t#{@agent_state}\t#{@agent_since}\t#{@slack_relay}",
  ]);
  if (!out) return [];
  const rank = { waiting: 3, done: 2, working: 1 };
  const windows = new Map();
  out.split("\n").forEach((line) => {
    const [id, index, name, command, state, since, relay] = line.split("\t");
    if (!VERSION.test(command) || relay === "1") return;
    const current = windows.get(id);
    if (!current || (rank[state] ?? 0) > (rank[current.state] ?? 0)) {
      windows.set(id, { id, index: Number(index), name, state: state || "idle", since });
    }
  });
  return [...windows.values()].sort((a, b) => a.index - b.index);
};

const label = (tab) => `tab ${tab.index}, ${tab.name}`;

const resolveTarget = (spec) => {
  const tabs = claudeTabs();
  if (/^\d+$/.test(spec)) {
    const tab = tabs.find((t) => t.index === Number(spec));
    return tab ? { tab } : { error: `No Claude tab ${spec}.` };
  }
  const matches = tabs.filter((t) => t.name.toUpperCase().includes(spec.toUpperCase()));
  if (matches.length === 1) return { tab: matches[0] };
  return {
    error: matches.length
      ? `Several tabs match ${spec}: ${matches.map(label).join("; ")}. Use the tab number.`
      : `No Claude tab mentions ${spec}.`,
  };
};

// The window's active pane, which must be running Claude to be typed into.
const claudePane = (windowId) => {
  const out = tryTmux(["display-message", "-p", "-t", windowId, "#{pane_id}\t#{pane_current_command}"]);
  if (!out) return { error: "That tab no longer exists." };
  const [pane, command] = out.split("\t");
  return VERSION.test(command) ? { pane } : { error: `That tab is running ${command}, not Claude, so nothing was sent.` };
};

// The Claude conversation running in a window, as its transcript file: the
// window's active pane runs Claude (directly or under its shell), which records
// its session in ~/.claude/sessions/<pid>.json, and the transcript is
// ~/.claude/projects/<dir>/<session>.jsonl. Undefined when any step is missing.
const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
};

const transcriptFor = (windowId) => {
  const pid = tryTmux(["display-message", "-p", "-t", windowId, "#{pane_pid}"]);
  if (!pid) return undefined;
  let children = [];
  try {
    children = execFileSync("pgrep", ["-P", pid], { encoding: "utf8" }).split("\n").filter(Boolean);
  } catch {}
  const sessionsDir = path.join(os.homedir(), ".claude/sessions");
  const sessionFile = [pid, ...children].map((p) => path.join(sessionsDir, `${p}.json`)).find((p) => fs.existsSync(p));
  if (!sessionFile) return undefined;
  try {
    let session = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
    // A session moved into the background is "parked": its file names the
    // background job that carries the conversation on (parkedJobId), and that
    // job's own session file has the same jobId. The conversation the tab is
    // part of is the job's, so its transcript is the one to read. The job can
    // itself have been parked, so the links are followed to the end, each
    // session at most once.
    if (session.parkedJobId) {
      const sessions = fs.readdirSync(sessionsDir)
        .filter((name) => name.endsWith(".json"))
        .flatMap((name) => {
          try {
            return [JSON.parse(fs.readFileSync(path.join(sessionsDir, name), "utf8"))];
          } catch {
            return [];
          }
        });
      const seen = new Set([session.sessionId]);
      let job;
      while (
        session.parkedJobId &&
        (job = sessions.find((other) => other.jobId === session.parkedJobId && other.sessionId && !seen.has(other.sessionId) && isAlive(other.pid)))
      ) {
        seen.add(job.sessionId);
        session = job;
      }
    }
    const { sessionId } = session;
    const projects = path.join(os.homedir(), ".claude/projects");
    return fs.readdirSync(projects)
      .map((dir) => path.join(projects, dir, `${sessionId}.jsonl`))
      .find((file) => fs.existsSync(file));
  } catch {
    return undefined;
  }
};

const relative = (ms) => {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / 1440)} days ago`;
};

// The last turn of a tab's conversation: the user's last prompt and everything
// Claude has written since, with its tool calls counted rather than shown.
// Falls back to the screen when the transcript can't be found.
const lastTurn = (windowId, expected) => {
  const asScreen = () => `\`\`\`\n${screen(windowId) || "(empty)"}\n\`\`\``;
  const file = transcriptFor(windowId);
  return (file && turnFrom(file, expected)) ?? asScreen();
};

const NO_REPLY = "(no reply yet)";

const sameText = (a, b) => (a ?? "").replace(/\s+/g, " ").trim() === (b ?? "").replace(/\s+/g, " ").trim();

// Whether a transcript has caught up with a turn the Stop hook reported: its
// last text is the turn's final message.
const caughtUp = (file, final) => {
  const after = lastPrompt(file)?.after ?? [];
  const texts = after.flatMap((entry) =>
    entry.type === "assistant" && Array.isArray(entry.message?.content)
      ? entry.message.content.filter((part) => part.type === "text" && part.text.trim()).map((part) => part.text)
      : [],
  );
  return sameText(texts.at(-1), final);
};

// Whether a transcript's last turn has been written to the end: its last
// entry is Claude's text, with no tool call after it. Claude Code writes the
// last words a moment after the Stop hook fires, so a turn reported ended can
// still stop at a tool call, or at text that came before one.
const turnWritten = (file) => {
  const after = lastPrompt(file)?.after ?? [];
  const last = after.filter((entry) => entry.type === "assistant" || entry.type === "user").at(-1);
  const parts = Array.isArray(last?.message?.content) ? last.message.content : [];
  return last?.type === "assistant" && parts.some((part) => part.type === "text" && part.text.trim()) && !parts.some((part) => part.type === "tool_use");
};

// Whether a prompt is the text the relay typed: the same start, ignoring
// spacing, since Claude Code may store it reflowed.
const promptMatches = (prompt, expected) => {
  const words = (text) => text.replace(/\s+/g, " ").trim().slice(0, 40);
  return words(prompt).startsWith(words(expected).slice(0, 30));
};

// A transcript's last prompt, when it was sent, and every entry after it, or
// undefined when there is no prompt yet. Subagents' entries are left out.
const lastPrompt = (file) => {
  let lines;
  try {
    lines = fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  const entries = lines.split("\n").filter(Boolean).flatMap((line) => {
    try {
      const entry = JSON.parse(line);
      return entry.isSidechain || entry.isMeta ? [] : [entry];
    } catch {
      return [];
    }
  });
  const promptText = (entry) => {
    const content = entry.message?.content;
    if (typeof content === "string") return content;
    if (!Array.isArray(content) || content.some((part) => part.type === "tool_result")) return undefined;
    return content.filter((part) => part.type === "text").map((part) => part.text).join("\n") || undefined;
  };
  const start = entries.findLastIndex((entry) => entry.type === "user" && promptText(entry));
  if (start === -1) return undefined;
  // Slash commands are stored with their tags; show what was typed.
  const prompt = promptText(entries[start])
    .replace(/<command-name>([^<]*)<\/command-name>/, "$1 ")
    .replace(/<[^>]+>[^<]*<\/[^>]+>/g, "")
    .trim();
  return { prompt, sentAt: Date.parse(entries[start].timestamp ?? ""), after: entries.slice(start + 1) };
};

// The last turn in a transcript file, or undefined when it has no prompt yet
// or, given `expected`, its last prompt is not that text.
// With `final` (the turn's last message, from the Stop hook), a transcript
// that hasn't caught up yet still ends with it.
const turnFrom = (file, expected, final) => {
  const last = lastPrompt(file);
  if (!last) return undefined;
  const { prompt, sentAt: sent, after } = last;
  // A Claude process can outlive its conversation (one that moved on to a
  // background session keeps the old transcript), so the transcript may not
  // be what the tab shows. When the relay knows what it typed, the last prompt
  // must be that text, or the screen is used instead. Otherwise the reply says
  // when the prompt was sent, so a stale turn is obvious.
  if (expected && !promptMatches(prompt, expected)) return undefined;
  let tools = 0;
  const said = [];
  after.forEach((entry) => {
    if (entry.type !== "assistant") return;
    (entry.message?.content ?? []).forEach((part) => {
      if (part.type === "tool_use") tools++;
      if (part.type === "text" && part.text.trim()) said.push(part.text.trim());
    });
  });
  const quoted = prompt.split("\n").map((line) => `> ${line}`).join("\n");
  if (final?.trim() && !sameText(said.at(-1), final)) said.push(final.trim());
  const reply = said.join("\n\n") || NO_REPLY;
  const ago = Number.isNaN(sent) ? "" : ` _(prompt sent ${relative(Date.now() - sent)})_`;
  return `${ago.trim()}\n${quoted}\n\n${reply}${tools ? `\n\n_(ran ${tools} tool${tools === 1 ? "" : "s"})_` : ""}`.trim();
};

// Full lines, joined where tmux wrapped them, so nothing is cut short. A
// run of one character (Claude Code draws its rules as a full-width line of
// ─ or ╌, 270 of them on a wide window) is cut to a few: it says nothing,
// and Haiku can't copy hundreds of them exactly, so a post with a screen in it
// failed and went out as the fallback note.
const RULE_RUN = /([\u2500-\u257F═—_=~.·-])\1{5,}/g;
const screen = (windowId) => {
  const out = tryTmux(["capture-pane", "-p", "-J", "-t", windowId, "-S", `-${SCREEN_LINES * 2}`]) ?? "";
  return out
    .split("\n")
    .map((line) => line.replace(RULE_RUN, "$1$1$1").trimEnd())
    .filter((line) => line.trim())
    .slice(-SCREEN_LINES)
    .join("\n");
};

// What a waiting tab is showing: a permission prompt is not in the transcript,
// only on the screen, and its numbered options are what you answer with.
const PROMPT_LINES = 20;
// Nothing when `turn`, what the message already shows, is the screen itself
// (lastTurn falls back to it).
// The numbered choices a waiting tab is showing (a permission prompt, or a
// question Claude asked), as { question, options: [{ n, label }] }, or
// undefined. Read from the bottom of the screen: the last run of lines
// numbered 1, 2, 3…, which may have description lines between them, and the
// few lines above it as the question.
const OPTION = /^\s*(?:[❯›>]\s*)?(\d{1,2})[.)]\s+(.*\S)\s*$/;
const optionsIn = (text) => {
  const lines = text.split("\n").map((line) => line.replace(/[│┃]/g, " ").trimEnd()).filter((line, i, all) => line.trim() && line !== all[i - 1]);
  const options = new Map();
  let first = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = lines[i].match(OPTION);
    if (!match) {
      if (options.size && i < lines.length - 1 && !options.has(1)) continue;
      if (options.has(1)) break;
      continue;
    }
    const n = Number(match[1]);
    if (!options.has(n)) options.set(n, match[2].replace(/\s{2,}.*$/, ""));
    first = i;
    if (n === 1) break;
  }
  const numbers = [...options.keys()].sort((a, b) => a - b);
  if (numbers.length < 2 || numbers.some((n, i) => n !== i + 1)) return undefined;
  // The question is the few lines just above the options, back to the
  // nearest rule (any line of box-drawing or dashes, such as the dotted one
  // under a file preview), so what it shows isn't taken for the question.
  const rule = /^[\s\u2500-\u257F—-]+$/;
  const above = [];
  for (let i = first - 1; i >= 0 && above.length < 3 && !rule.test(lines[i]) && !OPTION.test(lines[i]); i--) above.unshift(lines[i].trim());
  const question = above.join(" ");
  return { question, options: numbers.map((n) => ({ n, label: options.get(n) })) };
};

// Your answer as one of the options: its number, or the start of its text.
const chosenOption = (found, text) => {
  if (!found) return undefined;
  if (/^\d{1,2}$/.test(text)) return found.options.find((o) => o.n === Number(text));
  return text.length >= 2 ? found.options.find((o) => o.label.toLowerCase().startsWith(text.toLowerCase())) : undefined;
};

// A dialog Claude Code shows before a session starts ("trust this folder",
// "new MCP server found"), as { question, options, cursor }, or undefined:
// options listed one per line, unnumbered, the current one marked ❯, above
// an "Enter to confirm" line at the bottom of the screen. No hook runs before
// the session starts, so a tab showing one has no state; the relay reads it
// from the screen. The options are the lines aligned with the text after ❯,
// so the question and notes above them, set less deep, aren't taken for one.
const dialogIn = (text) => {
  const lines = text.split("\n").filter((line, i, all) => line.trim() && line !== all[i - 1]);
  const footer = lines.findLastIndex((line) => /Enter to confirm/.test(line));
  if (footer === -1 || footer < lines.length - 2) return undefined;
  const cursorLine = lines.slice(0, footer).findLastIndex((line) => /❯\s+\S/.test(line));
  if (cursorLine === -1) return undefined;
  const mark = lines[cursorLine].indexOf("❯");
  const column = mark + 1 + lines[cursorLine].slice(mark + 1).search(/\S/);
  const isOption = (line) =>
    line.indexOf("❯") === mark || (/^\s*$/.test(line.slice(0, column)) && line.length > column && line[column] !== " ");
  let start = cursorLine;
  while (start > 0 && isOption(lines[start - 1])) start--;
  let end = cursorLine;
  while (end < footer - 1 && isOption(lines[end + 1])) end++;
  const options = lines.slice(start, end + 1).map((line, i) => ({ n: i + 1, label: line.replace("❯", "").trim() }));
  if (options.length < 2) return undefined;
  const rule = /^[\s\u2500-\u257F—-]+$/;
  const above = [];
  for (let i = start - 1; i >= 0 && above.length < 3 && !rule.test(lines[i]); i--) above.unshift(lines[i].trim());
  return { question: above.join(" "), options, cursor: cursorLine - start + 1 };
};

const onScreen = (windowId, turn) => {
  const found = optionsIn(screen(windowId));
  if (found) {
    return (
      `\n${found.question ? `*${found.question}*\n` : ""}${found.options.map((o) => `${o.n}. ${o.label}`).join("\n")}` +
      "\n_Reply with a number or the start of an option, or react :+1: for 1, :raised_hand: to press Escape._"
    );
  }
  if (turn.startsWith("```")) return "";
  const lines = screen(windowId).split("\n").slice(-PROMPT_LINES).join("\n");
  return lines ? `\nOn screen now:\n\`\`\`\n${lines}\n\`\`\`` : "";
};

// -l types the text as written, so nothing in it is read as a key name.
const typeInto = (pane, text) => {
  tmux(["send-keys", "-t", pane, "-l", "--", text]);
  tmux(["send-keys", "-t", pane, "Enter"]);
};

module.exports = { claudeTabs, label, resolveTarget, claudePane, isAlive, transcriptFor, relative, lastTurn, NO_REPLY, sameText, caughtUp, turnWritten, promptMatches, lastPrompt, turnFrom, RULE_RUN, screen, PROMPT_LINES, OPTION, optionsIn, chosenOption, dialogIn, onScreen, typeInto };
