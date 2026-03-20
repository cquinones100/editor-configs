#!/usr/bin/env bash

dir=$(find ~ -maxdepth 1 -mindepth 1 -type d | sort | fzf --prompt='workspace> ' --bind 'tab:reload(find {}/. -maxdepth 1 -mindepth 1 -type d 2>/dev/null | sort)+clear-query')
[ -z "$dir" ] && exit 0

if [ -x "$dir/worktree" ]; then
  worktree_dir=$("$dir/worktree")
  [ -n "$worktree_dir" ] && dir="$worktree_dir"
fi

tmux new-window -c "$dir" \; \
  split-window -v -p 50 -c "$dir" \; \
  split-window -h -c "$dir" \; \
  select-pane -t 1 \; send-keys 'lazygit' Enter \; \
  select-pane -t 2 \; send-keys 'claude' Enter \; \
  select-pane -t 3
