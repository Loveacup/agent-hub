// Phase 7 Slice 8 — typed OMP lifecycle envelope routing tests (additive).
//
// The review-worker now recognizes a TYPED OMP lifecycle envelope (passed as an
// object `task`) BEFORE the legacy regex text detection. A typed envelope NEVER
// enables an OMP runtime: the route stays execute=false, falls back to the
// review/control plane, carries the monitorability/intervention contract, and
// leaks no raw forbidden field. Invalid/unsafe typed envelopes route to review
// with an explicit invalid/denied decision. The legacy regex path is preserved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { decideRoute } from '../src/routing.js';

const SECRET = 'sk-SECRET-VALUE-do-not-leak-0xDEADBEEF';
const BODY = 'BODY-TRANSCRIPT-do-not-leak-lorem-ipsum';

function typedEnvelope(overrides = {}) {
  return {
    task: { type: 'omp.lifecycle', action: 'discover', profile: 'page' },
    constraints: { execute: false, live: false, cross_profile: false },
    run_id: 'slice8-route-1',
    ...overrides,
  };
}

// ── 8. typed envelope recognized → review lane, execute=false, OMP unavailable ─
test('decideRoute recognizes a typed OMP lifecycle envelope and routes to review (execute=false)', () => {
  const res = decideRoute({ task: typedEnvelope() });
  assert.equal(res.lane, 'review');
  assert.equal(res.execute, false);
  assert.equal(res.requires_review, true);
  assert.equal(res.decision_code, 'omp_typed_lifecycle_review_required');

  // top-level OMP control contract (parity with the regex branches)
  assert.equal(res.monitoring_required, true);
  assert.equal(res.intervention_supported, false);
  assert.equal(res.runtime_available, false);

  // nested control_plane reflects the OMP runtime (unavailable), not review fallback
  assert.equal(res.control_plane.runtime_available, false);
  assert.equal(res.control_plane.intervenable, false);
  assert.equal(res.control_plane.monitorable, true);
  assert.equal(res.control_plane.status, 'unavailable');

  // sanitized envelope evidence is attached; the run_id propagates to the decision
  assert.equal(res.envelope_valid, true);
  assert.equal(res.envelope.type, 'omp.lifecycle');
  assert.equal(res.envelope.action, 'discover');
  assert.equal(res.envelope.profile, 'page');
  assert.equal(res.run_id, 'slice8-route-1');
});

// ── apply-plan typed envelope still routes non-executing ─────────────────────
test('decideRoute routes a typed apply-plan envelope as non-executing review', () => {
  const res = decideRoute({ task: typedEnvelope({ task: { type: 'omp.lifecycle', action: 'apply-plan', profile: 'page' } }) });
  assert.equal(res.lane, 'review');
  assert.equal(res.execute, false);
  assert.equal(res.decision_code, 'omp_typed_lifecycle_review_required');
  assert.equal(res.envelope.action, 'apply-plan');
});

// ── 9. invalid typed envelope → explicit invalid decision, no forbidden leak ──
test('decideRoute routes an invalid typed envelope to review with an explicit invalid decision', () => {
  const execTrue = decideRoute({ task: typedEnvelope({ constraints: { execute: true, live: false, cross_profile: false } }) });
  assert.equal(execTrue.lane, 'review');
  assert.equal(execTrue.execute, false);
  assert.equal(execTrue.requires_review, true);
  assert.equal(execTrue.decision_code, 'omp_lifecycle_envelope_execute_forbidden');
  assert.equal(execTrue.envelope_valid, false);
  assert.equal(execTrue.runtime_available, false);

  const unknown = decideRoute({ task: typedEnvelope({ task: { type: 'omp.lifecycle', action: 'apply' } }) });
  assert.equal(unknown.decision_code, 'omp_lifecycle_envelope_unknown_action');
  assert.equal(unknown.execute, false);
});

