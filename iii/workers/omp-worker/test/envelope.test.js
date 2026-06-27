// Phase 7 Slice 8 — OMP typed lifecycle envelope tests (TDD; pure, no filesystem).
//
// The typed envelope lets the review-worker recognize OMP lifecycle intents
// STRUCTURALLY (not just via regex text). The validator is PURE and metadata-
// only BY CONSTRUCTION: it performs NO filesystem access, never reads the real
// ~/.omp / `.env` / `mcp.json`, never inspects process.env, never spawns a
// subprocess, never opens a socket, NEVER enables an OMP runtime (every accepted
// envelope asserts execute=false), and NEVER echoes a raw body/payload/secret/
// session/log/transcript value. Every function MUST NOT throw on malformed input.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  validateOmpLifecycleEnvelope,
  buildEnvelopeLifecycleEvent,
  publishEnvelopeLifecycleEvent,
} from '../src/envelope.js';

// Recognizable markers — if any serialized output contains one, redaction failed.
const SECRET = 'sk-SECRET-VALUE-do-not-leak-0xDEADBEEF';
const BODY = 'BODY-TRANSCRIPT-do-not-leak-lorem-ipsum';

function validEnvelope(overrides = {}) {
  return {
    task: { type: 'omp.lifecycle', action: 'discover', profile: 'page' },
    constraints: { execute: false, live: false, cross_profile: false },
    run_id: 'slice8-smoke-1',
    ...overrides,
  };
}

// ── 2. valid typed envelope accepted and sanitized ───────────────────────────
test('validateOmpLifecycleEnvelope accepts a valid typed envelope and sanitizes it', () => {
  const res = validateOmpLifecycleEnvelope(validEnvelope());
  assert.equal(res.ok, true);
  assert.equal(res.kind, 'omp.lifecycle.envelope');
  assert.ok(Array.isArray(res.warnings));

  const env = res.envelope;
  assert.equal(env.type, 'omp.lifecycle');
  assert.equal(env.action, 'discover');
  assert.equal(env.lifecycle_action, 'discover');
  assert.equal(env.profile, 'page');
  assert.equal(env.run_id, 'slice8-smoke-1');
  assert.equal(env.metadata_only, true);
  assert.equal(env.redacted, true);
  // metadata-only, non-executing constraints survive as exactly false.
  assert.deepEqual(env.constraints, { execute: false, live: false, cross_profile: false });

  // a hostile profile token is sanitized to a single safe segment, never echoed raw.
  const weird = validateOmpLifecycleEnvelope(validEnvelope({ task: { type: 'omp.lifecycle', action: 'render-plan', profile: 'Page/../weird name' } }));
  assert.equal(weird.ok, true);
  assert.match(weird.envelope.profile, /^[a-z0-9_-]+$/);
  assert.ok(!weird.envelope.profile.includes('/'));
  assert.ok(!weird.envelope.profile.includes(' '));
});

// ── 3. valid apply-plan envelope stays metadata-only and non-executing ───────
test('validateOmpLifecycleEnvelope accepts apply-plan as non-executing plan metadata only', () => {
  const res = validateOmpLifecycleEnvelope(validEnvelope({
    task: { type: 'omp.lifecycle', action: 'apply-plan', profile: 'page' },
  }));
  assert.equal(res.ok, true);
  assert.equal(res.envelope.action, 'apply-plan');
  assert.equal(res.envelope.lifecycle_action, 'apply-plan');
  // apply-plan must NOT imply apply execution.
  assert.equal(res.envelope.constraints.execute, false);
  assert.equal(res.envelope.metadata_only, true);
});

// ── 4. unknown action rejected ───────────────────────────────────────────────
test('validateOmpLifecycleEnvelope rejects an unknown action', () => {
  for (const action of ['apply', 'execute', 'render', 'validate', 'nope', '', 42, null]) {
    const res = validateOmpLifecycleEnvelope(validEnvelope({ task: { type: 'omp.lifecycle', action } }));
    assert.equal(res.ok, false, `action ${String(action)} must be rejected`);
    assert.equal(res.decision_code, 'omp_lifecycle_envelope_unknown_action');
    assert.ok(Array.isArray(res.errors) && res.errors.length >= 1);
  }
});

