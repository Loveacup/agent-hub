// Phase 2 gc-worker — pure logic tests (node:test, zero deps)
// TDD RED first: this file defines G2-G5 data model and safety behavior before src/gc.js exists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_TTL_MS,
  classifyRuntimeArtifacts,
  planGcActions,
  buildGcReport,
  executePlan,
} from '../src/gc.js';

const now = Date.parse('2026-06-25T10:00:00Z');

function artifact(overrides = {}) {
  return {
    kind: 'file',
    path: '/tmp/cc-stale-marker',
    mtimeMs: now - DEFAULT_TTL_MS - 1,
    size: 10,
    ...overrides,
  };
}

test('classifyRuntimeArtifacts marks old /tmp/cc-* files as stale candidates and active-linked files as blocked', () => {
  const items = classifyRuntimeArtifacts([
    artifact({ path: '/tmp/cc-stale-marker' }),
    artifact({ path: '/tmp/cc-live-marker', pid: 123 }),
  ], {
    now,
    activePids: new Set([123]),
  });

  assert.equal(items.length, 2);
  assert.equal(items[0].status, 'candidate');
  assert.match(items[0].evidence.join(' '), /older than TTL/);
  assert.equal(items[1].status, 'blocked');
  assert.match(items[1].reason, /active pid/);
});

test('classifyRuntimeArtifacts protects iii engine, usage-worker, NATS, tmux and Claude/CC processes', () => {
  const protectedNames = ['iii', 'node src/index.js usage-worker', 'nats-server', 'tmux', 'claude'];
  const items = classifyRuntimeArtifacts(protectedNames.map((name, i) => artifact({
    kind: 'process',
    pid: 200 + i,
    name,
    path: null,
  })), { now, activePids: new Set() });

  assert.equal(items.length, protectedNames.length);
  assert.ok(items.every((item) => item.status === 'blocked'));
  assert.ok(items.every((item) => /protected active process/.test(item.reason)));
});

test('classifyRuntimeArtifacts blocks ordinary processes unless explicitly marked gcOwned', () => {
  const items = classifyRuntimeArtifacts([
    artifact({ kind: 'process', pid: 321, name: 'python unrelated-job', path: null }),
    artifact({ kind: 'process', pid: 654, name: 'orphan helper', path: null, gcOwned: true }),
  ], { now, activePids: new Set() });

  assert.equal(items[0].status, 'blocked');
  assert.match(items[0].reason, /not gc-owned/);
  assert.equal(items[1].status, 'candidate');
});

test('classifyRuntimeArtifacts blocks project/codex paths even when old', () => {
  const items = classifyRuntimeArtifacts([
    artifact({ path: '/Users/alexcai/code/agent-hub/important.log' }),
    artifact({ path: '/Users/alexcai/.codex/sessions/2026/session.jsonl' }),
  ], { now, activePids: new Set() });

  assert.equal(items.length, 2);
  assert.ok(items.every((item) => item.status === 'blocked'));
  assert.ok(items.every((item) => /outside gc-owned/.test(item.reason)));
});

test('planGcActions outputs required G4 action schema and never plans blocked items', () => {
  const classified = [
    { ...artifact({ path: '/tmp/cc-old' }), status: 'candidate', reason: 'older than TTL and no matching live process', evidence: ['mtimeMs=1'] },
    { ...artifact({ path: '/tmp/cc-live', pid: 123 }), status: 'blocked', reason: 'active pid 123', evidence: ['pid=123 active=true'] },
  ];
  const actions = planGcActions(classified);

  assert.equal(actions.length, 1);
  assert.deepEqual(Object.keys(actions[0]).sort(), [
    'evidence', 'expected_mtime_ms', 'id', 'kind', 'path_or_pid', 'reason', 'requires_confirm', 'risk',
  ]);
  assert.equal(actions[0].kind, 'delete_file');
  assert.equal(actions[0].path_or_pid, '/tmp/cc-old');
  assert.equal(actions[0].expected_mtime_ms, now - DEFAULT_TTL_MS - 1);
  assert.equal(actions[0].risk, 'low');
  assert.equal(actions[0].requires_confirm, false);
});

test('planGcActions skips directory artifacts in Phase 2 to avoid EISDIR cascade', () => {
  const actions = planGcActions([
    { ...artifact({ path: '/tmp/cc-old-dir', isDirectory: true }), status: 'candidate', reason: 'old directory', evidence: [] },
  ]);

  assert.equal(actions.length, 0);
});

