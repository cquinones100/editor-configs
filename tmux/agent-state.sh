#!/usr/bin/env bash

# Tracks what each Claude session in tmux is doing, so the tab bar can show
# which ones are waiting on you, which have finished, and which are working.
#
# Usage:
#   agent-state.sh set <working|waiting|done|clear>   from Claude Code hooks, for $TMUX_PANE
#   agent-state.sh notification               from the Notification hook; reads its JSON
#   agent-state.sh seen <window_id>           from the pane-focus-in hook
#   agent-state.sh next                       from M-a: go to the tab most in need of you
#
# Each pane running Claude carries @agent_state (working, waiting, or done) and
# @agent_since (when it got there). Its window carries @agent, the most urgent
# state among its panes (waiting, then done, then working), which the
# @agent_marker format in tmux.conf turns into the mark in the tab.
#
# "done" means finished and not yet looked at: focusing the tab clears it, and
# a session that finishes in the tab you are already looking at never gets it.
#
# Claude Code waits on its hooks, so everything here is a few tmux calls and
# nothing else: no network, nothing slow. Hooks must not print either, since
# Claude Code adds some hooks' output to the conversation, and they always exit
# 0 so a tmux hiccup never blocks Claude.

set -u

# tmux rewrites control characters in its output, tab delimiters included,
# without a UTF-8 locale.
export LC_ALL=en_US.UTF-8

[ -n "${TMUX:-}" ] || exit 0

# A pane still running Claude: its command is Claude Code's executable, which
# is named after its version. A pane that has gone back to a shell keeps no
# state, so a session that died without its SessionEnd hook does not leave a
# mark behind.
runs_claude() { [[ $1 =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; }

# Recomputes @agent for one window from its panes, dropping the state of any
# pane no longer running Claude.
refresh() {
  local window=$1 best="" rank=0 pane state command r
  while IFS=$'\t' read -r pane state command; do
    [ -n "$state" ] || continue
    if ! runs_claude "$command"; then
      tmux set -pu -t "$pane" @agent_state 2>/dev/null
      tmux set -pu -t "$pane" @agent_since 2>/dev/null
      continue
    fi
    case $state in waiting) r=3 ;; done) r=2 ;; working) r=1 ;; *) r=0 ;; esac
    (( r > rank )) && { rank=$r; best=$state; }
  done < <(tmux list-panes -t "$window" -F $'#{pane_id}\t#{@agent_state}\t#{pane_current_command}' 2>/dev/null)
  if [ -n "$best" ]; then
    tmux set -w -t "$window" @agent "$best"
  else
    tmux set -wu -t "$window" @agent 2>/dev/null
  fi
}

set_state() {
  local pane=$1 state=$2 window
  window=$(tmux display -p -t "$pane" '#{window_id}' 2>/dev/null) || return
  # Finishing in front of you is not news: the tab you are looking at in an
  # attached session does not get "done".
  if [ "$state" = done ] &&
    [ "$(tmux display -p -t "$pane" '#{&&:#{window_active},#{session_attached}}')" = 1 ]; then
    state=clear
  fi
  if [ "$state" = clear ]; then
    tmux set -pu -t "$pane" @agent_state 2>/dev/null
    tmux set -pu -t "$pane" @agent_since 2>/dev/null
  else
    tmux set -p -t "$pane" @agent_state "$state"
    tmux set -p -t "$pane" @agent_since "$(date +%s)"
  fi
  refresh "$window"
}

