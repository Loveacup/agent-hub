// Phase 3b bridge token helpers tests (RED phase)
import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  resolveBridgeToken,
} = await (async () => {
  try {
    return await import('../src/token.js');
  } catch {
    return { resolveBridgeToken: null };
  }
})();

test('resolveBridgeToken prefers env token', () => {
  assert.ok(resolveBridgeToken, 'resolveBridgeToken must be implemented');
  const token = resolveBridgeToken({
    env: { CC_HOST_BRIDGE_TOKEN: 'env-token' },
    readFileSync: () => { throw new Error('should not read file'); },
  });
  assert.equal(token, 'env-token');
});

test('resolveBridgeToken reads VM provisioned token file when env missing', () => {
  const token = resolveBridgeToken({
    env: {},
    tokenPaths: ['/.agent-hub/cc-host-bridge.token'],
    readFileSync: (path, enc) => {
      assert.equal(path, '/.agent-hub/cc-host-bridge.token');
      assert.equal(enc, 'utf8');
      return ' file-token\n';
    },
  });
  assert.equal(token, 'file-token');
});

test('resolveBridgeToken returns empty string when no token available', () => {
  const token = resolveBridgeToken({
    env: {},
    tokenPaths: ['/missing'],
    readFileSync: () => { throw new Error('ENOENT'); },
  });
  assert.equal(token, '');
});
