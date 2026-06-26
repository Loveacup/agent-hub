// Phase 5 Runtime Orchestrator — run-cc-task skeleton tests (RED phase)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = new URL('../run-cc-task.mjs', import.meta.url).pathname;

function runScript(args, opts = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT, ...args], {
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
      ...opts,
    }, (err, stdout, stderr) => {
      resolve({
        code: err?.code ?? 0,
        signal: err?.signal ?? null,
        stdout,
        stderr,
      });
    });
  });
}

test('run-cc-task --help prints usage and exits zero', async () => {
  const res = await runScript(['--help']);
  assert.equal(res.code, 0);
  assert.match(res.stdout, /Usage: run-cc-task\.mjs/);
  assert.match(res.stdout, /--context/);
});

test('run-cc-task rejects missing required args without creating a run', async () => {
  const res = await runScript(['--target', 'agent-hub']);
  assert.equal(res.code, 2);
  assert.match(res.stderr, /missing required args/i);
});

test('run-cc-task rejects relative context path', async () => {
  const res = await runScript([
    '--target', 'agent-hub',
    '--task', 'test task',
    '--context', 'relative.md',
  ]);
  assert.equal(res.code, 2);
  assert.match(res.stderr, /context.*absolute/i);
});

test('run-cc-task init-only creates run manifest and returns JSON', async () => {
  const base = await mkdtemp(join(tmpdir(), 'agent-hub-run-task-test-'));
  const contextPath = join(base, 'context.md');
  await writeFile(contextPath, 'hello context\n', 'utf8');
  try {
    const res = await runScript([
      '--target', 'agent-hub',
      '--task', 'test task',
      '--context', contextPath,
      '--topic', '58478',
      '--effort', 'high',
      '--base-dir', base,
      '--init-only',
    ]);
    assert.equal(res.code, 0, res.stderr);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.kind, 'agent_hub.cc_run');
    assert.equal(payload.status, 'starting');
    assert.match(payload.run_id, /^ccrun-/);
    assert.ok(payload.manifest_path.endsWith('/manifest.json'));
    assert.ok(payload.watch_path.endsWith('/watch.jsonl'));

    const manifest = JSON.parse(await readFile(payload.manifest_path, 'utf8'));
    assert.equal(manifest.status, 'starting');
    assert.equal(manifest.target, 'agent-hub');
    assert.equal(manifest.task, 'test task');
    assert.equal(manifest.context_path, contextPath);
    assert.equal(manifest.topic, '58478');
    assert.equal(manifest.effort, 'high');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
