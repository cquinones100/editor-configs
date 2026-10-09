#!/usr/bin/env bash

# Names and colors every window tab in a session. The name is tab-label.sh's
# label, cut to fit, with the PR number in front when there is one.
#
# Usage: window-names.sh <session>
#
# Split out of update-colors.sh so window-pr.sh can call it when a pull request
# number turns up in the background. The rest of update-colors.sh sets global
# styles from the focused pane, which a background refresh has no business
# touching — it would repaint the session badge in some unfocused window's
# color.

set -u

session="${1:-}"
[ -n "$session" ] || exit 0

script_dir="$(dirname "$0")"

# The label is cut by characters, which bash only counts under a UTF-8 locale.
export LC_ALL=en_US.UTF-8

# Long enough for a ticket ID and the start of its title. The second status
# line shows the whole label for the focused window.
MAX_LABEL=30

tmux list-windows -t "$session" -F '#{window_index},#{pane_current_path}' |
  while IFS=, read -r idx path; do
    whex=$("$script_dir/accent-color.sh" "$path")

    # The same label tab-status.sh puts at the front of the second status line.
    name=$("$script_dir/tab-label.sh" "${session}:${idx}" "$path")
    [ ${#name} -gt $MAX_LABEL ] && name="${name:0:$((MAX_LABEL - 3))}..."

    # The PR number goes first because it is the short, stable half: the tab
    # is scannable by number even when the branch name is cut off.
    pr=$("$script_dir/window-pr.sh" "$path")
    [ -n "$pr" ] && name="#${pr} ${name}"

    tmux setw -t "${session}:${idx}" window-status-format "#[fg=#${whex}] #I:#{E:@agent_marker}#[bg=default,fg=#${whex},nobold]#{?@agent, ,}#W "
    tmux rename-window -t "${session}:${idx}" "$name"
  done
