// Phase 3 cc-worker — scan module tests (RED phase)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const tmp = '/tmp'; // must be /tmp for cc-tmux file path realism

const {
  readStatusFile,
  parseStatusFile,
  scanSessions,
  fallbackStatus,
} = await (async () => {
  try {
    return await import('../src/scan.js');
  } catch {
    return { readStatusFile: null, parseStatusFile: null, scanSessions: null, fallbackStatus: null };
  }
})();

// ═══════ readStatusFile ═══════

test('readStatusFile reads valid cc-status JSON', async () => {
  assert.ok(readStatusFile, 'readStatusFile must be implemented');

  const dir = join(tmp, 'cc-test-read');
  await mkdir(dir, { recursive: true });
  const path = join(dir, 'cc-status-hermes-cc-default-test.json');
  const content = JSON.stringify({
    session_id: 'hermes-cc-default-test',
    state: 'IDLE',
    agent: 'default',
    topic: 'test',
    last_heartbeat: new Date().toISOString(),
  });

  try {
    await writeFile(path, content);
    const result = await readStatusFile(path);
    assert.equal(result.session_id, 'hermes-cc-default-test');
    assert.equal(result.state, 'IDLE');
    assert.equal(result.agent, 'default');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('readStatusFile returns null for missing file', async () => {
  const result = await readStatusFile('/tmp/cc-test-nonexistent.json');
  assert.equal(result, null);
});

test('readStatusFile marks source as file when successful', async () => {
  const dir = join(tmp, 'cc-test-source');
  await mkdir(dir, { recursive: true });
  const path = join(dir, 'cc-status-source.json');
  try {
    await writeFile(path, JSON.stringify({ session_id: 'x', state: 'IDLE' }));
    const result = await readStatusFile(path);
    assert.equal(result._source, 'file');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ═══════ parseStatusFile ═══════

test('parseStatusFile extracts session_id, state, heartbeat_fresh', () => {
  assert.ok(parseStatusFile, 'parseStatusFile must be implemented');

  const now = new Date().toISOString();
  const raw = {
    session_id: 'hermes-cc-default-main',
    state: 'TOOL',
    agent: 'default',
    topic: 'main',
    last_heartbeat: now,
  };
  const parsed = parseStatusFile(raw);

  assert.equal(parsed.session_id, 'hermes-cc-default-main');
  assert.equal(parsed.state, 'TOOL');
  assert.equal(parsed.heartbeat_fresh, true);
  assert.equal(parsed.observer_error, null);
});

test('parseStatusFile marks heartbeat_fresh false for old heartbeat', () => {
  const old = new Date(Date.now() - 3600_000).toISOString(); // 1 hour ago
  const parsed = parseStatusFile({
    session_id: 's',
    state: 'IDLE',
    last_heartbeat: old,
  });
  assert.equal(parsed.heartbeat_fresh, false);
});

// ═══════ scanSessions ═══════

test('scanSessions returns empty array when no cc-status files', async () => {
  assert.ok(scanSessions, 'scanSessions must be implemented');

  const sessions = await scanSessions('/tmp/cc-test-empty-dir-nonexistent-xyz');
  assert.deepEqual(sessions, []);
});

test('scanSessions returns sessions from /tmp/cc-status-* files', async () => {
  const dir = join(tmp, 'cc-test-scan');
  await mkdir(dir, { recursive: true });

  const now = new Date().toISOString();
  const s1 = join(dir, 'cc-status-hermes-cc-default-main.json');
  const s2 = join(dir, 'cc-status-hermes-cc-regent-review.json');

  try {
    await writeFile(s1, JSON.stringify({
      session_id: 'hermes-cc-default-main',
      state: 'IDLE',
      agent: 'default', topic: 'main',
      last_heartbeat: now,
    }));
    await writeFile(s2, JSON.stringify({
      session_id: 'hermes-cc-regent-review',
      state: 'THINKING',
      agent: 'regent', topic: 'review',
      last_heartbeat: now,
    }));

    const sessions = await scanSessions(dir);
    assert.equal(sessions.length, 2);

    const ids = sessions.map((s) => s.session_id).sort();
    assert.deepEqual(ids, ['hermes-cc-default-main', 'hermes-cc-regent-review']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('scanSessions marks observer_error when file is invalid JSON', async () => {
  const dir = join(tmp, 'cc-test-invalid');
  await mkdir(dir, { recursive: true });
  const path = join(dir, 'cc-status-broken.json');
  try {
    await writeFile(path, 'not json {{{');
    const sessions = await scanSessions(dir);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].observer_error, 'invalid JSON');
    assert.equal(sessions[0]._source, 'fallback');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ═══════ fallbackStatus ═══════

test('fallbackStatus returns session with source=fallback', () => {
  assert.ok(fallbackStatus, 'fallbackStatus must be implemented');

  const fb = fallbackStatus('hermes-cc-default-main', 'TOOL');
  assert.equal(fb.session_id, 'hermes-cc-default-main');
  assert.equal(fb.state, 'TOOL');
  assert.equal(fb._source, 'fallback');
  assert.equal(fb.heartbeat_fresh, true);
  assert.equal(fb.observer_error, null);
});

test('fallbackStatus sets observer_error when source is unknown', () => {
  const fb = fallbackStatus('hermes-cc-unknown', 'UNKNOWN');
  assert.equal(fb.observer_error, 'state UNKNOWN from fallback');
});
