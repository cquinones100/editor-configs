---
theme:
  name: terminal-dark
---

# Dev Environment Presentation

The thread holding all of this together: **stay on the home row, stay in the terminal, never reach for the mouse.** Every tool below shares the same muscle memory (vim motions, fzf pickers, alt-key chords) so switching contexts costs nothing.

```
  ___                  _
 / _ \__ _____ _ ___ _(_)_____ __ __
| (_) \ V / -_) '_\ V / / -_) V  V /
 \___/ \_/\___|_|  \_/|_\___|\_/\_/
```

## What we'll cover

1. **tmux** — the window manager I actually use
2. **claude** — agentic coding with permissions, hooks, and shared rules
3. **lazygit** — git with PR-shaped side-by-side diffs
4. **nvim** — editing with leader-space, telescope, and LSP
5. **Worktrees** — parallel branches without the bookkeeping cost
6. **Bonus** — this slide deck, rendered by the same toolchain
7. **Mouseless** — Homerow + Vimium, the philosophy outside the terminal
8. **Karabiner** — fn+hjkl arrows, hardware-layer remaps
9. **Configs** — how it all lives in one git repo
10. **Closing** — why it all reinforces itself

<!-- end_slide -->

```
 _
| |_ _ __ _  ___ __
|  _| '  \ || \ \ /
 \__|_|_|_\_,_/_\_\
```

## 1. tmux — the window manager

The prefix is `M-b` (alt-b) instead of the default `C-b`, so prefix-less alt chords drive almost everything. Result: I rarely actually press the prefix.

### Pane and window navigation

| Keys | Action |
| --- | --- |
| `alt + h/j/k/l` | Move between panes |
| `C-w h/j/k/l` | Same, but **also crosses into nvim splits** via `vim-tmux-navigator` |
| `alt + [` / `alt + ]` | Previous / next window |
| `alt + t` | New window in current pane's path |
| `alt + shift + h/j/k/l` | Split a new pane in that direction |
| `alt + shift + arrow` | Resize the active pane |
| `alt + =` | Zoom toggle |
| `alt + w` | Close pane (with confirm) |
| `alt + f` | Search pane scrollback |

### Toggle panes for the three things I always want

These are the killer keybinds. Each one creates a 75% split running the tool — press again from inside that tool and it kills itself. So every project-side pane is one keystroke away.

- `C-l` → lazygit pane
- `C-j` → nvim pane
- `C-k` → shell pane (persistent — tmux remembers which pane is "the shell")

### Command launcher

- `alt + p` opens an fzf popup with my history of recent commands; the selection runs in a new pane next to the focused one.
- `launch.sh` writes every selection to `~/.config/tmux/launch_history`, so the menu sorts by what I actually use.

### Visual feedback that I don't have to think about

- `pane-focus-in` hook runs `update-colors.sh`, which derives an accent color from the directory + git branch and recolors the pane border, session badge, and window tabs.
- I always know which project I'm in without reading the path.
- `alt + shift + T` toggles dark/light theme; the choice persists in `~/.config/tmux/.theme-mode` and re-applies on next start.

### Persistence

- `tmux-resurrect` + `tmux-continuum` with `@continuum-restore 'on'` — sessions survive reboots automatically.

### GitHub shortcut

- `prefix + P` and `alt + r` both run `gh pr view --web` for the current pane's path — straight from tmux to the PR in the browser.

### The workspace popup (`prefix + W`) — the killer feature

- fzf picks a project directory, then a sub-directory (Tab to drill into worktrees).
- A new window opens with three panes already running: `lazygit` (top), `claude` (bottom-left), shell (bottom-right) — all rooted at the chosen path.
- One keystroke from "I want to work on X" to a fully-laid-out workspace.

<!-- end_slide -->

```
    _              _     _
 __| |__ _ _  _ __| |___
/ _| / _` | || / _` / -_)
\__|_\__,_|\_,_\__,_\___|
```

## 2. claude — agentic coding

Configured at `~/.claude/settings.json` to be aggressive about defaults but safe about the things that bite.

### Permissions tuned to my workflow

- `defaultMode: auto` plus a wide allow-list for the commands I run constantly: `git log/diff/add/commit/status`, `gh pr/run` reads, `pnpm lint/tsc/typecheck`, `find`, `git -C *`. No prompt-fatigue for safe operations.
- Deny-list blocks the dangerous-by-default things: reading `.env*`, `git fetch`, `git pull` (I want to know when remote state changes).

### Hooks — the guardrails

PreToolUse hooks intercept `Bash` calls and enforce my rules at runtime, not just in CLAUDE.md:

- `enforce-no-npx.sh` — forces `pnpm` / `npm` instead of `npx`.
- `enforce-node.sh` — keeps one-off scripts on Node, not Python.
- `enforce-no-git-pull.sh` — backs up the deny-list above.
- `enforce-gh-api-readonly.sh` — `gh api` calls can only read, never POST/PATCH/DELETE.

These mean I don't have to police the agent in real time — the harness rejects the bad calls before they run.

