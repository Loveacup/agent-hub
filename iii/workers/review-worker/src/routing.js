// Phase 6 Slice 3 — deterministic routing registry.
// This module only decides; it never executes the selected lane.

// Phase 7 Slice 9A: the typed OMP lifecycle envelope validator is the single
// source of truth for envelope shape/safety. It now lives in the SHARED contract
// module so review-worker no longer reaches across into omp-worker's source. It
// is PURE (no fs/process.env/subprocess/network) and metadata-only, so importing
// it here adds no runtime capability — recognition stays execute=false and never
// enables an OMP lane.
import { validateOmpLifecycleEnvelope } from '../../shared/omp-contract.js';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function defaultWorkerCatalog() {
  return {
    cc: {
      available: true,
      capabilities: ['realtime', 'interactive', 'monitor', 'intervene', 'code'],
      reason: 'cc-worker supports realtime session control',
    },
    codex: {
      // codex-worker is CLI-backed but the agent-hub control plane can still
      // monitor/interrupt/cancel/status its runs, so it is treated as
      // monitorable + intervenable. This advertises control-plane capability
      // only; it does NOT add any new runtime execution behavior.
      available: true,
      capabilities: ['code', 'exec', 'stateless', 'monitor', 'intervene'],
      reason: 'codex-worker supports bounded code execution under control-plane monitor/intervene',
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

// ── Uniform control-plane contract ──────────────────────────────────────────
// Every route decision carries a `control_plane` object so NO agent — including
// CLI-backed lanes — is ever treated as fire-and-forget. monitoring_required /
// intervention_required are policy invariants (always true); monitorable /
// intervenable / runtime_available describe what the named lane can actually do
// right now. This is metadata only — it never enables a runtime.
function controlPlaneForLane(lane, catalog) {
  const entry = catalog?.[lane] ?? {};
  const caps = entry.capabilities ?? [];
  const available = entry.available === true;
  const hasMonitor = caps.includes('monitor');
  const hasIntervene = caps.includes('intervene');
  const base = { monitoring_required: true, intervention_required: true };

  switch (lane) {
    case 'cc':
    case 'codex': {
      const monitorable = available && hasMonitor;
      const intervenable = available && hasIntervene;
      return {
        ...base,
        monitorable,
        intervenable,
        runtime_available: available,
        status: monitorable && intervenable ? 'available' : 'unavailable',
      };
    }
    case 'review':
      // The review/gate lane is always observable but can only gate/deny — it
      // cannot steer a running agent, so intervention is review-only.
      return { ...base, monitorable: true, intervenable: false, runtime_available: available, status: 'review_only' };
    case 'omp':
      // OMP runtime stays unregistered: monitorable as control-plane metadata
      // only, never intervenable until a runtime exists.
      return { ...base, monitorable: true, intervenable: available, runtime_available: available, status: available ? 'available' : 'unavailable' };
    default:
      return { ...base, monitorable: false, intervenable: false, runtime_available: available, status: 'unsupported' };
  }
}

function decision({ lane, reason, decision_code, requires_review = false, constraints, catalog, run_id = null, control_lane = null }) {
  return {
    kind: 'route.decision',
    lane,
    decision_code,
    reason,
    requires_review,
    execute: false,
    run_id,
    constraints,
    available_workers: catalog,
    // control_lane lets OMP decisions (routed to the review lane) report the OMP
    // runtime's control-plane status rather than the review fallback's.
    control_plane: controlPlaneForLane(control_lane ?? lane, catalog),
  };
}

function risky(risk) {
  return risk === 'high' || risk === 'danger';
}

// ── OMP lifecycle recognition (Phase 7 Slice 6) ──────────────────────────────
// The review-worker recognizes OMP profile lifecycle intents but NEVER enables
// an OMP runtime lane: every OMP route stays execute=false and falls back to the
// review/control plane. Unsafe asks are explicitly denied rather than ignored.
// Each OMP decision also carries the mandatory monitorability/intervention
// contract so the work is never treated as fire-and-forget or untracked.
const OMP_LIFECYCLE_VERB_RE = /\b(discover|render|validate|audit|apply-plan)\b/;

function isOmpContext(taskText, raw) {
  return (
    /\bomp\b/.test(taskText) ||
    raw.task_kind === 'omp_profile_lifecycle' ||
    raw.capability === 'omp.profile.lifecycle' ||
    raw.preferred_lane === 'omp'
  );
}

// Attach the control-plane contract to an OMP decision. `intervention_supported`
// is explicitly false while the OMP runtime lane is unavailable — never omitted
// in a way that could read as untracked execution.
function withControlPlane(decision, runtimeAvailable) {
  return {
    ...decision,
    monitoring_required: true,
    intervention_supported: runtimeAvailable === true,
    runtime_available: runtimeAvailable === true,
  };
}

function detectOmpUnsafe(taskText) {
  if (/cross[\s-]?profile|across .*profiles?|other profiles?|另一?个?.*profile/.test(taskText)) {
    return { decision_code: 'omp_cross_profile_execution_denied', reason: 'cross-profile OMP execution is denied; route to review (execute=false)' };
  }
  if (/\b(enable|register|activate|turn on|启用|注册)\b/.test(taskText) && /gateway|runtime|lane|worker|omp/.test(taskText)) {
    return { decision_code: 'omp_runtime_disabled', reason: 'enabling/registering an OMP runtime lane or gateway is denied; OMP runtime stays disabled (execute=false)' };
  }
  if (/\.env|secret|credential|token|密钥|\bsession|\btranscript|\bmemor(y|ies)|\blogs?\b|读取/.test(taskText)) {
    return { decision_code: 'omp_secret_access_denied', reason: 'reading OMP secrets/sessions/logs/memory is denied; route to review (execute=false)' };
  }
  return null;
}

function isOmpLifecycleIntent(taskText, raw) {
  return (
    raw.task_kind === 'omp_profile_lifecycle' ||
    raw.capability === 'omp.profile.lifecycle' ||
    OMP_LIFECYCLE_VERB_RE.test(taskText)
  );
}

function decideOmpRoute({ taskText, rawConstraints, constraints, catalog }) {
  if (!isOmpContext(taskText, rawConstraints)) return null;
  const runtimeAvailable = catalog.omp?.available === true;

  const unsafe = detectOmpUnsafe(taskText);
  if (unsafe) {
    return withControlPlane(decision({
      lane: 'review',
      decision_code: unsafe.decision_code,
      reason: unsafe.reason,
      requires_review: true,
      constraints,
      catalog,
      control_lane: 'omp',
    }), runtimeAvailable);
  }

  if (isOmpLifecycleIntent(taskText, rawConstraints)) {
    return withControlPlane(decision({
      lane: 'review',
      decision_code: runtimeAvailable ? 'omp_lifecycle_review_required' : 'omp_runtime_unavailable',
      reason: runtimeAvailable
        ? 'OMP profile lifecycle intent recognized; route to review gate before any OMP action (execute=false, monitored)'
        : `OMP profile lifecycle intent recognized but OMP runtime lane is unavailable (${catalog.omp?.reason ?? 'omp lane disabled'}); route to review (execute=false, monitored, not intervenable)`,
      requires_review: true,
      constraints,
      catalog,
      control_lane: 'omp',
    }), runtimeAvailable);
  }

  return null;
}

// ── Typed OMP lifecycle envelope recognition (Phase 7 Slice 8) ───────────────
// A typed envelope is an object `task` of the documented shape
//   { task: { type: 'omp.lifecycle', action, profile? }, constraints, run_id? }.
// It is recognized BEFORE legacy regex text detection but, like every OMP route,
// NEVER enables an OMP runtime: success and rejection both stay execute=false,
// fall back to the review/control plane, and carry the monitorability contract.
// Only the validator's SANITIZED envelope / error codes are attached as evidence
// — no raw forbidden field (body/payload/secret/session/log/transcript) survives.
function isTypedOmpEnvelope(task) {
  return isPlainObject(task) && isPlainObject(task.task) && task.task.type === 'omp.lifecycle';
}

function decideTypedOmpEnvelopeRoute({ task, constraints, catalog, run_id }) {
  if (!isTypedOmpEnvelope(task)) return null;
  const runtimeAvailable = catalog.omp?.available === true;
  const result = validateOmpLifecycleEnvelope(task);

  if (!result.ok) {
    return withControlPlane({
      ...decision({
        lane: 'review',
        decision_code: result.decision_code,
        reason: `typed OMP lifecycle envelope rejected (${result.reason}); route to review (execute=false)`,
        requires_review: true,
        constraints,
        catalog,
        run_id,
        control_lane: 'omp',
      }),
      envelope_valid: false,
      // evidence is error codes/paths only — never raw forbidden values.
      envelope_errors: result.errors,
    }, runtimeAvailable);
  }

  const env = result.envelope;
  return withControlPlane({
    ...decision({
      lane: 'review',
      decision_code: 'omp_typed_lifecycle_review_required',
      reason: runtimeAvailable
        ? `typed OMP lifecycle envelope recognized (action=${env.action}); route to review gate before any OMP action (execute=false, monitored)`
        : `typed OMP lifecycle envelope recognized (action=${env.action}) but OMP runtime lane is unavailable (${catalog.omp?.reason ?? 'omp lane disabled'}); route to review (execute=false, monitored, not intervenable)`,
      requires_review: true,
      constraints,
      catalog,
      run_id: env.run_id ?? run_id,
      control_lane: 'omp',
    }),
    envelope_valid: true,
    envelope: env, // sanitized, metadata-only
    envelope_warnings: result.warnings,
  }, runtimeAvailable);
}

function routeEventPayload(decision) {
  return {
    kind: 'agent.route.decision',
    subject: 'agent.route.decision',
    run_id: decision.run_id,
    ts: new Date().toISOString(),
    decision,
  };
}

async function publishDecisionEvent(decision, publishDecision) {
  try {
    await publishDecision('agent.route.decision', routeEventPayload(decision));
    return { ...decision, publish_status: 'published' };
  } catch (err) {
    return { ...decision, publish_status: 'publish_failed', publish_error: err?.message ?? String(err) };
  }
}

function maybePublish(decision, { publish_route_event, publishDecision, run_id } = {}) {
  const withRun = { ...decision, run_id };
  if (!publish_route_event) return withRun;
  if (typeof publishDecision !== 'function') return { ...withRun, publish_status: 'skipped', publish_error: 'publishDecision is not a function' };
  return publishDecisionEvent(withRun, publishDecision);
}


export function decideRoute({ task = '', constraints: rawConstraints = {}, available_workers = {}, publish_route_event = false, publishDecision, run_id = null } = {}) {
  const constraints = normalizeConstraints(rawConstraints);
  const catalog = mergedCatalog(available_workers);

  // Phase 7 Slice 8: a TYPED OMP lifecycle envelope (object `task`) is recognized
  // before any text detection — always execute=false, review fallback, with the
  // sanitized envelope's run_id propagated to the decision.
  const typedDecision = decideTypedOmpEnvelopeRoute({ task, constraints, catalog, run_id });
  if (typedDecision) {
    const rid = typedDecision.envelope?.run_id ?? run_id;
    return maybePublish(typedDecision, { publish_route_event, publishDecision, run_id: rid });
  }

  const taskText = String(task).toLowerCase();

  // Phase 7 Slice 6: recognize OMP lifecycle intents (and deny unsafe OMP asks)
  // before the generic routing branches — always execute=false, review fallback,
  // monitorability contract attached. Benign `preferred_lane: 'omp'` requests
  // without a lifecycle verb fall through to the not-implemented branch below.
  const ompDecision = decideOmpRoute({ taskText, rawConstraints, constraints, catalog });
  if (ompDecision) {
    return maybePublish(ompDecision, { publish_route_event, publishDecision, run_id });
  }

  if (constraints.preferred_lane === 'omp') {
    return maybePublish(withControlPlane(decision({
      lane: 'review',
      decision_code: 'OMP_NOT_IMPLEMENTED_REVIEW_REQUIRED',
      reason: `omp requested but OMP lane is not implemented yet; route to review gate first (${catalog.omp?.reason ?? 'omp unavailable'})`,
      requires_review: true,
      constraints,
      catalog,
      control_lane: 'omp',
    }), catalog.omp?.available === true), { publish_route_event, publishDecision, run_id });
  }

  if (constraints.requires_review || /review|verify|danger|scan|gate|危险|审核|验收/.test(taskText)) {
    return maybePublish(decision({
      lane: 'review',
      decision_code: 'REVIEW_GATE_TASK',
      reason: 'review/gate task should be handled by review-worker; no downstream execution',
      requires_review: false,
      constraints,
      catalog,
    }), { publish_route_event, publishDecision, run_id });
  }

  if (constraints.requires_realtime || /monitor|intervene|realtime|watcher|实时|干预|监控/.test(taskText)) {
    if (!catalog.cc?.available) {
      return maybePublish(decision({
        lane: 'review',
        decision_code: 'CC_UNAVAILABLE_REVIEW_REQUIRED',
        reason: `realtime/interactive control requires cc-worker, but cc is unavailable (${catalog.cc?.reason ?? 'unknown'}); route to review`,
        requires_review: true,
        constraints,
        catalog,
      }), { publish_route_event, publishDecision, run_id });
    }
    return maybePublish(decision({
      lane: 'cc',
      decision_code: 'CC_REALTIME_CONTROL',
      reason: 'realtime/interactive control requires cc-worker',
      requires_review: risky(constraints.risk),
      constraints,
      catalog,
    }), { publish_route_event, publishDecision, run_id });
  }

  if (constraints.requires_code_execution) {
    if (catalog.codex?.available) {
      return maybePublish(decision({
        lane: 'codex',
        decision_code: 'CODEX_CODE_EXECUTION',
        reason: 'low/normal-risk bounded code execution fits codex-worker',
        requires_review: risky(constraints.risk),
        constraints,
        catalog,
      }), { publish_route_event, publishDecision, run_id });
    }
    if (catalog.cc?.available) {
      return maybePublish(decision({
        lane: 'cc',
        decision_code: 'CODEX_UNAVAILABLE_CC_FALLBACK',
        reason: `codex unavailable (${catalog.codex?.reason ?? 'unknown'}); fallback to cc-worker`,
        requires_review: risky(constraints.risk),
        constraints,
        catalog,
      }), { publish_route_event, publishDecision, run_id });
    }
    return maybePublish(decision({
      lane: 'review',
      decision_code: 'NO_EXECUTION_LANE_AVAILABLE',
      reason: `code execution requested but codex (${catalog.codex?.reason ?? 'unavailable'}) and cc (${catalog.cc?.reason ?? 'unavailable'}) are unavailable; route to review`,
      requires_review: true,
      constraints,
      catalog,
    }), { publish_route_event, publishDecision, run_id });
  }

  return maybePublish(decision({
    lane: 'review',
    decision_code: 'DEFAULT_REVIEW',
    reason: 'default safe route: review-worker decision/gate first; no execution',
    requires_review: false,
    constraints,
    catalog,
  }), { publish_route_event, publishDecision, run_id });
}
