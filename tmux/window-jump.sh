#!/usr/bin/env bash

# Opens the wt-jump picker, for the M-j popup binding.
#
# The indirection is about PATH. The tmux server keeps the environment it was
# started with, and nvm is set up in ~/.zshrc, which only interactive shells
# read — so the server has no node. wt-jump is a node script, so run straight
# from a binding it dies on `env: node: No such file or directory` before it
# prints anything, and the popup closes so fast it reads as a flicker.
#
# Sourcing an interactive shell would fix it and cost over a second per popup.
# nvm's default alias names the version to use and costs nothing to read.

set -u

if ! command -v node >/dev/null 2>&1; then
  NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  default=$(cat "$NVM_DIR/alias/default" 2>/dev/null)
  candidate="$NVM_DIR/versions/node/v${default#v}/bin"

  if [ -n "$default" ] && [ -x "$candidate/node" ]; then
    export PATH="$candidate:$PATH"
  elif [ -s "$NVM_DIR/nvm.sh" ]; then
    # The slow path, for a default alias that names no installed version.
    # nvm's own answer to which version is current, at a third of a second.
    . "$NVM_DIR/nvm.sh" >/dev/null 2>&1
  fi
fi

# A popup that closes the instant something goes wrong is the flicker this
# script exists to stop, so anything that failed stays on screen to be read.
# Cancelling the picker exits cleanly and closes it, which is what Esc means.
if ! ~/.local/bin/wt-jump "$@"; then
  printf '\nPress any key to close.'
  read -r -n 1 -s
fi
