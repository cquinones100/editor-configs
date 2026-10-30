#!/usr/bin/env bash
# Keeps ~/switchboard up to date with GitHub: fetches origin, and when its
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
#   repo-update.sh now <client>       M-p's "Update Switchboard": the same as
#                                      check, whatever the update_check setting
#                                      and however recently it looked; with
#                                      nothing new, or GitHub out of reach, it
#                                      says so on <client> and runs the guided
#                                      setup all the same, for a clone pulled
#                                      by hand
#   repo-update.sh prompt             the popup itself.
#   repo-update.sh setup <client>     M-p's "Run Switchboard's setup": the guided
#                                      ./setup.sh in a popup, whenever you like,
#                                      to set up anything not in place yet or
#                                      answer a question you said no to before
#
# It runs in the background, never on a key press or redraw, since it waits
# on the network. Main is only fast-forwarded: with commits of your own not
# on GitHub, or another branch checked out, it says so and changes nothing.

set -u

REPO="${SWITCHBOARD_DIR:-$HOME/switchboard}"
# A clone not yet set up under its new name (setup.sh links it).
[ -d "$REPO" ] || REPO=$HOME/editor-configs
STATE=~/.local/state/switchboard
CHECK_EVERY=3600

git_() { git -C "$REPO" "$@"; }

