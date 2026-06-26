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
