#!/usr/bin/env bash

# Sets this repository up on a Mac, and keeps it set up: run it again at any
# time, and it changes only what isn't in place yet.
#
# Usage:
#   ./setup.sh               the guided setup for the tmux workspace (tmux, the
#                            sidebar, the palette, the notes app, Neovim and the
#                            scripts in bin/): checks what it needs, installs
#                            what is missing after asking, links the configs,
#                            and asks about each optional part
#   ./setup.sh <part>...     only those parts, without questions: lazygit,
#                            neovim, git, claude, iterm, karabiner, tmux,
#                            ghostty, pgcli, bin, or the name of one script in
#                            bin/ to link just that one
#   --check                  with either: say what would change, change nothing
#
# Each part says what it changed, or that it was up to date. A link already
# pointing at the right file is left alone, and a real file or directory in
# the way is moved aside to <name>.bak.<time>, never overwritten or deleted.

set -u

CHECK=false
parts=()
for arg in "$@"; do
  if [[ $arg == --check ]]; then CHECK=true; else parts+=("$arg"); fi
done

# Resolved from this script's own location, so one bin script can be linked
# from a clone anywhere. Everything else links from ~/editor-configs, which
# the guided setup points at this clone.
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$HOME/editor-configs"

case "$(uname -s)" in
  Darwin) OS=macos ;;
  Linux) OS=linux ;;
  *) echo "Unsupported OS: $(uname -s)" >&2; exit 1 ;;
esac
if [[ $OS == macos ]]; then
  LAZYGIT_DIR="$HOME/Library/Application Support/lazygit"
  # iTerm and Karabiner only exist on macOS.
  PARTS=(lazygit neovim git claude iterm karabiner tmux ghostty pgcli bin)
else
  LAZYGIT_DIR="$HOME/.config/lazygit"
  PARTS=(lazygit neovim git claude tmux ghostty pgcli bin)
fi

# ── Parts ───────────────────────────────────────────────────────────────────

# Each change is printed under its part's name, which is printed only once
# something changes; `changes` counts them.
# The guided setup indents them under its own list, and leaves out the parts
# that were up to date.
changes=0
header=""
indent=""
quiet=false
change() {
  if [[ -n $header ]]; then
    echo "$indent$header"
    header=""
  fi
  if $CHECK; then echo "$indent  would: $1"; else echo "$indent  $1"; fi
  changes=$((changes + 1))
}
dir() { $CHECK || mkdir -p "$1"; }

# Links $1 at $2, unless it is already linked there. A real file or directory
# already at $2 is moved aside to $2.bak.<time> first, rather than being
# overwritten or deleted. A $2 ending in / is a directory to link into, under
# $1's own name.
put_link() {
  local src=$1 dest=$2 backup
  [[ $dest == */ ]] && dest="$dest$(basename "$src")"
  [[ -L $dest && $(readlink "$dest") == "$src" ]] && return 0
  if [[ -e $dest && ! -L $dest ]]; then
    backup="$dest.bak.$(date +%Y%m%d%H%M%S)"
    $CHECK || mv "$dest" "$backup" || return 1
    change "move $dest aside to $backup"
  fi
  $CHECK || ln -sfn "$src" "$dest" || return 1
  change "link $dest"
}

part_lazygit() {
  dir "$LAZYGIT_DIR"
  put_link "$SRC/lazygit/config.yml" "$LAZYGIT_DIR/config.yml"
}

part_neovim() {
  dir ~/.config
  put_link "$SRC/nvim" ~/.config/nvim
}

# This clone's git setup only. The global ~/.gitconfig isn't managed here: it
# holds a machine's identity and paths, which have no place in a public repo.
# This repo's own hooks, such as the one that keeps machine-specific Claude
# settings out of commits, are set on this clone only, so other repositories
# keep theirs.
part_git() {
  [[ $(git -C "$SRC" config core.hooksPath) == .githooks ]] && return 0
  $CHECK || git -C "$SRC" config core.hooksPath .githooks || return 1
  change "set this clone's core.hooksPath to .githooks"
}

