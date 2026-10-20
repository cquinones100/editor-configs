// Part of bin/slack-relay; see the comment at the top of that file.

const { log, tryTmux } = require("./util");
const { placeChoices } = require("./places");
const { slack } = require("./slack");
const { post, buttonElement } = require("./post");
const { saveState, watchThread } = require("./state");
const { claudeTabs, label, relative, transcriptFor, lastPrompt, lastSaid, lastActivityAt, screen, optionsIn, dialogIn } = require("./tabs");
const { homeOf, homeThread, threadUrl } = require("./homes");
const { stillShowing, optionButtons, dialogButtons, closeButton } = require("./buttons");
const { handle, renameTab, closeTab, interrupt, forTab } = require("./commands");
const { progress } = require("./summaries");
const { HOME_WORDS, refreshDashboard } = require("./dashboard");
const { SKILL_NAME, MAX_SKILLS, skillsFor } = require("./skills");

// ── A tab's screen ──────────────────────────────────────────────────────────

// Tapping Open on a tab in the Home tab opens a modal for it: where it stands,
// its last prompt and the end of its last reply, the options of a prompt it is
// waiting on, and what you can do (message it, open its thread, ask its
// progress, rename, stop, close). Progress and Stop show their
// result in the modal itself; Message and Rename open a second screen with a
// field. Every button names the tab's window and process, so a screen left
// open after the tab has closed can't act on a tab that has since taken its
// place. While a screen is open, it is drawn again whenever its tab's state
// changes (see refreshScreens), so it never shows a prompt that has gone.

const clip = (text, max) => {
  const flat = String(text ?? "").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
const running = (tab) => tab.state === "working" || tab.state === "waiting";

// The screens open now, by view ID: the tab each is for, and the state it was
// drawn in. Slack says when one is closed (notify_on_close); one it never
// says that of is forgotten after SCREEN_KEEP_MS.
const SCREEN_KEEP_MS = 60 * 60_000;
const openScreens = new Map();
const remember = (viewId, tab) => viewId && openScreens.set(viewId, { w: tab.id, p: String(tab.pid ?? ""), state: tab.state, since: String(tab.since ?? ""), at: Date.now() });
const forgetScreen = (viewId) => openScreens.delete(viewId);

// The prompt a waiting tab shows, or a dialog before its session starts, as
// buttons that answer only that prompt (see stillShowing).
const choiceBlocks = (tab) => {
  const found = tab.state === "waiting" ? optionsIn(screen(tab.id)) : undefined;
  const dialog = !found && dialogIn(screen(tab.id));
  const buttons = found ? optionButtons(tab, found) : dialog ? dialogButtons(tab, dialog) : [];
  if (!buttons.length) return [];
  return [
    { type: "section", text: { type: "mrkdwn", text: "🔴 *It's asking you to choose:*" } },
    { type: "actions", elements: buttons.slice(0, 25).map((b) => ({ ...b, value: { ...b.value, a: `screen-${b.value.a}`, p: String(tab.pid ?? "") } })).map(buttonElement) },
  ];
};

// The modal, as Block Kit. `note` is a line at the bottom: what a button just
// did, or a progress summary.
const tabScreen = (state, tab, note) => {
  const file = transcriptFor(tab.id, tab.pid);
  const turn = file && lastPrompt(file);
  const said = file && lastSaid(file);
  const lastAt = file && lastActivityAt(file);
  const thread = homeThread(state, tab);
  const url = thread && threadUrl(state, thread);
  const value = (a) => ({ a, w: tab.id, p: String(tab.pid ?? "") });
  return {
    type: "modal",
    callback_id: "tab",
    notify_on_close: true,
    private_metadata: JSON.stringify({ w: tab.id, p: String(tab.pid ?? "") }),
    // Slack cuts a modal's title at 24 characters; the full name is under it.
    title: { type: "plain_text", text: clip(`${tab.index} · ${String(tab.name).replace(/\s+/g, " ")}`, 24) },
    close: { type: "plain_text", text: "Done" },
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            `*${clip(tab.name, 150)}*\n${HOME_WORDS[tab.state] ?? tab.state}` +
            (tab.since ? ` for ${relative(Date.now() - Number(tab.since) * 1000).replace(/ ago$/, "")}` : "") +
            (lastAt ? ` · last activity ${relative(Date.now() - lastAt)}` : ""),
        },
      },
      ...(turn ? [{ type: "section", text: { type: "plain_text", text: `${turn.background ? "Background task" : "You asked"}: ${clip(turn.prompt, 400)}` } }] : []),
      ...(said ? [{ type: "section", text: { type: "mrkdwn", text: `*Claude said:*\n${asMrkdwn(clip(said, 1500))}` } }] : []),
      ...choiceBlocks(tab),
      {
        type: "actions",
        elements: [
          { text: "Message", value: value("screen-message"), style: "primary" },
          { text: "Skill", value: value("screen-skill") },
          ...(url ? [{ text: "Go to thread", url }] : []),
          { text: "Progress", value: value("screen-progress") },
          { text: "Rename", value: value("screen-rename") },
          ...(running(tab) ? [{ text: "Stop", value: value("screen-stop") }] : []),
          { ...closeButton(tab), value: value("screen-close") },
        ].map(buttonElement),
      },
      ...(note ? [{ type: "divider" }, { type: "section", text: { type: "mrkdwn", text: clip(note, 2900) } }] : []),
    ],
  };
};

