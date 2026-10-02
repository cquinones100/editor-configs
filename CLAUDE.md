# editor-configs

Dotfiles for the tools listed by directory. `sync.sh` symlinks them into place.

## Claude Code settings

- `claude/settings.json` is symlinked to `~/.claude/settings.json`, so anything Claude Code persists to user settings shows up as a tracked change here.
- Claude Code reads only four settings files: `~/.claude/settings.json`, the project's `.claude/settings.json` and `.claude/settings.local.json`, and managed settings. There is no user-level `settings.local.json`.
- Anything that describes a specific organization's environment must not live in the tracked file. The auto mode environment profile (the `autoMode` key) belongs in that project's `.claude/settings.local.json`, which is gitignored there. If Claude Code writes `autoMode` back into `claude/settings.json`, move it again before committing. The worktree scripts in `bin/` symlink the project-local file into each worktree so it applies there too.

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
`accent-color.sh --name`. The second status line, `tmux/tab-status.sh`, starts
with the same label uncut, so any change to what a window is called belongs in
`tab-label.sh` and reaches both.

All of this runs on every pane focus, for every window in the session, or on
every status redraw, so none of it may wait on the network.
`tmux/window-pr.sh` and `tmux/ticket-title.sh` answer from a cache and refresh
it in the background, then rename the tabs when the answer changes, so a PR
number or ticket title that was not known yet appears a second later rather
than delaying the focus. Anything else that wants to add to the tab belongs in
`window-names.sh` under the same rule.

## Key bindings and the M-p palette

`M-p` opens `tmux/palette.sh`, an fzf list of the custom bindings that picks
one and presses its key. The list is read from tmux, not kept anywhere: a
binding shows up when `tmux.conf` gives it a description with
`bind -N "<what it does>"`, so every new custom binding needs one. In the
prefix table only keys `tmux.conf` binds with `-N` are listed, since tmux's own
prefix bindings carry descriptions too.

## Skills and the scripts they call

Skills in `claude/skills/` may depend on a script in `bin/`. `review-loop` calls `codex-review`, so a change to the JSON the script prints or the flags it accepts has to be mirrored in the skill, and vice versa. Document each script in `bin/README.md`.

The tmux config depends on `bin/` too: the `M-j` binding runs
`tmux/window-jump.sh`, which runs `~/.local/bin/wt-jump`, so that binding needs
both `./sync.sh tmux` and `./sync.sh wt-jump`. The dependency runs the other
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
