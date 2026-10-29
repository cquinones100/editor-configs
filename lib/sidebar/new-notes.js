// Part of bin/tmux-sidebar; see the comment at the top of that file.
//
// The notes written for you without asking (the meeting notes from Fathom,
// meetings.js, and the standup note, standup.js), for the sidebar's
// notifications until you read one: each is kept in new-notes.json in the
// state directory as { path, title, source, at }, path within the notes
// directory, and is let go once Notes shows it (.notes.json's last), its file
// is gone, or its menu dismisses it.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { STATE_DIR } = require("./config");

const FILE = () => path.join(STATE_DIR, "new-notes.json");
const NOTES = () => process.env.NOTES_DIR || path.join(os.homedir(), "Notes");
const MAX = 50;

const read = () => {
  try {
    return JSON.parse(fs.readFileSync(FILE(), "utf8"));
  } catch {
    return [];
  }
};
const write = (notes) => {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(`${FILE()}.tmp`, JSON.stringify(notes.slice(-MAX)));
  fs.renameSync(`${FILE()}.tmp`, FILE());
};

// A note just written, by its absolute path, and what wrote it ("Fathom").
const noteWritten = (file, source) => {
  const title = (fs.readFileSync(file, "utf8").split("\n")[0] ?? "").replace(/^#+\s*/, "") || path.basename(file, ".md");
  const rel = path.relative(NOTES(), file);
  write([...read().filter((n) => n.path !== rel), { path: rel, title, source, at: Date.now() }]);
};

// The ones not yet read, newest first.
const newNotes = () => {
  let shown;
  try {
    shown = JSON.parse(fs.readFileSync(path.join(NOTES(), ".notes.json"), "utf8")).last;
  } catch {}
  const notes = read();
  const left = notes.filter((n) => n.path !== shown && fs.existsSync(path.join(NOTES(), n.path)));
  if (left.length !== notes.length) write(left);
  return [...left].reverse();
};

const dismissNote = (rel) => write(read().filter((n) => n.path !== rel));

module.exports = { noteWritten, newNotes, dismissNote };
