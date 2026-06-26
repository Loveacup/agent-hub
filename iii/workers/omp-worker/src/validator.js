// Phase 7 Slice 1 — OMP profile registry pure validator.
//
// Scope (Slice 1): validate the static registry + profile entries ONLY.
// No filesystem reads, no ~/.omp access, no NATS, no routing, no discovery.
// All functions are pure and MUST NOT throw on malformed input — normal
// validation failures are returned as structured { ok, errors } results.

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

const STATUSES = new Set([
  'planned',
  'rendered',
  'configured',
  'validated',
  'enabled',
  'retired',
]);

const RISK_LEVELS = new Set([
  'read_only',
  'writes_local',
  'external_messages',
  'dangerous',
]);

// Permissions a `read_only` profile must never enable.
const READONLY_FORBIDDEN = [
  'write_files',
  'run_shell',
  'send_external_messages',
  'external_network',
];

const REGISTRY_KIND = 'omp.profile.registry';

// Windows reserved device names (case-insensitive): con/prn/aux/nul/com1..com9/lpt1..lpt9.
const WINDOWS_DEVICES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

function err(code, path, message) {
  return { code, path, message };
}

function result(errors) {
  return { ok: errors.length === 0, errors };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Re-path a child result's errors under a parent prefix (e.g. `profiles[0].`).
function prefixErrors(errors, prefix) {
  return errors.map((e) => ({ ...e, path: `${prefix}${e.path}` }));
}

export function validateProfileName(name) {
  if (typeof name !== 'string') {
    return result([err('INVALID_NAME', 'name', `name must be a string, got ${name === null ? 'null' : typeof name}`)]);
  }

  const errors = [];

  if (name.length === 0) {
    errors.push(err('INVALID_NAME', 'name', 'name must not be empty'));
  }
  if (name.toLowerCase() === 'default') {
    errors.push(err('RESERVED_NAME', 'name', '`default` is reserved and cannot be a named profile'));
  }
  if (name === '.' || name === '..') {
    errors.push(err('INVALID_NAME', 'name', '`.` and `..` are not valid profile names'));
  }
  if (name.endsWith('.')) {
    errors.push(err('INVALID_NAME', 'name', 'name must not end with `.`'));
  }
  if (WINDOWS_DEVICES.has(name.toLowerCase())) {
    errors.push(err('RESERVED_NAME', 'name', `Windows reserved device name is not allowed: ${name}`));
  }
  if (!NAME_RE.test(name)) {
    errors.push(err('INVALID_NAME', 'name', 'name must match ^[a-z0-9][a-z0-9._-]{0,63}$ (lowercase, no spaces/slashes)'));
  }

  return result(errors);
}

export function validateProfileEntry(entry) {
  if (!isPlainObject(entry)) {
    return result([err('INVALID_ENTRY', '', 'profile entry must be an object')]);
  }

  const errors = [];

  // name
  const nameRes = validateProfileName(entry.name);
  if (!nameRes.ok) errors.push(...nameRes.errors);
  const name = typeof entry.name === 'string' ? entry.name : '';

  // status
  if (!STATUSES.has(entry.status)) {
    errors.push(err('INVALID_STATUS', 'status', `status must be one of: ${[...STATUSES].join('|')}`));
  }

  // risk_level
  if (!RISK_LEVELS.has(entry.risk_level)) {
    errors.push(err('INVALID_RISK_LEVEL', 'risk_level', `risk_level must be one of: ${[...RISK_LEVELS].join('|')}`));
  }

  // permissions — every value must be a boolean
  if (!isPlainObject(entry.permissions)) {
    errors.push(err('INVALID_PERMISSIONS', 'permissions', 'permissions must be an object of booleans'));
  } else {
    for (const [key, value] of Object.entries(entry.permissions)) {
      if (typeof value !== 'boolean') {
        errors.push(err('INVALID_PERMISSION', `permissions.${key}`, `permission ${key} must be a boolean`));
      }
    }
    // read_only profiles must not enable write/exec/network/external permissions
    if (entry.risk_level === 'read_only') {
      for (const key of READONLY_FORBIDDEN) {
        if (entry.permissions[key] === true) {
          errors.push(err('READONLY_VIOLATION', `permissions.${key}`, `read_only profile must not enable ${key}`));
        }
      }
    }
  }

  // subjects — must be the canonical per-profile audit/summary subjects
  if (!isPlainObject(entry.subjects)) {
    errors.push(err('INVALID_SUBJECTS', 'subjects', 'subjects must be an object'));
  } else {
    const expectSummary = `agent.omp.profile.${name}.summary`;
    const expectAudit = `agent.omp.profile.${name}.audit`;
    if (entry.subjects.summary !== expectSummary) {
      errors.push(err('INVALID_SUBJECT', 'subjects.summary', `summary subject must be ${expectSummary}`));
    }
    if (entry.subjects.audit !== expectAudit) {
      errors.push(err('INVALID_SUBJECT', 'subjects.audit', `audit subject must be ${expectAudit}`));
    }
  }

  // paths — named profile paths must stay under ~/.omp/profiles/<name>/agent
  if (!isPlainObject(entry.paths)) {
    errors.push(err('INVALID_PATHS', 'paths', 'paths must be an object'));
  } else {
    const base = `~/.omp/profiles/${name}/agent`;
    const checkPath = (key, expectExact) => {
      const value = entry.paths[key];
      if (typeof value !== 'string') {
        errors.push(err('INVALID_PATH', `paths.${key}`, `paths.${key} must be a string`));
        return;
      }
      if (value.split('/').includes('..')) {
        errors.push(err('INVALID_PATH', `paths.${key}`, `paths.${key} must not contain ".." segments`));
        return;
      }
      const inside = expectExact ? value === base : value === base || value.startsWith(`${base}/`);
      if (!inside) {
        errors.push(err('INVALID_PATH', `paths.${key}`, `paths.${key} must stay under ${base}`));
      }
    };
    checkPath('agent_dir', true);
    checkPath('config', false);
    checkPath('mcp', false);
    checkPath('env_example', false);
  }

  return result(errors);
}

export function validateRegistry(registry) {
  if (!isPlainObject(registry)) {
    return result([err('INVALID_REGISTRY', '', 'registry must be an object')]);
  }

  const errors = [];

  if (registry.kind !== REGISTRY_KIND) {
    errors.push(err('INVALID_REGISTRY', 'kind', `kind must be "${REGISTRY_KIND}"`));
  }
  if (typeof registry.version !== 'number') {
    errors.push(err('INVALID_REGISTRY', 'version', 'version must be a number'));
  }

  if (!Array.isArray(registry.profiles)) {
    errors.push(err('INVALID_REGISTRY', 'profiles', 'profiles must be an array'));
    return result(errors);
  }

  const seen = new Set();
  registry.profiles.forEach((entry, i) => {
    const prefix = `profiles[${i}].`;
    const entryRes = validateProfileEntry(entry);
    if (!entryRes.ok) errors.push(...prefixErrors(entryRes.errors, prefix));

    if (isPlainObject(entry) && typeof entry.name === 'string') {
      if (seen.has(entry.name)) {
        errors.push(err('DUPLICATE_NAME', `${prefix}name`, `duplicate profile name: ${entry.name}`));
      }
      seen.add(entry.name);
    }
  });

  return result(errors);
}
