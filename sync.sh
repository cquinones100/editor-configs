#!/usr/bin/env bash

set -e

case "$(uname -s)" in
  Darwin) OS=macos ;;
  Linux)  OS=linux ;;
  *) echo "Unsupported OS: $(uname -s)" >&2; exit 1 ;;
esac

if [[ "$OS" == "macos" ]]; then
  LAZYGIT_DIR="$HOME/Library/Application Support/lazygit"
  VSCODE_DIR="$HOME/Library/Application Support/Code/User"
else
  LAZYGIT_DIR="$HOME/.config/lazygit"
  VSCODE_DIR="$HOME/.config/Code/User"
fi

sync_lazygit() {
  mkdir -p "$LAZYGIT_DIR"
  ln -sf ~/editor-configs/lazygit/config.yml "$LAZYGIT_DIR/config.yml"
}

sync_vscode() {
  mkdir -p "$VSCODE_DIR"
  ln -sf ~/editor-configs/vscode/settings.json "$VSCODE_DIR/settings.json"
  ln -sf ~/editor-configs/vscode/tasks.json "$VSCODE_DIR/tasks.json"
  ln -sf ~/editor-configs/vscode/keybindings.json "$VSCODE_DIR/keybindings.json"
  ln -sfn ~/editor-configs/vscode/snippets "$VSCODE_DIR/snippets"
}

sync_neovim() {
  rm -rf ~/.config/nvim
  ln -sfn ~/editor-configs/nvim ~/.config/nvim
}

sync_git() {
  ln -sf ~/editor-configs/git/.gitconfig ~/.gitconfig
  # This repo's own hooks, such as the one that keeps machine-specific Claude
  # settings out of commits. Set on this clone only, not in the shared
  # .gitconfig, so other repositories keep their hooks.
  git -C ~/editor-configs config core.hooksPath .githooks
}

