// Part of bin/slack-relay; see the comment at the top of that file.

const { MAX_POST_CHARS } = require("./config");
const { log } = require("./util");
const { slack } = require("./slack");
const { watchThread, newestIn } = require("./state");

// Slack shows about 4,000 characters of a message, so longer text goes out as
// several messages in a row, split at paragraph breaks (or lines, or anywhere
// as a last resort), each under MAX_POST_CHARS. A code block split across two
// messages is closed in the first and reopened in the second.
const chunks = (text) => {
  const parts = [];
  let rest = text;
  while (rest.length > MAX_POST_CHARS) {
    const window = rest.slice(0, MAX_POST_CHARS);
    const cut = [window.lastIndexOf("\n\n"), window.lastIndexOf("\n")].find((i) => i > MAX_POST_CHARS / 2) ?? MAX_POST_CHARS;
    let part = rest.slice(0, cut);
    rest = rest.slice(cut).replace(/^\n+/, "");
    if ((part.match(/```/g) ?? []).length % 2) {
      part += "\n```";
      rest = "```\n" + rest;
    }
    parts.push(part);
  }
  return [...parts, rest];
};

// Everything the relay posts is standard Markdown, the way Claude writes, sent
// as a markdown block, which Slack renders: headings, **bold**, [links](url),
// lists, tables and code. Slack's older mrkdwn would show most of that as raw
// symbols. `text` is the same words, for notifications and previews.
// A button as Block Kit wants it, from { text, value } (what pressing it
// means to the relay, see buttons.js), or { text, url } for a link, with an
// optional `style` ("primary" or "danger") and `confirm`, a dialog Slack
// shows before the press counts.
const buttonElement = (b, i) => ({
  type: "button",
  action_id: `relay-${i}`,
  text: { type: "plain_text", text: b.text.length > 75 ? `${b.text.slice(0, 74)}…` : b.text, emoji: true },
  ...(b.url ? { url: b.url } : { value: JSON.stringify(b.value) }),
  ...(b.style ? { style: b.style } : {}),
  ...(b.confirm ? { confirm: b.confirm } : {}),
});

// `buttons` go in a row under the text (see buttonElement).
const asMarkdown = (body, buttons = []) => ({
  text: body,
  blocks: [{ type: "markdown", text: body }, ...(buttons.length ? [{ type: "actions", elements: buttons.map(buttonElement) }] : [])],
});

// Posts one message to the DM and returns its ts. Links aren't expanded into
// previews, which would bury a short reply under a PR's card. `broadcast`
// also shows a thread reply in the main DM, linked to its thread.
const postOne = async (state, body, threadTs, broadcast = false, buttons = []) => {
  const sent = await slack.api("chat.postMessage", {
    channel: state.dm.channel,
    ...asMarkdown(body, buttons),
    thread_ts: threadTs,
    reply_broadcast: threadTs && broadcast ? true : undefined,
    unfurl_links: false,
    unfurl_media: false,
  });
  return sent.ts;
};

// Reacts to a message with `emoji` (a name, such as "eyes"). Reacting twice
// is not an error worth reporting.
const react = async (state, ts, emoji) => {
  if (!ts) return;
  try {
    await slack.api("reactions.add", { channel: state.dm.channel, timestamp: ts, name: emoji });
  } catch (err) {
    if (!/already_reacted/.test(err.message)) throw err;
  }
};

// Takes the relay's reaction off a message; one that isn't there is fine.
const unreact = async (state, ts, emoji) => {
  try {
    await slack.api("reactions.remove", { channel: state.dm.channel, timestamp: ts, name: emoji });
  } catch (err) {
    if (!/no_reaction/.test(err.message)) throw err;
  }
};

// Deletes a message the relay posted.
const remove = (state, ts) => slack.api("chat.delete", { channel: state.dm.channel, ts });

// Edits a message the relay posted, in place.
const update = (state, ts, body, buttons = []) => slack.api("chat.update", { channel: state.dm.channel, ts, ...asMarkdown(body, buttons) });

// Uploads files into the DM, in `threadTs` if given: the images a tab made,
// shown in its thread. Each file's bytes go to an address Slack gives for it,
// then the files are shared together, FILES_PER_MESSAGE to a message, the
// most Slack shows in one. A file that fails to upload is left out and
// reported to `failed`; the rest still go. Returns the names shared.
const FILES_PER_MESSAGE = 10;
const uploadFiles = async (state, files, threadTs, failed = (name, err) => { throw err; }) => {
  const sent = [];
  for (const { filename, title, content } of files) {
    try {
      const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
      const target = await slack.api("files.getUploadURLExternal", { filename, length: bytes.length });
      await slack.put(target.upload_url, bytes);
      sent.push({ id: target.file_id, title, filename });
    } catch (err) {
      failed(filename, err);
    }
  }
  for (let i = 0; i < sent.length; i += FILES_PER_MESSAGE) {
    await slack.api("files.completeUploadExternal", {
      files: sent.slice(i, i + FILES_PER_MESSAGE).map(({ id, title }) => ({ id, title })),
      channel_id: state.dm.channel,
      thread_ts: threadTs,
    });
  }
  return sent.map((file) => file.filename);
};
const uploadFile = (state, { filename, title, content, threadTs }) => uploadFiles(state, [{ filename, title, content }], threadTs);

// The last part of each recent post, by its first part's ts, as { ts, body }:
// where its buttons are, for adding more later (see quickreplies.js).
const LAST_PARTS_KEPT = 100;
const lastParts = new Map();

// Posts `text`, in parts if it is long, and returns the first part's ts. A
// message at the top level is a thread you may reply under, so it is watched.
const post = async (state, text, threadTs, { broadcast = false, buttons = [] } = {}) => {
  const [first, ...rest] = chunks(text);
  // Buttons go under the last part, where you finish reading.
  const ts = await postOne(state, first, threadTs, broadcast, rest.length ? [] : buttons);
  let last = ts;
  for (const [i, part] of rest.entries()) last = await postOne(state, part, threadTs, false, i === rest.length - 1 ? buttons : []);
  lastParts.set(ts, { ts: last, body: rest.at(-1) ?? first });
  [...lastParts.keys()].slice(0, Math.max(0, lastParts.size - LAST_PARTS_KEPT)).forEach((old) => lastParts.delete(old));
  if (threadTs) newestIn(state, threadTs, last);
  if (!threadTs) watchThread(state, ts);
  log(`posted ${text.length} characters`);
  return ts;
};

// Every message showing a prompt's buttons for a tab: the alert in its thread
// and the notice in the main DM (and `kind`, "wait" or "dialog", says which
// sort of prompt). Answering from one clears the buttons from the others, and
// a prompt that has gone, answered at the computer or replaced, clears them
// all, so no button is left that would only be refused.
const offerChoice = (state, tabId, kind, ts, text) => {
  const offered = ((state.choices ??= {})[tabId] ??= { kind, messages: [] });
  if (offered.kind !== kind) {
    offered.kind = kind;
    offered.messages = [];
  }
  offered.messages.push({ ts, text });
};
const settleChoice = async (state, tabId, note, except) => {
  const offered = state.choices?.[tabId];
  if (!offered) return;
  delete state.choices[tabId];
  for (const message of offered.messages.filter((m) => m.ts !== except)) {
    await update(state, message.ts, `${message.text}\n\n_${note}_`).catch((err) => log(`couldn't clear a prompt's buttons: ${err.message}`));
  }
};

module.exports = { lastParts, chunks, buttonElement, asMarkdown, postOne, react, unreact, remove, update, FILES_PER_MESSAGE, uploadFiles, uploadFile, post, offerChoice, settleChoice };
