#!/usr/bin/env bash
# Replaced by setup.sh, which takes the same part names (./setup.sh tmux bin)
# and runs the guided setup with none. Kept for a while so a clone that
# updates past this, and old habits, keep working.
exec "$(dirname "${BASH_SOURCE[0]}")/setup.sh" "$@"
