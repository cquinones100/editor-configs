// Part of bin/slack-relay; see the comment at the top of that file.

const fs = require("node:fs");
const { EVENTS_FILE, QUIET_SCREEN_MS, FOLLOW_UP_LIMIT_MS, PICKUP_WARN_MS, REPLY_WAIT_MS } = require("./config");
const { log } = require("./util");
const { react, unreact, remove, post, offerChoice, settleChoice } = require("./post");
const { saveState } = require("./state");
const { claudeTabs, transcriptFor, lastTurn, caughtUp, turnWritten, promptMatches, turnFrom, screen, onScreen, optionsIn, lastSaid } = require("./tabs");
const { optionButtons, turnButtons, workingButtons } = require("./buttons");
const { isHome } = require("./homes");
const { shareImages } = require("./files");

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

const followUps = async (state, current = claudeTabs(), events = newEvents(state)) => {
  const tabs = new Map(current.map((t) => [t.id, t]));
  for (const [id, follow] of Object.entries(state.following)) {
    const tab = tabs.get(id);
    const name = `tab ${follow.index}, ${follow.name}`;
    const finish = async (body, { waiting = false, done = false } = {}) => {
      delete state.following[id];
      if (follow.working) await remove(state, follow.working).catch((err) => log(`couldn't delete the working note: ${err.message}`));
      // What the tab shows now, not when this pass began: the turn has just
      // ended, and the state that says so is the one alertTabs would report.
      const now = claudeTabs().find((t) => t.id === id);
      const since = now?.since ?? tab?.since;
      if (since) state.reported[id] = since;
      saveState(state);
      // A wait gets its options as buttons; a finished turn, what you'd send
      // next. Nothing for a tab that has closed or is still going.
      const found = waiting && now ? optionsIn(screen(id)) : undefined;
      const said = done ? follow.ended?.final ?? lastSaid(follow.ended?.transcript ?? transcriptFor(id, now?.pid)) : undefined;
      const buttons = !now ? [] : found ? optionButtons(now, found) : done ? turnButtons(now, said) : [];
      try {
        // A request you sent from the main DM gets its answer there too, sent
        // from the tab's thread to the conversation.
        if (found) await settleChoice(state, id, "This prompt is no longer showing.");
        const ts = await post(state, `🤖 ${body}`, follow.thread ?? undefined, { broadcast: Boolean(follow.broadcast), buttons });
        if (found) offerChoice(state, id, "wait", ts, `🤖 ${body}`);
        // Your message's reaction: ✅ once its turn is answered.
        if (done && follow.request) {
          await unreact(state, follow.request, "eyes").catch(() => {});
          await react(state, follow.request, "white_check_mark").catch((err) => log(`✅ failed: ${err.message}`));
        }
        state.alerts[ts] = { window: id, index: follow.index, name: follow.name, thread: follow.thread ?? undefined };
        // Images the turn made go under it.
        await shareImages(state, follow.ended?.transcript ?? transcriptFor(id, tab?.pid), follow.thread ?? ts);
        // Otherwise, in a tab's home thread, a wait gets a line in the main DM.
        if (waiting && !follow.broadcast && follow.thread && isHome(state, follow.thread)) {
          const noticeText = `🤖 ${name} is **waiting on you**.`;
          const notice = await post(state, noticeText, follow.thread, { broadcast: true, buttons: found ? buttons : [] });
          state.alerts[notice] = { window: id, index: follow.index, name: follow.name, thread: follow.thread };
          if (found) offerChoice(state, id, "wait", notice, noticeText);
        }
        saveState(state);
      } catch (err) {
        log(`follow-up failed: ${err.message}`);
      }
    };
    // The surest signal: a hook said a session finished a turn, or started
    // waiting, and that session's last prompt is the text the relay typed. It
    // works for any session, whatever tab or background process it runs in.
    const ends = events
      .filter((e) => (e.event === "done" || e.event === "waiting") && e.time * 1000 >= follow.sentAt - 1000 && e.transcript_path)
      .filter((e) => turnFrom(e.transcript_path, follow.text));
    // This turn is the follow-up's to report, so alertTabs leaves its events be.
    ends.forEach((e) => (e.handled = true));
    const answered = ends.at(-1);
    // Remembered, since each event is read only once and the reply may not be
    // in the transcript yet.
    if (answered) follow.ended = { event: answered.event, transcript: answered.transcript_path, at: Date.now(), final: answered.last };
    // Claude has taken the message: a session's prompt hook fired with its
    // text, or the tab's transcript ends with it (a queued message may reach
    // the conversation without the hook), or the turn already ended. Your
    // message gets 👀. A tab that is idle and still hasn't taken it after
    // PICKUP_WARN_MS is probably showing a dialog, so its screen is posted.
    if (follow.request && !follow.taken) {
      const file = transcriptFor(id, tab?.pid);
      follow.taken =
        Boolean(follow.ended) ||
        events.some((e) => e.event === "prompt" && e.time * 1000 >= follow.sentAt - 1000 && e.prompt && promptMatches(e.prompt, follow.text)) ||
        Boolean(file && turnFrom(file, follow.text));
      if (follow.taken) {
        saveState(state);
        await unreact(state, follow.request, "hourglass_flowing_sand").catch(() => {});
        await react(state, follow.request, "eyes").catch((err) => log(`👀 failed: ${err.message}`));
        // While it runs, a message with Progress and Stop, where you asked;
        // deleted once the answer is posted (see finish). Not when the turn
        // has already ended.
        if (!follow.ended && tab) {
          follow.working = await post(state, "🤖 _Working on it._", follow.thread ?? undefined, { broadcast: Boolean(follow.broadcast), buttons: workingButtons(tab) })
            .catch((err) => log(`working note failed: ${err.message}`));
          saveState(state);
        }
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
        await finish(`${name} is done:\n${turn}`, { done: true });
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
        if (!replyPending(transcriptFor(id, tab.pid), follow.doneAt)) await finish(`${name} is done:${shown()}`, { done: true });
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
        await finish(`${name} looks done (its screen stopped changing):${shown()}`, { done: true });
        continue;
      }
    }
    if (now - follow.sentAt > FOLLOW_UP_LIMIT_MS) {
      await finish(`${name} is still going after an hour, so I stopped watching it. \`?\` here shows its screen.`);
    }
  }
};

module.exports = { newEvents, followUps };
