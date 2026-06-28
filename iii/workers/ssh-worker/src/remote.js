// Phase 8 Slice 2 — acquire_remote / execute_remote orchestration (MOCKED).
//
// These are the control-plane shapes of the remote-execution lane, implemented
// against INJECTED collaborators ONLY:
//   - `registry`  — a validated host registry (see registry.js) the caller injects
//   - `sessions`  — an in-memory session-handle store (see session.js)
//   - `publish`   — a fake NATS publisher the caller injects ({subject,event} -> ok)
//   - `jobIdFactory` — optional id source for deterministic tests
//
// NOTHING here touches a real runtime:
//   - no SSH connect, no remote file write, no remote `codex exec`,
//   - no real NATS publish (the injected publisher is a stub),
//   - imports NO filesystem / subprocess / socket capability (node:crypto only,
//     for unguessable default job ids),
//   - never reads the runtime environment table.
//
// Invariants on every return:
//   - execute:false       — nothing was actually executed (PoC accept-only),
//   - redacted:true        — the request context/model/effort/secrets are NEVER
//     echoed back or placed in a published event,
//   - fail-closed          — malformed/unknown input yields { ok:false, decision_code },
//     never throws.
//
// `execute_remote` is ASYNC ACCEPTANCE ONLY: it returns { accepted:true, job_id }
// and names the turn-done subject where a real runtime would later publish the
// result (sole result channel per the design). It does NOT publish turn-done now.

import { randomUUID } from 'node:crypto';

import { buildDeviceSubject } from './subject.js';

const ACQUIRE_KIND = 'ssh.remote.acquire';
const EXECUTE_KIND = 'ssh.remote.execute';
const STATUS_KIND = 'ssh.remote.status';
const RELEASE_KIND = 'ssh.remote.release';
const TERMINATE_KIND = 'ssh.remote.terminate';
const SAFE_TOKEN_RE = /^[A-Za-z0-9-]+$/;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fail(kind, decision_code) {
  return {
    ok: false,
    kind,
    execute: false,
    accepted: false,
    decision_code,
    metadata_only: true,
    redacted: true,
    published: false,
  };
}

// Call the injected fake publisher safely. A missing/throwing/non-ok publisher
// yields published:false; it never throws and never alters acceptance.
function safePublish(publish, subject, event) {
  if (typeof publish !== 'function') return false;
  try {
    const res = publish({ subject, event });
    return res === true || (isPlainObject(res) && res.ok === true);
  } catch {
    return false;
  }
}

// Publish a SAFE device lifecycle event on the session's status subject. Builds
// the subject via the sanitizer; a malformed component or missing/throwing
// publisher yields published:false. Never throws, never alters the decision.
function publishLifecycle(publish, session, event) {
  const subjectRes = buildDeviceSubject({
    device_id: session.device_id,
    runtime: session.runtime,
    session: session.remote_session_id,
    verb: 'status',
  });
  if (!subjectRes.ok) return { subject: null, published: false };
  const published = safePublish(publish, subjectRes.subject, {
    kind: 'ssh.device.event',
    event,
    remote_session_id: session.remote_session_id,
    device_id: session.device_id,
    runtime: session.runtime,
  });
  return { subject: subjectRes.subject, published };
}

// acquire_remote — allocate a remote CLI session HANDLE against an enabled host
// with a declared runtime. Returns a safe session id + the session-scoped status
// subject (built via the sanitizer). Does NOT publish.
export function acquireRemote(input, deps) {
  const src = isPlainObject(input) ? input : {};
  const d = isPlainObject(deps) ? deps : {};
  const { registry, sessions } = d;
  const { device_id, runtime } = src;

  const hosts = isPlainObject(registry) && Array.isArray(registry.hosts) ? registry.hosts : [];
  const host = hosts.find((h) => isPlainObject(h) && h.id === device_id);
  if (!host) return fail(ACQUIRE_KIND, 'host_not_found');
  if (host.enabled !== true) return fail(ACQUIRE_KIND, 'host_disabled');

  if (typeof runtime !== 'string' || !SAFE_TOKEN_RE.test(runtime)) {
    return fail(ACQUIRE_KIND, 'invalid_runtime');
  }
  const declared = Array.isArray(host.runtimes) && host.runtimes.some((r) => isPlainObject(r) && r.name === runtime);
  if (!declared) return fail(ACQUIRE_KIND, 'runtime_not_declared');

  if (!sessions || typeof sessions.create !== 'function') {
    return fail(ACQUIRE_KIND, 'no_session_store');
  }

  let created;
  try {
    created = sessions.create({ device_id, runtime });
  } catch {
    // An injected session store that throws must not bubble out of the worker
    // entry — fail closed (the "never throws" contract beats any handle).
    return fail(ACQUIRE_KIND, 'injected_collaborator_failed');
  }
  if (!created || created.ok !== true) {
    return fail(ACQUIRE_KIND, (created && created.decision_code) || 'session_create_failed');
  }
  const { session } = created;

  const subjectRes = buildDeviceSubject({ device_id, runtime, session: session.remote_session_id, verb: 'status' });

  return {
    ok: true,
    kind: ACQUIRE_KIND,
    execute: false,
    accepted: true,
    decision_code: 'remote_session_acquired',
    remote_session_id: session.remote_session_id,
    device_id,
    runtime,
    expires_at: session.expires_at,
    subject: subjectRes.ok ? subjectRes.subject : null,
    metadata_only: true,
    redacted: true,
    published: false,
  };
}

