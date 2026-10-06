# bin

`./sync.sh bin` symlinks every executable here into `~/.local/bin`. To install
just one, pass its name instead: `./sync.sh worktree-from-ticket`.

## worktree-from-ticket

Creates a git worktree on a branch named after a Linear ticket, then opens
claude in it with a prompt that carries the ticket's Linear state: if that state
is a closed one (completed, cancelled, or duplicate, whatever the workspace
calls them) the prompt asks whether to reopen the ticket before anything else
happens. Then it checks the ticket against the current codebase (is it still
relevant and necessary, is the approach sound, how could it be improved). A
detail the ticket gets wrong it builds correctly without asking and then edits
into the ticket, leaving the PR description to describe the work rather than the
journey; only a change of scope stops and waits for an answer. Then it works on
the ticket without running tests, lint, or any other checks, runs the
`review-loop` skill, and pushes and creates a PR. Its final message has only a
ticket check ("Unchanged." or the edits made to the ticket), "PR pushed" or "PR
not pushed" with the reason, and a note about the review loop only when it hit
its round cap.

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
- Unless Claude is already running in that worktree. Then `wt` refuses, rather
  than start a second session editing the same files and pushing the same
  branch, and prints the running session's ID, its title (a `/rename` name, or
  the one Claude generated), and its tmux window. Running sessions are found
  through the files Claude Code keeps in `~/.claude/sessions`, ignoring any
  whose process has ended.
- Pass a different parent directory as a first argument:
  `worktree-from-ticket .worktrees ABC-123`. A full Linear issue URL works in
  place of the identifier.
- `wt-cleanup` is the companion for removing finished worktrees. Install it the
  same way (`./sync.sh wt-cleanup`) if you want it.
- `wt-batch` opens several tickets at once, one tmux window each, and
  `wt-jump` gets you back to any of those windows by ticket, PR, or branch.

## wt-batch

Runs `wt` for several tickets at once, each in its own tmux window. Tickets are
separated by commas, spaces, or both, and a full Linear issue URL works in
place of an identifier.

```
wt-batch ABC-123 ABC-124
wt-batch "ABC-123, ABC-124"
wt-batch ABC-123, https://linear.app/your-workspace/issue/ABC-124/some-title
```

The windows are inserted right after the current one, in the order given, each
named after its ticket. Focus stays where it is, so the tabs fill in behind you
while you keep working. Repeated tickets open once, and every ticket is checked
before any window opens, so a typo in one leaves none of them half-started.

### Setup

1. **Install the script.**

   ```sh
   ./sync.sh wt-batch
   ```

2. **Have `wt` working**, meaning `worktree-from-ticket` installed with its
   Linear key and the `eval "$(worktree-from-ticket init zsh)"` line in your
   shell config. `wt-batch` does no Linear work of its own; it only opens the
   windows and types `wt <ticket>` into each.

### Notes

- Must be run from inside tmux. The new windows start in the directory the
  command was run from, so run it from the repo the tickets belong to.
- `wt` is typed into each window's interactive shell rather than run as the
  window's command, for the reason `wt` is a shell function in the first place:
  the shell has to be what cd's, so it stays in the worktree after claude exits
  and panes split from it open there too. It also means the `wt` that runs is
  whatever your shell config defines, so the shell has to be zsh or bash with
  that line in place.

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
- For a worktree whose tmux window is still open, `wt-jump` is the shorter
  path: it selects that window instead of starting another session in it.

## wt-jump

The way back to a window you still have open. Takes the same ticket or PR the
other tools take, or any part of a branch name, finds the tmux window sitting in
that worktree, and selects it.

```
wt-jump ABC-123      the ticket's window
wt-jump 123          the PR's window
wt-jump theme-slot   any window whose branch or name contains that
wt-jump              fzf picker over every window
wt-jump --list       print the windows, jump to none of them
```

Each row is the window's second tmux status line, from the same
`tmux/tab-status.sh` tmux runs for the bar: its label (custom name, ticket and
title, or directory), PR, program, and in a Claude pane the session title and
last prompt, coloured the same way. That is what the picker searches, so a
ticket title or something you said to Claude finds the window. It needs
`./sync.sh tmux` as well as `./sync.sh wt-jump`; without the tmux script a row
falls back to its repository, PR, and branch. Every window is rendered at once,
which takes about a second with a dozen open.

