# editor-configs

Dotfiles for the tools listed by directory. `sync.sh` symlinks them into place.

## Pushing

Always ask before pushing this repo, every time, whatever the branch and
whatever an earlier push was allowed. The repo is public, so before asking,
check the unpushed commits for anything that identifies the user or their
employer: organization or company names, ticket IDs, PR numbers, internal
hosts, usernames, personal paths, tokens.

## Claude Code settings

- `claude/settings.json` is symlinked to `~/.claude/settings.json`, so anything Claude Code persists to user settings shows up as a tracked change here.
- Claude Code reads only four settings files: `~/.claude/settings.json`, the project's `.claude/settings.json` and `.claude/settings.local.json`, and managed settings. There is no user-level `settings.local.json`.
- Anything that describes a specific organization's environment must not live in the tracked file. The auto mode environment profile (the `autoMode` key) belongs in that project's `.claude/settings.local.json`, which is gitignored there. If Claude Code writes `autoMode` back into `claude/settings.json`, move it again before committing. `.githooks/pre-commit` refuses a commit that stages `autoMode` in that file, or any change to its `model`, which Claude Code rewrites whenever `/model` is used; commit the rest of the file with `git add -p`. The hook only runs where `./sync.sh git` has pointed this clone's `core.hooksPath` at `.githooks`, so run that on every new machine. Claude itself can't get around it: `claude/hooks/enforce-git-hooks-run.sh` blocks `git commit --no-verify` (and `-n`) and any change to `core.hooksPath`. The worktree scripts in `bin/` symlink the project-local file into each worktree so it applies there too.

## Window names and accent colors

`tmux/accent-color.sh` produces two different strings from the same directory.
The color key is hashed into the accent color, and `claude/statusline-command.sh`
and `iterm/Scripts/AutoLaunch/session_title.py` build the same key independently,
so changing its shape in one place silently gives tmux, the iTerm tab, and the
Claude statusline three different colors for one project. The window name is
only ever read, so it is free to change.

