// Phase 7 Slice 9A — shared OMP lifecycle contract tests (TDD; pure, no filesystem).
//
// These tests pin the SHARED contract module that both omp-worker and review-worker
// import. The validator is PURE and metadata-only BY CONSTRUCTION: it performs NO
// filesystem access, never reads the real ~/.omp / `.env` / `mcp.json`, never
// inspects process.env, never spawns a subprocess, never opens a socket, NEVER
// enables an OMP runtime (every accepted envelope asserts execute=false), and
// NEVER echoes a raw body/payload/secret/session/log/transcript value. Every
// function MUST NOT throw on malformed input.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  validateOmpLifecycleEnvelope,
  ENVELOPE_KIND,
  TASK_TYPE,
  ENVELOPE_ACTIONS,
  ACTION_TO_LIFECYCLE,
  FORBIDDEN_FIELDS,
} from '../omp-contract.js';

// Recognizable markers — if any serialized output contains one, redaction failed.
const SECRET = 'sk-SECRET-VALUE-do-not-leak-0xDEADBEEF';
const BODY = 'BODY-TRANSCRIPT-do-not-leak-lorem-ipsum';

function validEnvelope(overrides = {}) {
  return {
    task: { type: 'omp.lifecycle', action: 'discover', profile: 'page' },
    constraints: { execute: false, live: false, cross_profile: false },
    run_id: 'slice9-contract-1',
    ...overrides,
  };
}

// ── exported contract constants are stable ───────────────────────────────────
test('shared contract exports the documented constants', () => {
  assert.equal(ENVELOPE_KIND, 'omp.lifecycle.envelope');
  assert.equal(TASK_TYPE, 'omp.lifecycle');
  assert.ok(ENVELOPE_ACTIONS instanceof Set);
  for (const a of ['discover', 'render-plan', 'validate-metadata', 'audit-metadata', 'apply-plan']) {
    assert.ok(ENVELOPE_ACTIONS.has(a), `action ${a} must be allowed`);
  }
  assert.equal(ACTION_TO_LIFECYCLE['render-plan'], 'render');
  assert.ok(Array.isArray(FORBIDDEN_FIELDS) && FORBIDDEN_FIELDS.includes('secret'));
});

// ── valid typed envelope accepted and sanitized ──────────────────────────────
test('validateOmpLifecycleEnvelope accepts a valid typed envelope and sanitizes it', () => {
  const res = validateOmpLifecycleEnvelope(validEnvelope());
  assert.equal(res.ok, true);
  assert.equal(res.kind, ENVELOPE_KIND);
  assert.ok(Array.isArray(res.warnings));

  const env = res.envelope;
  assert.equal(env.type, 'omp.lifecycle');
  assert.equal(env.action, 'discover');
  assert.equal(env.lifecycle_action, 'discover');
  assert.equal(env.profile, 'page');
  assert.equal(env.run_id, 'slice9-contract-1');
  assert.equal(env.metadata_only, true);
  assert.equal(env.redacted, true);
});

// ── execute/live/cross_profile must ALL be exactly false in the output ───────
test('validateOmpLifecycleEnvelope keeps execute/live/cross_profile exactly false', () => {
  const res = validateOmpLifecycleEnvelope(validEnvelope());
  assert.equal(res.ok, true);
  assert.strictEqual(res.envelope.constraints.execute, false);
  assert.strictEqual(res.envelope.constraints.live, false);
  assert.strictEqual(res.envelope.constraints.cross_profile, false);
  assert.deepEqual(res.envelope.constraints, { execute: false, live: false, cross_profile: false });

  // any non-false constraint fails closed.
  for (const [k, code] of [
    ['execute', 'omp_lifecycle_envelope_execute_forbidden'],
    ['live', 'omp_lifecycle_envelope_live_forbidden'],
    ['cross_profile', 'omp_lifecycle_envelope_cross_profile_forbidden'],
  ]) {
    const bad = validEnvelope({ constraints: { execute: false, live: false, cross_profile: false, [k]: true } });
    const r = validateOmpLifecycleEnvelope(bad);
    assert.equal(r.ok, false, `${k}:true must reject`);
    assert.equal(r.decision_code, code);
  }
});

