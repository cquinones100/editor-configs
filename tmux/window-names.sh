#!/usr/bin/env bash

# Names and colors every window tab in a session. The name is tab-label.sh's
# label, cut to fit, with the PR number in front when there is one. The same
# name uncut goes in the window's @tab_label, for bin/slack-relay, which has
# the room to show it.
#
# Usage: window-names.sh <session>
#
# Split out of update-colors.sh so window-pr.sh can call it when a pull request
# number turns up in the background. The rest of update-colors.sh sets global
# styles from the focused pane, which a background refresh has no business
# touching — it would repaint the session badge in some unfocused window's
# color.

set -u

session="${1:-}"
[ -n "$session" ] || exit 0

script_dir="$(dirname "$0")"

# The label is cut by characters, which bash only counts under a UTF-8 locale.
export LC_ALL=en_US.UTF-8

# Long enough for a ticket ID and the start of its title. The second status
# line shows the whole label for the focused window.
MAX_LABEL=30

# Each window's directory is its active pane's, but never a sidebar's (the
# @sidebar pane option): with the sidebar's cursor on a tab, the sidebar is
# that window's active pane, and the tab would take the sidebar's directory.
# A window with only its sidebar active goes by its first other pane.
tmux list-panes -s -t "$session" -F $'#{window_index}\t#{?@sidebar,s,p}#{pane_active}\t#{pane_current_path}' |
  awk -F'\t' '$2 ~ /^p/ && (!($1 in path) || $2 == "p1") { if (!($1 in path)) order[++n] = $1; path[$1] = $3 }
    END { for (i = 1; i <= n; i++) print order[i] "\t" path[order[i]] }' |
  while IFS=$'\t' read -r idx path; do
    # Color, label and PR in one cached answer (see path-facts.sh).
    IFS=$'\t' read -r whex label pr <<<"$("$script_dir/path-facts.sh" "$path")"

    # The same label tab-status.sh puts at the front of the second status line.
    name=$("$script_dir/tab-label.sh" "${session}:${idx}" "$path" "$label")
    full=$name
    [ ${#name} -gt $MAX_LABEL ] && name="${name:0:$((MAX_LABEL - 3))}..."
    # rename-window expands formats in the name it is given, so a # from a
    # ticket title, branch or directory is doubled to stay a #: unescaped,
    # "#{…}" or "#(…)" in one would be expanded, and ## would lose a #. After
    # the cut, so the cut counts the characters shown. @tab_label is set with
    # setw, which doesn't expand, so the full name keeps its # as they are.
    name=${name//\#/##}

    # The PR number goes first because it is the short, stable half: the tab
    # is scannable by number even when the branch name is cut off. Written
    # ##, tmux stores it as the #<number> wt-jump reads back.
    [ -n "$pr" ] && name="##${pr} ${name}" && full="#${pr} ${full}"

    # One tmux call for all four, since this runs for every window on every
    # pane focus. @tab_path is the directory the name was worked out from,
    # which agent-state.sh compares at the end of a turn.
    tmux setw -t "${session}:${idx}" window-status-format "#[fg=#${whex}] #I:#{E:@agent_marker}#[bg=default,fg=#${whex},nobold]#{?@agent, ,}#W " \; \
      rename-window -t "${session}:${idx}" "$name" \; \
      setw -t "${session}:${idx}" @tab_label "$full" \; \
      setw -t "${session}:${idx}" @tab_path "$path"
  done

# bin/tmux-sidebar shows the same names, and redraws when told (see
# tmux/sidebar.sh).
[ -d ~/.local/state/tmux-sidebar ] && echo >>~/.local/state/tmux-sidebar/nudge
exit 0
