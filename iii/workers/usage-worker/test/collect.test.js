// Phase 1 usage-worker — 编排层单测 (依赖注入, 不触真实 npx/nats/fs)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { runCheck, buildNatsPublishFrame, defaultExec, resolveDefaultStatePath, resolveCcusageTimeoutMs, DEFAULT_CCUSAGE_TIMEOUT_MS } from '../src/collect.js';

// 假 child：EventEmitter + PassThrough stdout/stderr，永不触真实 npx。
function fakeChild(pid = 4242) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killedWith = null;
  child.kill = (sig) => { child.killedWith = sig; return true; };
  return child;
}

// 让注入的 stdout/stderr 'data' 事件先于 close 被处理（PassThrough 异步派发）。
const flush = () => new Promise((r) => setImmediate(r));

const ccusageOut = {
  daily: [
    { date: '2026-06-24', totalTokens: 1000 },
    { date: '2026-06-25', totalTokens: 1800 },
  ],
};

function harness(overrides = {}) {
  const published = [];
  let saved = null;
  const deps = {
    execFn: () => ccusageOut,
    publishFn: (subject, payload) => published.push({ subject, payload }),
    readState: () => ({ current: null, history: [], alerts: [] }),
    writeState: (s) => { saved = s; },
    env: { CC_MAX_TOKENS: '2000' },
    now: 2_000_000,
    nowIso: '2026-06-25T08:00:00Z',
    ...overrides,
  };
  return { deps, published, getSaved: () => saved };
}

test('runCheck 返回当前用量 (A2 字段)', async () => {
  const { deps } = harness();
  const r = await runCheck(deps);
  assert.equal(r.used, 1800);
  assert.equal(r.limit, 2000);
  assert.equal(r.remaining, 200);
  assert.equal(r.source, 'ccusage.claude.daily');
  assert.equal(r.period, '2026-06-25');
});

test('runCheck 超阈值 → publish agent.usage.alert 且写 state (A4/A3)', async () => {
  const { deps, published, getSaved } = harness();
  const r = await runCheck(deps);
  assert.equal(r.alerted, true);
  assert.equal(published.length, 1);
  assert.equal(published[0].subject, 'agent.usage.alert');
  assert.equal(published[0].payload.kind, 'usage.threshold');
  assert.equal(published[0].payload.used, 1800);
  const s = getSaved();
  assert.equal(s.history.length, 1);
  assert.equal(s.current.collected_at, '2026-06-25T08:00:00Z');
  assert.equal(s.alerts.length, 1);
});

test('runCheck 未超阈值 → 不 publish, 仍写 state', async () => {
  const { deps, published, getSaved } = harness({ env: { CC_MAX_TOKENS: '100000' } });
  const r = await runCheck(deps);
  assert.equal(r.alerted, false);
  assert.equal(published.length, 0);
  assert.equal(getSaved().history.length, 1);
  assert.equal(getSaved().alerts.length, 0);
});

test('runCheck limit 未设置 → 不 publish, 返回 warning', async () => {
  const { deps, published } = harness({ env: {} });
  const r = await runCheck(deps);
  assert.equal(r.alerted, false);
  assert.equal(published.length, 0);
  assert.match(r.warning, /CC_MAX_TOKENS not set/);
});

test('runCheck 支持注入 ccusageJson/env payload（iii trigger 集成测试用）', async () => {
  const { deps, published } = harness({
    ccusageJson: { daily: [{ date: '2026-06-25', totalTokens: 1800 }] },
    envOverrides: { CC_MAX_TOKENS: '1000' },
  });
  const r = await runCheck(deps);
  assert.equal(r.used, 1800);
  assert.equal(r.limit, 1000);
  assert.equal(r.alerted, true);
  assert.equal(published.length, 1);
});

test('resolveDefaultStatePath 在 iii VM 内优先写回 host-mounted /mnt/host-src/state', () => {
  const path = resolveDefaultStatePath({
    env: { III_ISOLATION: 'libkrun' },
    existsFn: (p) => p === '/mnt/host-src',
    repoStatePath: '/workspace/../state/usage-worker.json',
  });
  assert.equal(path, '/mnt/host-src/state/usage-worker.json');
});

test('resolveDefaultStatePath 在 host 端回退 repo state 路径', () => {
  const path = resolveDefaultStatePath({
    env: {},
    existsFn: () => false,
    repoStatePath: '/repo/state/usage-worker.json',
  });
  assert.equal(path, '/repo/state/usage-worker.json');
});