Windows are matched on what is on disk — the worktree directory and the branch
checked out in it — not on the window name. The name is rewritten by the
pane-focus-in hook and says nothing about pull requests, and a window opened by
hand never had a useful one to begin with.

A bare number is answered offline wherever it can be: from a `pr-<n>` worktree,
which is what `wtpr` creates, or from the `#<n>` the tmux tab already carries
once `window-pr.sh` has looked it up. Only when neither knows is `gh` asked
which branch the PR is on, so a ticket worktree that opened a PR minutes ago —
before anything cached the number — is still reachable by it. The difference is
about half a second.

### Setup

1. **Install the script.**

   ```sh
   ./sync.sh wt-jump
   ```

2. **Install fzf** if you want the no-argument picker. `brew install fzf`.
   Jumping by ticket, PR, or branch needs nothing but tmux and git; only the
   picker and the `M-j` binding below need fzf.

No shell function, so nothing to add to your shell config. Unlike `wt` and
`wtr`, this one never has to move your shell — tmux does the moving, and a
child process can ask tmux to do that.

### Notes

- `M-j` in the tmux config opens the picker in a popup, which is the form this
  gets used in most: a list of every window labelled by repository, PR number,
  and branch, type a few letters, Enter. fzf searches the whole row, so a PR
  number finds its window there as well as on the command line. The column is
  left out when no window has a number to show. It goes through `tmux/window-jump.sh`, which exists
  because the tmux server has no node: its environment is whatever it started
  with, and nvm is set up in `~/.zshrc`, which only interactive shells read.
  That wrapper finds node the cheap way, through nvm's default alias, and holds
  the popup open on an error instead of letting it close too fast to read.
- Every pane is considered, not just each window's active one, and the pane
  that matched is the pane you land on — so a window holding claude beside a
  shell in the worktree puts you in the right half of it.
- Windows in other sessions are matched too, and the session is switched along
  with the window.
- One match jumps outright. Several — the same worktree open twice, or a branch
  fragment that is not unique — print a short numbered list, first one on Enter,
  the same prompt `worktree-resume` uses.
- Ticket matching is bounded on both sides, so `ABC-12` never lands you in
  `ABC-123`. A branch fragment is a plain substring, since that is what you are
  reaching for when you type one.
- Nothing is created. If no window is open for the identifier, the error says so
  and prints the `wt` or `wtpr` that would open one. `wtr` is the tool for a
  worktree that exists but has no window.
- `gh` is only consulted for a PR number that no `pr-<n>` worktree matches, and
  only against the repositories you have windows open in, so the offline cases
  stay offline.

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

Runs Codex as a skeptical, read-only static reviewer of the current branch and
prints its findings as JSON. It is the reviewer half of the `review-loop`
Claude skill in `claude/skills/review-loop`, which calls it, fixes what it
agrees with, commits, and calls it again until the findings list comes back
empty. It is also fine to run by hand for a second opinion.

```
codex-review                       review the branch against its PR's base
codex-review --base upstream/main  diff against a different base, used as given when the ref exists
codex-review --notes notes.md      disputed findings and accepted known gaps, each with a reason
codex-review --include-low         report low-severity findings too
codex-review --dry-run             print the prompt and the codex command, run nothing
codex-review --model gpt-5.5       pick the Codex model; no other Codex option passes through
```

The prompt is the one that used to be typed into a Codex pane by hand: assess
the code against what the commits assert, look for regressions and security
concerns, run no checks, treat every claim as unproven until the code shows it.
It is a static review with the burden of proof on the code, not a red team: Codex
cannot execute, build, or probe anything, so a suspicion it cannot make concrete
from the code is left out of the findings and noted in the summary as something
a hands-on test would need to check. The PR title and body are fetched with
`gh` and pasted in, so Codex never needs GitHub access. Codex is told to answer
in a fixed JSON shape: a `summary` plus `findings`, each with a severity, a
category, a file and line, a title, and the concrete failure it found.

Codex runs with the least access it can currently be given, because a reviewer
needs to read code and nothing else:

- The `read-only` sandbox for anything the model runs, which also blocks
  network access for those commands, with `approval_policy=never` so a command
  that needs more access fails instead of asking for it. Approval rules from
  `.rules` files, which let matching commands run outside the sandbox, are
  ignored.
