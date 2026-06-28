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

// ── Slice 3: lifecycle (touch / release / terminate) ────────────────────────────
test('create seeds lifecycle fields: last_seen_at, released_at:null, terminated_at:null', () => {
  const now = fixedClock(1000);
  const store = createSessionStore({ now, idFactory: seqIds(), ttlMs: 1000 });
  const r = store.create({ device_id: 'nas-01', runtime: 'codex' });
  assert.equal(r.session.last_seen_at, 1000);
  assert.equal(r.session.released_at, null);
  assert.equal(r.session.terminated_at, null);
});

test('touch refreshes last_seen_at on an active, unexpired session', () => {
  const now = fixedClock(0);
  const store = createSessionStore({ now, idFactory: seqIds(), ttlMs: 1000 });
  const id = store.create({ device_id: 'nas-01', runtime: 'codex' }).session.remote_session_id;
  now.advance(500);
  const t = store.touch(id);
  assert.equal(t.ok, true);
  assert.equal(t.session.last_seen_at, 500);
  // expires_at is the creation TTL window, NOT extended by touch
  assert.equal(t.session.expires_at, 1000);
});

test('touch fails closed on unknown/invalid/expired/non-active session', () => {
  const now = fixedClock(0);
  const store = createSessionStore({ now, idFactory: seqIds(), ttlMs: 100 });
  assert.equal(store.touch('rsess-404').decision_code, 'session_not_found');
  assert.equal(store.touch('bad id').decision_code, 'invalid_session_id');
  const id = store.create({ device_id: 'nas-01', runtime: 'codex' }).session.remote_session_id;
  store.release(id);
  assert.equal(store.touch(id).decision_code, 'session_not_active');
  const id2 = store.create({ device_id: 'nas-01', runtime: 'codex' }).session.remote_session_id;
  now.advance(100);
  assert.equal(store.touch(id2).decision_code, 'session_expired');
});

test('touch fails closed when injected now() throws (never propagates)', () => {
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
    r = store.touch(id);
  });
  assert.equal(r.ok, false);
  assert.equal(r.kind, SESSION_KIND);
  assert.equal(r.session, null);
  assert.equal(r.decision_code, 'injected_collaborator_failed');
});

test('lookup with { touch:true } refreshes last_seen_at on success', () => {
  const now = fixedClock(0);
  const store = createSessionStore({ now, idFactory: seqIds(), ttlMs: 1000 });
  const id = store.create({ device_id: 'nas-01', runtime: 'codex' }).session.remote_session_id;
  now.advance(300);
  const r = store.lookup(id, { touch: true });
  assert.equal(r.ok, true);
  assert.equal(r.session.last_seen_at, 300);
});

test('release soft-releases an active session, projecting state released', () => {
  const now = fixedClock(0);
  const store = createSessionStore({ now, idFactory: seqIds(), ttlMs: 1000 });
  const id = store.create({ device_id: 'nas-01', runtime: 'codex' }).session.remote_session_id;
  now.advance(100);
  const r = store.release(id);
  assert.equal(r.ok, true);
  assert.equal(r.session.state, 'released');
  assert.equal(r.session.released_at, 100);
  // a released handle is no longer an active lookup target, but it lingers
  assert.equal(store.lookup(id).decision_code, 'session_not_active');
  assert.equal(store.size(), 1, 'released handle lingers for status/audit');
});

test('release fails closed on unknown/invalid/double/expired session', () => {
  const now = fixedClock(0);
  const store = createSessionStore({ now, idFactory: seqIds(), ttlMs: 100 });
  assert.equal(store.release('rsess-404').decision_code, 'session_not_found');
  assert.equal(store.release('bad id').decision_code, 'invalid_session_id');
  const id = store.create({ device_id: 'nas-01', runtime: 'codex' }).session.remote_session_id;
  assert.equal(store.release(id).ok, true);
  assert.equal(store.release(id).decision_code, 'session_not_active', 'double release fails closed');
  const id2 = store.create({ device_id: 'nas-01', runtime: 'codex' }).session.remote_session_id;
  now.advance(100);
  assert.equal(store.release(id2).decision_code, 'session_expired');
});

test('release fails closed when injected now() throws (never propagates)', () => {
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
    r = store.release(id);
  });
  assert.equal(r.ok, false);
  assert.equal(r.decision_code, 'injected_collaborator_failed');
});

test('terminate hard-deletes any session (active or released)', () => {
  const store = createSessionStore({ idFactory: seqIds() });
  const id = store.create({ device_id: 'nas-01', runtime: 'codex' }).session.remote_session_id;
  store.release(id);
  const r = store.terminate(id);
  assert.equal(r.ok, true);
  assert.equal(r.terminated, id);
  assert.equal(store.size(), 0);
});

// ── Slice 3: peek (state-agnostic read) ─────────────────────────────────────────
test('peek returns a session in any state without mutating or sweeping it', () => {
  const now = fixedClock(0);
  const store = createSessionStore({ now, idFactory: seqIds(), ttlMs: 100 });
  const id = store.create({ device_id: 'nas-01', runtime: 'codex' }).session.remote_session_id;
  assert.equal(store.peek(id).session.state, 'active');
  store.release(id);
  assert.equal(store.peek(id).session.state, 'released');
  now.advance(100); // expired
  // a released+expired handle reads as 'expired'; it is NOT swept by peek
  assert.equal(store.peek(id).session.state, 'expired');
  assert.equal(store.size(), 1, 'peek never sweeps');
});