### Editor + UX

- `editorMode: vim` so the prompt itself uses vim motions.
- Notification hook fires a macOS `display notification` whenever Claude needs attention — I can leave Claude running in another tmux pane and get pinged.
- Custom statusline (`statusline-command.sh`).
- `agentPushNotifEnabled: true` for background agents.

### Shared instructions

- The CLAUDE.md at `~/editor-configs/claude/CLAUDE.md` is the same one symlinked to my user-global `~/.claude/CLAUDE.md`. Code-style rules, Next.js conventions, testing rules, git etiquette — Claude inherits all of it on every project.
- Slash commands `/pr-view` and `/repo-view` are tiny shortcuts that map onto the same `gh` calls tmux and lazygit also use.

<!-- end_slide -->

```
 _                   _ _
| |__ _ ____  _ __ _(_) |_
| / _` |_ / || / _` | |  _|
|_\__,_/__|\_, \__, |_|\__|
           |__/|___/
```

## 3. lazygit — git

Configured to look and behave like a serious diff tool, not a TUI toy.

- `mainPanelSplitMode: vertical` + `splitDiff: auto` + `delta --side-by-side --tabs=2 --dark` → side-by-side diffs that match what I'd see on GitHub.
- `commitHashLength: 0` — no SHA noise in the log column.
- Vim-friendly remappings: `C-n` / `C-p` to reorder commits during interactive rebase.
- Editor preset is `nvim`, so commit message editing drops me back into the same editor I already live in.

### Custom commands

- `C-o` → `gh pr view --web` — jump from a commit/branch to its PR in the browser.
- `C-d` → `git diff main...HEAD | delta --side-by-side` — preview the entire branch as one PR-shaped diff before pushing.

This pairs with the tmux `C-l` toggle: lazygit is always one keystroke away, and one more keystroke away from being gone again.

<!-- end_slide -->

```
         _
 _ ___ _(_)_ __
| ' \ V / | '  \
|_||_\_/|_|_|_|_|
```

## 4. nvim — editing

Leader is `<Space>`. Settings worth calling out: `clipboard = unnamed` (yanks go straight to system clipboard), `splitright`/`splitbelow`, `relativenumber`, `scrolloff = 8`, `ignorecase` + `smartcase`.

### Movement and editing tweaks

- `Shift+Y` → yank entire line (no more `yy`).
- `C-s` → write.
- `C-c` → `<Esc>` in insert mode.
- Visual `J` / `K` → move highlighted block down / up, re-indented.
- `C-d` / `C-u` → half-page jumps **with the cursor pinned to the middle**, and snap to file boundaries when near the edges. (Custom autocmd.)
- `<leader>s` → start a substitution pre-filled with the word under the cursor — `s/\<word\>/word/gI` ready to edit.
- `<leader>cp` / `<leader>cP` → copy relative / absolute path of current buffer to clipboard.

### Telescope (fuzzy finder)

- `C-p` → find files (includes hidden); inside the picker, `C-y` copies the highlighted path instead of opening it.
- `C-S-f` → live grep across the project.
- `C-S-p` → searchable, selectable list of every keymap (live documentation of my own config).
  - open file on github web for easy sharing
  - copy relative and absolute paths of the current file to share easily with claude or in chat.
- `<leader>fb` buffers, `<leader>fr` recent files, `<leader>fd` diagnostics, `<leader>fh` help.

### LSP

- `gd` / `C-]` definition, `gr` references, `gi` implementation.
- `K` hover; `gh` shows diagnostic float **if there's a diagnostic on this line**, otherwise falls back to hover — one key, both jobs.
- `<leader>rn` rename, `<leader>ca` code action.
- `C-S-j` / `C-S-k` → next / previous diagnostic.

### File tree and seamless tmux integration

- `<leader>e` or `C-n` → toggle Neo-tree (shows dotfiles and gitignored entries; follows the current buffer).
- `vim-tmux-navigator` makes `C-w h/j/k/l` cross the boundary between nvim splits and tmux panes — I never think about whether the next pane is editor or terminal.

<!-- end_slide -->

```
__      __       _   _
\ \    / /__ _ _| |_| |_ _ _ ___ ___ ___
 \ \/\/ / _ \ '_| / /  _| '_/ -_) -_|_-<
  \_/\_/\___/_| |_\_\\__|_| \___\___/__/
```

## 5. Worktree cleanup (`wt-cleanup`)

**Why this matters:** I use one worktree per branch so I can have multiple Claude sessions, lazygit instances, and editors running in parallel without stashing or context-switching. The cost is that worktrees pile up.

- `~/editor-configs/bin/wt-cleanup .claude/worktrees`
- Pipes `git worktree list --porcelain` into an fzf multi-select, then removes everything I tick.
- Tab to toggle, Enter to confirm. No clicking, no copy-pasting paths into `git worktree remove`.
- Failure case is loud: if a worktree has uncommitted work, the remove fails and prints the `--force` command — never silently destructive.

<!-- end_slide -->

