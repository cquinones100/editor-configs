#!/usr/bin/env bash

# Called by tmux pane-focus-in hook. Receives the current pane path and
# session ID as arguments, then updates accent colors for the active pane
# border, session badge, current window tab, and all inactive window tabs.

pane_path="$1"
session="$2"

script_dir="$(dirname "$0")"

mode=$(cat "$script_dir/.theme-mode" 2>/dev/null || echo dark)
case "$mode" in
  light) BG_DARK=colour254; BG_MED=colour250; FG_BRIGHT=colour232; FG_DIM=colour240 ;;
  *)     BG_DARK=colour235; BG_MED=colour238; FG_BRIGHT=colour255; FG_DIM=colour244 ;;
esac

hex=$("$script_dir/accent-color.sh" "$pane_path")
tmux set -g pane-active-border-style "fg=#${hex}"
tmux set -g status-left "#[bg=#${hex},fg=$FG_BRIGHT,bold]  #S #[bg=$BG_DARK] "
tmux setw -g window-status-current-format "#[bg=$BG_MED,fg=#${hex},bold] #I:#W "

tmux list-windows -t "$session" -F '#{window_index},#{pane_current_path}' | while IFS=, read -r idx path; do
  whex=$("$script_dir/accent-color.sh" "$path")
  name=$("$script_dir/accent-color.sh" --name "$path")
  tmux setw -t "${session}:${idx}" window-status-format "#[fg=#${whex}] #I:#W "
  tmux rename-window -t "${session}:${idx}" "$name"
done
