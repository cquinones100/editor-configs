#!/usr/bin/env bash
# A tool in a pane's place, leaving the rest of the window, sidebar included,
# as it is; quitting the tool puts the pane back. C-l opens lazygit this way,
# M-d diffview.nvim (nvim/lua/plugins/diffview.lua).
#
# Usage:
#   pane-in-place.sh open <lazygit|diffview> <pane> <dir>   start the tool in <dir> in <pane>'s place
#   pane-in-place.sh back <pane>                            from the tool's pane as it exits: swap <pane> back
#
# The tool starts in a window of its own, and swap-pane trades places: the
# tool goes where the pane was, and the pane waits in that window, marked
# @pane_parked so the sidebar gives it no sidebar and leaves it out of the
# tabs. The tool's pane records the parked pane in @parked_pane and its own
# name in @in_place, which C-l and M-d use to tell their tool's pane, since
# its command reads as the shell that runs the tool. When the tool exits,
# however it is quit, its shell swaps the pane back and selects it, and the
# parked window, left with only the tool's closing pane, closes with it. A
# pane killed instead (M-w's confirmation) is swapped back by confirm.sh
# first, from @parked_pane.

set -u

case "${1:-}" in
  open)
    tool=$2 pane=$3 dir=$4
    back="~/.config/tmux/pane-in-place.sh back $pane"
    case $tool in
      lazygit) command="lazygit; $back" ;;
      # GitHub's comparison: everything since the branch left origin's
      # default branch (main where origin doesn't say), uncommitted changes
      # included. It does not fetch: it compares with what was last fetched.
      diffview)
        if ! git -C "$dir" rev-parse --git-dir >/dev/null 2>&1; then
          tmux display-message "Not in a git repository: ${dir//\#/##}"
          exit 0
        fi
        base=$(git -C "$dir" rev-parse --abbrev-ref origin/HEAD 2>/dev/null) || base=main
        command="nvim --cmd 'let g:diff_pane = 1' -c 'DiffviewOpen $base --merge-base'; $back"
        ;;
      *) exit 0 ;;
    esac
    tool_pane=$(tmux new-window -d -P -F '#{pane_id}' -c "$dir" "$command") || exit 0
    tmux set -w -t "$tool_pane" @pane_parked 1
    tmux set -p -t "$tool_pane" @parked_pane "$pane"
    tmux set -p -t "$tool_pane" @in_place "$tool"
    tmux swap-pane -d -s "$tool_pane" -t "$pane"
    tmux select-pane -t "$tool_pane"
    ;;
  back)
    pane=$2
    # The pane may have been closed meanwhile; then there is nothing to bring back.
    tmux swap-pane -d -s "$pane" -t "${TMUX_PANE:-}" 2>/dev/null && tmux select-pane -t "$pane"
    ;;
esac
exit 0
