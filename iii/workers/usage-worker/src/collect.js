// Phase 1 usage-worker — 编排 + 副作用薄壳
// 纯逻辑全部委托 usage.js; 本文件只负责: 跑 ccusage / nats pub / 读写 state 文件。
// runCheck 接收注入的 deps (默认真实实现), 便于单测替身。
import { execFile } from 'node:child_process';
import { connect } from 'node:net';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseUsage,
  resolveThreshold,
  evaluateThreshold,
  buildAlertPayload,
  emptyState,
  recordUsage,
  recordAlert,
} from './usage.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// 默认 repo-root/state/usage-worker.json; 可用 USAGE_STATE_PATH 覆盖 (VM 内运行时有用)。
export const STATE_PATH = process.env.USAGE_STATE_PATH
  || resolve(__dirname, '../../../../state/usage-worker.json');
const NATS_SUBJECT = 'agent.usage.alert';
// iii VM 内访问宿主通常走 100.96.0.1；宿主直接运行时可用 NATS_URL 覆盖为 127.0.0.1。
const NATS_SERVER = process.env.NATS_URL || 'nats://100.96.0.1:4222';

export function buildNatsPublishFrame(subject, payload) {
  const body = JSON.stringify(payload);
  return `PUB ${subject} ${Buffer.byteLength(body)}\r\n${body}\r\n`;
}

function parseNatsUrl(url = NATS_SERVER) {
  const u = new URL(url);
  return { host: u.hostname, port: Number(u.port || 4222) };
}

// ---- 默认真实副作用实现 ----

// A2/A7: 用量来自 `npx ccusage claude --json`, 不直接解析表格文本。
// 必须异步，避免 iii worker event loop 被同步 child process 阻塞。
export function defaultExec({ execFileImpl = execFile } = {}) {
  return new Promise((resolve, reject) => {
    execFileImpl('npx', ['ccusage', 'claude', '--json'], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    }, (err, stdout) => {
      if (err) return reject(err);
      try {
        return resolve(JSON.parse(stdout));
      } catch (parseErr) {
        return reject(parseErr);
      }
    });
  });
}

// A4: 发布 NATS agent.usage.alert（零依赖 TCP NATS protocol，不依赖 VM 内 nats CLI）。
export function defaultPublish(subject, payload) {
  const { host, port } = parseNatsUrl(process.env.NATS_URL || NATS_SERVER);
  const frame = buildNatsPublishFrame(subject, payload);

  return new Promise((resolvePromise, reject) => {
    const socket = connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`NATS publish timeout ${host}:${port}`));
    }, 5000);

    socket.on('connect', () => {
      socket.write(frame, () => {
        clearTimeout(timer);
        socket.destroy();
        resolvePromise();
      });
    });
    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    socket.on('close', () => {
      clearTimeout(timer);
      resolvePromise();
    });
  });
}

export function defaultReadState(path = STATE_PATH) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return emptyState();
    throw err;
  }
}

export function defaultWriteState(state, path = STATE_PATH) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2) + '\n');
}

function lastAlertMs(state) {
  const alerts = state.alerts || [];
  if (alerts.length === 0) return null;
  const ts = alerts[alerts.length - 1].ts;
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? null : ms;
}

// 一次完整 check 周期。deps 全部可注入, 默认走真实实现。
export async function runCheck({
  execFn = defaultExec,
  publishFn = defaultPublish,
  readState = defaultReadState,
  writeState = defaultWriteState,
  env = process.env,
  envOverrides = {},
  ccusageJson = null,
  now = Date.now(),
  nowIso = new Date().toISOString(),
} = {}) {
  const effectiveEnv = { ...env, ...envOverrides };
  const resolvedCcusageJson = ccusageJson ?? await execFn();
  const usage = parseUsage(resolvedCcusageJson, effectiveEnv);
  const threshold = resolveThreshold(effectiveEnv);

  let state = readState();
  const decision = evaluateThreshold(usage, {
    threshold,
    lastAlertTs: lastAlertMs(state),
    now,
  });

  state = recordUsage(state, usage, nowIso);

  let alerted = false;
  if (decision.shouldAlert) {
    const payload = buildAlertPayload(usage, { threshold, ts: nowIso, agent: effectiveEnv.USAGE_AGENT || 'cc', severity: decision.severity });
    await publishFn(NATS_SUBJECT, payload);
    state = recordAlert(state, {
      ts: nowIso,
      threshold,
      used: usage.used,
      limit: usage.limit,
      remaining: usage.remaining,
      severity: decision.severity,
    });
    alerted = true;
  }

  writeState(state);

  return { ...usage, threshold, alerted };
}
