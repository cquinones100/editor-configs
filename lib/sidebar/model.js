// Part of bin/tmux-sidebar; see the comment at the top of that file.

const { MARK } = require("./config");
const fs = require("node:fs");
const { sessionsByPane, transcriptFor, backgroundWork } = require("./claude");

// When an idle tab last did anything, in seconds: a Claude tab's last word in
// its conversation, else the last output to its pane's terminal, which the
// terminal device's modified time records. tmux's own window_activity can't
// say, since the sidebar in the window draws to it all the time.
const idleSince = (claude, tty) => {
  const file = claude && transcriptFor(claude);
  try {
    return Math.floor(fs.statSync(file ?? tty).mtimeMs / 1000);
  } catch {
    return undefined;
  }
};

// Most in need of you first: a Claude session waiting on you, then one that
// finished while you were elsewhere, then one working, then the rest. The same
// order agent-state.sh rolls a window's panes up into @agent by. A Claude tab
// whose turn ended with background tasks still running (a review loop, a CI
// watch) is "background": Claude carries on when they end, so it is working,
// not waiting for you.
const RANK = { waiting: 0, done: 1, working: 2, background: 2, idle: 3 };

// One tab per window, from a tmux snapshot. Sidebar panes are left out of
// everything but `sidebar`, the window's own.
const tabsFrom = (snap) => {
  const claude = sessionsByPane();
  const windows = new Map();
  snap.panes.forEach((p) => {
    if (!windows.has(p.window_id)) {
      // window-names.sh keeps the whole label, PR number in front, in
      // @tab_label, and the project's accent color in the tab's format.
      const label = p["@tab_label"] || p.window_name;
      const pr = /^#(\d+) /.exec(label)?.[1];
      windows.set(p.window_id, {
        id: p.window_id,
        index: Number(p.window_index),
        session: p.session_id,
        sessionName: p.session_name,
        attached: p.session_attached !== "0",
        current: p.window_active === "1",
        width: Number(p.window_width),
        zoomed: p.window_zoomed_flag === "1",
        name: pr ? label.slice(pr.length + 2) : label,
        pr,
        color: /fg=#([0-9a-fA-F]{6})/.exec(p["window-status-format"])?.[1],
        state: p["@agent"] || "idle",
        // Flagged by hand (the M-p action) as needing you, until unflagged.
        flagged: p["@flagged"] === "1",
        // A window holding a pane while a tool stands in for it (tmux/pane-in-place.sh).
        parked: p["@pane_parked"] === "1",
        panes: [],
        sidebars: [],
      });
    }
    const tab = windows.get(p.window_id);
    if (p[MARK] === "1" || p.pane_title === "tmux-sidebar") tab.sidebars.push(p);
    else tab.panes.push(p);
  });
  return [...windows.values()].map((tab) => {
    const active = tab.panes.find((p) => p.pane_active === "1") ?? tab.panes[0];
    // The pane whose state the window shows, and since when: the earliest of
    // the panes in that state.
    const inState = tab.panes.filter((p) => p["@agent_state"] === tab.state).sort((a, b) => Number(a["@agent_since"]) - Number(b["@agent_since"]));
    const claudePane = inState[0] ?? tab.panes.find((p) => claude.has(p.pane_id));
    const session = claudePane && claude.get(claudePane.pane_id);
    const work = session && (tab.state === "done" || tab.state === "idle") ? backgroundWork(transcriptFor(session), session.startedAt) : { count: 0 };
    return {
      ...tab,
      state: work.count ? "background" : tab.state,
      background: work.count,
      // The loop running, { kind, round }, when the work is one (see claude.js).
      loop: work.loop,
      // What Claude is doing, and what it waits on, as agent-state.sh records
      // them from its hooks.
      activity: claudePane?.["@agent_activity"] || undefined,
      wait: claudePane?.["@agent_wait"] || undefined,
      // The loop the session is running, from when its skill was asked for.
      loopSkill: claudePane?.["@agent_loop"] || undefined,
      since: tab.state === "idle" ? idleSince(session, active?.pane_tty) : Number(inState[0]?.["@agent_since"]) || undefined,
      path: active?.pane_current_path,
      command: active?.pane_current_command,
      claudePane: claudePane?.pane_id,
      claude: session,
      sidebar: tab.sidebars[0],
      sidebarActive: tab.sidebars.some((p) => p.pane_active === "1"),
    };
  });
};

