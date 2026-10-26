// Part of bin/tmux-sidebar; see the comment at the top of that file.
//
// Drawing text in a terminal: how many columns a string takes, cutting and
// wrapping it to fit, and the colors. Every line handed back is exactly the
// width asked for, so a frame overwrites the last one without clearing.

const fs = require("node:fs");
const { THEME_FILE } = require("./config");

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

// Columns a code point takes: two for East Asian wide characters and emoji,
// the symbols terminals draw as emoji (⏳ ✅ ❌ ⚡ ✨ ⭐ …) among them, none for
// combining marks and joiners. A symbol a terminal would draw narrow takes two
// when an emoji presentation selector (U+FE0F) follows it, as in ⚠️. Counting
// any of these one short pushes the rest of the line, and every border after
// it on the screen, a column right.
const WIDE = [
  [0x1100, 0x115f], [0x231a, 0x231b], [0x2329, 0x232a], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3], [0x25fd, 0x25fe], [0x2614, 0x2615],
  [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1], [0x26aa, 0x26ab], [0x26bd, 0x26be], [0x26c4, 0x26c5], [0x26ce, 0x26ce],
  [0x26d4, 0x26d4], [0x26ea, 0x26ea], [0x26f2, 0x26f3], [0x26f5, 0x26f5], [0x26fa, 0x26fa], [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b],
  [0x2728, 0x2728], [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797], [0x27b0, 0x27b0], [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55], [0x2e80, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe30, 0xfe4f], [0xff00, 0xff60],
  [0xffe0, 0xffe6], [0x1f004, 0x1f004], [0x1f0cf, 0x1f0cf], [0x1f18e, 0x1f18e], [0x1f191, 0x1f19a], [0x1f200, 0x1f2ff], [0x1f300, 0x1f64f],
  [0x1f680, 0x1f6ff], [0x1f7e0, 0x1f7eb], [0x1f90c, 0x1f9ff], [0x1fa70, 0x1faff], [0x20000, 0x3fffd],
];
const VS16 = 0xfe0f;
const ZERO = [[0x0300, 0x036f], [0x200b, 0x200f], [0xfe00, 0xfe0f], [0x20d0, 0x20ff]];
const within = (code, ranges) => ranges.some(([from, to]) => code >= from && code <= to);
const charWidth = (char) => {
  const code = char.codePointAt(0);
  if (code < 32 || within(code, ZERO)) return 0;
  return within(code, WIDE) ? 2 : 1;
};
// A character's width where it stands: an emoji presentation selector widens
// the narrow symbol before it.
const widthAfter = (char, before) => (char.codePointAt(0) === VS16 && before === 1 ? 1 : charWidth(char));
const width = (text) =>
  [...text.replace(ANSI, "")].reduce(
    ({ sum, before }, char) => {
      const w = widthAfter(char, before);
      return { sum: sum + w, before: w };
    },
    { sum: 0, before: 0 },
  ).sum;

