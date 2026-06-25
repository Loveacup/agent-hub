// Phase 3b cc watcher loop tests (RED phase)
import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  normalizeWatchState,
  shouldStopWatch,
  buildWatchEvent,
  shouldEmitWatchEvent,
  buildInterventionSuggestion,
  shouldSuggestIntervention,
} = await (async () => {
  try {
    return await import('../src/watchLoop.js');
  } catch {
    return { normalizeWatchState: null, shouldStopWatch: null, buildWatchEvent: null, shouldEmitWatchEvent: null, buildInterventionSuggestion: null, shouldSuggestIntervention: null };
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

test('shouldSuggestIntervention triggers on repeated non-terminal state after threshold', () => {
  assert.ok(shouldSuggestIntervention, 'shouldSuggestIntervention must be implemented');
  assert.equal(shouldSuggestIntervention({ repeated_ticks: 2, stale_after_ticks: 3, monitor: { state: 'THINKING', status: 'ok' } }), false);
  assert.equal(shouldSuggestIntervention({ repeated_ticks: 3, stale_after_ticks: 3, monitor: { state: 'THINKING', status: 'ok' } }), true);
  assert.equal(shouldSuggestIntervention({ repeated_ticks: 5, stale_after_ticks: 3, monitor: { state: 'COMPLETED', status: 'ok' } }), false);
  assert.equal(shouldSuggestIntervention({ repeated_ticks: 5, stale_after_ticks: 3, monitor: { status: 'error' } }), false);
});

test('buildInterventionSuggestion produces auditable suggestion and never auto-intervenes', () => {
  assert.ok(buildInterventionSuggestion, 'buildInterventionSuggestion must be implemented');
  const suggestion = buildInterventionSuggestion({
    session_id: 'hermes-cc-default-agent-hub-0625-1600',
    state: 'THINKING',
    repeated_ticks: 4,
    interval_ms: 15000,
    monitor_snapshot_id: 'snap-1',
  });
  assert.equal(suggestion.kind, 'cc.intervention.suggestion');
  assert.equal(suggestion.auto_execute, false);
  assert.equal(suggestion.session_id, 'hermes-cc-default-agent-hub-0625-1600');
  assert.equal(suggestion.reason, 'state_stale');
  assert.match(suggestion.message, /still THINKING/i);
  assert.equal(suggestion.monitor_snapshot_id, 'snap-1');
});

test('buildWatchEvent attaches suggestion when supplied', () => {
  const suggestion = { kind: 'cc.intervention.suggestion', auto_execute: false };
  const event = buildWatchEvent({
    session_id: 's',
    sequence: 2,
    monitor: { state: 'THINKING', status: 'ok' },
    suggestion,
  });
  assert.equal(event.suggestion, suggestion);
});
