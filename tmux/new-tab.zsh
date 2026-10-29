#!/bin/zsh

# Popup for M-t (and the sidebar's n): asks which directory the new tab opens
# in, then opens it there running Claude and asks for its name (tab-name.zsh).
#
# Usage: new-tab.zsh
#
# For a note (note-tab.sh sets NEW_TAB_NOTE, a path in the notes directory, and
# NEW_TAB_NAME, its title): the tab is linked to the note (@tab_note) and named
# after it, rather than asked for a name.
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
window=$(tmux new-window -P -F '#{window_id}' -c "${dir//\#/##}" "zsh -i -c 'claude; exec zsh -i'") || fail "tmux could not open a tab."
if [[ -n ${NEW_TAB_NOTE:-} ]]; then
  tmux set-option -w -t "$window" @tab_note "$NEW_TAB_NOTE"
  tmux set-option -w -t "$window" @tab_name "${NEW_TAB_NAME:-${NEW_TAB_NOTE:r}}"
  "$script_dir/window-names.sh" "$(tmux display -p -t "$window" '#{session_name}')"
  exit 0
fi
cd "$dir" && exec "$script_dir/tab-name.zsh" optional
