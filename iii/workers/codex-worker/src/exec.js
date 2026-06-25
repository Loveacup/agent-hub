// Phase 4b codex-worker — exec module
// Builds Codex CLI commands, spawns real `codex exec`, captures JSONL stdout,
// and verifies last-message byte-match integrity.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFile, readFile, rm } from 'node:fs/promises';

const VALID_SANDBOXES = new Set(['read-only', 'workspace-write']);
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_VM_HOST_PROXY = 'http://100.96.0.1:6152';
const LOCAL_PROXY_RE = /^http:\/\/(127\.0\.0\.1|localhost):6152\/?$/i;

/**
 * Build a Codex CLI command and argument array.
 * Codex 0.142: `--json` prints JSONL to stdout, `--output-last-message <file>` writes final message.
 *
 * @param {object} opts
 * @param {string} opts.prompt
 * @param {string} [opts.workdir]
 * @param {'read-only'|'workspace-write'} [opts.sandbox='read-only']
 * @param {string}  [opts.model]
 * @param {boolean} [opts.ephemeral=true]
 * @param {number}  [opts.timeout_ms]
 * @returns {{ cmd: string, args: string[], _meta: { jobId: string, outputJsonl: string, lastMsgPath: string, timeoutMs: number } }}
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
  const timeoutMs = Number.isFinite(timeout_ms) && timeout_ms > 0 ? timeout_ms : DEFAULT_TIMEOUT_MS;

  const args = [
    'codex', 'exec',
    '--json',
    '--output-last-message', lastMsgPath,
    '--sandbox', sandbox,
    '--skip-git-repo-check',
    '--color', 'never',
  ];

  if (ephemeral) {
    args.push('--ephemeral');
  }

  if (workdir) {
    args.push('--cd', workdir);
  }

  if (model) {
    args.push('--model', model);
  }

  args.push(prompt);

  return {
    cmd: args.join(' '),
    args,
    _meta: { jobId, outputJsonl, lastMsgPath, timeoutMs },
  };
}

/**
 * Parse codex exec output into a structured result.
 *
 * @param {string} stdoutPath
 * @param {string} lastMessage
 * @param {{ exitCode?: number, durationMs?: number, jobId?: string, lastMsgPath?: string, error?: string }} [opts]
 */
export function parseCodexOutput(stdoutPath, lastMessage, {
  exitCode = 0,
  durationMs,
  jobId = '',
  lastMsgPath = '',
  error = '',
} = {}) {
  const status = exitCode === 0 ? 'succeeded' : 'failed';
  const result = {
    kind: 'codex.result',
    source: 'codex-worker',
    job_id: jobId,
    exit_code: exitCode,
    status,
    last_message: lastMessage,
    stdout_path: stdoutPath,
    last_message_path: lastMsgPath,
    duration_ms: durationMs ?? 0,
    diff_summary: { dirty: false, files: [] },
    ts: new Date().toISOString(),
  };
  if (error) result.error = error;
  return result;
}

/**
 * Verify that `last_message` matches the file content byte-for-byte.
 *
 * @param {string} filePath
 * @param {string} lastMessage
 * @param {(path:string)=>Promise<Buffer|string>} [readFileFn]
 * @returns {Promise<boolean>}
 */
export async function verifyLastMessageMatch(filePath, lastMessage, readFileFn = readFile) {
  try {
    const buf = await readFileFn(filePath);
    const actual = Buffer.isBuffer(buf) ? buf.toString() : String(buf);
    return actual === lastMessage;
  } catch {
    return false;
  }
}

/**
 * Build environment for Codex CLI inside iii VM.
 * Host proxy `127.0.0.1:6152` is unusable inside VM; rewrite to iii host gateway.
 * Set CODEX_WORKER_PROXY_URL=direct to opt out, or set it to a proxy URL to override.
 */
