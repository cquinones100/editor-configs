// Part of bin/tmux-sidebar; see the comment at the top of that file.
//
// Mission control's Sessions view: each Claude tab's session, how full its
// context is, its model, how long it has run and how long since it last did
// anything, fullest first, to tell which to compact or close. The context
// and model are what Claude Code gives the statusline, which writes them to
// STATE_DIR/context/<session> (claude/statusline-command.sh); the age is the
// session file's start, and the last activity its transcript's last write.

const fs = require("node:fs");
const path = require("node:path");
const { STATE_DIR } = require("./config");
const { transcriptFor } = require("./claude");
const { ago } = require("./text");

// Context this full or more needs you: compact or start over.
const FULL = 80;

const contextOf = (sessionId) => {
  try {
    const [used, model] = fs.readFileSync(path.join(STATE_DIR, "context", sessionId), "utf8").split("\t");
    return { used: Number(used), model };
  } catch {
    return {};
  }
};

const lastWrite = (session) => {
  try {
    return Math.floor(fs.statSync(transcriptFor(session)).mtimeMs / 1000);
  } catch {
    return undefined;
  }
};

const sessionItems = (tabs) =>
  tabs
    .filter((tab) => tab.claude?.sessionId)
    .map((tab) => {
      const { used, model } = contextOf(tab.claude.sessionId);
      const started = tab.claude.startedAt ? Math.floor(tab.claude.startedAt / 1000) : undefined;
      const quiet = tab.state === "idle" || tab.state === "done" ? lastWrite(tab.claude) : undefined;
      const facts = [
        Number.isFinite(used) ? `context ${Math.round(used)}%` : "context unknown",
        model,
        started && `up ${ago(started)}`,
        quiet && `idle ${ago(quiet)}`,
      ].filter(Boolean);
      return {
        title: `${tab.index} ${tab.name}`,
        detail: facts.join(" · "),
        state: used >= FULL ? "attention" : tab.state === "idle" || tab.state === "done" ? "idle" : "active",
        used: Number.isFinite(used) ? used : -1,
        tab,
      };
    })
    .sort((a, b) => b.used - a.used);

module.exports = { FULL, sessionItems };
