// Phase 7 Slice 9A — shared OMP typed lifecycle envelope CONTRACT (PURE; metadata-only).
//
// Scope (Slice 9A): this module is the single, shared source of truth for the
// TYPED, metadata-only OMP lifecycle envelope contract. It was extracted from
// omp-worker/src/envelope.js so that BOTH omp-worker and review-worker can import
// the validator without a cross-worker relative path. omp-worker/src/envelope.js
// now re-exports from here, so its public surface is unchanged.
//
// This module is PURE by construction:
//   - performs NO filesystem access (no fs import, no adapter),
//   - never reads the real ~/.omp / `.env` / `mcp.json`,
//   - never inspects the runtime environment table,
//   - never starts a child process and never opens a socket/network,
//   - NEVER enables an OMP runtime: every accepted envelope is planning metadata
//     only and asserts execute=false (apply-plan is plan metadata, not apply),
//   - NEVER echoes a raw body/payload/secret/session/log/transcript value — a
//     forbidden field is rejected by NAME and its value is never copied out,
//   - never throws on malformed input — failures are structured results.
//
// It has NO imports at all: keeping it dependency-free guarantees both that it
// stays pure and that importing it adds no runtime capability to any worker.

export const ENVELOPE_KIND = 'omp.lifecycle.envelope';
export const TASK_TYPE = 'omp.lifecycle';

// Envelope-level lifecycle actions — metadata planning verbs ONLY. `apply-plan`
// is allowed only as non-executing plan metadata; it never implies apply exec.
export const ENVELOPE_ACTIONS = new Set([
  'discover',
  'render-plan',
  'validate-metadata',
  'audit-metadata',
  'apply-plan',
]);

// Map an envelope action to the audit-layer lifecycle_action token (Slice 6).
export const ACTION_TO_LIFECYCLE = {
  'discover': 'discover',
  'render-plan': 'render',
  'validate-metadata': 'validate',
  'audit-metadata': 'audit',
  'apply-plan': 'apply-plan',
};

// Content/secret fields that must NEVER survive into envelope output. Presence
// anywhere in the envelope (top-level / task / constraints) is a hard reject;
// values are never read or copied.
export const FORBIDDEN_FIELDS = [
  'payload', 'body', 'content', 'output', 'command_output',
  'env', 'mcp_env', 'secret', 'secrets', 'credential', 'credentials',
  'token', 'tokens', 'session', 'sessions', 'memory', 'memories',
  'log', 'logs', 'transcript', 'transcripts', 'prompt', 'prompt_body',
];

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function err(code, path, message) {
  return { code, path, message };
}

// Sanitize a profile name into a single safe token (no raw passthrough). `.` is
// also stripped so the token is one stable NATS-safe segment; null when unusable.
export function safeProfileToken(profile) {
  if (typeof profile !== 'string' || profile.trim() === '') return null;
  const token = profile.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^-+|-+$/g, '');
  return token === '' ? null : token;
}

// Sanitize an optional run_id into a safe token; null when absent/unusable.
export function safeRunId(run_id) {
  if (typeof run_id !== 'string' || run_id.trim() === '') return null;
  const token = run_id.toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 64);
  return token === '' ? null : token;
}

// Which forbidden fields are present on a candidate object (names only — values
// are never read), reported under a path prefix.
export function forbiddenFieldsPresent(obj, prefix) {
  if (!isPlainObject(obj)) return [];
  return FORBIDDEN_FIELDS
    .filter((f) => Object.prototype.hasOwnProperty.call(obj, f))
    .map((f) => `${prefix}${f}`);
}

export function invalid({ decision_code, reason, errors, warnings = [], sanitized = null }) {
  return {
    ok: false,
    kind: ENVELOPE_KIND,
    decision_code,
    reason,
    errors,
    warnings,
    sanitized,
  };
}

