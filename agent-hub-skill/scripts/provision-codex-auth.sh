#!/usr/bin/env bash
set -euo pipefail

III_CONFIG=${III_CONFIG:-"$HOME/code/agent-hub/iii/config.yaml"}
III_BIN=${III_BIN:-"$HOME/.local/bin/iii"}
WORKER=${WORKER:-codex-worker}
AUTH_PATH=${CODEX_AUTH_PATH:-"$HOME/.codex/auth.json"}

if [[ ! -f "$AUTH_PATH" ]]; then
  echo "codex auth not found: $AUTH_PATH" >&2
  exit 1
fi

# Do not echo or inline secret content. Stream over stdin into the worker VM.
"$III_BIN" --config "$III_CONFIG" worker exec "$WORKER" -- \
  sh -lc 'umask 077; mkdir -p /.codex; cat > /.codex/auth.json; chmod 600 /.codex/auth.json' < "$AUTH_PATH"

"$III_BIN" --config "$III_CONFIG" worker exec "$WORKER" -- \
  sh -lc 'python3 - <<"PY"
import json, pathlib
p = pathlib.Path("/.codex/auth.json")
data = json.loads(p.read_text())
print("provisioned codex auth keys=", sorted(data.keys()))
print("provisioned codex auth bytes=", p.stat().st_size)
PY'
