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

## shape

The step before `wt`: shapes a Linear ticket with Claude, from a rough idea or
an existing ticket that needs work.

```
shape "people can't tell which phase is active"
shape ABC-123
```

It starts Claude with the `/shape` skill, which holds the instructions, so
`/shape` works the same inside a session you already have. Claude reads the
code before asking anything, checks Linear for tickets that already cover the
idea, drafts the ticket in the layout the team's recent tickets use, and writes
it to Linear only once you approve the draft. It does not touch the code.
Given an existing ticket, it reads it first and asks whether to run the
repository's `/review-loop` on it in ticket mode (Codex checks the ticket
against the code), or keep shaping it; a review's findings can then be folded
into the ticket, again only once you approve. Afterwards `/wt <ID>` hands the same tab to `wt`, so one tab carries a ticket
from idea to PR.

- Runs in the repository's main checkout, even when called from a worktree,
  since a ticket being shaped has no branch yet.
- Fetches first and warns when the local main is behind its upstream, because
  Claude reads the files on disk. It never pulls.
- Inside tmux, names the tab "Shaping: <first words>" through the same
  `@tab_name` option `M-n` sets. `/wt` clears that name, or one you set
  yourself, when it takes the tab over, so the tab is named for the ticket
  like every other ticket tab.
- The team to create tickets in comes from `linearTeam` in
  `~/.config/worktree-from-ticket/config.json`, next to the API key, with
  optional default labels in `linearLabels`. Without `linearTeam`, Claude asks.
  Keeping them there keeps the team out of this repository.

```sh
./sync.sh shape
```

## shape-batch

Runs `shape` for several ideas or tickets at once, each in its own tmux window,
the way `wt-batch` does for `wt`.

```
shape-batch "phase label is unclear" "results load slowly" ABC-123
shape-batch "ABC-123, ABC-124"
shape-batch < ideas.txt
```

An idea is free text full of spaces and commas, so unlike `wt-batch` each
argument is one thing to shape; quote it. An argument made only of ticket
identifiers or Linear URLs is still split on spaces and commas. With no
arguments, ideas are read from stdin, one per line, and blank lines are
skipped. Repeats open once.

The windows go at the end of the tab list, in the order given, so no open tab
is renumbered, and focus stays where it is. Each idea is single-quoted before it is typed into its window's
shell, so whatever it contains reaches `shape` as text and is never run. Like
`wt-batch`, it must run inside tmux, from the repo the ideas belong to, and
needs `shape` installed.

```sh
./sync.sh shape-batch
```

## wt-batch

Runs `wt` for several tickets at once, each in its own tmux window. Tickets are
separated by commas, spaces, or both, and a full Linear issue URL works in
place of an identifier.

```
wt-batch ABC-123 ABC-124
wt-batch "ABC-123, ABC-124"
wt-batch ABC-123, https://linear.app/your-workspace/issue/ABC-124/some-title
```

The windows go at the end of the tab list, in the order given, so no open tab
is renumbered, each named after its ticket. Focus stays where it is, so the tabs fill in behind you
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

Windows whose Claude session is waiting on you come first, then ones that
finished while you were elsewhere, then the rest, from the `@agent` state
`tmux/agent-state.sh` keeps. The row says which ("waiting on you for 4m",
"finished 2m ago"), so typing "waiting" filters to them.

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

## wt-revive

The way back to a worktree whose tab you closed. Lists the worktrees no tmux
pane has open, and opens a tab in the one you pick, resuming its Claude with
`claude-here`, as `wtr` does.

```
wt-revive          fzf picker, from the current directory's repository
wt-revive <dir>    the same, starting from <dir>'s repository
wt-revive --list   print the rows, open nothing
```

