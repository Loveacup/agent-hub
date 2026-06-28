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

import { acquireRemote, executeRemote } from '../src/remote.js';
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

test('src/remote.js imports no fs/child_process/net/http and no process.env', () => {
  const src = readFileSync(fileURLToPath(new URL('../src/remote.js', import.meta.url)), 'utf8');
  assert.ok(!/from\s+['"]node:fs|from\s+['"]fs['"]|require\(/.test(src), 'no fs import');
  assert.ok(!/node:child_process|child_process|execSync|spawn/.test(src), 'no subprocess');
  assert.ok(!/node:net|node:https?|from\s+['"]net['"]|fetch\(/.test(src), 'no network/sockets');
  assert.ok(!/process\.env/.test(src), 'no env access');
});
