// Tests for the shared iii-sdk compatibility adapter (iii-compat.js).
//
// These are PURE: they never import the real `iii-sdk` (the shared dir has no
// node_modules) — `getRegisterWorker` accepts an injectable loader so the SDK
// is faked here. This keeps the suite runnable under the repo-wide regression
// command `node --test iii/workers/*/test/*.test.js`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  III_SDK_VERSION,
  SUPPORTED_RANGE,
  getEngineUrl,
  getRegisterWorker,
  createWorker,
  detectSdkVersion,
} from '../iii-compat.js';

test('exports version metadata', () => {
  assert.equal(typeof III_SDK_VERSION, 'string');
  assert.match(III_SDK_VERSION, /^\d+\.\d+\.\d+$/);
  assert.equal(typeof SUPPORTED_RANGE, 'string');
  assert.ok(SUPPORTED_RANGE.includes('0.19') && SUPPORTED_RANGE.includes('0.21'));
});

test('getEngineUrl precedence: III_ENGINE_URL wins', () => {
  assert.equal(
    getEngineUrl({ III_ENGINE_URL: 'ws://a:1', III_URL: 'ws://b:2' }),
    'ws://a:1',
  );
});

test('getEngineUrl precedence: III_URL is the fallback', () => {
  assert.equal(getEngineUrl({ III_URL: 'ws://b:2' }), 'ws://b:2');
});

test('getEngineUrl precedence: default when nothing set', () => {
  assert.equal(getEngineUrl({}), 'ws://localhost:49134');
});

test('getRegisterWorker resolves registerWorker from root export', async () => {
  const fake = () => 'client';
  const fn = await getRegisterWorker(async () => ({ registerWorker: fake }));
  assert.equal(fn, fake);
});

test('getRegisterWorker tolerates a default-wrapped export', async () => {
  const fake = () => 'client';
  const fn = await getRegisterWorker(async () => ({ default: { registerWorker: fake } }));
  assert.equal(fn, fake);
});

test('getRegisterWorker throws a helpful error when registerWorker is missing', async () => {
  await assert.rejects(
    () => getRegisterWorker(async () => ({})),
    /registerWorker' not found/,
  );
});

test('createWorker wires engineUrl and workerName through registerWorker', async () => {
  const calls = [];
  const loader = async () => ({
    registerWorker: (url, opts) => {
      calls.push([url, opts]);
      return { registerFunction() {} };
    },
  });
  const client = await createWorker('demo-worker', { engineUrl: 'ws://x:9', loader });
  assert.equal(typeof client.registerFunction, 'function');
  assert.deepEqual(calls, [['ws://x:9', { workerName: 'demo-worker' }]]);
});

test('createWorker falls back to env-derived engine URL', async () => {
  const seen = [];
  const loader = async () => ({
    registerWorker: (url) => {
      seen.push(url);
      return { registerFunction() {} };
    },
  });
  const prevEngine = process.env.III_ENGINE_URL;
  const prevUrl = process.env.III_URL;
  delete process.env.III_ENGINE_URL;
  process.env.III_URL = 'ws://env-host:7';
  try {
    await createWorker('demo-worker', { loader });
    assert.deepEqual(seen, ['ws://env-host:7']);
  } finally {
    if (prevEngine === undefined) delete process.env.III_ENGINE_URL;
    else process.env.III_ENGINE_URL = prevEngine;
    if (prevUrl === undefined) delete process.env.III_URL;
    else process.env.III_URL = prevUrl;
  }
});

test('detectSdkVersion returns version when iii-sdk is installed', async () => {
  const v = await detectSdkVersion();
  // In the test environment, iii-sdk may or may not be installed.
  // If installed, it should be a semver string; if not, null.
  if (v !== null) {
    assert.match(v, /^\d+\.\d+\.\d+/);
  }
});

test('detectSdkVersion returns null for non-existent package', async () => {
  const v = await detectSdkVersion('file:///nonexistent/path/');
  assert.equal(v, null);
});
