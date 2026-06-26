// Phase 7 Slice 6 — OMP lifecycle audit/event helpers (PURE; metadata-only).
//
// Scope (Slice 6): turn INJECTED lifecycle metadata (registry/discovery/render/
// apply/env/mcp validation summaries) into:
//   - a deterministic, metadata-only audit *plan* (planOmpAudit), and
//   - metadata-only, allowlisted lifecycle *event* drafts (buildOmpLifecycleEvent),
//     sanitized through a strict allowlist (redactOmpEventMetadata).
//
// This module is PURE by construction:
//   - performs NO filesystem access (no fs import, no adapter),
//   - never reads the real ~/.omp / `.env` / `mcp.json`,
//   - never inspects the runtime environment table,
//   - never starts a child process and never opens a socket/network,
//   - emits ONLY allowlisted metadata — env/mcp values, command output, prompt
//     body, session/memory/log/transcript/content NEVER leave this module,
//   - never throws on malformed input — failures are returned as structured
//     { ok, errors, findings } results instead.
//
// Monitorability contract (mandatory): OMP lifecycle work is never fire-and-
// forget. Every plan carries an explicit control-plane block stating that work
// must be monitored and — while the OMP runtime stays unavailable — is NOT
// intervenable. This module creates NO runtime execution to satisfy that; it
// only describes the contract as metadata.

const AUDIT_KIND = 'omp.profile.audit.plan';
const EVENT_TYPE = 'agent.omp.profile.lifecycle';

const LIFECYCLE_ACTIONS = new Set(['discover', 'render', 'validate', 'audit', 'apply-plan']);

// Content fields that must NEVER appear in metadata-only output. Their presence
// on an input is flagged as a finding; their values are never copied out.
const FORBIDDEN_FIELDS = [
  'session',
  'sessions',
  'memory',
  'memories',
  'log',
  'logs',
  'body',
  'content',
  'transcript',
  'env',
  'mcp_env',
  'command_output',
  'output',
  'prompt',
  'prompt_body',
];

// The ONLY metadata keys a lifecycle event may carry. Everything else is dropped.
const STRING_META_KEYS = ['profile', 'lifecycle_action', 'status', 'decision_code'];
const COUNT_META_KEYS = [
  'check_count',
  'finding_count',
  'error_count',
  'warning_count',
  'mcp_server_count',
  'env_key_count',
  'file_action_count',
  'conflict_count',
];

// Control-plane contract while the OMP runtime lane is unavailable in this slice.
function controlPlaneContract() {
  return {
    monitoring_required: true,
    intervention_supported: false,
    runtime_available: false,
    requires_review: true,
  };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function err(code, path, message) {
  return { code, path, message };
}

function check(code, ok, message) {
  return { code, ok: Boolean(ok), message };
}

function finding(severity, code, message) {
  return { severity, code, message };
}

// Sanitize a profile name into a single safe NATS subject token. `.` is a NATS
// token separator, so it is replaced too — the token is a single, stable segment.
function safeProfileToken(profile) {
  if (typeof profile !== 'string' || profile.trim() === '') return 'unknown';
  const token = profile.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^-+|-+$/g, '');
  return token === '' ? 'unknown' : token;
}

