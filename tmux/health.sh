#!/usr/bin/env bash
# The health light in the status line: nothing while all is well, a red mark
# and what is wrong when something that should be running quietly stopped.
# Run by #() in status-left (tmux.conf and update-colors.sh), every
# status-interval, so it is one tmux call and file checks, no network.
#
# Usage: health.sh
#
# What it watches:
#   saves    tmux-continuum's last save is over SAVE_LIMIT seconds old. It saves
#            from a #() job in status-right, so a status line that stops
#            drawing status-right stops the saves without a word.
#   sidebar  the sidebar is on but its daemon (bin/tmux-sidebar) isn't running.
#   relay    bin/slack-relay crashed: its events file is still there, which it
#            removes only when stopped on purpose, but its process has gone.

set -u

SAVE_LIMIT=300

alive() {
  local pid
  pid=$(cut -d' ' -f1 "$1" 2>/dev/null)
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

IFS='|' read -r saved sidebar < <(tmux display -p '#{@continuum-save-last-timestamp}|#{@sidebar_on}' 2>/dev/null)

problems=()
if [ -n "${saved:-}" ] && [ $(($(date +%s) - saved)) -gt $SAVE_LIMIT ]; then
  problems+=("saves $((($(date +%s) - saved) / 60))m old")
fi
if [ "${sidebar:-}" != off ] && ! alive ~/.local/state/tmux-sidebar/daemon.pid; then
  problems+=("sidebar down")
fi
if [ -f ~/.local/state/slack-relay/events.jsonl ] && ! alive ~/.local/state/slack-relay/relay.lock; then
  problems+=("relay down")
fi

[ ${#problems[@]} -eq 0 ] && exit 0
text=$(printf '%s, ' "${problems[@]}")
printf '#[fg=colour196,bold] ● %s #[default]' "${text%, }"
