#!/usr/bin/env bash
set -euo pipefail

III_CONFIG=${III_CONFIG:-"$HOME/code/agent-hub/iii/config.yaml"}
III_BIN=${III_BIN:-"$HOME/.local/bin/iii"}
WORKER=${WORKER:-cc-worker}
TOKEN_FILE=${CC_HOST_BRIDGE_TOKEN_FILE:-"$HOME/.agent-hub/cc-host-bridge.token"}

if [[ ! -s "$TOKEN_FILE" ]]; then
  echo "missing token file: $TOKEN_FILE" >&2
  echo "run: ~/code/agent-hub/agent-hub-skill/scripts/start-cc-host-bridge.sh" >&2
  exit 1
fi

"$III_BIN" --config "$III_CONFIG" worker exec "$WORKER" -- sh -lc 'umask 077; mkdir -p /.agent-hub; cat > /.agent-hub/cc-host-bridge.token; chmod 600 /.agent-hub/cc-host-bridge.token' < "$TOKEN_FILE"
"$III_BIN" --config "$III_CONFIG" worker exec "$WORKER" -- sh -lc 'python3 - <<"PY"
from pathlib import Path
p=Path("/.agent-hub/cc-host-bridge.token")
print("provisioned cc bridge token bytes=", p.stat().st_size)
PY'
