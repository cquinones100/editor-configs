#!/usr/bin/env bash
# Opens the notes app (bin/notes) in its own tab, or goes to that tab when it
# is already open: two Neovims saving the same notes as you type would write
# over each other. M-N runs it.
# Usage: notes-open.sh <client_name>
#
# The tab is found by its @notes window option, which this sets, so renaming
# it doesn't lose it. It runs notes from an interactive zsh, which has the
# PATH ~/.zshrc sets up (~/.local/bin, nvm), unlike the tmux server's own
# environment, and it closes when you quit notes.

set -u

client=${1:-}

existing=$(tmux list-windows -a -F '#{window_id} #{@notes}' 2>/dev/null | awk '$2 == "1" { print $1; exit }')
if [ -n "$existing" ]; then
  if [ -n "$client" ]; then
    tmux switch-client -c "$client" -t "$existing"
  else
    tmux select-window -t "$existing"
  fi
  exit 0
fi

window=$(tmux new-window -P -F '#{window_id}' -c "$HOME" "zsh -i -c notes")
tmux set-option -w -t "$window" @notes 1
tmux set-option -w -t "$window" @tab_name "Notes"
session=$(tmux display-message -p -t "$window" '#{session_name}')
"${0%/*}/window-names.sh" "$session"
