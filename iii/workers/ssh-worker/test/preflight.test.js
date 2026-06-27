// Phase 8 Slice 1 — read-only preflight tests (injected runner, no real SSH).
//
// preflight imports no fs/subprocess/socket; the injected runner is the sole
// boundary. It only ever issues allowlisted read-only commands. Fail-closed:
// unknown/disabled host, invalid runtime, missing/throwing runner, or timeout
// all yield { ready:false } and never throw. The result carries a Phase 9
// `askills_doctor` extension point that stays skipped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { preflight, createMockRunner } from '../src/preflight.js';
import { loadHostRegistryFromObject } from '../src/registry.js';

const validObj = JSON.parse(readFileSync(new URL('./fixtures/hosts.valid.json', import.meta.url), 'utf8'));
const { registry } = loadHostRegistryFromObject(validObj);

const ALLOWED = new Set(['true', 'command -v codex', 'codex --version']);

// Wrap a runner to capture every command it is asked to run.
function recordingRunner(inner) {
  const commands = [];
  const runner = ({ host, command }) => {
    commands.push(command);
    return inner({ host, command });
  };
  return { runner, commands };
}

function checkByName(res, name) {
  return res.checks.find((c) => c.name === name);
}

// ── preflight.js imports no fs/subprocess/socket capability ──────────────────
test('preflight.js imports no fs/subprocess/socket', () => {
  const src = readFileSync(fileURLToPath(new URL('../src/preflight.js', import.meta.url)), 'utf8');
  assert.ok(!/from\s+['"]node:fs|from\s+['"]fs['"]|require\(/.test(src), 'must not import fs');
  assert.ok(!/node:child_process|child_process|spawn|execSync/.test(src), 'must not import subprocess');
  assert.ok(!/node:net|node:https?|fetch\(/.test(src), 'must not import net/http');
});

// ── unknown host fails closed ────────────────────────────────────────────────
test('unknown host -> ready:false host_not_found', () => {
  const res = preflight({ device_id: 'no-such', runtime: 'codex' }, { runner: createMockRunner(), registry });
  assert.equal(res.ready, false);
  assert.equal(res.decision_code, 'host_not_found');
});

// ── disabled host fails closed ───────────────────────────────────────────────
test('disabled host -> ready:false host_disabled', () => {
  const res = preflight({ device_id: 'pi-02', runtime: 'codex' }, { runner: createMockRunner(), registry });
  assert.equal(res.ready, false);
  assert.equal(res.decision_code, 'host_disabled');
});

// ── happy path: reachable + runtime present -> ready ─────────────────────────
test('reachable host with runtime present -> ready:true', () => {
  const runner = createMockRunner({ 'nas-01': { reachable: true, runtimes: { codex: true } } });
  const res = preflight({ device_id: 'nas-01', runtime: 'codex' }, { runner, registry });
  assert.equal(res.ready, true);
  assert.equal(res.decision_code, 'ready');
  assert.equal(checkByName(res, 'ssh_reachable').status, 'pass');
  assert.equal(checkByName(res, 'ssh_reachable').source, 'ssh-worker');
  assert.equal(checkByName(res, 'runtime_present').status, 'pass');
  const askills = checkByName(res, 'askills_doctor');
  assert.equal(askills.source, 'askills');
  assert.equal(askills.status, 'skipped');
  assert.equal(askills.reason, 'phase_9_not_enabled');
});

// ── runtime missing on a reachable host -> not ready ─────────────────────────
test('reachable host missing runtime -> ready:false', () => {
  const runner = createMockRunner({ 'nas-01': { reachable: true, runtimes: { codex: false } } });
  const res = preflight({ device_id: 'nas-01', runtime: 'codex' }, { runner, registry });
  assert.equal(res.ready, false);
  assert.equal(checkByName(res, 'ssh_reachable').status, 'pass');
  assert.equal(checkByName(res, 'runtime_present').status, 'fail');
});

// ── unreachable host -> not ready, runtime probe skipped ─────────────────────
test('unreachable host -> ready:false and runtime_present skipped', () => {
  const runner = createMockRunner({ 'nas-01': { reachable: false } });
  const res = preflight({ device_id: 'nas-01', runtime: 'codex' }, { runner, registry });
  assert.equal(res.ready, false);
  assert.equal(checkByName(res, 'ssh_reachable').status, 'fail');
  assert.equal(checkByName(res, 'runtime_present').status, 'skipped');
});

// ── runtime not declared in registry -> fail closed ──────────────────────────
test('runtime not declared on host -> runtime_not_declared', () => {
  const runner = createMockRunner({ 'nas-01': { reachable: true, runtimes: { python: true } } });
  const res = preflight({ device_id: 'nas-01', runtime: 'python' }, { runner, registry });
  assert.equal(res.ready, false);
  assert.equal(res.decision_code, 'runtime_not_declared');
});

// ── invalid runtime token -> fail closed before any runner call ──────────────
test('invalid runtime token -> invalid_runtime, runner never called', () => {
  const { runner, commands } = recordingRunner(createMockRunner({ 'nas-01': { reachable: true } }));
  const res = preflight({ device_id: 'nas-01', runtime: 'co; rm -rf /' }, { runner, registry });
  assert.equal(res.ready, false);
  assert.equal(res.decision_code, 'invalid_runtime');
  assert.equal(commands.length, 0, 'runner must not be called for an invalid runtime');
});

// ── only allowlisted read-only commands ever reach the runner ────────────────
test('runner only ever receives allowlisted read-only commands', () => {
  const { runner, commands } = recordingRunner(createMockRunner({ 'nas-01': { reachable: true, runtimes: { codex: true } } }));
  preflight({ device_id: 'nas-01', runtime: 'codex' }, { runner, registry });
  assert.ok(commands.length >= 2);
  for (const cmd of commands) {
    assert.ok(ALLOWED.has(cmd), `non-allowlisted command reached runner: ${cmd}`);
    assert.ok(!/rm|>|>>|tee|cp|mv|install|chmod|curl|wget|cat\s/.test(cmd), `write/mutation command leaked: ${cmd}`);
  }
});

// ── timeout -> degraded + warning, not ready ─────────────────────────────────
test('runner timeout -> ready:false, degraded:true, timeout warning', () => {
  const runner = createMockRunner({ 'nas-01': { timeout: true } });
  const res = preflight({ device_id: 'nas-01', runtime: 'codex' }, { runner, registry });
  assert.equal(res.ready, false);
  assert.equal(res.degraded, true);
  assert.ok(res.warnings.includes('ssh_reachable_timeout'));
  assert.equal(checkByName(res, 'ssh_reachable').status, 'fail');
  assert.equal(checkByName(res, 'ssh_reachable').reason, 'timeout');
});

// ── missing / throwing runner fails closed without throwing ──────────────────
test('missing runner -> no_runner', () => {
  const res = preflight({ device_id: 'nas-01', runtime: 'codex' }, { registry });
  assert.equal(res.ready, false);
  assert.equal(res.decision_code, 'no_runner');
});

test('throwing runner is caught -> ssh_reachable fail, not ready', () => {
  const runner = () => { throw new Error('boom'); };
  const res = preflight({ device_id: 'nas-01', runtime: 'codex' }, { runner, registry });
  assert.equal(res.ready, false);
  assert.equal(checkByName(res, 'ssh_reachable').status, 'fail');
  assert.equal(checkByName(res, 'ssh_reachable').reason, 'runner_threw');
});

// ── never throws on malformed input ──────────────────────────────────────────
test('preflight never throws on malformed input', () => {
  for (const arg of [undefined, null, 42, 'str', {}, { device_id: 5 }]) {
    let res;
    assert.doesNotThrow(() => {
      res = preflight(arg, { runner: createMockRunner(), registry });
    }, `threw on ${String(arg)}`);
    assert.equal(res.ready, false);
  }
  // malformed deps too
  assert.doesNotThrow(() => preflight({ device_id: 'nas-01', runtime: 'codex' }, undefined));
});