// ── 4b. an unknown action's RAW value never rides out in the reject JSON ──────
// A hostile typed envelope can stuff a body/secret/transcript-shaped string into
// task.action; the unknown-action error must describe it only by kind, never by
// content, so it cannot leak through review-worker's envelope_errors.
test('validateOmpLifecycleEnvelope never echoes a hostile raw action value', () => {
  const hostileAction = 'BODY-TRANSCRIPT-do-not-leak-lorem-ipsum';
  const res = validateOmpLifecycleEnvelope(validEnvelope({ task: { type: 'omp.lifecycle', action: hostileAction } }));
  assert.equal(res.ok, false);
  assert.equal(res.decision_code, 'omp_lifecycle_envelope_unknown_action');
  assert.ok(!JSON.stringify(res).includes(hostileAction), 'reject JSON must not contain the raw action string');

  // a secret-looking action value is likewise never echoed.
  const secretAction = validateOmpLifecycleEnvelope(validEnvelope({ task: { type: 'omp.lifecycle', action: SECRET } }));
  assert.equal(secretAction.ok, false);
  assert.ok(!JSON.stringify(secretAction).includes(SECRET), 'reject JSON must not contain the raw secret action string');
});

// ── 5. execute:true / live:true / cross_profile:true rejected ────────────────
test('validateOmpLifecycleEnvelope rejects executing/live/cross-profile constraints', () => {
  const execTrue = validateOmpLifecycleEnvelope(validEnvelope({ constraints: { execute: true, live: false, cross_profile: false } }));
  assert.equal(execTrue.ok, false);
  assert.equal(execTrue.decision_code, 'omp_lifecycle_envelope_execute_forbidden');

  const liveTrue = validateOmpLifecycleEnvelope(validEnvelope({ constraints: { execute: false, live: true, cross_profile: false } }));
  assert.equal(liveTrue.ok, false);
  assert.equal(liveTrue.decision_code, 'omp_lifecycle_envelope_live_forbidden');

  const crossTrue = validateOmpLifecycleEnvelope(validEnvelope({ constraints: { execute: false, live: false, cross_profile: true } }));
  assert.equal(crossTrue.ok, false);
  assert.equal(crossTrue.decision_code, 'omp_lifecycle_envelope_cross_profile_forbidden');

  // a missing constraint (not exactly false) also rejects — fail closed.
  const missing = validateOmpLifecycleEnvelope({ task: { type: 'omp.lifecycle', action: 'discover' } });
  assert.equal(missing.ok, false);
  assert.equal(missing.decision_code, 'omp_lifecycle_envelope_execute_forbidden');
});

// ── 6. forbidden content fields rejected and never appear in output JSON ──────
test('validateOmpLifecycleEnvelope rejects forbidden content fields and never echoes them', () => {
  const hostile = [
    { task: { type: 'omp.lifecycle', action: 'discover', body: BODY }, constraints: { execute: false, live: false, cross_profile: false } },
    { task: { type: 'omp.lifecycle', action: 'discover' }, constraints: { execute: false, live: false, cross_profile: false }, payload: { secret: SECRET } },
    { task: { type: 'omp.lifecycle', action: 'discover' }, constraints: { execute: false, live: false, cross_profile: false, env: { OPENAI_API_KEY: SECRET } } },
    { task: { type: 'omp.lifecycle', action: 'discover' }, constraints: { execute: false, live: false, cross_profile: false }, session: BODY, logs: [BODY], transcript: BODY },
    { task: { type: 'omp.lifecycle', action: 'discover', token: SECRET, prompt: BODY }, constraints: { execute: false, live: false, cross_profile: false } },
  ];
  for (const input of hostile) {
    const res = validateOmpLifecycleEnvelope(input);
    assert.equal(res.ok, false, 'envelope carrying a forbidden field must be rejected');
    assert.equal(res.decision_code, 'omp_lifecycle_envelope_forbidden_field');
    const json = JSON.stringify(res);
    assert.ok(!json.includes(SECRET), 'rejected envelope must not leak secret');
    assert.ok(!json.includes(BODY), 'rejected envelope must not leak body/session/log/transcript');
  }
});

