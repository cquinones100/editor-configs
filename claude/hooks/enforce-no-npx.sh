#!/bin/bash
INPUT=$(cat)
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
if [[ -z "$CMD" ]]; then
  exit 0
fi
if echo "$CMD" | grep -qE '(^|;|&&|\|\||\|)\s*npx\b'; then
  PKG_MANAGER="the project's package manager"
  if [[ -f "pnpm-lock.yaml" ]]; then
    PKG_MANAGER="pnpm dlx for one-off remote packages, pnpm exec for local binaries, or pnpm <script> for named scripts in package.json"
  elif [[ -f "bun.lockb" || -f "bun.lock" ]]; then
    PKG_MANAGER="bunx for one-off remote packages, bun run <bin> for local binaries, or bun <script> for named scripts in package.json"
  elif [[ -f "yarn.lock" ]]; then
    PKG_MANAGER="yarn dlx for one-off remote packages, yarn exec for local binaries, or yarn <script> for named scripts in package.json"
  elif [[ -f "package-lock.json" ]]; then
    PKG_MANAGER="npm exec for local binaries or one-off remote packages, or npm run <script> for named scripts in package.json"
  fi
  echo "Do not use npx. Use ${PKG_MANAGER} instead." >&2
  exit 2
fi
exit 0
