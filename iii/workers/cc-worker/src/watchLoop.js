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

export function buildWatchEvent({ session_id = '', sequence = 0, monitor = {}, now = new Date() } = {}) {
  const state = normalizeWatchState(monitor);
  return {
    kind: 'cc.watch.event',
    source: 'cc-watch-session',
    session_id,
    sequence,
    state,
    terminal: shouldStopWatch(monitor),
    monitor,
    ts: now instanceof Date ? now.toISOString() : String(now),
  };
}

export function shouldEmitWatchEvent(previous = null, current = {}) {
  if (!previous) return true;
  if (current.status === 'error') return true;
  return normalizeWatchState(previous) !== normalizeWatchState(current);
}
