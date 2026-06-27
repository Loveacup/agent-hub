// Phase 8 Slice 1 — ssh-worker host registry pure validator + safe lister.
//
// Scope (Slice 1): validate the static host registry + project a SAFE,
// metadata-only host listing. PURE by construction:
//   - imports NO filesystem / subprocess / socket capability,
//   - `readHostRegistry` reads text ONLY through an injected `readText`,
//   - every function is fail-closed: malformed input returns a structured
//     { ok:false, errors } result and NEVER throws,
//   - secret-shaped fields (ssh_key/private_key/token/password/env) are
//     rejected — they must never live in the registry,
//   - the safe listing never emits SSH connection details (host/port/user/alias).

const REGISTRY_KIND = 'ssh.host.registry';
const HOST_LIST_KIND = 'ssh.host.list';

// Host id whitelist — strict, no dots / underscores / spaces.
const ID_RE = /^[A-Za-z0-9-]+$/;
// Runtime name whitelist (same safe token alphabet).
const RUNTIME_NAME_RE = /^[A-Za-z0-9-]+$/;

// Required top-level host fields (Slice 1 contract).
const REQUIRED_HOST_FIELDS = [
  'id',
  'ssh_alias',
  'ssh_host',
  'ssh_port',
  'ssh_user',
  'runtimes',
  'enabled',
];

// Secret-shaped keys that must NEVER appear on a host entry. The registry is
// connection metadata only; credentials live in the operator's ssh-agent /
// ~/.ssh/config, never here.
const FORBIDDEN_SECRET_FIELDS = ['ssh_key', 'private_key', 'token', 'password', 'env'];

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function err(code, path, message) {
  return { code, path, message };
}

function result(errors, registry) {
  return { ok: errors.length === 0, errors, registry: errors.length === 0 ? registry : null };
}

// Validate a single host entry; push structured errors under `hosts[i].`.
function validateHost(host, i, errors) {
  const at = `hosts[${i}]`;
  if (!isPlainObject(host)) {
    errors.push(err('host_not_object', at, 'host entry must be an object'));
    return;
  }

  // Reject secret-shaped fields first — fail closed regardless of other shape.
  for (const secret of FORBIDDEN_SECRET_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(host, secret)) {
      errors.push(err('secret_field', `${at}.${secret}`, `secret-shaped field "${secret}" is forbidden in the host registry`));
    }
  }

  // id: present + whitelist.
  if (typeof host.id !== 'string' || host.id === '') {
    errors.push(err('missing_field', `${at}.id`, 'id is required and must be a non-empty string'));
  } else if (!ID_RE.test(host.id)) {
    errors.push(err('bad_id', `${at}.id`, 'id must match [A-Za-z0-9-]'));
  }

  // Remaining required fields.
  for (const field of REQUIRED_HOST_FIELDS) {
    if (field === 'id') continue;
    if (!Object.prototype.hasOwnProperty.call(host, field)) {
      errors.push(err('missing_field', `${at}.${field}`, `${field} is required`));
    }
  }

  // Type checks for present fields.
  if ('ssh_alias' in host && typeof host.ssh_alias !== 'string') {
    errors.push(err('bad_type', `${at}.ssh_alias`, 'ssh_alias must be a string'));
  }
  if ('ssh_host' in host && typeof host.ssh_host !== 'string') {
    errors.push(err('bad_type', `${at}.ssh_host`, 'ssh_host must be a string'));
  }
  if ('ssh_user' in host && typeof host.ssh_user !== 'string') {
    errors.push(err('bad_type', `${at}.ssh_user`, 'ssh_user must be a string'));
  }
  if ('ssh_port' in host && (typeof host.ssh_port !== 'number' || !Number.isInteger(host.ssh_port) || host.ssh_port < 1 || host.ssh_port > 65535)) {
    errors.push(err('bad_type', `${at}.ssh_port`, 'ssh_port must be an integer in 1..65535'));
  }
  if ('enabled' in host && typeof host.enabled !== 'boolean') {
    errors.push(err('bad_type', `${at}.enabled`, 'enabled must be a boolean'));
  }

  // runtimes: array of { name } with safe names.
  if ('runtimes' in host) {
    if (!Array.isArray(host.runtimes)) {
      errors.push(err('bad_type', `${at}.runtimes`, 'runtimes must be an array'));
    } else {
      host.runtimes.forEach((rt, j) => {
        const rtAt = `${at}.runtimes[${j}]`;
        if (!isPlainObject(rt)) {
          errors.push(err('bad_runtime', rtAt, 'runtime entry must be an object'));
          return;
        }
        if (typeof rt.name !== 'string' || !RUNTIME_NAME_RE.test(rt.name)) {
          errors.push(err('bad_runtime_name', `${rtAt}.name`, 'runtime name must match [A-Za-z0-9-]'));
        }
        // Secret-shaped fields are forbidden inside runtime sub-objects too —
        // credentials must never live anywhere in the registry.
        for (const secret of FORBIDDEN_SECRET_FIELDS) {
          if (Object.prototype.hasOwnProperty.call(rt, secret)) {
            errors.push(err('secret_field', `${rtAt}.${secret}`, `secret-shaped field "${secret}" is forbidden in the host registry`));
          }
        }
      });
    }
  }
}