The repositories are the one you are in, every open pane's, and every one a
Claude session ran in over the last two weeks, so a repository whose tabs are
all closed still counts. Each row is a worktree of one of them: its repository
and branch, how long since it was last used, and the last prompt Claude was
given there that says something ("yes" and "go ahead" don't), most recent
first. Worktrees whose directory is gone are left out.

What each transcript says, its last directory and last prompt, is kept in
`~/.cache/wt-revive/index.json` (readable only by you, since it holds prompts)
against the file's size and modified time, along with the repository each
directory belongs to. A press reads only the transcripts that changed since the
last one, so it takes about a quarter of a second rather than the three the
version that read the end of every transcript each time took.

### Setup

```sh
./sync.sh wt-revive
./sync.sh tmux
```

`M-o` in the tmux config opens it in a popup through `tmux/window-revive.sh`,
which puts node on the PATH (the tmux server has none, as with `wt-jump`) and
holds the popup open when there is an error or nothing to reopen.

### Notes

- A worktree counts as open when any pane is in it or below it.
- The session shown is the newest one that ended in the worktree or a
  directory below it. A session that started elsewhere and moved into the
  worktree belongs to the worktree.
- A worktree with any tab still in it isn't listed, the main checkout
  included. A closed tab that shared its directory with other tabs is reopened
  by hand: a new tab there and `claude --resume` to pick the session.

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

## slack-relay

Relays between a Slack app's DM and the Claude sessions in your tmux tabs, for
when you are away from the computer. It runs in its own tmux tab. The command
is `bin/slack-relay`; its code is in `lib/slack-relay/`, one file per part,
which `./sync.sh` doesn't need to install, since the command finds it from its
own location.

```
slack-relay          open it in a tab named "slack-relay", or go to that tab
                     (starting it again there if it has stopped)
slack-relay stop     stop it (or C-M-s, `stop` in the DM, or Ctrl-C in its tab)
```

`slack-relay` works from outside tmux too (a Claude job, ssh): it uses the
running tmux server, putting a new tab in its most recently used session.

A tab can hold other panes beside Claude, such as a shell, a server or
another Claude. The relay keeps each tab to its own Claude pane, whichever
pane you use: the first Claude pane it sees in a window (or the pane a `new:`
tab starts in) is recorded on the window as the tmux option `@claude_pane`,
and stays the tab's pane while it is open, through `/clear` or Claude being
started again in it. While that pane isn't running Claude, another Claude
pane in the window stands in; once it has closed, that one is recorded
instead.

When it starts, the relay says so in the DM with buttons for what you'd
otherwise type: **Home** first (a link to the app's Home tab, added once
Slack has sent the relay an event, since that is the only way it learns the
app's ID), then Status, Threads, Progress, New tab, Help and Stop relay, which
asks first. They answer at the top level, as the typed commands would.

Each Claude tab gets its own thread in the DM, started the first time there's
something to say about it: its alerts with their full turns, answers,
milestone pings all go there, and whatever you reply there is
typed into that tab. The main DM only gets one-line notices for what needs you
or went wrong (waiting on you, a failure), posted in the tab's
thread and also sent to the conversation, so tapping one opens the thread; you
can answer a notice as you would the alert, and a notice for a prompt carries
the prompt's option buttons, so it can be answered from the notice itself. A finished turn gets no notice,
since it is already in the thread. A request you send from the main DM (`3:
…`) goes on in the tab's thread, and its answer is sent to the main DM too. A tab's thread is watched for
as long as the tab is open, and a new window gets a new one.

In the DM:

- a reply under a tab alert is typed into that tab's Claude
- `3: <text>` or `ABC-214: <text>` types into a tab by number or ticket; sent
  at the top level, the conversation goes on in that tab's thread
- `3: ?`, or `?` under an alert, shows that tab's last turn: your last prompt
  and Claude's reply since, from its transcript (the screen if there is none)
- `status` lists every Claude tab, its state, and a link to its thread, which
  opens at the thread's newest message
- `threads` lists a link to each Claude tab's thread, to find a conversation
  again; a tab with no thread yet says so, and `3: …` starts one
- a new tab stopped at a dialog Claude Code shows before its session starts
  ("trust this folder", "new MCP server found") gets an alert too, with the
  dialog's options as buttons; tap one, or reply with its number or the start
  of it, and the relay moves to it with the arrow keys and presses Enter
- when a tab is waiting on a permission prompt or a question, the alert shows
  the question and its numbered options, read from the screen, with a button
  for each; tap one, or reply with the number or the start of an option. A
  button only answers the prompt it was made for, while that same wait is on,
  and is replaced by what was chosen once pressed. Only the number is pressed, with no Enter
  after it, since an Enter could accept a second prompt that follows. Anything
  else is refused while the choice is showing, rather than typed: it would end
  with Enter, which accepts whichever option is selected. The refusal carries
  the option buttons. Answering a prompt anywhere (a button on the alert, the
  notice or the Home tab, or a typed reply) clears the buttons from every other
  message showing it, and a prompt answered at the computer clears them all,
  so no button is left that would only be refused
- `progress 3`, or `progress` in a tab's thread, tells you what that tab is
  doing without typing anything into it: its state, when the turn began, when
  it last did anything and how many tools have run, then a few bullets from a
  one-shot Haiku that reads the turn's activity and the screen. That Haiku has
  no tools, MCP servers or settings, so nothing in a transcript can make it act;
  it takes about five seconds
- `progress all`, or just `progress` at the top level, does the same for every
  Claude tab at once: one line each, most urgent first (waiting on you, then
  stuck or failing, working, finished, idle)
- `diff 3`, or `diff` in a tab's thread, reads that tab's branch with git: its
  commits since the default branch and every change since, committed or not.
  The thread gets a summary, the commits and the file list, with the whole
  diff attached as a `.diff` file, which Slack shows as a snippet with colors
- `rename 3 <name>` (or `rename 3: <name>`), or `rename <name>` in a tab's
  thread, names the tab as `M-n` does: the tab bar, the second status line and
  its thread all show it. `rename 3` alone clears it, so the tab goes back to
  its ticket's or directory's name
- `close 3` offers a **Close** button for that tab, and so does each tab's
  screen on the Home tab. Slack asks to confirm first, and the button only closes the
  tab it was drawn for (same window and process), so it can't close a tab that
  has since taken its place. Closing ends the tab's Claude session;
  `claude-here` in its directory resumes it
- `esc 3`, or `esc` in a tab's thread, presses Escape in that tab, which stops
  Claude mid-turn or declines the prompt it is waiting on; a tab that isn't
  working or waiting is left alone, since a second Escape opens the rewind menu
- `new <place>: <prompt>` starts it somewhere else: `new myapp: …` in that
  repository's main checkout, `new ABC-214: …` (or any part of a branch name) in
  the worktree that matches, `new ~/code/thing: …` in that directory. Names are
  looked up among the repositories your tabs and recent Claude sessions use,
  as `M-o` does; a name that matches several places, or none, starts nothing
  and says so, and the reply names the directory and branch it picked
- an image attached to a message (a screenshot from your phone, say) goes to
  the tab with your text: the relay downloads it to
  `~/.local/state/slack-relay/files/`, readable only by you, and adds
  `[Image: <path>]` to what it types, which Claude Code reads as the picture.
  Only PNG, JPEG, GIF and WebP up to 20 MB, only from Slack's own file host,
  and only on a message you typed; anything else is answered, not fetched.
  Downloads are deleted after a week
- images a tab makes come back the same way: when a turn is posted, image
  files it names (a Playwright screenshot, a chart it saved) are uploaded under
  it. Only files that really are PNG, JPEG, GIF or WebP by their contents,
  written during that turn, up to 20 MB and four a turn, and never one you sent,
  so an old image a turn only mentions stays on the Mac
- `new: <prompt>` starts a new Claude tab with that prompt
- a finished turn has a **Diff** button, and **Continue** (types "continue")
  when Claude ended by asking a question; a note that a tab may be stuck has
  **Stop** (`esc`) and **Progress**, since that tab is still running
- anything that names no tab and isn't a command is not acted on, so a typo
  never starts work; the reply has a button per tab, and tapping one sends the
  message there. `help` lists the commands

When the relay is offline (the Mac off, truly asleep, or without internet),
Slack can still tell you, because the relay leaves the warnings with Slack in
advance. The Home tab opens with when your Mac last checked in, a time Slack
itself renders and keeps counting ("checked in 47 minutes ago"); the relay
publishes it every minute, so anything older than two means it is offline.
Beside it, **Refresh** publishes it at once.
And a message saying the relay is offline is kept scheduled in the DM about
ten minutes ahead, renewed every two minutes: if the relay goes quiet, nothing
pushes it back and Slack sends it, which notifies you. When the relay is back
it says so, and for how long it was gone. A clean stop cancels it.

The app's Home tab shows every Claude tab: its state, for how long, its last
activity and one line from Haiku on what it is doing or, once it has
stopped, where it left off (written again only when the tab does something), with an **Open** button for its screen, and for a tab waiting on a prompt, the prompt's options, which answer it from there. The relay publishes it when anything has
changed, once a minute at most, and whenever you open it.

A tab's screen (**Open**) is a Slack modal with its state, its last prompt and
the end of its last reply, the options of a prompt it is waiting on as
buttons, and buttons for **Message** (a field whose text is typed into the
tab, said in its thread and handled as a reply there, so a showing choice
still refuses anything but its options, and the answer goes in the thread),
its thread, **Progress** (a Haiku summary, shown in the screen), **Diff**
(posted in its thread), **Rename** (a field holding its name, cleared for its
own name back), **Stop** (Escape, only while it works or waits) and **Close**.

**Skill** runs a skill or slash command in the tab. Slack takes any message
starting with `/` for one of its own commands and never sends it, so
`/review-loop` can't be typed into a thread as it is at the keyboard. Skill
opens a form instead: a menu of the skills that tab can run, and a field for
what follows the name, such as a ticket ID. Run types `/<skill> <rest>` into
the tab as a reply in its thread would be typed, and the answer goes there.
The menu is the tab's own: the skills its session lists in its transcript,
plus those only you can invoke (which that list leaves out), read from
`~/.claude/skills` and `~/.claude/commands` and from `.claude` in the tab's
directory and the ones above it. It is grouped yours, the project's, then
plugins and built-in skills; a Slack menu holds 100 options, so a longer list
is cut from the end, and a field takes any name the menu left out. The same
Skill button sits under every
finished turn in a tab's thread, next to Diff. `3: /review-loop` from the main
DM, or a thread reply that starts with a space, also gets past Slack.

An open screen is drawn again whenever its tab's state changes, so a prompt
that has been answered at the computer leaves it. Like the Close button,
every one acts only on the tab it was drawn for, and only the relay's owner
can open a screen or use one: Home and modal presses, and the forms sent from
them, are taken from you alone, and only the ones these screens draw. **New
tab** at the top of the Home tab asks where and for the prompt, as
`new <place>: <prompt>` does. The bottom of the Home tab says what the Haiku
summaries and `progress` have cost today, from what `claude -p` reports for
each (about $0.0002 a call), also logged a line a call. When the relay stops
on purpose it says so, since nothing in it is current any more. Each tab's
thread starts with a header naming the tab, with its state and since when
(🔴 waiting on you, 🔵 working, ✅ finished, ⚪ idle) and buttons for
Progress, Diff, Skill, Rename and Close. The header is edited whenever the
tab is renamed or its state changes, so Slack's list of threads shows how
every tab stands, and once the tab closes or its window runs another session
it says the session has ended and offers **Delete thread** instead.

Slack doesn't let you delete the app's messages in its DM, only your own, so
the relay deletes a closed tab's thread for you: Delete thread on its header,
or **Delete closed threads** on the Home tab and under `cleanup`, all
confirmed by Slack first. It deletes the header and every message the app
posted in the thread, with the files it uploaded there. Your own replies
stay, since Slack doesn't let an app delete them, and the relay says how many
were left. Only threads of tabs that have closed (recorded as they close)
can be deleted, never a running tab's, and nothing deleted can be brought back. Answers longer than one Slack message go out as
several.

Everything it posts is standard Markdown, the way Claude writes, sent as
Slack markdown blocks, so headings, **bold**, [links](…), lists, tables and
code render as they do in the terminal, rather than as Slack's older mrkdwn,
which shows most of that as raw symbols.

It posts an alert when a tab's Claude is waiting on you or has finished, from
the state `tmux/agent-state.sh` keeps. A turn that ends in the tab you're
looking at isn't marked finished in tmux, since you saw it; its thread gets it
all the same, from the hook's event and the final message it carries. You
count as away once nothing has been typed or clicked for 30 seconds (macOS's
own idle time, which a locked screen counts too).

Each tab's thread always gets everything at once: finished turns, waits,
dialogs, stall notes and milestone pings, so it is a complete record whether
you were at the computer or not. What notifies you is the one-line notice in
the main DM (waiting on you, a dialog, a stall, a failing test), and those wait
while you're at the computer, since tmux already shows them, and go out in the
order they happened once you've been away 30 seconds. Replies to what you send
from Slack, and the results of requests you made there, never wait. Held
notices are kept in memory, so stopping the relay drops them. Writing to the relay from Slack counts as being away for five
minutes from your latest message, and sends what was held, since
you're likely on your phone; unless the Mac's keyboard or mouse was used in the
five seconds before it arrived, which means you wrote it in Slack on the Mac. An alert or answer for a tab that is
waiting also shows the end of its screen, since a permission prompt and its
numbered options are only there, not in the transcript; reply with the number. Tab states are read every second.

Slack pushes each message to the relay the moment you send it,
so it answers in about a second and costs nothing while you're quiet. Replies
under anything the relay posted in the last day (up to 30 threads), and under
each tab's thread for as long as the tab is open, are part of those
conversations; `3: …` always reaches the tab. The log records how long each
message waited to be handled. It keeps the Mac awake while it runs, but not
its displays, which sleep as usual. On a MacBook with the lid closed, let the
external monitors sleep rather than switching them off: with no display
connected, a closed MacBook sleeps whatever keeps it awake (clamshell sleep).

When it types your message into a tab, it posts nothing: your message's
reaction says where it is, ⏳ while it waits behind a turn already running, 👀
once that tab's Claude takes it, and ✅ once the answer is posted. While
it runs, a "Working on it" message with **Progress** and **Stop** buttons sits
where you asked, and is deleted once the answer is posted. If a tab that isn't busy hasn't taken it after 30 seconds, it posts
the tab's screen, since a dialog is usually what's in the way.

A tab marked working whose transcript hasn't changed for ten minutes gets a
note in its thread (what it did last, and its screen) and a line in the main
DM saying it may be stuck. A long test run looks the same, and the screen
usually tells the two apart. Each stall is noted once.

It follows every Claude tab's transcript and posts one line in the tab's
latest thread (or at the top level) when a session commits, pushes, opens a
pull request, or runs tests that fail. It doesn't watch CI: GitHub already
notifies about checks.

It knows a tab has answered from the Claude Code hooks: while it runs,
`tmux/agent-state.sh` appends an event to `~/.local/state/slack-relay/events.jsonl`
whenever a session takes a prompt, finishes a turn or starts waiting, naming its
transcript.
The file is removed only when the relay is stopped on purpose, and how far it
has been read is saved, so turns that end while it restarts are not lost.
When that transcript's last prompt is the text the relay typed, the relay posts
the turn within a couple of seconds. Sessions started before the hooks fall back
to the tab's screen staying still for 20 seconds.

If the relay crashes, it is started again within seconds, after a longer wait
each time, and posts that it restarted and why; messages sent meanwhile are
read back from the DM and still answered, as are those sent while its
connection to Slack was down. After five crashes in ten minutes it gives up and posts that it
is down. Stopping it (`stop`, C-M-s, Ctrl-C, closing its tab) is never taken
for a crash.

A lock file keeps it to one relay at a time. State, the events file and a log
(`relay.log`, which keeps what the tab shows) live in
`~/.local/state/slack-relay/`, readable only by you.

### The Slack app, and keeping it yours

The relay is a Slack app of its own, `Slack relay`, which you talk to in its
Messages tab. It needs, in the app's settings at api.slack.com/apps:

- Socket Mode on, and an app-level token with `connections:write`. Slack
  connects to the relay over a connection the relay opens, so nothing on the
  Mac listens for connections
- bot scopes `chat:write`, `im:history`, `im:read`, `im:write`,
  `reactions:write` (for the 👀 it adds to your messages), `files:read` and
  `files:write`
- the bot events `message.im` and `app_home_opened`, and nothing else
- Interactivity on, for the buttons (with Socket Mode, no Request URL)
- App Home's Home Tab on, and its Messages Tab on, with messages allowed from it

Both tokens live in the macOS Keychain, never in a file; each command asks for
the token rather than taking it on the command line:

```sh
security add-generic-password -U -a "$USER" -s slack-relay-bot-token -w   # xoxb-…
security add-generic-password -U -a "$USER" -s slack-relay-app-token -w   # xapp-…
```

Anyone in the workspace can open a DM with an app, so the relay only acts on
messages typed by one member, named in
`~/.config/slack-relay/config.json` (outside this repository):

```json
{ "owner": "<your Slack member ID: Profile → ⋯ → Copy member ID>" }
```

Everything else is ignored and logged, with no reply, so the app doesn't even
say it's listening: other members, other conversations, other workspaces, bots
(the relay's own posts included), edits and deletions. A message has to have
been typed, too: other apps can post as you (anything holding your Slack user
token, the Slack connector your Claude sessions use included), so a message
counts only if it carries the `client_msg_id` Slack's own apps give what you
type, which the Web API doesn't let an app set, and no `app_id`. Otherwise a
Claude session that read something malicious could post `1: …` as you and
drive your other tabs. For the same reason reactions control nothing: Slack
can't say whether you added one or an app did as you. The owner comes from
that file, never from a message. Everything the relay writes is refused before
it leaves the Mac unless it is for the app's DM with you, whatever asked for
it. Buttons are trusted the same way: a press counts only if it is yours, on a
message in that DM, and Slack only reports a press a person made in Slack, so
no app can press one as you. The app subscribes to no channel events and has no scopes to read
channels, so adding it to one shows it nothing.

```sh
./sync.sh slack-relay
```

Its tests run against a tmux server of their own, a temporary home directory
and stand-ins for Slack, so they never type into your tabs or post anything:

```sh
node --test test/*.test.js
```

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
