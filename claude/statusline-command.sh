#!/usr/bin/env bash

input=$(cat)
model=$(echo "$input" | jq -r '.model.display_name')
cwd=$(echo "$input" | jq -r '.workspace.current_dir' | sed "s|^$HOME|~|")
used=$(echo "$input" | jq -r '.context_window.used_percentage // empty')

branch=$(git -C "$(echo "$input" | jq -r '.workspace.current_dir')" --no-optional-locks rev-parse --abbrev-ref HEAD 2>/dev/null)

if [ -n "$used" ]; then
  used_int=$(printf "%.0f" "$used")
  if [ "$used_int" -lt 20 ]; then
    color="\033[97m"
  elif [ "$used_int" -lt 40 ]; then
    color="\033[32m"
  elif [ "$used_int" -lt 60 ]; then
    color="\033[38;5;178m"
  elif [ "$used_int" -lt 80 ]; then
    color="\033[38;5;208m"
  else
    color="\033[38;5;160m"
  fi
  reset="\033[0m"
  if [ -n "$branch" ]; then
    printf "%s | %s | %s | Context: ${color}%.1f%% used${reset}" "$model" "$cwd" "$branch" "$used"
  else
    printf "%s | %s | Context: ${color}%.1f%% used${reset}" "$model" "$cwd" "$used"
  fi
else
  if [ -n "$branch" ]; then
    printf "%s | %s | %s" "$model" "$cwd" "$branch"
  else
    printf "%s | %s" "$model" "$cwd"
  fi
fi
