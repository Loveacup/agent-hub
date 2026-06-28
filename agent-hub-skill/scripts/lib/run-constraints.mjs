// Phase 5 Runtime Orchestrator — run constraints helpers
// Stream Horse (流马) absorption §5 — Task5W2H-inspired constraint model
//
// Purpose: Make task boundaries machine-readable so that watchers, policy
// gates, and archives can reason about a run without parsing natural language.
//
// This module is PURE — no fs, no network, no process.env, no side effects.

// ── Normalize ────────────────────────────────────────────────────────────────

const DEFAULT_FORBIDDEN = [
  'git_push',
  'modify_cc_tmux',
  'rm_rf',
];

/**
 * Normalize user-provided constraints into a stable shape.
 * Fills in safe defaults for missing fields.
 */
export function normalizeConstraints(input = {}) {
  if (typeof input !== 'object' || input === null) return _emptyConstraints();

  const where = _normalizeWhere(input.where);
  const how = _normalizeHow(input.how);
  const howMuch = _normalizeHowMuch(input.how_much);

  return {
    what: typeof input.what === 'string' ? input.what : '',
    why: typeof input.why === 'string' ? input.why : '',
    who: {
      requestor: input?.who?.requestor || 'unknown',
      assignee_lane: input?.who?.assignee_lane || '',
    },
    where,
    how,
    how_much: howMuch,
    acceptance: Array.isArray(input.acceptance)
      ? input.acceptance.filter((a) => typeof a === 'string' && a.trim())
      : [],
  };
}

function _emptyConstraints() {
  return normalizeConstraints({});
}

function _normalizeWhere(where) {
  if (typeof where !== 'object' || where === null) return { repo: '', paths: [] };
  return {
    repo: typeof where.repo === 'string' ? where.repo : '',
    paths: Array.isArray(where.paths)
      ? where.paths.filter((p) => typeof p === 'string' && p.trim())
      : [],
  };
}

function _normalizeHow(how) {
  if (typeof how !== 'object' || how === null) return { allowed_actions: [], forbidden_actions: [...DEFAULT_FORBIDDEN] };
  return {
    allowed_actions: Array.isArray(how.allowed_actions)
      ? how.allowed_actions.filter((a) => typeof a === 'string' && a.trim())
      : [],
    forbidden_actions: Array.isArray(how.forbidden_actions)
      ? how.forbidden_actions.filter((a) => typeof a === 'string' && a.trim())
      : [...DEFAULT_FORBIDDEN],
  };
}

function _normalizeHowMuch(how_much) {
  if (typeof how_much !== 'object' || how_much === null) return _defaultHowMuch();
  return {
    max_ticks: Number.isSafeInteger(how_much.max_ticks) && how_much.max_ticks > 0
      ? how_much.max_ticks
      : _defaultHowMuch().max_ticks,
    interval_ms: Number.isSafeInteger(how_much.interval_ms) && how_much.interval_ms >= 1000
      ? how_much.interval_ms
      : _defaultHowMuch().interval_ms,
    timeout_ms: Number.isSafeInteger(how_much.timeout_ms) && how_much.timeout_ms > 0
      ? how_much.timeout_ms
      : _defaultHowMuch().timeout_ms,
  };
}

function _defaultHowMuch() {
  return { max_ticks: 120, interval_ms: 15000, timeout_ms: 60000 };
}

// ── Validate ─────────────────────────────────────────────────────────────────

/**
 * Validate constraints and return issues.
 * Returns { valid: boolean, issues: Array<{field: string, message: string}> }
 */
export function validateConstraints(constraints) {
  const c = normalizeConstraints(constraints);
  const issues = [];

  // where.repo → if provided, must be absolute
  if (c.where.repo && !c.where.repo.startsWith('/')) {
    issues.push({ field: 'where.repo', message: 'must be an absolute path' });
  }

  // acceptance → at least one entry
  if (c.acceptance.length === 0) {
    issues.push({ field: 'acceptance', message: 'must have at least one acceptance criterion' });
  }

  // forbidden_actions → must include modify_cc_tmux
  if (!c.how.forbidden_actions.includes('modify_cc_tmux')) {
    issues.push({ field: 'how.forbidden_actions', message: 'must include modify_cc_tmux' });
  }

  // interval_ms → minimum 1000
  if (c.how_much.interval_ms < 1000) {
    issues.push({ field: 'how_much.interval_ms', message: 'must be >= 1000' });
  }

  // max_ticks → at least 1
  if (c.how_much.max_ticks < 1) {
    issues.push({ field: 'how_much.max_ticks', message: 'must be >= 1' });
  }

  return { valid: issues.length === 0, issues, constraints: c };
}

// ── Summary ──────────────────────────────────────────────────────────────────

/**
 * Generate a human-readable summary string for Telegram / Hermes.
 */
export function constraintSummary(constraints) {
  const c = normalizeConstraints(constraints);
  const lines = [];

  if (c.what) lines.push(`📋 ${c.what}`);
  if (c.why) lines.push(`🎯 ${c.why}`);

  const whereStr = _whereSummary(c.where);
  if (whereStr) lines.push(`📂 ${whereStr}`);

  const howStr = _howSummary(c.how);
  if (howStr) lines.push(`🔒 ${howStr}`);

  const timeStr = _howMuchSummary(c.how_much);
  if (timeStr) lines.push(`⏱ ${timeStr}`);

  if (c.acceptance.length) {
    lines.push(`✅ ${c.acceptance.map((a) => `"${a}"`).join(', ')}`);
  }

  return lines.length ? lines.join('\n') : '(no constraints)';
}

function _whereSummary(where) {
  const parts = [];
  if (where.repo) parts.push(where.repo);
  if (where.paths.length) parts.push(`[${where.paths.length} paths]`);
  return parts.join(' ');
}

function _howSummary(how) {
  const parts = [];
  if (how.allowed_actions.length) parts.push(`allow=[${how.allowed_actions.join(',')}]`);
  // Only show forbidden if it differs from the hard default
  const hasCustomForbidden = how.forbidden_actions.some((a) => !DEFAULT_FORBIDDEN.includes(a))
    || DEFAULT_FORBIDDEN.some((a) => !how.forbidden_actions.includes(a));
  if (how.forbidden_actions.length && hasCustomForbidden) {
    parts.push(`forbid=[${how.forbidden_actions.join(',')}]`);
  }
  return parts.join(' ');
}

function _howMuchSummary(how_much) {
  const def = _defaultHowMuch();
  const differs = how_much.max_ticks !== def.max_ticks
    || how_much.interval_ms !== def.interval_ms
    || how_much.timeout_ms !== def.timeout_ms;
  return differs
    ? `maxTicks=${how_much.max_ticks} interval=${how_much.interval_ms}ms timeout=${how_much.timeout_ms}ms`
    : '';
}
