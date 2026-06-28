// Phase 8 Slice 1+2 — ssh-worker fail-closed runtime entry.
//
// This is the importable worker entry referenced by package.json
// (`dev`/`start`: `node src/index.js`). It exposes static metadata + a
// fail-closed control plane ONLY. It deliberately does NOT enable any real
// remote SSH execution.
//
// Slice 2 adds the MOCKED control-plane shapes of the remote-execution lane:
// `acquire_remote` allocates an in-memory session HANDLE (session.js) and
// `execute_remote` ACCEPTS a turn asynchronously (remote.js), calling an
// injected fake publisher. Neither touches a real runtime — both keep
// execute:false (nothing is actually executed; "accepted" is async acceptance
// only) and never echo the request context/model/secrets. The host registry,
// session store and publisher are all CALLER-INJECTED via `deps`.
//
// Fail-closed BY CONSTRUCTION:
//   - imports NO I/O capability (no filesystem, subprocess, or socket modules),
//   - never opens an SSH connection and never starts a subprocess,
//   - never writes a remote file and never runs `codex exec` on a remote,
//   - never publishes a real NATS event,
//   - never calls askills,
//   - never registers ssh-worker in iii/config.yaml,
//   - never reads the runtime environment table (no env access),
//   - returns ONLY static, allowlisted metadata — never echoes a raw request
//     body/payload/secret back out,
//   - every function MUST NOT throw on malformed input.
//
// The only data-bearing control-plane request is `list_hosts`, which projects a
// SAFE host listing from a registry the CALLER injects (`deps.registry`). The
// entry imports the pure `listHosts` projector but never reads a registry file
// itself — with no injected registry, list_hosts returns an empty list.
//
// Monitorability contract (mandatory): remote work is never fire-and-forget.
// Every response carries an explicit control-plane block stating the work must
// be monitored and — while the SSH runtime stays unavailable — is monitorable
// but NOT intervenable.

import { listHosts } from './registry.js';
import { acquireRemote, executeRemote, statusRemote, releaseRemote, terminateRemote } from './remote.js';

const METADATA_KIND = 'ssh.worker.metadata';
const CAPABILITIES_KIND = 'ssh.worker.capabilities';
const CONTRACT_KIND = 'ssh.worker.runtime_contract';
const HEALTH_KIND = 'ssh.worker.health';
const UNSUPPORTED_KIND = 'ssh.worker.unsupported';
const CONTROL_PLANE_KIND = 'ssh.worker.control_plane';
const STATUS_KIND = 'ssh.worker.status';
const HOST_LIST_KIND = 'ssh.worker.host_list';

const UNSUPPORTED_DECISION_CODE = 'ssh_remote_execution_unsupported';

// Safe metadata/control-plane capabilities this worker can serve without any
// real remote runtime. The first four are descriptive/read-only helpers;
// acquire_remote/execute_remote are the MOCKED remote-lane shapes (Slice 2) —
// they allocate/accept against injected collaborators but never execute.
const SUPPORTED_CAPABILITIES = [
  'host_registry_validation',
  'list_hosts',
  'preflight_readonly',
  'subject_sanitization',
  'acquire_remote',
  'execute_remote',
  'status',
  'release_remote',
  'terminate_remote',
];

// Execution-shaped capabilities that are explicitly NOT supported. The runtime
// entry fails closed against every one of these.
const UNSUPPORTED_CAPABILITIES = [
  'remote_file_write',
  'remote_codex_exec',
  'nats_publish',
  'askills_call',
];

// Allowlisted safe control-plane request types. Anything not in this set — in
// particular any execution-shaped or unknown request — fails closed. The mocked
// remote-lane types dispatch to remote.js (see REMOTE_HANDLERS).
const SAFE_REQUEST_TYPES = new Set([
  'metadata',
  'capabilities',
  'contract',
  'health',
  'list_hosts',
  'acquire_remote',
  'execute_remote',
  'status',
  'release_remote',
  'terminate_remote',
]);

