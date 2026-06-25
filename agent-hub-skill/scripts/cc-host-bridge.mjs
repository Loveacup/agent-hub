#!/usr/bin/env node
// agent-hub Phase 3b — cc-host-bridge
// Host-side JSON bridge from iii VM cc-worker to cc-tmux scripts.
import http from 'node:http';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import {
  validateBridgeRequest,
  buildBridgeResponse,
  buildMonitorRequiredRefusal,
  buildInterruptRefusal,
  buildInterventionContextPath,
} from '../../iii/workers/cc-worker/src/hostBridge.js';
import { executeFlow } from '../../iii/workers/cc-worker/src/executeFlow.js';

const PORT = Number(process.env.CC_HOST_BRIDGE_PORT || 8767);
const HOST = process.env.CC_HOST_BRIDGE_HOST || '0.0.0.0';
function readTokenFile() {
  const path = process.env.CC_HOST_BRIDGE_TOKEN_FILE || `${process.env.HOME || '/Users/alexcai'}/.agent-hub/cc-host-bridge.token`;
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return '';
  }
}

const TOKEN = process.env.CC_HOST_BRIDGE_TOKEN || readTokenFile();
if (!TOKEN && process.env.CC_HOST_BRIDGE_ALLOW_NO_TOKEN !== '1') {
  console.error('CC_HOST_BRIDGE_TOKEN required (set CC_HOST_BRIDGE_ALLOW_NO_TOKEN=1 only for local smoke tests)');
  process.exit(1);
}
const CC_TMUX_SCRIPTS = process.env.CC_TMUX_SCRIPTS || '/Users/alexcai/.hermes/skills/autonomous-ai-agents/cc-tmux/scripts';

function run(script, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(script, args, {
      timeout: opts.timeout ?? 30_000,
      maxBuffer: opts.maxBuffer ?? 2 * 1024 * 1024,
      env: { ...process.env, HOME: process.env.HOME || '/Users/alexcai' },
    }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        exit_code: err?.code ?? 0,
        stdout: stdout ?? '',
        stderr: stderr ?? '',
        error: err?.message ?? null,
      });
    });
  });
}

function inferState(relay) {
  if (/BLOCKED|permission|AskUserQuestion/i.test(relay)) return 'BLOCKED';
  if (/COMPLETED|turn-done|✅/i.test(relay)) return 'COMPLETED';
  if (/TOOL|⏺|●/i.test(relay)) return 'TOOL';
  if (/THINKING|✻|✽|✶|✢|✳/i.test(relay)) return 'THINKING';
  if (/IDLE|❯/i.test(relay)) return 'IDLE';
  return 'UNKNOWN';
}

async function monitor(session_id) {
  const script = join(CC_TMUX_SCRIPTS, 'cc-monitor.sh');
  const result = await run(script, ['--session', session_id], { timeout: 20_000 });
  const relay = result.stdout || result.stderr || '';
  return buildBridgeResponse('cc.monitor', {
    session_id,
    status: result.ok ? 'ok' : 'observer_error',
    state: inferState(relay),
    relay,
    source: result.ok ? 'cc-monitor' : 'cc-monitor-error',
    observer_error: result.ok ? null : (result.stderr || result.error || 'cc-monitor failed'),
    monitor_snapshot_id: `cc-monitor-${Date.now()}`,
  });
}

async function sendContext(session_id, context_path) {
  const script = join(CC_TMUX_SCRIPTS, 'cc-send.sh');
  return run(script, ['--session', session_id, '--context', context_path], { timeout: 60_000 });
}

async function intervene(req) {
  let before = null;
  if (!req.monitor_snapshot_id) {
    before = await monitor(req.session_id);
    if (before.status !== 'ok') {
      return buildBridgeResponse('cc.intervention', {
        session_id: req.session_id,
        status: 'refused',
        error: 'monitor_failed',
        monitor: before,
      });
    }
  }

  const contextPath = buildInterventionContextPath({ session_id: req.session_id });
  await writeFile(contextPath, `${req.message || ''}\n\nReason: ${req.reason || 'not specified'}\n`, 'utf8');
  const sent = await sendContext(req.session_id, contextPath);
  const after = await monitor(req.session_id);
  return buildBridgeResponse('cc.intervention', {
    session_id: req.session_id,
    status: sent.ok ? 'sent' : 'send_failed',
    send_exit_code: sent.exit_code,
    stderr: sent.stderr,
    context_path: contextPath,
    monitor_before: before,
    monitor_after: after,
  });
}

async function execute(req) {
  return executeFlow(req, { runFn: run, scriptsDir: CC_TMUX_SCRIPTS });
}

async function interrupt(req) {
  const refusal = buildInterruptRefusal(req);
  if (refusal.status !== 'allowed') return refusal;
  const result = await run('tmux', ['send-keys', '-t', req.session_id, 'C-c'], { timeout: 10_000 });
  return buildBridgeResponse('cc.interrupt', {
    session_id: req.session_id,
    status: result.ok ? 'sent' : 'failed',
    reason: req.reason,
    stderr: result.stderr,
  });
}

async function handle(req) {
  validateBridgeRequest(req);
  if (req.action === 'monitor') return monitor(req.session_id);
  if (req.action === 'intervene') {
    if (!req.monitor_snapshot_id && req.require_existing_monitor === true) {
      return buildMonitorRequiredRefusal({ session_id: req.session_id });
    }
    return intervene(req);
  }
  if (req.action === 'execute') return execute(req);
  if (req.action === 'interrupt') return interrupt(req);
  throw new Error('action_not_allowed');
}

const server = http.createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/healthz') {
    if (TOKEN && request.headers['x-agent-hub-token'] !== TOKEN) {
      response.writeHead(401).end('unauthorized');
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      kind: 'cc.bridge.health',
      status: 'ok',
      token_required: Boolean(TOKEN),
      scripts_dir: CC_TMUX_SCRIPTS,
      ts: new Date().toISOString(),
    }));
    return;
  }
  if (request.method !== 'POST' || request.url !== '/control') {
    response.writeHead(404).end('not found');
    return;
  }
  if (TOKEN && request.headers['x-agent-hub-token'] !== TOKEN) {
    response.writeHead(401).end('unauthorized');
    return;
  }
  let raw = '';
  request.on('data', (chunk) => { raw += chunk; });
  request.on('end', async () => {
    try {
      const payload = raw ? JSON.parse(raw) : {};
      const result = await handle(payload);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(result));
    } catch (err) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ kind: 'cc.bridge', status: 'error', error: err?.message ?? String(err) }));
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`cc-host-bridge listening on ${HOST}:${PORT}`);
});
