// Phase 8 Slice 1 — fail-closed runtime entry tests (pure, no remote runtime).
//
// src/index.js is the importable worker entry. It is fail-closed BY
// CONSTRUCTION: no filesystem access, no SSH connect, no subprocess, no socket,
// no real NATS publish, no askills call, no process.env read, and no remote
// execution. Every execution-shaped or unknown request returns an explicit
// `unsupported` response with execute:false; only an allowlisted set of safe
// metadata/control-plane request types returns static metadata. list_hosts
// projects a SAFE listing from a CALLER-injected registry only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  getWorkerMetadata,
  getCapabilities,
  describeRuntimeContract,
  healthCheck,
  handleUnsupportedExecution,
  handleControlPlaneRequest,
  handleRequest,
} from '../src/index.js';
import { loadHostRegistryFromObject } from '../src/registry.js';

// Recognizable markers — if any serialized output contains one, leakage failed.
const SECRET = 'sk-SECRET-VALUE-do-not-leak-0xDEADBEEF';
const BODY = 'BODY-TRANSCRIPT-do-not-leak-lorem-ipsum';
const TOKEN = 'ghp_TOKEN-do-not-leak-123456';

const validObj = JSON.parse(readFileSync(new URL('./fixtures/hosts.valid.json', import.meta.url), 'utf8'));
const { registry } = loadHostRegistryFromObject(validObj);

function assertControlPlane(cp) {
  assert.ok(cp && typeof cp === 'object', 'control_plane must be present');
  assert.equal(cp.monitoring_required, true);
  assert.equal(cp.intervention_required, true);
  assert.equal(cp.monitorable, true);
  assert.equal(cp.intervenable, false);
  assert.equal(cp.runtime_available, false);
  assert.equal(cp.status, 'unavailable');
}

// ── metadata reports unregistered / no runtime / no execution ────────────────
test('getWorkerMetadata reports ssh-worker phase 8 fail-closed', () => {
  const meta = getWorkerMetadata();
  assert.equal(meta.kind, 'ssh.worker.metadata');
  assert.equal(meta.name, 'ssh-worker');
  assert.equal(meta.phase, 8);
  assert.equal(meta.registered, false);
  assert.equal(meta.runtime_available, false);
  assert.equal(meta.execution_enabled, false);
  assert.equal(meta.metadata_only, true);
  assert.equal(meta.redacted, true);
});

// ── capabilities split safe caps from unsupported execution caps ─────────────
test('getCapabilities marks remote execution caps unsupported', () => {
  const caps = getCapabilities();
  assert.equal(caps.kind, 'ssh.worker.capabilities');
  assert.equal(caps.execute, false);
  // Slice 2 promotes acquire_remote/execute_remote to MOCKED supported caps
  // (no real runtime, execute:false) — see test/index.slice2.test.js. The
  // remaining execution-shaped caps stay fail-closed.
  // Slice 3 promotes terminate_remote (+ status/release_remote) to MOCKED
  // supported caps — see test/index.slice3.test.js. The rest stay fail-closed.
  for (const u of ['remote_file_write', 'remote_codex_exec', 'nats_publish', 'askills_call']) {
    assert.ok(caps.unsupported.includes(u), `unsupported must include ${u}`);
  }
  for (const s of ['host_registry_validation', 'list_hosts', 'preflight_readonly', 'subject_sanitization']) {
    assert.ok(caps.supported.includes(s), `supported must include ${s}`);
  }
  const overlap = caps.supported.filter((c) => caps.unsupported.includes(c));
  assert.deepEqual(overlap, [], 'supported/unsupported must not overlap');
});

// ── runtime contract carries the monitorability/intervention contract ────────
test('describeRuntimeContract reports runtime unavailable, not intervenable', () => {
  const contract = describeRuntimeContract();
  assert.equal(contract.kind, 'ssh.worker.runtime_contract');
  assert.equal(contract.runtime_available, false);
  assert.equal(contract.execute, false);
  assertControlPlane(contract.control_plane);
});

// ── health is static-only ────────────────────────────────────────────────────
test('healthCheck is static-only and does not check external runtime', () => {
  assert.deepEqual(healthCheck(), {
    ok: true,
    kind: 'ssh.worker.health',
    static_entry_ok: true,
    external_runtime_checked: false,
    runtime_available: false,
    execute: false,
  });
});

// ── execution-shaped requests fail closed with no payload leakage ────────────
test('remote execution requests fail closed with execute:false, no leakage', () => {
  for (const type of ['acquire_remote', 'execute_remote', 'terminate_remote', 'remote.codex.exec', 'nats.publish', 'askills.doctor']) {
    const res = handleUnsupportedExecution({
      type,
      payload: { token: TOKEN },
      body: BODY,
      content: BODY,
      env: { OPENAI_API_KEY: SECRET },
      token: TOKEN,
    });
    assert.equal(res.ok, false);
    assert.equal(res.kind, 'ssh.worker.unsupported');
    assert.equal(res.execute, false);
    assert.equal(res.decision_code, 'ssh_remote_execution_unsupported');
    assertControlPlane(res.control_plane);

    const json = JSON.stringify(res);
    assert.ok(!json.includes(SECRET), `must not leak secret for ${type}`);
    assert.ok(!json.includes(BODY), `must not leak body for ${type}`);
    assert.ok(!json.includes(TOKEN), `must not leak token for ${type}`);
    for (const k of ['payload', 'body', 'content', 'env', 'token']) {
      assert.ok(!Object.prototype.hasOwnProperty.call(res, k), `response must not carry raw ${k}`);
    }
  }
});

