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
