// Phase 5 Runtime Orchestrator — minimal iii trigger client
import { execFile } from 'node:child_process';

export const DEFAULT_III_BIN = '/Users/alexcai/.local/bin/iii';

export function triggerIii({
  iii_bin = DEFAULT_III_BIN,
  action,
  payload = {},
  address = 'localhost',
  port = 49134,
  timeout_ms = 60_000,
} = {}) {
  if (!action) throw new Error('action is required');
  const args = [
    'trigger', action,
    '--json', JSON.stringify(payload),
    '--address', address,
    '--port', String(port),
    '--timeout-ms', String(timeout_ms),
  ];
  return new Promise((resolve, reject) => {
    execFile(iii_bin, args, { timeout: timeout_ms + 5_000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`iii trigger failed for ${action}: ${stderr || err.message}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (parseErr) {
        reject(new Error(`iii trigger returned invalid JSON for ${action}: ${parseErr.message}`));
      }
    });
  });
}