test('buildGcReport matches gc.report data model and summary counts', () => {
  const actions = [
    { id: 'a1', kind: 'delete_file', path_or_pid: '/tmp/cc-old', risk: 'low', reason: 'stale', requires_confirm: false, evidence: [] },
    { id: 'a2', kind: 'kill_process', path_or_pid: 999, risk: 'medium', reason: 'orphan process', requires_confirm: true, evidence: [] },
  ];
  const report = buildGcReport(actions, {
    ts: '2026-06-25T10:00:00Z',
    blocked: [{ path: '/tmp/cc-live' }],
  });

  assert.equal(report.kind, 'gc.report');
  assert.equal(report.source, 'gc-worker');
  assert.equal(report.ts, '2026-06-25T10:00:00Z');
  assert.deepEqual(report.summary, { candidates: 2, safe: 1, needs_confirm: 1, blocked: 1 });
  assert.equal(report.actions, actions);
});

test('executePlan defaults to dry-run and refuses destructive execution without confirm:true', async () => {
  const calls = [];
  const actions = [
    { id: 'a1', kind: 'delete_file', path_or_pid: '/tmp/cc-old', risk: 'low', reason: 'stale', requires_confirm: false },
  ];

  const dryRun = await executePlan(actions, { deleteFile: (p) => calls.push(p) });
  assert.equal(dryRun.executed.length, 0);
  assert.equal(dryRun.refused.length, 1);
  assert.match(dryRun.refused[0].reason, /confirm:true required/);
  assert.deepEqual(calls, []);
});

test('executePlan with confirm:true executes only safe actions unless explicit action ids confirm higher-risk actions', async () => {
  const deleted = [];
  const killed = [];
  const actions = [
    { id: 'safe-delete', kind: 'delete_file', path_or_pid: '/tmp/cc-old', risk: 'low', reason: 'stale', requires_confirm: false },
    { id: 'maybe-kill', kind: 'kill_process', path_or_pid: 999, risk: 'medium', reason: 'orphan process', requires_confirm: true },
  ];

  const first = await executePlan(actions, {
    confirm: true,
    deleteFile: async (p) => deleted.push(p),
    killProcess: async (pid) => killed.push(pid),
  });
  assert.deepEqual(deleted, ['/tmp/cc-old']);
  assert.deepEqual(killed, []);
  assert.equal(first.executed.length, 1);
  assert.equal(first.skipped.length, 1);

  const second = await executePlan(actions.slice(1), {
    confirm: true,
    confirmedActionIds: new Set(['maybe-kill']),
    deleteFile: async (p) => deleted.push(p),
    killProcess: async (pid) => killed.push(pid),
  });
  assert.deepEqual(killed, [999]);
  assert.equal(second.executed.length, 1);
});

test('executePlan refuses unsafe delete paths even with confirm:true', async () => {
  const deleted = [];
  const result = await executePlan([
    { id: 'unsafe-delete', kind: 'delete_file', path_or_pid: '/Users/alexcai/code/agent-hub/important.log', risk: 'low', reason: 'fake action', requires_confirm: false },
  ], {
    confirm: true,
    deleteFile: async (p) => deleted.push(p),
  });

  assert.equal(result.executed.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /unsafe delete path/);
  assert.deepEqual(deleted, []);
});

test('executePlan revalidates mtime before delete to reduce TOCTOU risk', async () => {
  const deleted = [];
  const result = await executePlan([
    { id: 'stale-delete', kind: 'delete_file', path_or_pid: '/tmp/cc-old', expected_mtime_ms: 100, risk: 'low', reason: 'old', requires_confirm: false },
  ], {
    confirm: true,
    statPath: async () => ({ mtimeMs: 200, isDirectory: false }),
    deleteFile: async (p) => deleted.push(p),
  });

  assert.equal(result.executed.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /mtime changed/);
  assert.deepEqual(deleted, []);
});

test('executePlan catches per-action errors and continues', async () => {
  const calls = [];
  const result = await executePlan([
    { id: 'first', kind: 'delete_file', path_or_pid: '/tmp/cc-first', risk: 'low', reason: 'old', requires_confirm: false },
    { id: 'second', kind: 'delete_file', path_or_pid: '/tmp/cc-second', risk: 'low', reason: 'old', requires_confirm: false },
  ], {
    confirm: true,
    deleteFile: async (p) => {
      calls.push(p);
      if (p.endsWith('first')) throw new Error('EACCES');
    },
  });

  assert.deepEqual(calls, ['/tmp/cc-first', '/tmp/cc-second']);
  assert.equal(result.executed.length, 1);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].id, 'first');
});