export function buildCodexEnv(baseEnv = process.env) {
  const env = { ...baseEnv };
  const override = env.CODEX_WORKER_PROXY_URL;

  let proxy = override && override !== 'direct'
    ? override
    : (env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || '');

  if (!override && (!proxy || LOCAL_PROXY_RE.test(proxy))) {
    proxy = DEFAULT_VM_HOST_PROXY;
  }

  if (override === 'direct') {
    delete env.HTTP_PROXY;
    delete env.HTTPS_PROXY;
    delete env.ALL_PROXY;
    delete env.http_proxy;
    delete env.https_proxy;
    delete env.all_proxy;
  } else if (proxy) {
    env.HTTP_PROXY = proxy;
    env.HTTPS_PROXY = proxy;
    env.http_proxy = proxy;
    env.https_proxy = proxy;
  }

  const noProxy = env.NO_PROXY || env.no_proxy || '';
  const essentials = ['127.0.0.1', 'localhost', '::1', '100.96.0.1'];
  const merged = new Set(noProxy.split(',').map((x) => x.trim()).filter(Boolean));
  for (const item of essentials) merged.add(item);
  env.NO_PROXY = [...merged].join(',');
  env.no_proxy = env.NO_PROXY;

  return env;
}

/**
 * Execute a codex task by spawning `codex exec`.
 * Dependency injection is used for TDD; production uses child_process.spawn and fs.
 *
 * @param {object} opts
 * @param {object} [deps]
 * @param {typeof spawn} [deps.spawnFn]
 * @param {(path:string, data:Buffer|string)=>Promise<void>} [deps.appendFileFn]
 * @param {(path:string)=>Promise<Buffer|string>} [deps.readFileFn]
 * @param {(path:string, opts?:object)=>Promise<void>} [deps.rmFn]
 * @param {()=>number} [deps.nowFn]
 * @param {NodeJS.ProcessEnv} [deps.baseEnv]
 * @returns {Promise<object>}
 */
export async function execCodexTask(opts, {
  spawnFn = spawn,
  appendFileFn = appendFile,
  readFileFn = readFile,
  rmFn = rm,
  nowFn = Date.now,
  baseEnv = process.env,
} = {}) {
  let built;
  try {
    built = buildCodexCommand(opts);
  } catch (err) {
    return buildErrorResult('', '', '', -1, `invalid request: ${err.message}`, 0);
  }

  const { args, _meta } = built;
  const start = nowFn();
  const bin = args[0];
  const childArgs = args.slice(1);
  let stderr = '';
  let settled = false;

  try {
    await rmFn(_meta.outputJsonl, { force: true });
  } catch {}

  return await new Promise((resolve) => {
    let child;
    let timer;

    const finish = async (exitCode, error = '') => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);

      const durationMs = Math.max(0, nowFn() - start);
      let lastMessage = '';
      try {
        const content = await readFileFn(_meta.lastMsgPath);
        lastMessage = Buffer.isBuffer(content) ? content.toString() : String(content);
      } catch {
        lastMessage = '';
      }

      if (exitCode === -1) {
        resolve(buildErrorResult(_meta.jobId, _meta.outputJsonl, _meta.lastMsgPath, -1, error, durationMs));
        return;
      }

      const result = parseCodexOutput(_meta.outputJsonl, lastMessage, {
        exitCode,
        durationMs,
        jobId: _meta.jobId,
        lastMsgPath: _meta.lastMsgPath,
        error: error || (exitCode === 0 ? '' : stderr.slice(-1000)),
      });
      result.match_ok = await verifyLastMessageMatch(_meta.lastMsgPath, lastMessage, readFileFn);
      resolve(result);
    };

    try {
      child = spawnFn(bin, childArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: buildCodexEnv(baseEnv),
      });
    } catch (err) {
      finish(-1, `failed to spawn codex: ${err.message}`);
      return;
    }

    timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch {}
      finish(-1, `codex exec timed out after ${_meta.timeoutMs}ms`);
    }, _meta.timeoutMs);

    child.stdout?.on('data', (chunk) => {
      appendFileFn(_meta.outputJsonl, chunk).catch(() => {});
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => {
      finish(-1, `failed to spawn codex: ${err.message}`);
    });
    child.on('close', (code, signal) => {
      if (signal) {
        finish(-1, `codex exec killed by signal ${signal}`);
        return;
      }
      finish(code ?? 0);
    });
  });
}

function buildErrorResult(jobId, stdoutPath, lastMsgPath, exitCode, error, durationMs) {
  return {
    kind: 'codex.result',
    source: 'codex-worker',
    job_id: jobId,
    exit_code: exitCode,
    status: 'error',
    last_message: '',
    stdout_path: stdoutPath,
    last_message_path: lastMsgPath,
    duration_ms: durationMs,
    diff_summary: { dirty: false, files: [] },
    error,
    ts: new Date().toISOString(),
  };
}
