// Phase 7 Slice 6 — OMP audit/event helper tests (TDD; pure, no filesystem).
//
// These helpers operate on INJECTED metadata only. They perform NO filesystem
// access, never read the real ~/.omp / `.env` / `mcp.json`, never inspect
// process.env, never spawn a subprocess, and never echo raw secret/body/session/
// log values. Every event is metadata-only and allowlisted BY CONSTRUCTION, and
// every function MUST NOT throw on malformed input. These tests pass only
// injected inputs and assert no raw secret/body/session/log value ever appears in
// the serialized output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  planOmpAudit,
  buildOmpLifecycleEvent,
  redactOmpEventMetadata,
} from '../src/audit.js';

// Recognizable markers — if any serialized output contains one, redaction failed.
const SECRET = 'sk-SECRET-VALUE-do-not-leak-0xDEADBEEF';
const BODY = 'BODY-TRANSCRIPT-do-not-leak-lorem-ipsum';

// The exact metadata allowlist the event layer is permitted to emit.
const ALLOWED_META_KEYS = [
  'profile',
  'lifecycle_action',
  'status',
  'decision_code',
  'check_count',
  'finding_count',
  'error_count',
  'warning_count',
  'mcp_server_count',
  'env_key_count',
  'file_action_count',
  'conflict_count',
];

// ════════════════════════════ EVENT BUILDER ═════════════════════════════════

// ── 1. emits a metadata-only, allowlisted event ──────────────────────────────
test('buildOmpLifecycleEvent emits a metadata-only allowlisted event', () => {
  const event = buildOmpLifecycleEvent({
    profile: 'page',
    lifecycle_action: 'audit',
    status: 'ok',
    decision_code: 'omp_audit_ok',
    check_count: 3,
    finding_count: 0,
    error_count: 0,
    warning_count: 1,
    mcp_server_count: 2,
    env_key_count: 4,
    file_action_count: 2,
    conflict_count: 1,
  });

  assert.equal(event.type, 'agent.omp.profile.lifecycle');
  assert.equal(event.subject, 'agent.omp.profile.page.lifecycle');
  assert.equal(event.metadata_only, true);
  assert.equal(event.redacted, true);

  // metadata carries EXACTLY the allowlist keys — nothing more.
  assert.deepEqual(Object.keys(event.metadata).sort(), [...ALLOWED_META_KEYS].sort());
  assert.equal(event.metadata.profile, 'page');
  assert.equal(event.metadata.lifecycle_action, 'audit');
  assert.equal(event.metadata.env_key_count, 4);
  assert.equal(event.metadata.mcp_server_count, 2);
});

// ── 2. subject is sanitized and stable for a profile name ────────────────────
test('buildOmpLifecycleEvent sanitizes and stably derives the subject token', () => {
  const a = buildOmpLifecycleEvent({ profile: 'Page/../weird name', lifecycle_action: 'render' });
  const b = buildOmpLifecycleEvent({ profile: 'Page/../weird name', lifecycle_action: 'render' });

  assert.equal(a.subject, b.subject, 'subject must be stable for the same profile');
  assert.match(a.subject, /^agent\.omp\.profile\.[a-z0-9_-]+\.lifecycle$/);
  assert.ok(!/\s/.test(a.subject), 'subject must not contain whitespace');
  assert.ok(!a.subject.includes('/'), 'subject must not contain slashes');

  // missing profile still yields a stable, safe subject.
  const none = buildOmpLifecycleEvent({ lifecycle_action: 'discover' });
  assert.match(none.subject, /^agent\.omp\.profile\.[a-z0-9_-]+\.lifecycle$/);
});

// ── 3. unknown / forbidden fields are dropped from event metadata ────────────
test('redactOmpEventMetadata drops unknown and forbidden content fields', () => {
  const meta = redactOmpEventMetadata({
    profile: 'page',
    lifecycle_action: 'audit',
    check_count: 2,
    // forbidden content fields and unknown keys — all must be dropped:
    env: { OPENAI_API_KEY: SECRET },
    mcp_env: { TOKEN: SECRET },
    command_output: SECRET,
    prompt_body: BODY,
    session: BODY,
    sessions: [BODY],
    memory: BODY,
    logs: [BODY],
    transcript: BODY,
    body: BODY,
    content: BODY,
    raw_value: SECRET,
    anything_else: 'nope',
  });

  assert.deepEqual(Object.keys(meta).sort(), [...ALLOWED_META_KEYS].sort());
  const json = JSON.stringify(meta);
  assert.ok(!json.includes(SECRET), 'redacted metadata must not leak secret');
  assert.ok(!json.includes(BODY), 'redacted metadata must not leak body/session/log');
});

// ── 4. serialized event never contains sample secret/body/session/log values ─
test('buildOmpLifecycleEvent serialized output never leaks secret/body/session/log', () => {
  const event = buildOmpLifecycleEvent({
    profile: 'page',
    lifecycle_action: 'apply-plan',
    status: 'ok',
    decision_code: 'omp_audit_ok',
    check_count: 1,
    // hostile payload smuggled alongside the metadata:
    env: { OPENAI_API_KEY: SECRET },
    session: BODY,
    logs: [BODY],
    transcript: BODY,
    command_output: SECRET,
  });
  const json = JSON.stringify(event);
  assert.ok(!json.includes(SECRET), 'event must not leak secret');
  assert.ok(!json.includes(BODY), 'event must not leak body/session/log');
});

