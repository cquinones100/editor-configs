#!/usr/bin/env bash

set -e

case "$(uname -s)" in
  Darwin) OS=macos ;;
  Linux)  OS=linux ;;
  *) echo "Unsupported OS: $(uname -s)" >&2; exit 1 ;;
esac

if [[ "$OS" == "macos" ]]; then
  LAZYGIT_DIR="$HOME/Library/Application Support/lazygit"
else
  LAZYGIT_DIR="$HOME/.config/lazygit"
fi

# Links $1 at $2, as ln -sfn does, but a real file or directory already at
# $2 is moved aside to $2.bak.<time> first, and said so, rather than being
# overwritten or deleted. A link already there is just replaced. A $2 ending
# in / is a directory to link into, under $1's own name.
put_link() {
  local src=$1 dest=$2
  [[ $dest == */ ]] && dest="$dest$(basename "$src")"
  if [[ -e $dest && ! -L $dest ]]; then
    local backup
    backup="$dest.bak.$(date +%Y%m%d%H%M%S)"
    mv "$dest" "$backup"
    echo "  moved $dest aside to $backup"
  fi
  ln -sfn "$src" "$dest"
}

sync_lazygit() {
  mkdir -p "$LAZYGIT_DIR"
  put_link ~/editor-configs/lazygit/config.yml "$LAZYGIT_DIR/config.yml"
}

sync_neovim() {
  put_link ~/editor-configs/nvim ~/.config/nvim
}

# This clone's git setup only. The global ~/.gitconfig isn't managed here: it
# holds a machine's identity and paths, which have no place in a public repo.
sync_git() {
  # This repo's own hooks, such as the one that keeps machine-specific Claude
  # settings out of commits. Set on this clone only, so other repositories
  # keep their hooks.
  git -C ~/editor-configs config core.hooksPath .githooks
}

