#!/usr/bin/env bash

input=$(cat)
model=$(echo "$input" | jq -r '.model.display_name')
raw_cwd=$(echo "$input" | jq -r '.workspace.current_dir')
cwd=$(echo "$raw_cwd" | sed "s|^$HOME|~|")
used=$(echo "$input" | jq -r '.context_window.used_percentage // empty')

branch=$(git -C "$raw_cwd" --no-optional-locks rev-parse --abbrev-ref HEAD 2>/dev/null)

# Derive a deterministic accent color from the directory path.
# Same HSL logic as the iTerm tab color hook in .zshrc (S=80%, L=45%).
hash=$(printf '%s' "$raw_cwd" | cksum | cut -d' ' -f1)
hue=$(( hash % 360 ))
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
accent="\033[38;2;${r};${g};${b}m"
reset="\033[0m"

# Context usage color gradient (independent of accent)
ctx_color=""
if [ -n "$used" ]; then
  used_int=$(printf "%.0f" "$used")
  if [ "$used_int" -lt 20 ]; then
    ctx_color="\033[97m"
  elif [ "$used_int" -lt 40 ]; then
    ctx_color="\033[32m"
  elif [ "$used_int" -lt 60 ]; then
    ctx_color="\033[38;5;178m"
  elif [ "$used_int" -lt 80 ]; then
    ctx_color="\033[38;5;208m"
  else
    ctx_color="\033[38;5;160m"
  fi
fi

# Build output with accent-colored model and directory
output="${accent}${model}${reset} | ${accent}${cwd}${reset}"

if [ -n "$branch" ]; then
  output="${output} | ${accent}${branch}${reset}"
fi

if [ -n "$used" ]; then
  printf "%b | Context: ${ctx_color}%.1f%% used${reset}" "$output" "$used"
else
  printf "%b" "$output"
fi
