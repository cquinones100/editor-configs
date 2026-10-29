#!/usr/bin/env bash

# Says whether the PR for the branch at <path> is ready to merge, for the M-m
# popup: a verdict first, then each thing that decides it.
#
# Usage: pr-ready.sh [--wait] [path]
#   path:   the worktree to ask about; defaults to the current directory, which
#           is how the popup passes it
#   --wait: hold the output until a key is pressed, for the popup
#
# Asked in the order that can end the answer soonest. A merged or closed PR
# says so and stops. A PR already in the merge queue reports its place there
# and stops too: its checks, conflicts, and review have already been settled by
# getting in, and GitHub still calls it mergeable, so the rest would only say
# "ready" about something that is on its way. For anything else the verdict is
# GitHub's own mergeStateStatus, so it agrees with the merge button, with the
# lines under it explaining it. Checks are split into required and the rest,
# because a failing optional check (a preview deploy, say) does not block the
# merge and should not read as if it did.
#
# It has to be quick, so GitHub is asked as little as it can be. The PR comes
# from one gh call, and its merge queue entry and its checks, counted by
# outcome, from one GraphQL query; listing the checks themselves would take
# a page per hundred, and a big repo has hundreds. Only the required checks
# can't be counted that way: gh pr checks --required reads them one by one,
# which takes seconds. It starts first, in the background, and is waited for
# only when the verdict needs it: a PR GitHub calls ready has every required
# check passing by definition.

set -u

wait=false
[ "${1:-}" = --wait ] && { wait=true; shift; }

path="${1:-$PWD}"
cd "$path" 2>/dev/null || { echo "No such directory: $path"; exit 1; }

# The required checks, counted by outcome (see the top), into a file the
# verdict reads if it needs them.
required_file=$(mktemp -t pr-ready)
gh pr checks --required --json bucket 2>/dev/null |
  jq -r 'group_by(.bucket) | map("\(length) \(.[0].bucket)") | join(", ") | if . == "" then "none" else . end' >"$required_file" &
required_pid=$!

# Every exit below goes through this, so the popup never closes before the
# answer has been read, and the background count stops with it.
trap 'kill "$required_pid" 2>/dev/null; rm -f "$required_file"; $wait && { printf "\n  Press any key to close."; read -rsn 1; }' EXIT

green=$'\033[32m' red=$'\033[31m' yellow=$'\033[33m' dim=$'\033[2m' bold=$'\033[1m' reset=$'\033[0m'

# Each gh call takes a second or so, and nothing else prints until they are
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

field() { jq -r "$1" <<<"$pr"; }

# Mission control's PR, CI and Work map views ask GitHub again too, so what
# they show agrees with this answer (the sidebar daemon watches this file).
sidebar_state=${TMUX_SIDEBAR_STATE_DIR:-$HOME/.local/state/tmux-sidebar}
[ -d "$sidebar_state" ] && echo >>"$sidebar_state/github"

header() {
  done_waiting
  printf '%s#%s %s%s\n%s%s%s\n\n' "$bold" "$(field .number)" "$(field .title)" "$reset" "$dim" "$(field .url)" "$reset"
}

case "$(field .state)" in
  MERGED) header; echo "${green}${bold}Already merged.${reset}"; exit 0 ;;
  CLOSED) header; echo "${red}${bold}Closed without merging.${reset}"; exit 0 ;;
esac

# gh pr view has no field for the merge queue, so the entry comes from GraphQL,
# as queue-and-clean reads it, along with the latest commit's checks counted by
# outcome: gh's own buckets, so they read as gh pr checks would say them.
# Owner, repo, and number are read off the PR's URL rather than asked for
# again. A failed query reads as "not queued", so the readiness check below
# still runs.
progress "Checking the merge queue and checks..."
IFS=/ read -r owner repo number < <(field .url | sed -E 's#^https://[^/]+/([^/]+)/([^/]+)/pull/([0-9]+).*#\1/\2/\3#')
extra=$(gh api graphql -F owner="$owner" -F repo="$repo" -F number="$number" \
  -f query='query($owner: String!, $repo: String!, $number: Int!) { repository(owner: $owner, name: $repo) { pullRequest(number: $number) { mergeQueueEntry { state position } commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 1) { checkRunCountsByState { state count } statusContextCountsByState { state count } } } } } } } } }' \
  --jq '.data.repository.pullRequest' 2>/dev/null) || extra=null
