#!/usr/bin/env node

// watch-note.js <note file>
//
// For the note-watch skill's Monitor: prints a line for each checklist item
// added to a note while it runs, "NEW: <the item's text>", and nothing else
// unless the note goes away ("GONE: …"). The items already there when it
// starts are known, so only what is added after counts.
//
// An item counts once its text has stayed the same for SETTLE_MS, so one
// still being typed is not reported half-written, and an empty "- [ ]" never
// is. An item ticked or deleted is forgotten. Editing an item's text reads as
// a new item. Plain Node, no packages, since a skill runs it as it is.

const fs = require("node:fs");

// Shorter in the tests, through the environment.
const POLL_MS = Number(process.env.NOTE_WATCH_POLL_MS) || 2_000;
const SETTLE_MS = Number(process.env.NOTE_WATCH_SETTLE_MS) || 20_000;
const ITEM = /^\s*[-*+]\s+\[ \]\s+(\S.*?)\s*$/;

const file = process.argv[2];
if (!file) {
  console.error("Usage: watch-note.js <note file>");
  process.exit(1);
}

const openItems = () => {
  try {
    return new Set(fs.readFileSync(file, "utf8").split("\n").map((line) => ITEM.exec(line)?.[1]).filter(Boolean));
  } catch {
    return undefined;
  }
};

let known = openItems();
if (!known) {
  console.log(`GONE: ${file} can't be read`);
  process.exit(1);
}
// Text first seen, and when, until it has settled.
const pending = new Map();

setInterval(() => {
  const now = Date.now();
  const items = openItems();
  if (!items) {
    console.log(`GONE: ${file} was moved or deleted`);
    process.exit(0);
  }
  items.forEach((text) => {
    if (known.has(text)) return;
    if (!pending.has(text)) pending.set(text, now);
    else if (now - pending.get(text) >= SETTLE_MS) {
      console.log(`NEW: ${text}`);
      pending.delete(text);
      known.add(text);
    }
  });
  // Ticked, deleted, or typed further: no longer waiting to settle.
  [...pending.keys()].filter((text) => !items.has(text)).forEach((text) => pending.delete(text));
  known = new Set([...known].filter((text) => items.has(text)));
}, POLL_MS);
