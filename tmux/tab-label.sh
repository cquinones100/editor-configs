#!/usr/bin/env bash

# Prints the label for the window <target> whose pane is at <path>: the name
# set with M-n, else the Linear ticket and its title, else the name
# accent-color.sh gives the directory.
#
# Usage: tab-label.sh <target> <path>
#
# window-names.sh puts this in the tab and tab-status.sh at the front of the
# second status line, so the two can never disagree about what a window is.
# Runs for every window on every pane focus, so it never waits on the network:
# ticket-title.sh answers from a cache.

set -u

target="${1:-}"
path="${2:-}"
[ -n "$target" ] || exit 0

script_dir="$(dirname "$0")"

name=$(tmux show -wqv -t "$target" @tab_name 2>/dev/null)
if [ -n "$name" ]; then
  printf '%s' "$name"
  exit 0
fi

# Matches any team key, the same way linear-ticket.sh does. A branch that only
# looks like a ticket is harmless: Linear has no such ticket, ticket-title.sh
# prints nothing, and the directory name is used as usual.
branch=$(git -C "$path" --no-optional-locks branch --show-current 2>/dev/null)
ticket=$(printf '%s' "$branch" | grep -ioE '[a-z][a-z0-9]*-[0-9]+' | head -1 | tr 'a-z' 'A-Z')
if [ -n "$ticket" ]; then
  title=$("$script_dir/ticket-title.sh" "$ticket")
  if [ -n "$title" ]; then
    printf '%s: %s' "$ticket" "$title"
    exit 0
  fi
fi

"$script_dir/accent-color.sh" --name "$path"
