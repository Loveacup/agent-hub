#!/usr/bin/env bash
# agent-hub GC wrapper: query gc-worker through iii. Defaults to scan (dry-run report).
set -euo pipefail

III_BIN="${III_BIN:-$HOME/.local/bin/iii}"
III_HOST="${III_HOST:-localhost}"
III_PORT="${III_PORT:-49134}"
TIMEOUT_MS="${TIMEOUT_MS:-30000}"
GC_FUNCTION="${GC_FUNCTION:-gc::scan}"

if [[ $# -gt 0 ]]; then
  PAYLOAD="$1"
else
  PAYLOAD="{}"
fi

ARGS=()
if [[ -n "${III_CONFIG:-}" ]]; then
  ARGS+=(--config "$III_CONFIG")
fi

exec "$III_BIN" "${ARGS[@]}" trigger "$GC_FUNCTION" \
  --json "$PAYLOAD" \
  --address "$III_HOST" \
  --port "$III_PORT" \
  --timeout-ms "$TIMEOUT_MS"
