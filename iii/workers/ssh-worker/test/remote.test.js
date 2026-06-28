// Phase 8 Slice 2 — acquire_remote / execute_remote business rules (MOCKED).
//
// remote.js orchestrates remote CLI sessions WITHOUT any real runtime: no SSH
// connect, no remote `codex exec`, no real NATS publish. It validates the
// CALLER-injected host registry + session store, allocates / resolves a session
// handle, and (for execute) ACCEPTS work asynchronously, calling an INJECTED
// fake publisher. Every return keeps execute:false (nothing was executed) and
// redacted:true (no context/model/secret is ever echoed back or published).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { acquireRemote, executeRemote, statusRemote, releaseRemote, terminateRemote } from '../src/remote.js';
import { createSessionStore } from '../src/session.js';
import { loadHostRegistryFromObject } from '../src/registry.js';

const validObj = JSON.parse(readFileSync(new URL('./fixtures/hosts.valid.json', import.meta.url), 'utf8'));
const { registry } = loadHostRegistryFromObject(validObj);

const SAFE_TOKEN_RE = /^[A-Za-z0-9-]+$/;
const SECRET = 'sk-SECRET-do-not-leak-0xCAFEBABE';

// Records every fake publish so leakage assertions can scan it.
function recorder() {
  const calls = [];
  const publish = ({ subject, event }) => {
    calls.push({ subject, event });
    return { ok: true };
  };
  publish.calls = calls;
  return publish;
}

function newStore() {
  let n = 0;
  return createSessionStore({ now: () => 1000, idFactory: () => `rsess-${(n += 1)}`, ttlMs: 60000 });
}

// ── acquire_remote ────────────────────────────────────────────────────────────
test('acquireRemote allocates a session for an enabled host + declared runtime', () => {
  const sessions = newStore();
  const publish = recorder();
  const r = acquireRemote({ device_id: 'nas-01', runtime: 'codex' }, { registry, sessions, publish });
  assert.equal(r.ok, true);
  assert.equal(r.execute, false);
  assert.equal(r.kind, 'ssh.remote.acquire');
  assert.match(r.remote_session_id, SAFE_TOKEN_RE);
  assert.equal(r.device_id, 'nas-01');
  assert.equal(r.runtime, 'codex');
  // subject built via subject.js sanitizer, session-scoped 6-token grammar
  assert.equal(r.subject, `agent.device.nas-01.codex.${r.remote_session_id}.status`);
  // the handle is really stored
  assert.equal(sessions.lookup(r.remote_session_id).ok, true);
});

test('acquireRemote fails closed: unknown host, disabled host, undeclared/invalid runtime', () => {
  const sessions = newStore();
  assert.equal(acquireRemote({ device_id: 'nope', runtime: 'codex' }, { registry, sessions }).decision_code, 'host_not_found');
  assert.equal(acquireRemote({ device_id: 'pi-02', runtime: 'codex' }, { registry, sessions }).decision_code, 'host_disabled');
  assert.equal(acquireRemote({ device_id: 'nas-01', runtime: 'rustc' }, { registry, sessions }).decision_code, 'runtime_not_declared');
  assert.equal(acquireRemote({ device_id: 'nas-01', runtime: 'bad name' }, { registry, sessions }).decision_code, 'invalid_runtime');
  for (const r of [acquireRemote(undefined, undefined), acquireRemote({}, {}), acquireRemote(42, null)]) {
    assert.equal(r.ok, false);
    assert.equal(r.execute, false);
  }
});

test('acquireRemote fails closed when injected sessions.create throws (never propagates)', () => {
  const sessions = {
    create() {
      throw new Error('store boom');
    },
  };
  let r;
  assert.doesNotThrow(() => {
    r = acquireRemote({ device_id: 'nas-01', runtime: 'codex' }, { registry, sessions });
  });
  assert.equal(r.ok, false);
  assert.equal(r.execute, false);
  assert.equal(r.accepted, false);
  assert.equal(r.published, false);
  assert.equal(r.decision_code, 'injected_collaborator_failed');
});

