#!/bin/zsh

# Popup for M-t (and the sidebar's n): asks which directory the new tab opens
# in, then opens it there running Claude and asks for its name (tab-name.zsh).
#
# Usage: new-tab.zsh
#
# The directory comes from pick-dir.zsh, which shape-open.zsh asks with too.

dim=$'\e[38;5;244m' red=$'\e[31m' reset=$'\e[0m'
script_dir=${0:A:h}

fail() {
  print "\n  ${red}$1${reset}"
  print -n "\n  ${dim}Press any key to close.${reset}"
  read -sk 1
  exit 0
}

dir=$("$script_dir/pick-dir.zsh" "A new tab running Claude: Enter opens it there") || exit 0

# tmux expands formats in -c, so a # in the path is doubled.
tmux new-window -c "${dir//\#/##}" "zsh -i -c 'claude; exec zsh -i'" || fail "tmux could not open a tab."
cd "$dir" && exec "$script_dir/tab-name.zsh" optional
