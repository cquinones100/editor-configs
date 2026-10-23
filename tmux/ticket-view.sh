#!/usr/bin/env bash
# The tab's Linear ticket, rendered in a pane to the right, as pr-view.sh shows
# its PR: the facts from the ticket's side panel, the description (glow for the
# Markdown, mermaid-ascii for Mermaid diagrams, through pr-view.js), sub-issues,
# related tickets, links, and the comments with their replies. M-i opens it and
# closes it again; q in it closes it too. M-l still opens the ticket in the
# browser.
#
# Usage:
#   ticket-view.sh toggle <pane>   M-i: open the view beside <pane>, or close it
#   ticket-view.sh show <ID>       in the view's pane: render ticket <ID>
#
# The ticket is the one the pane's branch names, as linear-ticket.sh finds it,
# else the one the tab's name gives (a "Shaping ABC-123: ..." tab, before
# there is a branch). The API key is worktree-from-ticket's, as
# ticket-title.sh reads it. The view's pane carries @ticket_view, so the key
# finds it to close it, and runs under an interactive zsh for the PATH (glow,
# node, ~/.local/bin) the tmux server lacks.

set -u

case "${1:-}" in
  toggle)
    here=${2:-}
    [ -n "$here" ] || exit 0
    open=$(tmux list-panes -t "$here" -F '#{pane_id} #{@ticket_view}' | awk '$2 == "1" { print $1; exit }')
    if [ -n "$open" ]; then
      tmux kill-pane -t "$open"
      exit 0
    fi
    dir=$(tmux display -p -t "$here" '#{pane_current_path}')
    ticket=$(git -C "$dir" branch --show-current 2>/dev/null | grep -ioE '[a-z][a-z0-9]*-[0-9]+' | head -1 | tr 'a-z' 'A-Z')
    [ -n "$ticket" ] ||
      ticket=$(tmux display -p -t "$here" '#{@tab_name}' | grep -oE '[A-Z][A-Z0-9]*-[0-9]+' | head -1)
    # It goes into a command line, so only a ticket ID's characters.
    if ! [[ $ticket =~ ^[A-Z][A-Z0-9]*-[0-9]+$ ]]; then
      tmux display-message "No Linear ticket in this branch or tab name"
      exit 0
    fi
    pane=$(tmux split-window -h -l 45% -t "$here" -c "${dir//\#/##}" -P -F '#{pane_id}' "zsh -i -c '~/.config/tmux/ticket-view.sh show $ticket'") || exit 0
    tmux set-option -p -t "$pane" @ticket_view 1
    ;;

  show)
    id=${2:-}
    dim=$'\e[38;5;244m' red=$'\e[31m' reset=$'\e[0m'
    wait_key() {
      printf '\n  %s\n\n  %sPress any key to close.%s' "$1" "$dim" "$reset"
      read -rsn 1
      exit 0
    }
    command -v glow >/dev/null || wait_key "${red}glow isn't installed.${reset} Install it with: brew install glow"
    config="${XDG_CONFIG_HOME:-$HOME/.config}/worktree-from-ticket/config.json"
    key="${LINEAR_API_KEY:-$(jq -r '.linearApiKey // empty' "$config" 2>/dev/null)}"
    [ -n "$key" ] || wait_key "${red}No Linear API key${reset} (LINEAR_API_KEY, or linearApiKey in $config)."
    printf '\n  %sReading %s...%s' "$dim" "$id" "$reset"
    query='query($id: String!) { issue(id: $id) {
      identifier title url description createdAt updatedAt priorityLabel estimate
      state { name } assignee { name } creator { name } project { name } cycle { number name }
      labels { nodes { name } } parent { identifier title }
      children { nodes { identifier title state { name } } }
      relations { nodes { type relatedIssue { identifier title state { name } } } }
      attachments { nodes { title url } }
      comments(first: 100) { nodes { id body createdAt parent { id } user { name } botActor { name } } }
    } }'
    body=$(jq -nc --arg id "$id" --arg query "$query" '{query: $query, variables: {id: $id}}')
    work=$(mktemp -d)
    trap 'rm -rf "$work"' EXIT
    # The key goes to curl on stdin, as in ticket-title.sh, never on a command line.
    printf 'Authorization: %s\n' "$key" |
      curl -s --max-time 15 https://api.linear.app/graphql \
        -H 'Content-Type: application/json' -H @- -d "$body" > "$work/ticket.json" ||
      wait_key "${red}Could not reach Linear.${reset}"
    jq -e '.data.issue' "$work/ticket.json" >/dev/null 2>&1 ||
      wait_key "${red}Linear has no ticket $id${reset} ($(jq -r '.errors[0].message // "no answer"' "$work/ticket.json" 2>/dev/null))."
    # Laid out and paged as the PR view is, drawn again when the pane is resized.
    "${0%/*}/pr-view.sh" page ticket "$work/ticket.json" "$work"
    ;;
esac
exit 0
