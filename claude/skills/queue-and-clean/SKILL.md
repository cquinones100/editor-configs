---
name: queue-and-clean
description: Queue the current branch's PR for merge if it is not queued already, watch it in the background, and once it merges remove this worktree and its local branch.
disable-model-invocation: true
---

# Queue and clean

Queue this worktree's PR for merge, in the merge queue or with auto-merge, unless it is already queued. Then watch the PR without blocking the conversation. When it merges, remove the worktree and its local branch. If it closes without merging or leaves the queue, leave everything as it is.

When the work is done, the final message is either `queue-and-clean: success` or `queue-and-clean: fail: <reason>` and nothing else: no summary of what was checked or what was removed. `success` means the PR merged and the cleanup finished. `fail` means the PR could not be queued, closed or left the queue without merging, or a cleanup command errored, and the reason is one line saying which, with the error message when a command failed (for example `queue-and-clean: fail: git worktree remove: '<path>' contains modified or untracked files`). The questions in "Before watching", the merge method question in "Queuing", and the questions in cleanup step 1 are still asked, because they pause the work rather than end it.

Arguments: a PR number, if one was given. Otherwise use the current branch's PR.

## Before watching

1. Read the PR and the repo:

   ```
   gh pr view <number-if-given> --json number,url,state,isDraft,headRefName,headRefOid,autoMergeRequest
   gh repo view --json owner,name --jq '.owner.login + " " + .name'
   ```

2. Record the paths the cleanup needs now, while the worktree still exists:

   ```
   git rev-parse --show-toplevel
   git rev-parse --path-format=absolute --git-common-dir
   ```

   The first is the worktree. The parent of the second is the main clone. If they are the same directory this is the main clone, not a worktree: say so and stop.

3. Stop and ask when any of these is true:
   - The PR's `headRefName` is not the branch checked out here. Cleaning up would remove the wrong thing.
   - The PR is `CLOSED`.
   - The PR is a draft. Queuing it would mean marking it ready for review, which is the user's call.

   If the PR is already `MERGED`, skip the queue and the watch and go straight to cleanup.

## Queuing

Check whether the PR is already queued, with the same query the watch uses:

```
gh api graphql -F owner=<owner> -F repo=<repo> -F number=<number> \
  -f query='query($owner: String!, $repo: String!, $number: Int!) { repository(owner: $owner, name: $repo) { pullRequest(number: $number) { autoMergeRequest { enabledAt } mergeQueueEntry { state } } } }' \
  --jq '.data.repository.pullRequest | if .autoMergeRequest or .mergeQueueEntry then "queued" else "unqueued" end'
```

If it prints `queued`, skip the rest of this section and start watching. If it prints `unqueued`, queue it:

```
gh pr merge <number> --auto --match-head-commit <headRefOid>
```

`--match-head-commit` makes GitHub refuse if the branch moved since you read it, so what gets queued is what was checked. On a branch that requires a merge queue this needs no merge strategy: gh enables auto-merge if required checks are still running, or adds the PR to the queue if they have passed. Without a merge queue gh refuses until it is given one. Then read the methods the repo allows:

```
gh repo view --json squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed
```

If exactly one is allowed, rerun with its flag (`--squash`, `--merge`, or `--rebase`). If more than one is, ask the user which to use. Keep that flag for any later `gh pr merge` in this run. Never pass `--admin`, which skips the queue and the required checks, and never pass `--delete-branch`.

### When the repo does not allow auto-merge

If `gh pr merge` fails with `Auto merge is not allowed for this repository`, the repo has auto-merge turned off in its settings. A merge queue can still be in use: gh only asks for auto-merge when GitHub does not yet consider the PR mergeable, and once it does, the same command adds the PR to the queue, or merges it outright where there is no queue. So do auto-merge's job yourself: wait until GitHub calls the PR mergeable, then run the command again without `--auto`.

Wait on GitHub's own merge state, not on `gh pr checks --watch`. That command stops as soon as every check reported so far has finished, and a required check that has not been created yet does not count, so it can say "passed" while GitHub still reports the PR as `BLOCKED`. Retrying then fails with the same auto-merge error.

Start this with the Bash tool's `run_in_background`, as with the watch below, so the conversation is not blocked:

```
stuck=0
while :; do
  pr_state=$(gh pr view <number> --json state,mergeStateStatus,statusCheckRollup \
    --jq '[.state, .mergeStateStatus, ([.statusCheckRollup[] | select((.status // "COMPLETED") != "COMPLETED" or .state == "PENDING" or .state == "EXPECTED")] | length)] | @tsv') \
    || { sleep 30; continue; }
  IFS=$'\t' read -r state merge running <<<"$pr_state"
  case "$state" in
    MERGED) echo merged; exit 0 ;;
    CLOSED) echo closed; exit 0 ;;
  esac
  if gh pr checks <number> --required 2>/dev/null | awk -F'\t' '$2 == "fail"' | grep -q .; then
    echo failed; exit 0
  fi
  case "$merge" in
    CLEAN|HAS_HOOKS|UNSTABLE|BEHIND) echo ready; exit 0 ;;
    DIRTY) echo conflicts; exit 0 ;;
    BLOCKED)
      if [ "$running" -eq 0 ]; then
        stuck=$((stuck + 1)); [ "$stuck" -ge 20 ] && { echo stuck; exit 0; }
      else
        stuck=0
      fi ;;
    *) stuck=0 ;;
  esac
  sleep 30
done
```

