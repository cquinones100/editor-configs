#!/usr/bin/env bash

# Prints the second status line for the focused pane: its window's label (the
# same one in the tab, but not cut short), the PR, the command, and in a Claude
# pane the session's title and last prompt.
#
# Usage: tab-status.sh <pane_id> <path> <command> <tty>
#
# tmux runs this from status-format[1] on every redraw, so nothing in it may
# wait on the network.

set -u

pane="${1:-}" path="${2:-}" command="${3:-}" tty="${4:-}"
[ -n "$pane" ] || exit 0

script_dir="$(dirname "$0")"

# Substrings below count characters, not bytes, only under a UTF-8 locale, and
# the tmux server's environment may not have one.
export LC_ALL=en_US.UTF-8

# The same palette update-colors.sh picks from the mode theme.sh last set.
mode=$(cat "$script_dir/.theme-mode" 2>/dev/null || echo dark)
case "$mode" in
  light) FG=colour234; FG_DIM=colour238; FG_BRIGHT=colour232 ;;
  *)     FG=colour248; FG_DIM=colour244; FG_BRIGHT=colour255 ;;
esac
hex=$("$script_dir/accent-color.sh" "$path")

# Claude Code's executable is named after its version, so tmux reports e.g.
# 2.1.285. Only call it claude when a foreground process in the pane is one
# Claude Code itself registered: it writes ~/.claude/sessions/<pid>.json for
# each of its processes and nothing else writes there, so an unrelated program
# that happens to be named like a version keeps its name. Checked this way
# rather than with lsof on the executable, which is as certain but costs a
# third of a second a pane and saturates the CPU when wt-jump asks for every
# window at once.
claude_pid=""
if [[ "$command" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  for pid in $(ps -t "${tty#/dev/}" -o pid=,stat= | awk '$2 ~ /\+/ {print $1}'); do
    if [ -f "$HOME/.claude/sessions/$pid.json" ]; then
      claude_pid=$pid
      command=claude
      break
    fi
  done
fi

# Doubled #s so tmux prints what the user or Linear wrote rather than reading
# it as a format.
label=$("$script_dir/tab-label.sh" "$pane" "$path")
if [ -n "$(tmux show -wqv -t "$pane" @tab_name 2>/dev/null)" ]; then
  out="#[fg=$FG_BRIGHT,bold]${label//#/##}#[nobold]"
else
  out="#[fg=$FG_BRIGHT]${label//#/##}"
fi

pr=$("$script_dir/window-pr.sh" "$path")
[ -n "$pr" ] && out="$out  #[fg=$FG] ##$pr"

# Last before the Claude summary, so in a Claude pane "claude" sits next to the
# title and prompt it introduces.
out="$out  #[fg=#$hex]$command"

# What the Claude session is doing, as agent-state.sh records it from Claude
# Code's hooks: the same states the tab's mark shows, in words.
if [ -n "$claude_pid" ]; then
  state=$(tmux show -pqv -t "$pane" @agent_state 2>/dev/null)
  since=$(tmux show -pqv -t "$pane" @agent_since 2>/dev/null)
  took=""
  if [[ $since =~ ^[0-9]+$ ]]; then
    secs=$(( $(date +%s) - since ))
    if (( secs < 60 )); then took="<1m"
    elif (( secs < 3600 )); then took="$(( secs / 60 ))m"
    else took="$(( secs / 3600 ))h"; fi
  fi
  case $state in
    waiting) out="$out #[fg=colour220]waiting on you${took:+ for $took}" ;;
    done)    out="$out #[fg=colour41]finished${took:+ $took ago}" ;;
    working) out="$out #[fg=$FG_DIM]working" ;;
  esac
fi

# Claude writes ~/.claude/sessions/<pid>.json for each running process, naming
# its current session and, once you /rename it, the name you gave it. That name
# is shown; the title Claude generates is not, because it summarises only the
# first prompt and goes stale as the session moves on. The prompt comes from
# history.jsonl, which gets it as soon as it is sent, and is left out when it
# is under three words ("yes", "do it"), which say nothing on their own.
# Neither file is documented, so if either changes shape the text quietly
# stops showing and nothing else is affected.
session_file="$HOME/.claude/sessions/$claude_pid.json"
if [ -n "$claude_pid" ] && [ -f "$session_file" ]; then
  session=$(jq -r '.sessionId // empty' "$session_file" 2>/dev/null)
  if [ -n "$session" ]; then
    session_title=$(jq -r 'select(.nameSource != null and .nameSource != "derived") | .name // empty' "$session_file" 2>/dev/null)
    prompt=$(grep -F "\"sessionId\":\"$session\"" "$HOME/.claude/history.jsonl" 2>/dev/null | tail -1 |
      jq -r '.display // empty' 2>/dev/null | tr '\n\t' '  ' | sed 's/ *$//')
    [ "$(wc -w <<<"$prompt")" -lt 3 ] && prompt=""
    max=60
    [ ${#prompt} -gt $max ] && prompt="${prompt:0:$((max - 3))}..."
    [ -n "$prompt" ] && prompt="\"$prompt\""
    summary="${session_title:+$session_title${prompt:+: }}$prompt"
    [ -n "$summary" ] && out="$out   #[fg=$FG_DIM]${summary//#/##}"
  fi
fi

printf '%s' "$out"
