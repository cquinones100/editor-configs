// Part of bin/slack-relay; see the comment at the top of that file.

const { log } = require("./util");
const { post } = require("./post");
const { claudeTabs, label, screen, optionsIn } = require("./tabs");
const { handle } = require("./commands");

// ── Answers by reaction ──────────────────────────────────────────────────

// An emoji on a tab's alert, or on anything the relay posted about a tab,
// answers it as a reply would: 👍 picks option 1 of the prompt a waiting tab
// is showing, ✋ presses Escape, 🔁 types "continue". Each emoji on each
// message counts once (`state.reactedTo`), and 👍 only while the tab is
// still waiting with options on screen, so a late 👍 can't type "1" into a
// prompt nobody is asking.
const REACTION_ANSWERS = {
  "+1": "1", thumbsup: "1", white_check_mark: "1", heavy_check_mark: "1",
  raised_hand: "esc", hand: "esc", octagonal_sign: "esc",
  repeat: "continue", arrows_counterclockwise: "continue", fast_forward: "continue",
};

const answerReactions = (state, reactions) =>
  reactions.flatMap(({ ts, names }) => {
    const alert = state.alerts[ts];
    if (!alert) return [];
    const done = ((state.reactedTo ??= {})[ts] ??= []);
    return names
      .filter((name) => REACTION_ANSWERS[name] && !done.includes(name))
      .map((name) => {
        done.push(name);
        const answer = REACTION_ANSWERS[name];
        const thread = state.answerable?.[ts]?.thread ?? alert.thread ?? ts;
        return async () => {
          log(`reaction :${name}: on ${ts}`);
          const tab = claudeTabs().find((t) => t.id === alert.window);
          if (answer === "1" && (tab?.state !== "waiting" || !optionsIn(screen(alert.window)))) {
            return post(state, `🤖 ${label(tab ?? alert)} isn't waiting on a choice any more, so your :${name}: did nothing.`, thread);
          }
          return handle(state, { ts, text: answer, thread_ts: thread, fresh: true, request: ts });
        };
      });
  });

module.exports = { REACTION_ANSWERS, answerReactions };
