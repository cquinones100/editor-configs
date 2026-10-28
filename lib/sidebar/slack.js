// Part of bin/tmux-sidebar; see the comment at the top of that file.
//
// Mission control's Slack view: what is new for you on Slack in the last day,
// newest first, as the /slack-updates skill last saved it (its
// scripts/save.js writes STATE_DIR/slack.json; the Slack tab, M-p, runs it
// every 5 minutes): direct messages and mentions marked as needing you, then
// replies in your threads and the channels you chose. Enter opens a message
// in Slack. The relay's own messages are never in it.
//
// Saved more than STALE_MS ago, it says it is out of date, and the daemon
// opens a Slack tab in the background (tmux/loop-tab.sh) unless a tab already
// keeps it, as it does for the Calendar view. Going to the view asks the
// Slack tab to look now (`slackNow` in the daemon), so it is current when you
// read it. Drawing reads only the file, kept while its modified time is the
// same.

const fs = require("node:fs");
const path = require("node:path");
const { STATE_DIR } = require("./config");
const { ago } = require("./text");

const FILE = () => path.join(STATE_DIR, "slack.json");
const STALE_MS = 15 * 60_000;
const MARKS = { dm: "DM", mention: "@", thread: "↳", channel: "#" };

let cache = { mtime: 0, data: undefined };
const readSlack = () => {
  try {
    const mtime = fs.statSync(FILE()).mtimeMs;
    if (mtime !== cache.mtime) cache = { mtime, data: JSON.parse(fs.readFileSync(FILE(), "utf8")) };
  } catch {
    cache = { mtime: 0, data: undefined };
  }
  return cache.data;
};

const slackStale = (data) => Boolean(data) && Date.now() - Number(data.checked ?? 0) > STALE_MS;
// A tab already keeping it: Claude in the Slack tab, or any tab looping
// /slack-updates.
const slackLooping = (tabs) => tabs.some((t) => (t.name === "Slack" && t.claude) || /^\/slack-updates\b/.test(t.loop?.prompt ?? ""));

// The view, once /slack-updates has saved a look; none before.
const slackView = (tabs = []) => {
  const data = readSlack();
  if (!data) return undefined;
  const items = (data.items ?? []).map((i) => ({
    title: `${MARKS[i.kind] ?? ""} ${i.from || "Someone"} · ${i.where || "Slack"}`,
    detail: i.text,
    state: i.kind === "dm" || i.kind === "mention" ? "attention" : i.kind === "thread" ? "active" : "idle",
    time: Number(i.ts) * 1000,
    url: i.link,
    search: i.kind,
  }));
  const catching = slackLooping(tabs) ? "the Slack tab looks every 5 minutes" : "opening a Slack tab to catch up";
  const error = slackStale(data) ? `Out of date, last looked ${ago(Math.floor(Number(data.checked) / 1000))} ago: ${catching}.` : undefined;
  return { title: "Slack", slack: true, items, loaded: true, builtIn: true, error };
};

module.exports = { slackView, readSlack, slackStale, slackLooping };
