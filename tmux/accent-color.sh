#!/usr/bin/env bash

# Derives a deterministic accent color from directory + git context.
# Same HSL logic (S=80%, L=45%) and color key as session_title.py and
# statusline-command.sh, so tmux, iTerm tabs, and Claude statusline
# all agree on the color for a given project/branch.
#
# Usage: accent-color.sh [--name] <path>
# Output: hex color (e.g. "23ef59"), or with --name, the color key string

name_only=false
if [ "$1" = "--name" ]; then
  name_only=true
  shift
fi
cwd="${1:-.}"
dirname=$(basename "$cwd")
color_key="$dirname"

branch=$(git -C "$cwd" --no-optional-locks rev-parse --abbrev-ref HEAD 2>/dev/null)
if [ -n "$branch" ]; then
  git_common_dir=$(git -C "$cwd" --no-optional-locks rev-parse --git-common-dir 2>/dev/null)
  git_dir=$(git -C "$cwd" --no-optional-locks rev-parse --git-dir 2>/dev/null)
  if [ -n "$git_common_dir" ] && [ -n "$git_dir" ]; then
    real_common=$(cd "$cwd" && realpath "$git_common_dir" 2>/dev/null)
    real_git=$(cd "$cwd" && realpath "$git_dir" 2>/dev/null)
    if [ "$real_git" != "$real_common" ]; then
      worktree_name=$(basename "$real_git")
      color_key="${dirname} | worktree:${worktree_name}"
    else
      color_key="${dirname} | branch:${branch}"
    fi
  fi
fi

if $name_only; then
  printf '%s' "$color_key"
  exit 0
fi

hash=$(printf '%s' "$color_key" | shasum -a 256 | cut -c1-8)
hue=$(( 16#$hash % 360 ))
h_segment=$(( hue / 60 ))
h_frac=$(( (hue % 60) * 255 / 60 ))
c=204
x=$(( c * (255 - (h_frac * 2 - 255 > 0 ? h_frac * 2 - 255 : 255 - h_frac * 2)) / 255 ))
m=35

case $h_segment in
  0) r=$((c+m)); g=$((x+m)); b=$m ;;
  1) r=$((x+m)); g=$((c+m)); b=$m ;;
  2) r=$m; g=$((c+m)); b=$((x+m)) ;;
  3) r=$m; g=$((x+m)); b=$((c+m)) ;;
  4) r=$((x+m)); g=$m; b=$((c+m)) ;;
  *) r=$((c+m)); g=$m; b=$((x+m)) ;;
esac

(( r > 255 )) && r=255; (( g > 255 )) && g=255; (( b > 255 )) && b=255
(( r < 0 )) && r=0; (( g < 0 )) && g=0; (( b < 0 )) && b=0

# Ensure minimum perceived luminance for readability on dark backgrounds
lum=$(( (299 * r + 587 * g + 114 * b) / 1000 ))
if (( lum < 100 )); then
  boost=$(( 100 - lum ))
  r=$(( r + boost )); g=$(( g + boost )); b=$(( b + boost ))
  (( r > 255 )) && r=255; (( g > 255 )) && g=255; (( b > 255 )) && b=255
fi

printf '%02x%02x%02x' "$r" "$g" "$b"
