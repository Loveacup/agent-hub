// Phase 7 Slice 9B — E2E metadata-only pipeline smoke (TDD; pure, no filesystem, no NATS).
//
// Proves the full metadata-only OMP lifecycle pipeline works end-to-end across
// the shared contract, the omp-worker audit/publisher helpers, and the
// review-worker router — WITHOUT a real NATS connection, WITHOUT touching the
// real ~/.omp, and with execute=false at every step. The published payload is
// metadata-only: no secret/session/log/body/transcript/content/payload/env keys
// or values ever ride along.
//
//   typed envelope input
//     → validateOmpLifecycleEnvelope (shared contract)
//     → buildOmpLifecycleEvent (audit helper)
//     → decideRoute (review-worker routing)
//     → publishEnvelopeLifecycleEvent (injected fake publisher)
//     → verify metadata-only payload
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { validateOmpLifecycleEnvelope } from '../../shared/omp-contract.js';
import { buildOmpLifecycleEvent } from '../src/audit.js';
import { decideRoute } from '../../review-worker/src/routing.js';
import { publishEnvelopeLifecycleEvent } from '../src/envelope.js';

// Forbidden substrings that must NEVER appear anywhere in the published payload.
const FORBIDDEN_PAYLOAD_SUBSTRINGS = ['secret', 'session', 'log', 'body', 'transcript', 'content', 'payload', 'env'];

test('E2E: typed envelope flows validate → build → route → publish, metadata-only and execute=false', async () => {
  // 1+5. a valid typed envelope: action=discover, profile=page, non-executing.
  const typedEnvelope = {
    task: { type: 'omp.lifecycle', action: 'discover', profile: 'page' },
    constraints: { execute: false, live: false, cross_profile: false },
    run_id: 'slice9b-e2e-1',
  };

  // 6. validate it via the SHARED contract.
  const validated = validateOmpLifecycleEnvelope(typedEnvelope);
  assert.equal(validated.ok, true);
  const env = validated.envelope;
  assert.equal(env.action, 'discover');
  assert.equal(env.lifecycle_action, 'discover');
  assert.equal(env.profile, 'page');
  // execute=false (step 10): the sanitized envelope is non-executing.
  assert.equal(env.constraints.execute, false);
  assert.equal(env.metadata_only, true); // metadata_only=true

  // 7. build a metadata-only lifecycle event from the validated envelope.
  const event = buildOmpLifecycleEvent({
    profile: env.profile,
    lifecycle_action: env.lifecycle_action,
    status: 'planned',
    decision_code: 'omp_typed_lifecycle_review_required',
  });
  assert.equal(event.metadata_only, true); // metadata_only=true
  assert.equal(event.redacted, true);
  assert.match(event.subject, /^agent\.omp\.profile\.page\.lifecycle$/);

  // 8. route via the review-worker router (typed front door).
  const route = decideRoute({ task: typedEnvelope });
  assert.equal(route.lane, 'review');             // route lane is review
  assert.equal(route.execute, false);             // execute=false
  assert.equal(route.requires_review, true);
  assert.equal(route.decision_code, 'omp_typed_lifecycle_review_required');
  assert.equal(route.runtime_available, false);   // runtime_available=false
  assert.equal(route.control_plane.runtime_available, false);
  assert.equal(route.envelope_valid, true);
  assert.equal(route.run_id, 'slice9b-e2e-1');

  // 9. publish via an INJECTED fake publisher — no real NATS/network.
  const published = [];
  const fakePublish = async (subject, payload) => { published.push({ subject, payload }); };
  const pub = await publishEnvelopeLifecycleEvent(env, fakePublish, { decision_code: 'omp_typed_lifecycle_review_required' });
  assert.equal(pub.ok, true);
  assert.equal(pub.published, true);
  assert.equal(published.length, 1);

  // 10. the published payload is metadata-only and execute=false.
  const payload = published[0].payload;
  assert.equal(payload.metadata_only, true);      // metadata_only=true
  assert.equal(payload.redacted, true);
  // the event carries no execute field (it is planning metadata, never an exec);
  // assert it is not surfaced as a live execution.
  assert.notEqual(payload.execute, true);

  // the metadata is exactly the audit allowlist — no raw forbidden keys. This is
  // the strongest guarantee: only these count/string meta keys can ever survive.
  const ALLOWED_META_KEYS = [
    'profile', 'lifecycle_action', 'status', 'decision_code',
    'check_count', 'finding_count', 'error_count', 'warning_count',
    'mcp_server_count', 'env_key_count', 'file_action_count', 'conflict_count',
  ];
  for (const k of Object.keys(payload.metadata)) {
    assert.ok(ALLOWED_META_KEYS.includes(k), `metadata key ${k} must be allowlisted`);
  }

  // published payload carries no forbidden CONTENT. We scan the outer envelope
  // plus the metadata VALUES — deliberately NOT the metadata key names, because
  // the legitimate allowlist key `env_key_count` contains the substring "env"
  // (it is a redacted count, never an env value). No real env/secret/session/log/
  // body/transcript/content/payload value can ride through the audit allowlist.
  const outer = JSON.stringify({
    subject: payload.subject,
    type: payload.type,
    metadata_only: payload.metadata_only,
    redacted: payload.redacted,
  }).toLowerCase();
  const metaValues = JSON.stringify(Object.values(payload.metadata)).toLowerCase();
  const scan = outer + metaValues;
  for (const marker of FORBIDDEN_PAYLOAD_SUBSTRINGS) {
    assert.ok(!scan.includes(marker), `published payload must not contain forbidden content "${marker}"`);
  }
});

// ── config.yaml still registers no OMP worker runtime lane ───────────────────
test('E2E: iii/config.yaml still does not register an omp-worker runtime lane', () => {
  const configPath = fileURLToPath(new URL('../../../config.yaml', import.meta.url));
  const cfg = readFileSync(configPath, 'utf8');
  assert.ok(!/name:\s*omp-worker/.test(cfg), 'config.yaml must not register omp-worker as a runtime lane');

  // and the router still reports the OMP lane as unavailable.
  const route = decideRoute({
    task: { task: { type: 'omp.lifecycle', action: 'discover', profile: 'page' }, constraints: { execute: false, live: false, cross_profile: false } },
  });
  assert.equal(route.available_workers.omp.available, false);
});
