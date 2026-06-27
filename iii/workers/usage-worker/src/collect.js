// Phase 1 usage-worker — 编排 + 副作用薄壳
// 纯逻辑全部委托 usage.js; 本文件只负责: 跑 ccusage / nats pub / 读写 state 文件。
// runCheck 接收注入的 deps (默认真实实现), 便于单测替身。
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
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
// 默认 repo-root/state/usage-worker.json；iii VM 内优先写回 host mount，便于 Hermes/host 侧验证与审计。
const REPO_STATE_PATH = resolve(__dirname, '../../../../state/usage-worker.json');
export function resolveDefaultStatePath({ env = process.env, existsFn = existsSync, repoStatePath = REPO_STATE_PATH } = {}) {
  if (env.III_ISOLATION && existsFn('/mnt/host-src')) {
    return '/mnt/host-src/state/usage-worker.json';
  }
  return repoStatePath;
}
export const STATE_PATH = process.env.USAGE_STATE_PATH || resolveDefaultStatePath();
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

// ccusage 采集硬超时。无界等待会让挂死的 npx/ccusage 子进程长期占用 CPU/swap（live incident 根因）。
export const DEFAULT_CCUSAGE_TIMEOUT_MS = 30_000;
// 非零退出时 stderr 预览上限：避免把挂死/报错的 ccusage 巨量 stderr 灌进日志/异常。
const STDERR_PREVIEW_LIMIT = 2_000;

// 把 USAGE_CCUSAGE_TIMEOUT_MS 解析成正整数毫秒；非法（NaN/0/负数/空）一律安全回退默认值。
export function resolveCcusageTimeoutMs(raw) {
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return n;
  return DEFAULT_CCUSAGE_TIMEOUT_MS;
}

// A2/A7: 用量来自 `npx ccusage claude --json`, 不直接解析表格文本。
// 必须异步，避免 iii worker event loop 被同步 child process 阻塞。
//
// 为什么用 spawn(detached) 而不是 execFile timeout（Codex P1）：
//   execFile 的 timeout 只 SIGKILL 直接子进程（npx）。npx 会再 fork 出 node/ccusage 孙进程；
//   杀掉 npx 后这些孙进程会脱离父进程成为孤儿，继续占用 CPU/swap（live incident：worker 停了
//   ccusage --json 子进程仍短暂发烫）。
//   detached:true 让 npx 成为新进程组组长（pgid == npx.pid），超时/超 buffer 时用
//   kill(-pid, SIGKILL) 对「整个进程组」下手，npx 及其 node/ccusage 子孙一起被收割，杜绝孤儿热循环。
export function defaultExec({
  spawnImpl = spawn,
  killImpl = process.kill,
  timeoutMs = resolveCcusageTimeoutMs(process.env.USAGE_CCUSAGE_TIMEOUT_MS),
  maxBuffer = 16 * 1024 * 1024,
} = {}) {
  return new Promise((resolvePromise, reject) => {
    const isPosix = process.platform !== 'win32';
    const child = spawnImpl('npx', ['ccusage', 'claude', '--json'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: isPosix,
    });

    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timer = null;

    // POSIX: kill(-pid) 杀的是「pgid==pid 的整个进程组」(detached 下 npx 即组长)，
    // 连带 node/ccusage 孙进程一并 SIGKILL。Windows 无进程组语义，退回 child.kill()。
    const killTree = (signal) => {
      try {
        if (isPosix && typeof child.pid === 'number') {
          killImpl(-child.pid, signal);
        } else if (typeof child.kill === 'function') {
          child.kill(signal);
        } else if (typeof child.pid === 'number') {
          killImpl(child.pid, signal);
        }
      } catch {
        // 进程组已退出 (ESRCH 等) 时忽略；目标本就是「确保它死」。
      }
    };

    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(arg);
    };

    timer = setTimeout(() => {
      killTree('SIGKILL');
      const err = new Error(`ccusage timed out after ${timeoutMs}ms and its process group was killed (SIGKILL)`);
      err.code = 'CCUSAGE_TIMEOUT';
      finish(reject, err);
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    child.on('error', (err) => finish(reject, err));

    if (child.stdout) {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        // 与 stderr 共享 maxBuffer 预算：必须用 stdout+stderr 总量判定，否则按到达顺序
        // (如 stderr 先写 6B、stdout 后写 6B、maxBuffer=10) 单独看 stdoutBytes 不超标会绕过
        // 总预算上限，泄漏内存（Codex 复核 BLOCKER）。
        stdoutBytes += Buffer.byteLength(chunk, 'utf8');
        if (stdoutBytes + stderrBytes > maxBuffer) {
          killTree('SIGKILL');
          const err = new Error(`ccusage stdout exceeded maxBuffer (${maxBuffer} bytes); process group killed`);
          err.code = 'CCUSAGE_MAX_BUFFER';
          return finish(reject, err);
        }
        stdout += chunk;
      });
    }
    if (child.stderr) {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        // stderr 与 stdout 共享 maxBuffer 预算：挂死/抓狂的 ccusage 可能只往 stderr 狂吐，
        // 若不计入预算就会绕过 maxBuffer 把内存灌爆（live incident 的 swap 压力面）。
        stderrBytes += Buffer.byteLength(chunk, 'utf8');
        if (stdoutBytes + stderrBytes > maxBuffer) {
          killTree('SIGKILL');
          const err = new Error(`ccusage stderr exceeded maxBuffer (${maxBuffer} bytes); process group killed`);
          err.code = 'CCUSAGE_MAX_BUFFER';
          return finish(reject, err);
        }
        // 只为错误预览保留前 STDERR_PREVIEW_LIMIT 字符，超出部分直接丢弃 → stderr 内存恒有界。
        if (stderr.length < STDERR_PREVIEW_LIMIT) {
          stderr += chunk.slice(0, STDERR_PREVIEW_LIMIT - stderr.length);
        }
      });
    }

    child.on('close', (code, signal) => {
      if (settled) return;
      if (code === 0) {
        try {
          return finish(resolvePromise, JSON.parse(stdout));
        } catch (parseErr) {
          return finish(reject, parseErr);
        }
      }
      // 非零退出：不把巨量 stderr 原样抛出，只截断预览，避免污染日志。
      const preview = stderr.slice(0, STDERR_PREVIEW_LIMIT);
      const err = new Error(
        `ccusage exited non-zero (code=${code}${signal ? `, signal=${signal}` : ''}): ${preview}`,
      );
      err.code = 'CCUSAGE_EXIT_NONZERO';
      err.exitCode = code;
      err.signal = signal;
      finish(reject, err);
    });
  });
}

// 周期采集 singleflight 守卫。若上一次 runCheck 仍在 flight，本次直接跳过并 warn，
// 避免慢/挂死的 ccusage 让周期 interval 不断叠加子进程（live incident 根因之一）。
// 纯逻辑 + 依赖注入，可脱离 iii engine / 真实计时器单测。
export function createPeriodicUsageCollector({ runCheckFn, logger = console } = {}) {
  let inFlight = false;
  return async function collectOnce() {
    if (inFlight) {
      logger.warn('usage-worker periodic check skipped: previous check still running');
      return { skipped: true };
    }
    inFlight = true;
    try {
      const result = await runCheckFn();
      return { skipped: false, result };
    } catch (err) {
      logger.error('usage-worker periodic check failed', err);
      return { skipped: false, error: err };
    } finally {
      inFlight = false;
    }
  };
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
