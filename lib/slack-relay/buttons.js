// Part of bin/slack-relay; see the comment at the top of that file.

const crypto = require("node:crypto");
const { claudeTabs, screen, optionsIn, dialogIn, promptHash } = require("./tabs");

// ── Buttons ─────────────────────────────────────────────────────────────────

// The buttons the relay puts under its messages, so the common answers are a
// tap. Each carries a value saying what pressing it means; presses.js checks
// it and acts. Only you can press them (see pressFrom).

// A waiting tab's numbered options. Each records the wait it belongs to (the
// tab's @agent_since) and the prompt it was made for, so a press can only
// answer that same prompt while that same wait is on.
const optionButtons = (tab, found) =>
  found.options.map((o) => ({
    text: `${o.n}. ${o.label}`,
    value: { a: "opt", w: tab.id, n: o.n, s: String(tab.since ?? ""), k: promptHash(found) },
    ...(o.n === 1 ? { style: "primary" } : {}),
  }));

// The option a choice button stands for, if the tab is still showing the very
// prompt it was made for (and, for a waiting tab's options, in the same wait),
// with the tab it is in.
const stillShowing = (value) => {
  const tab = claudeTabs().find((t) => t.id === value.w);
  const dialog = value.a.endsWith("dialog");
  const found = dialog ? dialogIn(screen(value.w)) : optionsIn(screen(value.w));
  const option = found?.options.find((o) => o.n === value.n);
  const same = tab && option && promptHash(found) === value.k && (dialog || (tab.state === "waiting" && String(tab.since ?? "") === value.s));
  return same ? { tab, option } : undefined;
};

// A dialog shown before a session starts, answered with the arrow keys.
const dialogButtons = (tab, dialog) =>
  dialog.options.map((o) => ({ text: o.label, value: { a: "dialog", w: tab.id, n: o.n, k: promptHash(dialog) } }));

// Under a finished turn: Diff, Skill (a form to run one; see skills.js), and
// Continue only when Claude ended by asking
// (its last words end with a question mark), where it reads as "yes, go on".
// Nothing is running, so there is nothing to stop or ask the progress of.
const asks = (said) => /\?[\s"'*_)\]]*$/.test(String(said ?? "").trim());
const turnButtons = (tab, said) => [
  ...(asks(said) ? [{ text: "Continue", value: { a: "cmd", w: tab.id, c: "continue" }, style: "primary" }] : []),
  { text: "Diff", value: { a: "cmd", w: tab.id, c: "diff" } },
  { text: "Skill", value: { a: "skill", w: tab.id, p: String(tab.pid ?? "") } },
];

// While a turn you asked for is running: how it's going, or stop it.
const workingButtons = (tab) => [
  { text: "Progress", value: { a: "cmd", w: tab.id, c: "progress" }, style: "primary" },
  { text: "Stop", value: { a: "cmd", w: tab.id, c: "esc" }, style: "danger" },
];

// Closes a tab, which ends its Claude session, so Slack asks first. It names
// the tab's process as well as its window: tmux reuses window IDs, so a
// button drawn for a tab that has since closed can't close another.
const closeButton = (tab) => ({
  text: "Close",
  value: { a: "close", w: tab.id, p: String(tab.pid ?? "") },
  style: "danger",
  confirm: {
    title: { type: "plain_text", text: "Close this tab?" },
    text: {
      type: "mrkdwn",
      text: `*Tab ${tab.index}, ${String(tab.name).slice(0, 120)}*${tab.state === "working" ? " is in the middle of a turn." : "."} Closing it ends its Claude session; \`claude-here\` in its directory resumes it later.`,
    },
    confirm: { type: "plain_text", text: "Close" },
    deny: { type: "plain_text", text: "Keep it" },
    style: "danger",
  },
});

// Under a note that a tab may be stuck, which is still running.
const stuckButtons = (tab) => [
  { text: "Stop", value: { a: "cmd", w: tab.id, c: "esc" }, style: "danger" },
  { text: "Progress", value: { a: "cmd", w: tab.id, c: "progress" } },
];

// A message that named no tab: one button per tab, to send it there. The
// message itself is kept here, in memory, under a short ID the buttons carry,
// for the latest MAX_PICKS of them.
const MAX_PICKS = 50;
const picks = new Map();
const pickerButtons = (tabs, pick) => {
  const id = crypto.randomUUID().slice(0, 8);
  picks.set(id, pick);
  [...picks.keys()].slice(0, Math.max(0, picks.size - MAX_PICKS)).forEach((old) => picks.delete(old));
  return tabs.slice(0, 25).map((t) => ({ text: `${t.index} ${t.name}`, value: { a: "to", w: t.id, p: id } }));
};

// On a tab's thread header (see homes.js): what you'd ask of the tab without
// typing into it.
const headerButtons = (tab) => [
  { text: "Progress", value: { a: "cmd", w: tab.id, c: "progress" } },
  { text: "Diff", value: { a: "cmd", w: tab.id, c: "diff" } },
  { text: "Skill", value: { a: "skill", w: tab.id, p: String(tab.pid ?? "") } },
  { text: "Rename", value: { a: "rename", w: tab.id, p: String(tab.pid ?? "") } },
  closeButton(tab),
];

// On a closed tab's thread header: delete the thread (see cleanup.js).
const deleteThreadButton = (ts) => ({
  text: "Delete thread",
  value: { a: "delete-thread", t: ts },
  style: "danger",
  confirm: {
    title: { type: "plain_text", text: "Delete this thread?" },
    text: { type: "plain_text", text: "The relay deletes its messages here. Your own replies stay; Slack only lets you delete those. This can't be undone." },
    confirm: { type: "plain_text", text: "Delete" },
    deny: { type: "plain_text", text: "Keep it" },
    style: "danger",
  },
});

// The welcome message's buttons, for what you'd otherwise type: the Home tab
// first, the main view of every tab, then the commands. Home is a link Slack
// opens in its own app. The link needs the app's ID, which Slack only gives
// with an event (see run.js), so it is left off until the relay has seen one.
const WELCOME_COMMANDS = ["status", "threads", "progress", "help", "stop"];
const homeLink = (dm) => `slack://app?team=${dm.team}&id=${dm.appId}&tab=home`;
const welcomeButtons = (dm) => [
  ...(dm.appId ? [{ text: "Home", url: homeLink(dm), style: "primary" }] : []),
  { text: "Status", value: { a: "do", c: "status" } },
  { text: "Threads", value: { a: "do", c: "threads" } },
  { text: "Progress", value: { a: "do", c: "progress" } },
  { text: "New tab", value: { a: "new" } },
  { text: "Help", value: { a: "do", c: "help" } },
  {
    text: "Stop relay",
    value: { a: "do", c: "stop" },
    style: "danger",
    confirm: {
      title: { type: "plain_text", text: "Stop the relay?" },
      text: { type: "plain_text", text: "Slack stops reaching your tabs until you start it again at the Mac." },
      confirm: { type: "plain_text", text: "Stop" },
      deny: { type: "plain_text", text: "Keep it running" },
      style: "danger",
    },
  },
];

module.exports = { deleteThreadButton, headerButtons, WELCOME_COMMANDS, homeLink, welcomeButtons, stillShowing, closeButton, optionButtons, dialogButtons, asks, turnButtons, workingButtons, stuckButtons, MAX_PICKS, picks, pickerButtons };
