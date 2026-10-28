#!/usr/bin/env node
// Saves the day /today read for mission control's Calendar view
// (lib/sidebar/calendar.js), which can't reach the calendar itself:
// ~/.local/state/tmux-sidebar/calendar.json, written to a temporary file and
// renamed into place, then the sidebar is nudged to draw it. Plain Node.
//
//   node save.js < day.json
//
// day.json: { "date": "2026-10-28", "events": [{ "title": "Standup",
//   "start": "2026-10-28T13:00:00-04:00", "end": "2026-10-28T13:15:00-04:00",
//   "allDay": false, "you": "going", "join": "https://…zoom.us/j/…",
//   "link": "https://www.google.com/calendar/event?eid=…" }] }. Only those
// fields are kept, and only https links.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dir = process.env.TMUX_SIDEBAR_STATE_DIR || path.join(os.homedir(), ".local/state/tmux-sidebar");
const fail = (message) => {
  console.error(message);
  process.exit(1);
};

let day;
try {
  day = JSON.parse(fs.readFileSync(0, "utf8"));
} catch (err) {
  fail(`Not JSON: ${err.message}`);
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(day?.date ?? "")) fail("date must be YYYY-MM-DD");
if (!Array.isArray(day.events)) fail("events must be a list");

const https = (url) => (typeof url === "string" && /^https:\/\/[^\s]+$/.test(url) ? url : undefined);
const events = day.events
  .filter((e) => e && typeof e.title === "string" && (e.allDay || (!Number.isNaN(Date.parse(e.start)) && !Number.isNaN(Date.parse(e.end)))))
  .map((e) => ({
    title: e.title.slice(0, 200),
    allDay: Boolean(e.allDay),
    ...(e.allDay ? {} : { start: e.start, end: e.end }),
    you: ["going", "yours", "maybe", "not answered"].includes(e.you) ? e.you : "not answered",
    ...(https(e.join) && { join: https(e.join) }),
    ...(https(e.link) && { link: https(e.link) }),
  }));

fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, "calendar.json");
fs.writeFileSync(`${file}.tmp`, JSON.stringify({ date: day.date, updated: Date.now(), events }));
fs.renameSync(`${file}.tmp`, file);
fs.appendFileSync(path.join(dir, "nudge"), "\n");
console.log(`Saved ${events.length} event${events.length === 1 ? "" : "s"} for mission control.`);
