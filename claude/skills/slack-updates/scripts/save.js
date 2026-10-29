#!/usr/bin/env node
// Keeps what is new for you on Slack for mission control's Slack view
// (lib/sidebar/slack.js), which can't reach Slack itself:
// ~/.local/state/tmux-sidebar/slack.json, written to a temporary file and
// renamed into place, then the sidebar is nudged to draw it. Plain Node.
//
//   node save.js --since    prints when to look back to: OVERLAP_MS before the
//                           last look, or an hour ago the first time (ISO 8601,
//                           and the Unix time), then the Unix time to look
//                           for your own messages from: the same, or a day
//                           back while none have been kept yet
//   node save.js < new.json  adds what this look found and marks the look
//
// new.json: { "items": [{ "kind": "mention" | "dm" | "thread" | "channel",
//   "channel": "C…", "where": "#general" or a person's name, "user": "U…",
//   "from": "Ada", "text": "…", "ts": "1761660000.000100", "thread": the
//   thread's ts when it is a reply in one,
//   "link": "https://….slack.com/archives/…" }], "replied": [{ "channel":
//   "C…", "ts": "…", "thread": "…" }] }, replied being what you wrote yourself
//   since the last look, kept as the newest ts you wrote in each conversation
//   (by channel) and each thread (by channel and thread), so the view counts
//   what came before it there as read. What the Slack relay posted,
// or anything in its DM, is left out (its state file names both), as is
// anything over a day old. At most MAX_ITEMS are kept, newest first.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dir = process.env.TMUX_SIDEBAR_STATE_DIR || path.join(os.homedir(), ".local/state/tmux-sidebar");
const file = path.join(dir, "slack.json");
const KEEP_MS = 24 * 60 * 60_000;
// The first look goes back only this far: a day's worth is mostly read.
const FIRST_MS = 60 * 60_000;
// Each look starts this long before the last one was saved: a message sent
// while that look was searching, or one Slack's search had yet to index, is
// found the next time. Messages already saved aren't saved twice.
const OVERLAP_MS = 10 * 60_000;
const MAX_ITEMS = 300;
const KINDS = ["mention", "dm", "thread", "channel"];

const read = (p) => {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return undefined;
  }
};
const saved = read(file) ?? { items: [] };

if (process.argv[2] === "--since") {
  const since = Number(saved.checked) ? Number(saved.checked) - OVERLAP_MS : Date.now() - FIRST_MS;
  const mine = saved.replied ? since : Date.now() - KEEP_MS;
  console.log(`${new Date(since).toISOString()} ${Math.floor(since / 1000)} ${Math.floor(mine / 1000)}`);
  process.exit(0);
}

let found;
try {
  found = JSON.parse(fs.readFileSync(0, "utf8"));
} catch (err) {
  console.error(`Not JSON: ${err.message}`);
  process.exit(1);
}
const relay = read(path.join(process.env.SLACK_RELAY_STATE ?? path.join(os.homedir(), ".local/state/slack-relay"), "state.json"))?.dm ?? {};
const text = (value, max) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const https = (url) => (typeof url === "string" && /^https:\/\/[^\s]+$/.test(url) ? url : undefined);
const items = (Array.isArray(found?.items) ? found.items : [])
  .filter((i) => i && KINDS.includes(i.kind) && /^\d+(\.\d+)?$/.test(String(i.ts ?? "")))
  .filter((i) => !(relay.channel && i.channel === relay.channel) && !(relay.bot && i.user === relay.bot))
  .map((i) => ({
    kind: i.kind,
    channel: text(i.channel, 40),
    where: text(i.where, 80),
    user: text(i.user, 40),
    from: text(i.from, 80),
    text: text(i.text, 400),
    ts: String(i.ts),
    ...(/^\d+(\.\d+)?$/.test(String(i.thread ?? "")) && { thread: String(i.thread) }),
    ...(https(i.link) && { link: https(i.link) }),
  }));

const key = (i) => `${i.channel}:${i.ts}`;
const now = Date.now();
const TS = /^\d+(\.\d+)?$/;
const replied = { ...(saved.replied ?? {}) };
(Array.isArray(found?.replied) ? found.replied : [])
  .filter((r) => r && /^[A-Z0-9]+$/.test(String(r.channel ?? "")) && TS.test(String(r.ts ?? "")))
  .forEach((r) => {
    const thread = TS.test(String(r.thread ?? "")) ? String(r.thread) : String(r.ts);
    [r.channel, `${r.channel}:${thread}`].forEach((k) => {
      if (!(Number(replied[k]) >= Number(r.ts))) replied[k] = String(r.ts);
    });
  });
Object.keys(replied).forEach((k) => now - Number(replied[k]) * 1000 >= KEEP_MS && delete replied[k]);
const merged = new Map([...saved.items, ...items].map((i) => [key(i), i]));
const kept = [...merged.values()]
  .filter((i) => now - Number(i.ts) * 1000 < KEEP_MS)
  .sort((a, b) => Number(b.ts) - Number(a.ts))
  .slice(0, MAX_ITEMS);

fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(`${file}.tmp`, JSON.stringify({ checked: now, items: kept, replied }));
fs.renameSync(`${file}.tmp`, file);
fs.appendFileSync(path.join(dir, "nudge"), "\n");
console.log(`Saved ${items.length} new, ${kept.length} in the last day.`);
