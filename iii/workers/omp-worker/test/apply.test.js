// Phase 7 Slice 4 — OMP profile apply tests (TDD; injected fake fs only).
//
// applyProfilePlan is the single controlled fs-write engine for render plans.
// These tests NEVER touch the real filesystem — every write goes through an
// injected fake adapter that records exact calls, proving no real fs / .env /
// ~/.omp access ever happens. Apply defaults to dry-run and writes NOTHING; a
// write requires confirm:true AND dryRun:false, content availability, and an
// immediate exists() recheck returning false right before each write.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { applyProfilePlan } from '../src/apply.js';

const BASE = '~/.omp/profiles/page/agent';
const CONFIG = `${BASE}/config.yml`;
const MCP = `${BASE}/mcp.json`;
const ENVEX = `${BASE}/.env.example`;

function contentByKind() {
  return { config: 'CONFIG-BODY', mcp: 'MCP-BODY', env_example: 'ENVEX-BODY' };
}

// A render-plan action mirroring render.js output (execute=false, review-gated).
function action(file_kind, target_path, extra = {}) {
  return {
    type: 'render_file',
    target_path,
    file_kind,
    execute: false,
    requires_review: true,
    overwrite: false,
    redacted: true,
    reason: `planned ${file_kind} render`,
    ...extra,
  };
}

// A canonical render plan with three pending actions (config/mcp/env_example).
function plan(overrides = {}) {
  return {
    kind: 'omp.profile.render.plan',
    profile: 'page',
    execute: false,
    requires_review: true,
    redacted: true,
    actions: [action('config', CONFIG), action('mcp', MCP), action('env_example', ENVEX)],
    conflicts: [],
    warnings: [],
    errors: [],
    ...overrides,
  };
}

// Fake fs adapter over an in-memory set of existing paths. Records every call
// so tests can prove exactly which fs operations ran (and that none are real).
function buildFakeFs({ existing = [], failWrites = [] } = {}) {
  const calls = [];
  const present = new Set(existing);
  const fail = new Set(failWrites);
  const store = new Map();
  return {
    calls,
    store,
    present,
    exists(p) {
      calls.push(['exists', p]);
      return present.has(p);
    },
    writeFile(p, content, options) {
      calls.push(['writeFile', p, content, options]);
      if (fail.has(p)) throw new Error(`boom writing ${p}`);
      if (present.has(p)) throw new Error(`EEXIST: ${p}`); // wx semantics
      present.add(p);
      store.set(p, content);
    },
  };
}

const writes = (fs) => fs.calls.filter((c) => c[0] === 'writeFile');
const existsCalls = (fs) => fs.calls.filter((c) => c[0] === 'exists');
const skipFor = (r, kind) => r.skipped.find((s) => s.file_kind === kind);

// ── 1. dry-run is the default: nothing is written ────────────────────────────
test('dry-run (default) plans skips and writes nothing', async () => {
  const fs = buildFakeFs();
  const r = await applyProfilePlan(plan(), { fsAdapter: fs, contentByKind: contentByKind() });
  assert.equal(r.kind, 'omp.profile.apply.result');
  assert.equal(r.profile, 'page');
  assert.equal(r.dry_run, true);
  assert.equal(r.execute, false);
  assert.equal(r.confirmed, false);
  assert.equal(r.written.length, 0);
  assert.equal(r.skipped.length, 3);
  for (const s of r.skipped) {
    assert.equal(s.action, 'skip');
    assert.equal(s.code, 'DRY_RUN');
  }
  assert.equal(writes(fs).length, 0, 'no writeFile in dry-run');
  assert.equal(fs.calls.length, 0, 'dry-run must not touch the fs adapter at all');
});

// ── 2. missing confirm:true writes nothing ───────────────────────────────────
test('without confirm:true nothing is written even when dryRun:false', async () => {
  const fs = buildFakeFs();
  const r = await applyProfilePlan(plan(), { fsAdapter: fs, dryRun: false, contentByKind: contentByKind() });
  assert.equal(r.execute, false);
  assert.equal(r.confirmed, false);
  assert.equal(r.written.length, 0);
  assert.equal(r.skipped.length, 3);
  for (const s of r.skipped) assert.equal(s.code, 'NOT_CONFIRMED');
  assert.equal(writes(fs).length, 0);
});

