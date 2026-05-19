#!/usr/bin/env bash
# Popup confirmation for tmux pane actions.
# Usage: confirm.sh "Prompt text" <pane_id>

prompt="$1"
target="$2"

text="$prompt (y/n) "
cols=$(tput cols)
lines=$(tput lines)
pad_left=$(( (cols - ${#text}) / 2 ))
pad_top=$(( (lines - 1) / 2 ))

for ((i = 0; i < pad_top; i++)); do echo; done
printf "%*s%s" "$pad_left" "" "$text"

read -rsn 1 ans

case "$ans" in
  y|Y) tmux kill-pane -t "$target" ;;
esac
