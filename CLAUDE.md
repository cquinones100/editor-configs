# Switchboard

Switchboard, called editor-configs until October 2026, is a terminal workspace for working with coding agents, shipped as an opinionated distribution: the dotfiles for the tools listed by directory, and the scripts that tie them together. Everything runs from `~/switchboard`. A clone set up under the old name keeps working: `setup.sh`'s `renamed` links `~/switchboard` to a clone at `~/editor-configs` and moves `~/.config/editor-configs` and `~/.local/state/editor-configs` to their new names, and `repo-update.sh` and `settings.sh` fall back to `~/editor-configs` until it has. Keep that until no clone needs it.

The dotfiles are for the tools listed by directory. `setup.sh` is the one script that puts them in place, and running it again changes only what isn't in place yet: `./setup.sh <part>` (`tmux`, `bin`, `claude`, `git`, …, or one script in `bin/` by name) does just those parts without questions, and `./setup.sh` alone runs the guided setup below. Every link goes through its `put_link`, which leaves a link already pointing at the right file alone and moves a real file or directory in the way to `<name>.bak.<time>` rather than overwriting or deleting it; every other step checks first in the same way, and each part says what it changed or that it was up to date. `--check` with either says what would change and changes nothing. A new step must be just as safe to run twice (`test/setup.test.js` runs the parts twice). `sync.sh`, which it replaced, only runs it, for clones and habits from before. In a clone where `setup.sh git` has set `core.hooksPath`, `.githooks/post-merge` (and `post-rewrite`, after `git pull --rebase`) runs the parts that ask nothing after every pull, `tmux`, `bin` and `git`, and `claude` where all of `claude/` is linked, then prints the guided setup's "Left to do" list from `--check`, and nothing when all is in place. The guided setup ends with that list too, every ✗ again, so none has to be found among the ticks. `tmux` links every `.sh`, `.zsh` and `.js` in `tmux/` into `~/.config/tmux`, so a new script there needs no line of its own.

