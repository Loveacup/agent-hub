// Phase 3b cc-host-bridge contract tests (RED phase)
import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  validateBridgeRequest,
  buildBridgeResponse,
  buildMonitorRequiredRefusal,
  buildInterruptRefusal,
} = await (async () => {
  try {
    return await import('../src/hostBridge.js');
  } catch {
    return {
      validateBridgeRequest: null,
      buildBridgeResponse: null,
      buildMonitorRequiredRefusal: null,
      buildInterruptRefusal: null,
    };
  }
})();

test('validateBridgeRequest rejects non-whitelisted actions', () => {
  assert.ok(validateBridgeRequest, 'validateBridgeRequest must be implemented');
  assert.throws(() => validateBridgeRequest({ action: 'shell', command: 'rm -rf /' }), /action_not_allowed/);
});

test('validateBridgeRequest requires absolute context_path for execute', () => {
  assert.throws(() => validateBridgeRequest({ action: 'execute', context_path: 'relative.md' }), /absolute context_path/);
});

test('intervene is refused when monitor evidence is absent', () => {
  assert.ok(buildMonitorRequiredRefusal, 'buildMonitorRequiredRefusal must be implemented');
  const res = buildMonitorRequiredRefusal({ session_id: 'hermes-cc-default-x' });
  assert.equal(res.status, 'refused');
  assert.equal(res.error, 'monitor_required');
});

test('interrupt is refused without confirm and reason', () => {
  assert.ok(buildInterruptRefusal, 'buildInterruptRefusal must be implemented');
  const noConfirm = buildInterruptRefusal({ session_id: 's', confirm: false, reason: 'x' });
  assert.equal(noConfirm.error, 'confirm_required');

  const noReason = buildInterruptRefusal({ session_id: 's', confirm: true, reason: '' });
  assert.equal(noReason.error, 'reason_required');
});

test('buildBridgeResponse always includes kind/source/ts', () => {
  assert.ok(buildBridgeResponse, 'buildBridgeResponse must be implemented');
  const res = buildBridgeResponse('cc.monitor', { session_id: 's', state: 'IDLE' });
  assert.equal(res.kind, 'cc.monitor');
  assert.equal(res.source, 'cc-host-bridge');
  assert.ok(res.ts);
});
