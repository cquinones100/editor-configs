// Part of bin/tmux-sidebar; see the comment at the top of that file.
//
// Keeps one sidebar pane on the left of every window, and none once the
// sidebar is turned off (@sidebar_on off). tmux has no sidebar of its own, so
// each window gets a narrow pane of its own running the zsh client, which
// draws what the daemon sends it. Each call compares what tmux has with that
// and fixes only what differs, so most calls run no tmux command at all.

const path = require("node:path");
const { CLIENT, MARK, SOCKET } = require("./config");
const { tryTmux, batch } = require("./tmux");

const shq = (text) => `'${String(text).replace(/'/g, "'\\''")}'`;
const clientCommand = () => `exec ${shq(CLIENT)} sidebar ${shq(SOCKET)}`;
// The sidebar keeps the terminal's background rather than the gray tmux.conf
// gives panes without focus: it is never where you type, so it would
// otherwise always look dimmed.
const STYLE = "bg=terminal";

const isOurs = (pane) => pane.pane_start_command.includes(path.basename(CLIENT));

const reconcile = async (snap, tabs, config, log = () => {}) => {
  // tmux-resurrect lays windows out pane by pane while it restores, and a
  // sidebar added halfway would throw its layouts off; its hooks set
  // @sidebar_hold until it is done.
  if (snap.hold) return false;
  let changed = false;
  for (const tab of tabs) {
    const commands = [];
    // A window holding a parked pane gets no sidebar.
    if (!snap.on || tab.parked || tab.width < config.minWindowWidth) {
      tab.sidebars.forEach((p) => commands.push(["kill-pane", "-t", p.pane_id]));
    } else if (!tab.panes.length) {
      // The tab's last real pane has closed: the tab closes with it, as it
      // would have without a sidebar.
      commands.push(["kill-window", "-t", tab.id]);
    } else if (!tab.zoomed) {
      const [keep, ...extra] = [...tab.sidebars].sort((a, b) => Number(isOurs(b)) - Number(isOurs(a)));
      extra.forEach((p) => commands.push(["kill-pane", "-t", p.pane_id]));
      if (!keep) {
        const id = await tryTmux(["split-window", "-hbf", "-d", "-l", String(config.width), "-t", tab.id, "-c", tab.path || process.env.HOME, "-P", "-F", "#{pane_id}", clientCommand()]);
        if (id) commands.push(["set-option", "-p", "-t", id, MARK, "1"], ["set-option", "-p", "-t", id, "window-style", STYLE]);
      } else {
        // A sidebar tmux-resurrect brought back is a shell with the title.
        if (!isOurs(keep)) commands.push(["respawn-pane", "-k", "-t", keep.pane_id, "-c", tab.path || process.env.HOME, clientCommand()], ["set-option", "-p", "-t", keep.pane_id, MARK, "1"]);
        if (keep["window-style"] !== STYLE) commands.push(["set-option", "-p", "-t", keep.pane_id, "window-style", STYLE]);
        if (Number(keep.pane_width) !== config.width) commands.push(["resize-pane", "-t", keep.pane_id, "-x", String(config.width)]);
        // A window left with its sidebar focused would come back to it, and
        // the tab's name and color would follow the sidebar's directory.
        if (tab.sidebarActive && !(tab.current && tab.attached)) commands.push(["last-pane", "-t", tab.id]);
      }
    }
    if (commands.length) {
      // Closing panes and windows is said in the log, with why.
      if (commands.some(([name]) => name.startsWith("kill") || name === "respawn-pane")) {
        log(`${tab.id}: ${commands.map((c) => c.join(" ")).join("; ")} (panes ${tab.panes.map((p) => p.pane_id).join(",") || "none"}, sidebars ${tab.sidebars.map((p) => p.pane_id).join(",") || "none"})`);
      }
      changed = true;
      await batch(commands);
    }
  }
  return changed;
};

module.exports = { reconcile, clientCommand, isOurs, shq };
