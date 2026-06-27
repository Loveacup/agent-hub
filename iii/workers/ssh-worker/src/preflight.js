// Phase 8 Slice 1 — read-only remote readiness preflight (INJECTED runner).
//
// Scope (Slice 1): probe whether a registered host is *ready* to run a runtime,
// using ONLY read-only, allowlisted commands, through an INJECTED `runner`.
// preflight.js imports no fs / subprocess / socket — the runner is the sole
// boundary, and the command allowlist is enforced here before any runner call.
//
// Allowed commands (read-only ONLY):
//   - `true`                  (ssh reachability)
//   - `command -v <runtime>`  (runtime presence)
//   - `<runtime> --version`   (runtime version, reserved)
// Anything else — and any write/mutation command — is refused before the runner
// ever sees it.
//
// Result shape carries an explicit Phase 9 extension point: an `askills_doctor`
// check that is `skipped` until askills integration lands.
//
// Fail-closed: unknown/disabled host, invalid runtime, missing runner, a
// throwing runner, or a timeout all yield a structured { ready:false } result
// and NEVER throw.

const PREFLIGHT_KIND = 'ssh.preflight.report';

const RUNTIME_NAME_RE = /^[A-Za-z0-9-]+$/;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Is `command` one of the allowlisted read-only probes for `runtime`?
function isAllowedCommand(command, runtime) {
  if (command === 'true') return true;
  if (command === `command -v ${runtime}`) return true;
  if (command === `${runtime} --version`) return true;
  return false;
}

// Run one allowlisted probe. Refuses non-allowlisted commands BEFORE calling the
// runner. Wraps the runner so a throw / bad result / timeout becomes a clean
// `fail` status, never an exception.
function safeRun(runner, host, command, runtime) {
  if (!isAllowedCommand(command, runtime)) {
    return { status: 'fail', reason: 'command_not_allowed' };
  }
  let res;
  try {
    res = runner({ host, command });
  } catch {
    return { status: 'fail', reason: 'runner_threw' };
  }
  if (!isPlainObject(res)) {
    return { status: 'fail', reason: 'bad_runner_result' };
  }
  if (res.timedOut === true) {
    return { status: 'fail', reason: 'timeout', timedOut: true };
  }
  return { status: res.ok === true ? 'pass' : 'fail' };
}

function check(name, source, outcome) {
  const c = { name, source, status: outcome.status };
  if (outcome.reason) c.reason = outcome.reason;
  return c;
}

function failClosed(decision_code) {
  return {
    kind: PREFLIGHT_KIND,
    ready: false,
    decision_code,
    checks: [],
    degraded: false,
    warnings: [],
  };
}

// Default in-memory runner for tests. `spec` maps host id ->
//   { reachable?: bool, timeout?: bool, runtimes?: { [name]: bool } }
// It interprets ONLY the allowlisted commands and returns
// { ok, exitCode, stdout, stderr, timedOut } — exactly the runner contract.
export function createMockRunner(spec = {}) {
  return function runner({ host, command }) {
    const cfg = (isPlainObject(host) && isPlainObject(spec[host.id]) && spec[host.id]) || {};
    if (cfg.timeout === true) {
      return { ok: false, exitCode: null, stdout: '', stderr: 'timeout', timedOut: true };
    }
    if (command === 'true') {
      return cfg.reachable === false
        ? { ok: false, exitCode: 255, stdout: '', stderr: 'ssh: connect failed' }
        : { ok: true, exitCode: 0, stdout: '', stderr: '' };
    }
    const presence = /^command -v ([A-Za-z0-9-]+)$/.exec(command);
    if (presence) {
      const name = presence[1];
      const present = isPlainObject(cfg.runtimes) && cfg.runtimes[name] === true;
      return present
        ? { ok: true, exitCode: 0, stdout: `/usr/bin/${name}`, stderr: '' }
        : { ok: false, exitCode: 1, stdout: '', stderr: '' };
    }
    const version = /^([A-Za-z0-9-]+) --version$/.exec(command);
    if (version) {
      const name = version[1];
      const present = isPlainObject(cfg.runtimes) && cfg.runtimes[name] === true;
      return present
        ? { ok: true, exitCode: 0, stdout: `${name} 1.0.0`, stderr: '' }
        : { ok: false, exitCode: 127, stdout: '', stderr: 'not found' };
    }
    // Any non-allowlisted command never reaches here in practice (safeRun
    // refuses first), but fail closed regardless.
    return { ok: false, exitCode: 126, stdout: '', stderr: 'refused' };
  };
}

// Read-only readiness probe for { device_id, runtime } against the injected
// registry, using the injected runner. device_id is matched against host.id.
export function preflight(input, deps) {
  const { device_id, runtime } = isPlainObject(input) ? input : {};
  const { runner, registry } = isPlainObject(deps) ? deps : {};
  const hosts = isPlainObject(registry) && Array.isArray(registry.hosts) ? registry.hosts : [];
  const host = hosts.find((h) => isPlainObject(h) && h.id === device_id);

  if (!host) return failClosed('host_not_found');
  if (host.enabled !== true) return failClosed('host_disabled');

  if (typeof runtime !== 'string' || !RUNTIME_NAME_RE.test(runtime)) {
    return failClosed('invalid_runtime');
  }
  const declared = Array.isArray(host.runtimes) && host.runtimes.some((r) => isPlainObject(r) && r.name === runtime);
  if (!declared) return failClosed('runtime_not_declared');

  if (typeof runner !== 'function') return failClosed('no_runner');

  const checks = [];
  const warnings = [];
  let degraded = false;

  // 1. ssh reachability
  const reach = safeRun(runner, host, 'true', runtime);
  checks.push(check('ssh_reachable', 'ssh-worker', reach));
  if (reach.timedOut) {
    degraded = true;
    warnings.push('ssh_reachable_timeout');
  }

  // 2. runtime presence — only probed if ssh is reachable.
  if (reach.status === 'pass') {
    const present = safeRun(runner, host, `command -v ${runtime}`, runtime);
    checks.push(check('runtime_present', 'ssh-worker', present));
    if (present.timedOut) {
      degraded = true;
      warnings.push('runtime_present_timeout');
    }
  } else {
    checks.push({ name: 'runtime_present', source: 'ssh-worker', status: 'skipped', reason: 'ssh_unreachable' });
  }

  // 3. Phase 9 extension point — askills doctor, skipped until enabled.
  checks.push({ name: 'askills_doctor', source: 'askills', status: 'skipped', reason: 'phase_9_not_enabled' });

  const reachable = checks.find((c) => c.name === 'ssh_reachable');
  const runtimePresent = checks.find((c) => c.name === 'runtime_present');
  const ready = reachable.status === 'pass' && runtimePresent.status === 'pass';

  return {
    kind: PREFLIGHT_KIND,
    ready,
    decision_code: ready ? 'ready' : 'not_ready',
    device_id,
    runtime,
    checks,
    degraded,
    warnings,
  };
}