test('handleUnsupportedExecution never throws on malformed input', () => {
  for (const bad of [undefined, null, 42, 'string', ['x'], () => {}]) {
    let res;
    assert.doesNotThrow(() => {
      res = handleUnsupportedExecution(bad);
    });
    assert.equal(res.ok, false);
    assert.equal(res.execute, false);
    assert.equal(res.decision_code, 'ssh_remote_execution_unsupported');
  }
});

// ── unknown request fails closed ─────────────────────────────────────────────
test('unknown control-plane request fails closed', () => {
  for (const req of [{ type: 'totally_unknown' }, {}, { foo: 'bar' }, undefined]) {
    const res = handleControlPlaneRequest(req);
    assert.equal(res.ok, false);
    assert.equal(res.execute, false);
    assert.equal(res.kind, 'ssh.worker.unsupported');
    assert.equal(res.decision_code, 'ssh_remote_execution_unsupported');
  }
});

// ── safe request types return static metadata ────────────────────────────────
test('safe control-plane types return metadata/capabilities/contract/health', () => {
  const cases = [
    ['metadata', getWorkerMetadata()],
    ['capabilities', getCapabilities()],
    ['contract', describeRuntimeContract()],
    ['health', healthCheck()],
  ];
  for (const [type, expected] of cases) {
    const res = handleControlPlaneRequest({ type });
    assert.equal(res.ok, true, `${type} should be safe`);
    assert.equal(res.execute, false, `${type} keeps execute:false`);
    assert.equal(res.kind, 'ssh.worker.control_plane');
    assert.equal(res.type, type);
    assertControlPlane(res.control_plane);
    assert.deepEqual(res.result, expected);
  }
});

test('handleControlPlaneRequest always returns execute:false', () => {
  for (const req of [{ type: 'metadata' }, { type: 'list_hosts' }, { type: 'execute_remote' }, { type: 'unknown' }, undefined]) {
    assert.equal(handleControlPlaneRequest(req).execute, false);
  }
});

test('handleRequest is an alias of handleControlPlaneRequest', () => {
  assert.equal(handleRequest, handleControlPlaneRequest);
});

// ── list_hosts: injected registry projects a safe listing ────────────────────
test('list_hosts with injected registry returns enabled hosts only', () => {
  const res = handleControlPlaneRequest({ type: 'list_hosts' }, { registry });
  assert.equal(res.ok, true);
  assert.equal(res.execute, false);
  assert.equal(res.result.registry_loaded, true);
  assert.equal(res.result.hosts.length, 1);
  assert.equal(res.result.hosts[0].id, 'nas-01');
});

test('list_hosts without a registry returns an empty list', () => {
  const res = handleControlPlaneRequest({ type: 'list_hosts' });
  assert.equal(res.ok, true);
  assert.equal(res.result.registry_loaded, false);
  assert.deepEqual(res.result.hosts, []);
});

test('list_hosts never leaks ssh connection details', () => {
  const res = handleControlPlaneRequest({ type: 'list_hosts' }, { registry });
  const json = JSON.stringify(res);
  assert.ok(!json.includes('nas.local'), 'no ssh_host');
  assert.ok(!json.includes('pi.local'), 'no disabled host');
  assert.ok(!/ssh_host|ssh_port|ssh_user|ssh_alias/.test(json), 'no connection keys');
});

// ── source proves no I/O capability import, no process.env ────────────────────
test('src/index.js imports no fs/child_process/net/http and never reads process.env', () => {
  const src = readFileSync(fileURLToPath(new URL('../src/index.js', import.meta.url)), 'utf8');
  assert.ok(!/require\(|from\s+['"]node:fs|from\s+['"]fs['"]/.test(src), 'index.js must not import fs');
  assert.ok(!/node:child_process|child_process|execSync|spawn|exec\(/.test(src), 'index.js must not spawn subprocesses');
  assert.ok(!/node:net|node:https?|from\s+['"]net['"]|fetch\(/.test(src), 'index.js must not open network/sockets');
  assert.ok(!/process\.env/.test(src), 'index.js must not read process.env');
});

// ── `node src/index.js` exits 0 and prints JSON fail-closed status ───────────
test('node src/index.js exits 0 and prints a JSON fail-closed status', () => {
  const srcPath = fileURLToPath(new URL('../src/index.js', import.meta.url));
  let stdout;
  assert.doesNotThrow(() => {
    stdout = execFileSync(process.execPath, [srcPath], { encoding: 'utf8' });
  });
  const status = JSON.parse(stdout);
  assert.equal(status.execute, false);
  assert.equal(status.runtime_available, false);
  assert.equal(status.execution_enabled, false);
  assert.equal(status.fail_closed, true);
  assertControlPlane(status.control_plane);
  assert.ok(!stdout.includes(SECRET) && !stdout.includes(BODY) && !stdout.includes(TOKEN));
});

// ── iii/config.yaml has no ssh-worker registration ───────────────────────────
test('iii/config.yaml contains no ssh-worker registration', () => {
  const cfgPath = fileURLToPath(new URL('../../../config.yaml', import.meta.url));
  const cfg = readFileSync(cfgPath, 'utf8');
  assert.ok(!cfg.includes('ssh-worker'), 'config.yaml must not register ssh-worker');
});
