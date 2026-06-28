// Phase 8 Slice 2 — entry dispatch of MOCKED acquire_remote / execute_remote.
//
// index.js now serves acquire_remote/execute_remote as supported control-plane
// types, dispatching to the mocked remote.js orchestrators with caller-injected
// deps ({ registry, sessions, publish }). Every response still carries the
// mandatory monitorability control_plane block and keeps execute:false — the
// runtime is still unavailable; "accepted" is async acceptance, not execution.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { getCapabilities, handleControlPlaneRequest } from '../src/index.js';
import { createSessionStore } from '../src/session.js';
import { loadHostRegistryFromObject } from '../src/registry.js';

const validObj = JSON.parse(readFileSync(new URL('./fixtures/hosts.valid.json', import.meta.url), 'utf8'));
const { registry } = loadHostRegistryFromObject(validObj);
const SECRET = 'sk-SECRET-slice2-do-not-leak-0xFEEDFACE';

function deps() {
  let n = 0;
  const calls = [];
  const sessions = createSessionStore({ now: () => 5000, idFactory: () => `rsess-${(n += 1)}`, ttlMs: 60000 });
  const publish = ({ subject, event }) => {
    calls.push({ subject, event });
    return { ok: true };
  };
  return { registry, sessions, publish, _calls: calls };
}

function assertControlPlane(cp) {
  assert.ok(cp && typeof cp === 'object', 'control_plane must be present');
  assert.equal(cp.monitoring_required, true);
  assert.equal(cp.intervention_required, true);
  assert.equal(cp.monitorable, true);
  assert.equal(cp.intervenable, false);
  assert.equal(cp.runtime_available, false);
  assert.equal(cp.status, 'unavailable');
}

test('capabilities now advertise acquire_remote/execute_remote as supported (mocked)', () => {
  const caps = getCapabilities();
  for (const s of ['acquire_remote', 'execute_remote']) {
    assert.ok(caps.supported.includes(s), `supported must include ${s}`);
    assert.ok(!caps.unsupported.includes(s), `unsupported must not include ${s}`);
  }
  // execution-shaped caps NOT in Slice 2 scope stay unsupported
  for (const u of ['terminate_remote', 'remote_file_write', 'remote_codex_exec', 'nats_publish', 'askills_call']) {
    assert.ok(caps.unsupported.includes(u), `unsupported must include ${u}`);
  }
  assert.equal(caps.execute, false);
  assert.deepEqual(caps.supported.filter((c) => caps.unsupported.includes(c)), [], 'no overlap');
});

test('dispatch acquire_remote allocates a session, execute:false, control_plane present', () => {
  const d = deps();
  const res = handleControlPlaneRequest({ type: 'acquire_remote', device_id: 'nas-01', runtime: 'codex' }, d);
  assert.equal(res.ok, true);
  assert.equal(res.execute, false);
  assert.equal(res.type, 'acquire_remote');
  assert.equal(res.kind, 'ssh.remote.acquire');
  assert.match(res.remote_session_id, /^[A-Za-z0-9-]+$/);
  assertControlPlane(res.control_plane);
});

test('dispatch execute_remote against an acquired session is accepted async, execute:false, no leakage', () => {
  const d = deps();
  const acq = handleControlPlaneRequest({ type: 'acquire_remote', device_id: 'nas-01', runtime: 'codex' }, d);
  const res = handleControlPlaneRequest(
    { type: 'execute_remote', remote_session_id: acq.remote_session_id, context: `go ${SECRET}`, model: `m-${SECRET}`, effort: 'high' },
    d,
  );
  assert.equal(res.ok, true);
  assert.equal(res.type, 'execute_remote');
  assert.equal(res.kind, 'ssh.remote.execute');
  assert.equal(res.accepted, true);
  assert.equal(res.execute, false);
  assert.ok(typeof res.job_id === 'string' && res.job_id.length > 0);
  assert.equal(res.published, true);
  assertControlPlane(res.control_plane);
  const json = JSON.stringify(res) + JSON.stringify(d._calls);
  assert.ok(!json.includes(SECRET), 'must not leak secret in response or published event');
  for (const k of ['context', 'model', 'effort']) {
    assert.ok(!Object.prototype.hasOwnProperty.call(res, k), `response must not carry raw ${k}`);
  }
});

test('dispatch execute_remote with unknown session fails closed, execute:false, control_plane present', () => {
  const d = deps();
  const res = handleControlPlaneRequest({ type: 'execute_remote', remote_session_id: 'rsess-404', context: 'x' }, d);
  assert.equal(res.ok, false);
  assert.equal(res.execute, false);
  assert.equal(res.decision_code, 'session_not_found');
  assertControlPlane(res.control_plane);
});

test('dispatch acquire_remote for unknown host fails closed', () => {
  const d = deps();
  const res = handleControlPlaneRequest({ type: 'acquire_remote', device_id: 'ghost', runtime: 'codex' }, d);
  assert.equal(res.ok, false);
  assert.equal(res.execute, false);
  assert.equal(res.decision_code, 'host_not_found');
  assertControlPlane(res.control_plane);
});

test('dispatch acquire_remote fails closed when an injected registry getter throws', () => {
  // A malicious registry whose `hosts` getter throws would blow up inside
  // acquireRemote's registry read — a path remote.js does not guard. The entry
  // must catch it and fail closed, never propagate the exception.
  const d = deps();
  d.registry = {
    get hosts() {
      throw new Error('malicious registry boom');
    },
  };
  let res;
  assert.doesNotThrow(() => {
    res = handleControlPlaneRequest({ type: 'acquire_remote', device_id: 'nas-01', runtime: 'codex' }, d);
  });
  assert.equal(res.ok, false);
  assert.equal(res.execute, false);
  assert.equal(res.type, 'acquire_remote');
  assert.equal(res.kind, 'ssh.remote.acquire');
  assert.equal(res.decision_code, 'injected_collaborator_failed');
  assertControlPlane(res.control_plane);
});

test('dispatch execute_remote fails closed when an injected deps getter throws', () => {
  // A malicious deps whose `sessions` getter throws blows up during the
  // destructuring in executeRemote, before remote.js's own try/catch around
  // sessions.lookup. The entry must catch it and fail closed.
  const d = deps();
  Object.defineProperty(d, 'sessions', {
    get() {
      throw new Error('malicious sessions boom');
    },
  });
  let res;
  assert.doesNotThrow(() => {
    res = handleControlPlaneRequest({ type: 'execute_remote', remote_session_id: 'rsess-1', context: 'x' }, d);
  });
  assert.equal(res.ok, false);
  assert.equal(res.execute, false);
  assert.equal(res.type, 'execute_remote');
  assert.equal(res.kind, 'ssh.remote.execute');
  assert.equal(res.decision_code, 'injected_collaborator_failed');
  assertControlPlane(res.control_plane);
});

test('acquire/execute without injected deps fail closed (no real runtime)', () => {
  for (const type of ['acquire_remote', 'execute_remote']) {
    const res = handleControlPlaneRequest({ type, device_id: 'nas-01', runtime: 'codex', remote_session_id: 'rsess-1', context: 'x' });
    assert.equal(res.ok, false);
    assert.equal(res.execute, false);
    assertControlPlane(res.control_plane);
  }
});
