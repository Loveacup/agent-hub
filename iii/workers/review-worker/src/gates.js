// Phase 6 review-worker — thin wrappers around substrate-independent gate scripts.
import { execFile } from 'node:child_process';

export const DEFAULT_GATE_DIR = '/Users/alexcai/.hermes/skills/autonomous-ai-agents/cc-tmux/scripts/gate';
export const DEFAULT_DANGER_GATE = `${DEFAULT_GATE_DIR}/gate-danger.sh`;
export const DEFAULT_VERIFY_GATE = `${DEFAULT_GATE_DIR}/gate-verify.sh`;
export const DEFAULT_COUNTER_GATE = `${DEFAULT_GATE_DIR}/gate-counter.sh`;

function tail(text, max = 4000) {
  const s = String(text ?? '');
  return s.length > max ? s.slice(-max) : s;
}

export function mapDangerStatus(exit_code) {
  if (exit_code === 0) return { status: 'ok', verdict: 'pass', danger: false };
  if (exit_code === 10) return { status: 'blocked', verdict: 'fail', danger: true };
  return { status: 'error', verdict: 'error', danger: false };
}

export function mapVerifyStatus(exit_code) {
  if (exit_code === 0) return { status: 'passed', verdict: 'pass' };
  if ([1, 2, 10].includes(exit_code)) return { status: 'failed', verdict: 'fail' };
  return { status: 'error', verdict: 'error' };
}

export function mapCounterStatus(exit_code) {
  if (exit_code === 0) return { status: 'ok', verdict: 'pass' };
  if (exit_code === 20) return { status: 'over_limit', verdict: 'stop' };
  return { status: 'error', verdict: 'error' };
}

export function runGate({ gate_bin, args = [], timeout_ms = 30_000 } = {}) {
  if (!gate_bin) throw new Error('gate_bin is required');
  return new Promise((resolve) => {
    execFile(gate_bin, args, { timeout: timeout_ms, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        exit_code: err?.code ?? 0,
        signal: err?.signal ?? null,
        stdout: tail(stdout),
        stderr: tail(stderr || err?.message || ''),
      });
    });
  });
}

export async function runDangerScan({ scan_text, scan_file, strict = false, gate_bin = DEFAULT_DANGER_GATE, timeout_ms } = {}) {
  const args = [];
  if (scan_file) args.push('--scan-file', scan_file);
  else if (scan_text) args.push('--scan-text', scan_text);
  else throw new Error('scan_text or scan_file is required');
  if (strict) args.push('--strict');
  args.push('--json');
  const gate = await runGate({ gate_bin, args, timeout_ms });
  const mapped = mapDangerStatus(gate.exit_code);
  return { kind: 'review.danger_scan', ...mapped, ...gate };
}

export async function runVerify({ cmds = [], artifacts = [], expect_artifacts = [], cwd, gate_bin = DEFAULT_VERIFY_GATE, timeout_ms } = {}) {
  const args = [];
  for (const cmd of cmds) args.push('--cmd', cmd);
  for (const artifact of artifacts) args.push('--artifact', artifact);
  for (const expect of expect_artifacts) args.push('--expect-artifacts', expect);
  if (cwd) args.push('--cwd', cwd);
  args.push('--json');
  const gate = await runGate({ gate_bin, args, timeout_ms });
  const mapped = mapVerifyStatus(gate.exit_code);
  return { kind: 'review.verify', ...mapped, ...gate };
}

export async function runCounter({ key, kind = 'reject', action = 'get', limit, gate_bin = DEFAULT_COUNTER_GATE, timeout_ms } = {}) {
  if (!key) throw new Error('key is required');
  const args = ['--key', key, '--kind', kind];
  if (action === 'inc') args.push('--inc');
  else if (action === 'reset') args.push('--reset');
  else args.push('--get');
  if (limit != null) args.push('--limit', String(limit));
  args.push('--json');
  const gate = await runGate({ gate_bin, args, timeout_ms });
  const mapped = mapCounterStatus(gate.exit_code);
  return { kind: 'review.counter', ...mapped, ...gate };
}