test('acquireRemote requires an injected session store', () => {
  const r = acquireRemote({ device_id: 'nas-01', runtime: 'codex' }, { registry });
  assert.equal(r.ok, false);
  assert.equal(r.decision_code, 'no_session_store');
});

// ── execute_remote ────────────────────────────────────────────────────────────
test('executeRemote accepts async against a live session and publishes a status event', () => {
  const sessions = newStore();
  const publish = recorder();
  const acq = acquireRemote({ device_id: 'nas-01', runtime: 'codex' }, { registry, sessions, publish });
  const r = executeRemote(
    { remote_session_id: acq.remote_session_id, context: 'do a thing', effort: 'medium', model: 'gpt-5' },
    { sessions, publish, jobIdFactory: () => 'rjob-1' },
  );
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'ssh.remote.execute');
  assert.equal(r.accepted, true);
  assert.equal(r.execute, false, 'accepted != executed');
  assert.equal(r.job_id, 'rjob-1');
  assert.equal(r.remote_session_id, acq.remote_session_id);
  assert.equal(r.published, true);
  // turn-done is the (future) result channel — string only, NOT published now
  assert.equal(r.result_subject, `agent.device.nas-01.codex.${acq.remote_session_id}.turn-done`);
  assert.ok(publish.calls.some((c) => c.subject.endsWith('.status')), 'a status event was published');
  assert.ok(!publish.calls.some((c) => c.subject.endsWith('.turn-done')), 'turn-done is not published at accept time');
});

test('executeRemote never leaks context/model/effort/secret into response or published event', () => {
  const sessions = newStore();
  const publish = recorder();
  const acq = acquireRemote({ device_id: 'nas-01', runtime: 'codex' }, { registry, sessions, publish });
  const r = executeRemote(
    { remote_session_id: acq.remote_session_id, context: `prompt ${SECRET}`, model: `model-${SECRET}`, effort: `high-${SECRET}` },
    { sessions, publish },
  );
  assert.equal(r.ok, true);
  assert.equal(r.redacted, true);
  const json = JSON.stringify(r) + JSON.stringify(publish.calls);
  assert.ok(!json.includes(SECRET), 'must not leak secret');
  for (const k of ['context', 'model', 'effort']) {
    assert.ok(!Object.prototype.hasOwnProperty.call(r, k), `response must not carry raw ${k}`);
  }
});

test('executeRemote fails closed: unknown/invalid session, missing context', () => {
  const sessions = newStore();
  const publish = recorder();
  assert.equal(executeRemote({ remote_session_id: 'rsess-999', context: 'x' }, { sessions, publish }).decision_code, 'session_not_found');
  assert.equal(executeRemote({ remote_session_id: 'bad id', context: 'x' }, { sessions, publish }).decision_code, 'invalid_session_id');
  const acq = acquireRemote({ device_id: 'nas-01', runtime: 'codex' }, { registry, sessions, publish });
  assert.equal(executeRemote({ remote_session_id: acq.remote_session_id, context: '' }, { sessions, publish }).decision_code, 'invalid_context');
  assert.equal(executeRemote({ remote_session_id: acq.remote_session_id, context: 42 }, { sessions, publish }).decision_code, 'invalid_context');
  for (const r of [executeRemote(undefined, undefined), executeRemote({}, {}), executeRemote(42, null)]) {
    assert.equal(r.ok, false);
    assert.equal(r.execute, false);
  }
});

test('executeRemote fails closed when injected sessions.lookup throws (never propagates)', () => {
  const sessions = {
    lookup() {
      throw new Error('lookup boom');
    },
  };
  const publish = recorder();
  let r;
  assert.doesNotThrow(() => {
    r = executeRemote({ remote_session_id: 'rsess-1', context: 'x' }, { sessions, publish });
  });
  assert.equal(r.ok, false);
  assert.equal(r.execute, false);
  assert.equal(r.accepted, false);
  assert.equal(r.published, false);
  assert.equal(r.decision_code, 'injected_collaborator_failed');
  assert.equal(publish.calls.length, 0, 'nothing published on a fail-closed path');
});