part_claude() {
  dir ~/.claude
  put_link "$SRC/claude/CLAUDE.md" ~/.claude/CLAUDE.md
  put_link "$SRC/claude/settings.json" ~/.claude/settings.json
  put_link "$SRC/claude/statusline-command.sh" ~/.claude/statusline-command.sh
  put_link "$SRC/claude/otel-headers.sh" ~/.claude/otel-headers.sh
  put_link "$SRC/claude/commands" ~/.claude/commands
  # One link per skill rather than one for the directory: Claude Code keeps its
  # own synced/ folder in ~/.claude/skills, so that path has to stay real.
  dir ~/.claude/skills
  # Skills kept here but not installed. review-loop is defined by the repos that
  # use it, and a personal copy beside theirs shows up as a second /review-loop.
  # A leftover link from before it was listed here is removed.
  local unlinked_skills=(review-loop ci-loop) skill name hook
  for skill in "$SRC"/claude/skills/*/; do
    name=$(basename "$skill")
    if [[ " ${unlinked_skills[*]} " == *" $name "* ]]; then
      if [[ -L ~/.claude/skills/$name ]]; then
        $CHECK || rm ~/.claude/skills/"$name"
        change "remove the link to the $name skill, which is kept here but not installed"
      fi
      continue
    fi
    put_link "${skill%/}" ~/.claude/skills/
  done
  dir ~/.claude/hooks
  for hook in "$SRC"/claude/hooks/*; do
    put_link "$hook" ~/.claude/hooks/
  done
}

part_iterm() {
  local dest="$HOME/Library/Application Support/iTerm2/Scripts/AutoLaunch"
  dir "$dest"
  put_link "$SRC/iterm/Scripts/AutoLaunch/session_title.py" "$dest/session_title.py"
}

part_karabiner() {
  dir ~/.config/karabiner
  put_link "$SRC/karabiner/karabiner.json" ~/.config/karabiner/karabiner.json
}

# Installs the tmux plugins listed in tmux/plugins.txt, each at its pinned
# commit. A plugin already there is moved to that commit, fetching it first if
# it is new to the clone. Nothing else is run from the plugin repositories here;
# tmux.conf loads them.
tmux_plugins() {
  local plugins=~/.config/tmux/plugins name url commit
  dir "$plugins"
  while read -r name url commit; do
    [[ $(git -C "$plugins/$name" rev-parse HEAD 2>/dev/null) == "$commit" ]] && continue
    if $CHECK; then
      change "install the $name plugin at ${commit:0:7}"
      continue
    fi
    if [ ! -d "$plugins/$name/.git" ]; then
      git clone --quiet --no-checkout "$url" "$plugins/$name" || { echo "  could not clone $name" >&2; continue; }
    fi
    git -C "$plugins/$name" cat-file -e "$commit^{commit}" 2>/dev/null ||
      git -C "$plugins/$name" fetch --quiet origin "$commit" ||
      { echo "  could not fetch $name at $commit" >&2; continue; }
    git -C "$plugins/$name" -c advice.detachedHead=false checkout --quiet --detach "$commit" &&
      change "install the $name plugin at ${commit:0:7}"
  done < <(grep -vE '^\s*(#|$)' "$SRC/tmux/plugins.txt")
}

# mermaid-ascii, which draws the Mermaid diagrams in M-v's PR view
# (tmux/pr-view.sh), pinned to one release and checked against its checksum
# before it is installed in ~/.local/bin. Updating it means reading what changed
# and putting the new version and checksums here.
MERMAID_ASCII_VERSION=1.6.1
# Its checksums, from the release's checksums.txt. bash 3.2, which macOS has,
# has no associative arrays, hence the case.
mermaid_ascii_sha256() {
  case $1 in
    Darwin_arm64) echo 9b7f7788bd2596437d92856e9a60b7b05ecb5f6f786c8c0b1cb369f742bf8063 ;;
    Darwin_x86_64) echo a0fc7b8dc4f01d0ad0afff16590d63b8a85d157cc957b2a659ffeca617360bdc ;;
  esac
}
mermaid_ascii() {
  local platform sum tmp stamp=~/.local/state/editor-configs/mermaid-ascii.version
  platform="$(uname -s)_$(uname -m | sed 's/aarch64/arm64/')"
  sum=$(mermaid_ascii_sha256 "$platform")
  if [ -z "$sum" ]; then
    echo "  no pinned mermaid-ascii for $platform; M-v shows diagrams as their source" >&2
    return 0
  fi
  # It has no --version, so the version installed is kept beside it.
  [ -x ~/.local/bin/mermaid-ascii ] && [ "$(cat "$stamp" 2>/dev/null)" = "$MERMAID_ASCII_VERSION" ] && return 0
  if $CHECK; then
    change "install mermaid-ascii $MERMAID_ASCII_VERSION"
    return 0
  fi
  tmp=$(mktemp -d)
  if curl -fsSL -o "$tmp/m.tar.gz" "https://github.com/AlexanderGrooff/mermaid-ascii/releases/download/$MERMAID_ASCII_VERSION/mermaid-ascii_$platform.tar.gz" &&
    echo "$sum  $tmp/m.tar.gz" | shasum -a 256 -c --quiet - &&
    tar -xzf "$tmp/m.tar.gz" -C "$tmp" mermaid-ascii &&
    mkdir -p ~/.local/bin "${stamp%/*}" && install -m 755 "$tmp/mermaid-ascii" ~/.local/bin/mermaid-ascii; then
    echo "$MERMAID_ASCII_VERSION" > "$stamp"
    change "install mermaid-ascii $MERMAID_ASCII_VERSION"
  else
    echo "  could not install mermaid-ascii $MERMAID_ASCII_VERSION" >&2
  fi
  rm -rf "$tmp"
}

# tmux.conf and every script it runs, each linked into ~/.config/tmux.
part_tmux() {
  dir ~/.config/tmux
  put_link "$SRC/tmux/tmux.conf" ~/.config/tmux/tmux.conf
  tmux_plugins
  mermaid_ascii
  local file
  for file in "$SRC"/tmux/*.sh "$SRC"/tmux/*.zsh "$SRC"/tmux/*.js "$SRC"/tmux/glow-style.json; do
    put_link "$file" ~/.config/tmux/
  done
  # Keeps resurrect's saves private and few; it changes nothing once they are.
  $CHECK || "$SRC/tmux/resurrect-tidy.sh"
}

part_ghostty() {
  dir ~/.config/ghostty
  put_link "$SRC/ghostty/config" ~/.config/ghostty/config
}

part_pgcli() {
  put_link "$SRC/pgcli/config" ~/.pgclirc
}

part_bin() {
  dir ~/.local/bin
  # Executables only, so docs alongside the scripts don't get linked in.
  local script
  for script in "$SRC"/bin/*; do
    [[ -f $script && -x $script ]] || continue
    put_link "$script" ~/.local/bin/"$(basename "$script")"
  done
}

bin_scripts() {
  local script
  for script in "$REPO_DIR"/bin/*; do
    [[ -f $script && -x $script ]] && basename "$script"
  done
}

failed=()
run_part() {
  local name=$1 before=$changes
  header="$name:"
  if printf '%s\n' "${PARTS[@]}" | grep -qx "$name"; then
    "part_$name" || failed+=("$name")
  else
    dir ~/.local/bin
    put_link "$REPO_DIR/bin/$name" ~/.local/bin/"$name" || failed+=("$name")
  fi
  (( changes == before )) && ! $quiet && echo "$name: up to date"
  header=""
}

if (( ${#parts[@]} )); then
  for part in "${parts[@]}"; do
    if ! printf '%s\n' "${PARTS[@]}" | grep -qx "$part" && [[ ! -f $REPO_DIR/bin/$part ]]; then
      echo "Unknown part: $part" >&2
      echo "  parts: ${PARTS[*]}" >&2
      echo "  bin scripts: $(bin_scripts | tr '\n' ' ')" >&2
      exit 1
    fi
  done
  for part in "${parts[@]}"; do
    run_part "$part"
  done
  if (( ${#failed[@]} )); then
    echo "" >&2
    echo "Failed: ${failed[*]}" >&2
    exit 1
  fi
  exit 0
fi

# ── The guided setup ────────────────────────────────────────────────────────

PACKAGES=(tmux jq fzf gh glow lazygit neovim)
# The oldest tmux this has been used with.
TMUX_MIN=3.8
# The parts the tmux workspace needs.
WORKSPACE=(tmux neovim lazygit bin)

# What is left is listed again at the end, so it needn't be found among the
# ticks; the git hooks after a pull print only that list.
left=()
problems=0
ok() { echo "  ✓ $1"; }
todo() { echo "  ✗ $1"; left+=("$1"); problems=$((problems + 1)); }
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
# How many changes the parts named would make, changing nothing.
pending() (
  CHECK=true
  changes=0
  for part in "$@"; do "part_$part" >/dev/null 2>&1; done
  echo "$changes"
)
# Runs the parts named, their changes indented under this list.
apply() {
  local part
  indent="    "
  quiet=true
  for part in "$@"; do run_part "$part"; done
  indent=""
  quiet=false
  (( ${#failed[@]} == 0 ))
}

echo "Required"

if [[ $OS == macos ]]; then
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
if [[ $(cd "$SRC" 2>/dev/null && pwd -P) == "$(cd "$REPO_DIR" && pwd -P)" ]]; then
  ok "the repo is at ~/editor-configs"
elif [[ -e $SRC ]]; then
  todo "~/editor-configs is something else; move it aside, then run this again"
  exit 1
elif ask "Link ~/editor-configs to $REPO_DIR?"; then
  ln -s "$REPO_DIR" "$SRC" && ok "linked ~/editor-configs to $REPO_DIR"
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

# The links, the pinned tmux plugins and mermaid-ascii, and the scripts. Asked
# the first time, since it moves aside any tmux or Neovim config already
# there; once tmux.conf is linked, whatever was added since is linked without
# asking.
count=$(pending "${WORKSPACE[@]}")
if (( count == 0 )); then
  ok "the configs are linked"
elif $CHECK; then
  todo "$count link(s) or installs to make: ./setup.sh ${WORKSPACE[*]}"
elif [[ -L ~/.config/tmux/tmux.conf ]] || ask "Link the tmux, Neovim and lazygit configs and the scripts in bin/? Any config of yours in the way is moved aside, not deleted."; then
  apply "${WORKSPACE[@]}" && ok "linked the configs" || todo "./setup.sh ${WORKSPACE[*]} failed"
else
  todo "./setup.sh ${WORKSPACE[*]}"
fi

# The shell functions that move a tab into a worktree, which the palette's
# popups type into a new tab and /wt runs: only a function can cd the shell.
# Each comes from its script's `init zsh`, so ~/.zshrc evals that, and only the
# ones it doesn't define yet are added.
worktree_functions=(wt:worktree-from-ticket wtpr:worktree-from-pr wtr:worktree-resume wtb:worktree-from-branch)
undefined=()
for pair in "${worktree_functions[@]}"; do
  [[ $(in_zsh "whence -w ${pair%%:*}") == *function ]] || undefined+=("$pair")
done
if (( ${#undefined[@]} == 0 )); then
  ok "the wt, wtpr, wtr and wtb functions"
elif ask "Add ${undefined[*]%%:*} to ~/.zshrc, from their scripts' init?"; then
  for pair in "${undefined[@]}"; do
    echo "eval \"\$(${pair#*:} init zsh)\"" >> ~/.zshrc
  done
  ok "added ${undefined[*]%%:*} to ~/.zshrc"
else
  todo "${undefined[*]%%:*} in ~/.zshrc: eval \"\$(<script> init zsh)\" for each"
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

# Without these hooks every tab shows idle, and M-a has nothing to walk. Only
# the hooks that run agent-state.sh are added to your own settings, beside
# what is there, and the statusline (which gives the sidebar each session's
# context use) only when you have none: the rest of claude/settings.json is
# its owner's.
whole_claude() { [[ -L ~/.claude/settings.json && $(readlink ~/.claude/settings.json) == */editor-configs/claude/settings.json ]]; }
if whole_claude; then
  if (( $(pending claude) == 0 )); then
    ok "Claude Code, with this repo's whole setup"
  elif $CHECK; then
    todo "this repo's Claude Code setup has links to make: ./setup.sh claude"
  else
    apply claude && ok "Claude Code, with this repo's whole setup, newly added skills and hooks linked" || todo "./setup.sh claude failed"
  fi
