// Phase 7 Slice 5 — OMP validation helpers (PURE; no filesystem, no secrets out).
//
// Scope (Slice 5): validate INJECTED `.env` data, INJECTED `mcp.json` data, and
// metadata-only profile summaries. This module:
//   - performs NO filesystem access (no fs adapter, no readFile/stat/writeFile),
//   - never reads the real ~/.omp, real `.env`, or real `mcp.json`,
//   - never inspects process.env,
//   - accepts `.env` as an injected string or object ONLY,
//   - accepts `mcp.json` as an injected object or JSON string ONLY,
//   - NEVER emits a raw `.env` value or a raw `mcp` env value — only key names
//     and a redacted `KEY=***` preview leave this module,
//   - emits summaries that are metadata-only: no session/memory/log/body/
//     content/transcript fields ever appear in the output (whitelist by
//     construction).
//
// Like the validator/discover/render/apply modules, every function MUST NOT
// throw on normal malformed input — failures are returned as structured
// { ok, errors, warnings } results instead.

const SUMMARY_KIND = 'omp.profile.summary';

// Content fields that must NEVER appear in a metadata-only summary. Their mere
// presence on an input profile is flagged; their values are never copied out.
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
];

function err(code, path, message) {
  return { code, path, message };
}

function warn(code, path, message) {
  return { code, path, message };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function typeName(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

// ════════════════════════════════ ENV ══════════════════════════════════════

// Parse a `.env`-style string into key names only. Blank and comment (`#`) lines
// are ignored; a `KEY=value` line contributes its KEY only — the value is never
// retained. `export KEY=value` is tolerated. Lines without `=` or with an empty
// key warn (and are skipped) rather than throwing. Values are dropped here, so a
// secret value never travels past this function.
function parseEnvString(input) {
  const keys = [];
  const warnings = [];
  const lines = input.split(/\r?\n/);
  lines.forEach((rawLine, idx) => {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) return;
    const body = line.startsWith('export ') ? line.slice('export '.length).trim() : line;
    const eq = body.indexOf('=');
    if (eq === -1) {
      warnings.push(warn('MALFORMED_LINE', `line[${idx + 1}]`, `line ${idx + 1} is not KEY=value and was ignored`));
      return;
    }
    const key = body.slice(0, eq).trim();
    if (key === '') {
      warnings.push(warn('MALFORMED_LINE', `line[${idx + 1}]`, `line ${idx + 1} has an empty key and was ignored`));
      return;
    }
    keys.push(key);
  });
  return { keys, warnings };
}

// Validate injected `.env` data (string or object). Emits key names + a redacted
// `KEY=***` preview only. Never includes a raw value; `secret_values_included`
// is always false.
export function validateEnvInput(input, options = {}) {
  const errors = [];
  const warnings = [];
  let rawKeys;

  if (typeof input === 'string') {
    const parsed = parseEnvString(input);
    rawKeys = parsed.keys;
    warnings.push(...parsed.warnings);
  } else if (isPlainObject(input)) {
    rawKeys = Object.keys(input);
    for (const k of rawKeys) {
      if (k.trim() === '') {
        warnings.push(warn('MALFORMED_KEY', 'env', 'an empty env key was ignored'));
      }
    }
    rawKeys = rawKeys.filter((k) => k.trim() !== '');
  } else {
    errors.push(err('INVALID_ENV_INPUT', '', `env input must be a string or object, got ${typeName(input)}`));
    return { ok: false, errors, warnings, keys: [], redacted_preview: [], secret_values_included: false };
  }

  // De-duplicate keys; a repeat warns but never re-lists or leaks a value.
  const seen = new Set();
  const keys = [];
  for (const k of rawKeys) {
    if (seen.has(k)) {
      warnings.push(warn('DUPLICATE_KEY', k, `duplicate env key ignored: ${k}`));
      continue;
    }
    seen.add(k);
    keys.push(k);
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    keys,
    redacted_preview: keys.map((k) => `${k}=***`),
    secret_values_included: false,
  };
}

// ════════════════════════════════ MCP ══════════════════════════════════════

// Validate one server entry. Pushes structured errors (never throws) and returns
// a redacted summary `{ name, command, args_count, env_keys }` — env KEY NAMES
// ONLY, never env values.
function validateServerEntry(name, entry, errors) {
  const path = `mcpServers.${name}`;
  if (!isPlainObject(entry)) {
    errors.push(err('INVALID_SERVER_ENTRY', path, `server "${name}" must be an object, got ${typeName(entry)}`));
    return null;
  }

  let command = null;
  if (entry.command !== undefined) {
    if (typeof entry.command !== 'string') {
      errors.push(err('INVALID_COMMAND', `${path}.command`, `command must be a string when present, got ${typeName(entry.command)}`));
    } else {
      command = entry.command;
    }
  }

  let args_count = 0;
  if (entry.args !== undefined) {
    if (!Array.isArray(entry.args)) {
      errors.push(err('INVALID_ARGS', `${path}.args`, `args must be an array when present, got ${typeName(entry.args)}`));
    } else {
      args_count = entry.args.length;
    }
  }

  let env_keys = [];
  if (entry.env !== undefined) {
    if (!isPlainObject(entry.env)) {
      errors.push(err('INVALID_ENV', `${path}.env`, `env must be an object when present, got ${typeName(entry.env)}`));
    } else {
      env_keys = Object.keys(entry.env); // KEY NAMES ONLY — values never copied.
    }
  }

  return { name, command, args_count, env_keys };
}

// Validate injected `mcp.json` data (object or JSON string). Minimal schema: a
// root object carrying an `mcpServers` object. Emits per-server metadata with
// env KEY NAMES ONLY — never env values.
export function validateMcpInput(input, options = {}) {
  const errors = [];
  const warnings = [];
  let root;

  if (typeof input === 'string') {
    try {
      root = JSON.parse(input);
    } catch (e) {
      errors.push(err('INVALID_MCP_JSON', '', `mcp input string is not valid JSON: ${String((e && e.message) || e)}`));
      return { ok: false, errors, warnings, server_count: 0, servers: [] };
    }
  } else if (isPlainObject(input)) {
    root = input;
  } else {
    errors.push(err('INVALID_MCP_INPUT', '', `mcp input must be an object or JSON string, got ${typeName(input)}`));
    return { ok: false, errors, warnings, server_count: 0, servers: [] };
  }

  if (!isPlainObject(root)) {
    errors.push(err('INVALID_MCP_ROOT', '', `mcp root must be an object, got ${typeName(root)}`));
    return { ok: false, errors, warnings, server_count: 0, servers: [] };
  }
  if (!isPlainObject(root.mcpServers)) {
    errors.push(err('INVALID_MCP_SERVERS', 'mcpServers', `mcpServers must be an object, got ${typeName(root.mcpServers)}`));
    return { ok: false, errors, warnings, server_count: 0, servers: [] };
  }

  const servers = [];
  for (const [name, entry] of Object.entries(root.mcpServers)) {
    const summary = validateServerEntry(name, entry, errors);
    if (summary) servers.push(summary);
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    server_count: servers.length,
    servers,
  };
}

// ══════════════════════════════ SUMMARY ════════════════════════════════════

// Which forbidden content fields are present on a candidate profile (names only;
// values are never read).
function forbiddenFieldsPresent(profile) {
  if (!isPlainObject(profile)) return [];
  return FORBIDDEN_FIELDS.filter((f) => Object.prototype.hasOwnProperty.call(profile, f));
}

// Copy permission flags but keep boolean values ONLY, so an injected non-boolean
// (e.g. a secret string smuggled into permissions) can never leak through.
function sanitizePermissions(permissions) {
  if (!isPlainObject(permissions)) return null;
  const out = {};
  for (const [k, v] of Object.entries(permissions)) {
    if (typeof v === 'boolean') out[k] = v;
  }
  return out;
}

// Validate that a profile is metadata-only and well-formed enough to summarize.
// Presence of any content field (session/memory/log/body/content/transcript) is
// a FORBIDDEN_FIELD error. Never throws; returns { ok, errors, warnings } and
// never echoes a field's value.
export function validateProfileMetadata(profile, options = {}) {
  const errors = [];
  const warnings = [];

  if (!isPlainObject(profile)) {
    errors.push(err('INVALID_PROFILE', '', `profile metadata must be an object, got ${typeName(profile)}`));
    return { ok: false, errors, warnings };
  }

  for (const f of forbiddenFieldsPresent(profile)) {
    errors.push(err('FORBIDDEN_FIELD', f, `profile metadata must not include content field: ${f}`));
  }

  if (profile.name !== undefined && typeof profile.name !== 'string') {
    errors.push(err('INVALID_NAME', 'name', `name must be a string when present, got ${typeName(profile.name)}`));
  }
  if (profile.status !== undefined && typeof profile.status !== 'string') {
    warnings.push(warn('INVALID_STATUS', 'status', 'status should be a string when present'));
  }
  if (profile.risk_level !== undefined && typeof profile.risk_level !== 'string') {
    warnings.push(warn('INVALID_RISK_LEVEL', 'risk_level', 'risk_level should be a string when present'));
  }
  if (profile.permissions !== undefined && !isPlainObject(profile.permissions)) {
    warnings.push(warn('INVALID_PERMISSIONS', 'permissions', 'permissions should be an object of booleans when present'));
  }

  return { ok: errors.length === 0, errors, warnings };
}

// Count file actions from a render plan (.actions) or an apply result (.written).
function countActions(planMeta) {
  if (!isPlainObject(planMeta)) return 0;
  if (Array.isArray(planMeta.actions)) return planMeta.actions.length;
  if (Array.isArray(planMeta.written)) return planMeta.written.length;
  return 0;
}

function countArray(planMeta, key) {
  return isPlainObject(planMeta) && Array.isArray(planMeta[key]) ? planMeta[key].length : 0;
}

// Produce a metadata-only, redacted profile summary. The output object is built
// from a strict whitelist of allowed metadata sources:
//   - registry profile entry fields (name/status/risk_level/permissions/subjects/gateway),
//   - render/apply plan metadata (counts only) via options.renderPlan|plan|applyResult,
//   - env validation result KEYS only via options.envValidation,
//   - mcp validation result SERVER COUNT only via options.mcpValidation.
// No session/memory/log/body/content/transcript field and no raw env/mcp value
// can appear, because nothing outside this whitelist is ever copied.
export function summarizeProfileMetadata(profile, options = {}) {
  const { renderPlan, plan, applyResult, envValidation, mcpValidation } = options;
  const validation = validateProfileMetadata(profile);
  const p = isPlainObject(profile) ? profile : {};

  const planMeta = isPlainObject(renderPlan) ? renderPlan
    : isPlainObject(plan) ? plan
    : isPlainObject(applyResult) ? applyResult
    : null;

  const env_key_count = isPlainObject(envValidation) && Array.isArray(envValidation.keys)
    ? envValidation.keys.length
    : 0;

  let mcp_server_count = 0;
  if (isPlainObject(mcpValidation)) {
    if (typeof mcpValidation.server_count === 'number') mcp_server_count = mcpValidation.server_count;
    else if (Array.isArray(mcpValidation.servers)) mcp_server_count = mcpValidation.servers.length;
  }

  const subjects = isPlainObject(p.subjects)
    ? {
        summary: typeof p.subjects.summary === 'string' ? p.subjects.summary : null,
        audit: typeof p.subjects.audit === 'string' ? p.subjects.audit : null,
      }
    : null;

  return {
    kind: SUMMARY_KIND,
    profile: typeof p.name === 'string' ? p.name : null,
    status: typeof p.status === 'string' ? p.status : null,
    risk_level: typeof p.risk_level === 'string' ? p.risk_level : null,
    permissions: sanitizePermissions(p.permissions),
    subjects,
    gateway_mode: isPlainObject(p.gateway) && typeof p.gateway.mode === 'string' ? p.gateway.mode : null,
    file_action_count: countActions(planMeta),
    conflict_count: countArray(planMeta, 'conflicts'),
    warning_count: countArray(planMeta, 'warnings'),
    mcp_server_count,
    env_key_count,
    has_secrets: false,
    metadata_only: true,
    redacted: true,
    errors: validation.errors,
    warnings: validation.warnings,
  };
}
