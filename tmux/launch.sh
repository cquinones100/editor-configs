#!/usr/bin/env bash
target="$1"

cmd=$(compgen -c | sort -u | fzf \
  --prompt="  " \
  --layout=reverse \
  --border=rounded \
  --height=100% \
  --print-query | tail -1)

if [ -n "$cmd" ]; then
  pane_path=$(tmux display-message -p -t "$target" "#{pane_current_path}")
  tmux split-window -h -c "$pane_path" -t "$target" "$cmd"
fi
