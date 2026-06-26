// Phase 5 Runtime Orchestrator — collect watch.jsonl into suggestions/final evidence (RED phase)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import {
  buildInitialManifest,
  buildRunPaths,
  writeManifest,
} from '../lib/cc-run-manifest.mjs';

const SCRIPT = new URL('../collect-cc-run-events.mjs', import.meta.url).pathname;

function runScript(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT, ...args], { timeout: 10_000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err?.code ?? 0, stdout, stderr });
    });
  });
}

async function setupRun() {
  const base = await mkdtemp(join(tmpdir(), 'agent-hub-collect-test-'));
  const run_id = 'ccrun-test-collect';
  const paths = buildRunPaths({ base_dir: base, run_id });
  const context_path = join(base, 'context.md');
  await writeFile(context_path, 'context\n', 'utf8');
  const manifest = buildInitialManifest({
    run_id,
    target: 'agent-hub',
    task: 'collect test',
    context_path,
    topic: '58478',
    effort: 'high',
    paths,
    now: new Date('2026-06-26T00:00:00Z'),
  });
  await writeManifest({ ...manifest, status: 'watching', session_id: 'session-1' });
  return { base, paths };
}

async function readJsonl(path) {
  const text = await readFile(path, 'utf8');
  return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

test('collect-cc-run-events extracts suggestions and writes final on terminal completed event', async () => {
  const { base, paths } = await setupRun();
  const suggestion = { kind: 'cc.intervention.suggestion', session_id: 'session-1', auto_execute: false, reason: 'state_stale' };
  await writeFile(paths.watch, [
    JSON.stringify({ kind: 'cc.watch.event', session_id: 'session-1', sequence: 1, state: 'THINKING', terminal: false, suggestion, ts: '2026-06-26T00:01:00Z' }),
    JSON.stringify({ kind: 'cc.watch.event', session_id: 'session-1', sequence: 2, state: 'COMPLETED', terminal: true, monitor: { status: 'ok', state: 'COMPLETED' }, ts: '2026-06-26T00:02:00Z' }),
  ].join('\n') + '\n', 'utf8');
  try {
    const res = await runScript(['--manifest', paths.manifest]);
    assert.equal(res.code, 0, res.stderr);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.status, 'completed');
    assert.equal(payload.suggestions_count, 1);

    const suggestions = await readJsonl(paths.suggestions);
    assert.equal(suggestions.length, 1);
    assert.equal(suggestions[0].suggestion.auto_execute, false);
    assert.equal(suggestions[0].event.sequence, 1);

    const final = JSON.parse(await readFile(paths.final, 'utf8'));
    assert.equal(final.status, 'completed');
    assert.equal(final.terminal_event.state, 'COMPLETED');
    assert.equal(final.suggestions_count, 1);

    const manifest = JSON.parse(await readFile(paths.manifest, 'utf8'));
    assert.equal(manifest.status, 'completed');
    assert.deepEqual(manifest.history.map((h) => h.status).slice(-1), ['completed']);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('collect-cc-run-events maps timeout event to timeout final status', async () => {
  const { base, paths } = await setupRun();
  await writeFile(paths.watch, `${JSON.stringify({ kind: 'cc.watch.event', session_id: 'session-1', status: 'timeout', terminal: true, ts: '2026-06-26T00:03:00Z' })}\n`, 'utf8');
  try {
    const res = await runScript(['--manifest', paths.manifest]);
    assert.equal(res.code, 2, res.stderr);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.status, 'timeout');
    const final = JSON.parse(await readFile(paths.final, 'utf8'));
    assert.equal(final.status, 'timeout');
    const manifest = JSON.parse(await readFile(paths.manifest, 'utf8'));
    assert.equal(manifest.status, 'timeout');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('collect-cc-run-events reports watching when no terminal event exists', async () => {
  const { base, paths } = await setupRun();
  await writeFile(paths.watch, `${JSON.stringify({ kind: 'cc.watch.event', session_id: 'session-1', sequence: 1, state: 'TOOL', terminal: false, ts: '2026-06-26T00:01:00Z' })}\n`, 'utf8');
  try {
    const res = await runScript(['--manifest', paths.manifest]);
    assert.equal(res.code, 0, res.stderr);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.status, 'watching');
    await assert.rejects(readFile(paths.final, 'utf8'), /ENOENT/);
    const manifest = JSON.parse(await readFile(paths.manifest, 'utf8'));
    assert.equal(manifest.status, 'watching');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
