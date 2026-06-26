// Phase 7 Slice 4 — OMP profile apply engine (skeleton; the single controlled
// fs-write path for render plans).
//
// Scope (Slice 4): take a Slice 3 render *plan* and, only under explicit
// confirmation, write the pending render files through an INJECTED fs adapter.
// This module:
//   - defaults to dry-run and writes NOTHING; a write requires
//     `confirm === true` AND `dryRun === false`,
//   - never invents profile templates — content must come from `action.content`
//     or `options.contentByKind[file_kind]`; otherwise the action is skipped,
//   - re-checks existence through `fsAdapter.exists(target_path)` immediately
//     before each write and refuses to overwrite (writes with `flag: 'wx'`),
//   - never writes a real `.env` secret and never writes `iii/config.yaml`,
//   - enforces a strict write-target boundary: every write must land on
//     ~/.omp/profiles/<valid-name>/agent/<expected-basename>, so a plan can
//     never steer a write outside a named profile's agent directory,
//   - never throws on normal conflicts/skips and captures adapter write
//     failures as structured errors,
//   - performs NO real filesystem access of its own — all I/O goes through the
//     injected adapter so tests use fakes and never touch real ~/.omp / .env.
//
// There is intentionally NO Node fs adapter in this slice: an apply engine that
// could reach the real filesystem by default has no place in a skeleton.

import { validateProfileName } from './validator.js';

const RESULT_KIND = 'omp.profile.apply.result';

// The only render kinds this slice may write. `.env` (real secret) is excluded
// by design; only `.env.example` (env_example) is ever a candidate.
const ALLOWED_KINDS = new Set(['config', 'mcp', 'env_example']);

// The on-disk basename each writable render kind must land on. The profile
// layout is ~/.omp/profiles/<name>/agent/<basename> (see discover.js).
const EXPECTED_BASENAME = {
  config: 'config.yml',
  mcp: 'mcp.json',
  env_example: '.env.example',
};

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function basename(path) {
  const parts = path.split('/');
  return parts[parts.length - 1];
}

// A real `.env` secret — by basename, so `.env.example` is NOT matched.
function isEnvSecretTarget(path) {
  return basename(path) === '.env';
}

// The iii routing config — never a valid render target.
function isConfigYamlTarget(path) {
  return path === 'iii/config.yaml' || path.endsWith('/iii/config.yaml');
}

// Strict write-target boundary: a target is in scope ONLY when it is a profile
// agent render file —
//   ~/.omp/profiles/<valid-profile-name>/agent/<expected-basename>
// — or an absolute path ending in that same `/.omp/profiles/<name>/agent/<base>`
// tail. This is a positive allowlist: anything else (the default profile dir,
// ~/.ssh, ~/Library, `..` traversal, a wrong basename, an invalid profile name)
// is rejected before any exists()/writeFile(), so a malicious plan can never
// steer a write outside a named profile's agent directory.
// Returns { ok: true } or { ok: false, reason }.
function checkTargetInScope(path, fileKind) {
  const expected = EXPECTED_BASENAME[fileKind];
  if (!expected) {
    return { ok: false, reason: `no expected basename for file_kind: ${fileKind ?? '(none)'}` };
  }

  const segments = path.split('/');
  if (segments.some((s) => s === '.' || s === '..')) {
    return { ok: false, reason: 'target_path must not contain `.`/`..` path segments' };
  }
  // The trailing tail must be exactly `.omp/profiles/<name>/agent/<basename>`,
  // and there must be at least one segment before `.omp` so the path is rooted
  // (e.g. `~` or an absolute prefix) rather than a bare relative path.
  if (segments.length < 6) {
    return { ok: false, reason: 'target_path is not a rooted profile agent file' };
  }
  const [omp, profiles, name, agent, base] = segments.slice(-5);
  if (omp !== '.omp' || profiles !== 'profiles' || agent !== 'agent') {
    return { ok: false, reason: 'target_path must be under ~/.omp/profiles/<name>/agent/' };
  }
  if (base !== expected) {
    return { ok: false, reason: `basename must be ${expected} for file_kind ${fileKind}, got ${base}` };
  }
  if (!validateProfileName(name).ok) {
    return { ok: false, reason: `invalid profile name segment: ${name}` };
  }
  return { ok: true };
}

// Resolve content for an action: inline `action.content` wins, else
// `contentByKind[file_kind]`. Returns null when no string content is available —
// Slice 4 never fabricates templates.
function resolveContent(action, contentByKind) {
  if (typeof action.content === 'string') return action.content;
  if (isPlainObject(contentByKind)) {
    const byKind = contentByKind[action.file_kind];
    if (typeof byKind === 'string') return byKind;
  }
  return null;
}

function pushSkip(result, path, fileKind, code, reason) {
  result.skipped.push({
    path: isNonEmptyString(path) ? path : null,
    file_kind: fileKind ?? null,
    action: 'skip',
    code,
    reason,
  });
}