test('defaultExec 返回 Promise，避免同步 child process 阻塞事件循环', () => {
  const child = fakeChild();
  const result = defaultExec({ spawnImpl: () => child, killImpl: () => {}, timeoutMs: 10_000 });
  assert.equal(typeof result.then, 'function');
  // 收尾，避免悬挂 timer/promise
  child.stdout.end('{"daily":[{"date":"2026-06-25","totalTokens":1}]}');
  return flush().then(() => { child.emit('close', 0, null); return result; });
});

test('defaultExec 用 spawn 调用 npx ccusage claude --json，POSIX 下 detached（整组可 kill）', async () => {
  let cmd, args, opts;
  const child = fakeChild();
  const p = defaultExec({
    spawnImpl: (c, a, o) => { cmd = c; args = a; opts = o; return child; },
    killImpl: () => {},
    timeoutMs: 10_000,
  });
  child.stdout.end('{"daily":[{"date":"2026-06-25","totalTokens":1}]}');
  await flush();
  child.emit('close', 0, null);
  await p;
  assert.equal(cmd, 'npx');
  assert.deepEqual(args, ['ccusage', 'claude', '--json']);
  assert.equal(opts.detached, process.platform !== 'win32');
  assert.deepEqual(opts.stdio, ['ignore', 'pipe', 'pipe']);
});

test('defaultExec 成功(code 0) → JSON.parse(stdout) 后 resolve', async () => {
  const child = fakeChild();
  const p = defaultExec({ spawnImpl: () => child, killImpl: () => {}, timeoutMs: 10_000 });
  child.stdout.end('{"daily":[{"date":"2026-06-25","totalTokens":42}]}');
  await flush();
  child.emit('close', 0, null);
  const out = await p;
  assert.equal(out.daily[0].totalTokens, 42);
});

test('defaultExec 超时 → kill 整个进程组(-pid, SIGKILL) 且 reject CCUSAGE_TIMEOUT', async () => {
  let killArgs = null;
  const child = fakeChild(777);
  const p = defaultExec({
    spawnImpl: () => child,
    killImpl: (pid, sig) => { killArgs = [pid, sig]; },
    timeoutMs: 5,
  });
  await assert.rejects(p, (err) => {
    assert.equal(err.code, 'CCUSAGE_TIMEOUT');
    assert.match(err.message, /ccusage timed out/);
    return true;
  });
  if (process.platform !== 'win32') {
    // 关键 P1 断言：负 pid → 杀进程组，连带 node/ccusage 孙进程，不留孤儿。
    assert.deepEqual(killArgs, [-777, 'SIGKILL']);
  } else {
    assert.equal(child.killedWith, 'SIGKILL');
  }
});

test('defaultExec 非零退出 → reject CCUSAGE_EXIT_NONZERO 且截断 stderr 预览', async () => {
  const child = fakeChild();
  const huge = 'x'.repeat(50_000);
  const p = defaultExec({ spawnImpl: () => child, killImpl: () => {}, timeoutMs: 10_000 });
  child.stderr.end(huge);
  await flush();
  child.emit('close', 2, null);
  await assert.rejects(p, (err) => {
    assert.equal(err.code, 'CCUSAGE_EXIT_NONZERO');
    assert.equal(err.exitCode, 2);
    assert.ok(err.message.length < huge.length, 'stderr 预览应被截断');
    return true;
  });
});

test('defaultExec stdout 超 maxBuffer → kill 进程组并 reject CCUSAGE_MAX_BUFFER', async () => {
  let killArgs = null;
  const child = fakeChild(999);
  const p = defaultExec({
    spawnImpl: () => child,
    killImpl: (pid, sig) => { killArgs = [pid, sig]; },
    timeoutMs: 10_000,
    maxBuffer: 10,
  });
  child.stdout.write('this chunk is definitely longer than ten bytes');
  await assert.rejects(p, (err) => {
    assert.equal(err.code, 'CCUSAGE_MAX_BUFFER');
    return true;
  });
  if (process.platform !== 'win32') {
    assert.deepEqual(killArgs, [-999, 'SIGKILL']);
  } else {
    assert.equal(child.killedWith, 'SIGKILL');
  }
});

test('defaultExec stderr 超 maxBuffer → kill 进程组并 reject CCUSAGE_MAX_BUFFER', async () => {
  let killArgs = null;
  const child = fakeChild(888);
  const p = defaultExec({
    spawnImpl: () => child,
    killImpl: (pid, sig) => { killArgs = [pid, sig]; },
    timeoutMs: 10_000,
    maxBuffer: 10,
  });
  child.stderr.write('this stderr chunk is definitely longer than ten bytes');
  await assert.rejects(p, (err) => {
    assert.equal(err.code, 'CCUSAGE_MAX_BUFFER');
    return true;
  });
  if (process.platform !== 'win32') {
    assert.deepEqual(killArgs, [-888, 'SIGKILL']);
  } else {
    assert.equal(child.killedWith, 'SIGKILL');
  }
});

