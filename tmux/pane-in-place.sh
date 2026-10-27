#!/usr/bin/env bash
# A tool in a pane's place, leaving the rest of the window, sidebar included,
# as it is; quitting the tool puts the pane back. M-p's lazygit opens this way,
# M-d diffview.nvim (nvim/lua/plugins/diffview.lua), in the stripped-down
# Neovim nvim/diff.lua sets up, and M-p's PR description as an image
# (tmux/pr-image.js), whose pane alone lets images through to the terminal.
#
# Usage:
#   pane-in-place.sh open <lazygit|diffview|pr-image> <pane> <dir> <client>
#                                                           start the tool in <dir> in <pane>'s place
#   pane-in-place.sh back <pane>                            from the tool's pane as it exits: swap <pane> back
#   pane-in-place.sh popup <lazygit|diffview|pr-image> <dir> <client> the tool in <dir> in a popup on <client>, for a
#                                                           worktree no tab is in (the sidebar's d and L)
#
# The tool starts in a window of its own, and swap-pane trades places: the
# tool goes where the pane was, and the pane waits in that window, marked
# @pane_parked so the sidebar gives it no sidebar and leaves it out of the
# tabs. The tool's pane records the parked pane in @parked_pane and its own
# name in @in_place, which the lazygit binding and M-d use to tell their tool's pane, since
# its command reads as the shell that runs the tool. When the tool exits,
# however it is quit, its shell swaps the pane back and selects it, and the
# parked window, left with only the tool's closing pane, closes with it. A
# pane killed instead (M-w's confirmation) is swapped back by confirm.sh
# first, from @parked_pane.

set -u

# The command that runs <tool> in <dir>, or nothing. <client> is shown a
# popup while it waits on the network.
tool_command() {
  local tool=$1 dir=$2 client=$3 base ref
  case $tool in
    lazygit) echo lazygit ;;
    # Under an interactive zsh, for the PATH (node, gh) the tmux server lacks.
    pr-image) echo "zsh -i -c 'node ~/.config/tmux/pr-image.js'" ;;
    # GitHub's "Files changed": the branch's commits since it left its PR's
    # base branch (origin's default branch without a PR, main where origin
    # doesn't say), as origin has that branch now, so it is fetched first: a
    # base last fetched before the branch was rebased onto a newer one would
    # count that newer work as the branch's. Committed changes only, as on
    # GitHub. gh and the fetch each wait on the network, about a second, so a
    # popup says it is loading until they are done. It is started in the
    # background, since display-popup holds until the popup closes, and closes
    # itself after 30 seconds should nothing close it.
    diffview)
      if ! git -C "$dir" rev-parse --git-dir >/dev/null 2>&1; then
        tmux display-message "Not in a git repository: ${dir//\#/##}"
        exit 0
      fi
      tmux display-popup -c "$client" -E -w 60 -h 9 -T " diffview " \
        "printf '\\n\\n\\n%14s\\033[1mFetching the PR base branch...\\033[0m' ''; sleep 30" </dev/null >/dev/null 2>&1 &
      base=$(cd "$dir" && gh pr view --json baseRefName -q .baseRefName 2>/dev/null)
      [ -n "$base" ] || base=$(git -C "$dir" rev-parse --abbrev-ref origin/HEAD 2>/dev/null)
      base=${base#origin/}
      [ -n "$base" ] || base=main
      # It goes into a command line, so only a branch name's characters.
      [[ $base =~ ^[A-Za-z0-9._/-]+$ ]] || base=main
      fetched=1
      git -C "$dir" fetch --quiet origin "$base" 2>/dev/null || fetched=
      tmux display-popup -C -c "$client"
      [ -n "$fetched" ] || tmux display-message -c "$client" "Could not fetch origin/$base; comparing with it as last fetched."
      # A repository with no origin compares with its own branch.
      ref=origin/$base
      git -C "$dir" rev-parse --verify --quiet "$ref" >/dev/null || ref=$base
      echo "nvim -u ~/.config/nvim/diff.lua --noplugin --cmd 'let g:diff_pane = 1' --cmd 'let g:diff_base = \"$ref\"' -c 'DiffviewOpen $ref...HEAD'"
      ;;
  esac
}

case "${1:-}" in
  open)
    tool=$2 pane=$3 dir=$4 client=$5
    command=$(tool_command "$tool" "$dir" "$client")
    [ -n "$command" ] || exit 0
    command="$command; ~/.config/tmux/pane-in-place.sh back $pane"
    tool_pane=$(tmux new-window -d -P -F '#{pane_id}' -c "$dir" "$command") || exit 0
    tmux set -w -t "$tool_pane" @pane_parked 1
    tmux set -p -t "$tool_pane" @parked_pane "$pane"
    tmux set -p -t "$tool_pane" @in_place "$tool"
    # The image view draws through tmux's passthrough, for its pane alone.
    [ "$tool" = pr-image ] && tmux set -p -t "$tool_pane" allow-passthrough on
    tmux swap-pane -d -s "$tool_pane" -t "$pane"
    tmux select-pane -t "$tool_pane"
    # How to get the pane back, the first time (tmux/tip.sh).
    ~/.config/tmux/tip.sh show in-place "$client"
    ;;
  popup)
    tool=$2 dir=$3 client=$4
    command=$(tool_command "$tool" "$dir" "$client")
    [ -n "$command" ] || exit 0
    tmux display-popup -c "$client" -E -w 95% -h 90% -d "$dir" -T " $tool " "$command"
    ;;
  back)
    pane=$2
    # The pane may have been closed meanwhile; then there is nothing to bring back.
    tmux swap-pane -d -s "$pane" -t "${TMUX_PANE:-}" 2>/dev/null && tmux select-pane -t "$pane"
    ;;
esac
exit 0
