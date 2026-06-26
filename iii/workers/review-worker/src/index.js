// Phase 6 review-worker — iii function registration.
import { registerWorker } from 'iii-sdk';
import { runCounter, runDangerScan, runVerify } from './gates.js';

const ENGINE_URL = process.env.III_ENGINE_URL || process.env.III_URL || 'ws://localhost:49134';
const iii = registerWorker(ENGINE_URL, { workerName: 'review-worker' });

iii.registerFunction('review::status', async () => ({
  kind: 'review.status',
  worker: 'review-worker',
  status: 'ok',
  functions: ['review::status', 'review::danger_scan', 'review::verify', 'review::counter'],
  ts: new Date().toISOString(),
}));

iii.registerFunction('review::danger_scan', async (data = {}) => runDangerScan(data));
iii.registerFunction('review::verify', async (data = {}) => runVerify(data));
iii.registerFunction('review::counter', async (data = {}) => runCounter(data));

setInterval(() => {}, 60_000);
console.info('review-worker ready', { engineWsUrl: ENGINE_URL });