// ── 7. malformed input never throws ──────────────────────────────────────────
test('validateOmpLifecycleEnvelope never throws on malformed input', () => {
  for (const bad of [undefined, null, 42, 'string', ['x'], () => {}, true, { task: 'not-an-object' }, { task: { type: 'wrong' } }]) {
    let res;
    assert.doesNotThrow(() => {
      res = validateOmpLifecycleEnvelope(bad);
    }, `threw on ${String(bad)}`);
    assert.equal(res.ok, false);
    assert.equal(res.kind, 'omp.lifecycle.envelope');
    assert.equal(typeof res.decision_code, 'string');
    assert.ok(Array.isArray(res.errors));
  }
});

// ── 11. fake publisher smoke: injected publisher only, payload metadata-only ──
test('publishEnvelopeLifecycleEvent uses an injected publisher and stays metadata-only', async () => {
  const { envelope } = validateOmpLifecycleEnvelope(validEnvelope({ task: { type: 'omp.lifecycle', action: 'audit-metadata', profile: 'page' } }));

  // build-only is metadata-only and reuses the audit allowlist.
  const built = buildEnvelopeLifecycleEvent(envelope, { decision_code: 'omp_typed_lifecycle_review_required' });
  assert.equal(built.metadata_only, true);
  assert.equal(built.type, 'agent.omp.profile.lifecycle');
  assert.equal(built.metadata.lifecycle_action, 'audit');

  const published = [];
  const fakePublish = async (subject, payload) => { published.push({ subject, payload }); };
  const res = await publishEnvelopeLifecycleEvent(envelope, fakePublish, { decision_code: 'omp_typed_lifecycle_review_required' });

  assert.equal(res.ok, true);
  assert.equal(res.published, true);
  assert.equal(published.length, 1);
  assert.match(published[0].subject, /^agent\.omp\.profile\.[a-z0-9_-]+\.lifecycle$/);

  const payload = published[0].payload;
  assert.equal(payload.metadata_only, true);
  assert.equal(payload.redacted, true);
  // metadata is exactly the audit allowlist — no raw body/payload/secret keys.
  const ALLOWED_META_KEYS = [
    'profile', 'lifecycle_action', 'status', 'decision_code',
    'check_count', 'finding_count', 'error_count', 'warning_count',
    'mcp_server_count', 'env_key_count', 'file_action_count', 'conflict_count',
  ];
  for (const k of Object.keys(payload.metadata)) {
    assert.ok(ALLOWED_META_KEYS.includes(k), `metadata key ${k} must be allowlisted`);
  }
  const json = JSON.stringify(payload);
  assert.ok(!json.includes(SECRET));
  assert.ok(!json.includes(BODY));
});

// ── publisher requires an injected publisher; no live NATS / network fallback ─
test('publishEnvelopeLifecycleEvent fails closed without an injected publisher', async () => {
  const { envelope } = validateOmpLifecycleEnvelope(validEnvelope());
  const res = await publishEnvelopeLifecycleEvent(envelope, undefined);
  assert.equal(res.ok, false);
  assert.equal(res.published, false);
  assert.equal(res.decision_code, 'omp_envelope_publish_no_publisher');
});

// ── purity: no fs / process.env / subprocess / network in the source module ──
test('envelope.js is pure — no fs, process.env, subprocess, or network', () => {
  const srcPath = fileURLToPath(new URL('../src/envelope.js', import.meta.url));
  const src = readFileSync(srcPath, 'utf8');
  assert.ok(!/require\(|from\s+['"]node:fs|from\s+['"]fs['"]/.test(src), 'envelope.js must not import fs');
  assert.ok(!/node:child_process|child_process|execSync|spawn|exec\(/.test(src), 'envelope.js must not spawn subprocesses');
  assert.ok(!/process\.env/.test(src), 'envelope.js must not read process.env');
  assert.ok(!/node:net|node:https?|fetch\(/.test(src), 'envelope.js must not open network/sockets');
});
