// Phase 1 usage-worker — 纯逻辑核心 (零依赖, 无副作用)
// 副作用 (exec npx ccusage / nats pub / 读写文件) 全部由 collect.js 注入。

const SOURCE = 'ccusage.claude.daily';
const ALERT_SOURCE = 'usage-worker';
const DEFAULT_THRESHOLD = 0.8;
const HISTORY_LIMIT = 1440;
const ALERT_LIMIT = 100;
export const DEBOUNCE_MS = 10 * 60_000; // 10 分钟去抖

// A2: 解析 `npx ccusage claude --json` 输出的最新一日用量。
// env.CC_MAX_TOKENS 缺失时 limit/remaining=null, 并带 warning (阈值告警禁用)。
export function parseUsage(ccusageJson, env = {}) {
  const daily = ccusageJson && ccusageJson.daily;
  let latest;
  let source = SOURCE;
  let fallbackWarning = null;
  let forceNoLimit = false;

  if (Array.isArray(daily) && daily.length > 0) {
    latest = daily[daily.length - 1];
  } else if (ccusageJson && ccusageJson.totals && typeof ccusageJson.totals.totalTokens === 'number') {
    latest = { date: null, totalTokens: ccusageJson.totals.totalTokens };
    source = 'ccusage.claude.totals';
    forceNoLimit = true;
    fallbackWarning = 'ccusage output has no daily entries; using totals fallback as informational only (likely running inside isolated iii VM without host logs); threshold alert disabled';
  } else {
    throw new Error('ccusage output has no `daily` entries and no `totals.totalTokens` fallback');
  }
  const used = latest.totalTokens;
  const period = latest.date;

  const rawLimit = env.CC_MAX_TOKENS;
  const limit = forceNoLimit || rawLimit === undefined || rawLimit === null || rawLimit === ''
    ? null
    : Number(rawLimit);

  const usage = {
    used,
    limit,
    remaining: limit === null ? null : limit - used,
    source,
    period,
  };
  if (fallbackWarning) {
    usage.warning = fallbackWarning;
  }
  if (forceNoLimit) {
    usage.warning = usage.warning
      ? `${usage.warning}; limit forced to null for totals fallback`
      : 'limit forced to null for totals fallback; threshold alert disabled';
  } else if (limit === null) {
    usage.warning = usage.warning
      ? `${usage.warning}; CC_MAX_TOKENS not set; threshold alert disabled`
      : 'CC_MAX_TOKENS not set; threshold alert disabled';
  }
  return usage;
}

// 阈值解析: 默认 0.8, 可被 USAGE_ALERT_THRESHOLD 覆盖。
export function resolveThreshold(env = {}) {
  const raw = env.USAGE_ALERT_THRESHOLD;
  if (raw === undefined || raw === null || raw === '') return DEFAULT_THRESHOLD;
  const n = Number(raw);
  return Number.isFinite(n) ? n : DEFAULT_THRESHOLD;
}

// 是否应发告警: limit 非空 && used/limit > threshold && 距上次告警 > 去抖窗口。
export function evaluateThreshold(usage, { threshold, lastAlertTs = null, now, debounceMs = DEBOUNCE_MS }) {
  if (usage.limit === null || usage.limit === undefined) {
    return { shouldAlert: false, ratio: null, reason: 'no-limit' };
  }
  const ratio = usage.used / usage.limit;
  if (!(ratio > threshold)) {
    return { shouldAlert: false, ratio, reason: 'under-threshold' };
  }
  if (lastAlertTs !== null && now - lastAlertTs < debounceMs) {
    return { shouldAlert: false, ratio, reason: 'debounced' };
  }
  return { shouldAlert: true, severity: 'warning', ratio, reason: 'over-threshold' };
}

// A4: 构造 NATS agent.usage.alert payload, 字段严格匹配 schema。
export function buildAlertPayload(usage, { threshold, ts, agent = 'cc', severity = 'warning' }) {
  return {
    kind: 'usage.threshold',
    source: ALERT_SOURCE,
    agent,
    used: usage.used,
    limit: usage.limit,
    remaining: usage.remaining,
    threshold,
    period: usage.period,
    ts,
    severity,
  };
}

// A3: worker-local state 骨架与不可变更新。
export function emptyState() {
  return { current: null, history: [], alerts: [] };
}

function keepLast(items, limit) {
  return items.length <= limit ? items : items.slice(items.length - limit);
}

export function recordUsage(state, usage, collectedAt) {
  return {
    ...state,
    current: { ...usage, collected_at: collectedAt },
    history: keepLast([...state.history, { ts: collectedAt, ...usage }], HISTORY_LIMIT),
  };
}

export function recordAlert(state, alertEntry) {
  return {
    ...state,
    alerts: keepLast([...state.alerts, alertEntry], ALERT_LIMIT),
  };
}
