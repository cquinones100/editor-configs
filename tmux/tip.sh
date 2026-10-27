#!/usr/bin/env bash
# Tips: a small box in the top-right corner that teaches a key the moment it
# would help, each tip once. Any key closes it, and that key goes on to tmux
# as if the box hadn't been there, so nothing typed is lost; left alone, it
# closes after a few seconds.
#
# Usage:
#   tip.sh show <tip> [<client>]   show a tip, unless it has been shown or the
#                                  tips setting is off; on <client>, or the
#                                  client used last
#   tip.sh seen <tip>              mark it shown without showing it (doing what
#                                  a tip teaches, such as pressing M-a, does)
#   tip.sh load                    mark the tips shown before, at tmux start
#   tip.sh reset                   show every tip again
#   tip.sh box <tip> <client>      the popup itself
#
# What was shown is kept in ~/.local/state/editor-configs/tips, one name a
# line, and as @tip_seen_<tip> options, so a hook can skip a tip with a
# format and start nothing once it has been shown.

set -u

SEEN=~/.local/state/editor-configs/tips
SHOW_SECONDS=8
FOOTER="any key closes · tips are in Settings"

text_of() {
  case $1 in
    waiting) printf '%s\n' "A tab is waiting on you." "" "M-a  jump to it, then to each tab" "     that needs you after it" ;;
    jump) printf '%s\n' "Lots of tabs?" "" "M-j  find one by typing its name" "M-a  go to whichever needs you" ;;
    in-place) printf '%s\n' "This took your pane's place." "" "Quit it, or press the same key" "again, and your pane comes back." ;;
    *) return 1 ;;
  esac
}

mark() {
  mkdir -p "${SEEN%/*}"
  grep -qx "$1" "$SEEN" 2>/dev/null || echo "$1" >>"$SEEN"
  tmux set -g "@tip_seen_$1" 1
}

# The key read from the box, in tmux's own names, for send-keys -K: Escape
# and a character is Alt with it, an escape sequence an arrow or such.
key_name() {
  local bytes=$1 first=${1:0:1} rest=${1:1}
  case $bytes in
    $'\x1b[A') echo Up ;; $'\x1b[B') echo Down ;; $'\x1b[C') echo Right ;; $'\x1b[D') echo Left ;;
    $'\x1b[H') echo Home ;; $'\x1b[F') echo End ;; $'\x1b[Z') echo BTab ;;
    $'\x1b') echo Escape ;;
    $'\r' | $'\n') echo Enter ;;
    $'\t') echo Tab ;;
    $'\x7f') echo BSpace ;;
    ' ') echo Space ;;
    *)
      if [ "$first" = $'\x1b' ] && [ ${#rest} -eq 1 ]; then
        echo "M-$(key_name "$rest")"
      elif [ ${#bytes} -eq 1 ] && [[ $bytes < ' ' ]]; then
        printf 'C-%b\n' "\\x$(printf '%x' $(( $(printf '%d' "'$bytes") + 96 )))"
      elif [ ${#bytes} -eq 1 ]; then
        printf '%s\n' "$bytes"
      fi
      ;;
  esac
}

case "${1:-}" in
  show)
    tip=${2:-}
    text_of "$tip" >/dev/null || exit 0
    IFS='|' read -r tips seen < <(tmux display -p "#{@setting_tips}|#{@tip_seen_$tip}" 2>/dev/null)
    [ "${tips:-}" = off ] || [ "${seen:-}" = 1 ] && exit 0
    client=${3:-$(tmux list-clients -F '#{client_activity} #{client_name}' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2-)}
    [ -n "$client" ] || exit 0
    mark "$tip"
    # Wide enough for its longest line and the footer, and tall enough for
    # its lines, the footer and the border.
    lines=$(text_of "$tip" | wc -l)
    width=$(( $( { text_of "$tip"; echo "$FOOTER"; } | awk '{ if (length > n) n = length } END { print n }') + 4 ))
    tmux display-popup -c "$client" -E -x R -y 0 -w "$width" -h $(( lines + 4 )) -b rounded -T ' tip ' "$0 box $(printf '%q %q' "$tip" "$client")"
    ;;
  seen) [ -n "${2:-}" ] && mark "$2" ;;
  load)
    [ -f "$SEEN" ] || exit 0
    while read -r tip; do
      [[ $tip =~ ^[a-z-]+$ ]] && tmux set -g "@tip_seen_$tip" 1
    done <"$SEEN"
    ;;
  reset)
    rm -f "$SEEN"
    tmux show-options -g 2>/dev/null | awk '/^@tip_seen_/ { print $1 }' | while read -r option; do tmux set -gu "$option"; done
    ;;
  box)
    tip=${2:-} client=${3:-}
    printf '\033[?25l'
    text_of "$tip" | sed 's/^/ /'
    printf '\n \033[38;5;244m%s\033[0m' "$FOOTER"
    IFS= read -rsn 1 -t "$SHOW_SECONDS" first || exit 0
    # What else the key sent, as an arrow or Alt sends several bytes at once.
    keys=$first
    while IFS= read -rsn 1 -t 0.02 more; do keys+=$more; done
    [ -z "$first" ] && keys=$'\r'
    name=$(key_name "$keys")
    # Sent by tmux a moment after the box has closed, so the key reaches what
    # was under it, a binding included. ## keeps a # from being read as a format.
    [ -n "$name" ] && [ -n "$client" ] &&
      tmux run-shell -b -d 0.1 "tmux send-keys -K -c $(printf %q "$client") $(printf %q "$name" | sed 's/#/##/g')"
    ;;
esac
exit 0