// Validate + normalize a registry object. Pure; never throws.
export function loadHostRegistryFromObject(input) {
  const errors = [];

  if (!isPlainObject(input)) {
    errors.push(err('not_object', '', 'registry must be an object'));
    return result(errors, null);
  }

  if (typeof input.version !== 'number' || !Number.isInteger(input.version) || input.version < 1) {
    errors.push(err('bad_version', 'version', 'version must be a positive integer'));
  }

  if (!Array.isArray(input.hosts)) {
    errors.push(err('hosts_not_array', 'hosts', 'hosts must be an array'));
    return result(errors, null);
  }

  const seen = new Set();
  input.hosts.forEach((host, i) => {
    validateHost(host, i, errors);
    if (isPlainObject(host) && typeof host.id === 'string' && host.id !== '') {
      if (seen.has(host.id)) {
        errors.push(err('duplicate_id', `hosts[${i}].id`, `duplicate host id "${host.id}"`));
      } else {
        seen.add(host.id);
      }
    }
  });

  if (errors.length > 0) return result(errors, null);

  const registry = {
    kind: REGISTRY_KIND,
    version: input.version,
    hosts: input.hosts.map((h) => ({
      id: h.id,
      label: typeof h.label === 'string' ? h.label : h.id,
      ssh_alias: h.ssh_alias,
      ssh_host: h.ssh_host,
      ssh_port: h.ssh_port,
      ssh_user: h.ssh_user,
      runtimes: h.runtimes.map((r) => ({ name: r.name })),
      askills_device_id: typeof h.askills_device_id === 'string' ? h.askills_device_id : null,
      status_hint: typeof h.status_hint === 'string' ? h.status_hint : 'unknown',
      tags: Array.isArray(h.tags) ? h.tags.filter((t) => typeof t === 'string') : [],
      enabled: h.enabled,
    })),
  };
  return result(errors, registry);
}

// Read a registry through an INJECTED text reader. registry.js imports no fs;
// the caller supplies `readText(path) -> string`. Fail-closed: a throwing
// reader or malformed JSON returns a structured error, never throws.
export function readHostRegistry({ path } = {}, { readText } = {}) {
  if (typeof readText !== 'function') {
    return result([err('no_reader', '', 'an injected readText(path) function is required')], null);
  }
  let text;
  try {
    text = readText(path);
  } catch {
    return result([err('read_failed', String(path ?? ''), 'failed to read registry source')], null);
  }
  if (typeof text !== 'string') {
    return result([err('read_failed', String(path ?? ''), 'reader did not return text')], null);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return result([err('bad_json', String(path ?? ''), 'registry source is not valid JSON')], null);
  }
  return loadHostRegistryFromObject(parsed);
}

// Project the SAFE, metadata-only host listing. Returns ONLY enabled hosts and
// ONLY non-connection metadata: id, label, runtime names, askills_device_id,
// status_hint. SSH connection details (host/port/user/alias) are never emitted.
// Fail-soft: an invalid/missing registry yields an empty list, never throws.
export function listHosts({ registry } = {}) {
  const hosts = isPlainObject(registry) && Array.isArray(registry.hosts) ? registry.hosts : [];
  const listed = hosts
    .filter((h) => isPlainObject(h) && h.enabled === true)
    .map((h) => ({
      id: h.id,
      label: typeof h.label === 'string' ? h.label : h.id,
      runtimes: Array.isArray(h.runtimes)
        ? h.runtimes.map((r) => (isPlainObject(r) ? r.name : null)).filter((n) => typeof n === 'string')
        : [],
      askills_device_id: typeof h.askills_device_id === 'string' ? h.askills_device_id : null,
      status_hint: typeof h.status_hint === 'string' ? h.status_hint : 'unknown',
    }));
  return { kind: HOST_LIST_KIND, hosts: listed };
}
