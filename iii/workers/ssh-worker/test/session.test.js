// Phase 8 Slice 2 — in-memory remote-session store tests (pure, no I/O).
//
// src/session.js holds remote CLI session HANDLES only — never a real remote
// process. It is pure by construction: no fs / subprocess / socket, every
// function fail-closed (malformed input -> { ok:false }, never throws), session
// ids constrained to the NATS-safe token alphabet, and TTL-bounded so handles
// cannot leak forever. now()/idFactory() are injectable for deterministic tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createSessionStore } from '../src/session.js';

const SAFE_TOKEN_RE = /^[A-Za-z0-9-]+$/;
const SESSION_KIND = 'ssh.remote.session';

// Deterministic, advanceable clock.
function fixedClock(start) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => {
    t += ms;
  };
  return now;
}

// Deterministic, collision-free id factory.
function seqIds(prefix = 'rsess-') {
  let n = 0;
  return () => `${prefix}${(n += 1)}`;
}

test('create returns a safe-token session with TTL and active state', () => {
  const now = fixedClock(1000);
  const store = createSessionStore({ now, idFactory: seqIds(), ttlMs: 1000 });
  const r = store.create({ device_id: 'nas-01', runtime: 'codex' });
  assert.equal(r.ok, true);
  assert.match(r.session.remote_session_id, SAFE_TOKEN_RE);
  assert.equal(r.session.device_id, 'nas-01');
  assert.equal(r.session.runtime, 'codex');
  assert.equal(r.session.state, 'active');
  assert.equal(r.session.created_at, 1000);
  assert.equal(r.session.expires_at, 2000);
});

test('create fails closed on unsafe device_id / runtime', () => {
  const store = createSessionStore({ idFactory: seqIds() });
  for (const bad of ['', 'has space', 'dot.dot', 'star*', '../x', 'wild>']) {
    assert.equal(store.create({ device_id: bad, runtime: 'codex' }).ok, false);
    assert.equal(store.create({ device_id: 'nas-01', runtime: bad }).ok, false);
  }
  for (const bad of [undefined, null, 42, 'x', [], () => {}]) {
    assert.doesNotThrow(() => store.create(bad));
    assert.equal(store.create(bad).ok, false);
  }
});

test('create rejects an unsafe injected session id', () => {
  const store = createSessionStore({ idFactory: () => 'bad id.*' });
  const r = store.create({ device_id: 'nas-01', runtime: 'codex' });
  assert.equal(r.ok, false);
  assert.equal(r.decision_code, 'unsafe_session_id');
});

test('create fails closed when injected idFactory throws (never propagates)', () => {
  const store = createSessionStore({
    idFactory: () => {
      throw new Error('id factory boom');
    },
  });
  let r;
  assert.doesNotThrow(() => {
    r = store.create({ device_id: 'nas-01', runtime: 'codex' });
  });
  assert.equal(r.ok, false);
  assert.equal(r.kind, SESSION_KIND);
  assert.equal(r.session, null);
  assert.equal(r.decision_code, 'injected_collaborator_failed');
});

test('create fails closed when injected now() throws (never propagates)', () => {
  const store = createSessionStore({
    idFactory: seqIds(),
    now: () => {
      throw new Error('clock boom');
    },
  });
  let r;
  assert.doesNotThrow(() => {
    r = store.create({ device_id: 'nas-01', runtime: 'codex' });
  });
  assert.equal(r.ok, false);
  assert.equal(r.kind, SESSION_KIND);
  assert.equal(r.session, null);
  assert.equal(r.decision_code, 'injected_collaborator_failed');
  assert.equal(store.size(), 0, 'no partial handle is stored');
});

test('lookup fails closed when injected now() throws (never propagates)', () => {
  // Seed a handle with a clock that throws only after creation succeeds.
  let armed = false;
  const store = createSessionStore({
    idFactory: seqIds(),
    now: () => {
      if (armed) throw new Error('clock boom');
      return 1000;
    },
  });
  const id = store.create({ device_id: 'nas-01', runtime: 'codex' }).session.remote_session_id;
  armed = true;
  let r;
  assert.doesNotThrow(() => {
    r = store.lookup(id);
  });
  assert.equal(r.ok, false);
  assert.equal(r.kind, SESSION_KIND);
  assert.equal(r.session, null);
  assert.equal(r.decision_code, 'injected_collaborator_failed');
});

