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
#
# One mutation is allowed: enqueuePullRequest, which queue-and-clean needs to
# add a PR to a merge queue in repos that turn auto-merge off. Every GitHub
# mutation takes an `input:` argument, so a mutation passes only when, with
# that one call taken out, no other `<name>(input:` is left in the command.
# Anything else, including a second mutation riding along with it, is blocked.
if echo "$CMD" | grep -qE '\bgh\s+api\s+(\S+\s+)*graphql\b'; then
  if echo "$CMD" | grep -qE '\bmutation\b'; then
    # macOS sed has no \b, so the word boundary is spelled out.
    others=$(echo "$CMD" | sed -E 's/(^|[^A-Za-z0-9_])enqueuePullRequest[[:space:]]*\([[:space:]]*input[[:space:]]*:/\1/g')
    if echo "$CMD" | grep -qE '\benqueuePullRequest\s*\(\s*input\s*:' \
      && ! echo "$others" | grep -qE '[A-Za-z_][A-Za-z0-9_]*\s*\(\s*input\s*:'; then
      exit 0
    fi
    echo "$MESSAGE GraphQL mutations are not allowed, except enqueuePullRequest." >&2
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