// The second screens, each a field or two: Rename's holds the name it has
// now. Their title is the tab's, cut as Slack cuts it, so the field's label
// names the tab in full. `from` says whether it was opened over the tab's
// screen, which is drawn again with what was done, or from a button in its
// thread.
const fieldScreen = (tab, { callback, submit, block, blocks = [block], from = "screen" }) => ({
  type: "modal",
  callback_id: callback,
  private_metadata: JSON.stringify({ w: tab.id, p: String(tab.pid ?? ""), from }),
  title: { type: "plain_text", text: clip(`${tab.index} · ${String(tab.name).replace(/\s+/g, " ")}`, 24) },
  submit: { type: "plain_text", text: submit },
  close: { type: "plain_text", text: from === "screen" ? "Back" : "Cancel" },
  blocks,
});
const renameScreen = (tab, current, from = "screen") =>
  fieldScreen(tab, {
    callback: "rename",
    submit: "Save",
    from,
    block: {
      type: "input",
      block_id: "name",
      optional: true,
      label: { type: "plain_text", text: clip(`New name for tab ${tab.index}, ${tab.name}`, 2000) },
      hint: { type: "plain_text", text: "Leave it empty for the tab's own name (its ticket or directory)." },
      element: { type: "plain_text_input", action_id: "name", max_length: 60, ...(current ? { initial_value: current } : {}) },
    },
  });
const messageScreen = (tab) =>
  fieldScreen(tab, {
    callback: "message",
    submit: "Send",
    block: {
      type: "input",
      block_id: "text",
      label: { type: "plain_text", text: clip(`Message to tab ${tab.index}, ${tab.name}`, 2000) },
      hint: { type: "plain_text", text: "Typed into its Claude, as a reply in its thread would be. The answer goes in its thread." },
      element: { type: "plain_text_input", action_id: "text", multiline: true, focus_on_load: true },
    },
  });

// Skill: a menu of the skills the tab can run (see skills.js), and what
// follows the name. Slack would take a message starting with "/" for its own
// command; a form has no such problem. The menu is grouped the ones you use
// most, yours, the project's, then the rest, and when a tab has more than a menu holds, the
// rest is cut and a field takes any name.
const SKILL_GROUPS = { frequent: "Frequently used", yours: "Yours", project: "This project", session: "Plugins and built-in" };
//
// Picking a skill draws the form again (see handleScreenPress), so the
// Arguments field can say what that skill takes, from its argument-hint.
// `chosen` and `args` are the pick and what was typed so far.
const skillScreen = (tab, from, chosen, args = "") => {
  const skills = skillsFor(tab);
  const shown = skills.slice(0, MAX_SKILLS);
  const cut = skills.length > shown.length;
  const option = (skill) => ({
    text: { type: "plain_text", text: clip(skill.name, 75) },
    value: skill.name,
    ...(skill.description ? { description: { type: "plain_text", text: clip(skill.description, 75) } } : {}),
  });
  const groups = Object.entries(SKILL_GROUPS)
    .map(([source, label]) => ({ label: { type: "plain_text", text: label }, options: shown.filter((skill) => skill.source === source).map(option) }))
    .filter((group) => group.options.length);
  const picked = shown.find((skill) => skill.name === chosen);
  const menu = shown.length
    ? [{
        type: "input",
        block_id: "skill",
        optional: cut,
        dispatch_action: true,
        label: { type: "plain_text", text: clip(`Skill for tab ${tab.index}, ${tab.name}`, 2000) },
        element: { type: "static_select", action_id: "skill", placeholder: { type: "plain_text", text: "Choose or type to search" }, option_groups: groups, ...(picked ? { initial_option: option(picked) } : {}) },
      }]
    : [];
  const typed = cut || !shown.length
    ? [{
        type: "input",
        block_id: "typed",
        optional: Boolean(shown.length),
        label: { type: "plain_text", text: shown.length ? `Or another skill (${skills.length - shown.length} more aren't in the menu)` : clip(`Skill for tab ${tab.index}, ${tab.name}`, 2000) },
        element: { type: "plain_text_input", action_id: "typed", placeholder: { type: "plain_text", text: "review-loop" } },
      }]
    : [];
  return fieldScreen(tab, {
    callback: "skill",
    submit: "Run",
    from,
    blocks: [
      ...menu,
      ...typed,
      {
        type: "input",
        block_id: "args",
        optional: true,
        label: { type: "plain_text", text: "Arguments" },
        hint: {
          type: "plain_text",
          text: clip(
            `${picked ? (picked.hint ? `/${picked.name} takes ${picked.hint}.` : `/${picked.name} doesn't say what it takes.`) : "What you'd type after the skill's name."} Runs as a reply in its thread would; the answer goes there.`,
            2000,
          ),
        },
        element: {
          type: "plain_text_input",
          action_id: "args",
          multiline: true,
          placeholder: { type: "plain_text", text: clip(picked?.hint || "ABC-123, or a description", 150) },
          ...(args ? { initial_value: args } : {}),
        },
      },
    ],
  });
};

