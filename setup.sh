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
#                            neovim, git, claude, karabiner, tmux,
#                            ghostty, terminal, pgcli, bin, or the name of one script in
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
# from a clone anywhere. Everything else links from ~/switchboard, which
# the guided setup points at this clone.
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$HOME/switchboard"

case "$(uname -s)" in
  Darwin) OS=macos ;;
  Linux) OS=linux ;;
  *) echo "Unsupported OS: $(uname -s)" >&2; exit 1 ;;
esac
if [[ $OS == macos ]]; then
  LAZYGIT_DIR="$HOME/Library/Application Support/lazygit"
  # Karabiner only exists on macOS.
  PARTS=(lazygit neovim git claude claude_md karabiner tmux ghostty terminal pgcli bin)
else
  LAZYGIT_DIR="$HOME/.config/lazygit"
  PARTS=(lazygit neovim git claude claude_md tmux ghostty terminal pgcli bin)
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
# What a slow step is doing, said before it starts, dimmed, so a long silence
# (a download, npm ci, a plugin fetch) doesn't read as setup stuck. Never with
# --check, which does none of them.
working() {
  $CHECK && return 0
  if [[ -n $header ]]; then
    echo "$indent$header"
    header=""
  fi
  printf '%s  \033[2m%s…\033[0m\n' "$indent" "$1"
}

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

