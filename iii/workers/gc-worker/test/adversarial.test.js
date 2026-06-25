// Phase 2 gc-worker — adversarial regression tests from Regent review.
// These assert the safety fixes, not the pre-fix failures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DEFAULT_TTL_MS,
  classifyRuntimeArtifacts,
  planGcActions,
  executePlan,
} from '../src/gc.js';

const now = Date.now();
const tmp = '/tmp';

test('REGRESSION: stale /tmp/cc-* directories are not planned as delete_file actions', () => {
  const dirArtifact = {
    kind: 'file',
    path: '/tmp/cc-stale-dir',
    mtimeMs: now - DEFAULT_TTL_MS - 1000,
    size: 4096,
    isDirectory: true,
  };

  const classified = classifyRuntimeArtifacts([dirArtifact], { now, activePids: new Set() });
  assert.equal(classified[0].status, 'candidate');
  const actions = planGcActions(classified);
  assert.equal(actions.length, 0);
});

test('REGRESSION: executePlan catches per-action errors and continues subsequent actions', async () => {
  const calls = [];
  const result = await executePlan([
    { id: 'dir', kind: 'delete_file', path_or_pid: '/tmp/cc-dir', risk: 'low', reason: 'old', requires_confirm: false },
    { id: 'file', kind: 'delete_file', path_or_pid: '/tmp/cc-file', risk: 'low', reason: 'old', requires_confirm: false },
  ], {
    confirm: true,
    deleteFile: async (path) => {
      calls.push(path);
      if (path.endsWith('dir')) throw new Error('EISDIR');
    },
  });

  assert.deepEqual(calls, ['/tmp/cc-dir', '/tmp/cc-file']);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].id, 'dir');
  assert.equal(result.executed.length, 1);
  assert.equal(result.executed[0].id, 'file');
});

test('REGRESSION: executePlan revalidates expected mtime before deleting', async () => {
  const deleted = [];
  const result = await executePlan([
    { id: 'changed', kind: 'delete_file', path_or_pid: '/tmp/cc-changed', expected_mtime_ms: 100, risk: 'low', reason: 'old', requires_confirm: false },
  ], {
    confirm: true,
    statPath: async () => ({ mtimeMs: 200, isDirectory: false }),
    deleteFile: async (path) => deleted.push(path),
  });

  assert.equal(result.executed.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /mtime changed/);
  assert.deepEqual(deleted, []);
});

test('REGRESSION: real directory delete action is skipped when statPath says isDirectory', async () => {
  const dirPath = join(tmp, 'cc-gc-regression-dir');
  await mkdir(dirPath, { recursive: true });
  try {
    const result = await executePlan([
      { id: 'dir', kind: 'delete_file', path_or_pid: dirPath, expected_mtime_ms: 123, risk: 'low', reason: 'old', requires_confirm: false },
    ], {
      confirm: true,
      statPath: async () => ({ mtimeMs: 123, isDirectory: true }),
      deleteFile: async () => assert.fail('deleteFile should not be called for directory'),
    });

    assert.equal(result.executed.length, 0);
    assert.equal(result.skipped.length, 1);
    assert.match(result.skipped[0].reason, /refusing directory delete/);
  } finally {
    await rm(dirPath, { recursive: true, force: true });
  }
});

test('REGRESSION: expected_mtime_ms is included in delete actions', () => {
  const mtimeMs = now - DEFAULT_TTL_MS - 1000;
  const actions = planGcActions(classifyRuntimeArtifacts([
    { kind: 'file', path: '/tmp/cc-stale-file', mtimeMs, size: 1, isDirectory: false },
  ], { now, activePids: new Set() }));

  assert.equal(actions.length, 1);
  assert.equal(actions[0].expected_mtime_ms, mtimeMs);
});
