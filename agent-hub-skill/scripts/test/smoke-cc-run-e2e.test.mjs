// Phase 5 Runtime Orchestrator — fake end-to-end smoke test (RED phase)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';

const SCRIPT = new URL('../smoke-cc-run-e2e.mjs', import.meta.url).pathname;

function runScript(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT, ...args], { timeout: 20_000, maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err?.code ?? 0, stdout, stderr });
    });
  });
}

async function writeFakeIii(dir) {
  const callsPath = join(dir, 'iii-calls.jsonl');
  const scriptPath = join(dir, 'fake-iii.mjs');
  const content = `#!/usr/bin/env node\nimport { appendFileSync } from 'node:fs';\nconst callsPath = ${JSON.stringify(callsPath)};\nconst args = process.argv.slice(2);\nappendFileSync(callsPath, JSON.stringify({ args }) + '\\n');\nconst action = args[1] || '';\nif (action === 'cc::bridge_status') {\n  console.log(JSON.stringify({ kind: 'cc.bridge_status', status: 'ok', bridge: { status: 'ok' } }));\n} else if (action === 'cc::execute') {\n  console.log(JSON.stringify({ kind: 'cc.execute', status: 'sent', lifecycle_state: 'sent_not_completed', session_id: 'session-e2e' }));\n} else if (action === 'cc::intervene') {\n  console.log(JSON.stringify({ kind: 'cc.intervention', status: 'sent', session_id: 'session-e2e', message_id: 'msg-e2e' }));\n} else {\n  console.log(JSON.stringify({ status: 'error', error: 'unexpected action', action }));\n}\n`;
  await writeFile(scriptPath, content, 'utf8');
  await chmod(scriptPath, 0o755);
  return { scriptPath, callsPath };
}

async function writeFakeWatcher(dir) {
  const callsPath = join(dir, 'watcher-calls.jsonl');
  const scriptPath = join(dir, 'fake-watcher.mjs');
  const content = `#!/usr/bin/env node\nimport { appendFileSync, writeFileSync } from 'node:fs';\nconst args = process.argv.slice(2);\nappendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ args }) + '\\n');\nconst output = args[args.indexOf('--output') + 1];\nconst session = args[args.indexOf('--session') + 1];\nconst suggestion = { kind: 'cc.intervention.suggestion', session_id: session, reason: 'state_stale', auto_execute: false, monitor_snapshot_id: 'snap-e2e' };\nwriteFileSync(output, [\n  JSON.stringify({ kind: 'cc.watch.event', session_id: session, sequence: 1, state: 'THINKING', terminal: false, suggestion, ts: '2026-06-26T00:00:01Z' }),\n  JSON.stringify({ kind: 'cc.watch.event', session_id: session, sequence: 2, state: 'BLOCKED', terminal: true, monitor: { status: 'ok', state: 'BLOCKED' }, ts: '2026-06-26T00:00:02Z' }),\n].join('\\n') + '\\n');\n`;
  await writeFile(scriptPath, content, 'utf8');
  await chmod(scriptPath, 0o755);
  return { scriptPath, callsPath };
}

async function readJsonl(path) {
  return (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

test('smoke-cc-run-e2e runs fake run → watcher → collect → approved intervention archive', async () => {
  const base = await mkdtemp(join(tmpdir(), 'agent-hub-e2e-test-'));
  const fakeIii = await writeFakeIii(base);
  const fakeWatcher = await writeFakeWatcher(base);
  try {
    const res = await runScript([
      '--base-dir', join(base, 'runs'),
      '--iii-bin', fakeIii.scriptPath,
      '--watcher-bin', fakeWatcher.scriptPath,
    ]);
    assert.equal(res.code, 0, res.stderr);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.status, 'sent');
    assert.equal(payload.run.status, 'watching');
    assert.equal(payload.collect.status, 'blocked');
    assert.equal(payload.collect.suggestions_count, 1);
    assert.equal(payload.intervention.status, 'sent');

    const calls = await readJsonl(fakeIii.callsPath);
    assert.deepEqual(calls.map((c) => c.args[1]), ['cc::bridge_status', 'cc::execute', 'cc::intervene']);

    const manifest = JSON.parse(await readFile(payload.paths.manifest, 'utf8'));
    assert.equal(manifest.status, 'blocked');
    assert.equal(manifest.session_id, 'session-e2e');

    const suggestions = await readJsonl(payload.paths.suggestions);
    assert.equal(suggestions.length, 1);
    assert.equal(suggestions[0].suggestion.auto_execute, false);

    const interventions = await readJsonl(payload.paths.interventions);
    assert.equal(interventions.length, 1);
    assert.equal(interventions[0].approved, true);
    assert.equal(interventions[0].monitor_snapshot_id, 'snap-e2e');
    assert.equal(interventions[0].send_result.status, 'sent');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