// Cut to `columns`, ending in … when anything was cut, keeping color codes.
const cut = (text, columns) => {
  if (width(text) <= columns) return text;
  let out = "";
  let used = 0;
  let before = 0;
  for (const piece of text.split(/(\x1b\[[0-9;?]*[A-Za-z])/)) {
    if (piece.startsWith("\x1b")) {
      out += piece;
      continue;
    }
    for (const char of piece) {
      const w = widthAfter(char, before);
      if (used + w > columns - 1) return `${out}…\x1b[0m`;
      out += char;
      used += w;
      before = w;
    }
  }
  return out;
};
const pad = (text, columns) => {
  const cutText = cut(text, columns);
  return cutText + " ".repeat(Math.max(0, columns - width(cutText)));
};

// Plain text wrapped to `columns`, on word boundaries where it can be.
const wrap = (text, atLeast) => {
  const columns = Math.max(atLeast, 4);
  return String(text ?? "")
    .split("\n")
    .flatMap((paragraph) => {
      const lines = [];
      let line = "";
      paragraph.split(/(\s+)/).filter((word) => word && !/^\s+$/.test(word)).forEach((word) => {
        while (width(word) > columns) {
          const room = columns - width(line) - (line ? 1 : 0);
          if (room < 4) {
            if (line) lines.push(line);
            line = "";
            continue;
          }
          const head = [...word].slice(0, room).join("");
          lines.push(line ? `${line} ${head}` : head);
          line = "";
          word = word.slice(head.length);
        }
        if (!line) line = word;
        else if (width(line) + 1 + width(word) <= columns) line += ` ${word}`;
        else {
          lines.push(line);
          line = word;
        }
      });
      lines.push(line);
      return lines;
    });
};

// Markdown read as plain text: fences, emphasis and heading marks dropped.
const plain = (text) =>
  String(text ?? "")
    .replace(/```[^\n]*\n?/g, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const fg = (color) => (typeof color === "string" ? `\x1b[38;2;${parseInt(color.slice(0, 2), 16)};${parseInt(color.slice(2, 4), 16)};${parseInt(color.slice(4, 6), 16)}m` : `\x1b[38;5;${color}m`);
const bg = (color) => (typeof color === "string" ? `\x1b[48;2;${parseInt(color.slice(0, 2), 16)};${parseInt(color.slice(2, 4), 16)};${parseInt(color.slice(4, 6), 16)}m` : `\x1b[48;5;${color}m`);
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

// The same 256-color palette theme.sh and update-colors.sh use, for the mode
// theme.sh last set. State colors match the tab badges in tmux.conf.
const PALETTES = {
  dark: { text: 250, dim: 244, faint: 240, bright: 255, highlight: 238, panel: 236 },
  light: { text: 236, dim: 242, faint: 248, bright: 232, highlight: 252, panel: 254 },
};
const STATES = {
  waiting: { color: 220, ink: 232, mark: "!", words: "waiting on you" },
  done: { color: 41, ink: 232, mark: "✓", words: "finished" },
  working: { color: 67, ink: 255, mark: "⠋", words: "working" },
  // Claude's turn ended with background tasks still running; it goes on when they end.
  background: { color: 60, ink: 255, mark: "⠋", words: "working in background" },
  // The background work is a loop: a review loop's Codex runs, a CI loop's
  // watch on the checks, or queue-and-clean's watch on the merge queue.
  review: { color: 97, ink: 255, mark: "⠋", words: "review loop" },
  ci: { color: 30, ink: 255, mark: "⠋", words: "CI loop" },
  queue: { color: 166, ink: 255, mark: "⠋", words: "queue-and-clean" },
  // A self-paced /loop between its ticks, waiting on the wakeup it scheduled.
  scheduled: { color: 31, ink: 255, mark: "↻", words: "looping" },
  // The background work is only Monitor watches, waiting for an event.
  monitor: { color: 37, ink: 232, mark: "◉", words: "monitoring" },
  idle: { color: undefined, ink: undefined, mark: "○", words: "" },
  // Not Claude's: an idle tab whose PR is in its merge queue, or merged.
  queued: { color: 173, ink: 232, mark: "»", words: "in merge queue" },
  merged: { color: 135, ink: 232, mark: "◆", words: "merged" },
  // Flagged by hand as needing you.
  flagged: { color: 220, ink: 232, mark: "⚑", words: "flagged" },
};
const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

let themeRead = { at: 0, mode: "dark" };
const theme = () => {
  if (Date.now() - themeRead.at > 2_000) {
    let mode = "dark";
    try {
      mode = fs.readFileSync(THEME_FILE, "utf8").trim() === "light" ? "light" : "dark";
    } catch {}
    themeRead = { at: Date.now(), mode };
  }
  return PALETTES[themeRead.mode];
};

const ago = (seconds) => {
  if (!seconds) return "";
  const s = Math.max(0, Math.floor(Date.now() / 1000) - seconds);
  if (s < 60) return "<1m";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
};

module.exports = { width, cut, pad, wrap, plain, fg, bg, BOLD, RESET, PALETTES, STATES, SPINNER, theme, ago };
