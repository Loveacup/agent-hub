// Agent Runtime Control Protocol — codex-worker control helpers
import { randomUUID } from 'node:crypto';

const MONITOR_TTL_MS = 30_000;

export function buildCodexMonitor({ jobs = [], now = new Date() } = {}) {
  const ts = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  return {
    kind: 'codex.monitor',
    source: 'codex-worker',
    monitor_snapshot_id: `codex-monitor-${randomUUID().slice(0, 8)}`,
    jobs,
    ts,
  };
}

export function assertMonitorFreshForIntervention({
  monitor_snapshot_id,
  monitored_at_ms,
  now_ms = Date.now(),
  ttl_ms = MONITOR_TTL_MS,
} = {}) {
  if (!monitor_snapshot_id) {
    throw new Error('monitor_required');
  }
  if (typeof monitored_at_ms === 'number' && now_ms - monitored_at_ms > ttl_ms) {
    throw new Error('monitor_stale');
  }
  return true;
}

export function buildUnsupportedIntervention({ job_id = '', monitor_snapshot_id, message = '', reason = '' } = {}) {
  return {
    kind: 'codex.intervention',
    source: 'codex-worker',
    job_id,
    monitor_snapshot_id,
    status: 'unsupported_live_intervention',
    message,
    reason,
    alternative: ['interrupt', 're-exec-with-additional-prompt'],
    ts: new Date().toISOString(),
  };
}

export function buildInterruptDecision({ job_id = '', confirm = false, reason = '' } = {}) {
  if (!confirm) {
    return {
      kind: 'codex.interrupt',
      source: 'codex-worker',
      job_id,
      status: 'refused',
      error: 'confirm_required',
      ts: new Date().toISOString(),
    };
  }
  if (!reason || typeof reason !== 'string' || reason.trim() === '') {
    return {
      kind: 'codex.interrupt',
      source: 'codex-worker',
      job_id,
      status: 'refused',
      error: 'reason_required',
      ts: new Date().toISOString(),
    };
  }
  return {
    kind: 'codex.interrupt',
    source: 'codex-worker',
    job_id,
    status: 'allowed',
    reason,
    ts: new Date().toISOString(),
  };
}