test('executeRemote fails closed when injected jobIdFactory throws (never propagates)', () => {
  const sessions = newStore();
  const publish = recorder();
  const acq = acquireRemote({ device_id: 'nas-01', runtime: 'codex' }, { registry, sessions, publish });
  const boom = () => {
    throw new Error('job id boom');
  };
  let r;
  assert.doesNotThrow(() => {
    r = executeRemote({ remote_session_id: acq.remote_session_id, context: 'x' }, { sessions, publish, jobIdFactory: boom });
  });
  assert.equal(r.ok, false);
  assert.equal(r.execute, false);
  assert.equal(r.accepted, false);
  assert.equal(r.published, false);
  assert.equal(r.decision_code, 'injected_collaborator_failed');
  // the acquire above publishes nothing; a fail-closed execute must also publish nothing
  assert.ok(!publish.calls.some((c) => c.subject.endsWith('.status')), 'no status event on fail-closed execute');
});

test('executeRemote requires an injected session store', () => {
  const r = executeRemote({ remote_session_id: 'rsess-1', context: 'x' }, {});
  assert.equal(r.ok, false);
  assert.equal(r.decision_code, 'no_session_store');
});

test('executeRemote with no publisher still accepts but reports published:false', () => {
  const sessions = newStore();
  const acq = acquireRemote({ device_id: 'nas-01', runtime: 'codex' }, { registry, sessions });
  const r = executeRemote({ remote_session_id: acq.remote_session_id, context: 'x' }, { sessions, jobIdFactory: () => 'rjob-2' });
  assert.equal(r.ok, true);
  assert.equal(r.accepted, true);
  assert.equal(r.execute, false);
  assert.equal(r.published, false);
});

test('executeRemote treats a throwing publisher as published:false (never throws)', () => {
  const sessions = newStore();
  const acq = acquireRemote({ device_id: 'nas-01', runtime: 'codex' }, { registry, sessions });
  const boom = () => {
    throw new Error('publish failed');
  };
  let r;
  assert.doesNotThrow(() => {
    r = executeRemote({ remote_session_id: acq.remote_session_id, context: 'x' }, { sessions, publish: boom, jobIdFactory: () => 'rjob-3' });
  });
  assert.equal(r.ok, true);
  assert.equal(r.accepted, true);
  assert.equal(r.published, false);
});

// ── statusRemote ────────────────────────────────────────────────────────────────
test('statusRemote reports a safe session snapshot, execute:false', () => {
  const sessions = newStore();
  acquireRemote({ device_id: 'nas-01', runtime: 'codex' }, { registry, sessions });
  const r = statusRemote({}, { sessions });
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'ssh.remote.status');
  assert.equal(r.execute, false);
  assert.equal(r.decision_code, 'remote_status_reported');
  assert.equal(r.count, 1);
  assert.equal(r.sessions.length, 1);
  assert.equal(r.published, false);
});

test('statusRemote supports a device_id filter and fails closed on an invalid one', () => {
  const sessions = newStore();
  acquireRemote({ device_id: 'nas-01', runtime: 'codex' }, { registry, sessions });
  assert.equal(statusRemote({ device_id: 'nas-01' }, { sessions }).count, 1);
  assert.equal(statusRemote({ device_id: 'pi-09' }, { sessions }).count, 0);
  assert.equal(statusRemote({ device_id: 'bad id' }, { sessions }).decision_code, 'invalid_device_id');
});

test('statusRemote requires an injected session store and never leaks connection details', () => {
  assert.equal(statusRemote({}, {}).decision_code, 'no_session_store');
  const sessions = newStore();
  acquireRemote({ device_id: 'nas-01', runtime: 'codex' }, { registry, sessions });
  const json = JSON.stringify(statusRemote({}, { sessions }));
  assert.ok(!/ssh_host|ssh_user|ssh_alias|ssh_port|password|private_key/.test(json), 'no connection details');
});