elif grep -qs 'agent-state.sh' ~/.claude/settings.json; then
  ok "Claude Code's hooks (tab states, the sidebar's Needs you, M-a)"
elif ! command -v claude >/dev/null; then
  optional "Claude Code, for tab states, the sidebar's sessions and M-a: https://claude.com/claude-code"
elif ask "Add Claude Code's hooks for tab states and M-a to your ~/.claude/settings.json?"; then
  mkdir -p ~/.claude
  [[ -f ~/.claude/settings.json ]] || echo '{}' > ~/.claude/settings.json
  cp ~/.claude/settings.json ~/.claude/settings.json.bak."$(date +%Y%m%d%H%M%S)"
  [[ -e ~/.claude/statusline-command.sh ]] || ln -s "$SRC/claude/statusline-command.sh" ~/.claude/statusline-command.sh
  merged=$(jq --slurpfile repo "$REPO_DIR/claude/settings.json" '
    ($repo[0].hooks | map_values(
      map(.hooks |= map(select(.command | contains("agent-state.sh")))) | map(select(.hooks | length > 0))
    ) | with_entries(select(.value | length > 0))) as $ours
    | .hooks = reduce ($ours | keys[]) as $k (.hooks // {}; .[$k] = ((.[$k] // []) + $ours[$k]))
    | .statusLine //= $repo[0].statusLine
  ' ~/.claude/settings.json) && printf '%s\n' "$merged" > ~/.claude/settings.json &&
    ok "added Claude Code's hooks; your old settings are beside them as settings.json.bak.*" ||
    todo "adding Claude Code's hooks to ~/.claude/settings.json failed"
else
  optional "Claude Code's hooks, for tab states and M-a: ./setup.sh adds them when you say yes"
fi

# Everything in claude/: its owner's CLAUDE.md, settings (telemetry included),
# skills, commands and hooks, linked in place of yours, which is moved aside.
# Asked only once Claude Code is there, and never assumed.
if whole_claude || ! command -v claude >/dev/null; then
  :
elif ask "Also replace your Claude Code setup with this repo's whole one (CLAUDE.md, settings with its owner's telemetry, skills, commands, hooks)? Yours is moved aside, not deleted."; then
  apply claude && ok "linked this repo's Claude Code setup" || todo "./setup.sh claude failed"
else
  optional "this repo's whole Claude Code setup, skills included: ./setup.sh claude, which replaces yours"
fi

# Only for committing to this clone: its pre-commit hook keeps machine-specific
# Claude settings out of commits.
if (( $(pending git) == 0 )); then
  ok "this clone's git hooks"
elif ask "Use this repo's git hooks in this clone (only matters if you commit to it)?"; then
  apply git && ok "set this clone's git hooks" || todo "./setup.sh git failed"
else
  optional "this clone's git hooks, if you commit to it: ./setup.sh git"
fi

if [[ -f ~/.config/slack-relay/config.json ]]; then
  ok "slack-relay"
else
  optional "slack-relay, to use the tabs from Slack: see slack-relay in bin/README.md"
fi

# A sidebar daemon started before its code last changed keeps running the old
# code, so a pull that adds to it shows nothing until it restarts. Its pid file
# is written as it starts, so a newer file under lib/ means it is stale.
pidfile=~/.local/state/tmux-sidebar/daemon.pid
if ! $CHECK && read -r pid 2>/dev/null <"$pidfile" && kill -0 "$pid" 2>/dev/null &&
  [[ -n $(find "$REPO_DIR/lib" "$REPO_DIR/bin/tmux-sidebar" -newer "$pidfile" -print -quit 2>/dev/null) ]]; then
  kill "$pid"
  for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$pid" 2>/dev/null || break; sleep 0.2; done
  ~/.config/tmux/sidebar.sh start && ok "restarted the sidebar daemon, for its new code"
fi

echo ""
if (( problems )); then
  echo "Left to do:"
  printf '  ✗ %s\n' "${left[@]}"
  echo "Run ./setup.sh again once they're done."
  exit 1
fi
if [[ -n ${TMUX:-} ]]; then
  $CHECK || tmux source-file ~/.config/tmux/tmux.conf
  echo "Ready."
else
  echo "Ready. Start tmux with: tmux"
fi
