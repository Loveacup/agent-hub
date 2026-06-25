// Phase 3b cc-worker — bridge token resolution
import { readFileSync as nodeReadFileSync } from 'node:fs';

const DEFAULT_TOKEN_PATHS = [
  '/.agent-hub/cc-host-bridge.token',
  '/tmp/agent-hub-cc-host-bridge.token',
];

export function resolveBridgeToken({
  env = process.env,
  tokenPaths = DEFAULT_TOKEN_PATHS,
  readFileSync = nodeReadFileSync,
} = {}) {
  const envToken = env.CC_HOST_BRIDGE_TOKEN;
  if (envToken && String(envToken).trim()) return String(envToken).trim();

  for (const path of tokenPaths) {
    try {
      const token = readFileSync(path, 'utf8').trim();
      if (token) return token;
    } catch {
      // try next path
    }
  }
  return '';
}