test('statusRemote fails closed when injected sessions.status throws (never propagates)', () => {
  const sessions = {
    status() {
      throw new Error('status boom');
    },
  };
  let r;
  assert.doesNotThrow(() => {
    r = statusRemote({}, { sessions });
  });
  assert.equal(r.ok, false);
  assert.equal(r.execute, false);
  assert.equal(r.decision_code, 'injected_collaborator_failed');
});

// ── releaseRemote ─────────────────────────────────────────────────────────────--
test('releaseRemote soft-releases a session and publishes a safe released event', () => {
  const sessions = newStore();
  const publish = recorder();
  const acq = acquireRemote({ device_id: 'nas-01', runtime: 'codex' }, { registry, sessions, publish });
  const r = releaseRemote({ remote_session_id: acq.remote_session_id }, { sessions, publish });
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'ssh.remote.release');
  assert.equal(r.execute, false);
  assert.equal(r.ack, true);
  assert.equal(r.decision_code, 'remote_session_released');
  assert.equal(r.remote_session_id, acq.remote_session_id);
  assert.equal(r.published, true);
  assert.ok(publish.calls.some((c) => c.event.event === 'released' && c.subject.endsWith('.status')));
  // the handle is really soft-released, no longer active
  assert.equal(sessions.lookup(acq.remote_session_id).decision_code, 'session_not_active');
});

test('releaseRemote fails closed: unknown/invalid session, no store, throwing store', () => {
  const sessions = newStore();
  assert.equal(releaseRemote({ remote_session_id: 'rsess-404' }, { sessions }).decision_code, 'session_not_found');
  assert.equal(releaseRemote({ remote_session_id: 'bad id' }, { sessions }).decision_code, 'invalid_session_id');
  assert.equal(releaseRemote({ remote_session_id: 'rsess-1' }, {}).decision_code, 'no_session_store');
  const throwing = {
    release() {
      throw new Error('release boom');
    },
  };
  let r;
  assert.doesNotThrow(() => {
    r = releaseRemote({ remote_session_id: 'rsess-1' }, { sessions: throwing });
  });
  assert.equal(r.ok, false);
  assert.equal(r.decision_code, 'injected_collaborator_failed');
});

test('releaseRemote with a throwing publisher still releases, reports published:false', () => {
  const sessions = newStore();
  const acq = acquireRemote({ device_id: 'nas-01', runtime: 'codex' }, { registry, sessions });
  const boom = () => {
    throw new Error('publish boom');
  };
  let r;
  assert.doesNotThrow(() => {
    r = releaseRemote({ remote_session_id: acq.remote_session_id }, { sessions, publish: boom });
  });
  assert.equal(r.ok, true);
  assert.equal(r.ack, true);
  assert.equal(r.published, false);
});

// ── terminateRemote ─────────────────────────────────────────────────────────────
test('terminateRemote reaps via injected terminator then deletes the handle', () => {
  const sessions = newStore();
  const publish = recorder();
  const reaped = [];
  const terminator = (info) => {
    reaped.push(info);
    return { ok: true };
  };
  const acq = acquireRemote({ device_id: 'nas-01', runtime: 'codex' }, { registry, sessions, publish });
  const r = terminateRemote({ remote_session_id: acq.remote_session_id }, { sessions, publish, terminator });
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'ssh.remote.terminate');
  assert.equal(r.execute, false);
  assert.equal(r.ack, true);
  assert.equal(r.reaped, true);
  assert.equal(r.decision_code, 'remote_session_terminated');
  assert.equal(r.published, true);
  // terminator saw the device/runtime/session so a real reaper could signal it
  assert.equal(reaped.length, 1);
  assert.equal(reaped[0].remote_session_id, acq.remote_session_id);
  assert.equal(reaped[0].device_id, 'nas-01');
  assert.equal(reaped[0].runtime, 'codex');
  // the handle is gone
  assert.equal(sessions.peek(acq.remote_session_id).decision_code, 'session_not_found');
  assert.ok(publish.calls.some((c) => c.event.event === 'terminated'));
});

