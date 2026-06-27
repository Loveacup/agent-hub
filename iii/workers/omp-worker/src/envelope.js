// Phase 7 Slice 9A — OMP typed lifecycle envelope ENTRY (PURE; metadata-only).
//
// Scope (Slice 9A): the typed envelope CONTRACT (validator + constants + pure
// helpers) was extracted into the shared module `../../shared/omp-contract.js`
// so review-worker can import it without a cross-worker relative path. This file
// is now a thin compatibility ENTRY: it re-exports the contract unchanged and
// keeps the omp-worker-only event/publisher helpers that depend on ./audit.js.
// Every importer of `../src/envelope.js` keeps the exact same public surface.
//
// This module stays PURE by construction:
//   - performs NO filesystem access (no fs import, no adapter),
//   - never reads the real ~/.omp / `.env` / `mcp.json`,
//   - never inspects the runtime environment table,
//   - never starts a child process and never opens a socket/network,
//   - NEVER enables an OMP runtime: every accepted envelope is planning metadata
//     only and asserts execute=false (apply-plan is plan metadata, not apply),
//   - NEVER echoes a raw body/payload/secret/session/log/transcript value,
//   - never throws on malformed input — failures are structured results.
//
// The publisher helper here publishes ONLY via an INJECTED async publisher and
// only metadata-only payloads; it never opens a live NATS/network connection.

import { buildOmpLifecycleEvent } from './audit.js';
import { isPlainObject } from '../../shared/omp-contract.js';

// Re-export the shared typed-envelope contract so `../src/envelope.js` remains a
// drop-in import surface (validator + constants), now backed by the shared module.
export {
  validateOmpLifecycleEnvelope,
  ENVELOPE_KIND,
  TASK_TYPE,
  ENVELOPE_ACTIONS,
  ACTION_TO_LIFECYCLE,
  FORBIDDEN_FIELDS,
} from '../../shared/omp-contract.js';

// Build a metadata-only lifecycle event from a VALIDATED envelope, reusing the
// audit-layer allowlist (redactOmpEventMetadata) so no field outside the
// allowlist can ride along. Never reads raw input beyond the sanitized envelope.
export function buildEnvelopeLifecycleEvent(envelope, extra = {}) {
  const src = isPlainObject(envelope) ? envelope : {};
  return buildOmpLifecycleEvent({
    profile: src.profile ?? null,
    lifecycle_action: src.lifecycle_action ?? null,
    status: typeof extra.status === 'string' ? extra.status : 'planned',
    decision_code: typeof extra.decision_code === 'string' ? extra.decision_code : 'omp_typed_lifecycle_review_required',
  });
}

// Publish a metadata-only envelope lifecycle event via an INJECTED async
// publisher. No live NATS / network / env-derived endpoint is ever opened here —
// supplying the publisher is the caller's responsibility, and it receives a
// metadata-only payload. Fails closed (no publish) when no publisher is given.
export async function publishEnvelopeLifecycleEvent(envelope, publish, extra = {}) {
  if (typeof publish !== 'function') {
    return {
      ok: false,
      published: false,
      decision_code: 'omp_envelope_publish_no_publisher',
      reason: 'an injected async publisher function is required; no live NATS/network fallback exists',
    };
  }
  const event = buildEnvelopeLifecycleEvent(envelope, extra);
  try {
    await publish(event.subject, event);
    return { ok: true, published: true, subject: event.subject, event };
  } catch (e) {
    return {
      ok: false,
      published: false,
      decision_code: 'omp_envelope_publish_failed',
      reason: e?.message ?? String(e),
      subject: event.subject,
      event,
    };
  }
}
