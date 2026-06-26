// Phase 7 Slice 3 — OMP profile render-plan tests (TDD; pure, no filesystem).
//
// renderProfilePlan is a PURE function: it takes a registry profile entry and
// produces a render *plan* describing what files WOULD be created. It performs
// NO filesystem access — no stat, no readFile, no fs adapter — and never writes.
// Every action defaults to execute=false / requires_review=true and the plan is
// never allowed to overwrite an existing target. These tests pass no fs adapter
// and assert the function behaves purely off its inputs.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderProfilePlan } from '../src/render.js';

// A valid `read_only` named profile entry mirroring agent-hub-skill/config/omp-profiles.json.
function pageEntry() {
  return {
    name: 'page',
    display_name: 'Page',
    role: 'knowledge-governance',
    status: 'planned',
    risk_level: 'read_only',
    permissions: {
      read_profile_metadata: true,
      read_recent_summary: true,
      write_files: false,
      run_shell: false,
      send_external_messages: false,
      external_network: false,
    },
    subjects: {
      summary: 'agent.omp.profile.page.summary',
      audit: 'agent.omp.profile.page.audit',
    },
    paths: {
      agent_dir: '~/.omp/profiles/page/agent',
      config: '~/.omp/profiles/page/agent/config.yml',
      mcp: '~/.omp/profiles/page/agent/mcp.json',
      env_example: '~/.omp/profiles/page/agent/.env.example',
    },
    gateway: { mode: 'none', platforms: [] },
  };
}

function actionFor(plan, fileKind) {
  return plan.actions.find((a) => a.file_kind === fileKind);
}
function conflictFor(plan, fileKind) {
  return plan.conflicts.find((c) => c.file_kind === fileKind);
}

// ── 1. plan-level review flags ────────────────────────────────────────────────
test('plan is non-executable, review-gated, and redacted', () => {
  const plan = renderProfilePlan(pageEntry());
  assert.equal(plan.kind, 'omp.profile.render.plan');
  assert.equal(plan.profile, 'page');
  assert.equal(plan.execute, false);
  assert.equal(plan.requires_review, true);
  assert.equal(plan.redacted, true);
  for (const a of plan.actions) {
    assert.equal(a.execute, false);
    assert.equal(a.requires_review, true);
    assert.equal(a.redacted, true);
    assert.equal(a.overwrite, false);
  }
});

// ── 2. render actions for config/mcp/env_example when absent ─────────────────
test('creates render actions for config, mcp, env_example when none exist', () => {
  const plan = renderProfilePlan(pageEntry());
  assert.equal(plan.conflicts.length, 0);
  assert.equal(plan.actions.length, 3);
  const config = actionFor(plan, 'config');
  assert.ok(config);
  assert.equal(config.type, 'render_file');
  assert.equal(config.target_path, '~/.omp/profiles/page/agent/config.yml');
  assert.equal(actionFor(plan, 'mcp').target_path, '~/.omp/profiles/page/agent/mcp.json');
  assert.equal(actionFor(plan, 'env_example').target_path, '~/.omp/profiles/page/agent/.env.example');
});

// ── 3. never plan the real .env, even if paths.env is present ─────────────────
test('never includes .env in actions even when profileEntry.paths.env is present', () => {
  const entry = pageEntry();
  entry.paths.env = '~/.omp/profiles/page/agent/.env';
  const plan = renderProfilePlan(entry);
  const allTargets = [...plan.actions, ...plan.conflicts].map((x) => x.target_path);
  for (const t of allTargets) {
    assert.ok(!/\/\.env$/.test(t), `.env must never be a planned target: ${t}`);
  }
  assert.ok(!plan.actions.some((a) => a.file_kind === 'env'));
});

// ── 4. existing targets become conflicts with overwrite=false ────────────────
test('existing config/mcp/env_example become conflicts with overwrite=false', () => {
  const entry = pageEntry();
  const existing = new Set([
    '~/.omp/profiles/page/agent/config.yml',
    '~/.omp/profiles/page/agent/mcp.json',
    '~/.omp/profiles/page/agent/.env.example',
  ]);
  const plan = renderProfilePlan(entry, { existingPaths: existing });
  assert.equal(plan.actions.length, 0);
  assert.equal(plan.conflicts.length, 3);
  for (const c of plan.conflicts) {
    assert.equal(c.type, 'target_exists');
    assert.equal(c.action, 'conflict');
    assert.equal(c.overwrite, false);
    assert.match(c.reason, /will not overwrite/);
  }
});

