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
#   pr-view.sh page <prepare|ticket|page> <file> <dir>
#                              render <file.json> (pr-view.js's mode for it) into
#                              <dir> and page it, drawn again at the pane's new
#                              width whenever it is resized; ticket-view.sh's
#                              and link-view.sh's too
#
# A resize is caught by the WINCH trap while less runs in the background (less
# reads keys from /dev/tty, so it still has the keyboard): it closes less, and
# the description is laid out again for the new width, glow and mermaid-ascii
# both, and opened where it was, at the line that was at the top. The style is
# glow's dark one without the #s before headings (glow-style.json).
#
# The view's pane carries @pr_view, so the key finds it to close it. It runs
# under an interactive zsh, for the PATH (gh, glow, ~/.local/bin) the tmux
# server lacks. mermaid-ascii is pinned and installed by `./setup.sh tmux`.

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
    printf '%s' "$pr" > "$work/pr.json"
    "$0" page prepare "$work/pr.json" "$work"
    ;;

  page)
    mode=$2 json=$3 work=$4
    here=${0%/*}
    # Ctrl-C is less's to take: this loop waiting on it would otherwise end on
    # one, closing the pane under it.
    trap '' INT
    # On a resize: the line at the top of the pane, to open there again, and
    # less closed.
    resize() {
      resized=1
      [ -n "$pid" ] || return
      top=$(tmux capture-pane -p -t "$TMUX_PANE" 2>/dev/null | awk '{ sub(/[ >]+$/, "") } NF { print; exit }')
      kill "$pid" 2>/dev/null
    }
    top="" pid=""
    trap resize WINCH
    while :; do
      resized=""
      # stty asks the terminal itself: tput, in $(...), has only a pipe to ask
      # and answers 80 whatever the pane's width.
      cols=$(stty size </dev/tty 2>/dev/null | cut -d " " -f 2)
      width=$(( ${cols:-80} - 4 ))
      # The Markdown, each Mermaid diagram drawn by mermaid-ascii and kept out
      # of glow, which would wrap it, then put back into glow's output
      # (pr-view.js), which also shows a link as its text alone, clickable.
      node "$here/pr-view.js" "$mode" "$json" "$work" "$width" || { printf '\n  \e[31mCould not read it.\e[0m'; read -rsn 1; exit 0; }
      glow -s "$here/glow-style.json" -w "$width" "$work/pr.md" </dev/null | node "$here/pr-view.js" splice "$work" > "$work/pr.txt"
      # Resized again while drawing: draw again, for the size it is now.
      [ -n "$resized" ] && continue
      line=1
      [ -n "$top" ] && line=$(node "$here/pr-view.js" top "$work/pr.txt" "$top")
      # less -S cuts a drawing still wider than the pane at its edge, for the
      # arrow keys to scroll, where wrapping would break its boxes apart; -~
      # leaves the rows past the end blank rather than filled with ~; the prompt
      # says (END) at the end and nothing else, not the temporary file's path.
      less -RS~ --mouse -Ps'?e(END) .' "+${line}g" "$work/pr.txt" &
      pid=$!
      # wait returns early when the trap runs; less is gone only once kill -0 says so.
      while kill -0 "$pid" 2>/dev/null; do wait "$pid"; done
      pid=""
      [ -n "$resized" ] || break
      # A drag sends a run of resizes; wait for the last.
      sleep 0.2
    done
    ;;
esac
exit 0
