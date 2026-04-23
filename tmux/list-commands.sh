#!/usr/bin/env bash
query="$1"
history_file="${HOME}/.config/tmux/launch_history"

if [ -z "$query" ] && [ -s "$history_file" ]; then
  sort "$history_file" | uniq -c | sort -rn | awk '{print $2}'
else
  {
    [ -s "$history_file" ] && sort "$history_file" | uniq -c | sort -rn | awk '{print $2}'
    compgen -c | sort -u
  } | awk '!seen[$0]++'
fi
