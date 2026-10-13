// Part of bin/slack-relay; see the comment at the top of that file.

const { log, tryTmux } = require("./util");
const { post, offerChoice, settleChoice } = require("./post");
const { saveState } = require("./state");
const { claudeTabs, label, lastTurn, lastSaid, screen, dialogIn, optionsIn, onScreen, transcriptFor, turnFrom } = require("./tabs");
const { optionButtons, dialogButtons, turnButtons } = require("./buttons");
const { presence } = require("./presence");
const { shareImages } = require("./files");
const { homeOf, closeHome } = require("./homes");

// ── Alerts ──────────────────────────────────────────────────────────────────

// A tab with no state is checked for a dialog at most this often: reading its
// screen is a tmux call, and the relay looks at its tabs every second.
const DIALOG_CHECK_MS = 5_000;
const dialogChecked = new Map();

// A line in the main DM pointing at a tab's thread, which is what notifies
// you. Everything else goes in the thread at once, so it is always complete;
// this line waits while you're at the computer (see presence).
// A notice for a prompt carries the prompt's buttons, so it can be answered
// from the notice itself, as long as the prompt is still showing when the
// notice goes out (`still`), since it may have waited for you to step away.
const notify = (state, text, home, target, { buttons = [], kind, still = () => true } = {}) =>
  presence.deliver(async () => {
    const live = buttons.length > 0 && still();
    const ts = await post(state, text, home, { broadcast: true, buttons: live ? buttons : [] });
    state.alerts[ts] = target;
    if (live) offerChoice(state, target.window, kind, ts, text);
    saveState(state);
  });

// A prompt that is no longer showing (answered at the computer, or the tab has
// moved on or closed) leaves no buttons behind (see offerChoice).
const PROMPT_GONE = "This prompt is no longer showing.";
const settleGone = async (state, tabs) => {
  for (const [id, offered] of Object.entries(state.choices ?? {})) {
    const tab = tabs.find((t) => t.id === id);
    const gone = !tab || (offered.kind === "wait" ? tab.state !== "waiting" : tab.state !== "idle");
    if (gone) await settleChoice(state, id, PROMPT_GONE);
  }
};