The guided setup sets up the tmux workspace on someone else's Mac (see `bin/README.md`): it checks what the workspace needs, installs what is missing with Homebrew after asking, links tmux, Neovim, lazygit and `bin/` (asking the first time, since it moves their configs aside), adds the worktree shell functions (`wt`, `wtpr`, `wtr`, `wtb`) to `~/.zshrc` from each script's `init zsh`, and reports the optional parts. A new tool the tmux scripts or the configs call belongs in its `PACKAGES` (with `command_of` when its command isn't its name), and anything only one feature needs in its optional checks, named for what it unlocks, so a fresh install never finds out by something breaking. Downloads it makes are pinned and checked, as the font is (`FONT_COMMIT`, `font_sha256`) and nvm (`NVM_VERSION`). The Claude Code and git setup are optional and asked for: by default it adds only the hooks that run `agent-state.sh` to the person's own `~/.claude/settings.json`, since the rest of `claude/` holds this machine's own settings, and links all of `claude/` (`setup.sh claude`) or sets this clone's git hooks (`setup.sh git`) only when they say yes. Once they have, later runs bring in what was added to those parts without asking.

`README.md` at the root is the front page for someone new: what the workspace is, the requirements, the two commands that set it up, the first keys and where things are, pointing to `bin/README.md` for the full detail. Keep its keys, requirements and setup steps in step with `setup.sh` and `tmux.conf`.

The global `~/.gitconfig` isn't kept here: it holds a machine's git identity and paths, which don't belong in a public repo. `./setup.sh git` only sets this clone's `core.hooksPath`.

Nothing here runs code that another repository supplies unless you have trusted that repository. Trusted directories are listed in `~/.config/switchboard/trusted-dirs`, one absolute or `~/` path per line (blank lines and lines starting with `#` ignored), which is yours, never committed, and never written for you; a missing file trusts nothing. A directory counts only when its real path equals a listed one's exactly, so trusting `~/code` doesn't trust what is under it. Nothing needs it today, since the workspace layout that ran a directory's own `worktree` script is gone. Any new script that would execute something from a repository checks this file the same way, inline.

## Pushing

Always ask before pushing this repo, every time, whatever the branch and
whatever an earlier push was allowed. The repo is public, so before asking,
check the unpushed commits for anything that identifies the user or their
employer: organization or company names, ticket IDs, PR numbers, internal
hosts, usernames, personal paths, tokens.

## Claude Code settings

- `claude/settings.json` is symlinked to `~/.claude/settings.json`, so anything Claude Code persists to user settings shows up as a tracked change here.
- Claude Code reads only four settings files: `~/.claude/settings.json`, the project's `.claude/settings.json` and `.claude/settings.local.json`, and managed settings. There is no user-level `settings.local.json`.
- Anything that describes a specific organization's environment must not live in the tracked file. The auto mode environment profile (the `autoMode` key) belongs in that project's `.claude/settings.local.json`, which is gitignored there. If Claude Code writes `autoMode` back into `claude/settings.json`, move it again before committing. `.githooks/pre-commit` refuses a commit that stages `autoMode` in that file, or any change to its `model`, which Claude Code rewrites whenever `/model` is used; commit the rest of the file with `git add -p`. The hook only runs where `./setup.sh git` has pointed this clone's `core.hooksPath` at `.githooks`, so run that on every new machine. Claude itself can't get around it: `claude/hooks/enforce-git-hooks-run.sh` blocks `git commit --no-verify` (and `-n`) and any change to `core.hooksPath`. The worktree scripts in `bin/` symlink the project-local file into each worktree so it applies there too.

## Neovim plugins

`nvim/lazy-lock.json` is committed, so a new machine gets the same plugin commits (`:Lazy restore`), and `nvim/init.lua` clones lazy.nvim itself at the commit the lockfile records, not its `stable` branch; when lazy.nvim updates itself, bump that commit with the lockfile. The language servers Mason installs (`nvim/lua/plugins/lsp.lua`) are left unpinned, at whatever npm and PyPI hold: pinning them would mean chasing every release for little gain.

`M-d` runs diffview in a Neovim of its own, `nvim -u ~/.config/nvim/diff.lua --noplugin`: only diffview, tokyonight and the icons, taken from lazy.nvim's directory and set up by calling their specs' `config` in `lua/plugins/`, so it starts in about a second with no language servers, Copilot or gitsigns. lazy.nvim must have installed them first, from a normal `nvim`. A plugin diffview comes to depend on goes in `diff.lua`'s list.

diffview opens on the first file that isn't generated (`generated()` in `nvim/lua/plugins/diffview.lua`: lockfiles, migration snapshots, minified and built output), and shows an added file, or a deleted one as it was, alone in a single pane rather than beside an empty half. A new kind of generated file goes in that list. Its files are a flat list in reading order (`reading_order`), every list diffview is given sorted first so its updates find nothing moved: documentation (`DOCS`), then the implementation, then tests (`TESTS`), then generated files, Haiku ordering the implementation from most abstract to most concrete in the background (`ask_order`, `claude -p` with no tools), its answer cached in Neovim's cache under `diff-order/`. The `diff_order` setting turns it off, back to the folder tree. Since the list has no folders, each side of the diff carries the file's path from the repository root in its winbar. In the file tree or history, `J` and `K` scroll the diff beside it without leaving the tree. In it, `yp` copies the cursor's `path:line` and `yl` a GitHub link to that line at the side's commit (a range in visual mode), taken from diffview's own file and rev, since its buffers are named `diffview:///…`.

## Window names and accent colors

`tmux/accent-color.sh` produces two different strings from the same directory.
The color key is hashed into the accent color, and `claude/statusline-command.sh`
builds the same key independently, so changing its shape in one place silently
gives tmux and the Claude statusline two different colors for one project. The window name is
only ever read, so it is free to change.

`tmux/window-names.sh` owns the tab: the label from `tmux/tab-label.sh`, cut to
30 characters, prefixed with `#<number>` when the branch has a pull request.
`wt-jump` reads that prefix back to find PRs, so it stays at the front. `rename-window` expands formats in the name it is given, so `window-names.sh` doubles every `#` in the name it sets (`##12` for the PR prefix, which tmux stores as `#12`); anything else that renames a window from a title, branch or directory must do the same. `@tab_label`, set with `setw`, is stored as given. The
label is the name set with "Rename the tab" in `M-p` (the window's `@tab_name`), else the Linear
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
the `@agent_marker` format in `tmux.conf` shows in the tab. From the same hooks' JSON
the pane also carries `@agent_activity`, the tool call in a few words, set by
a `PreToolUse` hook as each tool starts, and `@agent_wait`, what a permission
request or an `AskUserQuestion` waits on (a question is a wait from the moment
it is asked); and `@agent_loop`, the loop the session runs (review, ci, queue or deploy) from the
moment `/review-loop`, `/ci-loop`, `/queue-and-clean` or `/deploy-test` is asked for, typed
or through the Skill tool, until a new prompt or session. The sidebar shows
all three. One `jq` reads them, as the relay's event already does. No hook
fires when a background task ends, so the sidebar still counts running tasks
from the transcript. Every
window-status format in `tmux.conf`, `theme.sh`, `update-colors.sh`, and
`window-names.sh` expands that marker, so a new one has to as well.

A conversation moved into the background keeps running in a job with no tmux
of its own, so its hooks have no `TMUX_PANE`. The tab it came from holds a
parked Claude whose session file names the job (`parkedJobId`, matching the
job's `jobId` in `~/.claude/sessions/`), and `agent-state.sh` follows that
link to mark the tab, so a backgrounded conversation still shows as working,
waiting or done there rather than idle.

A headless Claude (`entrypoint` `sdk-cli` in its session file), such as one a
review loop's script starts, inherits the tab's `TMUX_PANE` and names its pane
in its session file too. `agent-state.sh` ignores its hooks, and the sidebar
reads the tab's own interactive session for the pane, so a tab running a loop
shows the loop's background work rather than the helper's turns.

Whether a pane runs Claude is decided in `tmux/claude-pane.sh`, which
`agent-state.sh` and `tab-status.sh` source, and again in
`lib/slack-relay/tabs.js`, so a change to one belongs in the other. tmux names
a pane after its foreground program: Claude Code's executable is named after
its version, but Claude started by `claude-here` runs as a Node script's child
and the pane reads `node`. A pane counts as Claude when a foreground process on
its terminal has a session file in `~/.claude/sessions/`.

"done" means finished and not yet seen: the pane-focus-in hook clears it once
the tab is still in front a second later, so passing over a tab, as moving the
sidebar's cursor does, leaves it, and a session that finishes in the tab you
are looking at never gets it. A pane that
is no longer running Claude loses its state on the next focus, so a session
that died without `SessionEnd` leaves nothing behind. `M-a` walks the sidebar's
Needs you in its order (pinned, then waiting, then done), from the list the
sidebar daemon writes to `~/.local/state/tmux-sidebar/needs` whenever it
changes, since only the daemon knows a tab that looks done is still looping
or working in the background; without the daemon it falls back to the panes'
own states. `agent-state.sh` runs before every tool call of every Claude
session, so a syntax error in it blocks them all, the fix included: check a
change with `bash -n` on a copy before it replaces the file. `wt-jump` and the
second status line show the same state.

Claude Code waits on these hooks, so the script only makes tmux calls: no
network, and no output, since Claude Code adds `UserPromptSubmit` and
`SessionStart` output to the conversation. Outside tmux it does only one thing:
while `bin/slack-relay` runs, the prompt-submit, turn-end and waiting hooks
append an event naming the session's transcript (and, for a prompt, its text) to `~/.local/state/slack-relay/events.jsonl`,
which the relay creates and removes only when stopped on purpose, so a crashed
relay picks up where it left off. That is how the relay knows a request
it typed into a tab has been answered, even by a session outside tmux.

## The sidebar and mission control

`bin/tmux-sidebar` (code in `lib/sidebar/`) is one daemon that draws a sidebar
pane on the left of every window, reached with `M-s` from any pane or `C-w h`
from the one beside it, and the mission control popup (`M-Space`). Every sidebar pane and the popup run `tmux/sidebar-pane.zsh`, which
uses only zsh builtins so a sidebar starts no processes however long it runs;
keep it that way. The daemon reads tmux in one `list-panes` per refresh and
`~/.claude` as files, so its drawing path starts no process and never waits on
the network either; only plugins (`lib/sidebar/plugins.js`) may, and they run
off it. It refreshes when something appends to
`~/.local/state/tmux-sidebar/nudge`: `agent-state.sh` and `window-names.sh` do
with a shell builtin, and anything else that changes what a tab shows should
too.

It shows what the tab bar shows, from the same places: the label from
`@tab_label` (PR prefix included) and the accent color parsed out of the
`window-status-format` `window-names.sh` sets, so a change to either shape
belongs in `lib/sidebar/model.js` too. States are `@agent`, `@agent_state`
and `@agent_since` from `agent-state.sh`. It finds a pane's Claude session from
the `tmux` field (`main:@27.%28`) in `~/.claude/sessions/<pid>.json`, not from
`claude-pane.sh`.

Sidebar panes carry the `@sidebar` pane option. Anything that walks every pane
to find a worktree, a Claude session or a pane to type into skips them, as
`wt-jump` does. A binding that acts on the current pane starts with
`leave-sidebar` (a command alias in `tmux.conf`), so it acts on your pane
rather than the sidebar when the sidebar has focus. tmux-resurrect restores
sidebars as shells titled `tmux-sidebar`, and the daemon gives them their
client back; its restore hooks set `@sidebar_hold` so nothing is added while
it lays windows out.

Plugins load only when named in `~/.config/tmux-sidebar/config.json`, from
`~/.config/tmux-sidebar/plugins/` (yours) or `lib/sidebar/plugins/`. Its tests,
`test/tmux-sidebar.test.js`, run against a throwaway tmux server and a
temporary HOME under `/tmp`, since a Unix socket's path can't be over 104 bytes
on macOS. Document it in `bin/README.md`.
`lib/sidebar/text.js`'s `width` must count what a terminal draws as two columns as two (wide characters, emoji-presentation symbols, a symbol followed by U+FE0F); one counted short shifts every border after it on a mission control line.

## tmux plugins

The plugins are pinned in `tmux/plugins.txt`. `./setup.sh tmux` installs each
into `~/.config/tmux/plugins/<name>` at that exact commit, and `tmux.conf` runs
each plugin's `.tmux` file itself. There is no TPM: it can only follow branches,
so it ran whatever each default branch held on every start. Updating a plugin
means reading what changed and putting the new commit in `plugins.txt`.

`M-v` (`tmux/pr-view.sh`) shows the branch's PR description in a pane to the
right: `glow` draws the Markdown and `mermaid-ascii` each Mermaid diagram as
text, a diagram it can't draw (only flowcharts and sequence diagrams) kept as
its source. `M-i` (`tmux/ticket-view.sh`) does the same for the Linear ticket the
branch or tab name gives, read from Linear's API with worktree-from-ticket's
key and laid out by `pr-view.js ticket`: the facts from its side panel, the
description, sub-issues, related tickets, links, and the comments with their
replies. Both draw with `tmux/glow-style.json`, glow's dark style without the #s before headings, and show a link as its text alone: `pr-view.js` hands glow the text between Private Use markers and splice makes it an OSC 8 link again, since glow prints a link's URL after its text. `pr-view.sh page` runs less in the background under a WINCH trap, so a resize lays the description out again at the new width and reopens it at the line that was on top; the image view (`pr-image.js`) keeps its headless Chrome open to do the same with its pages. `mermaid-ascii` is pinned the same way, by version and checksum in
`setup.sh` (`mermaid_ascii`), which `./setup.sh tmux` installs. A trial beside it, `M-p`'s "View the branch's PR
description as an image" (`tmux/pr-image.js`), draws the
description as GitHub does (its `body_html`, read with a GET, GitHub's
stylesheet, Mermaid in mermaid-cli's headless Chrome) and shows it a page at a
time as images, through tmux's passthrough for that pane alone. It opens in
place of the pane, as `M-d`'s diff does (`pane-in-place.sh`'s `pr-image`), and
`q` or asking for it again puts the pane back. M-p's "View the branch's Linear ticket as an image" is the same script with `--ticket <ID>` (`pane-in-place.sh`'s `ticket-image`, the ID from the branch or the tab's name as `M-i` finds it): the ticket from Linear's API, its facts, description, sub-issues and comments, the Markdown drawn in the page by marked and cleaned by DOMPurify, both pinned by version, since nothing has made Linear's Markdown safe the way GitHub's `body_html` is.

`M-r` and `M-p`'s "Open the repository in the browser" go through `tmux/gh-open.sh`, which opens GitHub's page for the branch's PR or the repository, or else says in a box which any key closes why it can't: not a git repository, no remote on GitHub, `gh` missing or signed out, a repository GitHub doesn't have or won't show you, or a branch with no PR yet. tmux's own message for a failed `run-shell` says only that it returned 1, so anything else that opens a page from a binding should say why it can't the same way.

## The notes app

`notes/` is a Neovim plugin, the notes app `bin/notes` opens: `lua/notes/` has one module per part (`store` for the files on disk, `render` for drawing a note's Markdown the way macOS Notes shows it, `format` for the Format menu's commands and the typing it does, `table`, `fold`, `links`, `sidebar`, `sync` for notes changed from outside, and `init`, which wires them into the note and sidebar windows). `bin/notes` runs your normal Neovim config and adds the plugin with `-c`, after the config has loaded, because lazy.nvim resets the runtimepath while it starts and would drop anything added with `--cmd`; the plugin is never part of `nvim/`, so plain `nvim` doesn't load it. Notes live in `$NOTES_DIR` or `~/Notes`, never in this repository, which is public. Copilot is not loaded in the notes app at all: `bin/notes` sets `g:notes_app` with `--cmd`, before the config, and `nvim/lua/plugins/copilot.lua` has `cond = not vim.g.notes_app`. As a second layer, a note's buffer is made with `bufadd` and marked `b:copilot_enabled = false` before it is loaded, since Copilot attaches on `FileType`, which fires while the file loads; nvim-cmp is turned off in it, and it keeps no undo file. So a note's text isn't sent anywhere and Tab and Enter are the app's; keep it that way for anything else that would read a buffer, and give anything that attaches on `FileType` a `g:notes_app` condition too. The exceptions are the `note-tickets` and `note-watch` skills, which you start yourself and which read only the notes you name or confirm; both are `disable-model-invocation`, so Claude never reads your notes on its own. `note-watch` keeps a Monitor on one note (`claude/skills/note-watch/scripts/watch-note.js`, plain Node with no packages) and works each item added to it. Changes made to a note's file from outside reach the open app through `sync.lua`: each note buffer remembers its file as last read or written, every save first brings in any change since (merged line by line with unsaved typing, both versions kept where the same lines changed), and a watch on the notes directory brings changes in as they happen. So nothing outside the app has to wait for it to close, and nothing in the app may write a note without going through `M.save`. Its tests are in `test/notes.test.js` and run with the relay's under `node --test test/*.test.js`: each runs Lua in a headless `nvim -u NONE` with a temporary `NOTES_DIR` and HOME, so it never reads your config or your notes. The user-facing description and keys are in `bin/README.md`. Only one app runs on a notes directory at a time: `M.start` takes `.notes.lock` there (`store.lock`), and a second one shows a message instead of opening, since two would write over each other; `.notes.json` is written to a temporary file and renamed into place. `M-N` runs `tmux/notes-open.sh`, which finds the notes pane by its `@notes_pane` option (a tab of its own also carries `@notes`), not its name, and `M-e` runs it to move that same pane beside the one you are in (`join-pane`), or back to a tab of its own (`break-pane`), or to start it there; moved out of its own tab, it leaves `tmux/notes-away.sh` in its place (a pane marked `@notes_placeholder`) saying which tab has it, and goes back into that tab when put away; and starts notes from `zsh -i` for the PATH the tmux server lacks; there is only ever one, because every note saves itself as you type and two Neovims would write over each other.

## Checking tmux.conf

`test/tmux-conf.test.js` loads `tmux.conf` into a throwaway server and checks it loads without an error and that every `bind` runs as many commands as the file gives it, which a `\;` that lost its backslash breaks silently. The file skips what reaches beyond that server (starting the sidebar daemon, the plugins, the theme) while `@conf_check` is set, inside `%if`; anything new it runs at load belongs inside one too.

## Context use, for the sidebar

`claude/statusline-command.sh` writes each session's context use and model, which Claude Code gives only to the statusline, to `~/.local/state/tmux-sidebar/context/<session id>` (`<percent>\t<model>`), when they change, for mission control's Sessions view (`lib/sidebar/sessions.js`) and the Slack relay (`contextOf` in `lib/slack-relay/tabs.js`), which shows it on each turn, the Home tab and a tab's screen, and warns a thread once a session passes 90%. A change to that line's shape belongs in all three.

## Settings

The workspace's options, the ones a person might want off (banners, the sidebar, lookups, the theme, saving pane contents, the update check and the rest), are listed in `tmux/settings.json`, each with its key, category, label, description and default: on/off, or one of its `choices`. What someone changes is kept in `~/.config/switchboard/settings.json`, only the keys that differ from their defaults, which they may also edit by hand; it is never in this repository. `lib/settings.js` reads and writes it for Node (the sidebar daemon, the Slack relay), and `tmux/settings.sh apply` sets each value as a global tmux option, `@setting_<key>` (on/off or the choice), plus the few that are tmux's own (`status`, resurrect's and continuum's). tmux.conf runs it with `--load` before the plugins, since continuum reads its restore setting as it loads, and `settings.sh theme` where theme.sh ran before; the sidebar daemon watches the file and runs `apply` whenever it changes, so a change takes effect at once. The scripts and hooks read the tmux option, in a format or in a tmux call they already make, never by starting a process of their own on a hot path. Mission control's Settings view (`M-p`, "Settings") lists them under their categories; Enter or Space changes one, and `/` filters by name, description, category or value. A new option is one entry in `tmux/settings.json` and the code that reads it. The `github` and `linear` options turn each service off as a whole: `settings.sh` binds every key whose description carries `#github` or `#linear` (root, prefix and palette tables) to do nothing, which also drops it from `M-p`, and reloads tmux.conf to give the keys back when the service is turned on again, so a new binding that uses either service must carry its tag; `palette.sh` leaves out the tagged ones as well; mission control drops the PRs view (github) and the Tickets view (linear, `lib/sidebar/ticketboard.js`), `prs.js` stops asking about merge states, the Work map shows no PR or ticket, and `path-facts.sh` asks neither for the tab's name. Anything new that reaches GitHub or Linear from tmux checks its setting the same way.

## Tips

`tmux/tip.sh` shows a tip in a small box in the top-right corner, once each, at the moment its key would help. From `agent-state.sh`: `waiting` and `done` when a tab first waits on you or finishes while you look elsewhere (`set_state`), `worktree` when Claude first starts in a worktree (its PR keys, with GitHub on). From tmux.conf: `jump` on a tab switch with five tabs or more (the `session-window-changed` hook), `pinned` on the first `M-f`. From the sidebar daemon (`tipsFor`), which alone can tell: `merged`, `loop` (a tab looping in the background) and `sidebar` (first focused). `in-place` when a tool first takes a pane's place (`pane-in-place.sh`), `updates` after the first update popup (`repo-update.sh`), `github_off` and `linear_off` when a key of a service turned off in Settings is pressed (the binding `settings.sh` gives it), and `key-<keys>` after a palette pick that has a hotkey of its own (`palette.sh`, `tip.sh key`), once for each key. A client shows one popup at a time, so a tip that can't open behind another popup is left unshown for next time; mission control, a popup itself, says its tip in its own footer on its first opening instead. Any key closes the box and goes on to tmux as if the box hadn't been there (`send-keys -K`, a moment after it closes), so nothing typed is lost, and it closes itself after eight seconds. Never put a tip in the status line: one that goes on the next key press is missed. What was shown is kept in `~/.local/state/switchboard/tips` and as `@tip_seen_<tip>` options, which `tip.sh load` sets when tmux starts; a trigger checks that option in a format, so it starts nothing once the tip has been shown, and doing what a tip teaches (`M-a`, `M-j`) marks it shown. The `tips` setting turns them off, and "Show the tips again" in `M-p` resets them. A new tip is its text in `text_of` and a trigger gated the same way.

## The health light

`tmux/health.sh` runs from `#()` in `status-left` (set in both `tmux.conf` and `update-colors.sh`, which rewrites it) and prints nothing while all is well, or a red mark naming what quietly stopped: tmux-continuum's saves older than five minutes, the sidebar daemon gone while the sidebar is on, or the relay crashed (its events file left with no process). It runs every `status-interval`, so it is one tmux call and file checks. Anything else that can stop without a word belongs in it.

It is also the one thing tmux runs on a timer, so once an hour (checked with builtins against `~/.local/state/switchboard/update-checked`) it starts `tmux/repo-update.sh periodic` in the background, which fetches this repo's origin and, when `main` is behind, offers the new commits in a popup on the client used last, once per new tip. The `client-attached` and `session-created` hooks run `repo-update.sh check`, which asks every time tmux opens while there is something new. Yes fast-forwards `main` only (never with commits of its own or another branch checked out), runs the guided `./setup.sh` in the popup, which links whatever is new and asks about anything else the update needs, restarts the sidebar daemon when its code changed, and reloads tmux.conf.

## Key bindings and the M-p palette

Lazygit (in `M-p`, with no hotkey) and `M-d` (diffview.nvim, `nvim/lua/plugins/diffview.lua`, showing the branch's committed changes against its PR's base, fetched first, as GitHub's "Files changed" does) put a tool in the pane's place without touching the rest of the window (`tmux/pane-in-place.sh`): the tool starts in a window of its own and `swap-pane` trades places, the pane waiting in that window, marked `@pane_parked` so the sidebar gives it no sidebar and lists it as no tab, and the tool's pane naming it in `@parked_pane` and itself in `@in_place`, which the key uses to quit its own tool, since the tool's pane reads as the shell that runs it. The shell swaps the pane back when the tool exits, and `confirm.sh` swaps back any `@parked_pane` before it kills a pane, so closing the tool's pane with `M-w` never strands it. Another tool in place goes in `pane-in-place.sh`'s list.

`M-p` opens `tmux/palette.sh`, an fzf list of the custom bindings that picks
one and presses its key. The list is read from tmux, not kept anywhere: a
binding shows up when `tmux.conf` gives it a description with
`bind -N "<what it does> #tag #tag"`, so every new custom binding needs one,
ending in tags: a few `#words` for what it is about (`#git`, `#pr`, `#tabs`),
which the palette shows dimmed and matches and ranks as any other word. In the
prefix table only keys `tmux.conf` binds with `-N` are listed, since tmux's own
prefix bindings carry descriptions too. A command that belongs in the palette
but has no hotkey is bound with `-N` in the `palette` key table, which no key
leads to, as the branch-copy commands (`tmux/branch-copy.sh`) are: the palette
lists that table with no key shown, and the `M-p` binding switches the client
to it before pressing the key.

The palette lists the commands picked last first, newest first, from
`~/.local/state/tmux-palette/recent` (the last six keys, written by
`palette.sh` after each pick), then the rest by description. Its columns are
fitted to the popup, 60% of the screen, so a description or tag list too long
for its column is cut with an ellipsis. `tmux.conf` empties the `palette`
table before binding it (`unbind -aq -T palette`), so a command taken out of
the file leaves the palette on the next reload; a binding removed from the
root or prefix table still needs `tmux unbind` by hand.

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

A skill whose scripts need npm packages keeps them in its own `scripts/package.json`, pinned to exact versions with the lockfile beside it, and its `node_modules` is gitignored: the skill itself says to run `npm ci` there when it is missing, as `diff-screenshots` does. Skills in `claude/skills/` may depend on a script in `bin/`. `review-loop` calls `codex-review`, so a change to the JSON the script prints or the flags it accepts has to be mirrored in the skill, and vice versa. `review-loop` and `ci-loop` are kept here but not installed: `setup.sh` skips the skills listed in `unlinked_skills`, because the repos that use them define their own, and a personal skill wins over a project skill of the same name, so an installed copy would hide the repo's. `wt` replaces its own tmux pane with `zsh -i -c 'wt <ID>'`, so it relies on `~/.zshrc` defining the `wt` function from `worktree-from-ticket init zsh`. It also clears the tab's `@tab_name` (the "Shaping: ..." name `bin/shape` sets, or one set with "Rename the tab" in `M-p`), and the `wt` function renames the tabs once it has moved into the worktree, so the tab takes the ticket's name from `tmux/tab-label.sh` straight away rather than on the next focus. `bin/shape` only starts Claude with `/shape`; the shaping instructions live in that skill. `tmux/note-shape.sh` (an M-p action) hands `/shape` a note's checklist items through `shape-batch`, each on one line with its details and numbered sub-items labelled, and the skill's "A checklist item from a note" section reads that line, so a change to the format belongs in both. The skill names the tab too ("Shaping: …" from its arguments, then "Shaping <ID>: <title>" once there is a ticket), through the same `@tab_name` and `tmux/window-names.sh`, so `/shape` in a session already running gets a name as `bin/shape` gives one, and `/wt` clearing `@tab_name` hands the tab its ticket name either way. `note-watch` and `queue-and-clean` find the note a piece of work belongs to the same way, from `claude/skills/note-watch/pick-note.md`, which both read, so a change to how belongs there; `queue-and-clean` reads only the note settled before it watches, to tick the PR's item once it merges. `queue-and-clean` hands a PR that can't merge to `ci-loop` by reading the repository's own `.claude/skills/ci-loop/SKILL.md`, or this repo's `claude/skills/ci-loop/SKILL.md` where there is none (both are `disable-model-invocation`, so it can't invoke the skill), and this repo's copy has a section for that case, which a repository's copy leaves out, so a change to how either one fixes or hands back has to reach the other. Once the PR merges, `queue-and-clean` follows `deploy-test` the same way, by reading its `SKILL.md`, and removes the worktree only once you approve its video, then restarts the pane in the main clone with `tmux respawn-pane` and `claude --resume <its session ID>`, so the same conversation carries on there, since a session left in a deleted directory can't `cd` the pane out of it; `deploy-test` also runs on its own, on any merged PR. Its cleanup is `clean-worktree`'s, read the same way, which also runs on its own on any worktree whose commits are all on GitHub. It waits for the deploy (`scripts/wait-deploy.js`, GitHub deployments or a deploy workflow, plain Node) and records a browser test of the feature on the deployed site (`scripts/record.js`, Playwright in the system Chrome, a captioned video converted to mp4 with ffmpeg). Each site it tests keeps a Chrome profile in `~/.cache/deploy-test/profiles/<host>`, signed into by hand with `record.js --login`, so no session ever lives in a repository; a test there must change nothing real unless the environment is a test one or you say so. `oncall` watches a team's Slack alert channels while you're on call, as `/loop /oncall`, and reaches you only through `slack-relay notify`, so its notices come from the relay's bot and Slack notifies you of them; the channels and the team's own rules are in `~/.config/oncall/config.json` and the rules file it names, never in this repository, which keeps only the general rules and `config.example.json` with made-up IDs. `bin/slack-relay` reads the `@agent_state` and `@agent_since` pane options that `tmux/agent-state.sh` keeps, to tell the user which tabs need them, so a change to those names or states has to reach it. `slack-relay` is a Slack app talking to its owner in the app's DM, over Socket Mode and the Web API, with its tokens in the Keychain and its owner's member ID in `~/.config/slack-relay/config.json`. Two rules in `lib/slack-relay/slack.js` keep it from being anyone else's remote control, and every new Slack call must go through them: an incoming message is acted on only if `fromOwner` passes (the owner, in that DM, in that workspace, not a bot) and `typedByYou` does (Slack's `client_msg_id` and no `app_id`, since other apps can post as the owner), a button press only if `pressFrom` passes (the owner, on a message in that DM, or on the Home tab or a tab's screen, which take only their own buttons), a form sent from one of its screens (Rename, Message, Skill, New tab) only if `submissionFrom` does, and nothing else Slack sends, reactions included, controls anything, and `slack.api` refuses any call that names a conversation other than the DM. The owner never comes from a message. Its code is in `lib/slack-relay/`, one module per part, and `bin/slack-relay` only picks the command and exports every part for the tests; a module that needs another's name requires it directly, and none may require one that leads back to it, since a cycle hands it an empty module. Its tests, `node --test test/*.test.js`, run against a throwaway tmux server, a temporary HOME and Slack stand-ins; a test must never reach your real tmux server or Slack, so keep any new one inside that setup. A test that reads a tab's skills opens the tab in the tests' temporary directory: one opened in the repository would walk up to your real `~/.claude`, since the temporary HOME isn't above it. Document each script in `bin/README.md`.

`M-j` and `M-o` open mission control's Work map as a picker, a filter
typing, scoped to open tabs or to the worktrees no tab has open. The second
comes from `bin/wt-revive --json`, which the sidebar daemon runs in the
background (`refreshRevived` in `lib/sidebar/views.js`), so a change to the
rows it prints belongs there too. Enter on one reopens it with `claude-here`,
the same handoff `wtr` makes, so a change to how `claude-here` resumes a
directory reaches both. Neither `wt-revive` nor `wt-jump` has a picker of its
own any more: `wt-revive` prints the rows, and `wt-jump` takes a ticket, PR or
branch to jump to. It finds a worktree's last
session from the `cwd` in Claude Code's transcripts, and keeps what each
transcript says in `~/.cache/wt-revive/index.json` against its size and
modified time, so a press reads only the transcripts that changed. Reading the
end of every transcript on every press, one pipeline each, started about a
thousand processes and took three seconds.

`wt-jump` builds its picker rows from `tmux/tab-status.sh`, so a
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
