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
    # A header like GitHub's, then the body with each Mermaid block swapped for
    # its drawing. A diagram mermaid-ascii can't draw keeps its source, said so.
    jq -r '"# \(.title) #\(.number)\n\n_\(if .isDraft then "Draft" else .state end) · \(.author.login) wants to merge `\(.headRefName)` into `\(.baseRefName)`_\n\n---\n\n\(.body // "")"' <<<"$pr" |
      tr -d '\r' |
      awk -v work="$work" '
        /^[ \t]*```+[ \t]*mermaid[ \t]*$/ { inside = 1; n++; file = work "/" n ".mmd"; printf "" > file; next }
        inside && /^[ \t]*```+[ \t]*$/ {
          inside = 0; close(file)
          out = ""; ok = 1
          # Its drawing ends without a newline, so its status goes on a line of
          # its own after one.
          cmd = "mermaid-ascii -f \"" file "\" 2>/dev/null; rc=$?; echo; echo \"rc=$rc\""
          while ((cmd | getline line) > 0) { if (line ~ /^rc=/) ok = (line == "rc=0"); else out = out line "\n" }
          close(cmd)
          sub(/\n+$/, "\n", out)
          if (ok && out != "") { print "```"; printf "%s", out; print "```" }
          else {
            print "_A Mermaid diagram mermaid-ascii cannot draw; M-r shows it on GitHub:_"
            print "```mermaid"; while ((getline line < file) > 0) print line; close(file); print "```"
          }
          next
        }
        inside { print >> file; next }
        { print }
      ' > "$work/pr.md"
    width=$(( $(tput cols 2>/dev/null || echo 80) - 2 ))
    PAGER="less -R" glow -s dark -w "$width" -p "$work/pr.md"
    ;;
esac
exit 0
