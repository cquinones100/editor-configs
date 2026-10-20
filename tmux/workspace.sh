#!/usr/bin/env bash

dir=$(find ~ -maxdepth 1 -mindepth 1 -type d | sort | fzf --prompt='workspace> ' --bind 'tab:reload(find {}/. -maxdepth 1 -mindepth 1 -type d 2>/dev/null | sort)+clear-query')
[ -z "$dir" ] && exit 0

# A directory's own `worktree` script picks where the workspace opens, but it
# is code the directory supplies, so it runs only for a directory you have
# trusted: one whose real path is a line of this file, exactly (trusting
# ~/code doesn't trust what is under it). `~/` paths are fine; blank lines and
# lines starting with # are ignored. No file trusts nothing. The file is yours,
# not this repo's, and nothing writes it for you.
trusted_dirs=~/.config/editor-configs/trusted-dirs
trusted() {
  local real entry
  real=$(realpath "$1" 2>/dev/null) || return 1
  [ -f "$trusted_dirs" ] || return 1
  while IFS= read -r entry || [ -n "$entry" ]; do
    entry="${entry#"${entry%%[![:space:]]*}"}"
    entry="${entry%"${entry##*[![:space:]]}"}"
    case "$entry" in '' | '#'*) continue ;; esac
    entry="${entry/#\~/$HOME}"
    [ "$(realpath "$entry" 2>/dev/null)" = "$real" ] && return 0
  done <"$trusted_dirs"
  return 1
}

if [ -x "$dir/worktree" ]; then
  if trusted "$dir"; then
    worktree_dir=$("$dir/worktree")
    [ -n "$worktree_dir" ] && dir="$worktree_dir"
  else
    tmux display-message "workspace: didn't run ${dir//\#/##}/worktree; to allow it, add ${dir//\#/##} to $trusted_dirs"
  fi
fi

# tmux expands formats in -c as well as in messages, so a # in the path is
# doubled; otherwise a folder named with #(...) opens somewhere else.
dir=${dir//\#/##}
tmux new-window -c "$dir" \; \
  split-window -v -p 50 -c "$dir" \; \
  split-window -h -c "$dir" \; \
  select-pane -t 1 \; send-keys 'lazygit' Enter \; \
  select-pane -t 2 \; send-keys 'claude' Enter \; \
  select-pane -t 3
