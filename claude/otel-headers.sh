#!/usr/bin/env bash

# Prints the OTLP export headers Claude Code sends to Datadog, as the JSON
# object `otelHeadersHelper` expects: {"dd-api-key":"..."}.
#
# It exists so the API key does not have to live in settings.json. That file is
# symlinked out of a public repo, so anything written into it is published; this
# script is public too, but holds only the lookup, never the key.
#
# The key is read from, in order: DATADOG_API_KEY, the login keychain, then
# ~/.config/claude-code/datadog-api-key. Same precedence worktree-from-ticket
# uses for its Linear key — the environment wins, the stored copy is the default.
#
# Store it in the keychain without it reaching your shell history:
#   security add-generic-password -a "$USER" -s claude-otel-datadog -w
# (-w with no value prompts for it, and does not echo.)

set -euo pipefail

SERVICE="claude-otel-datadog"
KEY_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/claude-code/datadog-api-key"

key="${DATADOG_API_KEY:-}"

# `security` is macOS only, and sync.sh installs this on Linux too.
if [ -z "$key" ] && command -v security >/dev/null 2>&1; then
  key=$(security find-generic-password -a "$USER" -s "$SERVICE" -w 2>/dev/null || true)
fi

if [ -z "$key" ] && [ -r "$KEY_FILE" ]; then
  key=$(tr -d '[:space:]' < "$KEY_FILE")
fi

# Exiting non-zero rather than printing {} on purpose: Claude Code reports a
# failed helper, where empty headers would just be rejected by Datadog on every
# export with nothing said about why.
if [ -z "$key" ]; then
  echo "No Datadog API key found for OpenTelemetry export. Add one with:" >&2
  echo "  security add-generic-password -a \"\$USER\" -s $SERVICE -w" >&2
  echo "or write it to $KEY_FILE (chmod 600)." >&2
  exit 1
fi

# Datadog API keys are hex, so there is nothing in one that needs escaping.
printf '{"dd-api-key":"%s"}\n' "$key"
