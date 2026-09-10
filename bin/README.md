# bin

`./sync.sh bin` symlinks every executable here into `~/.local/bin`. To install
just one, pass its name instead: `./sync.sh worktree-from-ticket`.

## worktree-from-ticket

Creates a git worktree on a branch named after a Linear ticket, then opens
claude in it with the ticket as the prompt.

```
wt ABC-123
```

That creates `.claude/worktrees/abc-123-the-ticket-title-slugified` off the repo
root, checks out a matching branch, moves your shell into it, and opens claude
there. The shell stays in the worktree for the whole session, so new tmux panes
and splits open in the worktree too — and you're still there after claude exits.

### Setup

1. **Install the script.** From a clone of this repo:

   ```sh
   ./sync.sh worktree-from-ticket
   ```

   That symlinks this one script into `~/.local/bin` and touches nothing else —
   no other scripts, no editor or shell config. Make sure `~/.local/bin` is on
   your `PATH`. The clone can live anywhere.

2. **Add your Linear API key.** Create a personal key at
   <https://linear.app/settings/api>, then:

   ```sh
   mkdir -p ~/.config/worktree-from-ticket
   printf '{"linearApiKey":"lin_api_...","linearWorkspace":"your-workspace"}' > ~/.config/worktree-from-ticket/config.json
   chmod 600 ~/.config/worktree-from-ticket/config.json
   ```

   `LINEAR_API_KEY` in the environment also works and takes precedence, but the
   config file keeps the secret out of your shell config.

   `linearWorkspace` is the slug in your Linear URLs
   (`linear.app/<workspace>/issue/...`). `worktree-from-ticket` does not need it,
   but the tmux `M-l` binding reads it from here to open the current branch's
   ticket, so no workspace or team name has to be committed to this repo.
   `LINEAR_WORKSPACE` overrides it.

3. **Add one line to your shell config** (optional — see below):

   ```sh
   eval "$(worktree-from-ticket init zsh)"
   ```

   Use `bash` instead of `zsh` for bash. This defines the `wt` function.

### Why step 3 exists

Running `worktree-from-ticket ABC-123` directly works fine and needs no shell
setup at all — it creates the worktree and opens claude in it. The only thing it
cannot do is move your shell: changing directory affects only the calling
process, so no child process can relocate the shell that invoked it. That
requires a shell function, which is what `init` prints.

Without it you still get a working claude session in the worktree, but your shell
stays where it was — so new tmux panes open in the original repo, not the
worktree.

The function body lives in the script rather than in your shell config, so it
stays one stable line that never needs re-editing when the tool changes.

### Notes

- Add `.claude/worktrees/` to the target repo's `.gitignore`.
- The main clone's `.claude/settings.local.json` is symlinked into the new
  worktree when one exists, so personal permissions and the auto mode
  environment profile apply there too. A worktree that already has its own file
  is left alone.
- Rerunning on the same ticket is safe: it reuses an existing worktree, and
  reuses the branch if the worktree directory was removed.
- Pass a different parent directory as a first argument:
  `worktree-from-ticket .worktrees ABC-123`. A full Linear issue URL works in
  place of the identifier.
- `wt-cleanup` is the companion for removing finished worktrees. Install it the
  same way (`./sync.sh wt-cleanup`) if you want it.

## worktree-from-pr

The same idea for a GitHub pull request instead of a Linear ticket. Takes a PR
number or URL, creates a worktree on that PR's head branch, moves your shell
into it, and opens claude.

```
wtpr 123
wtpr https://github.com/owner/repo/pull/123
```

That creates `.claude/worktrees/pr-123-the-head-branch` off the repo root. The
directory is named after the PR rather than the branch because head branches
often contain slashes, which would nest worktrees inside shared parent
directories.

Unlike `wt`, claude opens with no prompt — you say what you want when you get
there.

Only PRs whose branch lives on the repo's own remote. Fork PRs are rejected with
a pointer to `gh pr checkout`, which is the tool that knows how to wire up a
contributor's fork.

### Setup

1. **Install the script.**

   ```sh
   ./sync.sh worktree-from-pr
   ```

