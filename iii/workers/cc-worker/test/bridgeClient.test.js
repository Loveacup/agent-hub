// Phase 3b cc-worker — bridge client tests (RED phase)
import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  buildBridgeUrl,
  callHostBridge,
  checkHostBridge,
} = await (async () => {
  try {
    return await import('../src/bridgeClient.js');
  } catch {
    return { buildBridgeUrl: null, callHostBridge: null, checkHostBridge: null };
  }
})();

test('buildBridgeUrl defaults to VM-to-host gateway', () => {
  assert.ok(buildBridgeUrl, 'buildBridgeUrl must be implemented');
  assert.equal(buildBridgeUrl('/control'), 'http://100.96.0.1:8767/control');
});

test('callHostBridge returns host_bridge_unavailable when fetch fails', async () => {
  assert.ok(callHostBridge, 'callHostBridge must be implemented');
  const res = await callHostBridge({ action: 'monitor', session_id: 's' }, {
    fetchFn: async () => { throw new Error('ECONNREFUSED'); },
    token: 't',
  });
  assert.equal(res.status, 'error');
  assert.equal(res.error, 'host_bridge_unavailable');
});

test('callHostBridge sends token and JSON body', async () => {
  let seen = null;
  const res = await callHostBridge({ action: 'monitor', session_id: 's' }, {
    token: 'secret',
    fetchFn: async (url, opts) => {
      seen = { url, opts };
      return {
        ok: true,
        status: 200,
        json: async () => ({ kind: 'cc.monitor', session_id: 's' }),
      };
    },
  });

  assert.equal(res.kind, 'cc.monitor');
  assert.equal(seen.url, 'http://100.96.0.1:8767/control');
  assert.equal(seen.opts.headers['x-agent-hub-token'], 'secret');
  assert.equal(JSON.parse(seen.opts.body).action, 'monitor');
});

test('callHostBridge reports unauthorized response', async () => {
  const res = await callHostBridge({ action: 'monitor', session_id: 's' }, {
    token: 'bad',
    fetchFn: async () => ({ ok: false, status: 401, text: async () => 'unauthorized' }),
  });
  assert.equal(res.status, 'error');
  assert.equal(res.error, 'host_bridge_unauthorized');
});

test('checkHostBridge calls /healthz and reports healthy bridge', async () => {
  assert.ok(checkHostBridge, 'checkHostBridge must be implemented');
  let seen = null;
  const res = await checkHostBridge({
    token: 'secret',
    fetchFn: async (url, opts) => {
      seen = { url, opts };
      return {
        ok: true,
        status: 200,
        json: async () => ({ kind: 'cc.bridge.health', status: 'ok', token_required: true }),
      };
    },
  });
  assert.equal(seen.url, 'http://100.96.0.1:8767/healthz');
  assert.equal(seen.opts.headers['x-agent-hub-token'], 'secret');
  assert.equal(res.kind, 'cc.bridge_status');
  assert.equal(res.status, 'ok');
  assert.equal(res.bridge.status, 'ok');
});

test('checkHostBridge reports unavailable bridge', async () => {
  const res = await checkHostBridge({
    token: 'secret',
    fetchFn: async () => { throw new Error('ECONNREFUSED'); },
  });
  assert.equal(res.kind, 'cc.bridge_status');
  assert.equal(res.status, 'error');
  assert.equal(res.error, 'host_bridge_unavailable');
});
