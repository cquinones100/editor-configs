#!/usr/bin/env bash

# Says whether the PR for the branch at <path> is ready to merge, for the M-m
# popup: a verdict first, then each thing that decides it.
#
# Usage: pr-ready.sh [--wait] [path]
#   path:   the worktree to ask about; defaults to the current directory, which
#           is how the popup passes it
#   --wait: hold the output until a key is pressed, for the popup
#
# The verdict is GitHub's own mergeStateStatus, so it agrees with the merge
# button. The lines under it explain that answer. Checks are split into
# required and the rest, because a failing optional check (a preview deploy,
# say) does not block the merge and should not read as if it did. A PR already
# in the merge queue says so ahead of everything else, since GitHub reports it
# as mergeable and the answer you want is that it is on its way.

set -u

wait=false
[ "${1:-}" = --wait ] && { wait=true; shift; }

# Every exit below goes through this, so the popup never closes before the
# answer has been read.
trap '$wait && { printf "\n  Press any key to close."; read -rsn 1; }' EXIT

path="${1:-$PWD}"
cd "$path" 2>/dev/null || { echo "No such directory: $path"; exit 1; }

green=$'\033[32m' red=$'\033[31m' yellow=$'\033[33m' dim=$'\033[2m' bold=$'\033[1m' reset=$'\033[0m'

# Each gh call takes a second or so, and nothing else prints until they are all
# done, so a line says what is being waited on and is wiped before the answer.
# Only on a terminal, so a captured run has nothing to clean out.
progress() { [ -t 1 ] && printf '\r\033[2K  %s%s%s' "$dim" "$1" "$reset"; }
done_waiting() { [ -t 1 ] && printf '\r\033[2K'; }

progress "Reaching out to GitHub..."

fields=number,title,url,state,isDraft,mergeable,mergeStateStatus,reviewDecision,autoMergeRequest
if ! pr=$(gh pr view --json "$fields" 2>&1); then
  done_waiting
  echo "No pull request for this branch."
  echo "${dim}${pr}${reset}"
  exit 0
fi

# GitHub works out mergeability lazily: the first ask after a push often comes
# back UNKNOWN, and asking again a moment later has the answer.
for _ in 1 2 3; do
  [ "$(jq -r .mergeable <<<"$pr")" != UNKNOWN ] && break
  progress "Waiting for GitHub to work out whether it can merge..."
  sleep 1
  pr=$(gh pr view --json "$fields" 2>/dev/null) || break
done

field() { jq -r "$1" <<<"$pr"; }

# Counts by outcome, e.g. "2 pass, 1 pending". gh exits non-zero whenever a
# check is failing or pending, so its status is not an error here.
counts() {
  gh pr checks "$@" --json bucket 2>/dev/null |
    jq -r 'group_by(.bucket) | map("\(length) \(.[0].bucket)") | join(", ") | if . == "" then "none" else . end'
}
# gh pr view has no field for the merge queue, so the entry comes from GraphQL,
# the same query queue-and-clean watches with. Owner, repo, and number are read
# off the PR's URL rather than asked for again. "null" when it is not queued,
# and also when the query fails, which then reads as "not queued" rather than
# stopping the rest of the answer.
progress "Checking the merge queue..."
IFS=/ read -r owner repo number < <(field .url | sed -E 's#^https://[^/]+/([^/]+)/([^/]+)/pull/([0-9]+).*#\1/\2/\3#')
queue=$(gh api graphql -F owner="$owner" -F repo="$repo" -F number="$number" \
  -f query='query($owner: String!, $repo: String!, $number: Int!) { repository(owner: $owner, name: $repo) { pullRequest(number: $number) { mergeQueueEntry { state position } } } }' \
  --jq '.data.repository.pullRequest.mergeQueueEntry' 2>/dev/null) || queue=null
[ -n "$queue" ] || queue=null

