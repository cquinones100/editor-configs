#!/usr/bin/env bash

# Called by tmux pane-focus-in hook. Receives the current pane path and
# session ID as arguments, then updates accent colors for the active pane
# border, session badge, current window tab, and all inactive window tabs.

pane_path="$1"
session="$2"

script_dir="$(dirname "$0")"

hex=$("$script_dir/accent-color.sh" "$pane_path")
tmux set -g pane-active-border-style "fg=#${hex}"
tmux set -g status-left "#[bg=#${hex},fg=colour255,bold]  #S #[bg=colour235] "
tmux setw -g window-status-current-format "#[bg=colour238,fg=#${hex},bold] #I:#W "

tmux list-windows -t "$session" -F '#{window_index},#{pane_current_path}' | while IFS=, read -r idx path; do
  whex=$("$script_dir/accent-color.sh" "$path")
  name=$("$script_dir/accent-color.sh" --name "$path")
  tmux setw -t "${session}:${idx}" window-status-format "#[fg=#${whex}] #I:#W "
  tmux rename-window -t "${session}:${idx}" "$name"
done