// ── 5. existingPaths accepts Set / Array / plain object ──────────────────────
test('existingPaths supports Set, Array, and plain object', () => {
  const target = '~/.omp/profiles/page/agent/config.yml';
  const asSet = renderProfilePlan(pageEntry(), { existingPaths: new Set([target]) });
  const asArray = renderProfilePlan(pageEntry(), { existingPaths: [target] });
  const asObject = renderProfilePlan(pageEntry(), { existingPaths: { [target]: true } });
  for (const plan of [asSet, asArray, asObject]) {
    assert.ok(conflictFor(plan, 'config'), 'config must be a conflict');
    assert.ok(!actionFor(plan, 'config'), 'config must not be an action');
    assert.ok(actionFor(plan, 'mcp'), 'mcp still planned');
    assert.ok(actionFor(plan, 'env_example'), 'env_example still planned');
  }
  // plain object with a falsy value means "not existing"
  const falsy = renderProfilePlan(pageEntry(), { existingPaths: { [target]: false } });
  assert.ok(actionFor(falsy, 'config'), 'falsy object value must not mark target existing');
});

// ── 6. discovery metadata can mark targets existing without fs access ────────
test('discoveryProfile metadata marks targets existing without any fs access', () => {
  const discoveryProfile = {
    name: 'page',
    paths: {
      config: { exists: true, is_file: true },
      mcp: { exists: false },
      env_example: { exists: false },
    },
  };
  const plan = renderProfilePlan(pageEntry(), { discoveryProfile });
  assert.ok(conflictFor(plan, 'config'), 'config marked existing by discovery → conflict');
  assert.ok(!actionFor(plan, 'config'));
  assert.ok(actionFor(plan, 'mcp'), 'mcp absent in discovery → still planned');
  assert.ok(actionFor(plan, 'env_example'));
});

// ── 7. permissions/subjects/gateway preserved for review ─────────────────────
test('preserves permissions, subjects, and gateway for review', () => {
  const entry = pageEntry();
  const plan = renderProfilePlan(entry);
  assert.deepEqual(plan.permissions, entry.permissions);
  assert.deepEqual(plan.subjects, entry.subjects);
  assert.deepEqual(plan.gateway, entry.gateway);

  // gateway defaults to null when absent
  const noGw = pageEntry();
  delete noGw.gateway;
  assert.equal(renderProfilePlan(noGw).gateway, null);
});

// ── 8. invalid profile entry returns structured errors, never throws ─────────
test('invalid profile entry returns structured warnings/errors instead of throwing', () => {
  let plan;
  assert.doesNotThrow(() => {
    plan = renderProfilePlan({ name: 'Bad Name', risk_level: 'nope' });
  });
  assert.equal(plan.kind, 'omp.profile.render.plan');
  assert.ok(Array.isArray(plan.errors));
  assert.ok(plan.errors.length >= 1, 'malformed entry yields errors');
  for (const e of plan.errors) {
    assert.equal(typeof e.code, 'string');
    assert.equal(typeof e.path, 'string');
    assert.equal(typeof e.message, 'string');
  }

  // a non-object entry must also not throw
  let plan2;
  assert.doesNotThrow(() => {
    plan2 = renderProfilePlan(null);
  });
  assert.equal(plan2.kind, 'omp.profile.render.plan');
  assert.ok(plan2.errors.length >= 1);
});

// ── 9. missing paths.env_example warns and still plans config/mcp ────────────
test('missing paths.env_example produces a warning and still plans config + mcp', () => {
  const entry = pageEntry();
  delete entry.paths.env_example;
  const plan = renderProfilePlan(entry);
  assert.ok(actionFor(plan, 'config'), 'config still planned');
  assert.ok(actionFor(plan, 'mcp'), 'mcp still planned');
  assert.ok(!actionFor(plan, 'env_example'), 'no env_example action');
  assert.ok(!conflictFor(plan, 'env_example'), 'no env_example conflict');
  assert.ok(
    plan.warnings.some((w) => /env_example/.test(w.path) || /env_example/.test(w.message)),
    'expected a warning about the missing env_example path',
  );
});

// ── 10. pure: no fs adapter accepted/needed, repeatable, no shared mutation ───
test('is pure — no fs adapter is required and repeated calls are independent', () => {
  const entry = pageEntry();
  const a = renderProfilePlan(entry);
  const b = renderProfilePlan(entry);
  assert.deepEqual(a, b, 'same input → identical plan');
  // mutating one plan must not affect a fresh render
  a.actions.push({ tampered: true });
  const c = renderProfilePlan(entry);
  assert.equal(c.actions.length, 3, 'fresh plan unaffected by mutation of a prior plan');
  // input entry is not mutated
  assert.deepEqual(entry, pageEntry());
});

// ── 11. deterministic action order: config, mcp, env_example ─────────────────
test('actions are emitted in deterministic order: config, mcp, env_example', () => {
  const plan = renderProfilePlan(pageEntry());
  assert.deepEqual(plan.actions.map((a) => a.file_kind), ['config', 'mcp', 'env_example']);
});
