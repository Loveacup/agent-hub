// Phase 1 usage-worker — 编排层单测 (依赖注入, 不触真实 npx/nats/fs)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCheck, buildNatsPublishFrame, defaultExec } from '../src/collect.js';

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

test('defaultExec 返回 Promise，避免 execFileSync 阻塞事件循环', () => {
  const result = defaultExec({ execFileImpl: (_cmd, _args, _opts, cb) => cb(null, '{"daily":[{"date":"2026-06-25","totalTokens":1}]}', '') });
  assert.equal(typeof result.then, 'function');
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
