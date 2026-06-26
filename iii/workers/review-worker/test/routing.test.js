// Phase 6 Slice 3 routing registry tests (RED phase)
import { test } from 'node:test';
import assert from 'node:assert/strict';

const mod = await import('../src/routing.js').catch(() => ({}));
const { decideRoute, defaultWorkerCatalog, normalizeConstraints } = mod;

test('defaultWorkerCatalog exposes known lanes without enabling omp execution', () => {
  assert.ok(defaultWorkerCatalog, 'defaultWorkerCatalog must be implemented');
  const catalog = defaultWorkerCatalog();
  assert.equal(catalog.cc.available, true);
  assert.equal(catalog.codex.available, true);
  assert.equal(catalog.review.available, true);
  assert.equal(catalog.omp.available, false);
  assert.match(catalog.omp.reason, /not implemented|later|后置/i);
});

test('normalizeConstraints supplies safe defaults', () => {
  assert.ok(normalizeConstraints, 'normalizeConstraints must be implemented');
  assert.deepEqual(normalizeConstraints({}), {
    risk: 'normal',
    requires_realtime: false,
    requires_review: false,
    requires_code_execution: false,
    preferred_lane: null,
  });
});

test('decideRoute sends review-only tasks to review lane', () => {
  assert.ok(decideRoute, 'decideRoute must be implemented');
  const res = decideRoute({
    task: 'scan this diff for dangerous commands',
    constraints: { requires_review: true },
  });
  assert.equal(res.kind, 'route.decision');
  assert.equal(res.lane, 'review');
  assert.equal(res.requires_review, false);
  assert.equal(res.execute, false);
  assert.match(res.reason, /review/i);
});

test('decideRoute sends realtime intervention tasks to cc lane with review required', () => {
  const res = decideRoute({
    task: 'monitor a Claude Code session and intervene if it freezes',
    constraints: { requires_realtime: true, risk: 'high' },
  });
  assert.equal(res.lane, 'cc');
  assert.equal(res.requires_review, true);
  assert.equal(res.execute, false);
  assert.match(res.reason, /realtime|cc/i);
});

test('decideRoute sends low-risk non-realtime code execution to codex lane', () => {
  const res = decideRoute({
    task: 'run a small test and summarize output',
    constraints: { requires_code_execution: true, risk: 'low' },
  });
  assert.equal(res.lane, 'codex');
  assert.equal(res.requires_review, false);
  assert.equal(res.execute, false);
});

test('decideRoute refuses omp while omp lane is not implemented', () => {
  const res = decideRoute({
    task: 'fan out to all Hermes profiles',
    constraints: { preferred_lane: 'omp' },
  });
  assert.equal(res.lane, 'review');
  assert.equal(res.requires_review, true);
  assert.equal(res.execute, false);
  assert.match(res.reason, /omp.*not.*implemented|omp.*后置/i);
});

test('decideRoute honors available_workers overrides', () => {
  const res = decideRoute({
    task: 'run a bounded code check',
    constraints: { requires_code_execution: true, risk: 'low' },
    available_workers: {
      codex: { available: false, reason: 'offline' },
      cc: { available: true },
      review: { available: true },
    },
  });
  assert.equal(res.lane, 'cc');
  assert.equal(res.requires_review, false);
  assert.match(res.reason, /codex.*offline|fallback/i);
});

test('decideRoute marks high-risk code execution as requiring review', () => {
  const res = decideRoute({
    task: 'modify authentication code and run tests',
    constraints: { requires_code_execution: true, risk: 'high' },
  });
  assert.equal(res.lane, 'codex');
  assert.equal(res.requires_review, true);
  assert.equal(res.execute, false);
  assert.equal(res.decision_code, 'CODEX_CODE_EXECUTION');
});

test('decideRoute routes realtime tasks to review when cc is unavailable', () => {
  const res = decideRoute({
    task: 'monitor a Claude Code session and intervene if needed',
    constraints: { requires_realtime: true, risk: 'high' },
    available_workers: {
      cc: { available: false, reason: 'cc offline' },
      review: { available: true },
    },
  });
  assert.equal(res.lane, 'review');
  assert.equal(res.requires_review, true);
  assert.equal(res.execute, false);
  assert.equal(res.decision_code, 'CC_UNAVAILABLE_REVIEW_REQUIRED');
  assert.match(res.reason, /cc offline|unavailable/i);
});

test('decideRoute falls back to review when code execution workers are unavailable', () => {
  const res = decideRoute({
    task: 'run tests in the repo',
    constraints: { requires_code_execution: true, risk: 'normal' },
    available_workers: {
      codex: { available: false, reason: 'codex offline' },
      cc: { available: false, reason: 'cc offline' },
      review: { available: true },
    },
  });
  assert.equal(res.lane, 'review');
  assert.equal(res.requires_review, true);
  assert.equal(res.execute, false);
  assert.equal(res.decision_code, 'NO_EXECUTION_LANE_AVAILABLE');
});

test('decideRoute unknown tasks default to review with audit-friendly decision_code', () => {
  const res = decideRoute({ task: 'please handle this vague thing' });
  assert.equal(res.lane, 'review');
  assert.equal(res.requires_review, false);
  assert.equal(res.execute, false);
  assert.equal(res.decision_code, 'DEFAULT_REVIEW');
  assert.match(res.reason, /default safe route/i);
});
