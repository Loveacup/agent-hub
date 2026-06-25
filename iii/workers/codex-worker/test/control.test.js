// Agent Runtime Control Protocol — codex-worker control contract tests (RED phase)
import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  buildCodexMonitor,
  buildUnsupportedIntervention,
  buildInterruptDecision,
  assertMonitorFreshForIntervention,
} = await (async () => {
  try {
    return await import('../src/control.js');
  } catch {
    return {
      buildCodexMonitor: null,
      buildUnsupportedIntervention: null,
      buildInterruptDecision: null,
      assertMonitorFreshForIntervention: null,
    };
  }
})();

test('buildCodexMonitor returns active job state and snapshot id', () => {
  assert.ok(buildCodexMonitor, 'buildCodexMonitor must be implemented');

  const result = buildCodexMonitor({
    jobs: [{ job_id: 'codex-1', status: 'running', stdout_path: '/tmp/a.jsonl' }],
  });

  assert.equal(result.kind, 'codex.monitor');
  assert.equal(result.source, 'codex-worker');
  assert.equal(result.jobs.length, 1);
  assert.equal(result.jobs[0].job_id, 'codex-1');
  assert.match(result.monitor_snapshot_id, /^codex-monitor-/);
});

test('intervention requires a recent monitor snapshot', () => {
  assert.ok(assertMonitorFreshForIntervention, 'assertMonitorFreshForIntervention must be implemented');

  assert.throws(
    () => assertMonitorFreshForIntervention({ monitor_snapshot_id: null }),
    /monitor_required/,
  );

  const fresh = assertMonitorFreshForIntervention({
    monitor_snapshot_id: 'codex-monitor-123',
    monitored_at_ms: Date.now(),
  });
  assert.equal(fresh, true);
});

test('buildUnsupportedIntervention returns explicit alternative strategy for codex exec', () => {
  assert.ok(buildUnsupportedIntervention, 'buildUnsupportedIntervention must be implemented');

  const result = buildUnsupportedIntervention({
    job_id: 'codex-1',
    monitor_snapshot_id: 'codex-monitor-123',
    message: 'please change direction',
  });

  assert.equal(result.kind, 'codex.intervention');
  assert.equal(result.status, 'unsupported_live_intervention');
  assert.equal(result.monitor_snapshot_id, 'codex-monitor-123');
  assert.deepEqual(result.alternative, ['interrupt', 're-exec-with-additional-prompt']);
});

test('buildInterruptDecision refuses without confirm and requires reason when confirmed', () => {
  assert.ok(buildInterruptDecision, 'buildInterruptDecision must be implemented');

  const refused = buildInterruptDecision({ job_id: 'codex-1', confirm: false });
  assert.equal(refused.status, 'refused');
  assert.equal(refused.error, 'confirm_required');

  const missingReason = buildInterruptDecision({ job_id: 'codex-1', confirm: true });
  assert.equal(missingReason.status, 'refused');
  assert.equal(missingReason.error, 'reason_required');

  const allowed = buildInterruptDecision({ job_id: 'codex-1', confirm: true, reason: 'user changed direction' });
  assert.equal(allowed.status, 'allowed');
  assert.equal(allowed.reason, 'user changed direction');
});