const byNeed = (a, b) =>
  RANK[a.state] - RANK[b.state] ||
  (a.state === "waiting" || a.state === "done" ? (a.since ?? 0) - (b.since ?? 0) : 0) ||
  a.index - b.index;

// Grouped for drawing: [{ title, tabs }], in this order, empty groups left
// out. A tab is in one group: Needs you whenever Claude waits on you or has
// finished there; otherwise In merge queue or Merged when its PR is (see
// prs.js, which sets tab.merge), even while Claude works in it; otherwise by
// its state. The queue is in queue order.
const GROUPS = [
  { key: "needs", title: "Needs you" },
  { key: "working", title: "Working" },
  { key: "queued", title: "In merge queue", order: (a, b) => (a.position ?? Infinity) - (b.position ?? Infinity) || byNeed(a, b) },
  { key: "merged", title: "Merged" },
  { key: "idle", title: "Idle" },
];
const groupOf = (tab) =>
  tab.state === "waiting" || tab.state === "done" || tab.flagged ? "needs" : tab.merge === "queued" || tab.merge === "merged" ? tab.merge : tab.state === "working" || tab.state === "background" ? "working" : "idle";
// `frozen`, a layout from frozenFrom, keeps each tab it knows in the group
// and place it had then, whatever its state since; a tab opened since goes
// where its state puts it, after them.
const grouped = (tabs, frozen) =>
  GROUPS.map((group) => ({
    title: group.title,
    tabs: tabs
      .filter((t) => (frozen?.get(t.id)?.group ?? groupOf(t)) === group.key)
      .sort((a, b) => (frozen?.get(a.id)?.at ?? Infinity) - (frozen?.get(b.id)?.at ?? Infinity) || (group.order ?? byNeed)(a, b)),
  })).filter((g) => g.tabs.length);
// Each tab's group and place as grouped lays them out now: window ID ->
// { group, at }.
const frozenFrom = (tabs) =>
  new Map(GROUPS.flatMap((group) => tabs.filter((t) => groupOf(t) === group.key).sort(group.order ?? byNeed).map((t) => [t.id, group.key])).map(([id, group], at) => [id, { group, at }]));

// Mission control's finer stages, in this order: each loop running in the
// background (see claude.js) is a stage of its own rather than part of
// Working. A tab is in one: Needs you first, then its PR's place (In merge
// queue, Merged), then the loop it is running, then its state, so a
// queue-and-clean watching a queued PR shows the PR's place. `color` names the STATES entry whose
// color the stage's header wears.
const STAGES = [
  { key: "needs", title: "Needs you", color: "waiting" },
  { key: "working", title: "Working", color: "working" },
  { key: "review", title: "Review loop", color: "review" },
  { key: "ci", title: "CI loop", color: "ci" },
  { key: "queue", title: "Queue-and-clean", color: "queue" },
  { key: "queued", title: "In merge queue", color: "queued", order: GROUPS.find((g) => g.key === "queued").order },
  { key: "merged", title: "Merged", color: "merged" },
  { key: "idle", title: "Idle", color: "idle" },
];
const stageOf = (tab) => {
  if (tab.state === "waiting" || tab.state === "done" || tab.flagged) return "needs";
  if (tab.merge === "queued" || tab.merge === "merged") return tab.merge;
  if (tab.state === "background" && tab.loop) return tab.loop.kind;
  // Between a loop's rounds, Claude working in the foreground is the loop's too.
  if ((tab.state === "working" || tab.state === "background") && tab.loopSkill) return tab.loopSkill;
  return tab.state === "working" || tab.state === "background" ? "working" : "idle";
};
const staged = (tabs) =>
  STAGES.map((stage) => ({ ...stage, tabs: tabs.filter((t) => stageOf(t) === stage.key).sort(stage.order ?? byNeed) })).filter((s) => s.tabs.length);

module.exports = { RANK, tabsFrom, byNeed, grouped, frozenFrom, staged };