// execute_remote — ACCEPT a turn asynchronously against a live session handle.
// Validates the session, mints a job id, publishes a status:accepted event via
// the injected fake publisher, and names the turn-done result channel. It does
// NOT run anything and NEVER echoes the request context/model/effort.
export function executeRemote(input, deps) {
  const src = isPlainObject(input) ? input : {};
  const d = isPlainObject(deps) ? deps : {};
  const { sessions, publish, jobIdFactory } = d;
  const { remote_session_id } = src;

  if (!sessions || typeof sessions.lookup !== 'function') {
    return fail(EXECUTE_KIND, 'no_session_store');
  }
  let found;
  try {
    found = sessions.lookup(remote_session_id);
  } catch {
    // A throwing injected session store fails closed, never propagates.
    return fail(EXECUTE_KIND, 'injected_collaborator_failed');
  }
  if (!found || found.ok !== true) {
    return fail(EXECUTE_KIND, (found && found.decision_code) || 'session_not_found');
  }
  const { session } = found;

  // context is required but is NEVER echoed back or published.
  if (typeof src.context !== 'string' || src.context.length === 0) {
    return fail(EXECUTE_KIND, 'invalid_context');
  }

  // Default job id: node:crypto randomUUID -> [a-f0-9-], all within the safe
  // token alphabet. Caller may inject jobIdFactory for deterministic tests.
  const makeJob = typeof jobIdFactory === 'function' ? jobIdFactory : () => `rjob-${randomUUID()}`;
  let job_id;
  try {
    job_id = makeJob();
  } catch {
    // A throwing injected id factory fails closed, never propagates.
    return fail(EXECUTE_KIND, 'injected_collaborator_failed');
  }
  if (typeof job_id !== 'string' || !SAFE_TOKEN_RE.test(job_id)) {
    return fail(EXECUTE_KIND, 'unsafe_job_id');
  }

  const statusSubject = buildDeviceSubject({
    device_id: session.device_id,
    runtime: session.runtime,
    session: session.remote_session_id,
    verb: 'status',
  });
  const turnDone = buildDeviceSubject({
    device_id: session.device_id,
    runtime: session.runtime,
    session: session.remote_session_id,
    verb: 'turn-done',
  });

  // Publish a SAFE acceptance event only — ids + state, no context/model/secret.
  let published = false;
  if (statusSubject.ok) {
    published = safePublish(publish, statusSubject.subject, {
      kind: 'ssh.device.event',
      event: 'accepted',
      job_id,
      remote_session_id: session.remote_session_id,
      device_id: session.device_id,
      runtime: session.runtime,
    });
  }

  return {
    ok: true,
    kind: EXECUTE_KIND,
    execute: false,
    accepted: true,
    decision_code: 'remote_execution_accepted',
    job_id,
    remote_session_id: session.remote_session_id,
    device_id: session.device_id,
    runtime: session.runtime,
    subject: statusSubject.ok ? statusSubject.subject : null,
    result_subject: turnDone.ok ? turnDone.subject : null,
    metadata_only: true,
    redacted: true,
    published,
  };
}

// status — report the SAFE lifecycle snapshot of remote session handles, with an
// optional device_id filter. Read-only: it never executes, never accepts, never
// publishes, and never exposes connection details (the store projects ids +
// lifecycle only). Fail-closed around the injected session store.
export function statusRemote(input, deps) {
  const src = isPlainObject(input) ? input : {};
  let sessions;
  try {
    const d = isPlainObject(deps) ? deps : {};
    sessions = d.sessions;
  } catch {
    return fail(STATUS_KIND, 'injected_collaborator_failed');
  }

  if (!sessions || typeof sessions.status !== 'function') {
    return fail(STATUS_KIND, 'no_session_store');
  }
  const query = {};
  if (src.device_id !== undefined) query.device_id = src.device_id;

  let res;
  try {
    res = sessions.status(query);
  } catch {
    return fail(STATUS_KIND, 'injected_collaborator_failed');
  }
  if (!res || res.ok !== true) {
    return fail(STATUS_KIND, (res && res.decision_code) || 'status_failed');
  }
  const list = Array.isArray(res.sessions) ? res.sessions : [];
  return {
    ok: true,
    kind: STATUS_KIND,
    execute: false,
    accepted: false,
    decision_code: 'remote_status_reported',
    sessions: list,
    count: list.length,
    metadata_only: true,
    redacted: true,
    published: false,
  };
}