queue=$(jq -c '.mergeQueueEntry' <<<"${extra:-null}" 2>/dev/null) || queue=null
queue_state=$(jq -r '.state // empty' <<<"${queue:-null}" 2>/dev/null)
all=$(jq -r '
  def bucket: if IN("SUCCESS", "NEUTRAL", "COMPLETED") then "pass"
    elif . == "SKIPPED" then "skipping"
    elif . == "CANCELLED" then "cancel"
    elif IN("IN_PROGRESS", "PENDING", "QUEUED", "WAITING", "EXPECTED") then "pending"
    else "fail" end;
  [.commits.nodes[0].commit.statusCheckRollup.contexts // {} | (.checkRunCountsByState // []) + (.statusContextCountsByState // []) | .[] | select(.count > 0) | {bucket: (.state | bucket), count}]
  | group_by(.bucket) | map("\(map(.count) | add) \(.[0].bucket)")
  | ["pass", "fail", "pending", "cancel", "skipping"] as $order | sort_by(split(" ")[1] as $b | $order | index($b))
  | join(", ") | if . == "" then "none" else . end' <<<"${extra:-null}" 2>/dev/null) || all=unknown

if [ -n "$queue_state" ]; then
  position=$(jq -r '.position' <<<"$queue")
  header
  case "$queue_state" in
    AWAITING_CHECKS) echo "${green}${bold}In the merge queue${reset}${green} at position $position, waiting on the queue's checks.${reset}" ;;
    MERGEABLE)       echo "${green}${bold}In the merge queue${reset}${green} at position $position, passed and waiting its turn.${reset}" ;;
    LOCKED)          echo "${green}${bold}In the merge queue${reset}${green} at position $position, merging now.${reset}" ;;
    UNMERGEABLE)     echo "${red}${bold}In the merge queue at position $position, but it cannot merge${reset}${red}: it will be removed unless that changes.${reset}" ;;
    *)               echo "${green}${bold}In the merge queue${reset}${green} at position $position ($(tr '[:upper:]_' '[:lower:] ' <<<"$queue_state")).${reset}" ;;
  esac
  exit 0
fi

# GitHub works out mergeability lazily: the first ask after a push often comes
# back UNKNOWN, and asking again a moment later has the answer.
for _ in 1 2 3; do
  [ "$(field .mergeable)" != UNKNOWN ] && break
  progress "Waiting for GitHub to work out whether it can merge..."
  sleep 1
  pr=$(gh pr view --json "$fields" 2>/dev/null) || break
done

# Ready means every required check passes, so only a PR that isn't needs the
# background count of them. gh exits non-zero whenever a check is failing or
# pending, so its status is not an error there.
case "$(field .mergeStateStatus)" in
  CLEAN | HAS_HOOKS | UNSTABLE) required="${green}all passing${reset}" ;;
  *)
    progress "Reading the required checks..."
    wait "$required_pid" 2>/dev/null
    required=$(cat "$required_file")
    ;;
esac

header

case "$(field .mergeStateStatus)" in
  CLEAN)     verdict="${green}${bold}Ready to merge.${reset}" ;;
  HAS_HOOKS) verdict="${green}${bold}Ready to merge${reset}${green} (the repo runs merge hooks).${reset}" ;;
  UNSTABLE)  verdict="${green}${bold}Ready to merge${reset}${yellow}, though some optional checks are not passing.${reset}" ;;
  BEHIND)    verdict="${yellow}${bold}Not ready:${reset}${yellow} the branch is behind its base and must be updated.${reset}" ;;
  BLOCKED)   verdict="${red}${bold}Not ready:${reset}${red} blocked by a required review or check.${reset}" ;;
  DIRTY)     verdict="${red}${bold}Not ready:${reset}${red} it has merge conflicts.${reset}" ;;
  DRAFT)     verdict="${yellow}${bold}Not ready:${reset}${yellow} it is still a draft.${reset}" ;;
  *)         verdict="${yellow}${bold}GitHub has not worked out whether it can merge yet.${reset} ${dim}Try again in a moment.${reset}" ;;
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
  "Auto-merge" "$auto_merge"