test('defaultExec stderr 先写后 stdout 写、合计超 maxBuffer → 共享预算仍 kill 并 reject CCUSAGE_MAX_BUFFER', async () => {
  // 回归：stderr 先写 6B（单独看不超 10），stdout 后写 6B；若 stdout 仅判 stdoutBytes>maxBuffer
  // 会按到达顺序绕过共享预算（Codex BLOCKER）。stdout 必须按 stdoutBytes+stderrBytes 判定。
  let killArgs = null;
  const child = fakeChild(7777);
  const p = defaultExec({
    spawnImpl: () => child,
    killImpl: (pid, sig) => { killArgs = [pid, sig]; },
    timeoutMs: 10_000,
    maxBuffer: 10,
  });
  child.stderr.write('aaaaaa'); // 6B：stderrBytes=6，不超 10
  await flush();
  child.stdout.write('bbbbbb'); // 6B：stdoutBytes+stderrBytes=12 > 10 → kill
  await assert.rejects(p, (err) => {
    assert.equal(err.code, 'CCUSAGE_MAX_BUFFER');
    return true;
  });
  if (process.platform !== 'win32') {
    assert.deepEqual(killArgs, [-7777, 'SIGKILL']);
  } else {
    assert.equal(child.killedWith, 'SIGKILL');
  }
});

test('defaultExec stderr 远超预览上限也不会无界增长（巨量 stderr 内存有界）', async () => {
  // 关键回归断言：stderr 即便累计 1MB，进程内只保留 STDERR_PREVIEW_LIMIT 字符的预览。
  const child = fakeChild();
  // maxBuffer 给足，确保走的是「按 chunk 截断累积」而非「超 maxBuffer 直接 kill」分支。
  const p = defaultExec({ spawnImpl: () => child, killImpl: () => {}, timeoutMs: 10_000, maxBuffer: 64 * 1024 * 1024 });
  for (let i = 0; i < 1000; i++) child.stderr.write('y'.repeat(1024));
  await flush();
  child.emit('close', 3, null);
  await assert.rejects(p, (err) => {
    assert.equal(err.code, 'CCUSAGE_EXIT_NONZERO');
    assert.equal(err.exitCode, 3);
    // 1000*1024 ≈ 1MB stderr，但错误 message 仍被预览上限钳住，证明 stderr 未无界保留。
    assert.ok(err.message.length < 5_000, `error message 应有界，实际=${err.message.length}`);
    return true;
  });
});

test('defaultExec spawn error 原样 reject（如 npx 不存在）', async () => {
  const child = fakeChild();
  const p = defaultExec({ spawnImpl: () => child, killImpl: () => {}, timeoutMs: 10_000 });
  child.emit('error', Object.assign(new Error('spawn npx ENOENT'), { code: 'ENOENT' }));
  await assert.rejects(p, /ENOENT/);
});

test('resolveCcusageTimeoutMs: 合法值生效，非法值安全回退默认', () => {
  assert.equal(resolveCcusageTimeoutMs('1234'), 1234);
  assert.equal(resolveCcusageTimeoutMs(5000), 5000);
  assert.equal(resolveCcusageTimeoutMs(undefined), DEFAULT_CCUSAGE_TIMEOUT_MS);
  assert.equal(resolveCcusageTimeoutMs(''), DEFAULT_CCUSAGE_TIMEOUT_MS);
  assert.equal(resolveCcusageTimeoutMs('not-a-number'), DEFAULT_CCUSAGE_TIMEOUT_MS);
  assert.equal(resolveCcusageTimeoutMs('0'), DEFAULT_CCUSAGE_TIMEOUT_MS);
  assert.equal(resolveCcusageTimeoutMs('-5'), DEFAULT_CCUSAGE_TIMEOUT_MS);
});

test('buildNatsPublishFrame 生成 NATS PUB 协议帧', () => {
  const payload = { kind: 'usage.threshold', used: 1800 };
  const body = JSON.stringify(payload);
  const frame = buildNatsPublishFrame('agent.usage.alert', payload);
  assert.equal(frame, `PUB agent.usage.alert ${Buffer.byteLength(body)}\r\n${body}\r\n`);
});

test('runCheck 去抖: 上次告警 <10min → 不重复 publish', async () => {
  const { deps, published } = harness({
    readState: () => ({
      current: null,
      history: [],
      alerts: [{ ts: '2026-06-25T07:55:00Z', threshold: 0.8, used: 1700, limit: 2000, remaining: 300, severity: 'warning' }],
    }),
  });
  const r = await runCheck(deps);
  assert.equal(r.alerted, false);
  assert.equal(published.length, 0);
});
