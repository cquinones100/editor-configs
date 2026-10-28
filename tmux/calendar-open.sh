#!/usr/bin/env bash
# Opens the Calendar tab: Claude in your home directory running
# `/loop 30m /today`, the /today skill every 30 minutes, which also saves the
# day for mission control's Calendar view (lib/sidebar/calendar.js). The tab
# is named Calendar, and starts from an interactive zsh for the PATH the tmux
# server lacks, as M-t's does.
#
# Usage:
#   calendar-open.sh                M-p's command: open it and go there
#   calendar-open.sh --background   the sidebar daemon, when the saved day is
#                                   out of date and no tab is looping /today:
#                                   open it without taking you there

set -u
detached=
[ "${1:-}" = --background ] && detached=-d
window=$(tmux new-window $detached -P -F '#{window_id}' -c "$HOME" "zsh -i -c 'claude \"/loop 30m /today\"; exec zsh -i'") || exit 0
tmux set-option -w -t "$window" @tab_name Calendar
"${0%/*}/window-names.sh" "$(tmux display -p -t "$window" '#{session_name}')"
