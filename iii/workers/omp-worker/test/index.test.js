// Phase 7 Slice 7 — fail-closed runtime entry tests (TDD; pure, no runtime).
//
// `src/index.js` is the importable worker entry. It is fail-closed BY
// CONSTRUCTION: it performs NO filesystem access, never reads the real ~/.omp /
// `.env` / `mcp.json`, never inspects process.env, never spawns a subprocess,
// never opens a socket, and never enables OMP runtime execution. Every
// execution-shaped or unknown request returns an explicit `unsupported`
// response with `execute:false`; only an allowlisted set of safe metadata /
// control-plane request types returns static metadata.
//
// These tests are written FIRST and must be RED (import fails — file missing)
// before `src/index.js` exists.
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
} from '../src/index.js';

// Recognizable markers — if any serialized output contains one, leakage failed.
const SECRET = 'sk-SECRET-VALUE-do-not-leak-0xDEADBEEF';
const BODY = 'BODY-TRANSCRIPT-do-not-leak-lorem-ipsum';
const TOKEN = 'ghp_TOKEN-do-not-leak-123456';

// Assert a response carries the mandatory control-plane contract: OMP work is
// never fire-and-forget, and while the runtime is unavailable it is monitorable
// but NOT intervenable.
function assertControlPlane(cp) {
  assert.ok(cp && typeof cp === 'object', 'control_plane must be present');
  assert.equal(cp.monitoring_required, true);
  assert.equal(cp.intervention_required, true);
  assert.equal(cp.monitorable, true);
  assert.equal(cp.intervenable, false);
  assert.equal(cp.runtime_available, false);
  assert.equal(cp.status, 'unavailable');
}

// ── 2. metadata reports unregistered / no runtime / no execution ─────────────
test('getWorkerMetadata reports registered/runtime/execution all false', () => {
  const meta = getWorkerMetadata();
  assert.equal(meta.kind, 'omp.worker.metadata');
  assert.equal(meta.name, 'omp-worker');
  assert.equal(meta.phase, 7);
  assert.equal(meta.registered, false);
  assert.equal(meta.runtime_available, false);
  assert.equal(meta.execution_enabled, false);
  assert.equal(meta.metadata_only, true);
  assert.equal(meta.redacted, true);
});

// ── 3. capabilities split safe metadata caps from unsupported execution caps ─
test('getCapabilities separates supported metadata caps from unsupported execution caps', () => {
  const caps = getCapabilities();
  assert.equal(caps.kind, 'omp.worker.capabilities');
  assert.equal(caps.execute, false);
  assert.ok(Array.isArray(caps.supported) && caps.supported.length >= 1);
  assert.ok(Array.isArray(caps.unsupported) && caps.unsupported.length >= 1);

  // The dangerous capabilities MUST be explicitly listed as unsupported.
  for (const u of [
    'runtime_execution',
    'profile_apply_execution',
    'cross_profile_execution',
    'real_env_read',
    'real_mcp_read',
    'real_omp_smoke',
    'gateway_enablement',
  ]) {
    assert.ok(caps.unsupported.includes(u), `unsupported must include ${u}`);
  }

  // Safe metadata/control-plane capabilities are advertised as supported.
  for (const s of ['profile_registry_validation', 'route_recognition_metadata']) {
    assert.ok(caps.supported.includes(s), `supported must include ${s}`);
  }

  // No capability may be both supported and unsupported.
  const overlap = caps.supported.filter((c) => caps.unsupported.includes(c));
  assert.deepEqual(overlap, [], 'supported/unsupported must not overlap');

  // No execution-shaped capability sneaks into the supported list.
  for (const s of caps.supported) {
    assert.ok(!/execution|apply_execution|smoke|gateway_enablement/.test(s), `supported cap leaks execution: ${s}`);
  }
});

// ── 4. runtime contract carries the monitorability/intervention contract ─────
test('describeRuntimeContract reports runtime unavailable and not intervenable', () => {
  const contract = describeRuntimeContract();
  assert.equal(contract.kind, 'omp.worker.runtime_contract');
  assert.equal(contract.runtime_available, false);
  assert.equal(contract.execution_enabled, false);
  assert.equal(contract.execute, false);
  assertControlPlane(contract.control_plane);
});

// ── 5. healthCheck is static-only, never touches the real runtime ────────────
test('healthCheck is static-only and does not check external runtime', () => {
  const h = healthCheck();
  assert.deepEqual(h, {
    ok: true,
    kind: 'omp.worker.health',
    static_entry_ok: true,
    external_runtime_checked: false,
    runtime_available: false,
    execute: false,
  });
});

// ── 6. execution-shaped request returns unsupported with no payload leakage ──
test('execution-shaped requests fail closed with execute:false and no payload leakage', () => {
  for (const type of [
    'execute',
    'apply',
    'profile.apply',
    'cross_profile.execute',
    'read.env',
    'read.mcp',
    'smoke.real_omp',
  ]) {
    const res = handleUnsupportedExecution({
      type,
      // hostile payload smuggled alongside the request — must never echo back:
      payload: { token: TOKEN },
      body: BODY,
      content: BODY,
      env: { OPENAI_API_KEY: SECRET },
      token: TOKEN,
    });
    assert.equal(res.ok, false);
    assert.equal(res.kind, 'omp.worker.unsupported');
    assert.equal(res.execute, false);
    assert.equal(res.decision_code, 'omp_runtime_execution_unsupported');
    assert.equal(res.metadata_only, true);
    assert.equal(res.redacted, true);
    assert.equal(typeof res.reason, 'string');
    assert.equal(typeof res.alternative, 'string');
    assertControlPlane(res.control_plane);

    const json = JSON.stringify(res);
    assert.ok(!json.includes(SECRET), `must not leak secret for ${type}`);
    assert.ok(!json.includes(BODY), `must not leak body/content for ${type}`);
    assert.ok(!json.includes(TOKEN), `must not leak token for ${type}`);
    // No raw passthrough keys.
    for (const k of ['payload', 'body', 'content', 'env', 'token']) {
      assert.ok(!Object.prototype.hasOwnProperty.call(res, k), `response must not carry raw ${k}`);
    }
  }
});

