#!/usr/bin/env bash

# Prints the second status line for the focused pane: its window's label (the
# same one in the tab, but not cut short), the PR and whether it has every
# commit made here, the command, and in a Claude pane the session's title and
# last prompt.
#
# Usage: tab-status.sh <pane_id> <path> <command> <tty> [<@sidebar>]
#
# tmux runs this from status-format[1] on every redraw, so nothing in it may
# wait on the network.

set -u

pane="${1:-}" path="${2:-}" command="${3:-}" tty="${4:-}" sidebar="${5:-}"
[ -n "$pane" ] || exit 0

# With the sidebar focused (its @sidebar option, which sidebar.sh's status
# line passes), the line is about the tab's own pane: the one focused before
# the sidebar, else its first other pane. Otherwise it would show the
# sidebar's directory while you browse, where the tab's title is cut short.
if [ "$sidebar" = 1 ]; then
  IFS=$'\t' read -r pane path command tty < <(tmux list-panes -t "$pane" -F $'#{?@sidebar,,#{?pane_last,0,1}}\t#{pane_id}\t#{pane_current_path}\t#{pane_current_command}\t#{pane_tty}' 2>/dev/null | grep -v '^\t' | sort -k1,1n | cut -f2- | head -n 1)
  [ -n "$pane" ] || exit 0
fi

script_dir="${0%/*}"
source "$script_dir/claude-pane.sh"

# Substrings below count characters, not bytes, only under a UTF-8 locale, and
# the tmux server's environment may not have one.
export LC_ALL=en_US.UTF-8

# The same palette update-colors.sh picks from the mode theme.sh last set.
mode=dark
read -r mode 2>/dev/null <"$script_dir/.theme-mode"
case "$mode" in
  light) FG=colour234; FG_DIM=colour238; FG_BRIGHT=colour232 ;;
  *)     FG=colour248; FG_DIM=colour244; FG_BRIGHT=colour255 ;;
esac
# Color, label and PR in one cached answer (see path-facts.sh).
IFS=$'\t' read -r hex facts_label pr <<<"$("$script_dir/path-facts.sh" "$path")"

# The pane is called claude only when Claude Code is in its foreground (see
# claude-pane.sh), so an unrelated program named like a version, or any other
# node program, keeps its name.
claude_pid=$(claude_pid "$command" "$tty") && command=claude

# Doubled #s so tmux prints what the user or Linear wrote rather than reading
# it as a format.
label=$("$script_dir/tab-label.sh" "$pane" "$path" "$facts_label")
if [ -n "$(tmux show -wqv -t "$pane" @tab_name 2>/dev/null)" ]; then
  out="#[fg=$FG_BRIGHT,bold]${label//#/##}#[nobold]"
else
  out="#[fg=$FG_BRIGHT]${label//#/##}"
fi

if [ -n "$pr" ]; then
  out="$out  #[fg=$FG] ##$pr"
  # Whether the PR has everything committed here: the commits ahead of the
  # branch's upstream, or of origin's copy of it when no upstream is set.
  # Counted against what was last fetched or pushed, so it never touches the
  # network, and in one git call when there is an upstream.
  ahead=$(git -C "$path" --no-optional-locks rev-list --count '@{upstream}..HEAD' 2>/dev/null) ||
    ahead=$(git -C "$path" --no-optional-locks rev-list --count "origin/$(git -C "$path" branch --show-current)..HEAD" 2>/dev/null)
  if [[ $ahead =~ ^[0-9]+$ ]]; then
    if (( ahead > 0 )); then out="$out #[fg=colour220]↑$ahead to push"
    else out="$out #[fg=$FG_DIM]pushed"; fi
  fi
fi

# Last before the Claude summary, so in a Claude pane "claude" sits next to the
# title and prompt it introduces.
out="$out  #[fg=#$hex]${command//\#/##}"

# What the Claude session is doing, as agent-state.sh records it from Claude
# Code's hooks: the same states the tab's mark shows, in words.
if [ -n "$claude_pid" ]; then
  # | between them, since whitespace would collapse an empty state.
  IFS="|" read -r state since <<<"$(tmux display -p -t "$pane" '#{@agent_state}|#{@agent_since}' 2>/dev/null)"
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
#
# Working that out takes seven processes, so it is kept per Claude process
# and reused only while it is strictly newer than both files. -nt is a shell
# builtin, and a prompt written in the same second as the answer makes it
# count as old, so a new prompt is never missed.
session_file="$HOME/.claude/sessions/$claude_pid.json"
summary_cache="${XDG_CACHE_HOME:-$HOME/.cache}/tmux-tab-status/$claude_pid"
if [ -n "$claude_pid" ] && [ -f "$session_file" ] && [ "$summary_cache" -nt "$session_file" ] && [ "$summary_cache" -nt "$HOME/.claude/history.jsonl" ]; then
  IFS= read -r summary <"$summary_cache"
  [ -n "$summary" ] && out="$out   #[fg=$FG_DIM]${summary//#/##}"
elif [ -n "$claude_pid" ] && [ -f "$session_file" ]; then
  # One jq for both: the session ID, then the name you gave it, if any.
  { IFS= read -r session; IFS= read -r session_title; } <<<"$(jq -r '.sessionId // "", (select(.nameSource != null and .nameSource != "derived") | .name // "")' "$session_file" 2>/dev/null)"
  if [ -n "$session" ]; then
    prompt=$(grep -F "\"sessionId\":\"$session\"" "$HOME/.claude/history.jsonl" 2>/dev/null | tail -1 |
      jq -r '.display // empty' 2>/dev/null | tr '\n\t' '  ' | sed 's/ *$//')
    [ "$(wc -w <<<"$prompt")" -lt 3 ] && prompt=""
    max=60
    [ ${#prompt} -gt $max ] && prompt="${prompt:0:$((max - 3))}..."
    [ -n "$prompt" ] && prompt="\"$prompt\""
    summary="${session_title:+$session_title${prompt:+: }}$prompt"
    mkdir -p "${summary_cache%/*}" && printf '%s\n' "$summary" >"$summary_cache" 2>/dev/null
    [ -n "$summary" ] && out="$out   #[fg=$FG_DIM]${summary//#/##}"
  fi
fi

printf '%s' "$out"
