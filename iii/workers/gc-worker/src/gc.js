// Phase 2 gc-worker — pure scan/plan/execute logic (zero side effects)
// Adapter boundary lives in collect.js; this file is deterministic and test-first.

export const DEFAULT_TTL_MS = 48 * 60 * 60 * 1000;

const PROTECTED_PROCESS_RE = /(^|\b)(iii|usage-worker|nats-server|nats|tmux|claude|Claude Code|cc-worker)(\b|$)/i;

function isOldEnough(item, now, ttlMs) {
  return typeof item.mtimeMs === 'number' && now - item.mtimeMs > ttlMs;
}

function pathLooksGcOwned(path = '') {
  // Phase 2 deliberately keeps the destructive scope tiny: only cc-tmux style /tmp/cc-* artifacts.
  // Codex sessions and repo paths are reported/handled by later dedicated workers, never by generic GC.
  return /^\/tmp\/cc-[^/]+/.test(path);
}

function evidenceFor(item, now, ttlMs, activePids) {
  const evidence = [];
  if (item.path) evidence.push(`path=${item.path}`);
  if (item.pid !== undefined && item.pid !== null) evidence.push(`pid=${item.pid} active=${activePids.has(Number(item.pid))}`);
  if (item.name) evidence.push(`process=${item.name}`);
  if (typeof item.mtimeMs === 'number') evidence.push(`mtimeMs=${item.mtimeMs} ageMs=${now - item.mtimeMs} ttlMs=${ttlMs}`);
  if (typeof item.size === 'number') evidence.push(`size=${item.size}`);
  return evidence;
}

export function classifyRuntimeArtifacts(artifacts = [], {
  now = Date.now(),
  ttlMs = DEFAULT_TTL_MS,
  activePids = new Set([process.pid]),
} = {}) {
  return artifacts.map((item) => {
    const pid = item.pid === undefined || item.pid === null ? null : Number(item.pid);
    const evidence = evidenceFor(item, now, ttlMs, activePids);

    if (pid !== null && activePids.has(pid)) {
      return { ...item, status: 'blocked', reason: `active pid ${pid}`, evidence };
    }

    if (item.kind === 'process' && PROTECTED_PROCESS_RE.test(item.name || '')) {
      return { ...item, status: 'blocked', reason: 'protected active process', evidence };
    }

    if (item.kind === 'file') {
      if (!pathLooksGcOwned(item.path || '')) {
        return { ...item, status: 'blocked', reason: 'path outside gc-owned runtime scope', evidence };
      }
      if (isOldEnough(item, now, ttlMs)) {
        return {
          ...item,
          status: 'candidate',
          reason: 'older than TTL and no matching live process',
          evidence: [...evidence, 'older than TTL'],
        };
      }
      return { ...item, status: 'blocked', reason: 'not older than TTL', evidence };
    }

    if (item.kind === 'process') {
      if (item.gcOwned === true) {
        return {
          ...item,
          status: 'candidate',
          reason: 'gc-owned process not in active set',
          evidence,
        };
      }
      return { ...item, status: 'blocked', reason: 'process is not gc-owned', evidence };
    }

    return { ...item, status: 'blocked', reason: 'unknown artifact kind', evidence };
  });
}

function actionIdFor(action) {
  const raw = `${action.kind}:${action.path_or_pid}`;
  return raw.replace(/[^a-zA-Z0-9_.:-]+/g, '_');
}

export function planGcActions(classified = []) {
  return classified
    .filter((item) => item.status === 'candidate')
    .filter((item) => !(item.kind === 'file' && item.isDirectory === true))
    .map((item) => {
      const action = item.kind === 'process'
        ? {
            kind: 'kill_process',
            path_or_pid: Number(item.pid),
            risk: 'medium',
            reason: item.reason,
            requires_confirm: true,
            evidence: item.evidence || [],
          }
        : {
            kind: 'delete_file',
            path_or_pid: item.path,
            expected_mtime_ms: typeof item.mtimeMs === 'number' ? item.mtimeMs : undefined,
            risk: 'low',
            reason: item.reason,
            requires_confirm: false,
            evidence: item.evidence || [],
          };
      return { id: actionIdFor(action), ...action };
    });
}

export function buildGcReport(actions = [], { ts = new Date().toISOString(), blocked = [] } = {}) {
  return {
    kind: 'gc.report',
    source: 'gc-worker',
    ts,
    summary: {
      candidates: actions.length,
      safe: actions.filter((action) => !action.requires_confirm).length,
      needs_confirm: actions.filter((action) => action.requires_confirm).length,
      blocked: blocked.length,
    },
    actions,
  };
}

function isSafeDeletePath(path = '') {
  return pathLooksGcOwned(String(path));
}

function isExplicitlyConfirmed(action, confirmedActionIds) {
  if (!action.requires_confirm) return true;
  if (!confirmedActionIds) return false;
  if (confirmedActionIds instanceof Set) return confirmedActionIds.has(action.id);
  if (Array.isArray(confirmedActionIds)) return confirmedActionIds.includes(action.id);
  return false;
}

export async function executePlan(actions = [], {
  confirm = false,
  confirmedActionIds = new Set(),
  deleteFile = async () => {},
  killProcess = async () => {},
  statPath = null,
} = {}) {
  const executed = [];
  const refused = [];
  const skipped = [];
  const failed = [];

  for (const action of actions) {
    if (!confirm) {
      refused.push({ id: action.id, reason: 'confirm:true required for destructive execution', action });
      continue;
    }

    if (!isExplicitlyConfirmed(action, confirmedActionIds)) {
      skipped.push({ id: action.id, reason: 'action requires explicit confirmedActionIds entry', action });
      continue;
    }

    try {
      if (action.kind === 'delete_file') {
        if (!isSafeDeletePath(action.path_or_pid)) {
          skipped.push({ id: action.id, reason: `unsafe delete path ${action.path_or_pid}`, action });
          continue;
        }

        if (typeof action.expected_mtime_ms === 'number' && typeof statPath === 'function') {
          const current = await statPath(action.path_or_pid);
          if (!current) {
            skipped.push({ id: action.id, reason: `path disappeared before delete ${action.path_or_pid}`, action });
            continue;
          }
          if (current.isDirectory === true) {
            skipped.push({ id: action.id, reason: `refusing directory delete ${action.path_or_pid}`, action });
            continue;
          }
          if (Number(current.mtimeMs) !== Number(action.expected_mtime_ms)) {
            skipped.push({ id: action.id, reason: `mtime changed for ${action.path_or_pid}`, action });
            continue;
          }
        }

        await deleteFile(action.path_or_pid);
        executed.push(action);
      } else if (action.kind === 'kill_process') {
        await killProcess(Number(action.path_or_pid));
        executed.push(action);
      } else {
        skipped.push({ id: action.id, reason: `unsupported action kind ${action.kind}`, action });
      }
    } catch (err) {
      failed.push({ id: action.id, reason: err instanceof Error ? err.message : String(err), action });
    }
  }

  return { executed, refused, skipped, failed };
}