sync_claude() {
  mkdir -p ~/.claude
  ln -sf ~/editor-configs/claude/CLAUDE.md ~/.claude/CLAUDE.md
  ln -sf ~/editor-configs/claude/settings.json ~/.claude/settings.json
  ln -sf ~/editor-configs/claude/statusline-command.sh ~/.claude/statusline-command.sh
  ln -sf ~/editor-configs/claude/otel-headers.sh ~/.claude/otel-headers.sh
  ln -sfn ~/editor-configs/claude/commands ~/.claude/commands
  # One link per skill rather than one for the directory: Claude Code keeps its
  # own synced/ folder in ~/.claude/skills, so that path has to stay real.
  mkdir -p ~/.claude/skills
  # Skills kept here but not installed. review-loop is defined by the repos that
  # use it, and a personal copy beside theirs shows up as a second /review-loop.
  # A leftover link from before it was listed here is removed.
  unlinked_skills=(review-loop)
  for skill in ~/editor-configs/claude/skills/*/; do
    name=$(basename "$skill")
    if [[ " ${unlinked_skills[*]} " == *" $name "* ]]; then
      [ -L ~/.claude/skills/"$name" ] && rm ~/.claude/skills/"$name"
      continue
    fi
    ln -sfn "${skill%/}" ~/.claude/skills/
  done
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
  mkdir -p ~/.config/karabiner
  ln -sf ~/editor-configs/karabiner/karabiner.json ~/.config/karabiner/karabiner.json
}

sync_tmux() {
  mkdir -p ~/.config/tmux
  ln -sf ~/editor-configs/tmux/tmux.conf ~/.config/tmux/tmux.conf
  ln -sf ~/editor-configs/tmux/accent-color.sh ~/.config/tmux/accent-color.sh
  ln -sf ~/editor-configs/tmux/update-colors.sh ~/.config/tmux/update-colors.sh
  ln -sf ~/editor-configs/tmux/theme.sh ~/.config/tmux/theme.sh
  ln -sf ~/editor-configs/tmux/workspace.sh ~/.config/tmux/workspace.sh
  ln -sf ~/editor-configs/tmux/toggle-shell-pane.sh ~/.config/tmux/toggle-shell-pane.sh
  ln -sf ~/editor-configs/tmux/palette.sh ~/.config/tmux/palette.sh
  ln -sf ~/editor-configs/tmux/pr-ready.sh ~/.config/tmux/pr-ready.sh
  ln -sf ~/editor-configs/tmux/pr-open.zsh ~/.config/tmux/pr-open.zsh
  ln -sf ~/editor-configs/tmux/wt-open.zsh ~/.config/tmux/wt-open.zsh
  ln -sf ~/editor-configs/tmux/agent-state.sh ~/.config/tmux/agent-state.sh
  ln -sf ~/editor-configs/tmux/confirm.sh ~/.config/tmux/confirm.sh
  ln -sf ~/editor-configs/tmux/linear-ticket.sh ~/.config/tmux/linear-ticket.sh
  ln -sf ~/editor-configs/tmux/window-jump.sh ~/.config/tmux/window-jump.sh
  ln -sf ~/editor-configs/tmux/window-names.sh ~/.config/tmux/window-names.sh
  ln -sf ~/editor-configs/tmux/window-pr.sh ~/.config/tmux/window-pr.sh
  ln -sf ~/editor-configs/tmux/tab-label.sh ~/.config/tmux/tab-label.sh
  ln -sf ~/editor-configs/tmux/tab-status.sh ~/.config/tmux/tab-status.sh
  ln -sf ~/editor-configs/tmux/tab-name.zsh ~/.config/tmux/tab-name.zsh
  ln -sf ~/editor-configs/tmux/ticket-title.sh ~/.config/tmux/ticket-title.sh
}

sync_ghostty() {
  mkdir -p ~/.config/ghostty
  ln -sf ~/editor-configs/ghostty/config ~/.config/ghostty/config
}

sync_pgcli() {
  ln -sf ~/editor-configs/pgcli/config ~/.pgclirc
}

if [[ "$OS" == "macos" ]]; then
  configs=(lazygit vscode neovim git claude iterm karabiner tmux ghostty pgcli)
else
  configs=(lazygit vscode neovim git claude tmux ghostty pgcli)
fi

failed=()

run_sync() {
  local name=$1
  echo "Syncing $name..."
  if ! "sync_$name"; then
    echo "  failed to sync $name; continuing" >&2
    failed+=("$name")
  fi
}

report() {
  if (( ${#failed[@]} > 0 )); then
    echo ""
    echo "Failed: ${failed[*]}" >&2
    exit 1
  fi
}
configs=(lazygit vscode neovim git claude iterm karabiner tmux ghostty pgcli)
sync_bin() {
  mkdir -p ~/.local/bin
  # Executables only, so docs alongside the scripts don't get linked in.
  for script in ~/editor-configs/bin/*; do
    [[ -f "$script" && -x "$script" ]] || continue
    ln -sf "$script" ~/.local/bin/"$(basename "$script")"
  done
}

# Resolved from this script's own location rather than assuming ~/editor-configs,
# so a single bin script can be installed from a clone anywhere.
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Symlinks one script out of bin/, so `./sync.sh worktree-from-ticket` installs
# just that one instead of everything in bin/.
sync_bin_script() {
  local name=$1
  if [[ ! -f "$REPO_DIR/bin/$name" ]]; then
    echo "No such script: bin/$name" >&2
    return 1
  fi
  mkdir -p ~/.local/bin
  ln -sf "$REPO_DIR/bin/$name" ~/.local/bin/"$name"
}

bin_scripts() {
  local script
  for script in "$REPO_DIR"/bin/*; do
    [[ -f "$script" && -x "$script" ]] && basename "$script"
  done
}

configs=(lazygit vscode neovim git claude iterm karabiner tmux ghostty pgcli bin)

sync_all() {
  for config in "${configs[@]}"; do
    run_sync "$config"
  done
}

if [[ $# -gt 0 ]]; then
  for arg in "$@"; do
    if printf '%s\n' "${configs[@]}" | grep -qx "$arg"; then
      run_sync "$arg"
    elif [[ -f "$REPO_DIR/bin/$arg" ]]; then
      echo "Syncing bin/$arg..."
      if ! sync_bin_script "$arg"; then
        echo "  failed to sync bin/$arg; continuing" >&2
        failed+=("$arg")
      fi
    else
      echo "Unknown config: $arg" >&2
      echo "  configs: ${configs[*]}" >&2
      echo "  bin scripts: $(bin_scripts | tr '\n' ' ')" >&2
      exit 1
    fi
  done
  report
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
  report
  exit 0
fi

for num in $selection; do
  idx=$((num - 1))
  if [[ $idx -ge 0 && $idx -lt ${#configs[@]} ]]; then
    run_sync "${configs[$idx]}"
  else
    echo "Invalid selection: $num" >&2
    exit 1
  fi
done

report