// ── 3. confirm:true + dryRun:false writes the safe render actions ─────────────
test('confirm:true + dryRun:false writes safe render actions with provided content', async () => {
  const fs = buildFakeFs();
  const r = await applyProfilePlan(plan(), {
    fsAdapter: fs,
    confirm: true,
    dryRun: false,
    contentByKind: contentByKind(),
  });
  assert.equal(r.execute, true);
  assert.equal(r.dry_run, false);
  assert.equal(r.confirmed, true);
  assert.equal(r.written.length, 3);
  assert.equal(r.skipped.length, 0);
  assert.equal(r.conflicts.length, 0);
  assert.equal(r.errors.length, 0);
  for (const w of r.written) assert.equal(w.action, 'write');
  assert.deepEqual(fs.store.get(CONFIG), 'CONFIG-BODY');
  assert.deepEqual(fs.store.get(MCP), 'MCP-BODY');
  assert.deepEqual(fs.store.get(ENVEX), 'ENVEX-BODY');
  // exclusive-create semantics passed through to the adapter
  for (const c of writes(fs)) assert.deepEqual(c[3], { flag: 'wx' });
});

// ── 4. content resolves from action.content OR contentByKind ─────────────────
test('content comes from action.content, falling back to contentByKind', async () => {
  const fs = buildFakeFs();
  const p = plan();
  p.actions[0].content = 'INLINE-CONFIG'; // config carries its own content
  // mcp/env_example fall back to contentByKind; omit mcp from the map → NO_CONTENT
  const r = await applyProfilePlan(p, {
    fsAdapter: fs,
    confirm: true,
    dryRun: false,
    contentByKind: { env_example: 'MAP-ENVEX' },
  });
  assert.equal(fs.store.get(CONFIG), 'INLINE-CONFIG');
  assert.equal(fs.store.get(ENVEX), 'MAP-ENVEX');
  assert.ok(!fs.store.has(MCP), 'mcp had no content and must not be written');
  assert.equal(skipFor(r, 'mcp').code, 'NO_CONTENT');
});

// ── 5. immediate exists() makes an existing target a conflict, never written ──
test('existing target (immediate exists) becomes a conflict and is not written', async () => {
  const fs = buildFakeFs({ existing: [CONFIG] });
  const r = await applyProfilePlan(plan(), {
    fsAdapter: fs,
    confirm: true,
    dryRun: false,
    contentByKind: contentByKind(),
  });
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.conflicts[0].path, CONFIG);
  assert.equal(r.conflicts[0].action, 'conflict');
  assert.equal(r.conflicts[0].code, 'TARGET_EXISTS');
  assert.ok(!fs.store.has(CONFIG), 'existing target must never be overwritten');
  assert.equal(r.written.length, 2, 'the two absent targets still write');
  assert.ok(!writes(fs).some((c) => c[1] === CONFIG), 'no writeFile attempted on existing target');
});

// ── 6. existence is re-checked exactly once per candidate, before its write ───
test('exists() is called once per write candidate, immediately before the write', async () => {
  const fs = buildFakeFs();
  const r = await applyProfilePlan(plan(), {
    fsAdapter: fs,
    confirm: true,
    dryRun: false,
    contentByKind: contentByKind(),
  });
  assert.equal(r.written.length, 3);
  assert.equal(existsCalls(fs).length, 3, 'one exists() per candidate');
  // for each written path, exists() precedes writeFile() and both occur once
  for (const path of [CONFIG, MCP, ENVEX]) {
    const idxExists = fs.calls.findIndex((c) => c[0] === 'exists' && c[1] === path);
    const idxWrite = fs.calls.findIndex((c) => c[0] === 'writeFile' && c[1] === path);
    assert.ok(idxExists >= 0 && idxWrite >= 0, `both calls present for ${path}`);
    assert.ok(idxExists < idxWrite, `exists() must precede writeFile() for ${path}`);
  }
});

