// Phase 8 Slice 1 — NATS device subject sanitizer tests (no real publish).
//
// buildDeviceSubject only constructs + validates the subject string. It never
// connects to NATS and never publishes. Each component is constrained to
// [A-Za-z0-9-], so wildcard ('*','>') and extra-level ('.') injection is
// impossible. Fail-closed: malformed input returns { ok:false }, never throws.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildDeviceSubject } from '../src/subject.js';

test('valid components build the canonical subject and never publish', () => {
  const res = buildDeviceSubject({ device_id: 'nas-01', runtime: 'codex', session: 's1', verb: 'acquire' });
  assert.equal(res.ok, true);
  assert.equal(res.subject, 'agent.device.nas-01.codex.s1.acquire');
  assert.equal(res.published, false, 'Slice 1 never publishes');
});

test('a dot in any component is rejected (no extra subject levels)', () => {
  const res = buildDeviceSubject({ device_id: 'nas.01', runtime: 'codex', session: 's1', verb: 'acquire' });
  assert.equal(res.ok, false);
  assert.equal(res.subject, null);
  assert.ok(res.invalid.includes('device_id'));
});

test('wildcard / whitespace / empty components are rejected', () => {
  const cases = [
    { device_id: '*', runtime: 'codex', session: 's1', verb: 'acquire', bad: 'device_id' },
    { device_id: 'nas-01', runtime: '>', session: 's1', verb: 'acquire', bad: 'runtime' },
    { device_id: 'nas-01', runtime: 'codex', session: 's 1', verb: 'acquire', bad: 'session' },
    { device_id: 'nas-01', runtime: 'codex', session: 's1', verb: '', bad: 'verb' },
  ];
  for (const c of cases) {
    const res = buildDeviceSubject(c);
    assert.equal(res.ok, false, JSON.stringify(c));
    assert.ok(res.invalid.includes(c.bad), `${c.bad} must be flagged`);
    assert.equal(res.subject, null);
  }
});

test('missing components are reported, never thrown', () => {
  for (const bad of [undefined, null, 42, 'str', {}, { device_id: 'nas-01' }]) {
    let res;
    assert.doesNotThrow(() => {
      res = buildDeviceSubject(bad);
    }, `threw on ${String(bad)}`);
    assert.equal(res.ok, false);
    assert.equal(res.published, false);
    assert.ok(Array.isArray(res.invalid) && res.invalid.length >= 1);
  }
});
