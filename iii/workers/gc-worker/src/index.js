// Phase 2 gc-worker — iii adapter layer
// cc-tmux remains untouched; this worker exposes scan/plan/execute through iii functions.
import { registerWorker } from 'iii-sdk';
import { runScan, runPlan, runExecute } from './collect.js';

const engineWsUrl = process.env.III_URL ?? 'ws://localhost:49134';
const iii = registerWorker(engineWsUrl, { workerName: 'gc-worker' });

function parseConfirmedActionIds(value) {
  if (value instanceof Set) return value;
  if (Array.isArray(value)) return new Set(value);
  return new Set();
}

iii.registerFunction('gc::scan', async (data = {}) => {
  return runScan({
    ttlMs: data.ttlMs,
    activePids: data.activePids,
  });
});

iii.registerFunction('gc::plan', async (data = {}) => {
  return runPlan({
    ttlMs: data.ttlMs,
    activePids: data.activePids,
  });
});

iii.registerFunction('gc::execute', async (data = {}) => {
  return runExecute({
    actions: data.actions || [],
    confirm: data.confirm === true,
    confirmedActionIds: parseConfirmedActionIds(data.confirmedActionIds),
  });
});

console.info('gc-worker ready', { engineWsUrl });

// registerWorker registers async handlers, but the current iii-sdk/node combo does not
// keep the Node process alive by itself. Keep a tiny referenced timer so the worker
// remains available for `iii trigger gc::*` calls. No polling or side effects here.
setInterval(() => {}, 60_000);
