#!/usr/bin/env bash
# What the Notes tab shows while Notes is beside another tab's pane (M-e): which
# tab has it, kept up to date, so the tab stays in the sidebar's Other and
# says where Notes went. notes-open.sh starts it in the tab's place when it
# moves Notes out, and closes it when Notes comes back.
#
# Enter or a click goes to the tab that has Notes; M-e brings Notes back here,
# as it does anywhere. If Notes has been quit, Enter or a click starts it
# again here.
#
# Usage: notes-away.sh   (run as a pane's command, by notes-open.sh)

set -u

dim=$'\033[38;5;244m' bold=$'\033[1m' reset=$'\033[0m'
script_dir=${0%/*}

where() {
  tmux list-panes -a -F '#{@notes_pane} #{window_id} #{window_index}	#{@tab_label}' 2>/dev/null |
    awk -F'\t' '$1 ~ /^1 / { split($1, a, " "); print a[2] "\t" a[3] "\t" $2; exit }'
}

# Clicks come as escape sequences once asked for.
printf '\033[?1000h\033[?1006h'
while true; do
  IFS=$'\t' read -r window index label <<<"$(where)"
  rows=$(tput lines 2>/dev/null || echo 24)
  printf '\033[H\033[2J'
  for ((i = 0; i < rows / 3; i++)); do echo; done
  if [ -n "${window:-}" ]; then
    printf '  %sNotes is beside tab %s%s, %s\n\n' "$bold" "$index" "$reset" "${label:-its pane}"
    printf '  %sEnter: go there   M-e: bring it back here%s' "$dim" "$reset"
  else
    printf '  %sNotes isn'"'"'t open.%s\n\n  %sEnter: open it here%s' "$bold" "$reset" "$dim" "$reset"
  fi
  # Redrawn every two seconds, so a move or a rename shows.
  # Enter reads as an empty key; a click as ESC, then the rest of its report.
  # A read that times out leaves its variable empty too, so going is decided
  # only when a key came.
  go=false
  if IFS= read -rsn 1 -t 2 key; then
    if [ -z "$key" ]; then
      go=true
    elif [ "$key" = $'\033' ]; then
      IFS= read -rsn 32 -t 0.05 rest
      [[ $rest == "[<0;"*M* ]] && go=true
    fi
  fi
  if $go; then
    if [ -n "${window:-}" ]; then
      tmux switch-client -t "$window" 2>/dev/null || tmux select-window -t "$window"
    else
      tmux set-option -p -t "${TMUX_PANE:-}" -u @notes_placeholder 2>/dev/null
      tmux set-option -p -t "${TMUX_PANE:-}" @notes_pane 1 2>/dev/null
      exec ${NOTES_OPEN_COMMAND:-zsh -i -c notes}
    fi
  fi
done
