---
name: queue-and-clean
description: The current branch's PR has been queued for merge. Watch it in the background and, once it merges, remove this worktree and its local branch.
disable-model-invocation: true
---

# Queue and clean

The user has queued this worktree's PR for merge, either in a merge queue or with auto-merge. Watch the PR without blocking the conversation. When it merges, remove the worktree and its local branch. If it closes without merging or leaves the queue, leave everything as it is.

When the work is done, the final message is either `queue-and-clean: success` or `queue-and-clean: fail: <reason>` and nothing else: no summary of what was checked or what was removed. `success` means the PR merged and the cleanup finished. `fail` means the PR closed or left the queue without merging, or a cleanup command errored, and the reason is one line saying which, with the error message when a command failed (for example `queue-and-clean: fail: git worktree remove: '<path>' contains modified or untracked files`). The questions in "Before watching" and in cleanup step 1 are still asked, because they pause the work rather than end it.

Arguments: a PR number, if one was given. Otherwise use the current branch's PR.

## Before watching

1. Read the PR and the repo:

   ```
   gh pr view <number-if-given> --json number,url,state,headRefName,headRefOid,autoMergeRequest
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
   - The PR is `OPEN` and the query in the next section prints `unqueued`. The user may not have queued it yet, or the queue may already have dropped it.

   If the PR is already `MERGED`, skip the watch and go straight to cleanup.

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
