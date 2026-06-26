// Phase 6 review-worker gate runner tests (RED phase)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mod = await import('../src/gates.js').catch(() => ({}));
const {
  runGate,
  runDangerScan,
  runVerify,
  runCounter,
  mapDangerStatus,
  mapVerifyStatus,
  mapCounterStatus,
} = mod;

async function fakeGate(dir, body) {
  const p = join(dir, 'fake-gate.sh');
  await writeFile(p, `#!/usr/bin/env bash\n${body}\n`, 'utf8');
  await chmod(p, 0o755);
  return p;
}

test('mapDangerStatus maps gate-danger exit codes', () => {
  assert.ok(mapDangerStatus, 'mapDangerStatus must be implemented');
  assert.deepEqual(mapDangerStatus(0), { status: 'ok', verdict: 'pass', danger: false });
  assert.deepEqual(mapDangerStatus(10), { status: 'blocked', verdict: 'fail', danger: true });
  assert.equal(mapDangerStatus(3).status, 'error');
});

test('mapVerifyStatus maps gate-verify exit codes', () => {
  assert.ok(mapVerifyStatus, 'mapVerifyStatus must be implemented');
  assert.deepEqual(mapVerifyStatus(0), { status: 'passed', verdict: 'pass' });
  assert.deepEqual(mapVerifyStatus(1), { status: 'failed', verdict: 'fail' });
  assert.deepEqual(mapVerifyStatus(2), { status: 'failed', verdict: 'fail' });
  assert.deepEqual(mapVerifyStatus(10), { status: 'failed', verdict: 'fail' });
  assert.equal(mapVerifyStatus(3).status, 'error');
});

test('mapCounterStatus maps gate-counter exit codes', () => {
  assert.ok(mapCounterStatus, 'mapCounterStatus must be implemented');
  assert.deepEqual(mapCounterStatus(0), { status: 'ok', verdict: 'pass' });
  assert.deepEqual(mapCounterStatus(20), { status: 'over_limit', verdict: 'stop' });
  assert.equal(mapCounterStatus(3).status, 'error');
});

test('runGate captures stdout stderr and exit code without throwing', async () => {
  assert.ok(runGate, 'runGate must be implemented');
  const dir = await mkdtemp(join(tmpdir(), 'review-worker-gate-'));
  try {
    const gate = await fakeGate(dir, "echo out; echo err >&2; exit 10");
    const res = await runGate({ gate_bin: gate, args: ['--x'], timeout_ms: 5000 });
    assert.equal(res.exit_code, 10);
    assert.match(res.stdout, /out/);
    assert.match(res.stderr, /err/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('runDangerScan passes scan_text and maps blocked verdict', async () => {
  assert.ok(runDangerScan, 'runDangerScan must be implemented');
  const dir = await mkdtemp(join(tmpdir(), 'review-worker-danger-'));
  const calls = join(dir, 'calls.txt');
  try {
    const gate = await fakeGate(dir, `printf '%s\\n' "$@" > ${JSON.stringify(calls)}; echo danger; exit 10`);
    const res = await runDangerScan({ scan_text: 'rm -rf /tmp/x', gate_bin: gate });
    assert.equal(res.kind, 'review.danger_scan');
    assert.equal(res.status, 'blocked');
    assert.equal(res.verdict, 'fail');
    assert.equal(res.danger, true);
    const args = await readFile(calls, 'utf8');
    assert.match(args, /--scan-text/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('runVerify passes cmds/artifacts/cwd and maps pass verdict', async () => {
  assert.ok(runVerify, 'runVerify must be implemented');
  const dir = await mkdtemp(join(tmpdir(), 'review-worker-verify-'));
  const calls = join(dir, 'calls.txt');
  try {
    const gate = await fakeGate(dir, `printf '%s\\n' "$@" > ${JSON.stringify(calls)}; echo verified; exit 0`);
    const res = await runVerify({ cmds: ['true'], artifacts: ['/tmp/out.md'], cwd: '/tmp', gate_bin: gate });
    assert.equal(res.kind, 'review.verify');
    assert.equal(res.status, 'passed');
    assert.equal(res.verdict, 'pass');
    const args = await readFile(calls, 'utf8');
    assert.match(args, /--cmd/);
    assert.match(args, /--artifact/);
    assert.match(args, /--cwd/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('runCounter maps over limit and passes key/kind/action', async () => {
  assert.ok(runCounter, 'runCounter must be implemented');
  const dir = await mkdtemp(join(tmpdir(), 'review-worker-counter-'));
  const calls = join(dir, 'calls.txt');
  try {
    const gate = await fakeGate(dir, `printf '%s\\n' "$@" > ${JSON.stringify(calls)}; echo '{"over":true}'; exit 20`);
    const res = await runCounter({ key: 'run-1', kind: 'reject', action: 'inc', limit: 2, gate_bin: gate });
    assert.equal(res.kind, 'review.counter');
    assert.equal(res.status, 'over_limit');
    assert.equal(res.verdict, 'stop');
    const args = await readFile(calls, 'utf8');
    assert.match(args, /--key/);
    assert.match(args, /--kind/);
    assert.match(args, /--inc/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
