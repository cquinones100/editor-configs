#!/usr/bin/env bash
# Popup confirmation for tmux pane actions.
# Usage: confirm.sh "Prompt text" [<pane_id>]
#        confirm.sh --yes [<pane_id>]   closes it without asking, for M-w with
#                                       the confirm_close setting off
#
# Without a pane, the one in the global @confirm_pane, which M-w sets just
# before the popup, since display-popup does not expand #{pane_id} in its
# command.

prompt="$1"
target=${2:-$(tmux show -gqv @confirm_pane)}
[ -n "$target" ] || exit 0

if [ "$prompt" = --yes ]; then
  ans=y
else
  text="$prompt (y/n) "
  cols=$(tput cols)
  lines=$(tput lines)
  pad_left=$(( (cols - ${#text}) / 2 ))
  pad_top=$(( (lines - 1) / 2 ))

  for ((i = 0; i < pad_top; i++)); do echo; done
  printf "%*s%s" "$pad_left" "" "$text"

  read -rsn 1 ans
fi

case "$ans" in
  y|Y)
    # A pane standing in for another (pane-in-place.sh) puts it back first, so
    # closing it never leaves that pane parked out of sight.
    parked=$(tmux show -pqv -t "$target" @parked_pane 2>/dev/null)
    [ -n "$parked" ] && tmux swap-pane -d -s "$parked" -t "$target" 2>/dev/null && tmux select-pane -t "$parked"
    tmux kill-pane -t "$target"
    ;;
esac
