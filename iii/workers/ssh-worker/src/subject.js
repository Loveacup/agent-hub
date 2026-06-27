// Phase 8 Slice 1 — NATS device subject sanitizer (RESERVED; no real publish).
//
// Slice 1 only *builds and validates* the subject string. It performs NO NATS
// connection and NO publish. Every path component is constrained to a strict
// whitelist so a malicious device_id/runtime/session/verb can never inject
// wildcard ('*', '>') tokens or extra '.'-delimited levels into a subject.
//
// Pattern: agent.device.<device_id>.<runtime>.<session>.<verb>
// Pure + fail-closed: malformed input returns { ok:false }, never throws.

const SUBJECT_KIND = 'ssh.device.subject';

// Each component must be a non-empty run of [A-Za-z0-9-]. This bans '.', '*',
// '>', whitespace, and every other NATS-significant character.
const TOKEN_RE = /^[A-Za-z0-9-]+$/;

const COMPONENTS = ['device_id', 'runtime', 'session', 'verb'];

export function buildDeviceSubject(input = {}) {
  const source = input !== null && typeof input === 'object' ? input : {};
  const invalid = [];
  for (const key of COMPONENTS) {
    const value = source[key];
    if (typeof value !== 'string' || !TOKEN_RE.test(value)) {
      invalid.push(key);
    }
  }

  if (invalid.length > 0) {
    return {
      ok: false,
      kind: SUBJECT_KIND,
      subject: null,
      decision_code: 'invalid_subject_token',
      invalid,
      published: false,
    };
  }

  const { device_id, runtime, session, verb } = source;
  return {
    ok: true,
    kind: SUBJECT_KIND,
    subject: `agent.device.${device_id}.${runtime}.${session}.${verb}`,
    published: false,
  };
}