// ── 7. a .env target is always refused, never written ────────────────────────
test('.env target is always skipped/refused and never written', async () => {
  const fs = buildFakeFs();
  const p = plan({ actions: [action('config', `${BASE}/.env`)] });
  const r = await applyProfilePlan(p, {
    fsAdapter: fs,
    confirm: true,
    dryRun: false,
    contentByKind: { config: 'SECRET' },
  });
  assert.equal(r.written.length, 0);
  assert.equal(writes(fs).length, 0, 'a real .env must never be written');
  const item = r.skipped[0] ?? r.errors[0];
  assert.ok(item, 'the .env action is recorded as skip/error');
  assert.equal(item.code, 'ENV_FORBIDDEN');
});

// ── 8. iii/config.yaml is refused, never written ─────────────────────────────
test('iii/config.yaml target is skipped and never written', async () => {
  const fs = buildFakeFs();
  const p = plan({ actions: [action('config', 'iii/config.yaml')] });
  const r = await applyProfilePlan(p, {
    fsAdapter: fs,
    confirm: true,
    dryRun: false,
    contentByKind: { config: 'ROUTES' },
  });
  assert.equal(r.written.length, 0);
  assert.equal(writes(fs).length, 0);
  assert.equal(r.skipped[0].code, 'CONFIG_FORBIDDEN');
});

// ── 9. unsupported / overwrite / executable actions are never written ────────
test('overwrite, executable, and unsupported action types are never written', async () => {
  const fs = buildFakeFs();
  const p = plan({
    actions: [
      action('config', CONFIG, { overwrite: true }),
      action('mcp', MCP, { execute: true }),
      action('env_example', ENVEX, { type: 'run_shell' }),
    ],
  });
  const r = await applyProfilePlan(p, {
    fsAdapter: fs,
    confirm: true,
    dryRun: false,
    contentByKind: contentByKind(),
  });
  assert.equal(r.written.length, 0);
  assert.equal(writes(fs).length, 0);
  assert.equal(skipFor(r, 'config').code, 'OVERWRITE_FORBIDDEN');
  assert.equal(skipFor(r, 'mcp').code, 'ACTION_EXECUTABLE');
  assert.equal(skipFor(r, 'env_example').code, 'UNSUPPORTED_ACTION');
});

// ── 10. unsupported file_kind is skipped ─────────────────────────────────────
test('unsupported file_kind is skipped', async () => {
  const fs = buildFakeFs();
  const p = plan({ actions: [action('secrets', `${BASE}/secrets.json`)] });
  const r = await applyProfilePlan(p, {
    fsAdapter: fs,
    confirm: true,
    dryRun: false,
    contentByKind: { secrets: 'X' },
  });
  assert.equal(r.written.length, 0);
  assert.equal(writes(fs).length, 0);
  assert.equal(r.skipped[0].code, 'UNSUPPORTED_KIND');
});

// ── 11. no content available → NO_CONTENT skip ───────────────────────────────
test('missing content skips with NO_CONTENT and writes nothing', async () => {
  const fs = buildFakeFs();
  const r = await applyProfilePlan(plan(), { fsAdapter: fs, confirm: true, dryRun: false });
  assert.equal(r.written.length, 0);
  assert.equal(writes(fs).length, 0);
  assert.equal(r.skipped.length, 3);
  for (const s of r.skipped) assert.equal(s.code, 'NO_CONTENT');
});

// ── 12. adapter write failure → structured WRITE_FAILED error ────────────────
test('adapter write failure is captured as a structured error, not thrown', async () => {
  const fs = buildFakeFs({ failWrites: [MCP] });
  let r;
  await assert.doesNotReject(async () => {
    r = await applyProfilePlan(plan(), {
      fsAdapter: fs,
      confirm: true,
      dryRun: false,
      contentByKind: contentByKind(),
    });
  });
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].code, 'WRITE_FAILED');
  assert.equal(r.errors[0].path, MCP);
  assert.equal(typeof r.errors[0].message, 'string');
  assert.equal(r.written.length, 2, 'the other two still write despite one failure');
});

// ── 13. fake fs records exact calls; only known ops, no real fs ──────────────
test('the adapter only ever sees known ops (proves no real fs)', async () => {
  const fs = buildFakeFs();
  await applyProfilePlan(plan(), {
    fsAdapter: fs,
    confirm: true,
    dryRun: false,
    contentByKind: contentByKind(),
  });
  for (const c of fs.calls) {
    assert.ok(c[0] === 'exists' || c[0] === 'writeFile', `unexpected adapter op: ${c[0]}`);
  }
  // every touched path is inside the injected profile dir — nothing escapes
  for (const c of fs.calls) assert.ok(c[1].startsWith(BASE), `path escaped fake tree: ${c[1]}`);
});