// Coerce a count to a non-negative integer; anything else collapses to 0 so a
// smuggled string/object can never ride through a count field.
function toCount(value) {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

// Pure allowlist sanitizer. Drops unknown keys and every forbidden content field
// by only ever copying the allowlisted keys — nothing else can survive.
export function redactOmpEventMetadata(input) {
  const src = isPlainObject(input) ? input : {};
  const meta = {};
  for (const key of STRING_META_KEYS) {
    meta[key] = typeof src[key] === 'string' ? src[key] : null;
  }
  for (const key of COUNT_META_KEYS) {
    meta[key] = toCount(src[key]);
  }
  return meta;
}

// Build a metadata-only, allowlisted lifecycle event. No raw input passthrough:
// the metadata is produced solely by redactOmpEventMetadata.
export function buildOmpLifecycleEvent(input, options = {}) {
  const metadata = redactOmpEventMetadata(input);
  return {
    subject: `agent.omp.profile.${safeProfileToken(metadata.profile)}.lifecycle`,
    type: EVENT_TYPE,
    metadata_only: true,
    redacted: true,
    metadata,
  };
}

// Which forbidden content fields are present on the input (names only — values
// are never read).
function forbiddenFieldsPresent(input) {
  if (!isPlainObject(input)) return [];
  return FORBIDDEN_FIELDS.filter((f) => Object.prototype.hasOwnProperty.call(input, f));
}

function arrayLen(value) {
  return Array.isArray(value) ? value.length : 0;
}

// Count helpers prefer the richer validation summary, then fall back to the
// metadata-only profile summary. Only counts are ever read — never values.
function envKeyCount(env_validation, summary) {
  if (isPlainObject(env_validation) && Array.isArray(env_validation.keys)) return env_validation.keys.length;
  if (isPlainObject(summary) && Number.isFinite(summary.env_key_count)) return toCount(summary.env_key_count);
  return 0;
}

function mcpServerCount(mcp_validation, summary) {
  if (isPlainObject(mcp_validation)) {
    if (Number.isFinite(mcp_validation.server_count)) return toCount(mcp_validation.server_count);
    if (Array.isArray(mcp_validation.servers)) return mcp_validation.servers.length;
  }
  if (isPlainObject(summary) && Number.isFinite(summary.mcp_server_count)) return toCount(summary.mcp_server_count);
  return 0;
}

function fileActionCount(render_plan, apply_result, summary) {
  if (isPlainObject(render_plan) && Array.isArray(render_plan.actions)) return render_plan.actions.length;
  if (isPlainObject(apply_result) && Array.isArray(apply_result.written)) return apply_result.written.length;
  if (isPlainObject(summary) && Number.isFinite(summary.file_action_count)) return toCount(summary.file_action_count);
  return 0;
}

function conflictCount(render_plan, summary) {
  if (isPlainObject(render_plan) && Array.isArray(render_plan.conflicts)) return render_plan.conflicts.length;
  if (isPlainObject(summary) && Number.isFinite(summary.conflict_count)) return toCount(summary.conflict_count);
  return 0;
}

// Produce a deterministic, metadata-only audit plan from injected lifecycle
// summaries. Never throws; malformed input yields a structured error result.
export function planOmpAudit(input, options = {}) {
  const control_plane = controlPlaneContract();

  if (!isPlainObject(input)) {
    const errors = [err('INVALID_AUDIT_INPUT', '', `audit input must be an object, got ${input === null ? 'null' : typeof input}`)];
    const event_drafts = [buildOmpLifecycleEvent({
      profile: null,
      lifecycle_action: null,
      status: 'error',
      decision_code: 'omp_audit_invalid_input',
      check_count: 0,
      finding_count: 0,
      error_count: errors.length,
      warning_count: 0,
    })];
    return {
      kind: AUDIT_KIND,
      ok: false,
      profile: null,
      lifecycle_action: null,
      metadata_only: true,
      redacted: true,
      control_plane,
      checks: [],
      findings: [],
      event_drafts,
      errors,
      warnings: [],
    };
  }

  const profile = isNonEmptyString(input.profile) ? input.profile : null;
  const lifecycle_action = isNonEmptyString(input.lifecycle_action) ? input.lifecycle_action : null;
  const {
    registry_validation,
    env_validation,
    mcp_validation,
    render_plan,
    apply_result,
    summary,
  } = input;

  const checks = [];
  const findings = [];
  const errors = [];
  const warnings = [];

  // ── base checks (informational; do not gate ok) ──
  checks.push(check('profile_present', profile !== null, profile !== null ? `profile ${profile}` : 'profile name missing'));
  if (profile === null) findings.push(finding('warning', 'PROFILE_MISSING', 'audit input has no profile name'));

  const actionValid = LIFECYCLE_ACTIONS.has(lifecycle_action);
  checks.push(check('lifecycle_action_valid', actionValid, actionValid ? `lifecycle_action ${lifecycle_action}` : 'lifecycle_action missing or unknown'));
  if (!actionValid) findings.push(finding('warning', 'INVALID_LIFECYCLE_ACTION', `lifecycle_action must be one of: ${[...LIFECYCLE_ACTIONS].join('|')}`));

  // ── section checks (an error-severity finding gates ok) ──
  if (registry_validation !== undefined) {
    const ok = !(isPlainObject(registry_validation) && registry_validation.ok === false);
    checks.push(check('registry_valid', ok, ok ? 'registry validation passed' : 'registry validation failed'));
    if (!ok) findings.push(finding('error', 'REGISTRY_INVALID', 'injected registry validation reported ok=false'));
  }
  if (env_validation !== undefined) {
    const redacted = isPlainObject(env_validation)
      && env_validation.secret_values_included !== true
      && env_validation.has_secrets !== true;
    checks.push(check('env_redacted', redacted, redacted ? 'env validation is redacted (key names only)' : 'env validation is not redacted'));
    if (!redacted) findings.push(finding('error', 'ENV_NOT_REDACTED', 'injected env validation must be redacted (no secret values)'));
  }
  if (mcp_validation !== undefined) {
    const ok = !(isPlainObject(mcp_validation) && mcp_validation.ok === false);
    checks.push(check('mcp_valid', ok, ok ? 'mcp validation passed' : 'mcp validation failed'));
    if (!ok) findings.push(finding('error', 'MCP_INVALID', 'injected mcp validation reported ok=false'));
  }
  if (render_plan !== undefined) {
    const noExecute = !(isPlainObject(render_plan) && render_plan.execute === true);
    checks.push(check('render_no_execute', noExecute, noExecute ? 'render plan keeps execute=false' : 'render plan asserts execute=true'));
    if (!noExecute) findings.push(finding('error', 'RENDER_WOULD_EXECUTE', 'render plan must keep execute=false'));
  }
  if (apply_result !== undefined) {
    const noExecute = !(isPlainObject(apply_result) && apply_result.execute === true);
    checks.push(check('apply_no_execute', noExecute, noExecute ? 'apply result keeps execute=false' : 'apply result asserts execute=true'));
    if (!noExecute) findings.push(finding('error', 'APPLY_WOULD_EXECUTE', 'apply result must keep execute=false'));
  }
  if (summary !== undefined) {
    const metaOnly = isPlainObject(summary) && summary.metadata_only === true && summary.has_secrets !== true;
    checks.push(check('summary_metadata_only', metaOnly, metaOnly ? 'summary is metadata-only' : 'summary is not metadata-only / may carry secrets'));
    if (!metaOnly) findings.push(finding('error', 'SUMMARY_NOT_METADATA_ONLY', 'injected summary must be metadata-only with has_secrets=false'));
  }

  // ── forbidden content fields on the audit input (names only; never echoed) ──
  for (const f of forbiddenFieldsPresent(input)) {
    findings.push(finding('error', 'FORBIDDEN_FIELD', `audit input must not include content field: ${f}`));
  }

  const errorFindings = findings.filter((f) => f.severity === 'error').length;
  const warningFindings = findings.filter((f) => f.severity === 'warning').length;
  const ok = errors.length === 0 && errorFindings === 0;

  const status = ok ? 'ok' : (errors.length > 0 ? 'error' : 'review_required');
  const decision_code = ok ? 'omp_audit_ok' : 'omp_audit_findings';

  const event_drafts = [buildOmpLifecycleEvent({
    profile,
    lifecycle_action,
    status,
    decision_code,
    check_count: checks.length,
    finding_count: findings.length,
    error_count: errors.length + errorFindings,
    warning_count: warnings.length + warningFindings,
    mcp_server_count: mcpServerCount(mcp_validation, summary),
    env_key_count: envKeyCount(env_validation, summary),
    file_action_count: fileActionCount(render_plan, apply_result, summary),
    conflict_count: conflictCount(render_plan, summary),
  })];

  return {
    kind: AUDIT_KIND,
    ok,
    profile,
    lifecycle_action,
    metadata_only: true,
    redacted: true,
    control_plane,
    checks,
    findings,
    event_drafts,
    errors,
    warnings,
  };
}