// release_remote — SOFT-release a session handle (mark it released, allow the
// device to be re-acquired) and publish a SAFE `released` lifecycle event. Does
// NOT execute and never echoes any request context. Fail-closed around the store.
export function releaseRemote(input, deps) {
  const src = isPlainObject(input) ? input : {};
  let sessions, publish;
  try {
    const d = isPlainObject(deps) ? deps : {};
    sessions = d.sessions;
    publish = d.publish;
  } catch {
    return fail(RELEASE_KIND, 'injected_collaborator_failed');
  }
  const { remote_session_id } = src;

  if (!sessions || typeof sessions.release !== 'function') {
    return fail(RELEASE_KIND, 'no_session_store');
  }
  let res;
  try {
    res = sessions.release(remote_session_id);
  } catch {
    return fail(RELEASE_KIND, 'injected_collaborator_failed');
  }
  if (!res || res.ok !== true) {
    return fail(RELEASE_KIND, (res && res.decision_code) || 'release_failed');
  }
  const { session } = res;
  const { subject, published } = publishLifecycle(publish, session, 'released');

  return {
    ok: true,
    kind: RELEASE_KIND,
    execute: false,
    accepted: false,
    ack: true,
    decision_code: 'remote_session_released',
    remote_session_id: session.remote_session_id,
    device_id: session.device_id,
    runtime: session.runtime,
    subject,
    metadata_only: true,
    redacted: true,
    published,
  };
}

// terminate_remote — HARD-terminate a session handle in ANY state (active,
// released, or orphaned). It first reaps the (mock) remote process via the
// INJECTED `terminator` — no real signal is sent here — THEN deletes the handle
// and publishes a SAFE `terminated` event. A missing/throwing terminator yields
// reaped:false but the handle is still dropped (the host-side leak is always
// cleaned). Fail-closed around every injected collaborator.
export function terminateRemote(input, deps) {
  const src = isPlainObject(input) ? input : {};
  let sessions, publish, terminator;
  try {
    const d = isPlainObject(deps) ? deps : {};
    sessions = d.sessions;
    publish = d.publish;
    terminator = d.terminator;
  } catch {
    return fail(TERMINATE_KIND, 'injected_collaborator_failed');
  }
  const { remote_session_id } = src;

  if (!sessions || typeof sessions.peek !== 'function' || typeof sessions.terminate !== 'function') {
    return fail(TERMINATE_KIND, 'no_session_store');
  }
  // Resolve the handle (in any state) BEFORE reaping so the terminator/publish
  // can address the right device/runtime/session.
  let peeked;
  try {
    peeked = sessions.peek(remote_session_id);
  } catch {
    return fail(TERMINATE_KIND, 'injected_collaborator_failed');
  }
  if (!peeked || peeked.ok !== true) {
    return fail(TERMINATE_KIND, (peeked && peeked.decision_code) || 'session_not_found');
  }
  const { session } = peeked;

  // Reap the remote process via the injected mock (no real signal). A missing or
  // throwing terminator must not block the host-side cleanup below.
  let reaped = false;
  if (typeof terminator === 'function') {
    try {
      const tr = terminator({
        remote_session_id: session.remote_session_id,
        device_id: session.device_id,
        runtime: session.runtime,
      });
      reaped = tr === true || (isPlainObject(tr) && tr.ok === true);
    } catch {
      reaped = false;
    }
  }

  // Drop the host-side handle.
  let term;
  try {
    term = sessions.terminate(remote_session_id);
  } catch {
    return fail(TERMINATE_KIND, 'injected_collaborator_failed');
  }
  if (!term || term.ok !== true) {
    return fail(TERMINATE_KIND, (term && term.decision_code) || 'terminate_failed');
  }

  const { subject, published } = publishLifecycle(publish, session, 'terminated');

  return {
    ok: true,
    kind: TERMINATE_KIND,
    execute: false,
    accepted: false,
    ack: true,
    reaped,
    decision_code: 'remote_session_terminated',
    remote_session_id: session.remote_session_id,
    device_id: session.device_id,
    runtime: session.runtime,
    subject,
    metadata_only: true,
    redacted: true,
    published,
  };
}