test('peek reports an active+expired session as orphaned (potential orphan process)', () => {
  const now = fixedClock(0);
  // orphanMs < ttlMs so heartbeat goes stale before TTL expires
  const store = createSessionStore({ now, idFactory: seqIds(), ttlMs: 100, orphanMs: 50 });
  const id = store.create({ device_id: 'nas-01', runtime: 'codex' }).session.remote_session_id;
  now.advance(100); // past both TTL (100) and orphanMs (50)
  assert.equal(store.peek(id).session.state, 'orphaned');
});

test('peek reports an active+expired session as expired when heartbeat is still fresh', () => {
  const now = fixedClock(0);
  // orphanMs > ttlMs so TTL expires before heartbeat goes stale
  const store = createSessionStore({ now, idFactory: seqIds(), ttlMs: 100, orphanMs: 200 });
  const id = store.create({ device_id: 'nas-01', runtime: 'codex' }).session.remote_session_id;
  now.advance(100); // past TTL (100) but not orphanMs (200)
  assert.equal(store.peek(id).session.state, 'expired');
});

test('peek fails closed on unknown/invalid id', () => {
  const store = createSessionStore({ idFactory: seqIds() });
  assert.equal(store.peek('rsess-404').decision_code, 'session_not_found');
  assert.equal(store.peek('bad id').decision_code, 'invalid_session_id');
});

// ── Slice 3: status snapshot ────────────────────────────────────────────────────
test('status returns a safe lifecycle snapshot of all sessions', () => {
  const now = fixedClock(0);
  const store = createSessionStore({ now, idFactory: seqIds(), ttlMs: 1000 });
  const a = store.create({ device_id: 'nas-01', runtime: 'codex' }).session.remote_session_id;
  store.create({ device_id: 'pi-09', runtime: 'codex' });
  store.release(a);
  const s = store.status();
  assert.equal(s.ok, true);
  assert.equal(s.sessions.length, 2);
  const json = JSON.stringify(s);
  assert.ok(!/ssh_host|ssh_user|ssh_alias|ssh_port|password|private_key|token/.test(json), 'no connection details');
});

test('status filters by device_id and fails closed on an invalid device_id', () => {
  const now = fixedClock(0);
  const store = createSessionStore({ now, idFactory: seqIds(), ttlMs: 1000 });
  store.create({ device_id: 'nas-01', runtime: 'codex' });
  store.create({ device_id: 'pi-09', runtime: 'codex' });
  const s = store.status({ device_id: 'nas-01' });
  assert.equal(s.ok, true);
  assert.equal(s.sessions.length, 1);
  assert.equal(s.sessions[0].device_id, 'nas-01');
  assert.equal(store.status({ device_id: 'bad id' }).decision_code, 'invalid_device_id');
});

test('status fails closed when injected now() throws (never propagates)', () => {
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
    r = store.status();
  });
  assert.equal(r.ok, false);
  assert.equal(r.decision_code, 'injected_collaborator_failed');
});

// ── Slice 3: cleanup classifies orphans ─────────────────────────────────────────
test('cleanup reports orphaned count for active+expired (unreaped) handles', () => {
  const now = fixedClock(0);
  // orphanMs < ttlMs so heartbeat goes stale before TTL expires
  const store = createSessionStore({ now, idFactory: seqIds(), ttlMs: 100, orphanMs: 50 });
  store.create({ device_id: 'nas-01', runtime: 'codex' }); // a: will expire while active -> orphan
  const b = store.create({ device_id: 'pi-09', runtime: 'codex' }).session.remote_session_id;
  store.release(b); // b: cleanly released -> swept, not an orphan
  store.create({ device_id: 'nas-01', runtime: 'codex' }); // c: stays active+alive
  now.advance(100); // past both TTL (100) and orphanMs (50)
  const r = store.cleanup();
  // a (active+expired) -> orphaned; b (released) -> removed-not-orphaned; c (active+expired) -> orphaned
  assert.equal(r.orphaned, 2, 'two active+expired handles are orphans');
  assert.equal(r.removed, 3);
  assert.equal(r.remaining, 0);
});

test('cleanup orphaned excludes cleanly released handles', () => {
  const now = fixedClock(0);
  const store = createSessionStore({ now, idFactory: seqIds(), ttlMs: 100 });
  const a = store.create({ device_id: 'nas-01', runtime: 'codex' }).session.remote_session_id;
  store.release(a);
  now.advance(100);
  const r = store.cleanup();
  assert.equal(r.removed, 1);
  assert.equal(r.orphaned, 0, 'a released handle is not an orphan');
});

test('src/session.js imports no fs/child_process/net/http and no process.env', () => {
  const src = readFileSync(fileURLToPath(new URL('../src/session.js', import.meta.url)), 'utf8');
  assert.ok(!/from\s+['"]node:fs|from\s+['"]fs['"]|require\(/.test(src), 'no fs import');
  assert.ok(!/node:child_process|child_process|execSync|spawn/.test(src), 'no subprocess');
  assert.ok(!/node:net|node:https?|from\s+['"]net['"]|fetch\(/.test(src), 'no network/sockets');
  assert.ok(!/process\.env/.test(src), 'no process.env');
});
