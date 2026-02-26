#!/bin/bash
INPUT=$(cat)
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
if [[ -z "$CMD" ]]; then
  exit 0
fi
if echo "$CMD" | grep -qE '(^|;|&&|\|\||\|)\s*(python3?|/usr/bin/(env\s+)?python3?)\b'; then
  echo 'Use Node.js instead of Python for one-off scripts.' >&2
  exit 2
fi
exit 0
