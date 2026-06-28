// Phase 8 Slice 2 — in-memory remote-session store (handles only, no I/O).
//
// This store tracks remote CLI session HANDLES allocated by `acquire_remote`
// (see remote.js). It does NOT open SSH, start a remote process, or publish
// NATS — a handle is just bookkeeping the host-side worker keeps so it can later
// (in a real runtime) address / reap a remote session.
//
// PURE + fail-closed BY CONSTRUCTION:
//   - imports NO filesystem / subprocess / socket capability (node:crypto only,
//     for unguessable default ids),
//   - never reads the runtime environment table,
//   - session ids are constrained to the NATS-safe token alphabet [A-Za-z0-9-]
//     so a handle can be embedded in a device subject without injection,
//   - every handle is TTL-bounded (default 30min) so it cannot leak forever;
//     expiry is enforced lazily on lookup and in bulk via cleanup(),
//   - every function returns a structured result and NEVER throws on bad input.
//
// now() and idFactory() are injectable for deterministic tests.

import { randomUUID } from 'node:crypto';

const SESSION_KIND = 'ssh.remote.session';
const SESSION_LIST_KIND = 'ssh.remote.session_list';
const SESSION_STATUS_KIND = 'ssh.remote.session_status';
const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes
const DEFAULT_ORPHAN_MS = 2 * DEFAULT_TTL_MS; // 60 minutes — heartbeat window for orphan detection
const SAFE_TOKEN_RE = /^[A-Za-z0-9-]+$/;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// A throwing injected collaborator (now()/idFactory()) must not bubble out of a
// store method — every function fails closed with a structured result instead.
function injectedFail() {
  return { ok: false, kind: SESSION_KIND, session: null, decision_code: 'injected_collaborator_failed' };
}

// Project a stored record to a SAFE handle view — ids + lifecycle only. No SSH
// connection details ever live on a session record, so none can leak. An
// optional `state` override lets status()/peek() report an EFFECTIVE lifecycle
// state (orphaned/expired) computed against the clock, without mutating storage.
function project(rec, stateOverride) {
  return {
    kind: SESSION_KIND,
    remote_session_id: rec.remote_session_id,
    device_id: rec.device_id,
    runtime: rec.runtime,
    state: typeof stateOverride === 'string' ? stateOverride : rec.state,
    created_at: rec.created_at,
    expires_at: rec.expires_at,
    last_seen_at: rec.last_seen_at,
    released_at: rec.released_at,
    terminated_at: rec.terminated_at,
  };
}

// Effective lifecycle state of a stored record at time t. Uses TWO independent
// windows:
//   - TTL: expires_at = created_at + ttlMs — the session's natural lifetime.
//   - Heartbeat: last_seen_at + orphanMs — how long since anyone touched it.
//
// An `active` handle past its TTL is EXPIRED (session lifetime ended).
// An `active` handle whose last heartbeat is stale past orphanMs is an ORPHAN
// (remote process likely still running with no one tracking it).
// A `released` handle past TTL has simply `expired`.
// Live handles keep their stored state.
function effectiveState(rec, t, orphanMs) {
  const expired = t >= rec.expires_at;
  const staleHeartbeat = t >= rec.last_seen_at + orphanMs;
  if (rec.state === 'released') return expired ? 'expired' : 'released';
  if (staleHeartbeat) return 'orphaned';
  if (expired) return 'expired';
  return 'active';
}

