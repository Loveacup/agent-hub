// Phase 4 codex-worker — collect module tests (RED phase)
import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  buildNatsPublishFrame,
  sanitizeSubjectToken,
  buildCodexStatus,
  buildRetentionReport,
} = await (async () => {
  try {
    return await import('../src/collect.js');
  } catch {
    return { buildNatsPublishFrame: null, sanitizeSubjectToken: null, buildCodexStatus: null, buildRetentionReport: null };
  }
})();

// ═══════ NATS PUB frame ═══════

test('buildNatsPublishFrame generates valid NATS PUB frame for agent.codex.*', () => {
  assert.ok(buildNatsPublishFrame, 'buildNatsPublishFrame must be implemented');

  const frame = buildNatsPublishFrame('agent.codex.default.topic.job123.status', { kind: 'codex.status', source: 'codex-worker', ts: '2026-06-25T12:00:00Z' });
  assert.match(frame, /^PUB agent\.codex\./);
  assert.match(frame, /\r\n$/);
});

test('buildNatsPublishFrame includes subject length and payload', () => {
  const payload = { kind: 'codex.status', source: 'codex-worker', jobs: [] };
  const frame = buildNatsPublishFrame('agent.codex.pool.status', payload);
  const lines = frame.split('\r\n');
  assert.equal(lines[0], 'PUB agent.codex.pool.status ' + Buffer.byteLength(JSON.stringify(payload)));
  assert.equal(lines[2], '');
});

// ═══════ subject sanitize ═══════

test('sanitizeSubjectToken rejects dots, spaces, asterisks, and greater-than', () => {
  assert.ok(sanitizeSubjectToken, 'sanitizeSubjectToken must be implemented');

  assert.throws(() => sanitizeSubjectToken('to.ken'), /token/);
  assert.throws(() => sanitizeSubjectToken('to ken'), /token/);
  assert.throws(() => sanitizeSubjectToken('to*ken'), /token/);
  assert.throws(() => sanitizeSubjectToken('to>ken'), /token/);
});

test('sanitizeSubjectToken allows alphanumeric, hyphens, underscores', () => {
  assert.equal(sanitizeSubjectToken('token-123_abc'), 'token-123_abc');
});

test('sanitizeSubjectToken returns empty string for empty input', () => {
  assert.equal(sanitizeSubjectToken(''), '');
});

// ═══════ buildCodexStatus ═══════

test('buildCodexStatus returns correct shape with empty jobs', () => {
  assert.ok(buildCodexStatus, 'buildCodexStatus must be implemented');

  const status = buildCodexStatus([]);
  assert.equal(status.kind, 'codex.status');
  assert.equal(status.source, 'codex-worker');
  assert.deepEqual(status.jobs, []);
  assert.ok(typeof status.ts === 'string');
});

test('buildCodexStatus includes job details', () => {
  const jobs = [
    {
      job_id: 'codex-abc123',
      state: 'running',
      workdir: '/Users/alexcai/code/agent-hub',
      started_at: '2026-06-25T12:00:00Z',
    },
  ];

  const status = buildCodexStatus(jobs);
  assert.equal(status.jobs.length, 1);
  assert.equal(status.jobs[0].job_id, 'codex-abc123');
  assert.equal(status.jobs[0].state, 'running');
});

// ═══════ buildRetentionReport ═══════

test('buildRetentionReport returns correct shape with session data', () => {
  assert.ok(buildRetentionReport, 'buildRetentionReport must be implemented');

  const report = buildRetentionReport({
    sessions_count: 5,
    bytes: 1024000,
    oldest: '2026-06-20T10:00:00Z',
    newest: '2026-06-25T12:00:00Z',
  });

  assert.equal(report.kind, 'codex.retention_report');
  assert.equal(report.sessions_count, 5);
  assert.equal(report.bytes, 1024000);
  assert.deepEqual(report.recommendations, []);
});