// ── a hostile raw action value never leaks through envelope_errors ────────────
// The unknown-action reject carries envelope_errors into the route decision; a
// body/secret-shaped action string must not survive into the decision JSON.
test('decideRoute never leaks a hostile raw action value from an invalid typed envelope', () => {
  const hostileAction = 'BODY-TRANSCRIPT-do-not-leak-lorem-ipsum';
  const res = decideRoute({ task: typedEnvelope({ task: { type: 'omp.lifecycle', action: hostileAction } }) });
  assert.equal(res.execute, false);
  assert.equal(res.decision_code, 'omp_lifecycle_envelope_unknown_action');
  assert.equal(res.envelope_valid, false);
  assert.ok(!JSON.stringify(res).includes(hostileAction), 'route decision must not leak the raw action string');

  const secretAction = decideRoute({ task: typedEnvelope({ task: { type: 'omp.lifecycle', action: SECRET } }) });
  assert.equal(secretAction.execute, false);
  assert.ok(!JSON.stringify(secretAction).includes(SECRET), 'route decision must not leak a secret-shaped action');
});

// ── forbidden fields in a typed envelope never leak into the decision JSON ────
test('decideRoute never leaks forbidden fields from a hostile typed envelope', () => {
  const res = decideRoute({
    task: {
      task: { type: 'omp.lifecycle', action: 'discover', token: SECRET, prompt: BODY },
      constraints: { execute: false, live: false, cross_profile: false, env: { OPENAI_API_KEY: SECRET } },
      session: BODY,
      logs: [BODY],
    },
  });
  assert.equal(res.lane, 'review');
  assert.equal(res.execute, false);
  assert.equal(res.decision_code, 'omp_lifecycle_envelope_forbidden_field');
  const json = JSON.stringify(res);
  assert.ok(!json.includes(SECRET), 'route decision must not leak secret');
  assert.ok(!json.includes(BODY), 'route decision must not leak body/session/log');
});

// ── 10. legacy regex OMP route still works (string task path preserved) ──────
test('decideRoute preserves the legacy regex OMP lifecycle route for string tasks', () => {
  const res = decideRoute({ task: 'omp profile discover for the page profile' });
  assert.equal(res.lane, 'review');
  assert.equal(res.execute, false);
  assert.match(res.decision_code, /^omp_/);
  assert.equal(res.monitoring_required, true);
  assert.equal(res.runtime_available, false);

  // a non-OMP string task is unaffected by the typed front door.
  const def = decideRoute({ task: 'please handle this vague thing' });
  assert.equal(def.decision_code, 'DEFAULT_REVIEW');
  assert.equal(def.execute, false);
});

// ── typed envelope route can publish via injected publisher; payload safe ────
test('decideRoute publishes a typed envelope decision via injected publisher (metadata-only)', async () => {
  const published = [];
  const res = await decideRoute({
    task: typedEnvelope(),
    publishDecision: async (subject, payload) => published.push({ subject, payload }),
    publish_route_event: true,
  });
  assert.equal(res.publish_status, 'published');
  assert.equal(published.length, 1);
  assert.equal(published[0].payload.decision.execute, false);
  assert.equal(published[0].payload.decision.decision_code, 'omp_typed_lifecycle_review_required');
  const json = JSON.stringify(published[0].payload);
  assert.ok(!json.includes(SECRET));
  assert.ok(!json.includes(BODY));
});

// ── Slice 9A: routing.js no longer reaches across into omp-worker's source ───
// The typed-envelope validator now lives in the shared contract module. routing.js
// must import it from there and must NOT contain the cross-worker relative path.
test('routing.js imports the validator from the shared contract, not from omp-worker', () => {
  const routingPath = fileURLToPath(new URL('../src/routing.js', import.meta.url));
  const src = readFileSync(routingPath, 'utf8');
  assert.ok(!src.includes('../../omp-worker/src/envelope.js'), 'routing.js must not import from omp-worker/src/envelope.js');
  assert.ok(/from\s+['"]\.\.\/\.\.\/shared\/omp-contract\.js['"]/.test(src), 'routing.js must import the validator from ../../shared/omp-contract.js');
});

// ── 13. config.yaml still registers no OMP worker runtime lane ───────────────
test('iii/config.yaml still does not register an omp-worker runtime lane', () => {
  const configPath = fileURLToPath(new URL('../../../config.yaml', import.meta.url));
  const cfg = readFileSync(configPath, 'utf8');
  assert.ok(!/name:\s*omp-worker/.test(cfg), 'config.yaml must not register omp-worker as a runtime lane');
  const res = decideRoute({ task: typedEnvelope() });
  assert.equal(res.available_workers.omp.available, false);
});