export function createSessionStore(options = {}) {
  const opts = isPlainObject(options) ? options : {};
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const idFactory = typeof opts.idFactory === 'function' ? opts.idFactory : () => `rsess-${randomUUID()}`;
  const ttlMs = Number.isInteger(opts.ttlMs) && opts.ttlMs > 0 ? opts.ttlMs : DEFAULT_TTL_MS;
  const orphanMs = Number.isInteger(opts.orphanMs) && opts.orphanMs > 0 ? opts.orphanMs : DEFAULT_ORPHAN_MS;

  const sessions = new Map();

  function isExpired(rec, t) {
    return t >= rec.expires_at;
  }

  // Allocate a new handle for an enabled host + declared runtime. The CALLER
  // (remote.js) is responsible for validating the host/runtime against the
  // registry; here we defend in depth by re-checking the token shapes.
  function create(input = {}) {
    const src = isPlainObject(input) ? input : {};
    const { device_id, runtime } = src;
    if (typeof device_id !== 'string' || !SAFE_TOKEN_RE.test(device_id)) {
      return { ok: false, decision_code: 'invalid_device_id' };
    }
    if (typeof runtime !== 'string' || !SAFE_TOKEN_RE.test(runtime)) {
      return { ok: false, decision_code: 'invalid_runtime' };
    }
    let id;
    try {
      id = idFactory();
    } catch {
      return injectedFail();
    }
    if (typeof id !== 'string' || !SAFE_TOKEN_RE.test(id)) {
      return { ok: false, decision_code: 'unsafe_session_id' };
    }
    if (sessions.has(id)) {
      return { ok: false, decision_code: 'session_id_collision' };
    }
    let created_at;
    try {
      created_at = now();
    } catch {
      return injectedFail();
    }
    const rec = {
      remote_session_id: id,
      device_id,
      runtime,
      state: 'active',
      created_at,
      expires_at: created_at + ttlMs,
      last_seen_at: created_at,
      released_at: null,
      terminated_at: null,
    };
    sessions.set(id, rec);
    return { ok: true, session: project(rec) };
  }

  // Resolve an active, unexpired handle. Lazily sweeps a handle found expired
  // ON THE LOOKUP PATH (normal access reaps cleanly). With { touch:true } the
  // handle's last_seen_at is refreshed (a liveness heartbeat) on success.
  function lookup(remote_session_id, opts) {
    if (typeof remote_session_id !== 'string' || !SAFE_TOKEN_RE.test(remote_session_id)) {
      return { ok: false, decision_code: 'invalid_session_id' };
    }
    const rec = sessions.get(remote_session_id);
    if (!rec) {
      return { ok: false, decision_code: 'session_not_found' };
    }
    if (rec.state !== 'active') {
      return { ok: false, decision_code: 'session_not_active' };
    }
    let t;
    try {
      t = now();
    } catch {
      return injectedFail();
    }
    if (isExpired(rec, t)) {
      sessions.delete(remote_session_id);
      return { ok: false, decision_code: 'session_expired' };
    }
    if (isPlainObject(opts) && opts.touch === true) {
      rec.last_seen_at = t;
    }
    return { ok: true, session: project(rec) };
  }

  // Refresh last_seen_at on an active, unexpired handle (a liveness heartbeat).
  // Does NOT extend the TTL window — only records that the handle was just seen.
  function touch(remote_session_id) {
    if (typeof remote_session_id !== 'string' || !SAFE_TOKEN_RE.test(remote_session_id)) {
      return { ok: false, decision_code: 'invalid_session_id' };
    }
    const rec = sessions.get(remote_session_id);
    if (!rec) {
      return { ok: false, decision_code: 'session_not_found' };
    }
    if (rec.state !== 'active') {
      return { ok: false, decision_code: 'session_not_active' };
    }
    let t;
    try {
      t = now();
    } catch {
      return injectedFail();
    }
    if (isExpired(rec, t)) {
      // Leave the (now orphaned) handle in place for cleanup() to reap+report;
      // a heartbeat must not silently delete a potential orphan process handle.
      return { ok: false, decision_code: 'session_expired' };
    }
    rec.last_seen_at = t;
    return { ok: true, session: project(rec) };
  }

  // Soft-release an active handle: mark it `released` and stamp released_at. The
  // record LINGERS (it is not deleted) so status()/audit can see it and so a
  // never-reclaimed release can later be detected as an orphan; the device is
  // free to be re-acquired (acquire always mints a fresh handle).
  function release(remote_session_id) {
    if (typeof remote_session_id !== 'string' || !SAFE_TOKEN_RE.test(remote_session_id)) {
      return { ok: false, decision_code: 'invalid_session_id' };
    }
    const rec = sessions.get(remote_session_id);
    if (!rec) {
      return { ok: false, decision_code: 'session_not_found' };
    }
    if (rec.state !== 'active') {
      return { ok: false, decision_code: 'session_not_active' };
    }
    let t;
    try {
      t = now();
    } catch {
      return injectedFail();
    }
    if (isExpired(rec, t)) {
      // An expired active handle is already an orphan — leave it for cleanup().
      return { ok: false, decision_code: 'session_expired' };
    }
    rec.state = 'released';
    rec.released_at = t;
    rec.last_seen_at = t;
    return { ok: true, session: project(rec) };
  }

  // Drop a handle, in ANY state. Idempotent in effect, but reports whether one
  // existed; returns the SAFE projection of the just-removed handle so a caller
  // (remote.js terminate_remote) can address a real reaper after deletion.
  function terminate(remote_session_id) {
    if (typeof remote_session_id !== 'string' || !SAFE_TOKEN_RE.test(remote_session_id)) {
      return { ok: false, decision_code: 'invalid_session_id' };
    }
    const rec = sessions.get(remote_session_id);
    if (!rec) {
      return { ok: false, decision_code: 'session_not_found' };
    }
    sessions.delete(remote_session_id);
    return { ok: true, terminated: remote_session_id, session: project(rec, 'terminated') };
  }

  // Read a handle in ANY state WITHOUT mutating or sweeping it, reporting its
  // EFFECTIVE state (orphaned/expired computed against the clock). Used by the
  // terminate path to address a session that lookup() would reject (released or
  // orphaned) before reaping it.
  function peek(remote_session_id) {
    if (typeof remote_session_id !== 'string' || !SAFE_TOKEN_RE.test(remote_session_id)) {
      return { ok: false, decision_code: 'invalid_session_id' };
    }
    const rec = sessions.get(remote_session_id);
    if (!rec) {
      return { ok: false, decision_code: 'session_not_found' };
    }
    let t;
    try {
      t = now();
    } catch {
      return injectedFail();
    }
    return { ok: true, session: project(rec, effectiveState(rec, t, orphanMs)) };
  }

  // Read-only lifecycle snapshot of ALL handles (optionally filtered to one
  // device), each reported with its EFFECTIVE state. Never mutates/sweeps and
  // never exposes connection details.
  function status(input = {}) {
    const src = isPlainObject(input) ? input : {};
    const hasFilter = src.device_id !== undefined && src.device_id !== null;
    if (hasFilter && (typeof src.device_id !== 'string' || !SAFE_TOKEN_RE.test(src.device_id))) {
      return { ok: false, decision_code: 'invalid_device_id' };
    }
    let t;
    try {
      t = now();
    } catch {
      return injectedFail();
    }
    const out = [];
    for (const rec of sessions.values()) {
      if (hasFilter && rec.device_id !== src.device_id) continue;
      out.push(project(rec, effectiveState(rec, t, orphanMs)));
    }
    return { ok: true, kind: SESSION_STATUS_KIND, sessions: out };
  }

  // Bulk-sweep stale/expired/orphaned handles. Reports `orphaned`: the count of
  // swept handles that were ACTIVE with stale heartbeat (nobody released or
  // terminated them, so their remote process likely leaked and needs reaping).
  // Also reports `expired`: active handles past TTL but still heartbeat-fresh.
  function cleanup() {
    let t;
    try {
      t = now();
    } catch {
      return injectedFail();
    }
    let removed = 0;
    let orphaned = 0;
    let expired = 0;
    for (const [id, rec] of sessions) {
      const eff = effectiveState(rec, t, orphanMs);
      if (rec.state !== 'active' || eff !== 'active') {
        if (eff === 'orphaned') orphaned += 1;
        else if (eff === 'expired') expired += 1;
        sessions.delete(id);
        removed += 1;
      }
    }
    return { removed, remaining: sessions.size, orphaned, expired };
  }

  // Project all active, unexpired handles (does not mutate; sweep via cleanup()).
  function list() {
    let t;
    try {
      t = now();
    } catch {
      return injectedFail();
    }
    const out = [];
    for (const rec of sessions.values()) {
      if (rec.state === 'active' && !isExpired(rec, t)) {
        out.push(project(rec));
      }
    }
    return { kind: SESSION_LIST_KIND, sessions: out };
  }

  function size() {
    return sessions.size;
  }

  return { create, lookup, touch, release, terminate, peek, status, cleanup, list, size, ttlMs };
}
