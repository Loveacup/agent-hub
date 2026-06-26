// Phase 5 Runtime Orchestrator — approved cc::intervene archive wrapper tests (RED phase)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import {
  buildInitialManifest,
  buildRunPaths,
  writeManifest,
} from '../lib/cc-run-manifest.mjs';

const SCRIPT = new URL('../archive-cc-intervention.mjs', import.meta.url).pathname;

function runScript(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT, ...args], { timeout: 10_000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err?.code ?? 0, stdout, stderr });
    });
  });
}

async function setupRun() {
  const base = await mkdtemp(join(tmpdir(), 'agent-hub-intervene-test-'));
  const run_id = 'ccrun-test-intervene';
  const paths = buildRunPaths({ base_dir: base, run_id });
  const context_path = join(base, 'context.md');
  await writeFile(context_path, 'context\n', 'utf8');
  const manifest = buildInitialManifest({
    run_id,
    target: 'agent-hub',
    task: 'intervention test',
    context_path,
    topic: '58478',
    effort: 'high',
    paths,
    now: new Date('2026-06-26T00:00:00Z'),
  });
  await writeManifest({ ...manifest, status: 'watching', session_id: 'session-1' });
  return { base, paths };
}

async function writeFakeIii(dir, mode = 'sent') {
  const callsPath = join(dir, 'iii-calls.jsonl');
  const scriptPath = join(dir, 'fake-iii.mjs');
  const content = `#!/usr/bin/env node\nimport { appendFileSync } from 'node:fs';\nconst callsPath = ${JSON.stringify(callsPath)};\nconst args = process.argv.slice(2);\nappendFileSync(callsPath, JSON.stringify({ args }) + '\\n');\nconst action = args[1] || '';\nif (action !== 'cc::intervene') {\n  console.log(JSON.stringify({ status: 'error', error: 'unexpected action', action }));\n  process.exit(0);\n}\nif (${JSON.stringify(mode)} === 'error') {\n  console.log(JSON.stringify({ kind: 'cc.intervention', status: 'error', error: 'send failed' }));\n  process.exit(0);\n}\nconsole.log(JSON.stringify({ kind: 'cc.intervention', status: 'sent', session_id: 'session-1', message_id: 'msg-1' }));\n`;
  await writeFile(scriptPath, content, 'utf8');
  await chmod(scriptPath, 0o755);
  return { scriptPath, callsPath };
}

async function readJsonl(path) {
  const text = await readFile(path, 'utf8');
  return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

test('archive-cc-intervention refuses without explicit confirm and does not call iii', async () => {
  const { base, paths } = await setupRun();
  const fake = await writeFakeIii(base);
  try {
    const res = await runScript([
      '--manifest', paths.manifest,
      '--session', 'session-1',
      '--message', 'please report status',
      '--reason', 'operator approved stale-state follow-up',
      '--monitor-snapshot-id', 'snap-1',
      '--iii-bin', fake.scriptPath,
    ]);
    assert.equal(res.code, 2);
    assert.match(res.stderr, /confirm required/i);
    await assert.rejects(readFile(fake.callsPath, 'utf8'), /ENOENT/);
    await assert.rejects(readFile(paths.interventions, 'utf8'), /ENOENT/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('archive-cc-intervention calls cc::intervene and appends audit record when confirmed', async () => {
  const { base, paths } = await setupRun();
  const fake = await writeFakeIii(base);
  try {
    const res = await runScript([
      '--manifest', paths.manifest,
      '--session', 'session-1',
      '--message', 'please report status',
      '--reason', 'operator approved stale-state follow-up',
      '--monitor-snapshot-id', 'snap-1',
      '--iii-bin', fake.scriptPath,
      '--confirm',
    ]);
    assert.equal(res.code, 0, res.stderr);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.status, 'sent');
    assert.equal(payload.interventions_count, 1);

    const calls = await readJsonl(fake.callsPath);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].args[1], 'cc::intervene');
    const sentPayload = JSON.parse(calls[0].args[calls[0].args.indexOf('--json') + 1]);
    assert.equal(sentPayload.session_id, 'session-1');
    assert.equal(sentPayload.message, 'please report status');
    assert.equal(sentPayload.reason, 'operator approved stale-state follow-up');
    assert.equal(sentPayload.monitor_snapshot_id, 'snap-1');

    const records = await readJsonl(paths.interventions);
    assert.equal(records.length, 1);
    assert.equal(records[0].kind, 'agent_hub.cc_run_intervention');
    assert.equal(records[0].approved, true);
    assert.equal(records[0].session_id, 'session-1');
    assert.equal(records[0].message, 'please report status');
    assert.equal(records[0].reason, 'operator approved stale-state follow-up');
    assert.equal(records[0].monitor_snapshot_id, 'snap-1');
    assert.equal(records[0].send_result.status, 'sent');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('archive-cc-intervention archives failed send result and exits non-zero', async () => {
  const { base, paths } = await setupRun();
  const fake = await writeFakeIii(base, 'error');
  try {
    const res = await runScript([
      '--manifest', paths.manifest,
      '--session', 'session-1',
      '--message', 'please report status',
      '--reason', 'operator approved stale-state follow-up',
      '--monitor-snapshot-id', 'snap-1',
      '--iii-bin', fake.scriptPath,
      '--confirm',
    ]);
    assert.equal(res.code, 1);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.status, 'error');
    const records = await readJsonl(paths.interventions);
    assert.equal(records.length, 1);
    assert.equal(records[0].send_result.status, 'error');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
