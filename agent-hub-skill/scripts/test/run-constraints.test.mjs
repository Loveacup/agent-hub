// Tests for run-constraints.mjs — pure, no fs/network
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeConstraints,
  validateConstraints,
  constraintSummary,
} from '../lib/run-constraints.mjs';

// ── normalizeConstraints ─────────────────────────────────────────────────────

test('normalizeConstraints with full input preserves all fields', () => {
  const input = {
    what: 'implement suggestion router',
    why: 'complete monitoring loop',
    who: { requestor: 'Hermes/default', assignee_lane: 'cc-worker' },
    where: { repo: '/Users/alexcai/code/agent-hub', paths: ['agent-hub-skill/scripts/run-cc-task.mjs'] },
    how: { allowed_actions: ['read', 'write_workspace'], forbidden_actions: ['git_push', 'modify_cc_tmux'] },
    how_much: { max_ticks: 60, interval_ms: 10000, timeout_ms: 90000 },
    acceptance: ['tests pass', 'suggestions.jsonl exists'],
  };
  const c = normalizeConstraints(input);
  assert.equal(c.what, 'implement suggestion router');
  assert.equal(c.why, 'complete monitoring loop');
  assert.equal(c.who.requestor, 'Hermes/default');
  assert.equal(c.who.assignee_lane, 'cc-worker');
  assert.equal(c.where.repo, '/Users/alexcai/code/agent-hub');
  assert.deepEqual(c.where.paths, ['agent-hub-skill/scripts/run-cc-task.mjs']);
  assert.deepEqual(c.how.allowed_actions, ['read', 'write_workspace']);
  assert.deepEqual(c.how.forbidden_actions, ['git_push', 'modify_cc_tmux']);
  assert.equal(c.how_much.max_ticks, 60);
  assert.equal(c.how_much.interval_ms, 10000);
  assert.equal(c.how_much.timeout_ms, 90000);
  assert.deepEqual(c.acceptance, ['tests pass', 'suggestions.jsonl exists']);
});

test('normalizeConstraints with empty input returns safe defaults', () => {
  const c = normalizeConstraints({});
  assert.equal(c.what, '');
  assert.equal(c.why, '');
  assert.equal(c.who.requestor, 'unknown');
  assert.equal(c.where.repo, '');
  assert.deepEqual(c.where.paths, []);
  assert.deepEqual(c.acceptance, []);
  // forbidden_actions defaults include modify_cc_tmux
  assert.ok(c.how.forbidden_actions.includes('modify_cc_tmux'));
  assert.ok(c.how.forbidden_actions.includes('git_push'));
  assert.ok(c.how.forbidden_actions.includes('rm_rf'));
});

test('normalizeConstraints with null returns empty constraints', () => {
  const c = normalizeConstraints(null);
  assert.deepEqual(c.acceptance, []);
  assert.equal(c.who.requestor, 'unknown');
});

test('normalizeConstraints with undefined returns empty constraints', () => {
  const c = normalizeConstraints();
  assert.deepEqual(c.acceptance, []);
});

test('normalizeConstraints filters non-string acceptance entries', () => {
  const c = normalizeConstraints({
    acceptance: ['real', 42, null, '  ', 'also real', {}],
  });
  assert.deepEqual(c.acceptance, ['real', 'also real']);
});

test('normalizeConstraints uses defaults for invalid how_much values', () => {
  const c = normalizeConstraints({ how_much: { max_ticks: -1, interval_ms: 0, timeout_ms: 'bad' } });
  assert.equal(c.how_much.max_ticks, 120);
  assert.equal(c.how_much.interval_ms, 15000);
  assert.equal(c.how_much.timeout_ms, 60000);
});

// ── validateConstraints ──────────────────────────────────────────────────────

test('validateConstraints passes with valid full constraints', () => {
  const result = validateConstraints({
    where: { repo: '/abs/path' },
    how: { forbidden_actions: ['modify_cc_tmux'] },
    acceptance: ['at least one'],
  });
  assert.ok(result.valid);
  assert.equal(result.issues.length, 0);
});

test('validateConstraints fails when where.repo is relative', () => {
  const result = validateConstraints({
    where: { repo: 'relative/path' },
    acceptance: ['ok'],
  });
  assert.ok(!result.valid);
  assert.ok(result.issues.some((i) => i.field === 'where.repo'));
});

test('validateConstraints fails when acceptance is empty', () => {
  const result = validateConstraints({ acceptance: [] });
  assert.ok(!result.valid);
  assert.ok(result.issues.some((i) => i.field === 'acceptance'));
});

test('validateConstraints fails when modify_cc_tmux is not in forbidden_actions', () => {
  const result = validateConstraints({
    how: { forbidden_actions: ['git_push'] },
    acceptance: ['ok'],
  });
  assert.ok(!result.valid);
  assert.ok(result.issues.some((i) => i.field === 'how.forbidden_actions'));
});

test('validateConstraints normalizes before validating (defaults fix empty fields)', () => {
  // Empty where.repo is not rejected (only non-empty relative paths are)
  const result = validateConstraints({
    acceptance: ['at least one'],
  });
  // forbidden_actions defaults include modify_cc_tmux → valid
  assert.ok(result.valid);
});

// ── constraintSummary ────────────────────────────────────────────────────────

test('constraintSummary returns non-empty string for valid constraints', () => {
  const summary = constraintSummary({
    what: 'implement X',
    why: 'reason',
    where: { repo: '/abs/path' },
    how: { allowed_actions: ['read', 'write_workspace'], forbidden_actions: ['modify_cc_tmux', 'custom_action'] },
    acceptance: ['test'],
  });
  assert.ok(typeof summary === 'string');
  assert.ok(summary.includes('implement X'));
  assert.ok(summary.includes('reason'));
  assert.ok(summary.includes('/abs/path'));
  // show forbid because custom_action is not in defaults
  assert.ok(summary.includes('custom_action'));
});

test('constraintSummary with empty constraints returns fallback', () => {
  const summary = constraintSummary({});
  assert.equal(summary, '(no constraints)');
});
