---
name: resolve-conflicts
description: Resolve git merge conflicts during a rebase, merge, or cherry-pick. Use when the user says they are in the middle of a rebase, mentions conflicts, or when a git operation stops with conflicted files.
---

# Resolve conflicts

I am in the middle of a rebase. Fix the conflicts.

1. Run `git status` to see which operation is in progress and which files are conflicted.
2. For each conflicted file, read it and resolve the conflict so both sides' intent is preserved. Use `git log` on the incoming commit when the intent isn't obvious from the markers alone.
3. `git add` each resolved file. Never leave conflict markers behind.
4. Report what was resolved and stop. Do not run `git rebase --continue`, `--abort`, or commit anything without asking first.
