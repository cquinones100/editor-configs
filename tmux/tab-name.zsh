#!/bin/zsh

# Popup for naming a tab, opened by M-n and by M-t after it creates a window.
# The name goes in the window's @tab_name option, which tab-label.sh puts ahead
# of the ticket and directory in both the tab and the second status line.
#
# Usage: tab-name.zsh <window_id> [optional]
#   optional: say the name can be skipped, for the prompt after M-t
#
# zsh rather than bash for vared, which edits a prefilled line; the bash that
# ships with macOS is too old for `read -i`.

setopt extendedglob

window=$1
name=$(tmux show -wqv -t "$window" @tab_name)

# Esc cancels; KEYTIMEOUT=1 keeps it from waiting for an escape sequence.
KEYTIMEOUT=1
bindkey -e
bindkey '\e' send-break

print
print -P "  %F{244}${2:+Optional. }Enter to save, empty to clear, Esc to cancel%f"
print
vared -p '  Tab name: ' name || exit 0

name=${${name##[[:space:]]#}%%[[:space:]]#}
if [[ -z $name ]]; then
  tmux set -wu -t "$window" @tab_name
else
  tmux set -w -t "$window" @tab_name "$name"
fi

# Rename the tab now rather than on the next pane focus.
"${0:A:h}/window-names.sh" "$(tmux display -p -t "$window" '#{session_name}')"
