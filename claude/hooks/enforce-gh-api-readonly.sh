#!/bin/bash
INPUT=$(cat)
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
if [[ -z "$CMD" ]]; then
  exit 0
fi
if ! echo "$CMD" | grep -qE '(^|;|&&|\|\||\|)\s*gh\s+api\b'; then
  exit 0
fi
MESSAGE='gh api calls must be read-only. Destructive methods (POST/PUT/PATCH/DELETE) are not allowed.'
if echo "$CMD" | grep -qEi '(-X\s*|--method(\s+|=))["'\'']?(POST|PUT|PATCH|DELETE)\b'; then
  echo "$MESSAGE" >&2
  exit 2
fi
# GraphQL reads are POSTs too, so only mutations count as writes there.
if echo "$CMD" | grep -qE '\bgh\s+api\s+(\S+\s+)*graphql\b'; then
  if echo "$CMD" | grep -qE '\bmutation\b'; then
    echo "$MESSAGE GraphQL mutations are not allowed." >&2
    exit 2
  fi
  exit 0
fi
# gh api switches to POST when given fields or a request body, unless the method is set explicitly.
if echo "$CMD" | grep -qE '(\s)(-[fF]|--field|--raw-field|--input)(\s|=|$)' \
  && ! echo "$CMD" | grep -qEi '(-X\s*|--method(\s+|=))["'\'']?GET\b'; then
  echo "$MESSAGE Fields and --input make gh api send a POST; pass -X GET to send them as query parameters." >&2
  exit 2
fi
exit 0
