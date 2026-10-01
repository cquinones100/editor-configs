#!/usr/bin/env bash

# Prints the Linear title for ticket <ID>, or nothing when it is not known yet
# or Linear has no such ticket.
#
# Usage: ticket-title.sh <ID>
#
# Same rule as window-pr.sh: answer from a cache, never wait on the network,
# refresh in the background when the answer has gone stale. The API key is the
# one worktree-from-ticket uses, from $LINEAR_API_KEY or its config file.

set -u

id="${1:-}"
[ -n "$id" ] || exit 0

script_dir="$(dirname "$0")"
cache_dir="${XDG_CACHE_HOME:-$HOME/.cache}/tmux-ticket-title"
cache="$cache_dir/$id"
lock="$cache.lock"

# A title rarely changes, so a found one is good for a day. A miss is usually a
# branch name that only looks like a ticket, so it is rechecked less eagerly
# than window-pr.sh rechecks a missing PR.
FOUND_TTL=1440
MISSING_TTL=60

cached=""
[ -f "$cache" ] && cached=$(cat "$cache" 2>/dev/null)

fresh=false
if [ -f "$cache" ]; then
  if [ -n "$cached" ]; then ttl=$FOUND_TTL; else ttl=$MISSING_TTL; fi
  [ -n "$(find "$cache" -mmin "-$ttl" 2>/dev/null)" ] && fresh=true
fi

printf '%s' "$cached"

$fresh && exit 0

[ -d "$lock" ] && [ -n "$(find "$lock" -maxdepth 0 -mmin +2 2>/dev/null)" ] &&
  rmdir "$lock" 2>/dev/null

mkdir -p "$cache_dir"
mkdir "$lock" 2>/dev/null || exit 0

(
  trap 'rmdir "$lock" 2>/dev/null' EXIT

  config="${XDG_CONFIG_HOME:-$HOME/.config}/worktree-from-ticket/config.json"
  key="${LINEAR_API_KEY:-$(jq -r '.linearApiKey // empty' "$config" 2>/dev/null)}"
  [ -n "$key" ] || exit 0

  body=$(jq -nc --arg id "$id" \
    '{query: "query($id: String!) { issue(id: $id) { title } }", variables: {id: $id}}')
  response=$(curl -s --max-time 10 https://api.linear.app/graphql \
    -H 'Content-Type: application/json' -H "Authorization: $key" -d "$body") || exit 0

  # Only a definite answer is cached. A network or auth failure leaves the old
  # answer in place, so a blip never blanks a title that was already known.
  if title=$(printf '%s' "$response" | jq -er '.data.issue.title' 2>/dev/null); then
    :
  elif printf '%s' "$response" | jq -e '.errors[]? | select(.extensions.code == "INPUT_ERROR")' >/dev/null 2>&1; then
    title=""
  else
    exit 0
  fi

  printf '%s' "$title" > "$cache.$$" && mv "$cache.$$" "$cache"

  # Same as window-pr.sh: only when the answer changed, so a title shows up in
  # the tab while you are sitting in the window rather than on the next focus.
  if [ "$title" != "$cached" ]; then
    tmux list-sessions -F '#{session_name}' 2>/dev/null | while IFS= read -r session; do
      "$script_dir/window-names.sh" "$session"
    done
  fi
) >/dev/null 2>&1 &
