// Phase 2 gc-worker — collection/orchestration tests (dependency injection, no real fs/process/nats)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildNatsPublishFrame,
  runScan,
  runPlan,
  runExecute,
} from '../src/collect.js';

const nowIso = '2026-06-25T10:00:00Z';
const nowMs = Date.parse(nowIso);

function staleArtifact() {
  return {
    kind: 'file',
    path: '/tmp/cc-stale-marker',
    mtimeMs: nowMs - 49 * 60 * 60 * 1000,
    size: 12,
  };
}

test('runScan returns JSON-safe gc.report and publishes agent.gc.report (G1/G6)', async () => {
  const published = [];
  const report = await runScan({
    collectArtifacts: async () => [staleArtifact()],
    publishFn: async (subject, payload) => published.push({ subject, payload }),
    now: nowMs,
    nowIso,
    activePids: new Set(),
  });

  assert.equal(report.kind, 'gc.report');
  assert.equal(report.source, 'gc-worker');
  assert.equal(report.summary.candidates, 1);
  assert.equal(report.actions[0].kind, 'delete_file');
  assert.equal(published.length, 1);
  assert.equal(published[0].subject, 'agent.gc.report');
  assert.equal(published[0].payload.kind, 'gc.report');
});

test('runPlan returns actions and publishes the same report subject (G4/G6)', async () => {
  const published = [];
  const result = await runPlan({
    collectArtifacts: async () => [staleArtifact()],
    publishFn: async (subject, payload) => published.push({ subject, payload }),
    now: nowMs,
    nowIso,
    activePids: new Set(),
  });

  assert.equal(result.actions.length, 1);
  assert.equal(result.actions[0].path_or_pid, '/tmp/cc-stale-marker');
  assert.equal(result.actions[0].expected_mtime_ms, nowMs - 49 * 60 * 60 * 1000);
  assert.deepEqual(result.summary, { candidates: 1, safe: 1, needs_confirm: 0, blocked: 0 });
  assert.equal(published[0].subject, 'agent.gc.report');
});

test('runExecute refuses without confirm:true and does not delete files (G2/G5)', async () => {
  const deleted = [];
  const result = await runExecute({
    actions: [{ id: 'a1', kind: 'delete_file', path_or_pid: '/tmp/cc-stale-marker', risk: 'low', reason: 'stale', requires_confirm: false }],
    deleteFile: async (path) => deleted.push(path),
  });

  assert.equal(result.executed.length, 0);
  assert.equal(result.refused.length, 1);
  assert.deepEqual(deleted, []);
});

test('buildNatsPublishFrame generates NATS PUB frame for agent.gc.report', () => {
  const payload = { kind: 'gc.report', source: 'gc-worker' };
  const body = JSON.stringify(payload);
  assert.equal(
    buildNatsPublishFrame('agent.gc.report', payload),
    `PUB agent.gc.report ${Buffer.byteLength(body)}\r\n${body}\r\n`,
  );
});