// ── apply-plan stays non-executing plan metadata only ────────────────────────
test('validateOmpLifecycleEnvelope treats apply-plan as non-executing metadata', () => {
  const res = validateOmpLifecycleEnvelope(validEnvelope({ task: { type: 'omp.lifecycle', action: 'apply-plan', profile: 'page' } }));
  assert.equal(res.ok, true);
  assert.equal(res.envelope.action, 'apply-plan');
  assert.equal(res.envelope.lifecycle_action, 'apply-plan');
  assert.equal(res.envelope.constraints.execute, false);
  assert.equal(res.envelope.metadata_only, true);
});

// ── forbidden fields rejected; no raw secret/body leak in the result JSON ────
test('validateOmpLifecycleEnvelope rejects forbidden fields and never echoes them', () => {
  const hostile = [
    { task: { type: 'omp.lifecycle', action: 'discover', body: BODY }, constraints: { execute: false, live: false, cross_profile: false } },
    { task: { type: 'omp.lifecycle', action: 'discover' }, constraints: { execute: false, live: false, cross_profile: false }, payload: { secret: SECRET } },
    { task: { type: 'omp.lifecycle', action: 'discover' }, constraints: { execute: false, live: false, cross_profile: false, env: { OPENAI_API_KEY: SECRET } } },
    { task: { type: 'omp.lifecycle', action: 'discover', token: SECRET, prompt: BODY }, constraints: { execute: false, live: false, cross_profile: false } },
  ];
  for (const input of hostile) {
    const res = validateOmpLifecycleEnvelope(input);
    assert.equal(res.ok, false, 'envelope carrying a forbidden field must be rejected');
    assert.equal(res.decision_code, 'omp_lifecycle_envelope_forbidden_field');
    const json = JSON.stringify(res);
    assert.ok(!json.includes(SECRET), 'rejected envelope must not leak secret');
    assert.ok(!json.includes(BODY), 'rejected envelope must not leak body/transcript');
  }
});

// ── unknown action rejected; the raw action value is never echoed ────────────
test('validateOmpLifecycleEnvelope rejects an unknown action without echoing it', () => {
  for (const action of ['apply', 'execute', 'render', 'validate', 'nope', '', 42, null]) {
    const res = validateOmpLifecycleEnvelope(validEnvelope({ task: { type: 'omp.lifecycle', action } }));
    assert.equal(res.ok, false, `action ${String(action)} must be rejected`);
    assert.equal(res.decision_code, 'omp_lifecycle_envelope_unknown_action');
  }

  const hostile = validateOmpLifecycleEnvelope(validEnvelope({ task: { type: 'omp.lifecycle', action: BODY } }));
  assert.equal(hostile.ok, false);
  assert.ok(!JSON.stringify(hostile).includes(BODY), 'reject JSON must not contain the raw action string');

  const secretAction = validateOmpLifecycleEnvelope(validEnvelope({ task: { type: 'omp.lifecycle', action: SECRET } }));
  assert.equal(secretAction.ok, false);
  assert.ok(!JSON.stringify(secretAction).includes(SECRET), 'reject JSON must not contain the raw secret action string');
});

// ── malformed input never throws ─────────────────────────────────────────────
test('validateOmpLifecycleEnvelope never throws on malformed input', () => {
  for (const bad of [undefined, null, 42, 'string', ['x'], () => {}, true, { task: 'not-an-object' }, { task: { type: 'wrong' } }]) {
    let res;
    assert.doesNotThrow(() => {
      res = validateOmpLifecycleEnvelope(bad);
    }, `threw on ${String(bad)}`);
    assert.equal(res.ok, false);
    assert.equal(res.kind, ENVELOPE_KIND);
    assert.equal(typeof res.decision_code, 'string');
    assert.ok(Array.isArray(res.errors));
  }
});

// ── source purity: no fs / process.env / subprocess / network in the module ──
test('omp-contract.js is pure — no fs, process.env, subprocess, or network', () => {
  const srcPath = fileURLToPath(new URL('../omp-contract.js', import.meta.url));
  const src = readFileSync(srcPath, 'utf8');
  assert.ok(!/require\(|from\s+['"]node:fs|from\s+['"]fs['"]/.test(src), 'must not import fs');
  assert.ok(!/node:child_process|child_process|execSync|spawn|exec\(/.test(src), 'must not spawn subprocesses');
  assert.ok(!/process\.env/.test(src), 'must not read process.env');
  assert.ok(!/node:net|node:https?|fetch\(/.test(src), 'must not open network/sockets');
});