test('cleanup fails closed when injected now() throws (never propagates)', () => {
  // Seed a handle with a clock that throws only after creation succeeds.
  let armed = false;
  const store = createSessionStore({
    idFactory: seqIds(),
    now: () => {
      if (armed) throw new Error('clock boom');
      return 1000;
    },
  });
  store.create({ device_id: 'nas-01', runtime: 'codex' });
  armed = true;
  let r;
  assert.doesNotThrow(() => {
    r = store.cleanup();
  });
  assert.equal(r.ok, false);
  assert.equal(r.kind, SESSION_KIND);
  assert.equal(r.session, null);
  assert.equal(r.decision_code, 'injected_collaborator_failed');
  assert.equal(store.size(), 1, 'no handle is swept when the clock throws');
});

test('list fails closed when injected now() throws (never propagates)', () => {
  // Seed a handle with a clock that throws only after creation succeeds.
  let armed = false;
  const store = createSessionStore({
    idFactory: seqIds(),
    now: () => {
      if (armed) throw new Error('clock boom');
      return 1000;
    },
  });
  store.create({ device_id: 'nas-01', runtime: 'codex' });
  armed = true;
  let r;
  assert.doesNotThrow(() => {
    r = store.list();
  });
  assert.equal(r.ok, false);
  assert.equal(r.kind, SESSION_KIND);
  assert.equal(r.session, null);
  assert.equal(r.decision_code, 'injected_collaborator_failed');
});

test('lookup returns active session before TTL, expired after', () => {
  const now = fixedClock(0);
  const store = createSessionStore({ now, idFactory: seqIds(), ttlMs: 1000 });
  const id = store.create({ device_id: 'nas-01', runtime: 'codex' }).session.remote_session_id;
  now.advance(999);
  assert.equal(store.lookup(id).ok, true);
  now.advance(1); // now == expires_at -> expired
  const r = store.lookup(id);
  assert.equal(r.ok, false);
  assert.equal(r.decision_code, 'session_expired');
  assert.equal(store.size(), 0, 'expired entry is swept on lookup');
});

test('lookup fails closed on unknown / invalid id', () => {
  const store = createSessionStore({ idFactory: seqIds() });
  assert.equal(store.lookup('rsess-404').decision_code, 'session_not_found');
  assert.equal(store.lookup('bad id').decision_code, 'invalid_session_id');
  for (const bad of [undefined, null, 42, []]) {
    assert.doesNotThrow(() => store.lookup(bad));
    assert.equal(store.lookup(bad).ok, false);
  }
});

test('terminate removes a session; double terminate fails closed', () => {
  const store = createSessionStore({ idFactory: seqIds() });
  const id = store.create({ device_id: 'nas-01', runtime: 'codex' }).session.remote_session_id;
  assert.equal(store.terminate(id).ok, true);
  assert.equal(store.lookup(id).ok, false);
  assert.equal(store.terminate(id).ok, false);
  assert.equal(store.terminate(id).decision_code, 'session_not_found');
});

test('cleanup sweeps expired sessions and reports remaining', () => {
  const now = fixedClock(0);
  const store = createSessionStore({ now, idFactory: seqIds(), ttlMs: 100 });
  const a = store.create({ device_id: 'nas-01', runtime: 'codex' }).session.remote_session_id;
  now.advance(50);
  const b = store.create({ device_id: 'pi-02', runtime: 'codex' }).session.remote_session_id;
  now.advance(60); // a expired (110>=100); b alive (110<150)
  const c = store.cleanup();
  assert.equal(c.removed, 1);
  assert.equal(c.remaining, 1);
  assert.equal(store.lookup(b).ok, true);
  assert.equal(store.lookup(a).ok, false);
});

test('list projects only active, unexpired sessions and no connection details', () => {
  const now = fixedClock(0);
  const store = createSessionStore({ now, idFactory: seqIds(), ttlMs: 100 });
  store.create({ device_id: 'nas-01', runtime: 'codex' });
  const l = store.list();
  assert.equal(l.sessions.length, 1);
  const json = JSON.stringify(l);
  assert.ok(!/ssh_host|ssh_user|ssh_alias|ssh_port|password|private_key|token/.test(json), 'no secrets/connection details');
});

test('src/session.js imports no fs/child_process/net/http and no process.env', () => {
  const src = readFileSync(fileURLToPath(new URL('../src/session.js', import.meta.url)), 'utf8');
  assert.ok(!/from\s+['"]node:fs|from\s+['"]fs['"]|require\(/.test(src), 'no fs import');
  assert.ok(!/node:child_process|child_process|execSync|spawn/.test(src), 'no subprocess');
  assert.ok(!/node:net|node:https?|from\s+['"]net['"]|fetch\(/.test(src), 'no network/sockets');
  assert.ok(!/process\.env/.test(src), 'no process.env');
});