// ════════════════════════════ AUDIT PLANNER ═════════════════════════════════

function injectedAuditInput() {
  return {
    profile: 'page',
    lifecycle_action: 'audit',
    registry_validation: { ok: true, errors: [] },
    env_validation: { ok: true, keys: ['A', 'B'], secret_values_included: false },
    mcp_validation: { ok: true, server_count: 2, servers: [{ name: 'x' }, { name: 'y' }] },
    render_plan: { execute: false, actions: [{ type: 'render_file' }, { type: 'render_file' }], conflicts: [{ type: 'target_exists' }] },
    summary: { metadata_only: true, has_secrets: false },
  };
}

// ── 5. deterministic checks/findings + event draft from injected summaries ───
test('planOmpAudit returns deterministic checks/findings/event from injected summaries', () => {
  const a = planOmpAudit(injectedAuditInput());
  const b = planOmpAudit(injectedAuditInput());

  assert.equal(a.kind, 'omp.profile.audit.plan');
  assert.equal(a.ok, true);
  assert.equal(a.profile, 'page');
  assert.equal(a.lifecycle_action, 'audit');
  assert.equal(a.metadata_only, true);
  assert.equal(a.redacted, true);

  // Monitorability/control-plane contract — OMP work is never fire-and-forget,
  // and while the runtime is unavailable it is explicitly not intervenable.
  assert.equal(a.control_plane.monitoring_required, true);
  assert.equal(a.control_plane.runtime_available, false);
  assert.equal(a.control_plane.intervention_supported, false);

  assert.ok(Array.isArray(a.checks) && a.checks.length >= 1);
  for (const c of a.checks) {
    assert.equal(typeof c.code, 'string');
    assert.equal(typeof c.ok, 'boolean');
    assert.equal(typeof c.message, 'string');
  }
  // deterministic: identical injected input → identical plan.
  assert.deepEqual(a, b);

  // event draft reflects the counts derived from the injected summaries.
  assert.equal(a.event_drafts.length, 1);
  const meta = a.event_drafts[0].metadata;
  assert.equal(meta.env_key_count, 2);
  assert.equal(meta.mcp_server_count, 2);
  assert.equal(meta.file_action_count, 2);
  assert.equal(meta.conflict_count, 1);
  assert.equal(meta.check_count, a.checks.length);
});

// ── 6. malformed audit input returns structured errors and never throws ──────
test('planOmpAudit returns structured errors on malformed input without throwing', () => {
  for (const bad of [undefined, null, 42, 'string', ['x'], () => {}]) {
    let res;
    assert.doesNotThrow(() => {
      res = planOmpAudit(bad);
    }, `threw on ${String(bad)}`);
    assert.equal(res.kind, 'omp.profile.audit.plan');
    assert.equal(res.ok, false);
    assert.ok(Array.isArray(res.errors) && res.errors.length >= 1);
    for (const e of res.errors) {
      assert.equal(typeof e.code, 'string');
      assert.equal(typeof e.path, 'string');
      assert.equal(typeof e.message, 'string');
    }
    assert.equal(res.metadata_only, true);
    assert.equal(res.redacted, true);
  }

  // an audit input carrying forbidden content fields is flagged, never echoed.
  const flagged = planOmpAudit({
    profile: 'page',
    lifecycle_action: 'audit',
    body: BODY,
    session: BODY,
    logs: [BODY],
  });
  assert.equal(flagged.ok, false);
  assert.ok(flagged.findings.some((f) => f.code === 'FORBIDDEN_FIELD'));
  assert.ok(!JSON.stringify(flagged).includes(BODY), 'findings must not echo body/session/log content');
});

// ── 7. event builder is pure: no fs / process.env / subprocess, no adapter ───
test('audit helpers are pure — no fs, process.env, or subprocess; work with no adapter', () => {
  // (a) functions produce results with zero options / adapters supplied.
  assert.doesNotThrow(() => buildOmpLifecycleEvent({ profile: 'page', lifecycle_action: 'audit' }));
  assert.doesNotThrow(() => planOmpAudit({ profile: 'page', lifecycle_action: 'audit' }));
  assert.doesNotThrow(() => redactOmpEventMetadata({ profile: 'page' }));

  // (b) the source module imports no I/O capability and never reaches process.env.
  const srcPath = fileURLToPath(new URL('../src/audit.js', import.meta.url));
  const src = readFileSync(srcPath, 'utf8');
  assert.ok(!/require\(|from\s+['"]node:fs|from\s+['"]fs['"]/.test(src), 'audit.js must not import fs');
  assert.ok(!/node:child_process|child_process|execSync|spawn|exec\(/.test(src), 'audit.js must not spawn subprocesses');
  assert.ok(!/process\.env/.test(src), 'audit.js must not read process.env');
  assert.ok(!/node:net|node:https?|fetch\(/.test(src), 'audit.js must not open network/sockets');
});
