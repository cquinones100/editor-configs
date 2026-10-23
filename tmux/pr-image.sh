#!/usr/bin/env bash
# The M-p palette's "View the branch's PR description as an image (trial)":
# opens tmux/pr-image.js in a pane to the right, or closes it, as M-v does for
# the text view (tmux/pr-view.sh), which it leaves as it is.
#
# Usage: pr-image.sh toggle <pane>
#
# The pane carries @pr_image, so the entry finds it to close it, and has
# allow-passthrough on, for this pane alone, so the images reach the terminal
# through tmux. It runs under an interactive zsh, for the PATH (node, gh,
# pnpm) the tmux server lacks.

set -u

here=${2:-}
[ "${1:-}" = toggle ] && [ -n "$here" ] || exit 0
open=$(tmux list-panes -t "$here" -F '#{pane_id} #{@pr_image}' | awk '$2 == "1" { print $1; exit }')
if [ -n "$open" ]; then
  tmux kill-pane -t "$open"
  exit 0
fi
dir=$(tmux display -p -t "$here" '#{pane_current_path}')
pane=$(tmux split-window -h -l 50% -t "$here" -c "${dir//\#/##}" -P -F '#{pane_id}' "zsh -i -c 'node ~/.config/tmux/pr-image.js'") || exit 0
tmux set-option -p -t "$pane" @pr_image 1
tmux set-option -p -t "$pane" allow-passthrough on
