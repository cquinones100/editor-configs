// Part of bin/slack-relay; see the comment at the top of that file.

const fs = require("node:fs");
const { EVENTS_FILE, QUIET_SCREEN_MS, FOLLOW_UP_LIMIT_MS, PICKUP_WARN_MS, REPLY_WAIT_MS } = require("./config");
const { log } = require("./util");
const { react, post } = require("./post");
const { saveState } = require("./state");
const { claudeTabs, transcriptFor, lastTurn, caughtUp, turnWritten, promptMatches, turnFrom, screen, onScreen } = require("./tabs");
const { isHome } = require("./homes");

// Reports back, in the thread the request came from, when a tab the relay
// typed into is done. A tab with state (agent-state.sh) is done when it moves
// to finished or waiting after the message was sent. A tab without state is
// taken as done once its screen has changed and then stayed still for
// QUIET_SCREEN_MS. Either way the reply carries the end of its screen, which
// is usually Claude's answer. A tab being followed gets no separate alert.
// Turn ends and waits reported by the Claude Code hooks (tmux/agent-state.sh),
// for every session, in or out of tmux, each naming its transcript. The hooks
// write only while the file exists: the relay creates it, and removes it when
// stopped on purpose. A relay that crashed leaves it, so the turns that end
// while it restarts are still there, and how far it had read is kept in the
// state (eventsOffset), so it carries on from there.
const newEvents = (state) => {
  let size;
  try {
    size = fs.statSync(EVENTS_FILE).size;
  } catch {
    return [];
  }
  // A file shorter than what was read is a new one.
  if (size < state.eventsOffset) state.eventsOffset = 0;
  if (size === state.eventsOffset) return [];
  const fd = fs.openSync(EVENTS_FILE, "r");
  const buffer = Buffer.alloc(size - state.eventsOffset);
  fs.readSync(fd, buffer, 0, buffer.length, state.eventsOffset);
  fs.closeSync(fd);
  const text = buffer.toString("utf8");
  // Only whole lines; a line still being written is read next time.
  const end = text.lastIndexOf("\n") + 1;
  state.eventsOffset += Buffer.byteLength(text.slice(0, end));
  return text.slice(0, end).split("\n").filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
};