- Your `~/.codex/config.toml` is not loaded, so MCP servers, plugins and other
  integrations set up for interactive use do not come along. Login does.
- `AGENTS.md` and its fallbacks are not loaded as instructions. On a branch
  under review that file belongs to the contributor; the prompt tells Codex to
  read any agent instruction file the branch touches as code that tries to
  steer automated tools. Verified: with loading on, a hostile `AGENTS.md` in a
  probe repository reached the model as an instruction; with it off, it did not.
- Commands Codex runs see only core environment variables such as `PATH` and
  `HOME`, not the tokens in the calling shell's environment.
- Commit messages and the PR title and body are placed in the prompt inside
  fenced blocks Codex is told to treat as data, never as instructions, and to
  report as a finding if they try to steer the review. The person running the
  review still verifies every finding against the code before acting on it.
- The only Codex option that passes through is `--model`. Arbitrary
  passthrough would let whoever builds the command line, another agent
  included, undo the sandbox.
- The temp directory holding the schema and Codex's answer is removed on every
  exit path, so a failed run does not leave code excerpts behind.

What that does not cover: the read-only sandbox lets commands read any file
your user can read, not only the repository. Codex's custom permission profiles
can confine reads to the workspace, but in the current release any custom
profile also makes the workspace writable, even one that extends `:read-only`
(verified with `codex exec`: `touch` succeeded while `~/.zshrc` was denied).
For a reviewer that is the worse trade, since a write into `.git/hooks` or an
ignored directory survives the clean-tree check. Wrapping Codex in an outer
macOS seatbelt does not work either: the kernel refuses to apply Codex's inner
sandbox under any outer profile that contains a deny rule. So a prompt injection
that gets Codex to read a file outside the repository can put its contents in
the review output. That output is the JSON this script prints, and commands
have no network, so it cannot go anywhere else. Findings that name or mention a
path outside the repository are listed in a `warnings` array in the JSON and
printed to stderr, so the caller reads those before acting on them. Full
isolation means running the reviewer in a container that holds only the
checkout and the Codex login.

### Setup

1. **Install the script.**

   ```sh
   ./sync.sh codex-review
   ```

2. **Log in to Codex** (`codex login`) if `codex` does not already work
   interactively. `codex exec` uses the same login. Nothing else in your Codex
   configuration is read, so no per-repository trust step is needed.

### Notes

- Only committed changes are reviewed, and the command refuses to run on a
  dirty tree. Each round of the loop is then a review of exactly the commits
  the next round is compared against.
- The notes file is how the author talks back. A disputed finding is not
  raised again unless the reasoning is wrong; a known gap the author has
  accepted is not reported unless its impact is larger than the note admits.
  Anything the notes leave out is fair game, which is the point: a limitation
  acknowledged in chat but not written down is a finding hidden from the
  reviewer.
- Low-severity findings are dropped by the prompt unless `--include-low` is
  given. A skeptical reviewer asked for everything never runs out of nits;
  the loop needs a floor to converge.
- The base is the PR's base branch, or origin's default branch when there is
  no PR. With a PR, the base is read from the remote whose URL points at the
  PR's repository, which is not always `origin` in a clone with several
  remotes. That remote's copy of the base is used because it defines the PR's
  contents: an unpushed commit on your local `main` that the
  branch also carries is part of the PR and gets reviewed. Without a PR, the
  local or remote copy with the newer merge base is used, so only the branch's
  own commits are in scope whichever side is behind. A PR whose remote base has
  not been fetched, or that comes from a different repository than it targets,
  stops the run with the command or `--base` to use instead of guessing.
- `gh pr view` failing for any reason other than "no pull requests found" stops
  the run too. An expired login must not turn into a review against the wrong
  base with the prompt claiming there is no PR.
- The commit under review is pinned before Codex starts, and the prompt scopes
  the diff by SHA rather than `HEAD`. If `HEAD` or the working tree differs
  when Codex finishes from when it started, the result is discarded rather than
  labeled with a commit it does not describe. This is a check at both ends, not
  a snapshot: a branch switch that is switched back before Codex finishes goes
  unnoticed, so leave the checkout alone while a review runs.
- Codex's progress output is discarded so stdout is just the JSON. Set
  `CODEX_REVIEW_VERBOSE=1` to watch it on stderr.
