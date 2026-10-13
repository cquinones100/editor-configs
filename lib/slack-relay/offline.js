// Part of bin/slack-relay; see the comment at the top of that file.

const { log } = require("./util");
const { slack } = require("./slack");
const { post, asMarkdown } = require("./post");
const { saveState } = require("./state");

// ── Saying the relay is offline ─────────────────────────────────────────────

// When the Mac is off, asleep or offline, the relay can't tell Slack anything,
// so the warning is left with Slack ahead of time: a message scheduled
// OFFLINE_AFTER_MS ahead in the DM, saying the relay is offline. Every
// RENEW_MS a new one is scheduled further out and the old one deleted, so
// while the relay runs, none is ever sent. If the relay goes quiet, nothing
// pushes it back and Slack sends it. When the relay is back, it says so, and
// for how long it was gone. A clean stop deletes it, since you know.
const OFFLINE_AFTER_MS = 10 * 60_000;
const RENEW_MS = 2 * 60_000;

const time = (ms) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const offlineText = (since) =>
  `🤖 ⚠️ **The relay is offline.** Your Mac last checked in at ${time(since)}, so it may be off, asleep or without internet. I'll say when it's back.`;

const duration = (ms) => {
  const minutes = Math.round(ms / 60_000);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};

const cancel = (state, id) =>
  slack.api("chat.deleteScheduledMessage", { channel: state.dm.channel, scheduled_message_id: id }).catch((err) => {
    // One Slack has already sent can't be deleted, and needn't be.
    if (!/invalid_scheduled_message_id/.test(err.message)) log(`couldn't delete the offline note: ${err.message}`);
  });

// Schedules the next note, then deletes the one before, so there is always one.
const renewOfflineNote = async (state) => {
  const now = Date.now();
  const text = offlineText(now);
  const scheduled = await slack.api("chat.scheduleMessage", {
    channel: state.dm.channel,
    post_at: Math.floor((now + OFFLINE_AFTER_MS) / 1000),
    ...asMarkdown(text),
  });
  const old = state.offlineNote;
  state.offlineNote = { id: scheduled.scheduled_message_id, at: now };
  saveState(state);
  if (old) await cancel(state, old.id);
};

// After the relay was gone, whether Slack sent the note (it was gone longer
// than OFFLINE_AFTER_MS), and if so, that it is back.
const sayBackOnline = async (state) => {
  const note = state.offlineNote;
  if (!note || Date.now() < note.at + OFFLINE_AFTER_MS) return;
  await post(state, `🤖 ✅ **Back online**, after ${duration(Date.now() - note.at)} offline (since ${time(note.at)}).`);
};

const cancelOfflineNote = async (state) => {
  if (!state.offlineNote) return;
  await cancel(state, state.offlineNote.id);
  delete state.offlineNote;
  saveState(state);
};

module.exports = { OFFLINE_AFTER_MS, RENEW_MS, offlineText, renewOfflineNote, sayBackOnline, cancelOfflineNote };