test('terminateRemote can reap an orphaned (active+expired) handle', () => {
  let t = 1000;
  const sessions = createSessionStore({ now: () => t, idFactory: (() => { let n = 0; return () => `rsess-${(n += 1)}`; })(), ttlMs: 100 });
  const acq = acquireRemote({ device_id: 'nas-01', runtime: 'codex' }, { registry, sessions });
  t = 2000; // far past TTL -> orphaned, but never swept by lookup
  const calls = [];
  const r = terminateRemote({ remote_session_id: acq.remote_session_id }, { sessions, terminator: (i) => { calls.push(i); return true; } });
  assert.equal(r.ok, true);
  assert.equal(r.reaped, true);
  assert.equal(calls.length, 1, 'orphan was reaped');
  assert.equal(sessions.peek(acq.remote_session_id).decision_code, 'session_not_found');
});

test('terminateRemote without a terminator still deletes, reports reaped:false', () => {
  const sessions = newStore();
  const acq = acquireRemote({ device_id: 'nas-01', runtime: 'codex' }, { registry, sessions });
  const r = terminateRemote({ remote_session_id: acq.remote_session_id }, { sessions });
  assert.equal(r.ok, true);
  assert.equal(r.ack, true);
  assert.equal(r.reaped, false);
  assert.equal(sessions.peek(acq.remote_session_id).decision_code, 'session_not_found');
});

test('terminateRemote treats a throwing terminator as reaped:false but still deletes', () => {
  const sessions = newStore();
  const acq = acquireRemote({ device_id: 'nas-01', runtime: 'codex' }, { registry, sessions });
  const boom = () => {
    throw new Error('terminator boom');
  };
  let r;
  assert.doesNotThrow(() => {
    r = terminateRemote({ remote_session_id: acq.remote_session_id }, { sessions, terminator: boom });
  });
  assert.equal(r.ok, true);
  assert.equal(r.reaped, false);
  assert.equal(sessions.peek(acq.remote_session_id).decision_code, 'session_not_found');
});

test('terminateRemote fails closed: unknown/invalid session, no store, throwing store', () => {
  const sessions = newStore();
  assert.equal(terminateRemote({ remote_session_id: 'rsess-404' }, { sessions }).decision_code, 'session_not_found');
  assert.equal(terminateRemote({ remote_session_id: 'bad id' }, { sessions }).decision_code, 'invalid_session_id');
  assert.equal(terminateRemote({ remote_session_id: 'rsess-1' }, {}).decision_code, 'no_session_store');
  const throwing = {
    peek() {
      throw new Error('peek boom');
    },
    terminate() {},
  };
  let r;
  assert.doesNotThrow(() => {
    r = terminateRemote({ remote_session_id: 'rsess-1' }, { sessions: throwing });
  });
  assert.equal(r.ok, false);
  assert.equal(r.decision_code, 'injected_collaborator_failed');
});

test('terminateRemote never invokes the terminator on a fail-closed (not-found) path', () => {
  const sessions = newStore();
  const calls = [];
  const r = terminateRemote({ remote_session_id: 'rsess-404' }, { sessions, terminator: (i) => { calls.push(i); return true; } });
  assert.equal(r.ok, false);
  assert.equal(calls.length, 0, 'no reap attempt on an unknown session');
});

test('src/remote.js imports no fs/child_process/net/http and no process.env', () => {
  const src = readFileSync(fileURLToPath(new URL('../src/remote.js', import.meta.url)), 'utf8');
  assert.ok(!/from\s+['"]node:fs|from\s+['"]fs['"]|require\(/.test(src), 'no fs import');
  assert.ok(!/node:child_process|child_process|execSync|spawn/.test(src), 'no subprocess');
  assert.ok(!/node:net|node:https?|from\s+['"]net['"]|fetch\(/.test(src), 'no network/sockets');
  assert.ok(!/process\.env/.test(src), 'no env access');
});
