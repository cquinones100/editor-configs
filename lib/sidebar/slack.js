// Part of bin/tmux-sidebar; see the comment at the top of that file.
//
// Mission control's Slack view: what is new for you on Slack in the last day,
// newest first, as the daemon's own look (slack-look.js, the slack_background
// setting) or the /slack-updates skill in a Slack tab last saved it (the
// skill's scripts/save.js writes STATE_DIR/slack.json): direct messages and mentions marked as needing you, then
// replies in your threads and the channels you chose. Enter opens a message
// in Slack. The relay's own messages are never in it.
//
// Slack's connector can't say what you have read, so the view remembers what
// you have seen in it: leaving the view, or mission control, marks everything
// the look on screen had brought as seen (STATE_DIR/slack-seen, the look's
// time). Seen messages go below the new ones, faded, so what is new since
// you last looked is on top.
//
// x dismisses the chosen message and X every one shown: gone until something
// newer comes in its thread (a reply to it, or to the thread it is in), kept
// in STATE_DIR/slack-dismissed.json as the newest message dismissed in each
// thread (channel and thread, or the message itself when it is in none), for
// two days.
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
const { isOn } = require("../settings");

const FILE = () => path.join(STATE_DIR, "slack.json");
const SEEN = () => path.join(STATE_DIR, "slack-seen");
const DISMISSED = () => path.join(STATE_DIR, "slack-dismissed.json");
const DISMISS_KEEP_MS = 2 * 24 * 60 * 60_000;

// A message's thread: its channel and the thread's ts, or its own ts when it
// starts or is in none, so a reply to it lands in the same one.
const threadOf = (i) => `${i.channel}:${i.thread || i.ts}`;
const dismissed = () => {
  try {
    return JSON.parse(fs.readFileSync(DISMISSED(), "utf8"));
  } catch {
    return {};
  }
};
// Dismisses messages ({ channel, thread, ts } each) until their threads get
// something newer.
const dismissSlack = (messages) => {
  const all = dismissed();
  messages.forEach((m) => {
    const key = threadOf(m);
    all[key] = Math.max(Number(all[key] ?? 0), Number(m.ts));
  });
  const cutoff = (Date.now() - DISMISS_KEEP_MS) / 1000;
  Object.keys(all).filter((key) => all[key] < cutoff).forEach((key) => delete all[key]);
  fs.writeFileSync(`${DISMISSED()}.tmp`, JSON.stringify(all));
  fs.renameSync(`${DISMISSED()}.tmp`, DISMISSED());
};
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

const seenThrough = () => {
  try {
    return Number(fs.readFileSync(SEEN(), "utf8")) || 0;
  } catch {
    return 0;
  }
};
// Leaving the view: what its look brought is seen.
const markSlackSeen = () => {
  const data = readSlack();
  if (!data?.checked || Number(data.checked) <= seenThrough()) return;
  fs.writeFileSync(SEEN(), String(data.checked));
};

const slackStale = (data) => Boolean(data) && Date.now() - Number(data.checked ?? 0) > STALE_MS;
// A tab already keeping it: Claude in the Slack tab, or any tab looping
// /slack-updates.
const slackLooping = (tabs) => tabs.some((t) => (t.name === "Slack" && t.claude) || /^\/slack-updates\b/.test(t.loop?.prompt ?? ""));

// The view, always: before /slack-updates has saved a look, empty, saying a
// Slack tab is looking or is being opened (going to the view opens one).
const slackView = (tabs = []) => {
  const data = readSlack();
  if (!data) {
    const note = isOn("slack_background") ? "Nothing saved yet: mission control is looking." : slackLooping(tabs) ? "Nothing saved yet: the Slack tab is looking." : "Nothing saved yet: going to this view opens a Slack tab, which looks every 5 minutes (M-p, Open a Slack tab).";
    return { title: "Slack", slack: true, items: [], loaded: true, builtIn: true, error: note };
  }
  const seen = seenThrough();
  const gone = dismissed();
  // Slack's connector can't say what you have read, but it can say what you
  // wrote: a message before your own later one in the same DM, or in the same
  // thread, has been read (save.js keeps the newest you wrote in each).
  const replied = data.replied ?? {};
  const answered = (i) => {
    const after = (k) => Number(replied[k] ?? 0) > Number(i.ts);
    return i.kind === "dm" ? after(i.channel) : after(`${i.channel}:${i.thread ?? i.ts}`);
  };
  const items = (data.items ?? [])
    .filter((i) => !(Number(i.ts) <= Number(gone[threadOf(i)] ?? 0)))
    .map((i) => {
      const old = Number(i.ts) * 1000 <= seen || answered(i);
      return {
        title: `${MARKS[i.kind] ?? ""} ${i.from || "Someone"} · ${i.where || "Slack"}${old ? " · seen" : ""}`,
        detail: i.text,
        state: old ? "idle" : i.kind === "dm" || i.kind === "mention" ? "attention" : "active",
        time: Number(i.ts) * 1000,
        url: i.link,
        search: i.kind,
        old,
        message: { channel: i.channel, thread: i.thread, ts: i.ts },
      };
    })
    .sort((a, b) => Number(a.old) - Number(b.old) || b.time - a.time);
  const catching = isOn("slack_background") ? "mission control looks every minute while you're here" : slackLooping(tabs) ? "the Slack tab looks every 5 minutes" : "opening a Slack tab to catch up";
  const error = slackStale(data) ? `Out of date, last looked ${ago(Math.floor(Number(data.checked) / 1000))} ago: ${catching}.` : undefined;
  // With nothing to show, when it last looked, so an empty view reads as
  // current rather than broken.
  const checked = Math.floor(Number(data.checked ?? 0) / 1000);
  const empty = `Nothing new on Slack. Last checked ${Date.now() / 1000 - checked < 60 ? "just now" : `${ago(checked)} ago`}.`;
  return { title: "Slack", slack: true, items, loaded: true, builtIn: true, error, empty };
};

module.exports = { slackView, readSlack, slackStale, slackLooping, markSlackSeen, dismissSlack };