# Switchboard's part of Claude Code's settings, claude/switchboard-settings.json
# (the hooks that run agent-state.sh, the statusline, and what its skills and
# loops run and read without asking), merged into your own
# ~/.claude/settings.json, which stays yours: Claude Code writes /model and
# "always allow" there, and nothing else in it is touched. Its hooks replace
# any hook running the same command, the statusline takes the place of none
# or of an older one of Switchboard's, and its permissions are added to yours,
# so running it again changes nothing. A settings file that is a link into
# this repo, as the whole setup made one before, becomes your own file with
# what it held first. Claude Code has no file it reads after yours, so this is
# the user layer for Claude: your own settings are the file itself.
claude_settings() {
  local file=~/.claude/settings.json current merged
  if [[ -L $file && $(readlink "$file") == */claude/settings.json ]]; then
    $CHECK || { cp -L "$file" "$file.tmp" && mv "$file.tmp" "$file"; } || return 1
    change "make $file your own, from the one it linked to"
  fi
  if [[ -e $file ]]; then
    current=$(jq . "$file") || { echo "$indent  $file isn't JSON; left alone" >&2; return 1; }
  else
    current={}
  fi
  merged=$(jq --slurpfile p "$SRC/claude/switchboard-settings.json" '
    $p[0] as $p
    | [$p.hooks[][].hooks[].command] as $ours
    | .hooks = (((.hooks // {}) | map_values(map(.hooks |= map(select(.command as $c | $ours | index($c) | not))) | map(select(.hooks | length > 0))))
        as $mine | reduce ($p.hooks | keys[]) as $k ($mine; .[$k] = ((.[$k] // []) + $p.hooks[$k])) | with_entries(select(.value | length > 0)))
    | if ((.statusLine.command // "statusline-command.sh") | contains("statusline-command.sh")) then .statusLine = $p.statusLine else . end
    | .permissions.allow = ((.permissions.allow // []) + ($p.permissions.allow - (.permissions.allow // [])))
    | .permissions.deny = ((.permissions.deny // []) + ($p.permissions.deny - (.permissions.deny // [])))
  ' <<<"$current") || return 1
  [[ $merged == "$current" ]] && return 0
  if ! $CHECK; then
    [[ -e $file ]] && { cp "$file" "$file.bak.$(date +%Y%m%d%H%M%S)" || return 1; }
    printf '%s\n' "$merged" >"$file.tmp" && mv "$file.tmp" "$file" || return 1
  fi
  change "add Switchboard's hooks, statusline and permissions to $file"
}

# Your ~/.claude/CLAUDE.md: your own rules and Switchboard's part
# (claude/switchboard.md: the tabs, the notes app, repository skills). Your
# rules come from where ~/.config/switchboard/claude.json says, a git
# repository ({"repo": "<url>", "file": "CLAUDE.md"}, cloned into
# ~/.local/share/switchboard/claude-md and pulled on every run, fast-forward
# only) or a file ({"path": "~/somewhere/CLAUDE.md"}), else
# ~/.config/switchboard/CLAUDE.md when there is one. Then ~/.claude/CLAUDE.md
# is a short file importing both, which Claude Code follows (@path), so an edit
# to either shows at once; a real file in its way that isn't one of these is
# moved aside first. With no rules named, a CLAUDE.md of your own gets only the
# line importing Switchboard's part, and a missing one is made with it. A link
# into this repo's claude/CLAUDE.md (the whole setup, from before) is left
# alone until rules are named.
SWITCHBOARD_MD="@~/switchboard/claude/switchboard.md"
WRITTEN_MARK="<!-- Written by Switchboard's setup.sh: your rules, then Switchboard's. Edit them where they live, not here. -->"
claude_md() {
  local file=~/.claude/CLAUDE.md config=~/.config/switchboard/claude.json clone=~/.local/share/switchboard/claude-md
  local repo mine="" want backup
  repo=$(jq -r '.repo // empty' "$config" 2>/dev/null)
  if [[ -n $repo ]]; then
    # A clone of another repository, from before the setting changed, is
    # moved aside rather than pulled.
    if [[ -d $clone/.git && $(git -C "$clone" remote get-url origin 2>/dev/null) != "$repo" ]]; then
      backup="$clone.bak.$(date +%Y%m%d%H%M%S)"
      $CHECK || mv "$clone" "$backup" || return 1
      change "move the clone of your CLAUDE.md's old repository aside to $backup"
    fi
    if [[ ! -d $clone/.git ]] || { $CHECK && [[ -n $backup ]]; }; then
      if ! $CHECK; then
        mkdir -p "${clone%/*}" && git clone --quiet "$repo" "$clone" || { echo "  could not clone $repo for your CLAUDE.md" >&2; return 1; }
      fi
      change "clone your CLAUDE.md's repository"
    elif ! $CHECK; then
      git -C "$clone" pull --quiet --ff-only 2>/dev/null || echo "  could not update your CLAUDE.md's repository: git -C $clone pull --ff-only" >&2
    fi
    mine="$clone/$(jq -r '.file // "CLAUDE.md"' "$config")"
  else
    mine=$(jq -r '.path // empty' "$config" 2>/dev/null)
    mine=${mine/#\~/$HOME}
    [[ -z $mine && -f ~/.config/switchboard/CLAUDE.md ]] && mine=~/.config/switchboard/CLAUDE.md
  fi
  if [[ -n $mine ]]; then
    want=$(printf '%s\n\n@%s\n%s' "$WRITTEN_MARK" "${mine/#$HOME/~}" "$SWITCHBOARD_MD")
    [[ ! -L $file && $(cat "$file" 2>/dev/null) == "$want" ]] && return 0
    if [[ -e $file && ! -L $file ]] && ! grep -qF "$WRITTEN_MARK" "$file"; then
      backup="$file.bak.$(date +%Y%m%d%H%M%S)"
      $CHECK || mv "$file" "$backup" || return 1
      change "move your ~/.claude/CLAUDE.md aside to $backup"
    fi
    if ! $CHECK; then
      mkdir -p ~/.claude && rm -f "$file" && printf '%s\n' "$want" >"$file" || return 1
    fi
    change "write ~/.claude/CLAUDE.md to import your rules (${mine/#$HOME/~}) and Switchboard's"
  elif [[ -L $file ]]; then
    return 0
  elif [[ -f $file ]]; then
    grep -qxF "$SWITCHBOARD_MD" "$file" && return 0
    $CHECK || printf '\n%s\n' "$SWITCHBOARD_MD" >>"$file" || return 1
    change "add the line importing Switchboard's part to your ~/.claude/CLAUDE.md"
  else
    $CHECK || { mkdir -p ~/.claude && printf '%s\n' "$SWITCHBOARD_MD" >"$file"; } || return 1
    change "make ~/.claude/CLAUDE.md, importing Switchboard's part"
  fi
}

# The CLAUDE.md step alone, as mission control's Settings runs it when you
# change where your rules come from.
part_claude_md() { claude_md; }

part_claude() {
  dir ~/.claude
  claude_md || return 1
  claude_settings || return 1
  put_link "$SRC/claude/statusline-command.sh" ~/.claude/statusline-command.sh
  put_link "$SRC/claude/otel-headers.sh" ~/.claude/otel-headers.sh
  put_link "$SRC/claude/commands" ~/.claude/commands
  # One link per skill rather than one for the directory: Claude Code keeps its
  # own synced/ folder in ~/.claude/skills, so that path has to stay real.
  dir ~/.claude/skills
  # Every skill, review-loop and ci-loop included: a repository can define its
  # own of those, and a personal skill wins over a project one of the same
  # name, so each of the two starts by reading and following the repository's
  # copy, in the worktree or its main clone, when there is one.
  local skill hook
  for skill in "$SRC"/claude/skills/*/; do
    put_link "${skill%/}" ~/.claude/skills/
  done
  dir ~/.claude/hooks
  for hook in "$SRC"/claude/hooks/*; do
    put_link "$hook" ~/.claude/hooks/
  done
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
    working "fetching the $name tmux plugin"
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
  local platform sum tmp stamp=~/.local/state/switchboard/mermaid-ascii.version
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
  working "downloading mermaid-ascii $MERMAID_ASCII_VERSION"
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

# lib/'s Node packages, pinned in lib/package.json and its lockfile: ical.js,
# for the Calendar view's iCal feed, and turndown, for reading a web page in a
# pane. Installed with npm ci when any installed one isn't its locked version;
# without them, the Calendar view reads only what /today saves and a web page
# can't be read in a pane.
lib_packages() {
  local stale
  stale=$(node -e '
    const lock = require(process.argv[1] + "/package-lock.json");
    const deps = Object.keys(require(process.argv[1] + "/package.json").dependencies);
    const off = deps.filter((d) => { try { return require(process.argv[1] + "/node_modules/" + d + "/package.json").version !== lock.packages["node_modules/" + d].version; } catch { return true; } });
    console.log(off.join(" "));' "$SRC/lib" 2>/dev/null) || stale="its packages"
  [ -z "$stale" ] && return 0
  if $CHECK; then
    change "install lib's Node packages ($stale)"
    return 0
  fi
  working "installing lib's Node packages ($stale), which can take a minute"
  if (cd "$SRC/lib" && npm ci --silent --no-audit --no-fund >/dev/null 2>&1); then
    change "install lib's Node packages ($stale)"
  else
    echo "  could not install lib's Node packages (npm ci in lib); the Calendar view reads only what /today saves" >&2
  fi
}

# tmux.conf and every script it runs, each linked into ~/.config/tmux.
part_tmux() {
  dir ~/.config/tmux
  put_link "$SRC/tmux/tmux.conf" ~/.config/tmux/tmux.conf
  tmux_plugins
  mermaid_ascii
  lib_packages
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

# Option acting as Alt, which every M- key needs, in the terminals you use:
# Ghostty when it is installed (Switchboard's own config does it already; your
# own gets a config-file line reading ghostty/required), and the terminal this
# runs in when it is Terminal or iTerm2, whose default profile is changed
# through `defaults`, so the change goes through macOS's own preferences.
# Other terminals can only be told what to add (terminal_hint).
# The terminal you are in, inside tmux too, where TERM_PROGRAM is tmux's own.
terminal_name() {
  local name=${TERM_PROGRAM:-}
  if [[ $name == tmux || -n ${TMUX:-} ]]; then
    name=$(tmux display -p '#{client_termtype} #{client_termname}' 2>/dev/null)
    [[ -n ${LC_TERMINAL:-} ]] && name="$LC_TERMINAL $name"
  fi
  [[ -n ${KITTY_WINDOW_ID:-} ]] && name="kitty"
  [[ -n ${ALACRITTY_WINDOW_ID:-} || -n ${ALACRITTY_SOCKET:-} ]] && name="alacritty"
  case $(printf '%s' "$name" | tr 'A-Z' 'a-z') in
    *ghostty*) echo ghostty ;;
    *apple_terminal*) echo terminal ;;
    *iterm*) echo iterm ;;
    *wezterm*) echo wezterm ;;
    *kitty*) echo kitty ;;
    *alacritty*) echo alacritty ;;
    *) echo other ;;
  esac
}

# A terminal setup.sh can't change: what to add to its config, or nothing.
terminal_hint() {
  case $(terminal_name) in
    wezterm) echo "WezTerm: add send_composed_key_when_left_alt_is_pressed = false and send_composed_key_when_right_alt_is_pressed = false to your wezterm.lua" ;;
    kitty) echo "kitty: add macos_option_as_alt yes to kitty.conf" ;;
    alacritty) echo "Alacritty: add option_as_alt = \"Both\" under [window] in alacritty.toml" ;;
    other) echo "your terminal: make Option send Alt (Esc+, or \"Option as Meta\")" ;;
  esac
}

# PlistBuddy wants a space in a key escaped.
plist_key() { printf '%s' "${1// /\\ }"; }

# Terminal's default profile: useOptionAsMetaKey.
terminal_app_option() {
  local plist profile at
  plist=$(mktemp) || return 1
  defaults export com.apple.Terminal "$plist" 2>/dev/null || { rm -f "$plist"; return 0; }
  profile=$(/usr/libexec/PlistBuddy -c "Print :Default\ Window\ Settings" "$plist" 2>/dev/null)
  at=":Window\ Settings:$(plist_key "$profile"):useOptionAsMetaKey"
  if [[ -n $profile && $(/usr/libexec/PlistBuddy -c "Print $at" "$plist" 2>/dev/null) != true ]]; then
    if ! $CHECK; then
      /usr/libexec/PlistBuddy -c "Set $at true" "$plist" 2>/dev/null || /usr/libexec/PlistBuddy -c "Add $at bool true" "$plist" || { rm -f "$plist"; return 1; }
      defaults import com.apple.Terminal "$plist" || { rm -f "$plist"; return 1; }
    fi
    change "make Option act as Meta in Terminal's \"$profile\" profile (open a new window, or quit Terminal and open it again)"
  fi
  rm -f "$plist"
}

# iTerm2's default profile: its Option keys send Esc+ (2).
iterm_option() {
  local plist guid i=0 at
  plist=$(mktemp) || return 1
  defaults export com.googlecode.iterm2 "$plist" 2>/dev/null || { rm -f "$plist"; return 0; }
  guid=$(/usr/libexec/PlistBuddy -c "Print :Default\ Bookmark\ Guid" "$plist" 2>/dev/null)
  while /usr/libexec/PlistBuddy -c "Print :New\ Bookmarks:$i" "$plist" >/dev/null 2>&1; do
    if [[ $(/usr/libexec/PlistBuddy -c "Print :New\ Bookmarks:$i:Guid" "$plist" 2>/dev/null) == "$guid" ]]; then
      at=":New\ Bookmarks:$i"
      if [[ $(/usr/libexec/PlistBuddy -c "Print $at:Option\ Key\ Sends" "$plist" 2>/dev/null) != 2 || $(/usr/libexec/PlistBuddy -c "Print $at:Right\ Option\ Key\ Sends" "$plist" 2>/dev/null) != 2 ]]; then
        if ! $CHECK; then
          local key
          for key in "Option\ Key\ Sends" "Right\ Option\ Key\ Sends"; do
            /usr/libexec/PlistBuddy -c "Set $at:$key 2" "$plist" 2>/dev/null || /usr/libexec/PlistBuddy -c "Add $at:$key integer 2" "$plist" || { rm -f "$plist"; return 1; }
          done
          defaults import com.googlecode.iterm2 "$plist" || { rm -f "$plist"; return 1; }
        fi
        change "make both Option keys send Esc+ in iTerm2's default profile (quit iTerm2 and open it again)"
      fi
      break
    fi
    i=$((i + 1))
  done
  rm -f "$plist"
}

part_terminal() {
  local config=~/.config/ghostty/config line
  # Ghostty: Switchboard's own config sets it; your own gets a line reading
  # ghostty/required, unless it sets Option as Alt itself.
  line="config-file = ?~/switchboard/ghostty/required"
  if [[ -e $config && ! -L $config ]] && ! grep -qE '^\s*macos-option-as-alt\s*=\s*(true|left|right)' "$config" && ! grep -qxF "$line" "$config"; then
    $CHECK || printf '\n# Switchboard: Option as Alt, which its M- keys need (ghostty/required).\n%s\n' "$line" >>"$config" || return 1
    change "add Switchboard's key settings to your Ghostty config (restart Ghostty, or reload its config)"
  fi
  case $(terminal_name) in
    terminal) terminal_app_option || return 1 ;;
    iterm) iterm_option || return 1 ;;
  esac
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

# The rename from editor-configs: a clone set up as ~/editor-configs gets
# ~/switchboard linked to it, so the links made from ~/switchboard, and every
# script that runs from there, work without moving it, and the settings and
# state folders take their new names. Never with --check, never over anything
# already there, and only once: after it, there is nothing left to do.
renamed() {
  $CHECK && return 0
  if [[ ! -e $SRC && ! -L $SRC && $(cd "$HOME/editor-configs" 2>/dev/null && pwd -P) == "$(cd "$REPO_DIR" && pwd -P)" ]]; then
    ln -s "$REPO_DIR" "$SRC" && echo "Linked ~/switchboard to $REPO_DIR, the clone at ~/editor-configs."
  fi
  local pair old new
  for pair in .config/editor-configs:.config/switchboard .local/state/editor-configs:.local/state/switchboard; do
    old=$HOME/${pair%%:*} new=$HOME/${pair#*:}
    if [[ -d $old && ! -e $new ]]; then
      mkdir -p "${new%/*}" && mv "$old" "$new" && echo "Moved ~/${pair%%:*} to ~/${pair#*:}."
    fi
  done
}
renamed

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

# git-delta draws lazygit's diffs, and ripgrep is Telescope's live grep.
PACKAGES=(tmux jq fzf gh glow lazygit neovim git-delta ripgrep)
# Each package's command, where it isn't the package's name.
command_of() {
  case $1 in
    neovim) echo nvim ;;
    git-delta) echo delta ;;
    ripgrep) echo rg ;;
    *) echo "$1" ;;
  esac
}
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
  # Enter is yes, as in every yes/no question here; a closed input is no.
  read -rp "    $1 [Y/n] " answer || return 1
  [[ -z $answer || $answer == [yY]* ]]
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

# Everything links to and runs from ~/switchboard, so a clone elsewhere is
# linked there.
if [[ $(cd "$SRC" 2>/dev/null && pwd -P) == "$(cd "$REPO_DIR" && pwd -P)" ]]; then
  ok "the repo is at ~/switchboard"
elif [[ -e $SRC ]]; then
  todo "~/switchboard is something else; move it aside, then run this again"
  exit 1
elif ask "Link ~/switchboard to $REPO_DIR?"; then
  ln -s "$REPO_DIR" "$SRC" && ok "linked ~/switchboard to $REPO_DIR"
else
  todo "the repo at ~/switchboard (ln -s '$REPO_DIR' ~/switchboard)"
fi

if command -v brew >/dev/null; then
  ok "Homebrew"
  missing=()
  for package in "${PACKAGES[@]}"; do
    command -v "$(command_of "$package")" >/dev/null || missing+=("$package")
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

# nvm's own installer, at a pinned release, adds it to ~/.zshrc; then the
# current LTS Node through it.
NVM_VERSION=v0.40.3
if in_zsh 'command -v node' >/dev/null; then
  ok "Node $(in_zsh 'node --version')"
elif ask "Install nvm $NVM_VERSION (it adds itself to ~/.zshrc) and Node's LTS release?"; then
  working "installing nvm and Node, which takes a minute"
  if curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/$NVM_VERSION/install.sh" | PROFILE=~/.zshrc bash >/dev/null &&
    in_zsh 'nvm install --lts' >/dev/null && in_zsh 'command -v node' >/dev/null; then
    ok "installed Node $(in_zsh 'node --version') through nvm"
  else
    todo "Node through nvm: https://github.com/nvm-sh/nvm, then nvm install --lts"
  fi
else
  todo "Node in an interactive zsh, through nvm: https://github.com/nvm-sh/nvm, then nvm install --lts"
fi

# The font Ghostty's config names, with the icons Neovim and the status line
# draw: powerlevel10k's MesloLGS NF, pinned to a commit and checked against
# its checksums, into ~/Library/Fonts.
FONT_COMMIT=145eb9fbc2f42ee408dacd9b22d8e6e0e553f83d
font_sha256() {
  case $1 in
    Regular) echo d97946186e97f8d7c0139e8983abf40a1d2d086924f2c5dbf1c29bd8f2c6e57d ;;
    Bold) echo b6c0199cf7c7483c8343ea020658925e6de0aeb318b89908152fcb4d19226003 ;;
    Italic) echo 6f357bcbe2597704e157a915625928bca38364a89c22a4ac36e7a116dcd392ef ;;
    "Bold Italic") echo 56b4131adecec052c4b324efb818dd326d586dbc316fc68f98f1cae2eb8d1220 ;;
  esac
}
install_font() {
  local style file tmp
  tmp=$(mktemp -d)
  for style in Regular Bold Italic "Bold Italic"; do
    file="MesloLGS NF $style.ttf"
    curl -fsSL -o "$tmp/$file" "https://github.com/romkatv/powerlevel10k-media/raw/$FONT_COMMIT/${file// /%20}" &&
      echo "$(font_sha256 "$style")  $tmp/$file" | shasum -a 256 -c --quiet - || { rm -rf "$tmp"; return 1; }
  done
  mkdir -p ~/Library/Fonts && cp "$tmp"/*.ttf ~/Library/Fonts/
  rm -rf "$tmp"
}
if [[ -f ~/Library/Fonts/"MesloLGS NF Regular.ttf" || -f /Library/Fonts/"MesloLGS NF Regular.ttf" ]]; then
  ok "the MesloLGS NF font"
elif ask "Install the MesloLGS NF font, for Ghostty and Neovim's icons?"; then
  working "downloading the font"
  install_font && ok "installed the MesloLGS NF font" || todo "the MesloLGS NF font, from https://github.com/romkatv/powerlevel10k-media"
else
  todo "the MesloLGS NF font, from https://github.com/romkatv/powerlevel10k-media"
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

# The terminal it is set up for: Ghostty passes Option through as Alt, which
# every M- key needs, and draws 24-bit color; its config also carries the
# theme theme.sh switches and the font above. Another terminal works when it
# does both, so this is offered rather than required.
ghostty_installed() { [[ -d /Applications/Ghostty.app || -d ~/Applications/Ghostty.app ]] || command -v ghostty >/dev/null; }
if ! ghostty_installed; then
  optional "Ghostty, the terminal this is set up for: brew install --cask ghostty, then ./setup.sh again. Another terminal needs Option sending Alt (Esc+) and 24-bit color."
elif (( $(pending ghostty) == 0 )); then
  ok "Ghostty's config"
elif ask "Link Ghostty's config (Option as Alt, 24-bit color, the theme and font)? Yours is moved aside, not deleted."; then
  apply ghostty && ok "linked Ghostty's config; restart Ghostty to use it" || todo "./setup.sh ghostty failed"
else
  optional "Ghostty's config, for Option as Alt and the theme: ./setup.sh ghostty"
fi

# Option as Alt in the terminals you use (part_terminal): Ghostty with a
# config of your own, Terminal and iTerm2 are changed after asking; another
# terminal is told the line to add.
if (( $(pending terminal) > 0 )); then
  if ask "Make Option act as Alt in your terminal, which every M- key needs?"; then
    apply terminal && ok "Option acts as Alt; restart your terminal for it to take" || todo "./setup.sh terminal failed"
  else
    optional "Option as Alt, which every M- key needs: ./setup.sh terminal"
  fi
elif [[ -n $(terminal_hint) ]]; then
  optional "Option as Alt, which every M- key needs, in $(terminal_hint)"
else
  ok "Option acts as Alt in your terminal"
fi

# diffview (M-d) and the notes app need the plugins lazy.nvim installs.
if [[ -d ~/.local/share/nvim/lazy/diffview.nvim ]]; then
  ok "Neovim's plugins"
elif command -v nvim >/dev/null && [[ -L ~/.config/nvim ]] && ask "Install Neovim's plugins at their pinned commits?"; then
  working "installing Neovim's plugins, which takes a minute"
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
# /shape files tickets in the team named here.
if [[ -n $(jq -r '.linearTeam // empty' ~/.config/worktree-from-ticket/config.json 2>/dev/null) ]]; then
  ok "the Linear team for /shape"
else
  optional "the Linear team /shape files tickets in: add \"linearTeam\": \"<team key>\" to ~/.config/worktree-from-ticket/config.json"
fi

# Without these hooks every tab shows idle, and M-a has nothing to walk. Only
# Switchboard's part of the settings is merged into your own (see
# claude_settings): the hooks, the statusline (which gives the sidebar each
# session's context use) and the permissions its loops need.
# The whole setup is on when its commands are linked (CLAUDE.md no longer is).
whole_claude() { [[ $(readlink ~/.claude/commands 2>/dev/null) == */claude/commands ]]; }
claude_md_pending() (
  CHECK=true
  changes=0
  claude_md >/dev/null 2>&1
  echo "$changes"
)
claude_settings_pending() (
  CHECK=true
  changes=0
  claude_settings >/dev/null 2>&1
  echo "$changes"
)
if whole_claude; then
  if (( $(pending claude) == 0 )); then
    ok "Claude Code, with this repo's whole setup"
  elif $CHECK; then
    todo "this repo's Claude Code setup has links to make: ./setup.sh claude"
  else
    apply claude && ok "Claude Code, with this repo's whole setup, newly added skills and hooks linked" || todo "./setup.sh claude failed"
  fi
elif [[ -e ~/.claude/settings.json ]] && (( $(claude_settings_pending) == 0 )); then
  ok "Claude Code's hooks, statusline and permissions (tab states, the sidebar's Needs you, M-a, the loops)"
elif grep -qs 'agent-state.sh' ~/.claude/settings.json && $CHECK; then
  todo "Switchboard's Claude Code settings have changed: ./setup.sh adds them to yours"
elif ! command -v claude >/dev/null; then
  optional "Claude Code, which every tab here runs, for tab states, the sidebar's sessions and M-a: curl -fsSL https://claude.ai/install.sh | bash"
elif grep -qs 'agent-state.sh' ~/.claude/settings.json || ask "Add Switchboard's hooks, statusline and permissions to your ~/.claude/settings.json? Yours are kept, and a copy is left beside it."; then
  mkdir -p ~/.claude
  [[ -e ~/.claude/statusline-command.sh ]] || ln -s "$SRC/claude/statusline-command.sh" ~/.claude/statusline-command.sh
  claude_settings >/dev/null && ok "added Switchboard's Claude Code settings to yours; your old ones are beside them as settings.json.bak.*" ||
    todo "adding Switchboard's settings to ~/.claude/settings.json failed"
else
  optional "Claude Code's hooks, for tab states and M-a: ./setup.sh adds them when you say yes"
fi

# Your CLAUDE.md: your rules, wherever claude.json says, and Switchboard's
# part, imported (claude_md). Part of the whole setup's run above.
if ! whole_claude && command -v claude >/dev/null; then
  if (( $(claude_md_pending) == 0 )); then
    ok "your CLAUDE.md imports Switchboard's part (the tabs, the notes app)"
  elif ask "Add Switchboard's part (how to read the tabs, the notes app) to your ~/.claude/CLAUDE.md, with your own rules from ~/.config/switchboard/claude.json when it names them?"; then
    claude_md >/dev/null && ok "your CLAUDE.md imports Switchboard's part" || todo "./setup.sh claude failed"
  else
    optional "Switchboard's part of CLAUDE.md, for the tabs and the notes app: ./setup.sh claude"
  fi
fi

# Everything in claude/: its owner's skills, commands and hooks,
# linked in place of yours, which is moved aside; settings are merged, not linked.
# Asked only once Claude Code is there, and never assumed.
if whole_claude || ! command -v claude >/dev/null; then
  :
elif ask "Also link this repo's whole Claude Code setup (its owner's skills, commands, hooks)? What it replaces is moved aside, not deleted; your settings and CLAUDE.md are kept."; then
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

# What a few features need beyond the rest, each named for what it unlocks.
if in_zsh 'command -v mmdc' >/dev/null; then
  ok "mermaid-cli (M-p's PR description as an image)"
else
  optional "mermaid-cli, for M-p's PR description as an image: npm install -g @mermaid-js/mermaid-cli"
fi
if command -v ffmpeg >/dev/null; then
  ok "ffmpeg (/deploy-test's videos)"
else
  optional "ffmpeg, for /deploy-test's videos: brew install ffmpeg"
fi
if in_zsh 'command -v codex' >/dev/null; then
  ok "Codex (/review-loop's reviewer)"
else
  optional "Codex, /review-loop's reviewer: npm install -g @openai/codex, then codex login"
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
