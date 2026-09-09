# editor-configs

Dotfiles for the tools listed by directory. `sync.sh` symlinks them into place.

## Claude Code settings

- `claude/settings.json` is symlinked to `~/.claude/settings.json`, so anything Claude Code persists to user settings shows up as a tracked change here.
- Claude Code reads only four settings files: `~/.claude/settings.json`, the project's `.claude/settings.json` and `.claude/settings.local.json`, and managed settings. There is no user-level `settings.local.json`.
- Anything that describes a specific organization's environment must not live in the tracked file. The auto mode environment profile (the `autoMode` key) belongs in that project's `.claude/settings.local.json`, which is gitignored there. If Claude Code writes `autoMode` back into `claude/settings.json`, move it again before committing. The worktree scripts in `bin/` symlink the project-local file into each worktree so it applies there too.