// Validate a typed OMP lifecycle envelope. Documented input shape:
//   { task: { type: 'omp.lifecycle', action, profile? }, constraints: { execute:false, live:false, cross_profile:false }, run_id? }
// Returns { ok:true, kind, envelope, warnings } or a structured reject result.
export function validateOmpLifecycleEnvelope(input) {
  const warnings = [];

  if (!isPlainObject(input)) {
    return invalid({
      decision_code: 'omp_lifecycle_envelope_invalid',
      reason: `envelope must be an object, got ${input === null ? 'null' : typeof input}`,
      errors: [err('INVALID_ENVELOPE', '', 'envelope must be an object')],
    });
  }

  // ── forbidden content fields (highest priority; names only, never values) ──
  const forbidden = [
    ...forbiddenFieldsPresent(input, ''),
    ...forbiddenFieldsPresent(input.task, 'task.'),
    ...forbiddenFieldsPresent(input.constraints, 'constraints.'),
  ];
  if (forbidden.length > 0) {
    return invalid({
      decision_code: 'omp_lifecycle_envelope_forbidden_field',
      reason: `envelope must not include content/secret fields: ${forbidden.join(', ')}`,
      errors: forbidden.map((p) => err('FORBIDDEN_FIELD', p, `forbidden content field is not allowed: ${p}`)),
    });
  }

  // ── task object ──
  const task = input.task;
  if (!isPlainObject(task)) {
    return invalid({
      decision_code: 'omp_lifecycle_envelope_invalid',
      reason: 'envelope.task must be an object',
      errors: [err('INVALID_ENVELOPE', 'task', 'task must be an object')],
    });
  }

  // ── task.type ──
  if (task.type !== TASK_TYPE) {
    return invalid({
      decision_code: 'omp_lifecycle_envelope_type_mismatch',
      reason: `task.type must be "${TASK_TYPE}"`,
      errors: [err('INVALID_TYPE', 'task.type', `task.type must be "${TASK_TYPE}"`)],
    });
  }

  // ── task.action ──
  // NEVER echo the raw action value: a hostile typed envelope can stuff a
  // body/secret/transcript-shaped string into task.action, and this error rides
  // out through review-worker's envelope_errors. Describe the action only by
  // kind ('missing' / its typeof) plus the allowed list — never its content.
  if (!ENVELOPE_ACTIONS.has(task.action)) {
    const actionKind = task.action === undefined ? 'missing' : typeof task.action;
    return invalid({
      decision_code: 'omp_lifecycle_envelope_unknown_action',
      reason: `task.action must be one of: ${[...ENVELOPE_ACTIONS].join('|')}`,
      errors: [err('UNKNOWN_ACTION', 'task.action', `unsupported action (kind: ${actionKind}); allowed: ${[...ENVELOPE_ACTIONS].join('|')}`)],
    });
  }

  // ── constraints: execute/live/cross_profile must each be EXACTLY false ──
  const constraints = isPlainObject(input.constraints) ? input.constraints : {};
  if (constraints.execute !== false) {
    return invalid({
      decision_code: 'omp_lifecycle_envelope_execute_forbidden',
      reason: 'constraints.execute must be exactly false (this envelope is metadata-only, non-executing)',
      errors: [err('EXECUTE_FORBIDDEN', 'constraints.execute', 'constraints.execute must be false')],
    });
  }
  if (constraints.live !== false) {
    return invalid({
      decision_code: 'omp_lifecycle_envelope_live_forbidden',
      reason: 'constraints.live must be exactly false (no live OMP/NATS access)',
      errors: [err('LIVE_FORBIDDEN', 'constraints.live', 'constraints.live must be false')],
    });
  }
  if (constraints.cross_profile !== false) {
    return invalid({
      decision_code: 'omp_lifecycle_envelope_cross_profile_forbidden',
      reason: 'constraints.cross_profile must be exactly false (no cross-profile execution)',
      errors: [err('CROSS_PROFILE_FORBIDDEN', 'constraints.cross_profile', 'constraints.cross_profile must be false')],
    });
  }

  // ── profile (optional, sanitized; raw untrusted content is never echoed) ──
  let profile = null;
  if (task.profile !== undefined) {
    profile = safeProfileToken(task.profile);
    if (profile === null) {
      warnings.push('task.profile was omitted: not a usable safe token after sanitization');
    }
  }

  // ── run_id (optional, sanitized) ──
  let run_id = null;
  if (input.run_id !== undefined) {
    run_id = safeRunId(input.run_id);
    if (run_id === null) {
      warnings.push('run_id was omitted: not a usable safe token after sanitization');
    }
  }

  const envelope = {
    type: TASK_TYPE,
    action: task.action,
    lifecycle_action: ACTION_TO_LIFECYCLE[task.action],
    profile,
    constraints: { execute: false, live: false, cross_profile: false },
    run_id,
    metadata_only: true,
    redacted: true,
  };

  return { ok: true, kind: ENVELOPE_KIND, envelope, warnings };
}