// The MOCKED remote-execution lane: request type -> orchestrator (remote.js).
// All dispatch through a single fail-closed wrapper below; none touch a real
// runtime and every result is forced to execute:false.
const REMOTE_HANDLERS = {
  acquire_remote: acquireRemote,
  execute_remote: executeRemote,
  status: statusRemote,
  release_remote: releaseRemote,
  terminate_remote: terminateRemote,
};

// Kind label per remote type, used to shape an injected-collaborator failure
// when an orchestrator's own guards are bypassed (e.g. a throwing deps getter).
const REMOTE_KINDS = {
  acquire_remote: 'ssh.remote.acquire',
  execute_remote: 'ssh.remote.execute',
  status: 'ssh.remote.status',
  release_remote: 'ssh.remote.release',
  terminate_remote: 'ssh.remote.terminate',
};

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// The mandatory control-plane contract while the SSH runtime lane is
// unregistered: monitoring/intervention are policy invariants (always required),
// the lane is monitorable as control-plane metadata only, and never intervenable
// until a real remote runtime exists.
function controlPlane() {
  return {
    monitoring_required: true,
    intervention_required: true,
    monitorable: true,
    intervenable: false,
    runtime_available: false,
    status: 'unavailable',
  };
}

export function getWorkerMetadata() {
  return {
    kind: METADATA_KIND,
    name: 'ssh-worker',
    phase: 8,
    registered: false,
    runtime_available: false,
    execution_enabled: false,
    metadata_only: true,
    redacted: true,
  };
}

export function getCapabilities() {
  return {
    kind: CAPABILITIES_KIND,
    execute: false,
    metadata_only: true,
    supported: [...SUPPORTED_CAPABILITIES],
    unsupported: [...UNSUPPORTED_CAPABILITIES],
  };
}

export function describeRuntimeContract() {
  return {
    kind: CONTRACT_KIND,
    runtime_available: false,
    execution_enabled: false,
    execute: false,
    fail_closed: true,
    metadata_only: true,
    redacted: true,
    control_plane: controlPlane(),
  };
}

// Static-only health: confirms the entry module loads. It deliberately does NOT
// probe a remote host, the network, or the filesystem.
export function healthCheck() {
  return {
    ok: true,
    kind: HEALTH_KIND,
    static_entry_ok: true,
    external_runtime_checked: false,
    runtime_available: false,
    execute: false,
  };
}

// Project the SAFE host listing from a CALLER-injected registry. With no
// registry, returns an empty list and registry_loaded:false. Never reads a file.
function handleListHosts(deps) {
  const registry = isPlainObject(deps) ? deps.registry : null;
  if (!isPlainObject(registry) || !Array.isArray(registry.hosts)) {
    return { kind: HOST_LIST_KIND, registry_loaded: false, hosts: [] };
  }
  const { hosts } = listHosts({ registry });
  return { kind: HOST_LIST_KIND, registry_loaded: true, hosts };
}

// Sanitize an inbound request type to a single safe label for diagnostics. Only
// a bounded set of characters survive; nothing else (and no other request field)
// is ever echoed out.
function safeRequestType(request) {
  const type = isPlainObject(request) && typeof request.type === 'string' ? request.type : '';
  const token = type.toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 64);
  return token === '' ? 'unknown' : token;
}

// Fail-closed response for any execution-shaped or unknown request. No raw
// request body/payload/secret is ever copied out — only a sanitized type label.
export function handleUnsupportedExecution(request = {}) {
  let requested_type = 'unknown';
  try {
    requested_type = safeRequestType(request);
  } catch {
    // A malicious request object with a throwing getter — fail closed silently.
  }
  return {
    ok: false,
    kind: UNSUPPORTED_KIND,
    execute: false,
    decision_code: UNSUPPORTED_DECISION_CODE,
    requested_type,
    reason: `remote SSH execution is unsupported in this worker entry; request "${requested_type}" is failed closed (no ssh connect, no remote write, no remote codex exec, no NATS publish, no askills call)`,
    alternative: 'use metadata/control-plane request types (metadata|capabilities|contract|health|list_hosts), or run a read-only preflight via the preflight helper',
    metadata_only: true,
    redacted: true,
    control_plane: controlPlane(),
  };
}

