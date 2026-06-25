// Phase 3b cc-host-bridge — execute flow helpers
import { join } from 'node:path';

const DEFAULT_CC_TMUX_SCRIPTS = '/Users/alexcai/.hermes/skills/autonomous-ai-agents/cc-tmux/scripts';
const VALID_EFFORTS = new Set(['high', 'xhigh', 'max']);

export function parseStartSessionName(stdout = '') {
  const lines = String(stdout).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (/^hermes-cc-[A-Za-z0-9._-]+/.test(lines[i])) return lines[i];
  }
  return '';
}

export function buildStartArgs(req = {}) {
  const target = req.target || 'agent-hub';
  const task = req.task || 'agent-hub task';
  const effort = VALID_EFFORTS.has(req.effort) ? req.effort : 'high';
  const model = req.model || 'claude-opus-4-8';
  const args = [
    '--target', target,
    '--task', task,
    '--effort', effort,
    '--model', model,
  ];
  if (req.topic) args.push('--topic', String(req.topic));
  if (req.ack_active === true) args.push('--ack-active');
  return args;
}

export function buildMonitorResult(session_id, runResult) {
  const relay = runResult.stdout || runResult.stderr || '';
  return {
    kind: 'cc.monitor',
    source: runResult.ok ? 'cc-monitor' : 'cc-monitor-error',
    session_id,
    status: runResult.ok ? 'ok' : 'observer_error',
    relay,
    observer_error: runResult.ok ? null : (runResult.stderr || runResult.error || 'cc-monitor failed'),
    monitor_snapshot_id: `cc-monitor-${Date.now()}`,
    ts: new Date().toISOString(),
  };
}

export async function executeFlow(req = {}, {
  runFn,
  scriptsDir = DEFAULT_CC_TMUX_SCRIPTS,
} = {}) {
  if (typeof runFn !== 'function') throw new Error('runFn_required');

  let session = req.session_id || '';
  let startResult = null;
  if (!session) {
    startResult = await runFn(join(scriptsDir, 'cc-start.sh'), buildStartArgs(req), { timeout: 60_000 });
    if (!startResult.ok) {
      if (startResult.exit_code === 3) {
        return {
          kind: 'cc.execute',
          source: 'cc-host-bridge',
          status: 'refused',
          error: 'active_sessions_require_ack',
          relay: `${startResult.stdout || ''}${startResult.stderr || ''}`,
          ts: new Date().toISOString(),
        };
      }
      return {
        kind: 'cc.execute',
        source: 'cc-host-bridge',
        status: 'refused',
        error: 'cc_start_failed',
        exit_code: startResult.exit_code,
        relay: `${startResult.stdout || ''}${startResult.stderr || ''}`,
        ts: new Date().toISOString(),
      };
    }
    session = parseStartSessionName(startResult.stdout);
    if (!session) {
      return {
        kind: 'cc.execute',
        source: 'cc-host-bridge',
        status: 'refused',
        error: 'cc_start_session_parse_failed',
        relay: startResult.stdout || '',
        ts: new Date().toISOString(),
      };
    }
  }

  const monitorBeforeRaw = await runFn(join(scriptsDir, 'cc-monitor.sh'), ['--session', session], { timeout: 20_000 });
  const monitorBefore = buildMonitorResult(session, monitorBeforeRaw);
  if (monitorBefore.status !== 'ok') {
    return {
      kind: 'cc.execute',
      source: 'cc-host-bridge',
      session_id: session,
      status: 'refused',
      error: 'monitor_failed_before_send',
      monitor_before: monitorBefore,
      ts: new Date().toISOString(),
    };
  }

  const send = await runFn(join(scriptsDir, 'cc-send.sh'), ['--session', session, '--context', req.context_path], { timeout: 60_000 });
  const monitorAfterRaw = await runFn(join(scriptsDir, 'cc-monitor.sh'), ['--session', session], { timeout: 20_000 });
  const monitorAfter = buildMonitorResult(session, monitorAfterRaw);

  return {
    kind: 'cc.execute',
    source: 'cc-host-bridge',
    session_id: session,
    status: send.ok ? 'sent' : 'send_failed',
    lifecycle_state: send.ok ? 'sent_not_completed' : 'send_failed',
    start: startResult ? { exit_code: startResult.exit_code } : null,
    send_exit_code: send.exit_code,
    stderr: send.stderr || '',
    monitor_before: monitorBefore,
    monitor_after: monitorAfter,
    ts: new Date().toISOString(),
  };
}
