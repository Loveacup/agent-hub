// Phase 4 codex-worker — exec module
// Builds Codex CLI commands, parses output, verifies byte-match integrity.
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const VALID_SANDBOXES = new Set(['read-only', 'workspace-write']);

/**
 * Build a Codex CLI command string and argument array.
 *
 * @param {object} opts
 * @param {string} opts.prompt
 * @param {string} [opts.workdir]
 * @param {'read-only'|'workspace-write'} [opts.sandbox='read-only']
 * @param {string}  [opts.model]
 * @param {boolean} [opts.ephemeral=true]
 * @param {number}  [opts.timeout_ms]
 * @returns {{ cmd: string, args: string[], _meta: { jobId: string, outputJsonl: string, lastMsgPath: string } }}
 */
export function buildCodexCommand({
  prompt,
  workdir,
  sandbox = 'read-only',
  model = null,
  ephemeral = true,
  timeout_ms,
}) {
  if (!prompt || typeof prompt !== 'string' || prompt.trim() === '') {
    throw new Error('prompt is required and must be a non-empty string');
  }
  if (workdir !== undefined) {
    if (typeof workdir !== 'string' || !workdir.startsWith('/')) {
      throw new Error(`workdir must be an absolute path, got: ${workdir}`);
    }
  }
  if (!VALID_SANDBOXES.has(sandbox)) {
    throw new Error(`sandbox must be one of: ${[...VALID_SANDBOXES].join(', ')}, got: ${sandbox}`);
  }

  const jobId = `codex-${randomUUID().slice(0, 8)}`;
  const outputJsonl = `/tmp/agent-hub-codex-${jobId}.jsonl`;
  const lastMsgPath = `/tmp/agent-hub-codex-${jobId}.txt`;

  const args = [
    'codex', 'exec',
    '--json', outputJsonl,
    '--output-last-message', lastMsgPath,
    '--sandbox', sandbox,
  ];

  if (ephemeral) {
    args.push('--ephemeral');
  }

  if (workdir) {
    args.push('--workdir', workdir);
  }

  if (model) {
    args.push('--model', model);
  }

  if (timeout_ms && typeof timeout_ms === 'number' && timeout_ms > 0) {
    args.push('--timeout', String(timeout_ms));
  }

  args.push(prompt);

  return {
    cmd: args.join(' '),
    args,
    _meta: { jobId, outputJsonl, lastMsgPath },
  };
}

/**
 * Parse codex exec output into a structured result.
 *
 * @param {string} stdoutPath
 * @param {string} lastMessage
 * @param {{ exitCode?: number, durationMs?: number }} [opts]
 * @returns {{ kind: string, source: string, job_id: string, exit_code: number, status: string, last_message: string, stdout_path: string, last_message_path: string, duration_ms: number, diff_summary: object, ts: string }}
 */
export function parseCodexOutput(stdoutPath, lastMessage, { exitCode = 0, durationMs } = {}) {
  const now = new Date().toISOString();
  const status = exitCode === 0 ? 'succeeded' : 'failed';

  return {
    kind: 'codex.result',
    source: 'codex-worker',
    job_id: '',
    exit_code: exitCode,
    status,
    last_message: lastMessage,
    stdout_path: stdoutPath,
    last_message_path: '',
    duration_ms: durationMs ?? 0,
    diff_summary: { dirty: false, files: [] },
    ts: now,
  };
}

/**
 * Verify that `last_message` matches the file content byte-for-byte.
 *
 * @param {string} filePath
 * @param {string} lastMessage
 * @returns {Promise<boolean>}
 */
export async function verifyLastMessageMatch(filePath, lastMessage) {
  try {
    const buf = await readFile(filePath);
    return buf.toString() === lastMessage;
  } catch {
    return false;
  }
}

/**
 * Execute a codex task — Phase 4a stub returns mock result.
 * Real implementation (child_process.spawn) goes into Phase 4b when
 * codex is actually installed in the VM sandbox.
 *
 * @param {object} opts
 * @returns {Promise<object>}
 */
export async function execCodexTask(opts) {
  const { _meta } = buildCodexCommand(opts);

  // Phase 4a stub: returns valid shape without spawning real Codex.
  // Tests validate command-building, parsing, and byte-match independently.
  const result = parseCodexOutput(_meta.outputJsonl, '', { exitCode: 0, durationMs: 0 });
  result.job_id = _meta.jobId;
  result.last_message_path = _meta.lastMsgPath;

  return result;
}