const followUps = async (state) => {
  const events = newEvents(state);
  const tabs = new Map(claudeTabs().map((t) => [t.id, t]));
  for (const [id, follow] of Object.entries(state.following)) {
    const tab = tabs.get(id);
    const name = `tab ${follow.index}, ${follow.name}`;
    const finish = async (body, { waiting = false } = {}) => {
      delete state.following[id];
      if (tab?.since) state.reported[id] = tab.since;
      saveState(state);
      try {
        const ts = await post(state, `🤖 ${body}`, follow.thread ?? undefined, { title: `${name}: ${follow.text.slice(0, 60)}` });
        state.alerts[ts] = { window: id, index: follow.index, name: follow.name, thread: follow.thread ?? undefined };
        if (waiting) (state.answerable ??= {})[ts] = { window: id, thread: follow.thread ?? ts };
        // In a tab's home thread, the main DM gets a line too.
        if (follow.thread && isHome(state, follow.thread)) {
          const notice = await post(state, `🤖 ${name} ${waiting ? "is *waiting on you*" : "is done"}.`, follow.thread, { broadcast: true });
          state.alerts[notice] = { window: id, index: follow.index, name: follow.name, thread: follow.thread };
          if (waiting) state.answerable[notice] = { window: id, thread: follow.thread };
        }
        saveState(state);
      } catch (err) {
        log(`follow-up failed: ${err.message}`);
      }
    };
    // The surest signal: a hook said a session finished a turn, or started
    // waiting, and that session's last prompt is the text the relay typed. It
    // works for any session, whatever tab or background process it runs in.
    const answered = events
      .filter((e) => (e.event === "done" || e.event === "waiting") && e.time * 1000 >= follow.sentAt - 1000 && e.transcript_path)
      .filter((e) => turnFrom(e.transcript_path, follow.text))
      .at(-1);
    // Remembered, since each event is read only once and the reply may not be
    // in the transcript yet.
    if (answered) follow.ended = { event: answered.event, transcript: answered.transcript_path, at: Date.now(), final: answered.last };
    // Claude has taken the message: a session's prompt hook fired with its
    // text, or the tab's transcript ends with it (a queued message may reach
    // the conversation without the hook), or the turn already ended. Your
    // message gets 👀. A tab that is idle and still hasn't taken it after
    // PICKUP_WARN_MS is probably showing a dialog, so its screen is posted.
    if (follow.request && !follow.taken) {
      const file = transcriptFor(id);
      follow.taken =
        Boolean(follow.ended) ||
        events.some((e) => e.event === "prompt" && e.time * 1000 >= follow.sentAt - 1000 && e.prompt && promptMatches(e.prompt, follow.text)) ||
        Boolean(file && turnFrom(file, follow.text));
      if (follow.taken) {
        saveState(state);
        await react(state, follow.request, "eyes").catch((err) => log(`👀 failed: ${err.message}`));
      } else if (!follow.warned && tab && tab.state !== "working" && Date.now() - follow.sentAt > PICKUP_WARN_MS) {
        follow.warned = true;
        saveState(state);
        await post(
          state,
          `🤖 ${name} hasn't taken your message after ${PICKUP_WARN_MS / 1000} seconds. It may be showing a prompt or a dialog.${onScreen(id, "")}`,
          follow.thread ?? undefined,
        ).catch((err) => log(`pickup warning failed: ${err.message}`));
      }
    }
    // A turn reported ended is posted once the transcript has caught up with
    // it (its last text is the final message the Stop hook gave, or without
    // one, it ends with Claude's text), or after REPLY_WAIT_MS, as it is.
    const replyPending = (file, since, final) =>
      file && !(final ? caughtUp(file, final) : turnWritten(file)) && Date.now() - since < REPLY_WAIT_MS;
    if (follow.ended) {
      const turn = turnFrom(follow.ended.transcript, follow.text, follow.ended.final) ?? lastTurn(id, follow.text);
      if (follow.ended.event === "waiting") {
        await finish(`${name} is waiting on you. Reply here to answer it:\n${turn}${tab ? onScreen(id, turn) : ""}`, { waiting: true });
      } else if (!replyPending(follow.ended.transcript, follow.ended.at, follow.ended.final)) {
        await finish(`${name} is done:\n${turn}`);
      }
      continue;
    }
    if (!tab) {
      await finish(`${name} has closed.`);
      continue;
    }
    const now = Date.now();
    const shown = () => `\n${lastTurn(id, follow.text)}`;
    const waited = () => {
      const turn = lastTurn(id, follow.text);
      return `\n${turn}${onScreen(id, turn)}`;
    };
    if (tab.state !== "idle" && Number(tab.since) * 1000 >= follow.sentAt - 1000) {
      if (tab.state === "done") {
        follow.doneAt ??= now;
        if (!replyPending(transcriptFor(id), follow.doneAt)) await finish(`${name} is done:${shown()}`);
      }
      else if (tab.state === "waiting") await finish(`${name} is waiting on you. Reply here to answer it:${waited()}`, { waiting: true });
      continue;
    }
    if (tab.state === "idle") {
      const current = screen(id);
      if (current !== follow.screen) {
        follow.screen = current;
        follow.changedAt = now;
      } else if (follow.changedAt && now - follow.changedAt >= QUIET_SCREEN_MS) {
        await finish(`${name} looks done (its screen stopped changing):${shown()}`);
        continue;
      }
    }
    if (now - follow.sentAt > FOLLOW_UP_LIMIT_MS) {
      await finish(`${name} is still going after an hour, so I stopped watching it. \`?\` here shows its screen.`);
    }
  }
};

module.exports = { newEvents, followUps };
