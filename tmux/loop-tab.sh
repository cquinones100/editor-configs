#!/usr/bin/env bash
# Opens a tab that runs one skill on a loop: Claude in your home directory
# running `/loop <every> <skill>`, under the tab name <name>, from an
# interactive zsh for the PATH the tmux server lacks, as M-t's does. The
# Calendar tab runs /today every 30 minutes, and the Slack tab
# /slack-updates every 5, each saving what it finds for mission control's
# view of it (lib/sidebar/calendar.js, lib/sidebar/slack.js).
#
# Usage:
#   loop-tab.sh <name> <every> <skill>                M-p's commands: open it
#                                                     and go there
#   loop-tab.sh <name> <every> <skill> --background   the sidebar daemon, when
#                                                     a view is out of date and
#                                                     no tab keeps it: open it
#                                                     without taking you there
#
#   loop-tab.sh Calendar 30m /today

set -u
name=${1:-} every=${2:-} skill=${3:-}
# They go into a command line, so only the characters each can have.
[[ $name =~ ^[A-Za-z0-9\ ]+$ && $every =~ ^[0-9]+[smhd]$ && $skill =~ ^/[a-z0-9-]+$ ]] || {
  echo "Usage: $0 <name> <every> <skill> [--background]" >&2
  exit 1
}
detached=
[ "${4:-}" = --background ] && detached=-d
window=$(tmux new-window $detached -P -F '#{window_id}' -c "$HOME" "zsh -i -c 'claude \"/loop $every $skill\"; exec zsh -i'") || exit 0
tmux set-option -w -t "$window" @tab_name "$name"
# The Slack relay alerts on its waits only, not on each tick it finishes.
tmux set-option -w -t "$window" @loop_tab 1
"${0%/*}/window-names.sh" "$(tmux display -p -t "$window" '#{session_name}')"
