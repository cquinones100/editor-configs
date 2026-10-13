// Part of bin/slack-relay; see the comment at the top of that file.

const { slack, messageFrom } = require("./slack");

// ── Catching up ─────────────────────────────────────────────────────────────

// Slack pushes each message as it is sent (see socketMode), so reading the DM
// is only needed for what was sent while the relay couldn't hear: before it
// started again after a crash, or while its connection was down. Then the DM
// is read from the cursor, and each watched thread from its last handled
// reply. Only your messages come back, by the same rule as events (see
// fromOwner); the dispatcher drops any it has already handled.
const PAGE = 200;

const catchUp = async (state) => {
  const mine = (messages, thread) =>
    messages
      .map((m) => messageFrom(state, { ...m, type: "message", channel: state.dm.channel, thread_ts: m.thread_ts ?? thread }))
      .filter(Boolean);
  const top = await slack.api("conversations.history", { channel: state.dm.channel, oldest: state.cursor, limit: PAGE });
  const messages = mine(top.messages ?? []).filter((m) => !m.thread_ts && Number(m.ts) > Number(state.cursor));
  for (const [thread, handledTo] of Object.entries(state.threads)) {
    const replies = await slack
      .api("conversations.replies", { channel: state.dm.channel, ts: thread, oldest: handledTo, limit: PAGE })
      .catch(() => ({ messages: [] }));
    messages.push(...mine(replies.messages ?? [], thread).filter((m) => m.thread_ts === thread && Number(m.ts) > Number(handledTo)));
  }
  return messages;
};

module.exports = { PAGE, catchUp };
