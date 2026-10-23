#!/usr/bin/env bash
# Opens the notes app (bin/notes) in its own tab, or beside the pane you are
# in, or goes to it when it is already open: there is only ever one, since two
# Neovims saving the same notes as you type would write over each other. M-N
# runs it for a tab, M-e beside the pane.
#
# Usage: notes-open.sh <client_name>            M-N: its own tab, or go to it
#        notes-open.sh side <client_name> <pane> M-e: to the right of <pane>
#        notes-open.sh away <client_name> <pane> M-w on Notes: back to its own tab
#
# The notes pane is found by its @notes_pane option, which this sets, so it is
# found wherever it has been moved, and renaming its tab doesn't lose it; a
# tab of its own also carries the @notes window option. It runs notes from an
# interactive zsh, which has the PATH ~/.zshrc sets up (~/.local/bin, nvm),
# unlike the tmux server's own environment, and it closes when you quit notes.
#
# Beside a pane: notes already open elsewhere moves there (join-pane), its own
# tab closing behind it; open in that tab already, it goes back to a tab of its
# own (break-pane), so the key opens and puts away the same pane.

set -u

# The pane marked @notes_pane, else the first pane of a tab marked @notes, as
# a tab opened before panes were marked is, else the pane whose terminal runs
# the Neovim holding the notes lock (store.lua's .notes.lock), found up its
# parents, since that one has no terminal of its own: a pane tmux-resurrect
# brought back has lost its marks. A pane found from the lock is marked again.
notes_dir=${NOTES_DIR:-$HOME/Notes}
notes_pane() {
  local found pid tty hops=0
  found=$(tmux list-panes -a -F '#{pane_id} #{@notes_pane} #{@notes}' 2>/dev/null |
    awk '$2 == "1" { print $1; found = 1; exit } $3 == "1" && !old { old = $1 } END { if (!found && old) print old }')
  if [ -z "$found" ] && pid=$(cat "$notes_dir/.notes.lock" 2>/dev/null) && [ -n "$pid" ]; then
    while [ -n "$pid" ] && [ "$pid" != 1 ] && (( hops++ < 6 )); do
      tty=$(ps -o tty= -p "$pid" 2>/dev/null | tr -d ' ')
      [ -n "$tty" ] && [ "$tty" != "??" ] && break
      pid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
    done
    [ -n "$tty" ] && [ "$tty" != "??" ] && found=$(tmux list-panes -a -F '#{pane_id} #{pane_tty}' | awk -v t="/dev/$tty" '$2 == t { print $1; exit }')
    [ -n "$found" ] && tmux set-option -p -t "$found" @notes_pane 1
  fi
  echo "$found"
}

# What runs notes; the tests put a stand-in here.
notes_command=${NOTES_OPEN_COMMAND:-zsh -i -c notes}

# A tab of its own for the notes pane, named Notes.
own_tab() {
  local window=$1 session
  tmux set-option -w -t "$window" @notes 1
  tmux set-option -w -t "$window" @tab_name "Notes"
  session=$(tmux display-message -p -t "$window" '#{session_name}')
  "${0%/*}/window-names.sh" "$session"
}

# Puts the notes pane back in a tab of its own, unless it is alone in its tab
# already (beside the sidebar). Returns whether it moved.
# The pane standing in for Notes in its tab while Notes is away
# (notes-away.sh), if there is one.
placeholder() {
  tmux list-panes -a -F '#{pane_id} #{@notes_placeholder}' 2>/dev/null | awk '$2 == "1" { print $1; exit }'
}

# Back in the Notes tab it left, in the place of what stood in for it there,
# or in a new Notes tab.
put_away() {
  local pane=$1 window stand_in
  [ "$(tmux list-panes -t "$pane" -F '#{?@sidebar,,x}' | grep -c x)" -gt 1 ] || return 1
  stand_in=$(placeholder)
  if [ -n "$stand_in" ]; then
    tmux join-pane -d -s "$pane" -t "$stand_in" && tmux kill-pane -t "$stand_in"
    return 0
  fi
  window=$(tmux break-pane -d -s "$pane" -P -F '#{window_id}') && own_tab "$window"
}

# M-w on the notes pane: back to its own tab; alone in it already, asked
# about and closed as any pane is (confirm.sh, with @confirm_pane M-w set).
if [ "${1:-}" = away ]; then
  client=${2:-} pane=${3:-}
  [ -n "$pane" ] || exit 0
  put_away "$pane" && exit 0
  tmux display-popup -c "$client" -E -w 60 -h 6 "~/.config/tmux/confirm.sh 'Close pane?'"
  exit 0
fi

if [ "${1:-}" = side ]; then
  client=${2:-} here=${3:-}
  [ -n "$here" ] || exit 0
  existing=$(notes_pane)
  if [ -z "$existing" ]; then
    pane=$(tmux split-window -h -l 40% -t "$here" -c "$HOME" -P -F '#{pane_id}' "$notes_command") || exit 0
    tmux set-option -p -t "$pane" @notes_pane 1
    exit 0
  fi
  tmux set-option -p -t "$existing" @notes_pane 1
  if [ "$(tmux display -p -t "$existing" '#{window_id}')" = "$(tmux display -p -t "$here" '#{window_id}')" ]; then
    # Alone in its own tab (beside the sidebar) it is already put away.
    put_away "$existing"
    exit 0
  fi
  # Leaving its own Notes tab, it leaves notes-away.sh in its place, so the
  # tab stays and says where Notes went. Leaving another tab, nothing.
  old=$(tmux display -p -t "$existing" '#{window_id}')
  # Its own tab: marked @notes, or holding nothing else but the sidebar, as a
  # Notes tab that lost its marks (tmux-resurrect) does.
  alone=$(tmux list-panes -t "$existing" -F '#{?@sidebar,,x}' | grep -c x)
  if { [ "$(tmux show -wqv -t "$old" @notes)" = 1 ] || [ "$alone" -eq 1 ]; } && [ -z "$(placeholder)" ]; then
    stand_in=$(tmux split-window -d -t "$existing" -c "$HOME" -P -F '#{pane_id}' "${0%/*}/notes-away.sh")
    [ -n "$stand_in" ] && tmux set-option -p -t "$stand_in" @notes_placeholder 1 && own_tab "$old"
  fi
  tmux join-pane -h -l 40% -s "$existing" -t "$here"
  # Brought into the Notes tab itself, it takes the stand-in's place there.
  stand_in=$(placeholder)
  if [ -n "$stand_in" ] && [ "$(tmux display -p -t "$stand_in" '#{window_id}')" = "$(tmux display -p -t "$here" '#{window_id}')" ]; then
    tmux kill-pane -t "$stand_in"
  fi
  exit 0
fi

client=${1:-}

existing=$(notes_pane)
if [ -n "$existing" ]; then
  window=$(tmux display -p -t "$existing" '#{window_id}')
  if [ -n "$client" ]; then
    tmux switch-client -c "$client" -t "$window"
  else
    tmux select-window -t "$window"
  fi
  tmux select-pane -t "$existing"
  exit 0
fi

window=$(tmux new-window -P -F '#{window_id}' -c "$HOME" "$notes_command")
tmux set-option -p -t "$window" @notes_pane 1
own_tab "$window"
