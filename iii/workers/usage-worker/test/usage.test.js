// Phase 1 usage-worker — 纯逻辑单测 (node:test, 零依赖)
// 严格 TDD: 本文件先于实现存在, 预期 RED.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseUsage,
  resolveThreshold,
  evaluateThreshold,
  buildAlertPayload,
  emptyState,
  recordUsage,
  recordAlert,
} from '../src/usage.js';

// ---- A2: parseUsage ----

const sampleJson = {
  daily: [
    { date: '2026-06-24', totalTokens: 1000 },
    { date: '2026-06-25', totalTokens: 1368 },
  ],
};

test('parseUsage 取最新 daily 的 totalTokens 与 date', () => {
  const u = parseUsage(sampleJson, { CC_MAX_TOKENS: '2000' });
  assert.equal(u.used, 1368);
  assert.equal(u.period, '2026-06-25');
  assert.equal(u.source, 'ccusage.claude.daily');
  assert.equal(u.limit, 2000);
  assert.equal(u.remaining, 632);
  assert.equal(u.warning, undefined);
});

test('parseUsage 在 CC_MAX_TOKENS 未设置时 limit/remaining 为 null 且带 warning', () => {
  const u = parseUsage(sampleJson, {});
  assert.equal(u.used, 1368);
  assert.equal(u.limit, null);
  assert.equal(u.remaining, null);
  assert.match(u.warning, /CC_MAX_TOKENS not set/);
});

test('parseUsage 对空 daily 但有 totals 时降级为 totals，并强制禁用阈值告警', () => {
  const u = parseUsage({ daily: [], totals: { totalTokens: 500000 } }, { CC_MAX_TOKENS: '2000' });
  assert.equal(u.used, 500000);
  assert.equal(u.period, null);
  assert.equal(u.source, 'ccusage.claude.totals');
  assert.equal(u.limit, null);
  assert.equal(u.remaining, null);
  assert.match(u.warning, /no daily entries/);
  assert.match(u.warning, /threshold alert disabled/);
});

test('parseUsage 对无 daily 且无 totals 抛错', () => {
  assert.throws(() => parseUsage({}, {}), /daily|totals/);
});

// ---- 阈值解析 ----

test('resolveThreshold 默认 0.8', () => {
  assert.equal(resolveThreshold({}), 0.8);
});

test('resolveThreshold 读取 USAGE_ALERT_THRESHOLD', () => {
  assert.equal(resolveThreshold({ USAGE_ALERT_THRESHOLD: '0.5' }), 0.5);
});

// ---- A4 前置: 阈值判定 ----

const overUsage = { used: 1800, limit: 2000, remaining: 200, source: 'ccusage.claude.daily', period: '2026-06-25' };
const underUsage = { used: 1000, limit: 2000, remaining: 1000, source: 'ccusage.claude.daily', period: '2026-06-25' };
const noLimitUsage = { used: 1800, limit: null, remaining: null, source: 'ccusage.claude.daily', period: '2026-06-25' };

test('evaluateThreshold 超阈值 → shouldAlert true', () => {
  const r = evaluateThreshold(overUsage, { threshold: 0.8, lastAlertTs: null, now: 1_000_000 });
  assert.equal(r.shouldAlert, true);
  assert.equal(r.severity, 'warning');
});

test('evaluateThreshold 未超阈值 → false', () => {
  const r = evaluateThreshold(underUsage, { threshold: 0.8, lastAlertTs: null, now: 1_000_000 });
  assert.equal(r.shouldAlert, false);
});

test('evaluateThreshold limit=null → 禁用告警', () => {
  const r = evaluateThreshold(noLimitUsage, { threshold: 0.8, lastAlertTs: null, now: 1_000_000 });
  assert.equal(r.shouldAlert, false);
});

test('evaluateThreshold 10min 去抖: 距上次告警 <10min → false', () => {
  const now = 1_000_000;
  const r = evaluateThreshold(overUsage, { threshold: 0.8, lastAlertTs: now - 5 * 60_000, now });
  assert.equal(r.shouldAlert, false);
});

