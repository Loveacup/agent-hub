// Phase 7 Slice 7 — OMP worker fail-closed runtime entry.
//
// This is the importable worker entry referenced by package.json
// (`dev`/`start`: `node src/index.js`). It exists ONLY to expose static
// metadata + a fail-closed control plane. It deliberately does NOT enable any
// OMP runtime execution.
//
// Fail-closed BY CONSTRUCTION:
//   - imports NO I/O capability (no filesystem, subprocess, or socket modules),
//   - never reads the real ~/.omp / `.env` / `mcp.json`,
//   - never inspects the runtime environment table,
//   - never starts a subprocess and never opens a socket,
//   - never registers an OMP runtime lane in iii/config.yaml,
//   - returns ONLY static, allowlisted metadata — never echoes a raw request
//     body/payload/secret back out,
//   - every function MUST NOT throw on malformed input.
//
// Monitorability contract (mandatory): OMP work is never fire-and-forget. Every
// response carries an explicit control-plane block stating the work must be
// monitored and — while the OMP runtime stays unavailable — is monitorable but
// NOT intervenable. This entry creates NO runtime to satisfy that; it only
// describes the contract as metadata.

const METADATA_KIND = 'omp.worker.metadata';
const CAPABILITIES_KIND = 'omp.worker.capabilities';
const CONTRACT_KIND = 'omp.worker.runtime_contract';
const HEALTH_KIND = 'omp.worker.health';
const UNSUPPORTED_KIND = 'omp.worker.unsupported';
const CONTROL_PLANE_KIND = 'omp.worker.control_plane';
const STATUS_KIND = 'omp.worker.status';

const UNSUPPORTED_DECISION_CODE = 'omp_runtime_execution_unsupported';

// Safe metadata/control-plane capabilities this worker can serve without any
// runtime — these are descriptive/planning helpers, never execution.
const SUPPORTED_CAPABILITIES = [
  'profile_registry_validation',
  'profile_discovery_metadata',
  'render_planning',
  'apply_plan_skeleton',
  'validation_helpers',
  'audit_event_drafts',
  'route_recognition_metadata',
];

// Execution-shaped capabilities that are explicitly NOT supported. The runtime
// entry fails closed against every one of these.
const UNSUPPORTED_CAPABILITIES = [
  'runtime_execution',
  'profile_apply_execution',
  'cross_profile_execution',
  'real_env_read',
  'real_mcp_read',
  'real_omp_smoke',
  'gateway_enablement',
];

// Allowlisted safe control-plane request types. Anything not in this set — in
// particular any execution-shaped or unknown request — fails closed.
const SAFE_REQUEST_TYPES = new Set(['metadata', 'capabilities', 'contract', 'health']);

// Keys that must NEVER be copied out of an inbound request (no raw passthrough).
const FORBIDDEN_REQUEST_KEYS = ['payload', 'body', 'content', 'env', 'token'];

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// The mandatory control-plane contract while the OMP runtime lane is
// unregistered: monitoring/intervention are policy invariants (always required),
// the lane is monitorable as control-plane metadata only, and never intervenable
// until a real runtime exists.
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
    name: 'omp-worker',
    phase: 7,
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
// probe the real OMP runtime or the filesystem.
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
    reason: `OMP runtime execution is unsupported in this worker entry; request "${requested_type}" is failed closed (no runtime, no apply, no real env/mcp/omp access)`,
    alternative: 'use metadata/control-plane request types (metadata|capabilities|contract|health), or route the OMP lifecycle intent through the review gate',
    metadata_only: true,
    redacted: true,
    control_plane: controlPlane(),
  };
}

// Dispatch a control-plane request. Allowlisted safe types return static
// metadata; EVERYTHING else (execution-shaped or unknown) fails closed via
// handleUnsupportedExecution. Every return keeps execute:false.
export function handleControlPlaneRequest(request = {}) {
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

// The static fail-closed status printed when this entry is invoked directly.
export function failClosedStatus() {
  return {
    kind: STATUS_KIND,
    ok: true,
    name: 'omp-worker',
    phase: 7,
    registered: false,
    runtime_available: false,
    execution_enabled: false,
    execute: false,
    fail_closed: true,
    metadata_only: true,
    redacted: true,
    message: 'omp-worker runtime entry is fail-closed: metadata/control-plane only, no OMP runtime execution.',
    control_plane: controlPlane(),
  };
}

// Direct invocation (`node src/index.js`): print the static fail-closed status
// as JSON and exit cleanly. This touches NO real OMP runtime or filesystem.
if (import.meta.main) {
  process.stdout.write(`${JSON.stringify(failClosedStatus(), null, 2)}\n`);
  process.exit(0);
}
