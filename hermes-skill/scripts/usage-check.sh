#!/usr/bin/env bash
# agent-hub usage wrapper: query usage-worker through iii, never call ccusage directly from Hermes.
set -euo pipefail

III_BIN="${III_BIN:-$HOME/.local/bin/iii}"
III_HOST="${III_HOST:-localhost}"
III_PORT="${III_PORT:-49134}"
TIMEOUT_MS="${TIMEOUT_MS:-30000}"
if [[ $# -gt 0 ]]; then
  PAYLOAD="$1"
else
  PAYLOAD="{}"
fi

exec "$III_BIN" trigger usage::check \
  --json "$PAYLOAD" \
  --address "$III_HOST" \
  --port "$III_PORT" \
  --timeout-ms "$TIMEOUT_MS"
