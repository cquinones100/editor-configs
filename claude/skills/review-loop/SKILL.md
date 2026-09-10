---
name: review-loop
description: Run the branch through repeated adversarial Codex reviews, fixing what each round finds, until Codex reports nothing left. Use when the user says a branch or PR is ready for review, asks to "run the review loop", or asks for a Codex review of the branch.
---

# Review loop

Have Codex review the current branch, fix the findings you agree with, commit, and review again. Stop when a round returns no findings, or when the round cap is hit. Push once at the end, after asking.

The reviewer is `codex-review`, installed from `editor-configs` with `./sync.sh codex-review`. It runs Codex read-only against committed history and prints one JSON object with `summary`, `findings`, and the commit it reviewed. If the command is missing, say so and stop; do not substitute your own review for Codex's.

Arguments: `all` means also act on low-severity findings. Anything else is ignored.

## Before the first round

1. Commit anything outstanding that belongs on the branch. `codex-review` refuses a dirty tree, and a review of code that is not committed is a review of the wrong thing.
2. Record the starting commit with `git rev-parse HEAD` so the final report can show `git log <start>..HEAD`.
3. Start an empty disputes file in the scratchpad directory. It carries findings you rejected forward to later rounds so Codex does not keep raising them.

## Each round (at most 5)

1. Run the reviewer. Without the `all` argument:

   ```
   codex-review --notes <disputes-file>
   ```

   With `all`, add `--include-low`. Pass `--base <branch>` only when the PR's base is not what Codex should diff against. Expect the command to take a few minutes; that is normal.

2. If `findings` is empty, the loop is done. Go to the final report.

3. Triage every finding by reading the code it points at. For each one decide:

   - **Fix it** when the finding is real. Make the smallest change that resolves it without weakening what the branch set out to do.
   - **Dispute it** when the finding is wrong, describes behavior the branch intends, or is out of scope for this PR. Append it to the disputes file as `- <title> (<file>:<line>): <one or two sentences on why it is wrong>`. Never "fix" a finding you believe is wrong just to make the loop end.

   Act on `critical`, `high`, and `medium`. Leave `low` alone unless `all` was given; it still goes in the final report.

4. If the project has a typecheck or lint command, run it on the files you changed. Do not run the test suite or end-to-end tests; those are a separate decision for the user.

5. Commit the fixes. One commit per round is fine when the fixes are related; split them when they are not. Write the message the way the repo's other commits are written: the intent, no bullets, no emojis.

6. If a fix changed what the PR delivers, or a `commit-claim` finding showed the description promising something the code does not do, update the PR body with `gh pr edit --body-file`. Keep the body's existing structure and tone. Do not add a section about this review.

7. Go back to step 1. Codex reviews from the merge base to `HEAD` every time, so it sees the whole branch including this round's commits.

## Final report

Say which of these ended the loop: a clean round, the round cap, or a blocker. Then give:

- **Rounds run** and the commits added, from `git log <start>..HEAD --oneline`.
- **Fixed**: each finding acted on, one line each.
- **Disputed**: each finding rejected and why, copied from the disputes file. These are for the user to overrule.
- **Left alone**: low-severity findings from the last round, if any.
- **PR description**: whether it changed and how.

Then ask whether to push. Never run `git push` without the user's explicit approval, even in auto mode. If the cap ended the loop with findings still open, list them and let the user decide whether to keep going.

## Stop and ask instead of continuing when

- A finding can only be fixed by changing what the branch is meant to do, not how it does it.
- Two findings contradict each other, or a fix for one would reintroduce another.
- The same finding comes back after you fixed it, which usually means the fix was wrong or Codex is reading stale state.
- `codex-review` fails twice in a row for the same reason.
