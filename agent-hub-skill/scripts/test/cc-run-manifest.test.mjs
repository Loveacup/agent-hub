// Phase 5 Runtime Orchestrator — run manifest helpers (RED phase)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const {
  buildRunId,
  buildRunPaths,
  buildInitialManifest,
  writeManifest,
  updateManifestStatus,
} = await (async () => {
  try {
    return await import('../lib/cc-run-manifest.mjs');
  } catch {
    return {
      buildRunId: null,
      buildRunPaths: null,
      buildInitialManifest: null,
      writeManifest: null,
      updateManifestStatus: null,
    };
  }
})();

test('buildRunId creates stable ccrun id from date and suffix', () => {
  assert.ok(buildRunId, 'buildRunId must be implemented');
  const id = buildRunId({ now: new Date('2026-06-25T09:52:03.000Z'), suffix: 'a1b2c3' });
  assert.equal(id, 'ccrun-20260625-095203-a1b2c3');
});

test('buildRunPaths creates canonical evidence paths under base dir', () => {
  assert.ok(buildRunPaths, 'buildRunPaths must be implemented');
  const paths = buildRunPaths({ base_dir: '/tmp/agent-hub-runs', run_id: 'ccrun-1' });
  assert.equal(paths.run_dir, '/tmp/agent-hub-runs/ccrun-1');
  assert.equal(paths.manifest, '/tmp/agent-hub-runs/ccrun-1/manifest.json');
  assert.equal(paths.watch, '/tmp/agent-hub-runs/ccrun-1/watch.jsonl');
  assert.equal(paths.suggestions, '/tmp/agent-hub-runs/ccrun-1/suggestions.jsonl');
  assert.equal(paths.interventions, '/tmp/agent-hub-runs/ccrun-1/interventions.jsonl');
  assert.equal(paths.final, '/tmp/agent-hub-runs/ccrun-1/final.json');
});

test('buildInitialManifest records task metadata and honest starting status', () => {
  assert.ok(buildInitialManifest, 'buildInitialManifest must be implemented');
  const manifest = buildInitialManifest({
    run_id: 'ccrun-1',
    target: 'agent-hub',
    task: 'test task',
    context_path: '/tmp/context.md',
    topic: '58478',
    effort: 'high',
    paths: buildRunPaths({ base_dir: '/tmp/agent-hub-runs', run_id: 'ccrun-1' }),
    now: new Date('2026-06-25T09:52:03.000Z'),
  });
  assert.equal(manifest.kind, 'agent_hub.cc_run_manifest');
  assert.equal(manifest.run_id, 'ccrun-1');
  assert.equal(manifest.status, 'starting');
  assert.equal(manifest.target, 'agent-hub');
  assert.equal(manifest.task, 'test task');
  assert.equal(manifest.context_path, '/tmp/context.md');
  assert.equal(manifest.topic, '58478');
  assert.equal(manifest.effort, 'high');
  assert.equal(manifest.created_at, '2026-06-25T09:52:03.000Z');
  assert.equal(manifest.updated_at, '2026-06-25T09:52:03.000Z');
  assert.equal(manifest.paths.watch, '/tmp/agent-hub-runs/ccrun-1/watch.jsonl');
});

test('buildInitialManifest rejects relative context paths', () => {
  assert.throws(() => buildInitialManifest({
    run_id: 'ccrun-1',
    target: 'agent-hub',
    task: 'test task',
    context_path: 'relative.md',
    paths: buildRunPaths({ base_dir: '/tmp/agent-hub-runs', run_id: 'ccrun-1' }),
  }), /context_path must be absolute/);
});

test('writeManifest creates run dir and writes pretty JSON', async () => {
  assert.ok(writeManifest, 'writeManifest must be implemented');
  const base = await mkdtemp(join(tmpdir(), 'agent-hub-manifest-test-'));
  try {
    const paths = buildRunPaths({ base_dir: base, run_id: 'ccrun-1' });
    const manifest = buildInitialManifest({
      run_id: 'ccrun-1',
      target: 'agent-hub',
      task: 'test task',
      context_path: '/tmp/context.md',
      paths,
    });
    await writeManifest(manifest);
    const parsed = JSON.parse(await readFile(paths.manifest, 'utf8'));
    assert.equal(parsed.run_id, 'ccrun-1');
    assert.equal(parsed.status, 'starting');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('updateManifestStatus preserves original fields and appends status history', () => {
  assert.ok(updateManifestStatus, 'updateManifestStatus must be implemented');
  const manifest = buildInitialManifest({
    run_id: 'ccrun-1',
    target: 'agent-hub',
    task: 'test task',
    context_path: '/tmp/context.md',
    paths: buildRunPaths({ base_dir: '/tmp/agent-hub-runs', run_id: 'ccrun-1' }),
    now: new Date('2026-06-25T09:52:03.000Z'),
  });
  const next = updateManifestStatus(manifest, {
    status: 'watching',
    session_id: 'hermes-cc-default-agent-hub-0625-1752',
    now: new Date('2026-06-25T09:53:00.000Z'),
  });
  assert.equal(next.run_id, 'ccrun-1');
  assert.equal(next.status, 'watching');
  assert.equal(next.session_id, 'hermes-cc-default-agent-hub-0625-1752');
  assert.equal(next.updated_at, '2026-06-25T09:53:00.000Z');
  assert.equal(next.history.length, 2);
  assert.deepEqual(next.history.map((h) => h.status), ['starting', 'watching']);
  assert.equal(manifest.status, 'starting', 'must not mutate original manifest');
});
