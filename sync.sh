#!/usr/bin/env bash

set -e

sync_lazygit() {
  ln -sf ~/editor-configs/lazygit/config.yml ~/Library/Application\ Support/lazygit/config.yml
}

sync_vscode() {
  ln -sf ~/editor-configs/vscode/settings.json ~/Library/Application\ Support/Code/User/settings.json
  ln -sf ~/editor-configs/vscode/tasks.json ~/Library/Application\ Support/Code/User/tasks.json
  ln -sf ~/editor-configs/vscode/keybindings.json ~/Library/Application\ Support/Code/User/keybindings.json
  ln -sf ~/editor-configs/vscode/snippets ~/Library/Application\ Support/Code/User/snippets
}

sync_neovim() {
  ln -sf ~/editor-configs/nvim/init.lua ~/.config/nvim/init.lua
}

sync_git() {
  ln -sf ~/editor-configs/git/.gitconfig ~/.gitconfig
}

sync_claude() {
  ln -sf ~/editor-configs/claude/CLAUDE.md ~/.claude/CLAUDE.md
  ln -sf ~/editor-configs/claude/settings.json ~/.claude/settings.json
  ln -sf ~/editor-configs/claude/statusline-command.sh ~/.claude/statusline-command.sh
  mkdir -p ~/.claude/hooks
  for hook in ~/editor-configs/claude/hooks/*; do
    ln -sf "$hook" ~/.claude/hooks/
  done
}

sync_iterm() {
  mkdir -p ~/Library/Application\ Support/iTerm2/Scripts/AutoLaunch
  ln -sf ~/editor-configs/iterm/Scripts/AutoLaunch/session_title.py ~/Library/Application\ Support/iTerm2/Scripts/AutoLaunch/session_title.py
}

sync_karabiner() {
  ln -s ~/editor-configs/karabiner/settings.json ~/.config/karabiner
}

configs=(lazygit vscode neovim git claude iterm karabiner)

sync_all() {
  for config in "${configs[@]}"; do
    echo "Syncing $config..."
    "sync_$config"
  done
}

if [[ $# -gt 0 ]]; then
  for arg in "$@"; do
    if printf '%s\n' "${configs[@]}" | grep -qx "$arg"; then
      echo "Syncing $arg..."
      "sync_$arg"
    else
      echo "Unknown config: $arg (available: ${configs[*]})" >&2
      exit 1
    fi
  done
  exit 0
fi

echo "Select configs to sync (space-separated numbers, or 'a' for all):"
echo ""
for i in "${!configs[@]}"; do
  echo "  $((i + 1))) ${configs[$i]}"
done
echo ""
read -rp "> " selection

if [[ "$selection" == "a" ]]; then
  sync_all
  exit 0
fi

for num in $selection; do
  idx=$((num - 1))
  if [[ $idx -ge 0 && $idx -lt ${#configs[@]} ]]; then
    echo "Syncing ${configs[$idx]}..."
    "sync_${configs[$idx]}"
  else
    echo "Invalid selection: $num" >&2
    exit 1
  fi
done
