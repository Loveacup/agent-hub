// Phase 5 Runtime Orchestrator — run-cc-task skeleton tests (RED phase)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
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

async function writeFakeIii(dir, mode) {
  const callsPath = join(dir, 'iii-calls.jsonl');
  const scriptPath = join(dir, 'fake-iii.mjs');
  const content = `#!/usr/bin/env node\nimport { appendFileSync } from 'node:fs';\nconst callsPath = ${JSON.stringify(callsPath)};\nconst args = process.argv.slice(2);\nappendFileSync(callsPath, JSON.stringify({ args }) + '\\n');\nconst action = args[1] || '';\nif (${JSON.stringify(mode)} === 'invalid-json') {\n  console.log('not json');\n  process.exit(0);\n}\nif (action === 'cc::bridge_status') {\n  if (${JSON.stringify(mode)} === 'bridge-fail') {\n    console.log(JSON.stringify({ kind: 'cc.bridge_status', status: 'error', error: 'bridge down' }));\n    process.exit(0);\n  }\n  console.log(JSON.stringify({ kind: 'cc.bridge_status', status: 'ok', bridge: { status: 'ok' } }));\n  process.exit(0);\n}\nif (action === 'cc::execute') {\n  if (${JSON.stringify(mode)} === 'active-sessions') {\n    console.log(JSON.stringify({ kind: 'cc.execute', status: 'blocked', lifecycle_state: 'active_sessions_require_ack', sessions: ['hermes-cc-existing'] }));\n    process.exit(0);\n  }\n  console.log(JSON.stringify({ kind: 'cc.execute', status: 'sent', lifecycle_state: 'sent_not_completed', session_id: 'hermes-cc-default-agent-hub-test' }));\n  process.exit(0);\n}\nconsole.log(JSON.stringify({ status: 'error', error: 'unknown action', action }));\nprocess.exit(0);\n`;
  await writeFile(scriptPath, content, 'utf8');
  await chmod(scriptPath, 0o755);
  return { scriptPath, callsPath };
}

async function writeFakeWatcher(dir) {
  const callsPath = join(dir, 'watcher-calls.jsonl');
  const scriptPath = join(dir, 'fake-watcher.mjs');
  const content = `#!/usr/bin/env node\nimport { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ args: process.argv.slice(2) }) + '\\n');\nsetTimeout(() => process.exit(0), 25);\n`;
  await writeFile(scriptPath, content, 'utf8');
  await chmod(scriptPath, 0o755);
  return { scriptPath, callsPath };
}

