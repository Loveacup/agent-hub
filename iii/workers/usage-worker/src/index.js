// Phase 1 usage-worker — iii 适配层
// 把 runCheck 注册成 usage::check, 并每分钟自动采集 (A1/A3)。
// 纯逻辑/编排在 usage.js / collect.js, 本文件只做 iii 接线。
import { registerWorker } from 'iii-sdk';
import { runCheck } from './collect.js';

const engineWsUrl = process.env.III_URL ?? 'ws://localhost:49134';
const COLLECT_INTERVAL_MS = Number(process.env.USAGE_COLLECT_INTERVAL_MS) || 60_000;

const iii = registerWorker(engineWsUrl, { workerName: 'usage-worker' });

// A1/A2: 按需查当前用量。data 为 `--json` payload。
// 支持 `ccusageJson` / `envOverrides` 注入，便于 iii VM 隔离环境下做 deterministic 集成测试。
iii.registerFunction('usage::check', async (data = {}) => {
  return await runCheck({
    ccusageJson: data.ccusageJson ?? null,
    envOverrides: data.envOverrides ?? data.env ?? {},
  });
});

// A3: 每分钟自动采集, 超阈值时由 runCheck 内部 pub agent.usage.alert (A4)。
const timer = setInterval(() => {
  runCheck().catch((err) => console.error('usage-worker periodic check failed', err));
}, COLLECT_INTERVAL_MS);
if (typeof timer.unref === 'function') timer.unref();

console.info('usage-worker ready', { engineWsUrl, collectIntervalMs: COLLECT_INTERVAL_MS });