```
 ___
| _ ) ___ _ _ _  _ ___
| _ \/ _ \ ' \ || (_-<
|___/\___/_||_\_,_/__/
```

## 6. Bonus: this slide deck

You're looking at a markdown file. No Keynote, no PowerPoint, no Google Slides, no browser tab.

- The "slides" are `<!-- end_slide -->` comments in `outline.md`.
- The renderer is `presenterm` — a terminal-native slideshow tool.
- Arrow keys advance, vim motions work in the source, and the whole thing is version-controlled in the same git repo as everything else I've been talking about.
- If a slide is wrong I `C-j` into nvim, fix it, `:w`, and refresh. No exporting, no re-uploading, no "let me share my screen again."
- Naturally, the file lives in a git worktree opened by the `prefix + W` workspace popup. The presentation about the dev environment is being presented *by* the dev environment.

It's tools all the way down.

<!-- end_slide -->

```
 __  __                  _
|  \/  |___ _  _ ___ ___| |___ ______
| |\/| / _ \ || (_-</ -_) / -_|_-<_-<
|_|  |_\___/\_,_/__/\___|_\___/__/__/
```

## 7. Mouseless: outside the terminal

The home-row philosophy doesn't stop at the edge of the terminal. Two tools extend it to the rest of the OS and the browser.

### Homerow (macOS)

- Trigger Homerow → every clickable UI element on the screen gets a letter label.
- Type the label → it's "clicked." Works in any Mac app: menus, toolbars, web forms, file dialogs.
- Like Vimium's link hints, but for the entire operating system.

### Vimium (Chrome)

- `f` → label every link/button on the page; type the hint to follow it. `F` opens it in a new tab.
- `j` / `k` scroll, `gg` / `G` jump to top/bottom, `/` find — vim motions in the browser.
- `t` new tab, `J` / `K` cycle tabs, `x` close, `X` reopen — same muscle memory as nvim's buffer keymaps.

Same vocabulary as everything else in this deck: hint-based navigation (fzf, telescope, Homerow, Vimium) and vim motions everywhere a cursor exists.

<!-- end_slide -->

```
 _  __              _    _
| |/ /__ _ _ _ __ _| |__(_)_ _  ___ _ _
| ' </ _` | '_/ _` | '_ \ | ' \/ -_) '_|
|_|\_\__,_|_| \__,_|_.__/_|_||_\___|_|
```

## 8. Karabiner: remap the keyboard itself

Karabiner Elements rewires the keyboard at the OS level — before any app even sees the keystrokes. My config has exactly two rules, but they're the most-used keybinds I own:

- `fn + h / j / k / l` → arrow keys.
- `fn + backspace` → forward delete.

That's it. The hjkl rule means I never reach for the arrow cluster — even in apps that don't speak vim (Slack, Notion, browser address bars). The home-row philosophy starts at the hardware layer.

The whole config is ~80 lines of JSON in `karabiner/karabiner.json` of the editor-configs repo.

<!-- end_slide -->

```
  ___           __ _
 / __|___ _ _  / _(_)__ _ ___
| (__/ _ \ ' \|  _| / _` (_-<
 \___\___/_||_|_| |_\__, /__/
                    |___/
```

## 9. Configs: how I manage all of this

Everything you've seen — tmux, nvim, claude, lazygit, ghostty, karabiner — lives in one public git repo.

**`github.com/cquinones100/editor-configs`**

- One repo, one source of truth. Every dotfile and keybind is version-controlled.
- `sync.sh` symlinks each tool's config into the right place (`~/.config/tmux`, `~/.config/nvim`, `~/.claude`, etc.) — different OS paths for macOS vs Linux are handled in one place.
- New machine setup is `git clone && ./sync.sh`. That's it.
- Every keybinding change is a commit. When something breaks, `git blame` tells me which past-me to be mad at.
- The `wt-cleanup` script and the Claude hooks I covered earlier live in `bin/` and `claude/hooks/` of this repo.
- Public and fork-able. Take whatever's useful.

<!-- end_slide -->

```
  ___ _        _
 / __| |___ __(_)_ _  __ _
| (__| / _ (_-< | ' \/ _` |
 \___|_\___/__/_|_||_\__, |
                     |___/
```

## Closing: how it all reinforces itself

- **One vocabulary.** Vim motions in nvim, vim motions in tmux copy-mode, vim motions in the Claude prompt, vim-style remaps in lazygit. Everything fzf where a list shows up.
- **One filesystem boundary.** Worktrees keep parallel branches physically separate so tmux, lazygit, and Claude can all assume "the cwd is the project."
- **One keystroke away from anything.** lazygit, nvim, shell, command launcher, PR in browser, fresh workspace, theme switch — all single chords from any pane.
- **The agent inherits the same rules I follow.** Same CLAUDE.md, same `pnpm`-not-`npx`, same git etiquette. Less re-explaining, fewer surprises.

The presentation's punchline: efficiency isn't any one of these tools — it's that they all speak the same language, so the cost of moving between them is zero.
