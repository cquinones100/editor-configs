# Switchboard

A terminal workspace for working with coding agents: tmux, Neovim, lazygit and a set of scripts, built around Claude Code. Every tab says what its agent is doing and whether it is waiting on you, one key takes you to the next one that needs you, and a ticket goes from idea to merged PR without leaving the keyboard.

It is opinionated: the defaults are how it is meant to be used, and Settings (`M-p`, then Settings) turns off the parts you don't want.

## Requirements

- macOS, with zsh as your shell. Linux isn't supported yet: the scripts use pbcopy, osascript, open and the Keychain, and `setup.sh` stops at its first check there.
- [Homebrew](https://brew.sh)
- A terminal that passes Option through as Alt and shows 24-bit color: [Ghostty](https://ghostty.org) (`brew install --cask ghostty`; setup links its config) or iTerm2 with the Option keys set to Esc+. Terminal.app does neither.
- [Claude Code](https://claude.com/claude-code), which every tab runs: `curl -fsSL https://claude.ai/install.sh | bash`

## Set up

```
git clone https://github.com/cquinones100/switchboard.git ~/switchboard
~/switchboard/setup.sh
```

`setup.sh` checks what the workspace needs and asks before it installs anything or changes `~/.zshrc`: Homebrew's `tmux jq fzf gh glow lazygit neovim git-delta ripgrep`, Node through nvm, the MesloLGS NF font, the links for the tmux, Neovim and lazygit configs and the scripts in `bin/`, the worktree shell functions, Ghostty's config, and Neovim's plugins. Then it asks about the optional parts (Claude Code's hooks for tab states, this repo's whole Claude Code setup, the git hooks) and lists what GitHub, Linear, the Slack relay, the PR image view (mermaid-cli), `/deploy-test` (ffmpeg) and `/review-loop` (Codex) need. It ends with a list of anything left to do; run it again until it says Ready. Running it again any time changes only what isn't in place, and `./setup.sh --check` only reports.

Then start tmux:

```
tmux new-session -A -s main
```

## First keys

| Key | What it does |
|---|---|
| `M-p` | Find any command by what it does, Settings included |
| `M-a` | Go to the next tab that needs you |
| `M-j` | Find a tab by typing its name |
| `M-S-f` | Search your notes, Linear, GitHub and Slack at once |
| `M-Space` | Mission control: every tab, the Work map, PRs, Settings |
| `M-t` | New tab running Claude, in a directory you pick |
| `M-s` | Into the sidebar and back out |
| `M-f` | Pin the tab to the top of Needs you |
| `M-v` / `M-d` | The branch's PR description / its diff, as GitHub shows them |

`M` is Option. Tips in the top-right corner teach the rest the first time each would help.

## Staying up to date

Each time tmux opens, and hourly after that, it checks GitHub for new commits and offers them in a popup that updates the clone and runs `setup.sh`. With the git hooks on, a `git pull` links whatever it added too.

## Where things are

| Directory | What is in it |
|---|---|
| `tmux/` | `tmux.conf`, the tab states, sidebar launcher, palette, settings and tips |
| `lib/sidebar/`, `bin/tmux-sidebar` | The sidebar and mission control |
| `bin/` | The scripts: worktrees (`wt`, `wtpr`, `wtb`, `wtr`), the notes app, the Slack relay, and more; see [bin/README.md](bin/README.md) |
| `nvim/`, `notes/` | Neovim's config, and the notes app built on it |
| `claude/` | Claude Code's settings, hooks, statusline and skills |
| `lazygit/`, `ghostty/`, `karabiner/`, `pgcli/` | Those tools' configs |
| `test/` | `node --test test/*.test.js`, against a throwaway tmux and a temporary home |

[bin/README.md](bin/README.md) describes every script and feature in full.
