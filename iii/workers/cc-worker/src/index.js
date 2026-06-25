// Phase 3 cc-worker — worker entry
// Registers cc::status, cc::discover, cc::publish_status with iii engine.
import { registerWorker } from 'iii-sdk';
import { scanSessions, capturePaneFallback } from './scan.js';
import { buildPoolStatus, buildSessionStatus, discoverSessions, publishFrame } from './publish.js';
import { callHostBridge } from './bridgeClient.js';

const ENGINE_URL = process.env.III_ENGINE_URL || process.env.III_URL || 'ws://localhost:49134';

const iii = registerWorker(ENGINE_URL, { workerName: 'cc-worker' });

// ─── cc::status — scan /tmp for cc-status-* files and return parsed sessions ───

iii.registerFunction('cc::status', async () => {
  const sessions = await scanSessions('/tmp');
  return buildPoolStatus(sessions);
});

// ─── cc::discover — list hermes-cc-* tmux sessions (read-only) ───

iii.registerFunction('cc::discover', async () => {
  // Stub for Phase 3 minimal slice. Real impl uses tmux list-sessions.
  // In iii VM sandbox, tmux is not accessible; return empty.
  // Host-side test uses direct function call.
  return { sessions: [], kind: 'cc.discover', source: 'cc-worker', ts: new Date().toISOString() };
});

// ─── cc::publish_status — scan + publish to NATS ───

iii.registerFunction('cc::publish_status', async () => {
  const sessions = await scanSessions('/tmp');
  const poolPayload = buildPoolStatus(sessions);

  try {
    await publishFrame('agent.cc.pool.status', poolPayload);
  } catch {
    // NATS unreachable — not fatal for a read-only adapter
  }

  // Per-session publishes (best-effort)
  for (const s of sessions) {
    const perSession = buildSessionStatus(s);
    if (!perSession) continue;
    try {
      await publishFrame(perSession.subject, perSession.payload);
    } catch {
      // best-effort
    }
  }

  return poolPayload;
});

// ─── Phase 3b control functions — delegate to host bridge ───

iii.registerFunction('cc::monitor', async (data = {}) => {
  return callHostBridge({ action: 'monitor', session_id: data.session_id ?? '' });
});

iii.registerFunction('cc::intervene', async (data = {}) => {
  return callHostBridge({
    action: 'intervene',
    session_id: data.session_id ?? '',
    message: data.message ?? '',
    reason: data.reason ?? '',
    monitor_snapshot_id: data.monitor_snapshot_id ?? null,
  });
});

iii.registerFunction('cc::interrupt', async (data = {}) => {
  return callHostBridge({
    action: 'interrupt',
    session_id: data.session_id ?? '',
    confirm: data.confirm === true,
    reason: data.reason ?? '',
  });
});

iii.registerFunction('cc::execute', async (data = {}) => {
  return callHostBridge({
    action: 'execute',
    target: data.target ?? 'agent-hub',
    task: data.task ?? '',
    context_path: data.context_path ?? '',
    session_id: data.session_id ?? null,
    topic: data.topic ?? null,
    mode: data.mode ?? 'discuss-first',
    timeout_ms: data.timeout_ms,
    effort: data.effort ?? 'high',
    model: data.model ?? 'claude-opus-4-8',
    ack_active: data.ack_active === true,
  });
});

// keepalive
setInterval(() => {}, 60_000);

console.info('cc-worker ready', { engineWsUrl: ENGINE_URL });
