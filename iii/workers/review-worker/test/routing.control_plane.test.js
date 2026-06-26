// Phase 7 Slice 6 (follow-up) — uniform control-plane contract tests (additive).
//
// User requirement: ALL agents, including CLI-backed lanes (codex), must be
// continuously monitorable and intervenable. Every route decision therefore
// carries a `control_plane` object. This is routing metadata only — it never
// enables a runtime and never flips execute to true.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decideRoute, defaultWorkerCatalog } from '../src/routing.js';

function assertControlPlaneShape(cp) {
  assert.ok(cp && typeof cp === 'object', 'control_plane object must be present');
  for (const k of ['monitoring_required', 'intervention_required', 'monitorable', 'intervenable', 'runtime_available', 'status']) {
    assert.ok(Object.prototype.hasOwnProperty.call(cp, k), `control_plane.${k} must be present`);
  }
  assert.equal(cp.monitoring_required, true);
  assert.equal(cp.intervention_required, true);
  assert.match(cp.status, /^(available|unavailable|review_only|unsupported)$/);
}

// ── 1. Every route decision carries the control-plane contract ───────────────
test('every route decision includes a well-formed control_plane and stays execute=false', () => {
  const scenarios = [
    { task: 'scan this diff', constraints: { requires_review: true } },                                  // REVIEW_GATE_TASK
    { task: 'monitor a CC session and intervene', constraints: { requires_realtime: true } },             // CC_REALTIME_CONTROL
    { task: 'run a small test', constraints: { requires_code_execution: true, risk: 'low' } },            // CODEX_CODE_EXECUTION
    { task: 'fan out to all profiles', constraints: { preferred_lane: 'omp' } },                          // OMP_NOT_IMPLEMENTED_REVIEW_REQUIRED
    { task: 'omp profile discover for the page profile' },                                                // omp lifecycle
    { task: 'please handle this vague thing' },                                                           // DEFAULT_REVIEW
  ];
  for (const s of scenarios) {
    const res = decideRoute(s);
    assertControlPlaneShape(res.control_plane);
    assert.equal(res.execute, false, `execute must stay false for ${res.decision_code}`);
  }
});

// ── 2. Codex code-execution route is monitorable/intervenable; catalog agrees ─
test('codex route is monitorable + intervenable and catalog capabilities reflect it', () => {
  const caps = defaultWorkerCatalog().codex.capabilities;
  assert.ok(caps.includes('monitor'), 'codex catalog must advertise monitor');
  assert.ok(caps.includes('intervene'), 'codex catalog must advertise intervene');

  const res = decideRoute({
    task: 'run a small test and summarize output',
    constraints: { requires_code_execution: true, risk: 'low' },
  });
  assert.equal(res.lane, 'codex');
  assert.equal(res.decision_code, 'CODEX_CODE_EXECUTION');
  assert.equal(res.execute, false);
  assert.equal(res.control_plane.monitorable, true);
  assert.equal(res.control_plane.intervenable, true);
  assert.equal(res.control_plane.runtime_available, true);
  assert.equal(res.control_plane.status, 'available');
});

// ── 3. CC realtime route is monitorable + intervenable ───────────────────────
test('cc realtime route is monitorable + intervenable', () => {
  const res = decideRoute({
    task: 'monitor a Claude Code session and intervene if it freezes',
    constraints: { requires_realtime: true, risk: 'high' },
  });
  assert.equal(res.lane, 'cc');
  assert.equal(res.decision_code, 'CC_REALTIME_CONTROL');
  assert.equal(res.control_plane.monitorable, true);
  assert.equal(res.control_plane.intervenable, true);
  assert.equal(res.control_plane.status, 'available');
});

// ── 4. Review fallback route has explicit review-only control-plane status ───
test('review/default route is monitorable but intervention is review_only', () => {
  const res = decideRoute({ task: 'please handle this vague thing' });
  assert.equal(res.lane, 'review');
  assert.equal(res.decision_code, 'DEFAULT_REVIEW');
  assert.equal(res.control_plane.monitorable, true);
  assert.equal(res.control_plane.intervenable, false);
  assert.equal(res.control_plane.status, 'review_only');
});

// ── 5. preferred_lane:'omp' fallback shows OMP unavailable control-plane ──────
test('omp not-implemented fallback carries an OMP-unavailable control-plane contract', () => {
  const res = decideRoute({ task: 'fan out to all Hermes profiles', constraints: { preferred_lane: 'omp' } });
  assert.equal(res.lane, 'review');
  assert.equal(res.decision_code, 'OMP_NOT_IMPLEMENTED_REVIEW_REQUIRED');
  assert.equal(res.execute, false);
  assert.equal(res.requires_review, true);
  // nested contract reflects the OMP runtime, not the review fallback lane.
  assert.equal(res.control_plane.runtime_available, false);
  assert.equal(res.control_plane.intervenable, false);
  assert.equal(res.control_plane.monitorable, true);
  assert.equal(res.control_plane.status, 'unavailable');
  // top-level OMP fields stay for parity with the lifecycle branches.
  assert.equal(res.monitoring_required, true);
  assert.equal(res.intervention_supported, false);
  assert.equal(res.runtime_available, false);
});

// ── 6. OMP lifecycle decision also carries the nested OMP-unavailable contract ─
test('omp lifecycle decision carries both top-level and nested OMP-unavailable contract', () => {
  const res = decideRoute({ task: 'omp profile discover for the page profile' });
  assert.match(res.decision_code, /^omp_/);
  assert.equal(res.execute, false);
  // existing top-level contract (unchanged)
  assert.equal(res.monitoring_required, true);
  assert.equal(res.intervention_supported, false);
  assert.equal(res.runtime_available, false);
  // new nested contract
  assert.equal(res.control_plane.runtime_available, false);
  assert.equal(res.control_plane.intervenable, false);
  assert.equal(res.control_plane.status, 'unavailable');
});

// ── 7. Adding control_plane does not change lane/decision_code/execute ────────
test('control_plane is purely additive: lane/decision_code/execute unchanged', () => {
  const cc = decideRoute({ task: 'monitor a session', constraints: { requires_realtime: true, risk: 'high' } });
  assert.equal(cc.lane, 'cc');
  assert.equal(cc.decision_code, 'CC_REALTIME_CONTROL');
  assert.equal(cc.requires_review, true);
  assert.equal(cc.execute, false);

  // unavailable cc → review fallback is still review_only in control-plane terms.
  const fallback = decideRoute({
    task: 'monitor a session and intervene',
    constraints: { requires_realtime: true, risk: 'high' },
    available_workers: { cc: { available: false, reason: 'cc offline' }, review: { available: true } },
  });
  assert.equal(fallback.lane, 'review');
  assert.equal(fallback.decision_code, 'CC_UNAVAILABLE_REVIEW_REQUIRED');
  assert.equal(fallback.control_plane.status, 'review_only');
  assert.equal(fallback.execute, false);
});

// ── 8. NATS route event payload includes the control-plane contract ──────────
test('published route event carries the control_plane contract', async () => {
  const published = [];
  const res = await decideRoute({
    task: 'run a small test and summarize output',
    constraints: { requires_code_execution: true, risk: 'low' },
    publishDecision: async (subject, payload) => published.push({ subject, payload }),
    publish_route_event: true,
    run_id: 'cp-smoke-1',
  });
  assert.equal(res.publish_status, 'published');
  assert.equal(published.length, 1);
  assertControlPlaneShape(published[0].payload.decision.control_plane);
  assert.equal(published[0].payload.decision.execute, false);
});