`tmux/window-names.sh` owns the tab: the label from `tmux/tab-label.sh`, cut to
30 characters, prefixed with `#<number>` when the branch has a pull request.
`wt-jump` reads that prefix back to find PRs, so it stays at the front. The
label is the name set with `M-n` (the window's `@tab_name`), else the Linear
ticket and its title when the branch names one Linear confirms, else
`accent-color.sh --name`. The same name uncut, PR prefix included, goes in
the window's `@tab_label`, which `bin/slack-relay` shows in Slack in place of
the cut one. The second status line, `tmux/tab-status.sh`, starts
with the same label uncut, so any change to what a window is called belongs in
`tab-label.sh` and reaches both.

All of this runs on every pane focus, for every window in the session, or on
every status redraw, so none of it may wait on the network.
`tmux/window-pr.sh` and `tmux/ticket-title.sh` answer from a cache and refresh
it in the background, then rename the tabs when the answer changes, so a PR
number or ticket title that was not known yet appears a second later rather
than delaying the focus. Anything else that wants to add to the tab belongs in
`window-names.sh` under the same rule.

It must not start many processes either. A security agent on this Mac inspects
every process that starts, and the status line and focus hook used to start
dozens per window, which made tmux sluggish. `tmux/path-facts.sh` therefore
answers a directory's color, ticket label and PR from a cache that holds only
while the branch stays the same (ten minutes once there is a PR, one minute
before), and `window-pr.sh` and `ticket-title.sh` clear that cache when they
learn something new. `tab-status.sh` keeps a Claude pane's session name and
prompt the same way, until the session file or prompt history changes. Anything that
depends only on the directory and its branch belongs there, and should be read
from there.

## Claude session state in tmux

`tmux/agent-state.sh` records what each Claude session in tmux is doing, from
Claude Code's hooks in `claude/settings.json`: `UserPromptSubmit`,
`PostToolUse`, and `PostToolUseFailure` mark the pane working,
`PermissionRequest` and the question kinds of `Notification` mark it waiting,
`Stop` marks it done, and `SessionStart` and `SessionEnd` clear it. The
`Notification` hook also sends the macOS banner, titled with the tmux window.
The state lives on the pane (`@agent_state`, `@agent_since`) and is rolled up
into the window's `@agent`, most urgent first (waiting, done, working), which
the `@agent_marker` format in `tmux.conf` shows in the tab. Every
window-status format in `tmux.conf`, `theme.sh`, `update-colors.sh`, and
`window-names.sh` expands that marker, so a new one has to as well.

A conversation moved into the background keeps running in a job with no tmux
of its own, so its hooks have no `TMUX_PANE`. The tab it came from holds a
parked Claude whose session file names the job (`parkedJobId`, matching the
job's `jobId` in `~/.claude/sessions/`), and `agent-state.sh` follows that
link to mark the tab, so a backgrounded conversation still shows as working,
waiting or done there rather than idle.

Whether a pane runs Claude is decided in `tmux/claude-pane.sh`, which
`agent-state.sh` and `tab-status.sh` source, and again in
`lib/slack-relay/tabs.js`, so a change to one belongs in the other. tmux names
a pane after its foreground program: Claude Code's executable is named after
its version, but Claude started by `claude-here` runs as a Node script's child
and the pane reads `node`. A pane counts as Claude when a foreground process on
its terminal has a session file in `~/.claude/sessions/`.

"done" means finished and not yet seen: the pane-focus-in hook clears it, and a
session that finishes in the tab you are looking at never gets it. A pane that
is no longer running Claude loses its state on the next focus, so a session
that died without `SessionEnd` leaves nothing behind. `M-a` walks the tabs that
need you, waiting first and then done, oldest first; `wt-jump` and the second
status line show the same state.

Claude Code waits on these hooks, so the script only makes tmux calls: no
network, and no output, since Claude Code adds `UserPromptSubmit` and
`SessionStart` output to the conversation. Outside tmux it does only one thing:
while `bin/slack-relay` runs, the prompt-submit, turn-end and waiting hooks
append an event naming the session's transcript (and, for a prompt, its text) to `~/.local/state/slack-relay/events.jsonl`,
which the relay creates and removes only when stopped on purpose, so a crashed
relay picks up where it left off. That is how the relay knows a request
it typed into a tab has been answered, even by a session outside tmux.

## tmux plugins

The plugins are pinned in `tmux/plugins.txt`. `./sync.sh tmux` installs each
into `~/.config/tmux/plugins/<name>` at that exact commit, and `tmux.conf` runs
each plugin's `.tmux` file itself. There is no TPM: it can only follow branches,
so it ran whatever each default branch held on every start. Updating a plugin
means reading what changed and putting the new commit in `plugins.txt`.

## The notes app

`notes/` is a Neovim plugin, the notes app `bin/notes` opens: `lua/notes/` has one module per part (`store` for the files on disk, `render` for drawing a note's Markdown the way macOS Notes shows it, `format` for the Format menu's commands and the typing it does, `table`, `fold`, `links`, `sidebar`, `sync` for notes changed from outside, and `init`, which wires them into the note and sidebar windows). `bin/notes` runs your normal Neovim config and adds the plugin with `-c`, after the config has loaded, because lazy.nvim resets the runtimepath while it starts and would drop anything added with `--cmd`; the plugin is never part of `nvim/`, so plain `nvim` doesn't load it. Notes live in `$NOTES_DIR` or `~/Notes`, never in this repository, which is public. Copilot is not loaded in the notes app at all: `bin/notes` sets `g:notes_app` with `--cmd`, before the config, and `nvim/lua/plugins/copilot.lua` has `cond = not vim.g.notes_app`. As a second layer, a note's buffer is made with `bufadd` and marked `b:copilot_enabled = false` before it is loaded, since Copilot attaches on `FileType`, which fires while the file loads; nvim-cmp is turned off in it, and it keeps no undo file. So a note's text isn't sent anywhere and Tab and Enter are the app's; keep it that way for anything else that would read a buffer, and give anything that attaches on `FileType` a `g:notes_app` condition too. The one exception is the `note-tickets` skill, which you start yourself and which reads only the notes you name; it is `disable-model-invocation`, so Claude never reads your notes on its own. Changes made to a note's file from outside reach the open app through `sync.lua`: each note buffer remembers its file as last read or written, every save first brings in any change since (merged line by line with unsaved typing, both versions kept where the same lines changed), and a watch on the notes directory brings changes in as they happen. So nothing outside the app has to wait for it to close, and nothing in the app may write a note without going through `M.save`. Its tests are in `test/notes.test.js` and run with the relay's under `node --test test/*.test.js`: each runs Lua in a headless `nvim -u NONE` with a temporary `NOTES_DIR` and HOME, so it never reads your config or your notes. The user-facing description and keys are in `bin/README.md`. Only one app runs on a notes directory at a time: `M.start` takes `.notes.lock` there (`store.lock`), and a second one shows a message instead of opening, since two would write over each other; `.notes.json` is written to a temporary file and renamed into place. `M-N` runs `tmux/notes-open.sh`, which finds the notes tab by its `@notes` window option, not its name, and starts notes from `zsh -i` for the PATH the tmux server lacks; there is only ever one, because every note saves itself as you type and two Neovims would write over each other.

## Key bindings and the M-p palette

`M-p` opens `tmux/palette.sh`, an fzf list of the custom bindings that picks
one and presses its key. The list is read from tmux, not kept anywhere: a
binding shows up when `tmux.conf` gives it a description with
`bind -N "<what it does>"`, so every new custom binding needs one. In the
prefix table only keys `tmux.conf` binds with `-N` are listed, since tmux's own
prefix bindings carry descriptions too.

Every format inside a shell command (`run-shell`, `if-shell` without `-F`,
`#(...)`) is written `#{q:...}`, never bare or in quotes. tmux pastes the value
into the command before the shell parses it, so a directory named
`repo$(...)` would run that code, and the pane-focus-in hook would do it
without a keypress. `q:` shell-quotes the value. Values tmux makes itself
(`#{window_id}`, `#{client_name}`) are quoted too, so the rule has no
exceptions to remember. Formats given to tmux options such as `-c` or `-d` are
not shell and are fine as they are.

`display-popup` does not expand formats in its command: `#{pane_id}` reaches
the shell as written, and the shell reads the `#` as the start of a comment, so
the script gets no argument at all. Its `-d` start directory is expanded, so a
popup that needs the pane's path takes it from `-d '#{pane_current_path}'` and
the script defaults to `$PWD`, as `M-m` does with `pr-ready.sh`.

## Skills and the scripts they call

Skills in `claude/skills/` may depend on a script in `bin/`. `review-loop` calls `codex-review`, so a change to the JSON the script prints or the flags it accepts has to be mirrored in the skill, and vice versa. `review-loop` is kept here but not installed: `sync.sh` skips the skills listed in `unlinked_skills`, because the repos that use it define their own and a personal copy shows up beside theirs as a second `/review-loop`. `wt` replaces its own tmux pane with `zsh -i -c 'wt <ID>'`, so it relies on `~/.zshrc` defining the `wt` function from `worktree-from-ticket init zsh`. It also clears the tab's `@tab_name` (the "Shaping: ..." name `bin/shape` sets, or one set with `M-n`), and the `wt` function renames the tabs once it has moved into the worktree, so the tab takes the ticket's name from `tmux/tab-label.sh` straight away rather than on the next focus. `bin/shape` only starts Claude with `/shape`; the shaping instructions live in that skill. `queue-and-clean` hands a PR that can't merge to `ci-loop` by reading `~/.claude/skills/ci-loop/SKILL.md` (both are `disable-model-invocation`, so it can't invoke the skill), and `ci-loop` has a section for that case, so a change to how either one fixes or hands back has to reach the other. `bin/slack-relay` reads the `@agent_state` and `@agent_since` pane options that `tmux/agent-state.sh` keeps, to tell the user which tabs need them, so a change to those names or states has to reach it. `slack-relay` is a Slack app talking to its owner in the app's DM, over Socket Mode and the Web API, with its tokens in the Keychain and its owner's member ID in `~/.config/slack-relay/config.json`. Two rules in `lib/slack-relay/slack.js` keep it from being anyone else's remote control, and every new Slack call must go through them: an incoming message is acted on only if `fromOwner` passes (the owner, in that DM, in that workspace, not a bot) and `typedByYou` does (Slack's `client_msg_id` and no `app_id`, since other apps can post as the owner), a button press only if `pressFrom` passes (the owner, on a message in that DM, or on the Home tab or a tab's screen, which take only their own buttons), a form sent from one of its screens (Rename, Message, Skill, New tab) only if `submissionFrom` does, and nothing else Slack sends, reactions included, controls anything, and `slack.api` refuses any call that names a conversation other than the DM. The owner never comes from a message. Its code is in `lib/slack-relay/`, one module per part, and `bin/slack-relay` only picks the command and exports every part for the tests; a module that needs another's name requires it directly, and none may require one that leads back to it, since a cycle hands it an empty module. Its tests, `node --test test/*.test.js`, run against a throwaway tmux server, a temporary HOME and Slack stand-ins; a test must never reach your real tmux server or Slack, so keep any new one inside that setup. A test that reads a tab's skills opens the tab in the tests' temporary directory: one opened in the repository would walk up to your real `~/.claude`, since the temporary HOME isn't above it. Document each script in `bin/README.md`.

`M-o` is the other half of `M-j`: `bin/wt-revive`, run through the
`tmux/window-revive.sh` wrapper, lists the worktrees no tab has open and
reopens one with `claude-here`, the same handoff `wtr` makes, so a change to
how `claude-here` resumes a directory reaches both. It finds a worktree's last
session from the `cwd` in Claude Code's transcripts, and keeps what each
transcript says in `~/.cache/wt-revive/index.json` against its size and
modified time, so a press reads only the transcripts that changed. Reading the
end of every transcript on every press, one pipeline each, started about a
thousand processes and took three seconds.

The tmux config depends on `bin/` too: the `M-j` binding runs
`tmux/window-jump.sh`, which runs `~/.local/bin/wt-jump`, so that binding needs
both `./sync.sh tmux` and `./sync.sh wt-jump`, as `M-o` needs
`./sync.sh wt-revive`. The dependency runs the other
way as well: `wt-jump` builds its picker rows from `tmux/tab-status.sh`, so a
change to what the second status line prints shows up in the picker, and the
line has to stay fast enough to run for every window at once.

Anything in `bin/` called from a tmux binding needs a wrapper like that one. The
tmux server keeps the environment it was started with, and nvm is set up in
`~/.zshrc`, which only interactive shells read — so a node script run straight
from a binding dies on `env: node: No such file or directory`, and with
`display-popup -E` it closes so fast it reads as a flicker rather than an error.
Scripts that parse `tmux -F` output want `LC_ALL` set to a UTF-8 locale too:
without one, tmux rewrites control characters in its output, tab delimiters
included.