case "${1:-}" in
  check | periodic | now)
    # The update_check setting (tmux/settings.sh): off never checks, and
    # "open" leaves out the hourly one. Asked for, it always looks.
    case "$1:$(tmux show -gqv @setting_update_check 2>/dev/null)" in
      check:off | periodic:off | periodic:open) exit 0 ;;
    esac
    # What happened, said on the client that asked; nothing for the others.
    say() { [ "$1" = now ] && tmux display-message -c "${2:-}" "$3"; return 0; }
    # Asked for with nothing new to take, or GitHub out of reach, the setup
    # still runs, saying why first, so a clone pulled by hand (or changed some
    # other way) gets whatever its setup has to do.
    setup_anyway() {
      [ "$1" = now ] || return 0
      tmux display-popup -c "${2:-}" -E -w 90 -h 85% -T ' Switchboard setup ' "SETUP_WHY=$(printf %q "$3") $0 run-setup"
    }
    mkdir -p "$STATE"
    now=$(date +%s)
    if [ "$1" = periodic ]; then
      read -r last 2>/dev/null < "$STATE/update-checked"
      [ $((now - ${last:-0})) -lt $CHECK_EVERY ] && exit 0
    fi
    # Recorded first, so health.sh, which starts this when the hour is up,
    # doesn't start it again on every redraw while it runs or has nothing to do.
    echo "$now" > "$STATE/update-checked"
    [ -d "$REPO/.git" ] || { say "$1" "${2:-}" "Switchboard isn't a git clone at $REPO, so it can't update."; exit 0; }
    # One check at a time; a lock left by a check that died goes after ten minutes.
    lock="$STATE/update.lock"
    if ! mkdir "$lock" 2>/dev/null; then
      [ -n "$(find "$lock" -maxdepth 0 -mmin +10 2>/dev/null)" ] || { say "$1" "${2:-}" "Switchboard is already looking for updates."; exit 0; }
    fi
    trap 'rmdir "$lock" 2>/dev/null' EXIT
    # Your CLAUDE.md's rules, when they live in a git repository (Settings'
    # Your CLAUDE.md): pulled with the same look, fast-forward only, by setup's
    # CLAUDE.md step, which also writes ~/.claude/CLAUDE.md again if it must.
    # It never asks for anything: git's own prompt is off, and so is its askpass
    # (GIT_ASKPASS=false, which fails at once; a credential helper such as the
    # Keychain still answers first), ssh may not open an askpass dialog
    # (SSH_ASKPASS_REQUIRE=never), and this runs from the tmux
    # server, with no terminal for ssh to ask on; your ssh settings
    # (GIT_SSH_COMMAND, GIT_SSH, the clone's core.sshCommand, ~/.ssh/config)
    # are left as they are. It runs beside the Switchboard look, not before
    # it, so nothing it waits on can hold that up, and only pulls a clone
    # already there (SWITCHBOARD_PULL_ONLY), cloning being setup's.
    if [ -n "$(jq -r '.repo // empty' ~/.config/switchboard/claude.json 2>/dev/null)" ] && [ -x "$REPO/setup.sh" ]; then
      GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=false SSH_ASKPASS_REQUIRE=never SWITCHBOARD_PULL_ONLY=true nohup bash "$REPO/setup.sh" claude_md >/dev/null 2>&1 </dev/null &
    fi
    [ "$1" = now ] && tmux display-message -c "${2:-}" "Looking for Switchboard updates…"
    GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND="ssh -o BatchMode=yes" git_ fetch --quiet origin main 2>/dev/null || { say "$1" "${2:-}" "Couldn't reach GitHub to look for Switchboard updates."; setup_anyway "$1" "${2:-}" "Couldn't reach GitHub to look for updates; running the setup with what you have."; exit 0; }
    behind=$(git_ rev-list --count main..origin/main 2>/dev/null) || exit 0
    [ "${behind:-0}" -gt 0 ] || { say "$1" "${2:-}" "Switchboard is up to date ($(git_ log -1 --format=%h main))."; setup_anyway "$1" "${2:-}" "Switchboard is up to date ($(git_ log -1 --format=%h main)); running its setup for anything not in place yet."; exit 0; }
    tip=$(git_ rev-parse origin/main)
    if [ "$1" = periodic ]; then
      read -r offered 2>/dev/null < "$STATE/update-offered"
      [ "${offered:-}" = "$tip" ] && exit 0
    fi
    client="${2:-$(tmux list-clients -F '#{client_activity} #{client_name}' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2-)}"
    [ -n "$client" ] || exit 0
    echo "$tip" > "$STATE/update-offered"
    tmux display-popup -c "$client" -E -w 90 -h 85% -T ' Switchboard ' "$0 prompt"
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
    # Enter is yes, as in every yes/no question here; a closed input is no.
    read -rsn 1 -p "  Update now? [Y/n] " answer || exit 0
    printf '\n\n'
    [[ -z $answer || $answer == [yY] ]] || exit 0
    printf '  \033[2mUpdating…\033[0m\n'
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
      printf '\n  \033[2mRunning the setup, to link and install what the update brought…\033[0m\n\n'
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

  setup)
    tmux display-popup -c "${2:-}" -E -w 90 -h 85% -T ' Switchboard setup ' "$0 run-setup"
    ;;

  # M-p's "Check Switchboard's setup": what the guided setup would do, changing nothing.
  setup-check)
    tmux display-popup -c "${2:-}" -E -w 90 -h 85% -T ' Switchboard setup, checked ' "$0 run-setup-check"
    ;;

  run-setup-check)
    printf '\n'
    if [ -x "$REPO/setup.sh" ]; then
      "$REPO/setup.sh" --check
    else
      printf '  There is no setup.sh in %s.\n' "$REPO"
    fi
    printf '\n  \033[38;5;244mPress any key to close.\033[0m'
    read -rsn 1
    ;;

  # M-p's "Run a part of Switchboard's setup": the parts setup.sh lists, Tab
  # choosing several; Enter runs them, Ctrl-O only checks them.
  setup-part)
    tmux display-popup -c "${2:-}" -E -w 90 -h 85% -T ' A part of Switchboard setup ' "$0 run-setup-part"
    ;;

  run-setup-part)
    [ -x "$REPO/setup.sh" ] || { printf '\n  There is no setup.sh in %s.\n\n  Press any key to close.' "$REPO"; read -rsn 1; exit 0; }
    picked=$("$REPO/setup.sh" --parts | fzf --multi --delimiter=$'\t' --with-nth=1,2 --layout=reverse --border=rounded --height=100% \
      --prompt='part> ' --header='Enter runs it (Tab picks several), Ctrl-O only checks what it would change' --expect=ctrl-o)
    key=$(head -1 <<<"$picked")
    chosen=()
    while IFS=$'\t' read -r part _; do [ -n "$part" ] && chosen+=("$part"); done < <(tail -n +2 <<<"$picked")
    [ ${#chosen[@]} -gt 0 ] || exit 0
    printf '\n'
    if [ "$key" = ctrl-o ]; then
      "$REPO/setup.sh" --check "${chosen[@]}"
    else
      "$REPO/setup.sh" "${chosen[@]}"
      [ -n "${TMUX:-}" ] && tmux source-file ~/.config/tmux/tmux.conf && printf '\n  Reloaded tmux.\n'
    fi
    printf '\n  \033[38;5;244mPress any key to close.\033[0m'
    read -rsn 1
    ;;

  run-setup)
    # The guided setup, as an update runs it: it changes only what isn't in
    # place and asks before anything else. Then tmux takes in what it linked.
    printf '\n'
    [ -n "${SETUP_WHY:-}" ] && printf '  %s\n\n' "$SETUP_WHY"
    if [ -x "$REPO/setup.sh" ]; then
      "$REPO/setup.sh"
    else
      printf '  There is no setup.sh in %s.\n' "$REPO"
    fi
    [ -n "${TMUX:-}" ] && tmux source-file ~/.config/tmux/tmux.conf && printf '\n  Reloaded tmux.\n'
    printf '\n  \033[38;5;244mPress any key to close.\033[0m'
    read -rsn 1
    ;;

  *)
    echo "Usage: $0 check [<client>] | periodic | now <client> | prompt | setup <client> | setup-check <client> | setup-part <client>" >&2
    exit 1
    ;;
esac
