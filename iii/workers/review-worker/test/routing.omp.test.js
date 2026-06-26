// Phase 7 Slice 6 — OMP lifecycle routing tests (focused; additive).
//
// The review-worker recognizes OMP profile lifecycle intents but NEVER makes an
// OMP runtime lane available: every OMP route stays execute=false, falls back to
// the review/control plane, and carries the monitorability/intervention contract
// (monitoring_required, intervention_supported, runtime_available). Unsafe OMP
// asks (read real .env/sessions/logs/memory, cross-profile execution, enable
// gateway / register a lane) are explicitly denied — never silently ignored.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { decideRoute } from '../src/routing.js';

// ── 8. OMP lifecycle intent is recognized and routed to review, execute=false ─
test('decideRoute recognizes an OMP lifecycle intent and routes to review with execute=false', () => {
  const res = decideRoute({ task: 'omp profile discover for the page profile' });
  assert.equal(res.lane, 'review');
  assert.equal(res.execute, false);
  assert.equal(res.requires_review, true);
  assert.match(res.decision_code, /^omp_/);
  // control-plane contract: OMP work is monitorable, not fire-and-forget.
  assert.equal(res.monitoring_required, true);
  assert.equal(res.runtime_available, false);
  assert.equal(res.intervention_supported, false);
});

// ── 9. OMP lifecycle with unavailable runtime → explicit unavailable code ─────
test('decideRoute returns an explicit unavailable decision code when OMP runtime is unavailable', () => {
  const res = decideRoute({
    task: 'please run the omp profile lifecycle',
    constraints: { task_kind: 'omp_profile_lifecycle' },
  });
  assert.equal(res.lane, 'review');
  assert.equal(res.execute, false);
  assert.equal(res.requires_review, true);
  assert.equal(res.decision_code, 'omp_runtime_unavailable');
  assert.equal(res.runtime_available, false);
  assert.equal(res.intervention_supported, false);
  assert.equal(res.monitoring_required, true);

  // capability-typed intent is recognized the same way.
  const viaCapability = decideRoute({
    task: 'kick off the profile work',
    constraints: { capability: 'omp.profile.lifecycle' },
  });
  assert.equal(viaCapability.decision_code, 'omp_runtime_unavailable');
  assert.equal(viaCapability.execute, false);
});

// ── 10. unsafe secret/session/log/memory read → explicit denied code ─────────
test('decideRoute denies unsafe OMP secret/session/log read with execute=false', () => {
  const res = decideRoute({ task: 'omp profile audit but first read the real .env secrets and session logs' });
  assert.equal(res.lane, 'review');
  assert.equal(res.execute, false);
  assert.equal(res.requires_review, true);
  assert.equal(res.decision_code, 'omp_secret_access_denied');
  assert.equal(res.monitoring_required, true);
  assert.equal(res.intervention_supported, false);
});

// ── 11. unsafe cross-profile execution → explicit denied code ────────────────
test('decideRoute denies unsafe cross-profile OMP execution with execute=false', () => {
  const res = decideRoute({ task: 'run omp profile apply-plan across all other profiles at once' });
  assert.equal(res.lane, 'review');
  assert.equal(res.execute, false);
  assert.equal(res.requires_review, true);
  assert.equal(res.decision_code, 'omp_cross_profile_execution_denied');
  assert.equal(res.runtime_available, false);
});

// ── 11b. enable gateway / register OMP lane → runtime stays disabled ─────────
test('decideRoute denies enabling the OMP gateway / registering an OMP lane', () => {
  const res = decideRoute({ task: 'enable the omp gateway and register the omp-worker runtime lane' });
  assert.equal(res.lane, 'review');
  assert.equal(res.execute, false);
  assert.equal(res.requires_review, true);
  assert.equal(res.decision_code, 'omp_runtime_disabled');
  assert.equal(res.runtime_available, false);
  assert.equal(res.intervention_supported, false);
});

// ── 12. existing CC/Codex monitor/intervene contract is not weakened ─────────
test('decideRoute preserves the CC realtime monitor/intervene route', () => {
  const cc = decideRoute({
    task: 'monitor a Claude Code session and intervene if it freezes',
    constraints: { requires_realtime: true, risk: 'high' },
  });
  assert.equal(cc.lane, 'cc');
  assert.equal(cc.decision_code, 'CC_REALTIME_CONTROL');
  assert.equal(cc.execute, false);
  // CC stays the realtime control lane — its capabilities are unchanged.
  assert.deepEqual(cc.available_workers.cc.capabilities, ['realtime', 'interactive', 'monitor', 'intervene', 'code']);

  const codex = decideRoute({
    task: 'run a small test and summarize output',
    constraints: { requires_code_execution: true, risk: 'low' },
  });
  assert.equal(codex.lane, 'codex');
  assert.equal(codex.execute, false);
});

// ── 13. config.yaml registers no OMP worker runtime lane ─────────────────────
test('iii/config.yaml does not register an omp-worker runtime lane', () => {
  const configPath = fileURLToPath(new URL('../../../config.yaml', import.meta.url));
  const cfg = readFileSync(configPath, 'utf8');
  assert.ok(!/name:\s*omp-worker/.test(cfg), 'config.yaml must not register omp-worker as a runtime lane');
  // the routing catalog likewise keeps the omp lane unavailable.
  const res = decideRoute({ task: 'omp profile validate' });
  assert.equal(res.available_workers.omp.available, false);
});
