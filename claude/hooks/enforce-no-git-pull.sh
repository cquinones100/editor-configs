#!/bin/bash
INPUT=$(cat)
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
if [[ -z "$CMD" ]]; then
  exit 0
fi
if echo "$CMD" | grep -qE '(^|;|&&|\|\||\|)\s*git\s+((-\S+\s+)*)pull\b'; then
  echo "Do not use git pull. Fetch and rebase are handled manually." >&2
  exit 2
fi
exit 0
