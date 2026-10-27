#!/usr/bin/env bash
# Keeps ~/editor-configs up to date with GitHub: fetches origin, and when its
# main has commits yours doesn't, offers them in a popup that fast-forwards
# main, runs ./setup.sh, and reloads tmux.
#
# Usage:
#   repo-update.sh check [<client>]   fetch, and offer any new commits in a
#                                      popup on <client>, or the client used
#                                      last. Run when a client attaches or a
#                                      session starts (tmux.conf), so it asks
#                                      whenever there is something new.
#   repo-update.sh periodic           the same, at most every CHECK_EVERY
#                                      seconds, and offering each new tip only
#                                      once, so a "no" isn't asked again until
#                                      more commits land. Started by health.sh.
#   repo-update.sh prompt             the popup itself.
#
# It runs in the background, never on a key press or redraw, since it waits
# on the network. Main is only fast-forwarded: with commits of your own not
# on GitHub, or another branch checked out, it says so and changes nothing.

set -u

REPO="${EDITOR_CONFIGS_DIR:-$HOME/editor-configs}"
STATE=~/.local/state/editor-configs
CHECK_EVERY=3600

git_() { git -C "$REPO" "$@"; }

case "${1:-}" in
  check | periodic)
    # The update_check setting (tmux/settings.sh): off never checks, and
    # "open" leaves out the hourly one.
    case "$1:$(tmux show -gqv @setting_update_check 2>/dev/null)" in
      *:off | periodic:open) exit 0 ;;
    esac
    mkdir -p "$STATE"
    now=$(date +%s)
    if [ "$1" = periodic ]; then
      read -r last 2>/dev/null < "$STATE/update-checked"
      [ $((now - ${last:-0})) -lt $CHECK_EVERY ] && exit 0
    fi
    # Recorded first, so health.sh, which starts this when the hour is up,
    # doesn't start it again on every redraw while it runs or has nothing to do.
    echo "$now" > "$STATE/update-checked"
    [ -d "$REPO/.git" ] || exit 0
    # One check at a time; a lock left by a check that died goes after ten minutes.
    lock="$STATE/update.lock"
    if ! mkdir "$lock" 2>/dev/null; then
      [ -n "$(find "$lock" -maxdepth 0 -mmin +10 2>/dev/null)" ] || exit 0
    fi
    trap 'rmdir "$lock" 2>/dev/null' EXIT
    GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND="ssh -o BatchMode=yes" git_ fetch --quiet origin main 2>/dev/null || exit 0
    behind=$(git_ rev-list --count main..origin/main 2>/dev/null) || exit 0
    [ "${behind:-0}" -gt 0 ] || exit 0
    tip=$(git_ rev-parse origin/main)
    if [ "$1" = periodic ]; then
      read -r offered 2>/dev/null < "$STATE/update-offered"
      [ "${offered:-}" = "$tip" ] && exit 0
    fi
    client="${2:-$(tmux list-clients -F '#{client_activity} #{client_name}' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2-)}"
    [ -n "$client" ] || exit 0
    echo "$tip" > "$STATE/update-offered"
    tmux display-popup -c "$client" -E -w 90 -h 85% -T ' editor-configs ' "$0 prompt"
    # How updates also arrive, once (tip.sh).
    [ -x ~/.config/tmux/tip.sh ] && ~/.config/tmux/tip.sh show updates "$client"
    ;;

  prompt)
    behind=$(git_ rev-list --count main..origin/main)
    ahead=$(git_ rev-list --count origin/main..main)
    printf '\n  %s new commit%s on GitHub:\n\n' "$behind" "$([ "$behind" = 1 ] || echo s)"
    git_ log --format='  %s' main..origin/main | head -20
    [ "$behind" -gt 20 ] && printf '  …and %s more\n' $((behind - 20))
    printf '\n'
    done_() {
      printf '\n  \033[38;5;244mPress any key to close.\033[0m'
      read -rsn 1
      exit "${1:-0}"
    }
    if [ "$ahead" -gt 0 ]; then
      printf '  You have %s commit%s of your own not on GitHub, so main can'\''t\n  simply move forward. Update it by hand.\n' "$ahead" "$([ "$ahead" = 1 ] || echo s)"
      done_
    fi
    if [ "$(git_ branch --show-current)" != main ]; then
      printf '  %s has %s checked out, not main. Update it by hand.\n' "$REPO" "$(git_ branch --show-current)"
      done_
    fi
    read -rsn 1 -p "  Update now? [y/N] " answer
    printf '\n\n'
    [[ $answer == [yY] ]] || exit 0
    old=$(git_ rev-parse HEAD)
    if ! out=$(git_ merge --ff-only --quiet origin/main 2>&1); then
      printf '  It could not update:\n\n%s\n' "$(sed 's/^/  /' <<<"$out")"
      done_ 1
    fi
    printf '  Updated to %s.\n' "$(git_ log -1 --format=%h)"
    # The guided setup, which links what is new, installs the pinned tmux
    # plugins and anything else the update needs, and asks about the rest. It
    # changes only what isn't in place. Not piped, so its questions show.
    if [ -x "$REPO/setup.sh" ]; then
      printf '\n'
      "$REPO/setup.sh"
      printf '\n'
    fi
    if [ -n "${TMUX:-}" ]; then
      # The sidebar daemon keeps running the code it started with; reloading
      # tmux.conf starts it again once it has stopped.
      if [ -n "$(git_ diff --name-only "$old" HEAD -- lib/sidebar bin/tmux-sidebar)" ]; then
        kill "$(cut -d' ' -f1 ~/.local/state/tmux-sidebar/daemon.pid 2>/dev/null)" 2>/dev/null && sleep 1 && printf '  Restarted the sidebar.\n'
      fi
      tmux source-file ~/.config/tmux/tmux.conf && printf '  Reloaded tmux.\n'
    fi
    done_
    ;;

  *)
    echo "Usage: $0 check [<client>] | periodic | prompt" >&2
    exit 1
    ;;
esac
