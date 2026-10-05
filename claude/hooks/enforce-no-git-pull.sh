#!/bin/bash
INPUT=$(cat)
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
if [[ -z "$CMD" ]]; then
  exit 0
fi
# Global options before the subcommand, including the ones that take a value (git -C <path> pull).
VALUE='("[^"]*"|'\''[^'\'']*'\''|\S+)'
OPTION="(-[Cc]\s+${VALUE}|--(git-dir|work-tree|namespace|config-env|exec-path)\s+${VALUE}|-\S+)"
if echo "$CMD" | grep -qE "(^|;|&&|\|\||\|)\s*git\s+(${OPTION}\s+)*pull\b"; then
  echo "Do not use git pull. Fetch and rebase are handled manually." >&2
  exit 2
fi
exit 0
