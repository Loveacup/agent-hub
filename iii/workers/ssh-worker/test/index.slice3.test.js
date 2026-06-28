// Phase 8 Slice 3 — entry dispatch of MOCKED status / release_remote /
// terminate_remote (with orphan-aware session lifecycle).
//
// index.js now serves status/release_remote/terminate_remote as supported
// control-plane types, dispatching to the mocked remote.js orchestrators with
// caller-injected deps ({ registry, sessions, publish, terminator }). Every
// response still carries the mandatory monitorability control_plane block and
// keeps execute:false — the runtime is still unavailable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { getCapabilities, handleControlPlaneRequest } from '../src/index.js';
import { createSessionStore } from '../src/session.js';
import { loadHostRegistryFromObject } from '../src/registry.js';

const validObj = JSON.parse(readFileSync(new URL('./fixtures/hosts.valid.json', import.meta.url), 'utf8'));
const { registry } = loadHostRegistryFromObject(validObj);

function deps() {
  let n = 0;
  const calls = [];
  const reaped = [];
  const sessions = createSessionStore({ now: () => 5000, idFactory: () => `rsess-${(n += 1)}`, ttlMs: 60000 });
  const publish = ({ subject, event }) => {
    calls.push({ subject, event });
    return { ok: true };
  };
  const terminator = (info) => {
    reaped.push(info);
    return { ok: true };
  };
  return { registry, sessions, publish, terminator, _calls: calls, _reaped: reaped };
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

test('capabilities promote status/release_remote/terminate_remote to supported (mocked)', () => {
  const caps = getCapabilities();
  for (const s of ['status', 'release_remote', 'terminate_remote']) {
    assert.ok(caps.supported.includes(s), `supported must include ${s}`);
    assert.ok(!caps.unsupported.includes(s), `unsupported must not include ${s}`);
  }
  // execution-shaped caps NOT in scope stay unsupported
  for (const u of ['remote_file_write', 'remote_codex_exec', 'nats_publish', 'askills_call']) {
    assert.ok(caps.unsupported.includes(u), `unsupported must include ${u}`);
  }
  assert.equal(caps.execute, false);
  assert.deepEqual(caps.supported.filter((c) => caps.unsupported.includes(c)), [], 'no overlap');
});

test('dispatch status returns a safe snapshot, execute:false, control_plane present', () => {
  const d = deps();
  handleControlPlaneRequest({ type: 'acquire_remote', device_id: 'nas-01', runtime: 'codex' }, d);
  const res = handleControlPlaneRequest({ type: 'status' }, d);
  assert.equal(res.ok, true);
  assert.equal(res.execute, false);
  assert.equal(res.type, 'status');
  assert.equal(res.kind, 'ssh.remote.status');
  assert.equal(res.count, 1);
  assertControlPlane(res.control_plane);
});

test('dispatch status supports a device_id filter', () => {
  const d = deps();
  handleControlPlaneRequest({ type: 'acquire_remote', device_id: 'nas-01', runtime: 'codex' }, d);
  const res = handleControlPlaneRequest({ type: 'status', device_id: 'pi-09' }, d);
  assert.equal(res.ok, true);
  assert.equal(res.count, 0);
  assertControlPlane(res.control_plane);
});

test('dispatch release_remote soft-releases an acquired session, execute:false', () => {
  const d = deps();
  const acq = handleControlPlaneRequest({ type: 'acquire_remote', device_id: 'nas-01', runtime: 'codex' }, d);
  const res = handleControlPlaneRequest({ type: 'release_remote', remote_session_id: acq.remote_session_id }, d);
  assert.equal(res.ok, true);
  assert.equal(res.type, 'release_remote');
  assert.equal(res.kind, 'ssh.remote.release');
  assert.equal(res.execute, false);
  assert.equal(res.ack, true);
  assert.equal(res.published, true);
  assertControlPlane(res.control_plane);
});

test('dispatch terminate_remote reaps + deletes an acquired session, execute:false', () => {
  const d = deps();
  const acq = handleControlPlaneRequest({ type: 'acquire_remote', device_id: 'nas-01', runtime: 'codex' }, d);
  const res = handleControlPlaneRequest({ type: 'terminate_remote', remote_session_id: acq.remote_session_id }, d);
  assert.equal(res.ok, true);
  assert.equal(res.type, 'terminate_remote');
  assert.equal(res.kind, 'ssh.remote.terminate');
  assert.equal(res.execute, false);
  assert.equal(res.ack, true);
  assert.equal(res.reaped, true);
  assertControlPlane(res.control_plane);
  assert.equal(d._reaped.length, 1, 'a reap was attempted');
  // session is gone
  const after = handleControlPlaneRequest({ type: 'status' }, d);
  assert.equal(after.count, 0);
});

test('dispatch status/release/terminate fail closed on unknown session, control_plane present', () => {
  const d = deps();
  const rel = handleControlPlaneRequest({ type: 'release_remote', remote_session_id: 'rsess-404' }, d);
  assert.equal(rel.ok, false);
  assert.equal(rel.execute, false);
  assert.equal(rel.decision_code, 'session_not_found');
  assertControlPlane(rel.control_plane);
  const term = handleControlPlaneRequest({ type: 'terminate_remote', remote_session_id: 'rsess-404' }, d);
  assert.equal(term.ok, false);
  assert.equal(term.execute, false);
  assert.equal(term.decision_code, 'session_not_found');
  assertControlPlane(term.control_plane);
});

test('dispatch terminate_remote fails closed when an injected deps getter throws', () => {
  const d = deps();
  Object.defineProperty(d, 'sessions', {
    get() {
      throw new Error('malicious sessions boom');
    },
  });
  let res;
  assert.doesNotThrow(() => {
    res = handleControlPlaneRequest({ type: 'terminate_remote', remote_session_id: 'rsess-1' }, d);
  });
  assert.equal(res.ok, false);
  assert.equal(res.execute, false);
  assert.equal(res.type, 'terminate_remote');
  assert.equal(res.kind, 'ssh.remote.terminate');
  assert.equal(res.decision_code, 'injected_collaborator_failed');
  assertControlPlane(res.control_plane);
});

test('status/release/terminate without injected deps fail closed (no real runtime)', () => {
  for (const type of ['status', 'release_remote', 'terminate_remote']) {
    const res = handleControlPlaneRequest({ type, remote_session_id: 'rsess-1' });
    assert.equal(res.ok, false);
    assert.equal(res.execute, false);
    assertControlPlane(res.control_plane);
  }
});