// Attach the mandatory monitorability contract to a mocked remote-lane result
// and FORCE execute:false. The remote orchestrators own ok/decision_code/shape;
// the entry owns the control-plane invariant. Only the orchestrator's own result
// fields are spread out — never the raw request — so no payload can leak.
function wrapRemote(result, type) {
  const base = isPlainObject(result) ? result : {};
  return { ...base, type, execute: false, control_plane: controlPlane() };
}

// Defense in depth: a malicious injected collaborator (e.g. a registry/host with
// a throwing getter, or a session store whose method throws) must not bubble out
// of the dispatcher. The remote orchestrators already fail closed around the
// session store; this catch covers anything they don't (e.g. a getter that
// throws while the registry is read). No raw request is ever copied out.
function injectedRemoteFail(type) {
  return {
    ok: false,
    kind: REMOTE_KINDS[type] || 'ssh.remote.execute',
    execute: false,
    accepted: false,
    decision_code: 'injected_collaborator_failed',
    metadata_only: true,
    redacted: true,
    published: false,
  };
}

// Dispatch a control-plane request. Allowlisted safe types return static
// metadata (and, for list_hosts, a safe registry projection); the mocked
// remote-lane types (acquire_remote/execute_remote) dispatch to remote.js with
// injected deps; EVERYTHING else (execution-shaped or unknown) fails closed via
// handleUnsupportedExecution. Every return keeps execute:false. `deps` carries
// caller-injected collaborators (e.g. { registry, sessions, publish }) — the
// entry never reads them from disk and never opens SSH/NATS itself.
export function handleControlPlaneRequest(request = {}, deps = {}) {
  try {
    return _handleControlPlaneRequest(request, deps);
  } catch {
    // Defense in depth: any throwing injected collaborator (malicious getter on
    // request, deps, registry, etc.) must not bubble out of the worker entry.
    return handleUnsupportedExecution(request);
  }
}

function _handleControlPlaneRequest(request, deps) {
  const type = isPlainObject(request) && typeof request.type === 'string' ? request.type : '';

  if (!SAFE_REQUEST_TYPES.has(type)) {
    return handleUnsupportedExecution(request);
  }

  // Mocked remote-execution lane — no real SSH/NATS, execute:false enforced.
  // Dispatch is wrapped fail-closed: a throwing injected collaborator yields a
  // structured 'injected_collaborator_failed' result, never an exception.
  const remoteHandler = REMOTE_HANDLERS[type];
  if (remoteHandler) {
    let result;
    try {
      result = remoteHandler(request, deps);
    } catch {
      result = injectedRemoteFail(type);
    }
    return wrapRemote(result, type);
  }

  let result;
  switch (type) {
    case 'metadata':
      result = getWorkerMetadata();
      break;
    case 'capabilities':
      result = getCapabilities();
      break;
    case 'contract':
      result = describeRuntimeContract();
      break;
    case 'health':
      result = healthCheck();
      break;
    case 'list_hosts':
      try {
        result = handleListHosts(deps);
      } catch {
        return handleUnsupportedExecution(request);
      }
      break;
    default:
      return handleUnsupportedExecution(request);
  }
  return { ok: true, kind: CONTROL_PLANE_KIND, type, execute: false, result, control_plane: controlPlane() };
}

// Plan alias — the slice contract refers to this dispatcher as handleRequest.
export const handleRequest = handleControlPlaneRequest;

// The static fail-closed status printed when this entry is invoked directly.
export function failClosedStatus() {
  return {
    kind: STATUS_KIND,
    ok: true,
    name: 'ssh-worker',
    phase: 8,
    registered: false,
    runtime_available: false,
    execution_enabled: false,
    execute: false,
    fail_closed: true,
    metadata_only: true,
    redacted: true,
    message: 'ssh-worker runtime entry is fail-closed: metadata/control-plane only, no remote SSH execution.',
    control_plane: controlPlane(),
  };
}

// Direct invocation (`node src/index.js`): print the static fail-closed status
// as JSON and exit cleanly. This touches NO remote host, network, or filesystem.
if (import.meta.main) {
  process.stdout.write(`${JSON.stringify(failClosedStatus(), null, 2)}\n`);
  process.exit(0);
}
