#!/usr/bin/env bash
# C-l: lazygit in a pane's place, leaving the rest of the window, sidebar
# included, as it is; quitting lazygit puts the pane back.
#
# Usage:
#   lazygit-pane.sh open <pane> <dir>   start lazygit in <dir> and swap it into <pane>'s place
#   lazygit-pane.sh back <pane>         from lazygit's pane as it exits: swap <pane> back
#
# lazygit starts in a window of its own, and swap-pane trades places: lazygit
# goes where the pane was, and the pane waits in that window, marked
# @pane_parked so the sidebar gives it no sidebar and leaves it out of the
# tabs. lazygit's pane records the parked pane in @parked_pane. When lazygit
# exits, however it is quit, its command swaps the pane back and selects it,
# and the parked window, left with only lazygit's closing pane, closes with
# it. A pane killed instead (C-l's or M-w's confirmation) is swapped back by
# confirm.sh first, from @parked_pane.

set -u

case "${1:-}" in
  open)
    pane=$2 dir=$3
    lazygit_pane=$(tmux new-window -d -P -F '#{pane_id}' -c "$dir" "lazygit; ~/.config/tmux/lazygit-pane.sh back $pane") || exit 0
    tmux set -w -t "$lazygit_pane" @pane_parked 1
    tmux set -p -t "$lazygit_pane" @parked_pane "$pane"
    tmux swap-pane -d -s "$lazygit_pane" -t "$pane"
    tmux select-pane -t "$lazygit_pane"
    ;;
  back)
    pane=$2
    # The pane may have been closed meanwhile; then there is nothing to bring back.
    tmux swap-pane -d -s "$pane" -t "${TMUX_PANE:-}" 2>/dev/null && tmux select-pane -t "$pane"
    ;;
esac
exit 0