const alertTabs = async (state, tabs = claudeTabs(), events = []) => {
  await settleGone(state, tabs);
  // Homes of windows that have closed are forgotten. Only a home whose window
  // isn't a Claude tab needs tmux asked whether it is still open.
  const unsure = Object.keys(state.homes ?? {}).some((id) => !tabs.some((t) => t.id === id));
  const windows = unsure ? tryTmux(["list-windows", "-a", "-F", "#{window_id}"])?.split("\n") : undefined;
  if (windows && state.homes) {
    for (const id of Object.keys(state.homes).filter((id) => !windows.includes(id))) await closeHome(state, id);
  }
  // A tab with no state showing a dialog is waiting on you too, once per
  // dialog.
  for (const tab of tabs.filter((t) => t.state === "idle" && !state.following[t.id])) {
    if (Date.now() - (dialogChecked.get(tab.id) ?? 0) < DIALOG_CHECK_MS) continue;
    dialogChecked.set(tab.id, Date.now());
    const dialog = dialogIn(screen(tab.id));
    if (!dialog) {
      if (String(state.reported[tab.id] ?? "").startsWith("dialog:")) delete state.reported[tab.id];
      if (state.choices?.[tab.id]) await settleChoice(state, tab.id, PROMPT_GONE);
      continue;
    }
    const key = `dialog:${dialog.options.map((o) => o.label).join("|")}`;
    if (state.reported[tab.id] === key) continue;
    state.reported[tab.id] = key;
    try {
      const home = await homeOf(state, tab);
      const target = { window: tab.id, index: tab.index, name: tab.name, thread: home };
      const text =
        `🤖 **Tab ${tab.index}, ${tab.name}** is showing a dialog before its session starts, **waiting on you**:\n\n` +
        (dialog.question ? `**${dialog.question}**\n` : "") +
        dialog.options.map((o) => `${o.n}. ${o.label}${o.n === dialog.cursor ? " (selected)" : ""}`).join("\n") +
        "\n_Tap an option, or reply with its number or the start of it, and I'll move to it and press Enter._";
      await settleChoice(state, tab.id, PROMPT_GONE);
      const ts = await post(state, text, home, { buttons: dialogButtons(tab, dialog) });
      state.alerts[ts] = target;
      offerChoice(state, tab.id, "dialog", ts, text);
      await notify(state, `🤖 **Tab ${tab.index}, ${tab.name}** is showing a dialog, **waiting on you**.`, home, target, {
        buttons: dialogButtons(tab, dialog),
        kind: "dialog",
        still: () => state.reported[tab.id] === key,
      });
      log(`alert: ${label(tab)} dialog`);
    } catch (err) {
      delete state.reported[tab.id];
      log(`dialog alert failed: ${err.message}`);
    }
    saveState(state);
  }
  // A turn already posted from its hook event (below) whose tab is then marked
  // done, by focusing away from it, counts as reported.
  const postedTurn = (t) => t.state === "done" && Math.abs(Number(t.since) - (state.turnPosted?.[t.id] ?? -Infinity)) <= 10;
  const fresh = tabs.filter(
    (t) => (t.state === "waiting" || t.state === "done") && state.reported[t.id] !== t.since && !state.following[t.id] && !postedTurn(t),
  );
  // A turn that ends in the tab you're looking at is never marked done
  // (agent-state.sh): you saw it end. Its thread still gets it, from the hook's
  // event and the final message the event carries, so the thread is complete.
  const unseen = events
        .filter((e) => e.event === "done" && e.transcript_path && !e.handled)
        .flatMap((e) => {
          const tab = tabs.find((t) => transcriptFor(t.id, t.pid) === e.transcript_path);
          // Only the tab in front of you: any other is marked done in tmux,
          // and alerted from that below.
          if (!tab || !tab.focused || tab.state === "done" || tab.state === "waiting" || state.following[tab.id]) return [];
          return [{ ...tab, state: "done", since: `turn:${e.time}`, turn: turnFrom(e.transcript_path, undefined, e.last), transcript: e.transcript_path, said: e.last }];
        })
        .filter((t, i, all) => state.reported[t.id] !== t.since && all.findLastIndex((other) => other.id === t.id) === i);
  for (const tab of [...fresh, ...unseen]) {
    state.reported[tab.id] = tab.since;
    if (String(tab.since).startsWith("turn:")) (state.turnPosted ??= {})[tab.id] = Number(tab.since.slice(5));
    const what = tab.state === "waiting" ? "is **waiting on you**" : "has finished";
    const turn = tab.turn ?? lastTurn(tab.id);
    const shown = tab.state === "waiting" ? onScreen(tab.id, turn) : "";
    // A wait gets its options as buttons; a finished turn, what you'd send next.
    const found = tab.state === "waiting" ? optionsIn(screen(tab.id)) : undefined;
    const said = tab.state === "done" ? tab.said ?? lastSaid(tab.transcript ?? transcriptFor(tab.id, tab.pid)) : undefined;
    const buttons = found ? optionButtons(tab, found) : tab.state === "done" ? turnButtons(tab, said) : [];
    try {
      // The alert, in the tab's thread, carries what `?` would show, so the
      // answer or the question is readable without asking for it. The main DM
      // gets one line for a wait, which you can also answer.
      const home = await homeOf(state, tab);
      const target = { window: tab.id, index: tab.index, name: tab.name, thread: home };
      const text = `🤖 **Tab ${tab.index}, ${tab.name}** ${what}. Reply here to answer it.\n\n${turn}${shown}`;
      if (found) await settleChoice(state, tab.id, PROMPT_GONE);
      const ts = await post(state, text, home, { buttons });
      state.alerts[ts] = target;
      if (found) offerChoice(state, tab.id, "wait", ts, text);
      // Images the turn made go under it.
      await shareImages(state, tab.transcript ?? transcriptFor(tab.id, tab.pid), home ?? ts);
      // A tab waiting on you also gets a line in the main DM; one that has
      // finished doesn't, since its turn is already in its thread.
      const stillWaiting = () => claudeTabs().some((t) => t.id === tab.id && t.state === "waiting" && String(t.since ?? "") === String(tab.since ?? ""));
      if (tab.state === "waiting") await notify(state, `🤖 **Tab ${tab.index}, ${tab.name}** ${what}.`, home, target, { buttons: found ? buttons : [], kind: "wait", still: stillWaiting });
      log(`alert: ${label(tab)} ${tab.state}`);
    } catch (err) {
      delete state.reported[tab.id];
      log(`alert failed: ${err.message}`);
    }
    saveState(state);
  }
};

module.exports = { DIALOG_CHECK_MS, dialogChecked, notify, PROMPT_GONE, settleGone, alertTabs };