// ── 14. the input plan is never mutated ──────────────────────────────────────
test('input plan is not mutated', async () => {
  const fs = buildFakeFs();
  const p = plan();
  const snapshot = structuredClone(p);
  await applyProfilePlan(p, { fsAdapter: fs, confirm: true, dryRun: false, contentByKind: contentByKind() });
  assert.deepEqual(p, snapshot, 'apply must not mutate its input plan');
});

// ── 15. malformed plan never throws ──────────────────────────────────────────
test('malformed plan returns an empty structured result without throwing', async () => {
  for (const bad of [null, undefined, {}, { actions: 'nope' }, 42]) {
    let r;
    await assert.doesNotReject(async () => {
      r = await applyProfilePlan(bad, { fsAdapter: buildFakeFs(), confirm: true, dryRun: false });
    });
    assert.equal(r.kind, 'omp.profile.apply.result');
    assert.equal(r.written.length, 0);
  }
});

// ── 16. write-target boundary: only profile agent files are in scope ─────────
// A plan must never steer a write outside ~/.omp/profiles/<name>/agent/<base>.
// Each of these targets must be skipped before any exists()/writeFile().
test('out-of-scope targets are skipped before any fs access and never written', async () => {
  // [target, file_kind] — every one must be refused. `.env` is also covered by
  // the dedicated env gate (ENV_FORBIDDEN); the rest are TARGET_OUT_OF_SCOPE.
  const cases = [
    ['/Users/alexcai/.ssh/config', 'config'],
    ['~/Library/Application Support/anything/config.yml', 'config'],
    ['~/.omp/agent/config.yml', 'config'], // default profile dir, not a named profile
    ['~/.omp/profiles/Page/agent/config.yml', 'config'], // invalid (uppercase) profile name
    ['~/.omp/profiles/page/agent/other.yml', 'config'], // wrong basename for config
    ['~/.omp/profiles/page/agent/../../../../.ssh/config', 'config'], // `..` traversal
    ['~/.omp/profiles/page/agent/.env', 'env_example'], // real .env, never .env.example
  ];

  for (const [target, kind] of cases) {
    const fs = buildFakeFs();
    const p = plan({ actions: [action(kind, target)] });
    const r = await applyProfilePlan(p, {
      fsAdapter: fs,
      confirm: true,
      dryRun: false,
      contentByKind: contentByKind(),
    });
    assert.equal(r.written.length, 0, `must not write ${target}`);
    assert.equal(fs.calls.length, 0, `no fs access at all for ${target}`);
    const item = r.skipped[0];
    assert.ok(item, `out-of-scope target is recorded as a skip: ${target}`);
    assert.ok(
      item.code === 'TARGET_OUT_OF_SCOPE' || item.code === 'ENV_FORBIDDEN',
      `unexpected code ${item.code} for ${target}`,
    );
  }
});

// ── 17. in-scope canonical targets still pass the boundary and write ──────────
test('canonical profile agent targets pass the boundary and write', async () => {
  const fs = buildFakeFs();
  const r = await applyProfilePlan(plan(), {
    fsAdapter: fs,
    confirm: true,
    dryRun: false,
    contentByKind: contentByKind(),
  });
  assert.equal(r.written.length, 3);
  assert.equal(r.skipped.length, 0, 'no boundary false-positives on canonical targets');
});

// ── 18. absolute profile agent paths are in scope (future expansion) ──────────
test('absolute paths ending in the profile agent tail are in scope', async () => {
  const fs = buildFakeFs();
  const abs = '/Users/alexcai/.omp/profiles/page/agent/config.yml';
  const p = plan({ actions: [action('config', abs)] });
  const r = await applyProfilePlan(p, {
    fsAdapter: fs,
    confirm: true,
    dryRun: false,
    contentByKind: contentByKind(),
  });
  assert.equal(r.written.length, 1);
  assert.equal(r.written[0].path, abs);
  assert.equal(fs.store.get(abs), 'CONFIG-BODY');
});