async function waitForFile(path, attempts = 20) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      await stat(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(`file did not appear: ${path}`);
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

test('run-cc-task stops after bridge_status failure and writes final.json', async () => {
  const base = await mkdtemp(join(tmpdir(), 'agent-hub-run-task-bridge-fail-'));
  const contextPath = join(base, 'context.md');
  await writeFile(contextPath, 'hello context\n', 'utf8');
  const fake = await writeFakeIii(base, 'bridge-fail');
  try {
    const res = await runScript([
      '--target', 'agent-hub',
      '--task', 'test task',
      '--context', contextPath,
      '--base-dir', join(base, 'runs'),
      '--iii-bin', fake.scriptPath,
    ]);
    assert.equal(res.code, 1, res.stderr);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.status, 'failed');
    const manifest = JSON.parse(await readFile(payload.manifest_path, 'utf8'));
    assert.equal(manifest.status, 'failed');
    assert.deepEqual(manifest.history.map((h) => h.status), ['starting', 'bridge_checking', 'failed']);
    const final = JSON.parse(await readFile(payload.final_path, 'utf8'));
    assert.equal(final.status, 'failed');
    assert.match(final.error, /bridge/i);
    const calls = (await readFile(fake.callsPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(calls.length, 1, 'must not call cc::execute after bridge failure');
    assert.equal(calls[0].args[1], 'cc::bridge_status');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('run-cc-task bridge-check-only stops after bridge_status ok without execute or watcher', async () => {
  const base = await mkdtemp(join(tmpdir(), 'agent-hub-run-task-bridge-check-'));
  const contextPath = join(base, 'context.md');
  await writeFile(contextPath, 'hello context\n', 'utf8');
  const fake = await writeFakeIii(base, 'ok');
  const watcher = await writeFakeWatcher(base);
  try {
    const res = await runScript([
      '--target', 'agent-hub',
      '--task', 'test task',
      '--context', contextPath,
      '--base-dir', join(base, 'runs'),
      '--iii-bin', fake.scriptPath,
      '--watcher-bin', watcher.scriptPath,
      '--bridge-check-only',
    ]);
    assert.equal(res.code, 0, res.stderr);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.status, 'bridge_ok');
    assert.equal(payload.bridge_check_only, true);
    const manifest = JSON.parse(await readFile(payload.manifest_path, 'utf8'));
    assert.equal(manifest.status, 'bridge_ok');
    assert.deepEqual(manifest.history.map((h) => h.status), ['starting', 'bridge_checking', 'bridge_ok']);
    const final = JSON.parse(await readFile(payload.final_path, 'utf8'));
    assert.equal(final.status, 'bridge_ok');
    assert.equal(final.bridge_check_only, true);
    const calls = (await readFile(fake.callsPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(calls.map((c) => c.args[1]), ['cc::bridge_status']);
    await assert.rejects(readFile(watcher.callsPath, 'utf8'), /ENOENT/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('run-cc-task executes after bridge ok and marks manifest watching', async () => {
  const base = await mkdtemp(join(tmpdir(), 'agent-hub-run-task-execute-'));
  const contextPath = join(base, 'context.md');
  await writeFile(contextPath, 'hello context\n', 'utf8');
  const fake = await writeFakeIii(base, 'ok');
  const watcher = await writeFakeWatcher(base);
  try {
    const res = await runScript([
      '--target', 'agent-hub',
      '--task', 'test task',
      '--context', contextPath,
      '--base-dir', join(base, 'runs'),
      '--iii-bin', fake.scriptPath,
      '--watcher-bin', watcher.scriptPath,
    ]);
    assert.equal(res.code, 0, res.stderr);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.status, 'watching');
    assert.equal(payload.session_id, 'hermes-cc-default-agent-hub-test');
    const manifest = JSON.parse(await readFile(payload.manifest_path, 'utf8'));
    assert.equal(manifest.status, 'watching');
    assert.equal(manifest.session_id, 'hermes-cc-default-agent-hub-test');
    assert.deepEqual(manifest.history.map((h) => h.status), ['starting', 'bridge_checking', 'executing', 'watching']);
    const calls = (await readFile(fake.callsPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(calls.map((c) => c.args[1]), ['cc::bridge_status', 'cc::execute']);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('run-cc-task maps active session ack gate to blocked instead of failed', async () => {
  const base = await mkdtemp(join(tmpdir(), 'agent-hub-run-task-active-sessions-'));
  const contextPath = join(base, 'context.md');
  await writeFile(contextPath, 'hello context\n', 'utf8');
  const fake = await writeFakeIii(base, 'active-sessions');
  const watcher = await writeFakeWatcher(base);
  try {
    const res = await runScript([
      '--target', 'agent-hub',
      '--task', 'test task',
      '--context', contextPath,
      '--base-dir', join(base, 'runs'),
      '--iii-bin', fake.scriptPath,
      '--watcher-bin', watcher.scriptPath,
    ]);
    assert.equal(res.code, 3, res.stderr);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.status, 'blocked');
    assert.match(payload.error, /active_sessions_require_ack/);
    const manifest = JSON.parse(await readFile(payload.manifest_path, 'utf8'));
    assert.equal(manifest.status, 'blocked');
    assert.deepEqual(manifest.history.map((h) => h.status), ['starting', 'bridge_checking', 'executing', 'blocked']);
    const final = JSON.parse(await readFile(payload.final_path, 'utf8'));
    assert.equal(final.status, 'blocked');
    assert.equal(final.execute.lifecycle_state, 'active_sessions_require_ack');
    await assert.rejects(readFile(watcher.callsPath, 'utf8'), /ENOENT/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('run-cc-task records final.json when iii returns invalid JSON', async () => {
  const base = await mkdtemp(join(tmpdir(), 'agent-hub-run-task-invalid-json-'));
  const contextPath = join(base, 'context.md');
  await writeFile(contextPath, 'hello context\n', 'utf8');
  const fake = await writeFakeIii(base, 'invalid-json');
  try {
    const res = await runScript([
      '--target', 'agent-hub',
      '--task', 'test task',
      '--context', contextPath,
      '--base-dir', join(base, 'runs'),
      '--iii-bin', fake.scriptPath,
    ]);
    assert.equal(res.code, 1, res.stderr);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.status, 'failed');
    const final = JSON.parse(await readFile(payload.final_path, 'utf8'));
    assert.equal(final.status, 'failed');
    assert.match(final.error, /invalid JSON/i);
    const manifest = JSON.parse(await readFile(payload.manifest_path, 'utf8'));
    assert.equal(manifest.status, 'failed');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('run-cc-task spawns watcher after execute success and records watcher metadata', async () => {
  const base = await mkdtemp(join(tmpdir(), 'agent-hub-run-task-watcher-'));
  const contextPath = join(base, 'context.md');
  await writeFile(contextPath, 'hello context\n', 'utf8');
  const fake = await writeFakeIii(base, 'ok');
  const watcher = await writeFakeWatcher(base);
  try {
    const res = await runScript([
      '--target', 'agent-hub',
      '--task', 'test task',
      '--context', contextPath,
      '--base-dir', join(base, 'runs'),
      '--iii-bin', fake.scriptPath,
      '--watcher-bin', watcher.scriptPath,
      '--watch-interval-ms', '10',
      '--watch-max-ticks', '1',
    ]);
    assert.equal(res.code, 0, res.stderr);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.status, 'watching');
    assert.ok(Number.isInteger(payload.watcher_pid));
    assert.ok(payload.watcher_command.includes('hermes-cc-default-agent-hub-test'));
    await waitForFile(watcher.callsPath);
    const watcherCall = JSON.parse((await readFile(watcher.callsPath, 'utf8')).trim());
    assert.deepEqual(watcherCall.args, [
      '--session', 'hermes-cc-default-agent-hub-test',
      '--interval-ms', '10',
      '--max-ticks', '1',
      '--output', payload.watch_path,
      '--stale-after-ticks', '8',
    ]);
    const manifest = JSON.parse(await readFile(payload.manifest_path, 'utf8'));
    assert.equal(manifest.status, 'watching');
    assert.equal(manifest.watcher.pid, payload.watcher_pid);
    assert.equal(manifest.watcher.output, payload.watch_path);
    assert.ok(manifest.watcher.command.includes(watcher.scriptPath));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
