#!/bin/zsh

# Popup for M-t (and the sidebar's n): asks which directory the new tab opens
# in, then opens it there running Claude and asks for its name (tab-name.zsh).
#
# Usage: new-tab.zsh
#
# An fzf list of the directories you work in, the way the Slack relay's places
# and the Work map find them: the directory you are in first (the binding's
# -d), then every open tab's, then every one a Claude session ran in, most
# recent first, from wt-revive's cache (~/.cache/wt-revive/index.json, kept
# fresh by the sidebar daemon), then your home. Only directories that still
# exist are listed. Type to narrow it; Enter takes the chosen one, or, when
# nothing matches, what you typed if it is a directory. Esc cancels and opens
# nothing.

dim=$'\e[38;5;244m' red=$'\e[31m' reset=$'\e[0m'
script_dir=${0:A:h}

fail() {
  print "\n  ${red}$1${reset}"
  print -n "\n  ${dim}Press any key to close.${reset}"
  read -sk 1
  exit 0
}

here=$PWD
typeset -U dirs
dirs=(
  "$here"
  ${(f)"$(tmux list-panes -a -F '#{?@sidebar,,#{pane_current_path}}' 2>/dev/null)"}
  ${(f)"$(jq -r '.transcripts | to_entries | sort_by(-.value.mtimeMs) | .[].value.cwd // empty' ~/.cache/wt-revive/index.json 2>/dev/null)"}
  "$HOME"
)
shown=()
for dir in $dirs; do
  [[ -n $dir && -d $dir ]] && shown+=("${dir/#$HOME/~}")
done

# fzf prints the query, then the choice: none when nothing matches (exit 1),
# and it exits 130 on Esc.
out=$(print -rl -- $shown | fzf --print-query --no-sort --layout=reverse --height=100% \
  --prompt='Open in > ' --header='A new tab running Claude: Enter opens it there; a path you type works too. Esc cancels.')
(( $? == 130 )) && exit 0
picked=("${(@f)out}")
choice=${picked[2]:-${picked[1]}}
[[ -n $choice ]] || exit 0
dir=${choice/#\~/$HOME}
[[ -d $dir ]] || fail "No such directory: $choice"

# tmux expands formats in -c, so a # in the path is doubled.
tmux new-window -c "${dir//\#/##}" "zsh -i -c 'claude; exec zsh -i'" || fail "tmux could not open a tab."
cd "$dir" && exec "$script_dir/tab-name.zsh" optional