test('evaluateThreshold 10min 去抖: 距上次告警 >10min → true', () => {
  const now = 1_000_000;
  const r = evaluateThreshold(overUsage, { threshold: 0.8, lastAlertTs: now - 11 * 60_000, now });
  assert.equal(r.shouldAlert, true);
});

// ---- A4: alert payload schema ----

test('buildAlertPayload 字段严格匹配 schema', () => {
  const p = buildAlertPayload(overUsage, { threshold: 0.8, ts: '2026-06-25T08:00:00Z', agent: 'cc' });
  assert.deepEqual(Object.keys(p).sort(), [
    'agent', 'kind', 'limit', 'period', 'remaining', 'severity', 'source', 'threshold', 'ts', 'used',
  ]);
  assert.equal(p.kind, 'usage.threshold');
  assert.equal(p.source, 'usage-worker');
  assert.equal(p.agent, 'cc');
  assert.equal(p.used, 1800);
  assert.equal(p.limit, 2000);
  assert.equal(p.remaining, 200);
  assert.equal(p.threshold, 0.8);
  assert.equal(p.period, '2026-06-25');
  assert.equal(p.ts, '2026-06-25T08:00:00Z');
  assert.equal(p.severity, 'warning');
});

// ---- A3: state 读写与时间戳递增 ----

test('emptyState 返回骨架', () => {
  const s = emptyState();
  assert.deepEqual(s, { current: null, history: [], alerts: [] });
});

test('recordUsage 设 current 并追加 history (带 collected_at)', () => {
  let s = emptyState();
  s = recordUsage(s, overUsage, '2026-06-25T08:00:00Z');
  assert.equal(s.current.used, 1800);
  assert.equal(s.current.collected_at, '2026-06-25T08:00:00Z');
  assert.equal(s.history.length, 1);
  assert.equal(s.history[0].ts, '2026-06-25T08:00:00Z');
});

test('recordUsage 连续两次 → history 递增, 时间戳更新 (A3)', () => {
  let s = emptyState();
  s = recordUsage(s, overUsage, '2026-06-25T08:00:00Z');
  s = recordUsage(s, underUsage, '2026-06-25T08:01:00Z');
  assert.equal(s.history.length, 2);
  assert.equal(s.current.collected_at, '2026-06-25T08:01:00Z');
  assert.notEqual(s.history[0].ts, s.history[1].ts);
});

test('recordUsage 默认只保留最近 1440 条 history，避免 state 无界增长', () => {
  let s = emptyState();
  for (let i = 0; i < 1500; i += 1) {
    s = recordUsage(s, { ...overUsage, used: i }, `2026-06-25T08:${String(i).padStart(4, '0')}:00Z`);
  }
  assert.equal(s.history.length, 1440);
  assert.equal(s.history[0].used, 60);
  assert.equal(s.history.at(-1).used, 1499);
});

test('recordAlert 追加 alerts', () => {
  let s = emptyState();
  s = recordAlert(s, { ts: '2026-06-25T08:00:00Z', threshold: 0.8, used: 1800, limit: 2000, remaining: 200, severity: 'warning' });
  assert.equal(s.alerts.length, 1);
  assert.equal(s.alerts[0].severity, 'warning');
});

test('recordAlert 默认只保留最近 100 条 alerts', () => {
  let s = emptyState();
  for (let i = 0; i < 150; i += 1) {
    s = recordAlert(s, { ts: `2026-06-25T08:${String(i).padStart(4, '0')}:00Z`, threshold: 0.8, used: i, limit: 10, remaining: 10 - i, severity: 'warning' });
  }
  assert.equal(s.alerts.length, 100);
  assert.equal(s.alerts[0].used, 50);
  assert.equal(s.alerts.at(-1).used, 149);
});

// recordUsage/recordAlert 必须不可变 (不改入参)
test('recordUsage 不可变', () => {
  const s0 = emptyState();
  const s1 = recordUsage(s0, overUsage, '2026-06-25T08:00:00Z');
  assert.equal(s0.history.length, 0);
  assert.notEqual(s0, s1);
});