sync_claude() {
  mkdir -p ~/.claude
  put_link ~/editor-configs/claude/CLAUDE.md ~/.claude/CLAUDE.md
  put_link ~/editor-configs/claude/settings.json ~/.claude/settings.json
  put_link ~/editor-configs/claude/statusline-command.sh ~/.claude/statusline-command.sh
  put_link ~/editor-configs/claude/otel-headers.sh ~/.claude/otel-headers.sh
  put_link ~/editor-configs/claude/commands ~/.claude/commands
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
    put_link "${skill%/}" ~/.claude/skills/
  done
  mkdir -p ~/.claude/hooks
  for hook in ~/editor-configs/claude/hooks/*; do
    put_link "$hook" ~/.claude/hooks/
  done
}

sync_iterm() {
  mkdir -p ~/Library/Application\ Support/iTerm2/Scripts/AutoLaunch
  put_link ~/editor-configs/iterm/Scripts/AutoLaunch/session_title.py ~/Library/Application\ Support/iTerm2/Scripts/AutoLaunch/session_title.py
}

sync_karabiner() {
  mkdir -p ~/.config/karabiner
  put_link ~/editor-configs/karabiner/karabiner.json ~/.config/karabiner/karabiner.json
}

# Installs the tmux plugins listed in tmux/plugins.txt, each at its pinned
# commit. A plugin already there is moved to that commit, fetching it first if
# it is new to the clone. Nothing else is run from the plugin repositories here;
# tmux.conf loads them.
sync_tmux_plugins() {
  local dir=~/.config/tmux/plugins name url commit
  mkdir -p "$dir"
  grep -vE '^\s*(#|$)' ~/editor-configs/tmux/plugins.txt | while read -r name url commit; do
    if [ ! -d "$dir/$name/.git" ]; then
      git clone --quiet --no-checkout "$url" "$dir/$name" || { echo "  could not clone $name" >&2; continue; }
    fi
    git -C "$dir/$name" cat-file -e "$commit^{commit}" 2>/dev/null ||
      git -C "$dir/$name" fetch --quiet origin "$commit" ||
      { echo "  could not fetch $name at $commit" >&2; continue; }
    git -C "$dir/$name" -c advice.detachedHead=false checkout --quiet --detach "$commit" &&
      echo "  $name at ${commit:0:7}"
  done
}

sync_tmux() {
  mkdir -p ~/.config/tmux
  put_link ~/editor-configs/tmux/tmux.conf ~/.config/tmux/tmux.conf
  sync_tmux_plugins
  put_link ~/editor-configs/tmux/accent-color.sh ~/.config/tmux/accent-color.sh
  put_link ~/editor-configs/tmux/update-colors.sh ~/.config/tmux/update-colors.sh
  put_link ~/editor-configs/tmux/theme.sh ~/.config/tmux/theme.sh
  put_link ~/editor-configs/tmux/workspace.sh ~/.config/tmux/workspace.sh
  put_link ~/editor-configs/tmux/toggle-shell-pane.sh ~/.config/tmux/toggle-shell-pane.sh
  put_link ~/editor-configs/tmux/palette.sh ~/.config/tmux/palette.sh
  put_link ~/editor-configs/tmux/pr-ready.sh ~/.config/tmux/pr-ready.sh
  put_link ~/editor-configs/tmux/pr-open.zsh ~/.config/tmux/pr-open.zsh
  put_link ~/editor-configs/tmux/ticket-open.zsh ~/.config/tmux/ticket-open.zsh
  put_link ~/editor-configs/tmux/wt-open.zsh ~/.config/tmux/wt-open.zsh
  put_link ~/editor-configs/tmux/slack-relay-open.sh ~/.config/tmux/slack-relay-open.sh
  put_link ~/editor-configs/tmux/agent-state.sh ~/.config/tmux/agent-state.sh
  put_link ~/editor-configs/tmux/claude-pane.sh ~/.config/tmux/claude-pane.sh
  put_link ~/editor-configs/tmux/resurrect-tidy.sh ~/.config/tmux/resurrect-tidy.sh
  # Saves made before resurrect's post-save hook ran the tidy-up are handled once here.
  ~/editor-configs/tmux/resurrect-tidy.sh
  put_link ~/editor-configs/tmux/confirm.sh ~/.config/tmux/confirm.sh
  put_link ~/editor-configs/tmux/linear-ticket.sh ~/.config/tmux/linear-ticket.sh
  put_link ~/editor-configs/tmux/branch-copy.sh ~/.config/tmux/branch-copy.sh
  put_link ~/editor-configs/tmux/reply-send.sh ~/.config/tmux/reply-send.sh
  put_link ~/editor-configs/tmux/note-shape.sh ~/.config/tmux/note-shape.sh
  put_link ~/editor-configs/tmux/linear-project.sh ~/.config/tmux/linear-project.sh
  put_link ~/editor-configs/tmux/merge-queue.sh ~/.config/tmux/merge-queue.sh
  put_link ~/editor-configs/tmux/notes-open.sh ~/.config/tmux/notes-open.sh
  put_link ~/editor-configs/tmux/window-jump.sh ~/.config/tmux/window-jump.sh
  put_link ~/editor-configs/tmux/window-revive.sh ~/.config/tmux/window-revive.sh
  put_link ~/editor-configs/tmux/window-names.sh ~/.config/tmux/window-names.sh
  put_link ~/editor-configs/tmux/window-pr.sh ~/.config/tmux/window-pr.sh
  put_link ~/editor-configs/tmux/tab-label.sh ~/.config/tmux/tab-label.sh
  put_link ~/editor-configs/tmux/tab-goto.sh ~/.config/tmux/tab-goto.sh
  put_link ~/editor-configs/tmux/path-facts.sh ~/.config/tmux/path-facts.sh
  put_link ~/editor-configs/tmux/tab-status.sh ~/.config/tmux/tab-status.sh
  put_link ~/editor-configs/tmux/tab-name.zsh ~/.config/tmux/tab-name.zsh
  put_link ~/editor-configs/tmux/ticket-title.sh ~/.config/tmux/ticket-title.sh
}

sync_ghostty() {
  mkdir -p ~/.config/ghostty
  put_link ~/editor-configs/ghostty/config ~/.config/ghostty/config
}

sync_pgcli() {
  put_link ~/editor-configs/pgcli/config ~/.pgclirc
}

# What `./sync.sh` offers: iTerm and Karabiner only exist on macOS.
if [[ "$OS" == "macos" ]]; then
  configs=(lazygit neovim git claude iterm karabiner tmux ghostty pgcli bin)
else
  configs=(lazygit neovim git claude tmux ghostty pgcli bin)
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
sync_bin() {
  mkdir -p ~/.local/bin
  # Executables only, so docs alongside the scripts don't get linked in.
  for script in ~/editor-configs/bin/*; do
    [[ -f "$script" && -x "$script" ]] || continue
    put_link "$script" ~/.local/bin/"$(basename "$script")"
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
  put_link "$REPO_DIR/bin/$name" ~/.local/bin/"$name"
}

bin_scripts() {
  local script
  for script in "$REPO_DIR"/bin/*; do
    [[ -f "$script" && -x "$script" ]] && basename "$script"
  done
}

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
