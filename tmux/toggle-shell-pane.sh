#!/usr/bin/env bash
set -euo pipefail

current="$(tmux display-message -p '#{pane_id}')"
shell_pane="$(tmux show-options -wv @shell_pane 2>/dev/null || true)"

if [[ -n "$shell_pane" && "$current" == "$shell_pane" ]]; then
  tmux kill-pane -t "$current"
  tmux set-option -wu @shell_pane
else
  path="$(tmux display-message -p '#{pane_current_path}')"
  new="$(tmux split-window -h -l 75% -c "$path" -P -F '#{pane_id}')"
  tmux set-option -w @shell_pane "$new"
fi