progress "Reading the checks..."
required=$(counts --required)
all=$(counts)
done_waiting

printf '%s#%s %s%s\n%s%s%s\n\n' "$bold" "$(field .number)" "$(field .title)" "$reset" "$dim" "$(field .url)" "$reset"

state=$(field .state)
case "$state" in
  MERGED) echo "${green}${bold}Already merged.${reset}"; exit 0 ;;
  CLOSED) echo "${red}${bold}Closed without merging.${reset}"; exit 0 ;;
esac

# A queued PR usually reads as CLEAN, so without this it would say "Ready to
# merge" about something that is already on its way.
queue_state=$(jq -r '.state // empty' <<<"$queue")
queue_position=$(jq -r '.position // empty' <<<"$queue")
case "$queue_state" in
  "")              queue_line="not queued" ;;
  AWAITING_CHECKS) queue_line="${yellow}position $queue_position, waiting on checks${reset}" ;;
  MERGEABLE)       queue_line="${green}position $queue_position, mergeable${reset}" ;;
  UNMERGEABLE)     queue_line="${red}position $queue_position, unmergeable${reset}" ;;
  LOCKED)          queue_line="${green}position $queue_position, merging now${reset}" ;;
  *)               queue_line="position $queue_position, $(tr '[:upper:]_' '[:lower:] ' <<<"$queue_state")" ;;
esac

case "$queue_state:$(field .mergeStateStatus)" in
  UNMERGEABLE:*) verdict="${red}${bold}In the merge queue, but it cannot merge${reset}${red}: it will be removed unless that changes.${reset}" ;;
  ?*:*)          verdict="${green}${bold}Already in the merge queue.${reset}" ;;
  :CLEAN)        verdict="${green}${bold}Ready to merge.${reset}" ;;
  :HAS_HOOKS)    verdict="${green}${bold}Ready to merge${reset}${green} (the repo runs merge hooks).${reset}" ;;
  :UNSTABLE)     verdict="${green}${bold}Ready to merge${reset}${yellow}, though some optional checks are not passing.${reset}" ;;
  :BEHIND)       verdict="${yellow}${bold}Not ready:${reset}${yellow} the branch is behind its base and must be updated.${reset}" ;;
  :BLOCKED)      verdict="${red}${bold}Not ready:${reset}${red} blocked by a required review or check.${reset}" ;;
  :DIRTY)        verdict="${red}${bold}Not ready:${reset}${red} it has merge conflicts.${reset}" ;;
  :DRAFT)        verdict="${yellow}${bold}Not ready:${reset}${yellow} it is still a draft.${reset}" ;;
  *)             verdict="${yellow}${bold}GitHub has not worked out whether it can merge yet.${reset} ${dim}Try again in a moment.${reset}" ;;
esac
echo "$verdict"
echo

case "$(field .reviewDecision)" in
  APPROVED)          review="${green}approved${reset}" ;;
  CHANGES_REQUESTED) review="${red}changes requested${reset}" ;;
  REVIEW_REQUIRED)   review="${yellow}review required${reset}" ;;
  *)                 review="${dim}none required${reset}" ;;
esac

case "$(field .mergeable)" in
  MERGEABLE)   conflicts="${green}none${reset}" ;;
  CONFLICTING) conflicts="${red}conflicts with the base${reset}" ;;
  *)           conflicts="${dim}unknown${reset}" ;;
esac

if [ "$(field .isDraft)" = true ]; then draft="${yellow}yes${reset}"; else draft="no"; fi
if [ "$(field .autoMergeRequest)" != null ]; then auto_merge="${green}on${reset}"; else auto_merge="off"; fi

printf '  %-17s %s\n' \
  "Required checks" "$required" \
  "All checks" "$all" \
  "Review" "$review" \
  "Conflicts" "$conflicts" \
  "Draft" "$draft" \
  "Auto-merge" "$auto_merge" \
  "Merge queue" "$queue_line"