// Apply a render plan. Always returns a structured result; never throws on
// normal skips/conflicts. Writes occur only under explicit confirmation and
// only after a fresh per-candidate existence recheck.
//
//   applyProfilePlan(plan, { fsAdapter, confirm, dryRun, contentByKind })
export async function applyProfilePlan(plan, options = {}) {
  const { fsAdapter, confirm, dryRun, contentByKind } = options;

  const execute = confirm === true && dryRun === false;
  const result = {
    kind: RESULT_KIND,
    profile: isPlainObject(plan) ? plan.profile ?? null : null,
    execute,
    dry_run: dryRun !== false,
    confirmed: confirm === true,
    written: [],
    skipped: [],
    conflicts: [],
    errors: [],
  };

  const actions = isPlainObject(plan) && Array.isArray(plan.actions) ? plan.actions : [];
  const planRequiresReview = isPlainObject(plan) && plan.requires_review === true;

  for (const raw of actions) {
    const action = isPlainObject(raw) ? raw : {};
    const fileKind = action.file_kind;
    const targetPath = action.target_path;

    // ── static safety gates (independent of confirm/dryRun) ──────────────────
    // These refusals hold even in execute mode, so a forbidden target can never
    // be written regardless of confirmation.
    if (action.type !== 'render_file') {
      pushSkip(result, targetPath, fileKind, 'UNSUPPORTED_ACTION', `unsupported action type: ${action.type ?? '(none)'}`);
      continue;
    }
    if (!ALLOWED_KINDS.has(fileKind)) {
      pushSkip(result, targetPath, fileKind, 'UNSUPPORTED_KIND', `unsupported file_kind: ${fileKind ?? '(none)'}`);
      continue;
    }
    if (!isNonEmptyString(targetPath)) {
      pushSkip(result, targetPath, fileKind, 'INVALID_TARGET', 'target_path must be a non-empty string');
      continue;
    }
    if (isEnvSecretTarget(targetPath)) {
      pushSkip(result, targetPath, fileKind, 'ENV_FORBIDDEN', 'refusing to write a real .env secret file');
      continue;
    }
    if (isConfigYamlTarget(targetPath)) {
      pushSkip(result, targetPath, fileKind, 'CONFIG_FORBIDDEN', 'refusing to write iii/config.yaml');
      continue;
    }
    const scope = checkTargetInScope(targetPath, fileKind);
    if (!scope.ok) {
      pushSkip(result, targetPath, fileKind, 'TARGET_OUT_OF_SCOPE', `target outside a profile agent directory: ${scope.reason}`);
      continue;
    }
    if (action.execute === true) {
      pushSkip(result, targetPath, fileKind, 'ACTION_EXECUTABLE', 'action.execute must be false/missing for apply');
      continue;
    }
    if (!(action.requires_review === true || planRequiresReview)) {
      pushSkip(result, targetPath, fileKind, 'REVIEW_NOT_REQUIRED', 'apply requires action or plan requires_review === true');
      continue;
    }
    if (action.overwrite === true) {
      pushSkip(result, targetPath, fileKind, 'OVERWRITE_FORBIDDEN', 'overwrite is never permitted in this slice');
      continue;
    }
    const content = resolveContent(action, contentByKind);
    if (content === null) {
      pushSkip(result, targetPath, fileKind, 'NO_CONTENT', 'no content from action.content or contentByKind; skeleton does not fabricate templates');
      continue;
    }

    // ── confirmation gates ───────────────────────────────────────────────────
    // dry-run is the dominant withholding reason: it writes nothing regardless
    // of confirm, so report DRY_RUN first. The confirm gate only matters once a
    // real write is actually pending (dryRun === false).
    if (dryRun !== false) {
      pushSkip(result, targetPath, fileKind, 'DRY_RUN', 'dry run: planned write withheld (set dryRun:false to apply)');
      continue;
    }
    if (confirm !== true) {
      pushSkip(result, targetPath, fileKind, 'NOT_CONFIRMED', 'confirm:true is required before any write');
      continue;
    }

    // ── execute: fresh existence recheck immediately before the write ────────
    if (!isPlainObject(fsAdapter) || typeof fsAdapter.exists !== 'function' || typeof fsAdapter.writeFile !== 'function') {
      result.errors.push({ path: targetPath, file_kind: fileKind, code: 'NO_FS_ADAPTER', message: 'fsAdapter with exists()/writeFile() is required for writes' });
      continue;
    }

    let exists;
    try {
      exists = await fsAdapter.exists(targetPath);
    } catch (e) {
      result.errors.push({ path: targetPath, file_kind: fileKind, code: 'EXISTS_FAILED', message: String((e && e.message) || e) });
      continue;
    }
    if (exists) {
      result.conflicts.push({ path: targetPath, file_kind: fileKind, action: 'conflict', code: 'TARGET_EXISTS', reason: 'target exists; refusing to overwrite' });
      continue;
    }

    try {
      await fsAdapter.writeFile(targetPath, content, { flag: 'wx' });
      result.written.push({ path: targetPath, file_kind: fileKind, action: 'write', reason: 'rendered profile file written (wx, no overwrite)' });
    } catch (e) {
      result.errors.push({ path: targetPath, file_kind: fileKind, code: 'WRITE_FAILED', message: String((e && e.message) || e) });
    }
  }

  return result;
}