// The Home tab's New tab: where, and the prompt, as `new <place>: <prompt>`.
// Where is a menu of every directory you have run Claude in (see
// placeChoices), and a field beside it takes anything else `new <place>:`
// does: a repository, a ticket or branch with a worktree, or a path.
const newScreen = () => {
  const groups = placeChoices().map(({ group, choices }) => ({
    label: { type: "plain_text", text: clip(group, 75) },
    options: choices.map((choice) => ({ text: { type: "plain_text", text: clip(choice.label, 75) }, value: choice.value })),
  }));
  return {
    type: "modal",
    callback_id: "new",
    title: { type: "plain_text", text: "New Claude tab" },
    submit: { type: "plain_text", text: "Start" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      ...(groups.length
        ? [{
            type: "input",
            block_id: "place",
            optional: true,
            label: { type: "plain_text", text: "Where" },
            hint: { type: "plain_text", text: "Every directory you have run Claude in, most recent first. Empty: the relay's directory." },
            element: { type: "static_select", action_id: "place", placeholder: { type: "plain_text", text: "Choose or type to search" }, option_groups: groups },
          }]
        : []),
      {
        type: "input",
        block_id: "typed",
        optional: true,
        label: { type: "plain_text", text: groups.length ? "Or somewhere else" : "Where" },
        hint: { type: "plain_text", text: "A repository, a ticket or branch with a worktree, or a path. Used instead of the menu." },
        element: { type: "plain_text_input", action_id: "typed", max_length: 200 },
      },
      {
        type: "input",
        block_id: "prompt",
        label: { type: "plain_text", text: "Prompt" },
        element: { type: "plain_text_input", action_id: "prompt", multiline: true, focus_on_load: true },
      },
    ],
  };
};

// A tab that has closed, or was just closed.
const goneScreen = (note = "That tab has closed.") => ({
  type: "modal",
  callback_id: "gone",
  title: { type: "plain_text", text: "Tab" },
  close: { type: "plain_text", text: "Done" },
  blocks: [{ type: "section", text: { type: "mrkdwn", text: note } }],
});

// The tab a button or field was made for, if it is still the same tab.
const sameTab = ({ w, p }) => claudeTabs().find((t) => t.id === w && t.pids.includes(p));

// The name set with M-n or `rename`, not the one the tab would have anyway.
const tmuxName = (tab) => (tryTmux(["show-options", "-wqv", "-t", tab.id, "@tab_name"]) ?? "").trim();