2. **Install and authenticate gh.** <https://cli.github.com>, then `gh auth
   login`. There is no API key to configure. `gh` is only used to turn a PR into
   a branch name; the fetch and the worktree are plain git.

3. **Add one line to your shell config** (optional):

   ```sh
   eval "$(worktree-from-pr init zsh)"
   ```

   This defines the `wtpr` function. Same reasoning as step 3 above: only a
   shell function can move your shell into the worktree.

### Notes

- The branch is set up to track its remote counterpart, so `git push` and `git
  pull` work with no arguments.
- The main clone's `.claude/settings.local.json` is symlinked into the new
  worktree when one exists, so personal permissions and the auto mode
  environment profile apply there too. A worktree that already has its own file
  is left alone.
- Rerunning on the same PR is safe: it reuses the worktree, and if the branch is
  already checked out in some other worktree it points you there instead of
  failing. A local branch left over from an earlier run gets fast-forwarded to
  the PR head; if it has diverged, it is left alone with a warning rather than
  losing your commits.
- If the PR's branch is checked out in your main clone, the run stops and says
  so. Git allows a branch in one worktree at a time, so there is nothing to
  create — switch the main clone to another branch and rerun.
- Closed and merged PRs work too — the state is printed when it isn't open.
- Works on shallow and `--single-branch` clones: the PR's branch is added to the
  remote's fetch refspec when the existing one doesn't cover it.

## worktree-resume

The way back in. Takes the same ticket or PR the other two take, finds the
worktree they already made for it, moves your shell there, and hands off to
`claude-here` to resume the session that was running in it. What you run after a
restart, when the worktrees survived but the terminal didn't.

```
wtr ABC-123
wtr 123
wtr https://github.com/owner/repo/pull/123
```

Nothing is created and nothing is fetched. The worktree is found by matching the
identifier against `git worktree list` — `wt` and `wtpr` bake it into the branch
name and the directory name, so it is already recorded on disk. That means no
Linear key, no `gh`, and no network: recovery works on a plane.

### Setup

1. **Install the script.**

   ```sh
   ./sync.sh worktree-resume
   ```

2. **Install `claude-here`** and make sure it is on your `PATH`. That is the
   piece that knows how to find and resume a directory's claude session; this
   script only gets you standing in the right directory.

3. **Add one line to your shell config** (optional):

   ```sh
   eval "$(worktree-resume init zsh)"
   ```

   This defines the `wtr` function. Same reasoning as the other two: only a
   shell function can move your shell into the worktree.

### Notes

- Run it from anywhere in the repo, including from inside another worktree.
- If both a `wt` worktree and a `wtpr` worktree carry the same ticket — you
  opened the ticket, then opened its PR — you get a short numbered list, most
  recently touched first, and Enter takes that one.
- Matching is bounded on both sides, so `ABC-12` never lands you in `ABC-123`.
- A worktree git still tracks but whose directory is gone is reported as such
  rather than as "not found", since rerunning `wt` or `wtpr` is the fix.
- Resuming is `claude-here`'s job, so its own session picker appears when the
  worktree has more than one session.

## worktree-done

Reads every worktree in the repo, asks Linear what state each one's ticket is
in, and offers up the ones that are finished — completed, merged, deployed,
canceled, whatever your workflow calls them — in an fzf multi-select that
removes what you pick. The answer to "which of these forty directories can I
delete", and the deleting.

```
worktree-done           pick finished worktrees to remove
worktree-done --list    print them instead, removing nothing
worktree-done --all     print every worktree grouped by ticket state
worktree-done --paths   print only the finished worktrees' paths, for pipes
```

Keys in the picker are `wt-cleanup`'s, plus one: Tab toggles, `C-a` takes
everything, Enter removes what is selected, Esc cancels. Taking the whole list
at once asks for a `y` first — every other selection was made row by row and
speaks for itself.

`C-a` selects what the current query matches rather than the entire list, so
typing `abc-6` and hitting it takes those and not all forty. It
costs fzf's default `C-a` (beginning-of-line) inside the query, which is a short
field here.

`wt-cleanup` is still the tool for the worktrees this one will not touch — the
ones with no ticket, or whose ticket is still open.

### Setup

1. **Install the script.**

   ```sh
   ./sync.sh worktree-done
   ```

2. **Install fzf.** `brew install fzf`. Without it the command prints the list
   and says so, rather than removing nothing in silence.

3. **Add your Linear API key**, if you have not already. It reads the same
   `LINEAR_API_KEY` or `~/.config/worktree-from-ticket/config.json` that
   `worktree-from-ticket` reads, so if `wt` works this does too.

No shell function, so nothing to add to your shell config.

### Notes

- Finished means Linear's own `completed` or `canceled` state type, so a custom
  state like "Deployed to Production" or "Duplicate" counts without any
  configuration. The state's real name is what gets printed.
- The ticket is read from the branch first and the directory name second. Those
  usually agree, but when they don't the branch is the truth — a worktree named
  for one ticket sitting on another ticket's branch is worth seeing.
- A leading `pr-<number>-` is stripped before the identifier is matched, so a
  `wtpr` worktree is never read as ticket number `<number>` on a team called PR.
- Worktrees whose name yields no ticket are counted, not skipped, and `--all`
  lists them. They are usually PR worktrees for branches that never had one.
- One request per hundred tickets rather than one per worktree, so a repo with
  forty of them answers in a single round trip.
- The main clone is left out. Git will not remove it and its branch is normally
  the trunk, so it is never a cleanup candidate.
- Removal is `git worktree remove` with no `--force`, so a worktree holding
  uncommitted changes or untracked files refuses to go. The refusal is reported
  with the `--force` command to run if that is what you meant, and the rest of
  the selection still goes.
- Only the checkout is removed. The branch survives, so nothing you committed is
  lost even if the ticket turns out not to have been finished after all.

## codex-review

Runs Codex as an adversarial, read-only reviewer of the current branch and
prints its findings as JSON. It is the reviewer half of the `review-loop`
Claude skill in `claude/skills/review-loop`, which calls it, fixes what it
agrees with, commits, and calls it again until the findings list comes back
empty. It is also fine to run by hand for a second opinion.

```
codex-review                       review the branch against its PR's base
codex-review --base develop        diff against a different base
codex-review --notes disputes.md   give the reviewer context, e.g. findings you rejected last time
codex-review --include-low         report low-severity findings too
codex-review --dry-run             print the prompt and the codex command, run nothing
codex-review -- -m gpt-5.5         anything after -- goes to codex exec
```

The prompt is the one that used to be typed into a Codex pane by hand: assess
the code against what the commits assert, look for regressions and security
concerns, run no checks, be adversarial. The PR title and body are fetched with
`gh` and pasted in, so Codex never needs GitHub access. Codex runs with the
`read-only` sandbox and an ephemeral session, and is told to answer in a fixed
JSON shape: a `summary` plus `findings`, each with a severity, a category, a
file and line, a title, and the concrete failure it found.

### Setup

1. **Install the script.**

   ```sh
   ./sync.sh codex-review
   ```

2. **Log in to Codex** (`codex login`) if `codex` does not already work
   interactively. `codex exec` uses the same login.

3. **Trust the repo in Codex.** The first interactive `codex` run in a repo
   asks; `codex exec` will not, so do it once by hand.

### Notes

- Only committed changes are reviewed, and the command refuses to run on a
  dirty tree. Each round of the loop is then a review of exactly the commits
  the next round is compared against.
- Low-severity findings are dropped by the prompt unless `--include-low` is
  given. An adversarial reviewer asked for everything never runs out of nits;
  the loop needs a floor to converge.
- The base is the PR's base branch, or origin's default branch when there is
  no PR. With a PR the remote copy of the base is used, because that is what
  defines the PR's contents: an unpushed commit on your local `main` that the
  branch also carries is part of the PR and gets reviewed. Without a PR, the
  local or remote copy with the newer merge base is used, so only the branch's
  own commits are in scope whichever side is behind.
- The commit under review is pinned before Codex starts. If `HEAD` moves or the
  tree becomes dirty while it is reading, the result is discarded rather than
  labeled with a commit it does not describe.
- Codex's progress output is discarded so stdout is just the JSON. Set
  `CODEX_REVIEW_VERBOSE=1` to watch it on stderr.
