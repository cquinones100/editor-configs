// Part of bin/slack-relay; see the comment at the top of that file.

const { log, tryTmux } = require("./util");
const { post } = require("./post");
const { saveState } = require("./state");
const { claudeTabs, label, lastTurn, screen, dialogIn, onScreen } = require("./tabs");
const { homeOf } = require("./homes");

// ── Alerts ──────────────────────────────────────────────────────────────────

const alertTabs = async (state) => {
  const tabs = claudeTabs();
  // Homes of windows that have closed are forgotten.
  const windows = tryTmux(["list-windows", "-a", "-F", "#{window_id}"])?.split("\n");
  if (windows && state.homes) {
    Object.keys(state.homes).filter((id) => !windows.includes(id)).forEach((id) => delete state.homes[id]);
  }
  // A message stops waiting on an answer once its tab isn't waiting.
  Object.entries(state.answerable ?? {}).forEach(([ts, a]) => {
    if (tabs.find((t) => t.id === a.window)?.state !== "waiting") delete state.answerable[ts];
  });
  // A tab with no state showing a dialog is waiting on you too, once per
  // dialog. No reactions here: in "trust this folder", option 1 is "No, exit".
  for (const tab of tabs.filter((t) => t.state === "idle" && !state.following[t.id])) {
    const dialog = dialogIn(screen(tab.id));
    if (!dialog) {
      if (String(state.reported[tab.id] ?? "").startsWith("dialog:")) delete state.reported[tab.id];
      continue;
    }
    const key = `dialog:${dialog.options.map((o) => o.label).join("|")}`;
    if (state.reported[tab.id] === key) continue;
    state.reported[tab.id] = key;
    try {
      const home = await homeOf(state, tab);
      const target = { window: tab.id, index: tab.index, name: tab.name, thread: home };
      const ts = await post(
        state,
        `🤖 Tab ${tab.index}, ${tab.name} is showing a dialog before its session starts, *waiting on you*:\n` +
          (dialog.question ? `*${dialog.question}*\n` : "") +
          dialog.options.map((o) => `${o.n}. ${o.label}${o.n === dialog.cursor ? " (selected)" : ""}`).join("\n") +
          "\n_Reply with a number or the start of an option, and I'll move to it and press Enter._",
        home,
      );
      const notice = await post(state, `🤖 Tab ${tab.index}, ${tab.name} is showing a dialog, *waiting on you*.`, home, { broadcast: true });
      state.alerts[ts] = target;
      state.alerts[notice] = target;
      log(`alert: ${label(tab)} dialog`);
    } catch (err) {
      delete state.reported[tab.id];
      log(`dialog alert failed: ${err.message}`);
    }
    saveState(state);
  }
  const fresh = tabs.filter(
    (t) => (t.state === "waiting" || t.state === "done") && state.reported[t.id] !== t.since && !state.following[t.id],
  );
  for (const tab of fresh) {
    state.reported[tab.id] = tab.since;
    const what = tab.state === "waiting" ? "is *waiting on you*" : "has finished";
    try {
      // The alert, in the tab's thread, carries what `?` would show, so the
      // answer or the question is readable without asking for it. The main DM
      // gets one line, which you can also answer or react to.
      const home = await homeOf(state, tab);
      const turn = lastTurn(tab.id);
      const target = { window: tab.id, index: tab.index, name: tab.name, thread: home };
      const ts = await post(
        state,
        `🤖 Tab ${tab.index}, ${tab.name} ${what}. Reply here to answer it.\n${turn}${tab.state === "waiting" ? onScreen(tab.id, turn) : ""}`,
        home,
        { title: `${label(tab)} ${tab.state === "waiting" ? "is waiting" : "finished"}` },
      );
      const notice = await post(state, `🤖 Tab ${tab.index}, ${tab.name} ${what}.`, home, { broadcast: true });
      state.alerts[ts] = target;
      state.alerts[notice] = target;
      if (tab.state === "waiting") {
        (state.answerable ??= {})[ts] = { window: tab.id, thread: home ?? ts };
        state.answerable[notice] = { window: tab.id, thread: home ?? ts };
      }
      log(`alert: ${label(tab)} ${tab.state}`);
    } catch (err) {
      delete state.reported[tab.id];
      log(`alert failed: ${err.message}`);
    }
    saveState(state);
  }
};

module.exports = { alertTabs };
