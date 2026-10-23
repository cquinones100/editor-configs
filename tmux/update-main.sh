#!/usr/bin/env bash
# Popup for the M-p palette's "Update local main to origin's": runs
# bin/update-main for the focused pane's repository (the binding's -d) and
# keeps the popup open until a key, so what it did can be read. Through an
# interactive zsh, for the PATH (node, ~/.local/bin) the tmux server lacks.
#
# Usage: update-main.sh   (in the pane's directory)

printf '\n'
zsh -i -c 'update-main "$1"' update-main "$PWD" 2>&1 | sed 's/^/  /'
printf '\n  \033[38;5;244mPress any key to close.\033[0m'
read -rsn 1