`BEHIND` counts as ready because a merge queue brings the branch up to date itself; if the repo has no queue and insists on an up-to-date branch, the merge below fails and says so. A failed request is retried rather than read as an answer. `BLOCKED` with nothing still running is given ten minutes, since a required check can take that long to appear at all, before it is treated as stuck.

When it exits:

- `ready`: run `gh pr merge <number> --match-head-commit <headRefOid>` again, with the merge method flag if one was needed above, and without `--auto`. Then start watching. If it fails with the same auto-merge error, GitHub changed its mind between the two calls: start the wait again, up to three times in all, then report it as any other `gh pr merge` failure.
- `failed`: reply `queue-and-clean: fail: required checks failed: <names of the failing checks>`, from `gh pr checks <number> --required`, and stop.
- `conflicts`: reply `queue-and-clean: fail: PR has merge conflicts` and stop.
- `stuck`: reply `queue-and-clean: fail: PR is blocked by something other than checks, such as a required review` and stop.
- `merged` or `closed`: someone else finished it. Go to cleanup for `merged`; reply `queue-and-clean: fail: PR closed without merging` for `closed`.

If `gh pr merge` still asks for auto-merge after the third wait, and the repo has a merge queue, add the PR to the queue directly. `expectedHeadOid` does what `--match-head-commit` does:

```
gh api graphql -F id="$(gh pr view <number> --json id --jq .id)" -F oid=<headRefOid> \
  -f query='mutation($id: ID!, $oid: GitObjectID!) { enqueuePullRequest(input: {pullRequestId: $id, expectedHeadOid: $oid}) { mergeQueueEntry { position state } } }'
```

The user's `enforce-gh-api-readonly.sh` hook blocks every other GraphQL mutation and lets this one through on its own, so send it alone. Never call `enablePullRequestAutoMerge`: the repo has turned auto-merge off on purpose.

If the branch moved while you waited, `--match-head-commit` makes the merge fail. That is the right outcome, since the new commits are not the ones that were checked: report it as any other `gh pr merge` failure.

### Any other failure

If `gh pr merge` fails for any other reason, such as a missing review or a merge conflict, reply `queue-and-clean: fail: gh pr merge: <its error message>` and stop.

Once it succeeds, start watching. Do not check the state yourself first: right after queuing, GitHub can briefly show neither auto-merge nor a queue entry, and the watch already allows for that. It also covers a PR that GitHub merged straight away because nothing was left to wait for.

## Watching

Start this with the Bash tool's `run_in_background`, filling in owner, repo, and number. You are re-invoked when it exits, so do not poll it yourself and do not sleep in the foreground. Tell the user that you are watching and that they can keep working in the meantime.

```
query='query($owner: String!, $repo: String!, $number: Int!) { repository(owner: $owner, name: $repo) { pullRequest(number: $number) { state autoMergeRequest { enabledAt } mergeQueueEntry { state } } } }'
misses=0
while :; do
  pr_state=$(gh api graphql -F owner=<owner> -F repo=<repo> -F number=<number> -f query="$query" \
    --jq '.data.repository.pullRequest | [.state, (if .autoMergeRequest or .mergeQueueEntry then "queued" else "unqueued" end)] | @tsv') || { sleep 60; continue; }
  case "$pr_state" in
    MERGED*) echo merged; exit 0 ;;
    CLOSED*) echo closed; exit 0 ;;
    *unqueued) misses=$((misses + 1)); [ "$misses" -ge 2 ] && { echo dequeued; exit 0; } ;;
    *) misses=0 ;;
  esac
  sleep 60
done
```

A failed request is retried rather than read as a result, so a network blip never ends the watch. Leaving the queue has to be seen twice in a row, because GitHub briefly shows neither auto-merge nor a queue entry while it moves a PR from one to the other.

When it exits:

- `merged`: clean up.
- `closed`: leave the worktree alone and reply `queue-and-clean: fail: PR closed without merging`.
- `dequeued`: leave the worktree alone and reply `queue-and-clean: fail: PR left the queue without merging`.

## Cleanup

Only after GitHub reports the PR `MERGED`. If any command in steps 2 to 4 errors, stop there and reply `queue-and-clean: fail: <command>: <its error message>`.

1. Make sure nothing would be lost. Stop and ask if either check fails. Never reach for `--force` to get past one.
   - `git -C <worktree> status --porcelain` must print nothing.
   - `git -C <worktree> rev-parse HEAD` must equal the PR's final head. Get it again with `gh pr view <number> --json headRefOid`, because the queue may have updated the branch after you first read it. A difference means there are local commits the merge did not include.
2. Remove the worktree from the main clone, so nothing runs from inside the directory being deleted:

   ```
   git -C <main-clone> worktree remove <worktree>
   ```

3. Delete the local branch. It has to be `-D`: a squash or rebase merge leaves the branch looking unmerged to git, and step 1 already showed GitHub has every commit on it.

   ```
   git -C <main-clone> branch -D <branch>
   ```

4. Run `git -C <main-clone> fetch --prune origin` so the deleted remote branch stops showing up. Do not check anything out or pull in the main clone. Its working tree is not yours to change.
5. Reply `queue-and-clean: success`. From here on every command needs `git -C <main-clone>` or an absolute path, since the shell's working directory no longer exists.

Never run `git push` and never delete the remote branch. GitHub or the repo's settings handle that.