// handleUnsupportedExecution never throws on malformed input.
test('handleUnsupportedExecution never throws on malformed input', () => {
  for (const bad of [undefined, null, 42, 'string', ['x'], () => {}]) {
    let res;
    assert.doesNotThrow(() => {
      res = handleUnsupportedExecution(bad);
    }, `threw on ${String(bad)}`);
    assert.equal(res.ok, false);
    assert.equal(res.execute, false);
    assert.equal(res.decision_code, 'omp_runtime_execution_unsupported');
  }
});

// ── 7. unknown request fails closed (never best-effort executes) ─────────────
test('unknown control-plane request fails closed, not best-effort execution', () => {
  for (const req of [
    { type: 'totally_unknown_intent' },
    { type: 'render.apply.now' },
    {},
    { foo: 'bar' },
    undefined,
  ]) {
    const res = handleControlPlaneRequest(req);
    assert.equal(res.execute, false);
    assert.equal(res.ok, false, 'unknown request must not succeed');
    assert.equal(res.kind, 'omp.worker.unsupported');
    assert.equal(res.decision_code, 'omp_runtime_execution_unsupported');
    assertControlPlane(res.control_plane);
  }
});

// ── 8. safe metadata/control-plane request types return static metadata ──────
test('safe control-plane request types return metadata/capabilities/contract/health', () => {
  const cases = [
    ['metadata', getWorkerMetadata()],
    ['capabilities', getCapabilities()],
    ['contract', describeRuntimeContract()],
    ['health', healthCheck()],
  ];
  for (const [type, expected] of cases) {
    const res = handleControlPlaneRequest({ type });
    assert.equal(res.ok, true, `${type} should be a safe request`);
    assert.equal(res.execute, false, `${type} must keep execute:false`);
    assert.equal(res.kind, 'omp.worker.control_plane');
    assert.equal(res.type, type);
    assertControlPlane(res.control_plane);
    assert.deepEqual(res.result, expected, `${type} result must match the static payload`);
  }
});

// every handleControlPlaneRequest response is execute:false, even safe ones.
test('handleControlPlaneRequest always returns execute:false', () => {
  for (const req of [
    { type: 'metadata' },
    { type: 'health' },
    { type: 'execute' },
    { type: 'profile.apply' },
    { type: 'unknown' },
    undefined,
  ]) {
    assert.equal(handleControlPlaneRequest(req).execute, false);
  }
});

// ── 9. source proves no fs/child_process/net/http/https import, no process.env ─
test('src/index.js imports no I/O capability and never reads process.env', () => {
  const srcPath = fileURLToPath(new URL('../src/index.js', import.meta.url));
  const src = readFileSync(srcPath, 'utf8');
  assert.ok(!/require\(|from\s+['"]node:fs|from\s+['"]fs['"]/.test(src), 'index.js must not import fs');
  assert.ok(!/node:child_process|child_process|execSync|spawn|exec\(/.test(src), 'index.js must not spawn subprocesses');
  assert.ok(!/node:net|node:https?|from\s+['"]net['"]|fetch\(/.test(src), 'index.js must not open network/sockets');
  assert.ok(!/process\.env/.test(src), 'index.js must not read process.env');
});

// ── 10. `node src/index.js` exits 0 and prints JSON fail-closed status ───────
test('node src/index.js exits 0 and prints a JSON fail-closed status', () => {
  const srcPath = fileURLToPath(new URL('../src/index.js', import.meta.url));
  let stdout;
  assert.doesNotThrow(() => {
    stdout = execFileSync(process.execPath, [srcPath], { encoding: 'utf8' });
  }, 'running the entry must exit 0');

  const status = JSON.parse(stdout);
  assert.equal(status.execute, false);
  assert.equal(status.runtime_available, false);
  assert.equal(status.execution_enabled, false);
  assert.equal(status.fail_closed, true);
  assertControlPlane(status.control_plane);

  // The CLI output must not leak any sample secret/body/token.
  assert.ok(!stdout.includes(SECRET) && !stdout.includes(BODY) && !stdout.includes(TOKEN));
});

// ── 11. iii/config.yaml has no omp-worker registration ───────────────────────
test('iii/config.yaml contains no omp-worker registration', () => {
  const cfgPath = fileURLToPath(new URL('../../../config.yaml', import.meta.url));
  const cfg = readFileSync(cfgPath, 'utf8');
  assert.ok(!cfg.includes('omp-worker'), 'config.yaml must not register omp-worker');
});

// ── 12. review-worker OMP lifecycle route still execute:false + control_plane ─
test('review-worker OMP lifecycle route stays execute:false with control_plane', async () => {
  const { decideRoute } = await import('../../review-worker/src/routing.js');
  const res = decideRoute({ task: 'omp discover profiles and render configs', constraints: {} });
  assert.equal(res.execute, false, 'OMP lifecycle route must not execute');
  assert.ok(res.control_plane && typeof res.control_plane === 'object', 'must carry control_plane contract');
  assert.equal(res.control_plane.monitoring_required, true);
  assert.equal(res.control_plane.runtime_available, false);
});
