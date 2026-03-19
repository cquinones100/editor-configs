#!/bin/bash
INPUT=$(cat)
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
if [[ -z "$CMD" ]]; then
  exit 0
fi
if echo "$CMD" | grep -qE '^gh api\b' && echo "$CMD" | grep -qEi '(-X|--method)\s+(POST|PUT|PATCH|DELETE)'; then
  echo 'gh api calls must be read-only. Destructive methods (POST/PUT/PATCH/DELETE) are not allowed.' >&2
  exit 2
fi
exit 0
