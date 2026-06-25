// Phase 3 cc-worker — publish module tests (RED phase)
import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  sanitizeSubjectToken,
  buildNatsPublishFrame,
  buildPoolStatus,
  buildSessionStatus,
  discoverSessions,
} = await (async () => {
  try {
    return await import('../src/publish.js');
  } catch {
    return { sanitizeSubjectToken: null, buildNatsPublishFrame: null, buildPoolStatus: null, buildSessionStatus: null, discoverSessions: null };
  }
})();

// ═══════ sanitizeSubjectToken ═══════

test('sanitizeSubjectToken rejects dots, spaces, asterisks, greater-than', () => {
  assert.ok(sanitizeSubjectToken, 'sanitizeSubjectToken must be implemented');

  assert.throws(() => sanitizeSubjectToken('agent.default'), /token/);
  assert.throws(() => sanitizeSubjectToken('agent topic'), /token/);
  assert.throws(() => sanitizeSubjectToken('agent*'), /token/);
  assert.throws(() => sanitizeSubjectToken('agent>'), /token/);
});

test('sanitizeSubjectToken allows alphanumeric, hyphens, underscores', () => {
  assert.equal(sanitizeSubjectToken('agent-123_main'), 'agent-123_main');
});

test('sanitizeSubjectToken returns empty string for empty input', () => {
  assert.equal(sanitizeSubjectToken(''), '');
});

// ═══════ buildNatsPublishFrame ═══════

test('buildNatsPublishFrame generates valid PUB frame', () => {
  assert.ok(buildNatsPublishFrame, 'buildNatsPublishFrame must be implemented');

  const frame = buildNatsPublishFrame('agent.cc.pool.status', { kind: 'cc.status', source: 'cc-worker' });
  assert.match(frame, /^PUB agent\.cc\.pool\.status/);
  assert.match(frame, /\r\n$/);
});

test('buildNatsPublishFrame includes correct byte length', () => {
  const payload = { kind: 'cc.status', sessions: [] };
  const frame = buildNatsPublishFrame('agent.cc.pool.status', payload);
  const lines = frame.split('\r\n');
  assert.equal(lines[0], 'PUB agent.cc.pool.status ' + Buffer.byteLength(JSON.stringify(payload)));
});

// ═══════ buildPoolStatus ═══════

test('buildPoolStatus returns correct shape with sessions', () => {
  assert.ok(buildPoolStatus, 'buildPoolStatus must be implemented');

  const sessions = [
    { session_id: 's1', state: 'IDLE', heartbeat_fresh: true, observer_error: null, _source: 'file' },
  ];
  const status = buildPoolStatus(sessions);
  assert.equal(status.kind, 'cc.status');
  assert.equal(status.source, 'cc-worker');
  assert.equal(status.sessions.length, 1);
  assert.ok(typeof status.ts === 'string');
  // _source stripped
  assert.equal(status.sessions[0]._source, undefined);
});

test('buildPoolStatus returns empty sessions for empty input', () => {
  const status = buildPoolStatus([]);
  assert.deepEqual(status.sessions, []);
});

// ═══════ buildSessionStatus ═══════

test('buildSessionStatus returns per-session payload with correct subject', () => {
  assert.ok(buildSessionStatus, 'buildSessionStatus must be implemented');

  const session = { session_id: 'hermes-cc-default-main', state: 'IDLE', heartbeat_fresh: true, observer_error: null };
  const { subject, payload } = buildSessionStatus(session);

  assert.equal(subject, 'agent.cc.default.main.hermes-cc-default-main.status');
  assert.equal(payload.kind, 'cc.status');
  assert.equal(payload.sessions.length, 1);
  assert.equal(payload.sessions[0].session_id, 'hermes-cc-default-main');
});

test('buildSessionStatus omits per-session subject when agent/topic cannot be parsed', () => {
  const session = { session_id: 'broken-session-id', state: 'IDLE', heartbeat_fresh: true, observer_error: null };
  const result = buildSessionStatus(session);
  // should return null or similar for unparseable sessions
  assert.equal(result, null);
});

// ═══════ discoverSessions ═══════

test('discoverSessions returns empty array when no tmux sessions', () => {
  assert.ok(discoverSessions, 'discoverSessions must be implemented');

  const sessions = discoverSessions([]);
  assert.deepEqual(sessions, []);
});

test('discoverSessions filters to hermes-cc-* sessions only', () => {
  const tmuxLines = [
    'hermes-cc-default-main: 1 windows',
    'other-session: 1 windows',
    'hermes-cc-regent-review: 1 windows',
  ];
  const sessions = discoverSessions(tmuxLines);
  assert.equal(sessions.length, 2);
  assert.deepEqual(sessions, ['hermes-cc-default-main', 'hermes-cc-regent-review']);
});
