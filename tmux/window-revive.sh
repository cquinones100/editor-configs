#!/usr/bin/env bash

# Opens the wt-revive picker, for the M-o popup binding: worktrees no tab has
# open, to reopen one and resume its Claude.
#
# The indirection is about PATH, as with window-jump.sh. The tmux server keeps
# the environment it was started with, and nvm is set up in ~/.zshrc, which
# only interactive shells read — so the server has no node, and wt-revive run
# straight from a binding dies on `env: node: No such file or directory` before
# it prints anything. nvm's default alias names the version to use and costs
# nothing to read.
#
# Usage: window-revive.sh [--list] [dir]   (dir defaults to $PWD)

set -u

if ! command -v node >/dev/null 2>&1; then
  NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  default=$(cat "$NVM_DIR/alias/default" 2>/dev/null)
  candidate="$NVM_DIR/versions/node/v${default#v}/bin"

  if [ -n "$default" ] && [ -x "$candidate/node" ]; then
    export PATH="$candidate:$PATH"
  elif [ -s "$NVM_DIR/nvm.sh" ]; then
    # The slow path, for a default alias that names no installed version.
    . "$NVM_DIR/nvm.sh" >/dev/null 2>&1
  fi
fi

# A popup that closes the instant something goes wrong reads as a flicker, so
# anything that failed (or found nothing to reopen) stays on screen to be read.
# Cancelling the picker exits cleanly and closes it, which is what Esc means.
if ! ~/.local/bin/wt-revive "$@"; then
  printf '\nPress any key to close.'
  read -r -n 1 -s
fi
