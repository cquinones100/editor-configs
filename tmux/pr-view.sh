#!/usr/bin/env bash
# The tab's pull request description, rendered in a pane to the right, as
# GitHub shows it as far as a terminal can: glow draws the Markdown (headings,
# lists, tables, checkboxes, code), and each Mermaid diagram is drawn as text
# by mermaid-ascii. M-v opens it and closes it again; q in it closes it too.
# M-r still opens the PR itself in the browser, where a diagram mermaid-ascii
# can't draw (it handles flowcharts and sequence diagrams) is shown properly.
#
# Usage:
#   pr-view.sh toggle <pane>   M-v: open the view beside <pane>, or close it
#   pr-view.sh show            in the view's pane: render the PR of $PWD's branch
#
# The view's pane carries @pr_view, so the key finds it to close it. It runs
# under an interactive zsh, for the PATH (gh, glow, ~/.local/bin) the tmux
# server lacks. mermaid-ascii is pinned and installed by `./sync.sh pr-view`.

set -u

case "${1:-}" in
  toggle)
    here=${2:-}
    [ -n "$here" ] || exit 0
    open=$(tmux list-panes -t "$here" -F '#{pane_id} #{@pr_view}' | awk '$2 == "1" { print $1; exit }')
    if [ -n "$open" ]; then
      tmux kill-pane -t "$open"
      exit 0
    fi
    dir=$(tmux display -p -t "$here" '#{pane_current_path}')
    pane=$(tmux split-window -h -l 45% -t "$here" -c "${dir//\#/##}" -P -F '#{pane_id}' "zsh -i -c '~/.config/tmux/pr-view.sh show'") || exit 0
    tmux set-option -p -t "$pane" @pr_view 1
    ;;

  show)
    dim=$'\e[38;5;244m' red=$'\e[31m' reset=$'\e[0m'
    wait_key() {
      printf '\n  %s\n\n  %sPress any key to close.%s' "$1" "$dim" "$reset"
      read -rsn 1
      exit 0
    }
    command -v glow >/dev/null || wait_key "${red}glow isn't installed.${reset} Install it with: brew install glow"
    printf '\n  %sReading the PR...%s' "$dim" "$reset"
    pr=$(gh pr view --json number,title,url,state,isDraft,author,baseRefName,headRefName,body 2>/dev/null) ||
      wait_key "${red}No PR for this branch${reset} ($(git branch --show-current 2>/dev/null || echo "not a repository"))."
    work=$(mktemp -d)
    trap 'rm -rf "$work"' EXIT
    width=$(( $(tput cols 2>/dev/null || echo 80) - 4 ))
    # The Markdown, each Mermaid diagram drawn by mermaid-ascii and kept out of
    # glow, which would wrap it, then put back into glow's output (pr-view.js).
    # less -S cuts a drawing still wider than the pane at its edge, for the
    # arrow keys to scroll, where wrapping would break its boxes apart.
    printf '%s' "$pr" > "$work/pr.json"
    node "${0%/*}/pr-view.js" prepare "$work/pr.json" "$work" "$width" || wait_key "${red}Could not read the PR.${reset}"
    glow -s dark -w "$width" "$work/pr.md" | node "${0%/*}/pr-view.js" splice "$work" > "$work/pr.txt"
    less -RS "$work/pr.txt"
    ;;
esac
exit 0
