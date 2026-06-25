// Phase 3b cc-worker — bounded watch loop helpers

const TERMINAL_STATES = new Set(['COMPLETED', 'BLOCKED', 'FREEZE', 'FROZEN', 'ERROR']);

export function normalizeWatchState(monitor = {}) {
  const state = monitor.state ? String(monitor.state).toUpperCase() : 'UNKNOWN';
  return state || 'UNKNOWN';
}

export function shouldStopWatch(monitor = {}) {
  if (monitor.status === 'error') return true;
  return TERMINAL_STATES.has(normalizeWatchState(monitor));
}

export function buildWatchEvent({ session_id = '', sequence = 0, monitor = {}, now = new Date(), suggestion = null } = {}) {
  const state = normalizeWatchState(monitor);
  const event = {
    kind: 'cc.watch.event',
    source: 'cc-watch-session',
    session_id,
    sequence,
    state,
    terminal: shouldStopWatch(monitor),
    monitor,
    ts: now instanceof Date ? now.toISOString() : String(now),
  };
  if (suggestion) event.suggestion = suggestion;
  return event;
}

export function shouldEmitWatchEvent(previous = null, current = {}) {
  if (!previous) return true;
  if (current.status === 'error') return true;
  return normalizeWatchState(previous) !== normalizeWatchState(current);
}

export function shouldSuggestIntervention({ repeated_ticks = 0, stale_after_ticks = 0, monitor = {} } = {}) {
  if (!stale_after_ticks || repeated_ticks < stale_after_ticks) return false;
  if (shouldStopWatch(monitor)) return false;
  return ['THINKING', 'TOOL', 'IDLE', 'UNKNOWN'].includes(normalizeWatchState(monitor));
}

export function buildInterventionSuggestion({
  session_id = '',
  state = 'UNKNOWN',
  repeated_ticks = 0,
  interval_ms = 0,
  monitor_snapshot_id = null,
} = {}) {
  const stale_ms = repeated_ticks * interval_ms;
  return {
    kind: 'cc.intervention.suggestion',
    source: 'cc-watch-session',
    session_id,
    reason: 'state_stale',
    state,
    repeated_ticks,
    stale_ms,
    monitor_snapshot_id,
    auto_execute: false,
    message: `CC session ${session_id} is still ${state} after ${repeated_ticks} watch ticks (~${Math.round(stale_ms / 1000)}s). Consider sending a concise follow-up via cc::intervene if this is unexpected.`,
    ts: new Date().toISOString(),
  };
}
