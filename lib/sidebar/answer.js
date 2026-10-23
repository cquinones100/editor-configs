// Part of bin/tmux-sidebar; see the comment at the top of that file.
//
// Answering a tab from mission control, as the Slack relay does from a
// thread: the question or permission prompt it shows, read off its screen,
// and your answer pressed there. The reading and pressing are the relay's own
// (lib/slack-relay/tabs.js), so the two answer alike. A tab showing no prompt
// takes what you type as a message, Enter and all.

const { optionsIn, answerFor, answerPrompt, answerSaid, typeInto } = require("../slack-relay/tabs");
const { tryTmux } = require("./tmux");

// The prompt a tab's Claude pane shows, or undefined.
const promptOf = async (tab) => {
  if (!tab?.claudePane) return undefined;
  const text = await tryTmux(["capture-pane", "-p", "-J", "-t", tab.claudePane, "-S", "-60"]);
  return text ? optionsIn(text) : undefined;
};

// Presses `reply` in the tab: an option's number, its start, "submit", your
// own answer to a question that takes one, or, with no prompt showing, a
// message. Returns what was done, in words, or why nothing was.
const answer = async (tab, reply) => {
  if (!tab?.claudePane) return "That tab has no Claude to answer.";
  const found = await promptOf(tab);
  if (found) {
    const pressed = answerFor(found, reply);
    if (!pressed) return `"${reply}" isn't one of its options.`;
    answerPrompt(tab.claudePane, found, pressed);
    return answerSaid(pressed);
  }
  if (!reply.trim()) return "Nothing to send.";
  typeInto(tab.claudePane, reply);
  return "Sent.";
};

module.exports = { promptOf, answer };
