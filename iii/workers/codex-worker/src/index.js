// Phase 4 codex-worker — worker entry
// Registers codex::exec, codex::status, codex::retention_report with iii engine.
import { registerWorker } from 'iii-sdk';
import { execCodexTask } from './exec.js';
import { buildCodexStatus, buildRetentionReport } from './collect.js';

const ENGINE_URL = process.env.III_ENGINE_URL || process.env.III_URL || 'ws://localhost:49134';

const iii = registerWorker(ENGINE_URL, { workerName: 'codex-worker' });

iii.registerFunction('codex::exec', async (data = {}) => {
  return await execCodexTask({
    prompt: data.prompt ?? '',
    workdir: data.workdir,
    sandbox: data.sandbox ?? 'read-only',
    model: data.model ?? null,
    ephemeral: data.ephemeral !== false,
    timeout_ms: data.timeout_ms,
  });
});

iii.registerFunction('codex::status', async () => {
  return buildCodexStatus([]);
});

iii.registerFunction('codex::retention_report', async () => {
  return buildRetentionReport({});
});

// keepalive — iii-sdk currently needs a referenced timer to prevent exit
setInterval(() => {}, 60_000);

console.info('codex-worker ready', { engineWsUrl: ENGINE_URL });
