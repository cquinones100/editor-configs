#!/usr/bin/env bash
# Switchboard's one-line install, for someone new:
#
#   curl -fsSL https://raw.githubusercontent.com/cquinones100/switchboard/main/install.sh | bash
#
# It clones main into ~/switchboard, the branch the update popup follows, so
# there are no releases to pick from, then runs the guided ./setup.sh, which
# asks before it installs or changes anything. A clone already there is left
# as it is and set up from. Run through a pipe, its own input is this script,
# so setup.sh's questions are read from the terminal instead.

set -euo pipefail

repo=https://github.com/cquinones100/switchboard.git
dir=${SWITCHBOARD_DIR:-$HOME/switchboard}

if [ "$(uname -s)" != Darwin ]; then
  echo "Switchboard runs on macOS only, for now." >&2
  exit 1
fi
# git comes with Apple's command line tools; asking for it offers to install them.
if ! git --version >/dev/null 2>&1; then
  echo "git isn't installed. Install Apple's command line tools (xcode-select --install), then run this again." >&2
  exit 1
fi

if [ -d "$dir/.git" ]; then
  echo "Switchboard is already in $dir; setting up from it."
elif [ -e "$dir" ]; then
  echo "$dir is there and isn't a Switchboard clone; move it aside and run this again." >&2
  exit 1
else
  git clone --quiet "$repo" "$dir"
  echo "Cloned Switchboard into $dir."
fi

if [ -r /dev/tty ]; then
  exec "$dir/setup.sh" </dev/tty
fi
exec "$dir/setup.sh"
