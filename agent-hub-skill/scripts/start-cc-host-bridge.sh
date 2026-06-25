#!/usr/bin/env bash
set -euo pipefail

TOKEN_FILE=${CC_HOST_BRIDGE_TOKEN_FILE:-"$HOME/.agent-hub/cc-host-bridge.token"}
BRIDGE=${CC_HOST_BRIDGE_SCRIPT:-"$HOME/code/agent-hub/agent-hub-skill/scripts/cc-host-bridge.mjs"}

mkdir -p "$(dirname "$TOKEN_FILE")"
if [[ ! -s "$TOKEN_FILE" ]]; then
  umask 077
  openssl rand -hex 24 > "$TOKEN_FILE"
fi
chmod 600 "$TOKEN_FILE"

export CC_HOST_BRIDGE_TOKEN_FILE="$TOKEN_FILE"
exec node "$BRIDGE"
