// Phase 7 Slice 3 — OMP profile render planner (PURE; no filesystem, no apply).
//
// Scope (Slice 3): given a registry profile entry, produce a render *plan*
// describing which skeleton files WOULD be created (config / mcp / .env.example)
// and which targets already exist (conflicts). This module:
//   - performs NO filesystem access (no fs adapter, no stat, no readFile/writeFile),
//   - never registers a runtime lane, never applies a profile, never touches ~/.omp,
//   - never plans the real `.env` (secret) — only `.env.example`,
//   - defaults every plan + action to execute=false / requires_review=true and
//     never overwrites an existing target.
//
// Existence of a target is decided purely from caller-supplied metadata:
//   - options.existingPaths   — Set / Array / Map / plain object of known paths,
//   - options.discoveryProfile — Slice 2 discovery output (paths.<kind>.exists).
//
// Like the validator/discover modules, this function MUST NOT throw on malformed
// input — it returns a plan carrying structured warnings/errors instead.
import { validateProfileEntry } from './validator.js';

const PLAN_KIND = 'omp.profile.render.plan';

// The only paths a render plan may target, in deterministic emission order.
// `agent_dir` is a directory (not rendered as a file) and `env` (real secret)
// is intentionally excluded — Slice 3 never plans a real `.env`.
const PLANNED_FILES = [
  { key: 'config', file_kind: 'config' },
  { key: 'mcp', file_kind: 'mcp' },
  { key: 'env_example', file_kind: 'env_example' },
];

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Normalize the various accepted `existingPaths` shapes into a path→boolean
// predicate. Pure: builds a local lookup and performs no I/O.
function buildExistsLookup(existingPaths) {
  if (existingPaths == null) return () => false;
  if (existingPaths instanceof Set) return (p) => existingPaths.has(p);
  if (existingPaths instanceof Map) return (p) => Boolean(existingPaths.get(p));
  if (Array.isArray(existingPaths)) {
    const set = new Set(existingPaths);
    return (p) => set.has(p);
  }
  if (isPlainObject(existingPaths)) return (p) => Boolean(existingPaths[p]);
  return () => false;
}

// A discovery profile (Slice 2) reports existence per path-kind as
// paths.<kind>.exists === true. Treat anything else (missing kind, exists:false)
// as "not existing".
function discoveryMarksExisting(discoveryProfile, key) {
  const paths = isPlainObject(discoveryProfile) ? discoveryProfile.paths : null;
  if (!isPlainObject(paths)) return false;
  const meta = paths[key];
  return isPlainObject(meta) && meta.exists === true;
}

function renderAction(targetPath, fileKind, profileName) {
  return {
    type: 'render_file',
    target_path: targetPath,
    file_kind: fileKind,
    execute: false,
    requires_review: true,
    overwrite: false,
    redacted: true,
    reason: `planned ${fileKind} render for profile ${profileName ?? '(unknown)'} (review required before apply)`,
  };
}

function targetExists(targetPath, fileKind) {
  return {
    type: 'target_exists',
    target_path: targetPath,
    file_kind: fileKind,
    action: 'conflict',
    overwrite: false,
    reason: 'target exists; render plan will not overwrite',
  };
}

// Produce a pure render plan for a single registry profile entry.
//
//   renderProfilePlan(profileEntry, { discoveryProfile, existingPaths })
//
// Returns a plan object — never throws on malformed input.
export function renderProfilePlan(profileEntry, options = {}) {
  const { discoveryProfile, existingPaths } = options;
  const entry = isPlainObject(profileEntry) ? profileEntry : {};

  // Reuse the Slice 1 validator so render plans surface the same structured
  // errors a registry validation would. Render never blocks on invalidity here;
  // it records the errors and still plans whatever paths it can.
  const validation = validateProfileEntry(profileEntry);

  const profileName = typeof entry.name === 'string' ? entry.name : null;
  const plan = {
    kind: PLAN_KIND,
    profile: profileName,
    execute: false,
    requires_review: true,
    redacted: true,
    actions: [],
    conflicts: [],
    warnings: [],
    errors: validation.errors,
    permissions: entry.permissions ?? null,
    subjects: entry.subjects ?? null,
    gateway: entry.gateway ?? null,
  };

  const paths = isPlainObject(entry.paths) ? entry.paths : {};
  const existsLookup = buildExistsLookup(existingPaths);

  for (const { key, file_kind } of PLANNED_FILES) {
    const target = paths[key];

    // A missing/blank optional path warns — it does not throw and does not block
    // the remaining files from being planned.
    if (typeof target !== 'string' || target.length === 0) {
      plan.warnings.push({
        code: 'MISSING_PATH',
        path: `paths.${key}`,
        message: `paths.${key} is missing; skipped from render plan`,
      });
      continue;
    }

    const exists = existsLookup(target) || discoveryMarksExisting(discoveryProfile, key);
    if (exists) {
      plan.conflicts.push(targetExists(target, file_kind));
    } else {
      plan.actions.push(renderAction(target, file_kind, profileName));
    }
  }

  return plan;
}
