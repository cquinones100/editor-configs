#!/usr/bin/env bash

# Sets up the tmux workspace (tmux, the sidebar, the palette, the notes app,
# Neovim and the scripts in bin/) on a new Mac, and says what else each
# optional part needs. Safe to run again: it installs only what is missing,
# and asks before installing anything or changing ~/.zshrc. With --check it
# changes nothing and only reports.

set -u

CHECK=false
[[ ${1:-} == --check ]] && CHECK=true

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PACKAGES=(tmux jq fzf gh glow lazygit neovim)
# The oldest tmux this has been used with.
TMUX_MIN=3.8

problems=0
ok() { echo "  ✓ $1"; }
todo() { echo "  ✗ $1"; problems=$((problems + 1)); }
optional() { echo "  – $1"; }
ask() {
  $CHECK && return 1
  local answer
  read -rp "    $1 [y/N] " answer
  [[ $answer == [yY]* ]]
}
# What an interactive zsh sees, since tmux starts new tabs from `zsh -i` and
# nvm is set up only there.
in_zsh() { zsh -i -c "$1" 2>/dev/null; }

echo "Required"

if [[ $(uname -s) == Darwin ]]; then
  ok "macOS"
else
  todo "macOS: the scripts use pbcopy, osascript and the Keychain"
  exit 1
fi

if [[ ${SHELL##*/} == zsh ]]; then
  ok "zsh is your shell"
else
  todo "zsh as your shell: chsh -s /bin/zsh"
fi

# Everything links to and runs from ~/editor-configs, so a clone elsewhere is
# linked there.
if [[ $(cd ~/editor-configs 2>/dev/null && pwd -P) == "$REPO_DIR" ]]; then
  ok "the repo is at ~/editor-configs"
elif [[ -e ~/editor-configs ]]; then
  todo "~/editor-configs is something else; move it aside, then run this again"
  exit 1
elif ask "Link ~/editor-configs to $REPO_DIR?"; then
  ln -s "$REPO_DIR" ~/editor-configs && ok "linked ~/editor-configs to $REPO_DIR"
else
  todo "the repo at ~/editor-configs (ln -s '$REPO_DIR' ~/editor-configs)"
fi

if command -v brew >/dev/null; then
  ok "Homebrew"
  missing=()
  for package in "${PACKAGES[@]}"; do
    command="$package"
    [[ $package == neovim ]] && command=nvim
    command -v "$command" >/dev/null || missing+=("$package")
  done
  if (( ${#missing[@]} == 0 )); then
    ok "${PACKAGES[*]}"
  elif ask "Install ${missing[*]} with Homebrew?"; then
    brew install "${missing[@]}" && ok "installed ${missing[*]}" || todo "brew install ${missing[*]} failed"
  else
    todo "brew install ${missing[*]}"
  fi
else
  todo "Homebrew, from https://brew.sh, then run this again"
fi

if command -v tmux >/dev/null; then
  version=$(tmux -V | sed 's/[^0-9.]//g')
  if [[ $(printf '%s\n' "$TMUX_MIN" "$version" | sort -t. -k1,1n -k2,2n | head -1) == "$TMUX_MIN" ]]; then
    ok "tmux $version"
  else
    todo "tmux $TMUX_MIN or newer (you have $version): brew upgrade tmux"
  fi
fi

if in_zsh 'command -v node' >/dev/null; then
  ok "Node $(in_zsh 'node --version')"
else
  todo "Node in an interactive zsh, through nvm: https://github.com/nvm-sh/nvm, then nvm install --lts"
fi

if in_zsh 'echo $PATH' | tr ':' '\n' | grep -qx "$HOME/.local/bin"; then
  ok "~/.local/bin is on your PATH"
elif ask "Add ~/.local/bin to your PATH in ~/.zshrc?"; then
  echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc && ok "added ~/.local/bin to ~/.zshrc"
else
  todo "~/.local/bin on your PATH, in ~/.zshrc"
fi

# The links, the pinned tmux plugins and mermaid-ascii, and the scripts.
if [[ -L ~/.config/tmux/tmux.conf && -L ~/.config/nvim ]]; then
  ok "the configs are linked"
elif ask "Link the tmux and Neovim configs and the scripts in bin/ (./sync.sh tmux neovim lazygit bin)?"; then
  "$REPO_DIR/sync.sh" tmux neovim lazygit bin && ok "linked the configs" || todo "./sync.sh tmux neovim lazygit bin failed"
else
  todo "./sync.sh tmux neovim lazygit bin"
fi

# diffview (M-d) and the notes app need the plugins lazy.nvim installs.
if [[ -d ~/.local/share/nvim/lazy/diffview.nvim ]]; then
  ok "Neovim's plugins"
elif command -v nvim >/dev/null && [[ -L ~/.config/nvim ]] && ask "Install Neovim's plugins at their pinned commits?"; then
  nvim --headless "+Lazy! restore" +qa >/dev/null 2>&1 && ok "installed Neovim's plugins" || todo "nvim, then :Lazy restore"
else
  todo "Neovim's plugins: open nvim once, then :Lazy restore"
fi

echo ""
echo "Optional, each for the keys it names"

if gh auth status >/dev/null 2>&1; then
  ok "GitHub (M-v, M-d and PR numbers in tab names)"
else
  optional "GitHub, for M-v, M-d and PR numbers in tab names: gh auth login"
fi

if security find-generic-password -s linear-api-key >/dev/null 2>&1; then
  ok "Linear (M-i, M-l and ticket titles in tab names)"
else
  optional "Linear, for M-i, M-l and ticket titles in tab names: a personal API key from Linear's settings, then security add-generic-password -a \"\$USER\" -s linear-api-key -w"
fi

# Without these hooks every tab shows idle, and M-a has nothing to walk.
if grep -qs 'agent-state.sh' ~/.claude/settings.json; then
  ok "Claude Code's hooks (tab states, the sidebar's Needs you, M-a)"
elif command -v claude >/dev/null; then
  optional "Claude Code's hooks, for tab states and M-a: copy the \"hooks\" block from $REPO_DIR/claude/settings.json into ~/.claude/settings.json (./sync.sh claude would bring the rest of its owner's settings too)"
else
  optional "Claude Code, for tab states, the sidebar's sessions and M-a: https://claude.com/claude-code"
fi

if [[ -f ~/.config/slack-relay/config.json ]]; then
  ok "slack-relay"
else
  optional "slack-relay, to use the tabs from Slack: see slack-relay in bin/README.md"
fi

echo ""
if (( problems )); then
  echo "$problems thing(s) left above. Run ./setup.sh again once they're done."
  exit 1
fi
if [[ -n ${TMUX:-} ]]; then
  $CHECK || tmux source-file ~/.config/tmux/tmux.conf
  echo "Ready."
else
  echo "Ready. Start tmux with: tmux"
fi
