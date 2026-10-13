// Part of bin/slack-relay; see the comment at the top of that file.

const { log } = require("./util");
const { slack } = require("./slack");
const { remove } = require("./post");
const { saveState } = require("./state");

// ── Deleting closed threads ─────────────────────────────────────────────────

// Slack doesn't let you delete the app's messages in its DM, only your own,
// so the relay deletes a closed tab's thread for you: its header and every
// message the app posted in it, with the files it uploaded there (diffs,
// images). Your own replies are yours to delete; Slack doesn't let an app
// delete them, so a thread you replied in keeps them, under a deleted header.
//
// Only threads of tabs that have closed can go: closeHome (homes.js) records
// each one in state.closedHomes when its tab closes or its window starts
// another session, and nothing else is ever deleted, so a running tab's
// thread can't be. Deleting is offered as a button that Slack confirms first:
// Delete thread on a closed header, Delete closed threads on the Home tab and
// under `cleanup`.

const closedThreads = (state) => Object.keys(state.closedHomes ?? {});

// Every message in a thread, the header first, following Slack's pages.
const threadMessages = async (state, ts) => {
  const messages = [];
  let cursor;
  do {
    const page = await slack.api("conversations.replies", { channel: state.dm.channel, ts, limit: 200, cursor });
    messages.push(...(page.messages ?? []));
    cursor = page.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return messages;
};

const fromApp = (state, message) => Boolean(message.bot_id) || message.user === state.dm.bot;

// Deletes the closed threads named, replies first and the header last, and
// says how many of your own replies were left behind.
const deleteThreads = async (state, threads) => {
  let deleted = 0;
  let yours = 0;
  for (const ts of threads.filter((t) => state.closedHomes?.[t])) {
    try {
      const messages = await threadMessages(state, ts);
      const replies = messages.filter((m) => m.ts !== ts);
      for (const message of replies) {
        if (!fromApp(state, message)) {
          yours += 1;
          continue;
        }
        for (const file of message.files ?? []) await slack.api("files.delete", { file: file.id }).catch((err) => log(`couldn't delete a file: ${err.message}`));
        await remove(state, message.ts).catch((err) => log(`couldn't delete a message: ${err.message}`));
      }
      await remove(state, ts).catch((err) => {
        if (!/message_not_found/.test(err.message)) throw err;
      });
      delete state.closedHomes[ts];
      delete state.threads[ts];
      delete state.latest?.[ts];
      Object.keys(state.alerts ?? {}).filter((key) => key === ts || state.alerts[key]?.thread === ts).forEach((key) => delete state.alerts[key]);
      deleted += 1;
      log(`deleted thread ${ts}`);
    } catch (err) {
      log(`deleting thread ${ts} failed: ${err.message}`);
    }
    saveState(state);
  }
  return { deleted, yours };
};

// The button that deletes every closed thread, for the Home tab and `cleanup`.
const cleanupButton = (count) => ({
  text: `Delete ${count} closed thread${count === 1 ? "" : "s"}`,
  value: { a: "cleanup" },
  style: "danger",
  confirm: {
    title: { type: "plain_text", text: "Delete closed threads?" },
    text: {
      type: "plain_text",
      text: `The relay deletes its messages in the threads of ${count} closed tab${count === 1 ? "" : "s"}. Your own replies stay; Slack only lets you delete those. This can't be undone.`,
    },
    confirm: { type: "plain_text", text: "Delete" },
    deny: { type: "plain_text", text: "Keep them" },
    style: "danger",
  },
});

const cleanupNote = ({ deleted, yours }) =>
  `Deleted ${deleted} closed thread${deleted === 1 ? "" : "s"}.` +
  (yours ? ` ${yours} of your own replies stayed, since only you can delete those.` : "");

module.exports = { closedThreads, threadMessages, deleteThreads, cleanupButton, cleanupNote };
