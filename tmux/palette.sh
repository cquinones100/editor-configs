#!/usr/bin/env bash

# The M-p palette: an fzf list of every custom binding, by its description.
# Picking one presses its key, so the action runs exactly as the binding does.
#
# Usage: palette.sh
#
# The list is read from tmux, not kept here: every binding tmux.conf gives a
# description with `bind -N` shows up, so a new binding needs a note and
# nothing else. The root table holds only bindings from tmux.conf; the prefix
# table also holds tmux's own, which carry notes too, so from it only the keys
# tmux.conf binds with -N are taken.
#
# The key cannot be pressed from inside the popup, which would swallow it. This
# leaves it in @palette_choice, and the M-p binding presses it once the popup
# has closed.

set -u

# tmux rewrites control characters in its output, tab included, without a
# UTF-8 locale.
export LC_ALL=en_US.UTF-8

prefix=$(tmux show -gv prefix)
conf=~/.config/tmux/tmux.conf

# "<keys>\t<description>", with keys as send-keys -K takes them.
split_note='{ key = $1; $1 = ""; sub(/^ +/, ""); print key "\t" $0 }'

bindings() {
  tmux list-keys -N -T root -P '' | awk "$split_note"

  # list-keys ignores a key argument alongside -N, so the whole prefix table is
  # listed and narrowed to the keys tmux.conf binds there with a note.
  ours=$(grep -oE '^bind -N "[^"]*" [^- ][^ ]*' "$conf" | awk '{ print $NF }' | tr '\n' ' ')
  tmux list-keys -N -T prefix -P '' | awk "$split_note" |
    awk -F'\t' -v prefix="$prefix" -v ours="$ours" '
      BEGIN { n = split(ours, keys, " "); for (i = 1; i <= n; i++) wanted[keys[i]] = 1 }
      $1 in wanted { print prefix " " $1 "\t" $2 }'
}

# tmux spells Shift+letter as the capital letter: Option+Shift+J is M-J and
# Shift+W after the prefix is W. Read that way M-J looks like Option+J, so the
# shown key spells the Shift out (M-S-J, M-b S-W). Only the shown key changes;
# the first field, which is what gets pressed, keeps tmux's own name.
show_key='
  function shown(keys,   n, tokens, i, parts, m, out) {
    n = split(keys, tokens, " ")
    for (i = 1; i <= n; i++) {
      m = split(tokens[i], parts, "-")
      if (parts[m] ~ /^[A-Z]$/) {
        sub(/[A-Z]$/, "S-" parts[m], tokens[i])
      }
      out = out (i > 1 ? " " : "") tokens[i]
    }
    return out
  }'

# The palette itself is left out: picking it would only reopen it.
# Shown as "<description>  <key>", sorted by description, with the key dimmed.
choice=$(
  bindings | awk -F'\t' '$1 != "M-p"' | sort -t$'\t' -k2,2 |
    awk -F'\t' "$show_key"'{ printf "%s\t%-48s \033[38;5;244m%s\033[0m\n", $1, $2, shown($1) }' |
    fzf --ansi --delimiter=$'\t' --with-nth=2 \
      --prompt='action> ' --layout=reverse --border=rounded --height=100% |
    cut -f1
)

[ -n "$choice" ] && tmux set -g @palette_choice "$choice"
exit 0