// Markdown, as Claude and the relay's replies are written, in Slack's older
// mrkdwn, the only formatting a modal renders: headings and **bold** become
// *bold*, *italic* _italic_, [links](…) <…|links>, and list items bullets.
// Code is left as it is (mrkdwn has the same backticks), and &, < and > are
// escaped everywhere, as mrkdwn needs.
const asMrkdwn = (markdown) => {
  const escape = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const prose = (text) =>
    escape(text)
      .replace(/^#{1,6}[ \t]+(.+?)[ \t]*#*$/gm, "**$1**")
      .replace(/(?<![*\w])\*(?!\*)([^*\n]+?)(?<!\*)\*(?![*\w])/g, "_$1_")
      .replace(/\*\*([^*\n]+?)\*\*/g, "*$1*")
      .replace(/__([^_\n]+?)__/g, "*$1*")
      .replace(/~~([^~\n]+?)~~/g, "~$1~")
      .replace(/\[([^\]\n]+)\]\((https?:[^)\s]+)\)/g, "<$2|$1>")
      .replace(/^([ \t]*)[-*+][ \t]+/gm, "$1• ");
  // Fenced blocks, then inline code, are kept out of the changes above.
  return String(markdown ?? "")
    .split(/(```[\s\S]*?```)/)
    .map((part, i) => (i % 2 ? escape(part) : part.split(/(`[^`\n]+`)/).map((bit, j) => (j % 2 ? escape(bit) : prose(bit))).join("")))
    .join("");
};

// Draws a tab's screen again, or says the tab has gone.
const redraw = async (state, viewId, meta, note) => {
  const tab = sameTab(meta);
  try {
    await slack.api("views.update", { view_id: viewId, view: tab ? tabScreen(state, tab, note) : goneScreen() });
    if (tab) remember(viewId, tab);
    else forgetScreen(viewId);
  } catch (err) {
    // A screen you have closed is gone from Slack (not_found), which is nothing
    // to report: it is only forgotten.
    if (!/not_found/.test(err.message)) log(`screen update failed: ${err.message}`);
    forgetScreen(viewId);
  }
};

// The tab's thread, made if it has none yet, and linked to the tab.
const threadFor = async (state, tab) => {
  const home = await homeOf(state, tab);
  if (!home) return undefined;
  watchThread(state, home);
  state.alerts[home] ??= { window: tab.id, index: tab.index, name: tab.name };
  return home;
};

// What you send from a screen is said in the tab's thread, then handled as
// a reply there: so it is typed in only as a thread reply would be (a choice
// still refuses anything but one of its options), and gets the same
// reactions and answer.
const sendFromScreen = async (state, tab, text, said) => {
  const home = await threadFor(state, tab);
  if (!home) return undefined;
  const ts = await post(state, `🤖 ${said}`, home);
  // Straight to the tab the screen is for, as what you typed: never read as a
  // command, and never through the thread's link to a tab.
  await forTab(state, tab, { thread: home, request: ts, text });
  return home;
};

const linkTo = (state, home) => (home ? `<${threadUrl(state, home)}|its thread>` : "its thread");

// A press on the Home tab's Open or New tab, on a button in a tab's screen,
// or on Skill under a finished turn in its thread.
const handleScreenPress = async (state, { value, view, triggerId, thread }) => {
  if (value.a === "new") return slack.api("views.open", { trigger_id: triggerId, view: newScreen() });
  const tab = sameTab(value);
  // A skill picked in the Skill form: drawn again to say what it takes. The
  // hash makes Slack refuse it if the form has changed since, which is fine.
  if (value.a === "skill-chosen") {
    if (!tab) return undefined;
    return slack.api("views.update", { view_id: view.id, ...(view.hash ? { hash: view.hash } : {}), view: skillScreen(tab, value.from, value.skill, value.args) })
      .catch((err) => log(`couldn't redraw the Skill form: ${err.message}`));
  }
  // An option on the Home tab, answered as a reply in its thread would be; the
  // Home tab is then drawn again, without it.
  if (value.a === "home-opt" || value.a === "home-dialog") {
    const shown = tab && stillShowing({ ...value, a: value.a.replace("home-", "") });
    if (shown) await sendFromScreen(state, tab, shown.option.answer, `_From the Home tab:_ chose **${shown.option.said}**`);
    return refreshDashboard(state, { quick: true, opened: true });
  }
  // Skill and Rename on a message in a tab's thread open their form on its own.
  if (value.a === "skill" || value.a === "rename") {
    if (!tab) return post(state, "🤖 That tab has closed, or is running a different session now.", thread);
    const view = value.a === "skill" ? skillScreen(tab, "thread") : renameScreen(tab, tmuxName(tab), "thread");
    return slack.api("views.open", { trigger_id: triggerId, view });
  }
  const show = (note) => redraw(state, view.id, value, note);
  if (value.a === "open") {
    if (!tab) return refreshDashboard(state, { quick: true, opened: true });
    const opened = await slack.api("views.open", { trigger_id: triggerId, view: tabScreen(state, tab) });
    return remember(opened.view?.id, tab);
  }
  if (!tab) return show();
  if (value.a === "screen-rename") return slack.api("views.push", { trigger_id: triggerId, view: renameScreen(tab, tmuxName(tab)) });
  if (value.a === "screen-message") return slack.api("views.push", { trigger_id: triggerId, view: messageScreen(tab) });
  if (value.a === "screen-skill") return slack.api("views.push", { trigger_id: triggerId, view: skillScreen(tab, "screen") });
  if (value.a === "screen-opt" || value.a === "screen-dialog") {
    const shown = stillShowing({ ...value, a: value.a.replace("screen-", "") });
    if (!shown) return show("That choice isn't showing any more, so I didn't press anything.");
    const home = await sendFromScreen(state, tab, shown.option.answer, `_From the Home tab:_ chose **${shown.option.said}**`);
    return show(`Chose *${shown.option.said}*. What happens next goes in ${linkTo(state, home)}.`);
  }
  if (value.a === "screen-progress") {
    await show("_Asking what it's doing…_");
    return progress(state, tab, (text) => show(asMrkdwn(text)), undefined);
  }
  if (value.a === "screen-stop") return interrupt(state, tab, (text) => show(asMrkdwn(text)));
  if (value.a === "screen-close") {
    await closeTab(state, tab);
    saveState(state);
    forgetScreen(view.id);
    await slack.api("views.update", { view_id: view.id, view: goneScreen(`Closed ${label(tab)}.`) }).catch(() => {});
    return refreshDashboard(state, { quick: true, opened: true });
  }
  return undefined;
};

// Send or Save on a field's screen, or Start on New tab. Slack closes that
// screen when the relay acknowledges it, which it does at once, so the tab's
// screen under it is drawn again with what was done.
const handleSubmission = async (state, form) => {
  if (form.kind === "new") {
    const place = (form.values.typed.trim() || form.values.place).replace(/[\s:]+/g, " ").trim();
    const prompt = form.values.prompt.trim();
    if (!prompt) return undefined;
    return handle(state, { ts: (Date.now() / 1000).toFixed(6), text: `new${place ? ` ${place}` : ""}: ${prompt}`, thread_ts: null, fresh: true });
  }
  const tab = sameTab(form.meta);
  const overScreen = form.meta.from !== "thread";
  if (!tab) return overScreen ? redraw(state, form.rootView, form.meta) : undefined;
  if (form.kind === "rename") {
    await renameTab(tab, form.values.name, async (text) =>
      overScreen ? redraw(state, form.rootView, form.meta, asMrkdwn(text)) : post(state, `🤖 ${text}`, homeThread(state, tab)),
    );
    return refreshDashboard(state, { quick: true, opened: true });
  }
  if (form.kind === "skill") {
    const name = (form.values.typed.trim() || form.values.skill.trim()).replace(/^\//, "");
    if (!name) return overScreen ? redraw(state, form.rootView, form.meta, "No skill was chosen, so I didn't run anything.") : undefined;
    if (!SKILL_NAME.test(name)) return overScreen ? redraw(state, form.rootView, form.meta, `\`${name}\` isn't a skill name, so I didn't run anything.`) : undefined;
    const text = `/${name}${form.values.args.trim() ? ` ${form.values.args.trim()}` : ""}`;
    const home = await sendFromScreen(state, tab, text, `_Skill:_ \`${text}\``);
    return overScreen ? redraw(state, form.rootView, form.meta, `Ran \`${asMrkdwn(text)}\`. The answer goes in ${linkTo(state, home)}.`) : undefined;
  }
  if (form.kind === "message") {
    const text = form.values.text.trim();
    if (!text) return undefined;
    const home = await sendFromScreen(state, tab, text, `_From the Home tab:_ ${text}`);
    return redraw(state, form.rootView, form.meta, `Sent. The answer goes in ${linkTo(state, home)}.`);
  }
  return undefined;
};

// Every tick: an open screen whose tab has changed state is drawn again, and
// one whose tab has closed says so.
const refreshScreens = async (state, tabs = claudeTabs()) => {
  for (const [viewId, open] of openScreens) {
    if (Date.now() - open.at > SCREEN_KEEP_MS) {
      forgetScreen(viewId);
      continue;
    }
    const tab = tabs.find((t) => t.id === open.w && String(t.pid ?? "") === open.p);
    if (tab && tab.state === open.state && String(tab.since ?? "") === open.since) continue;
    await redraw(state, viewId, open);
  }
};

module.exports = { skillScreen, asMrkdwn, SCREEN_KEEP_MS, openScreens, forgetScreen, tabScreen, renameScreen, messageScreen, newScreen, goneScreen, handleScreenPress, handleSubmission, refreshScreens };
