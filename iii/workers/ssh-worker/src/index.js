// Phase 8 Slice 1 — ssh-worker fail-closed runtime entry.
//
// This is the importable worker entry referenced by package.json
// (`dev`/`start`: `node src/index.js`). It exposes static metadata + a
// fail-closed control plane ONLY. It deliberately does NOT enable any remote
// SSH execution.
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
// remote runtime — descriptive/read-only helpers, never execution.
const SUPPORTED_CAPABILITIES = [
  'host_registry_validation',
  'list_hosts',
  'preflight_readonly',
  'subject_sanitization',
];

// Execution-shaped capabilities that are explicitly NOT supported. The runtime
// entry fails closed against every one of these.
const UNSUPPORTED_CAPABILITIES = [
  'acquire_remote',
  'execute_remote',
  'terminate_remote',
  'remote_file_write',
  'remote_codex_exec',
  'nats_publish',
  'askills_call',
];

// Allowlisted safe control-plane request types. Anything not in this set — in
// particular any execution-shaped or unknown request — fails closed.
const SAFE_REQUEST_TYPES = new Set(['metadata', 'capabilities', 'contract', 'health', 'list_hosts']);

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
  const requested_type = safeRequestType(request);
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

// Dispatch a control-plane request. Allowlisted safe types return static
// metadata (and, for list_hosts, a safe registry projection); EVERYTHING else
// (execution-shaped or unknown) fails closed via handleUnsupportedExecution.
// Every return keeps execute:false. `deps` carries caller-injected data
// (e.g. { registry }) — the entry never reads it from disk.
export function handleControlPlaneRequest(request = {}, deps = {}) {
  const type = isPlainObject(request) && typeof request.type === 'string' ? request.type : '';

  if (!SAFE_REQUEST_TYPES.has(type)) {
    return handleUnsupportedExecution(request);
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
      result = handleListHosts(deps);
      break;
    default:
      return handleUnsupportedExecution(request);
  }

  return {
    ok: true,
    kind: CONTROL_PLANE_KIND,
    type,
    execute: false,
    metadata_only: true,
    redacted: true,
    control_plane: controlPlane(),
    result,
  };
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
