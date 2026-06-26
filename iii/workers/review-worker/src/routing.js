// Phase 6 Slice 3 — deterministic routing registry.
// This module only decides; it never executes the selected lane.

export function defaultWorkerCatalog() {
  return {
    cc: {
      available: true,
      capabilities: ['realtime', 'interactive', 'monitor', 'intervene', 'code'],
      reason: 'cc-worker supports realtime session control',
    },
    codex: {
      available: true,
      capabilities: ['code', 'exec', 'stateless'],
      reason: 'codex-worker supports bounded code execution',
    },
    review: {
      available: true,
      capabilities: ['danger_scan', 'verify', 'counter', 'gate'],
      reason: 'review-worker supports gate verdicts',
    },
    omp: {
      available: false,
      capabilities: ['multi_profile', 'fanout'],
      reason: 'omp lane not implemented yet; OMP is deliberately later',
    },
  };
}

export function normalizeConstraints(input = {}) {
  return {
    risk: input.risk ?? 'normal',
    requires_realtime: Boolean(input.requires_realtime),
    requires_review: Boolean(input.requires_review),
    requires_code_execution: Boolean(input.requires_code_execution),
    preferred_lane: input.preferred_lane ?? null,
  };
}

function mergedCatalog(available_workers = {}) {
  const base = defaultWorkerCatalog();
  for (const [lane, override] of Object.entries(available_workers || {})) {
    base[lane] = { ...(base[lane] ?? {}), ...override };
  }
  return base;
}

function decision({ lane, reason, decision_code, requires_review = false, constraints, catalog }) {
  return {
    kind: 'route.decision',
    lane,
    decision_code,
    reason,
    requires_review,
    execute: false,
    constraints,
    available_workers: catalog,
  };
}

function risky(risk) {
  return risk === 'high' || risk === 'danger';
}

export function decideRoute({ task = '', constraints: rawConstraints = {}, available_workers = {} } = {}) {
  const constraints = normalizeConstraints(rawConstraints);
  const catalog = mergedCatalog(available_workers);
  const taskText = String(task).toLowerCase();

  if (constraints.preferred_lane === 'omp') {
    return decision({
      lane: 'review',
      decision_code: 'OMP_NOT_IMPLEMENTED_REVIEW_REQUIRED',
      reason: `omp requested but OMP lane is not implemented yet; route to review gate first (${catalog.omp?.reason ?? 'omp unavailable'})`,
      requires_review: true,
      constraints,
      catalog,
    });
  }

  if (constraints.requires_review || /review|verify|danger|scan|gate|危险|审核|验收/.test(taskText)) {
    return decision({
      lane: 'review',
      decision_code: 'REVIEW_GATE_TASK',
      reason: 'review/gate task should be handled by review-worker; no downstream execution',
      requires_review: false,
      constraints,
      catalog,
    });
  }

  if (constraints.requires_realtime || /monitor|intervene|realtime|watcher|实时|干预|监控/.test(taskText)) {
    if (!catalog.cc?.available) {
      return decision({
        lane: 'review',
        decision_code: 'CC_UNAVAILABLE_REVIEW_REQUIRED',
        reason: `realtime/interactive control requires cc-worker, but cc is unavailable (${catalog.cc?.reason ?? 'unknown'}); route to review`,
        requires_review: true,
        constraints,
        catalog,
      });
    }
    return decision({
      lane: 'cc',
      decision_code: 'CC_REALTIME_CONTROL',
      reason: 'realtime/interactive control requires cc-worker',
      requires_review: risky(constraints.risk),
      constraints,
      catalog,
    });
  }

  if (constraints.requires_code_execution) {
    if (catalog.codex?.available) {
      return decision({
        lane: 'codex',
        decision_code: 'CODEX_CODE_EXECUTION',
        reason: 'low/normal-risk bounded code execution fits codex-worker',
        requires_review: risky(constraints.risk),
        constraints,
        catalog,
      });
    }
    if (catalog.cc?.available) {
      return decision({
        lane: 'cc',
        decision_code: 'CODEX_UNAVAILABLE_CC_FALLBACK',
        reason: `codex unavailable (${catalog.codex?.reason ?? 'unknown'}); fallback to cc-worker`,
        requires_review: risky(constraints.risk),
        constraints,
        catalog,
      });
    }
    return decision({
      lane: 'review',
      decision_code: 'NO_EXECUTION_LANE_AVAILABLE',
      reason: `code execution requested but codex (${catalog.codex?.reason ?? 'unavailable'}) and cc (${catalog.cc?.reason ?? 'unavailable'}) are unavailable; route to review`,
      requires_review: true,
      constraints,
      catalog,
    });
  }

  return decision({
    lane: 'review',
    decision_code: 'DEFAULT_REVIEW',
    reason: 'default safe route: review-worker decision/gate first; no execution',
    requires_review: false,
    constraints,
    catalog,
  });
}
