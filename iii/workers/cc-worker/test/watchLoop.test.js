// Phase 3b cc watcher loop tests (RED phase)
import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  normalizeWatchState,
  shouldStopWatch,
  buildWatchEvent,
  shouldEmitWatchEvent,
} = await (async () => {
  try {
    return await import('../src/watchLoop.js');
  } catch {
    return { normalizeWatchState: null, shouldStopWatch: null, buildWatchEvent: null, shouldEmitWatchEvent: null };
  }
})();

test('normalizeWatchState prefers explicit state and uppercases it', () => {
  assert.ok(normalizeWatchState, 'normalizeWatchState must be implemented');
  assert.equal(normalizeWatchState({ state: 'thinking' }), 'THINKING');
  assert.equal(normalizeWatchState({ status: 'ok', bridge: {} }), 'UNKNOWN');
});

test('shouldStopWatch stops only on terminal/error states', () => {
  assert.ok(shouldStopWatch, 'shouldStopWatch must be implemented');
  assert.equal(shouldStopWatch({ state: 'COMPLETED' }), true);
  assert.equal(shouldStopWatch({ state: 'BLOCKED' }), true);
  assert.equal(shouldStopWatch({ state: 'FREEZE' }), true);
  assert.equal(shouldStopWatch({ status: 'error' }), true);
  assert.equal(shouldStopWatch({ state: 'THINKING', status: 'ok' }), false);
});

test('buildWatchEvent records session, state, sequence, terminal flag, and raw monitor', () => {
  assert.ok(buildWatchEvent, 'buildWatchEvent must be implemented');
  const event = buildWatchEvent({
    session_id: 'hermes-cc-default-agent-hub-0625-1600',
    sequence: 3,
    monitor: { kind: 'cc.monitor', status: 'ok', state: 'COMPLETED', monitor_snapshot_id: 'snap-1' },
  });
  assert.equal(event.kind, 'cc.watch.event');
  assert.equal(event.session_id, 'hermes-cc-default-agent-hub-0625-1600');
  assert.equal(event.sequence, 3);
  assert.equal(event.state, 'COMPLETED');
  assert.equal(event.terminal, true);
  assert.equal(event.monitor.monitor_snapshot_id, 'snap-1');
});

test('shouldEmitWatchEvent emits first event and state changes, suppresses repeated state', () => {
  assert.ok(shouldEmitWatchEvent, 'shouldEmitWatchEvent must be implemented');
  assert.equal(shouldEmitWatchEvent(null, { state: 'THINKING' }), true);
  assert.equal(shouldEmitWatchEvent({ state: 'THINKING' }, { state: 'THINKING' }), false);
  assert.equal(shouldEmitWatchEvent({ state: 'THINKING' }, { state: 'TOOL' }), true);
  assert.equal(shouldEmitWatchEvent({ state: 'THINKING' }, { status: 'error', error: 'x' }), true);
});
