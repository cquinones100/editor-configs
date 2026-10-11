#!/usr/bin/env bash

# The M-o popup: an fzf list of worktrees that no tab has open, to bring one
# back. Picking one opens a tab in it and resumes its Claude session with
# claude-here, as `wtr` does. The companion to M-j, which only jumps between
# tabs that are still open.
#
# Usage: window-revive.sh [--list] [dir]   (dir defaults to $PWD; --list
#        prints the rows instead of opening the picker)
#
# Which repositories: the one `dir` is in, every open tab's, and every one a
# Claude session has run in over the last two weeks, so a repository whose
# tabs are all closed still counts. Each row is a worktree of one of them with
# no pane inside it: its repository and branch, how long since it was last
# used, and the last prompt Claude was given there, most recent first.
# Worktrees git marks prunable (their directory is gone) are left out.
#
# Bash rather than node, so the popup needs none of window-jump.sh's PATH
# setup: git, jq and fzf are all it runs.

set -u

# tmux rewrites control characters in its output, tab delimiters included,
# without a UTF-8 locale.
export LC_ALL=en_US.UTF-8

list=false
[ "${1:-}" = --list ] && { list=true; shift; }
dir=${1:-$PWD}
projects=~/.claude/projects
recent_days=14

hold() {
  printf '%s\n\nPress any key to close.' "$1"
  read -r -n 1 -s
  exit 0
}

# A session's directory is in its transcript, on most lines; the newest
# transcript per directory says when it was last used and what was last asked.
# The last directory counts, since a session that started elsewhere and moved
# into a worktree belongs to the worktree; only the end of each transcript is
# read, since some are megabytes long.
# Tab-separated: modified time, directory, transcript.
sessions=$(
  find "$projects" -name '*.jsonl' -mtime "-$recent_days" -type f 2>/dev/null |
    while read -r file; do
      cwd=$(tail -c 65536 "$file" | grep -o '"cwd":"[^"]*"' | tail -1 | sed 's/^"cwd":"//; s/"$//')
      [ -n "$cwd" ] && printf '%s\t%s\t%s\n' "$(stat -f %m "$file")" "$cwd" "$file"
    done | sort -t$'\t' -k1,1nr
)

panes=$(tmux list-panes -a -F '#{pane_current_path}' 2>/dev/null)

# Every repository, as its main checkout, so each one's worktrees are listed
# once however many places point into it.
repos=$(
  { printf '%s\n' "$dir"; printf '%s\n' "$panes"; cut -f2 <<<"$sessions"; } |
    sort -u |
    while read -r path; do
      [ -d "$path" ] || continue
      common=$(git -C "$path" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || continue
      # A bare repository has no checkout of its own.
      [ "$(basename "$common")" = .git ] && dirname "$common"
    done | sort -u
)
[ -n "$repos" ] || hold "No git repositories found in your tabs or recent Claude sessions."

# A worktree is open when some pane is in it or below it.
is_open() {
  local tree=$1 pane
  while read -r pane; do
    [ "$pane" = "$tree" ] || [[ $pane == "$tree"/* ]] && return 0
  done <<<"$panes"
  return 1
}

age() {
  local s=$(($(date +%s) - $1))
  if ((s < 3600)); then echo "$((s / 60))m ago"
  elif ((s < 172800)); then echo "$((s / 3600))h ago"
  else echo "$((s / 86400))d ago"
  fi
}

# Tab-separated rows: sort key, path, then what fzf shows (repository and
# branch, age, last prompt).
rows=$(
  while read -r repo; do
    git -C "$repo" worktree list --porcelain 2>/dev/null |
      awk -v RS= '!/\nprunable/ && !/\nbare/ {
        path = ""; branch = ""
        n = split($0, line, "\n")
        for (i = 1; i <= n; i++) {
          if (line[i] ~ /^worktree /) path = substr(line[i], 10)
          if (line[i] ~ /^branch /) branch = substr(line[i], 8)
          if (line[i] == "detached") branch = "(detached)"
        }
        sub("^refs/heads/", "", branch)
        print path "\t" branch
      }' |
      while IFS=$'\t' read -r tree branch; do
        is_open "$tree" && continue
        # The newest session in this worktree, or in a directory below it.
        session=$(awk -F'\t' -v t="$tree" '$2 == t || index($2, t "/") == 1 { print; exit }' <<<"$sessions")
        if [ -n "$session" ]; then
          when=$(cut -f1 <<<"$session")
          # The last prompt that says something: "yes" and "go ahead" don't
          # say what the worktree was for. The very last one if none does.
          prompt=$(jq -r 'select(.type == "user" and (.isMeta | not) and (.message.content | type) == "string") | .message.content | gsub("[\\n\\t]"; " ")' "$(cut -f3 <<<"$session")" 2>/dev/null |
            grep -v '^<' | awk 'length >= 20 { said = $0 } { last = $0 } END { print (said != "" ? said : last) }' | cut -c1-90)
        else
          when=$(stat -f %m "$tree" 2>/dev/null || echo 0)
          prompt="(no recent Claude session)"
        fi
        printf '%s\t%s\t%s\t%s\t%s\n' "$when" "$tree" "$(basename "$repo") $branch" "$(age "$when")" "$prompt"
      done
  done <<<"$repos" | sort -t$'\t' -k1,1nr
)
[ -n "$rows" ] || hold "Every worktree already has a tab open."
if $list; then
  cut -f3- <<<"$rows"
  exit 0
fi

choice=$(
  cut -f2- <<<"$rows" |
    fzf --delimiter=$'\t' --with-nth=2.. --tabstop=2 \
      --prompt='Reopen > ' --header='A worktree with no tab: Enter opens a tab and resumes its Claude' \
      --no-sort --layout=reverse
) || exit 0

tree=$(cut -f1 <<<"$choice")
# claude-here finds and resumes the directory's session; an interactive zsh
# puts it on the PATH, and leaves the tab at a shell when Claude exits.
tmux new-window -c "$tree" "zsh -i -c 'claude-here; exec zsh -i'"
