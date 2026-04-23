#!/usr/bin/env bash
target="$1"
history_file="${HOME}/.config/tmux/launch_history"

cmd=$(~/.config/tmux/list-commands.sh "" | fzf \
  --prompt="  " \
  --layout=reverse \
  --border=rounded \
  --height=100% \
  --print-query \
  --bind "change:reload(~/.config/tmux/list-commands.sh {q})" \
  | tail -1)

if [ -n "$cmd" ]; then
  echo "$cmd" >> "$history_file"
  pane_path=$(tmux display-message -p -t "$target" "#{pane_current_path}")
  tmux split-window -h -c "$pane_path" -t "$target" "$cmd"
fi
