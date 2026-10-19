#!/usr/bin/env bash
# Opens the repository's merge queue in the browser.
# Usage: merge-queue.sh <pane_current_path>
#
# A queue belongs to a branch, so this opens the one the branch's PR targets,
# and the default branch's when there is no PR. A repository without a merge
# queue shows GitHub's empty queue page.

cd "$1" 2>/dev/null || exit 0

url=$(gh repo view --json url --jq .url 2>/dev/null)
[ -z "$url" ] && exit 0

base=$(gh pr view --json baseRefName --jq .baseRefName 2>/dev/null)
[ -z "$base" ] && base=$(gh repo view --json defaultBranchRef --jq .defaultBranchRef.name 2>/dev/null)
[ -z "$base" ] && exit 0

open "$url/queue/$base"
