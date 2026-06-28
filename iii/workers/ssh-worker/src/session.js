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
const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes
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
// connection details ever live on a session record, so none can leak.
function project(rec) {
  return {
    kind: SESSION_KIND,
    remote_session_id: rec.remote_session_id,
    device_id: rec.device_id,
    runtime: rec.runtime,
    state: rec.state,
    created_at: rec.created_at,
    expires_at: rec.expires_at,
  };
}

export function createSessionStore(options = {}) {
  const opts = isPlainObject(options) ? options : {};
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const idFactory = typeof opts.idFactory === 'function' ? opts.idFactory : () => `rsess-${randomUUID()}`;
  const ttlMs = Number.isInteger(opts.ttlMs) && opts.ttlMs > 0 ? opts.ttlMs : DEFAULT_TTL_MS;

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
    };
    sessions.set(id, rec);
    return { ok: true, session: project(rec) };
  }

  // Resolve an active, unexpired handle. Lazily sweeps a handle found expired.
  function lookup(remote_session_id) {
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
    return { ok: true, session: project(rec) };
  }

  // Drop a handle. Idempotent in effect, but reports whether one existed.
  function terminate(remote_session_id) {
    if (typeof remote_session_id !== 'string' || !SAFE_TOKEN_RE.test(remote_session_id)) {
      return { ok: false, decision_code: 'invalid_session_id' };
    }
    if (!sessions.has(remote_session_id)) {
      return { ok: false, decision_code: 'session_not_found' };
    }
    sessions.delete(remote_session_id);
    return { ok: true, terminated: remote_session_id };
  }

  // Bulk-sweep expired (and any non-active) handles.
  function cleanup() {
    let t;
    try {
      t = now();
    } catch {
      return injectedFail();
    }
    let removed = 0;
    for (const [id, rec] of sessions) {
      if (rec.state !== 'active' || isExpired(rec, t)) {
        sessions.delete(id);
        removed += 1;
      }
    }
    return { removed, remaining: sessions.size };
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

  return { create, lookup, terminate, cleanup, list, size, ttlMs };
}
