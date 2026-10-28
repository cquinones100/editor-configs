#!/usr/bin/env bash
# The M-0 popup: asks for a tab number and goes to that tab, for the tabs past
# 9 that M-1 to M-9 can't reach. Enter goes, Esc closes.
#
# Usage: tab-goto.sh   (run by display-popup, which gives it the client's tmux)
#
# Read a key at a time, so only digits are taken and Esc closes at once:
# what is typed can only ever name a tab.

set -u

number=""
printf '\n  Go to tab: '
while IFS= read -rsn 1 key; do
  case "$key" in
    [0-9]) number+=$key; printf '%s' "$key" ;;
    $'\x7f' | $'\b') [ -n "$number" ] && { number=${number%?}; printf '\b \b'; } ;;
    $'\e') exit 0 ;;
    '') break ;;
  esac
done
[ -n "$number" ] || exit 0

# := matches the number exactly: 1 is tab 1, never tab 11. Asked from a
# sidebar, the cursor stays in one, the new tab's, as M-1 to M-9 leave it.
from_sidebar=$(tmux display -p '#{@sidebar}')
if tmux select-window -t ":=$number" 2>/dev/null; then
  [ "$from_sidebar" = 1 ] && "${0%/*}/sidebar.sh" refocus ":=$number"
  exit 0
fi
printf '\n\n  There is no tab %s. Press any key to close.' "$number"
read -rsn 1
