---
name: resolve-conflicts
description: Resolve git merge conflicts during a rebase, merge, or cherry-pick and carry the operation through to completion. Use when the user says they are in the middle of a rebase, mentions conflicts, or when a git operation stops with conflicted files.
---

# Resolve conflicts

Resolve the conflicts in the in-progress git operation and drive it to completion. Work through every conflicting commit without stopping to ask.

1. Run `git status` to see which operation is in progress (rebase, merge, cherry-pick) and which files are conflicted. For a rebase, also record the pre-rebase tip now, while the operation is still in progress, so step 7 has something to compare against:

   ```
   cat .git/rebase-merge/orig-head 2>/dev/null || cat .git/rebase-apply/orig-head 2>/dev/null
   ```

   Keep that SHA. Don't rely on `ORIG_HEAD` to still hold it later — it survives `--continue`, but any stash or reset along the way will overwrite it.
2. For each conflicted file, read it and resolve the conflict so both sides' intent is preserved. Use `git log` on the incoming commit when the intent isn't obvious from the markers alone.
3. `git add` each resolved file, then run `git diff --cached --check` to confirm no conflict markers were left behind.
4. Continue the operation with the editor disabled so it can't block on a commit message:
   - rebase: `git -c core.editor=true rebase --continue`
   - merge: `git -c core.editor=true merge --continue`
   - cherry-pick: `git -c core.editor=true cherry-pick --continue`
5. If the next commit also conflicts, repeat steps 2-4. Keep going until `git status` shows no operation in progress.
6. Report every commit that conflicted and how each one was resolved.
7. For a rebase, verify nothing was silently lost. Only once the rebase has fully finished — never between continues, where a detached mid-replay HEAD makes the output meaningless — run:

   ```
   git range-diff <orig-head-from-step-1>...HEAD
   ```

   Read the per-commit markers: `=` identical, `!` changed, `<` dropped, `>` added. Then check the output against what you expect:

   - A conflicted commit will show `!`, since it was replayed onto a new base. That's normal. What matters is the inner diff: lines the commit originally added should still be added. A `-+foo` paired with a `++bar` means your resolution replaced that commit's content, which is how intent gets dropped.
   - A `!` on a commit that never conflicted is suspicious and worth explaining.
   - A `<`/`>` pair for the same subject usually just means the content changed too much for `range-diff` to pair the commits, so inspect it rather than reporting it as a dropped commit.

   If the output shows content that should have survived but didn't, say so plainly and offer to fix it. Don't report the rebase as clean on the strength of step 3 alone — `git diff --cached --check` only catches leftover conflict markers, and a resolution that quietly drops a whole side passes it.

Steps 3 and 7 cover different failures, so run both. For a merge or cherry-pick, skip step 7: a merge doesn't rewrite commits (review the merge commit's diff instead), and cherry-pick never sets `orig-head`, so there is no before-tip to compare against.

Stop and ask instead of continuing when:

- A resolution requires choosing between two behaviors that can't both be kept, and the right choice isn't clear from the code or commit messages.
- The same commit conflicts again after a continue, which usually means the previous resolution was wrong.
- The only way forward is `--abort` or `--skip`, or dropping a commit's changes entirely.

Never run `git push` and never `--abort` without asking first.
