#!/bin/zsh -f

# The client every sidebar pane and the mission control popup run: it shows
# what bin/tmux-sidebar's daemon draws and sends it the keys you press.
#
# Usage: sidebar-pane.zsh sidebar <socket>
#        sidebar-pane.zsh mission <socket> <tmux client>
#
# Built from zsh's own modules (sockets, select, raw reads and writes) so each
# sidebar is one small process that starts no others, however long it runs:
# there is one in every window, and a security agent on this Mac inspects
# every process that starts. A sidebar whose daemon goes away reconnects to
# the next one, starting it if need be; mission control closes instead.

zmodload zsh/net/socket zsh/zselect zsh/system zsh/datetime || exit 1

mode=$1 sock=$2 client=${3:-}
stty raw -echo 2>/dev/null
# The cursor is hidden and wrapping off while the daemon draws; a sidebar
# that has lost it says so in its first line.
print -n '\e[?25l\e[?7l'

if [[ $mode == mission ]]; then
  size=($(stty size 2>/dev/null))
  hello="mission $client ${size[2]:-120} ${size[1]:-40}"
else
  hello="sidebar $TMUX_PANE"
fi

started=0 backoff=3
while true; do
  if zsocket $sock 2>/dev/null; then
    fd=$REPLY
    started=0 backoff=3
    syswrite -o $fd -- "$hello"$'\n'
    while true; do
      zselect -A ready -r 0 $fd || continue
      if (( ${+ready[$fd]} )); then
        sysread -i $fd -s 65536 buf || break
        syswrite -o 1 -- $buf
      fi
      if (( ${+ready[0]} )); then
        # The pane or popup has closed.
        sysread -i 0 -s 256 key || exit 0
        syswrite -o $fd -- $key || break
      fi
    done
    exec {fd}>&-
    [[ $mode == mission ]] && exit 0
  fi
  # No daemon: start one, and look again shortly. Every window's sidebar does
  # this at once, so a daemon that keeps failing is tried less and less often,
  # up to once a minute, rather than starting a crowd of processes every few
  # seconds.
  if (( EPOCHSECONDS - started > backoff )); then
    (( started )) && (( backoff = backoff * 2 > 60 ? 60 : backoff * 2 ))
    started=$EPOCHSECONDS
    print -n '\e[H\e[2J\e[38;5;244m starting the sidebar…\e[0m'
    ${0:h}/sidebar.sh start </dev/null >/dev/null 2>&1
  fi
  [[ $mode == mission ]] && (( EPOCHSECONDS - started > 5 )) && exit 1
  zselect -t 50
done