case "${1:-}" in
  set)
    [ -n "${TMUX_PANE:-}" ] && set_state "$TMUX_PANE" "${2:-clear}"
    ;;

  notification)
    [ -n "${TMUX_PANE:-}" ] || exit 0
    payload=$(cat)
    kind=$(jq -r '.notification_type // empty' <<<"$payload" 2>/dev/null)
    message=$(jq -r '.message // empty' <<<"$payload" 2>/dev/null)
    # Permission prompts and questions are Claude waiting on you. The
    # PermissionRequest hook has usually said so already, since this hook only
    # fires once a prompt has waited about six seconds. The idle reminder comes
    # a minute after a turn ended, which "done" already shows, and the rest
    # (sign-in, quota) only get the banner.
    case $kind in
      permission_prompt | elicitation_dialog | elicitation_url_dialog | agent_needs_input)
        set_state "$TMUX_PANE" waiting ;;
    esac
    # The banner names the tab, so you know where to go.
    label=$(tmux display -p -t "$TMUX_PANE" '#{window_index}:#{window_name}' 2>/dev/null)
    text=${message:-Claude Code needs your attention}
    osascript -e "display notification \"${text//\"/\\\"}\" with title \"Claude Code: ${label//\"/\\\"}\"" >/dev/null 2>&1
    ;;

  seen)
    window=${2:-}
    [ -n "$window" ] || exit 0
    while IFS=$'\t' read -r pane state; do
      [ "$state" = done ] && tmux set -pu -t "$pane" @agent_state && tmux set -pu -t "$pane" @agent_since
    done < <(tmux list-panes -t "$window" -F $'#{pane_id}\t#{@agent_state}' 2>/dev/null)
    # Every window, not just this one, so a session that ended without saying
    # so loses its mark the next time any tab is focused.
    tmux list-windows -a -F '#{window_id}' | while read -r w; do refresh "$w"; done
    ;;

  next)
    # Everything that needs you, in order: waiting first, then done, oldest
    # first within each. Each press goes to the entry after the current tab and
    # wraps at the end, so pressing it repeatedly walks the whole list. A tab
    # stays waiting after a visit until you answer it, so it has to be a walk:
    # "the most urgent tab" would keep coming back to the same one.
    here=$(tmux display -p '#{window_id}')
    list=$(tmux list-panes -a -F $'#{@agent_state}\t#{@agent_since}\t#{window_id}\t#{pane_id}\t#{session_name}\t#{pane_current_command}' |
      awk -F'\t' '($1 == "waiting" || $1 == "done") && $6 ~ /^[0-9]+\.[0-9]+\.[0-9]+$/ {
        print ($1 == "waiting" ? 0 : 1) "\t" $2 "\t" $3 "\t" $4 "\t" $5 }' |
      sort -t$'\t' -k1,1n -k2,2n)
    if [ -z "$list" ]; then
      tmux display-message "No Claude session is waiting on you."
      exit 0
    fi
    # Where the walk got to is kept as the last stop's place in the order, not
    # as a tab: a done tab stops being done the moment it is focused, so by the
    # next press it is no longer in the list to count from. Pressed from that
    # same tab, the walk carries on from its place; pressed anywhere else, it
    # starts again from the top.
    last_window=$(tmux show -gqv @agent_walk_window)
    last_key=$(tmux show -gqv @agent_walk_key)
    target=$(awk -F'\t' -v here="$here" -v last_window="$last_window" -v last_key="$last_key" '
      BEGIN { split(last_key, k, " ") }
      { line[NR] = $0; rank[NR] = $1; since[NR] = $2; win[NR] = $3 }
      END {
        if (here == last_window && last_key != "") {
          for (i = 1; i <= NR; i++)
            if (rank[i] > k[1] || (rank[i] == k[1] && since[i] > k[2]) || (rank[i] == k[1] && since[i] == k[2] && win[i] > k[3])) { print line[i]; exit }
          print line[1]; exit
        }
        for (i = 1; i <= NR; i++) if (win[i] != here) { print line[i]; exit }
        print line[1]
      }' <<<"$list")
    if [ "$(cut -f3 <<<"$target")" = "$here" ]; then
      tmux display-message "This is the only Claude session waiting on you."
      exit 0
    fi
    tmux set -g @agent_walk_window "$(cut -f3 <<<"$target")"
    tmux set -g @agent_walk_key "$(cut -f1-3 <<<"$target" | tr '\t' ' ')"
    IFS=$'\t' read -r _ _ window pane session <<<"$target"
    # select-window first, so switching sessions lands on it rather than on
    # whatever was last focused there. switch-client only when the session
    # changes, since it needs a client and the rest do not.
    tmux select-window -t "$window" \; select-pane -t "$pane"
    [ "$session" != "$(tmux display -p '#{session_name}')" ] && tmux switch-client -t "$session"
    ;;
esac
exit 0
