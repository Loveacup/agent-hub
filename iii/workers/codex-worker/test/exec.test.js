// Phase 4 codex-worker — exec module tests (RED phase)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const tmp = tmpdir();

// Import stubs — will fail until implemented
const {
  buildCodexCommand,
  parseCodexOutput,
  verifyLastMessageMatch,
  execCodexTask,
} = await (async () => {
  try {
    return await import('../src/exec.js');
  } catch {
    return { buildCodexCommand: null, parseCodexOutput: null, verifyLastMessageMatch: null, execCodexTask: null };
  }
})();

// ═══════ buildCodexCommand ═══════

test('buildCodexCommand returns correct base command with ephemeral default', () => {
  assert.ok(buildCodexCommand, 'buildCodexCommand must be implemented');

  const cmd = buildCodexCommand({ prompt: 'say hello' });

  assert.ok(cmd.cmd.includes('codex exec'));
  assert.ok(cmd.args.includes('--json'));
  assert.ok(cmd.args.includes('--ephemeral'));
  assert.ok(cmd.args.includes('--output-last-message'));
});

test('buildCodexCommand sets workdir when provided', () => {
  const cmd = buildCodexCommand({
    prompt: 'analyze',
    workdir: '/Users/alexcai/code/agent-hub',
  });

  assert.ok(cmd.args.includes('--cd'));
  const idx = cmd.args.indexOf('--cd');
  assert.equal(cmd.args[idx + 1], '/Users/alexcai/code/agent-hub');
});

test('buildCodexCommand rejects relative workdir', () => {
  assert.throws(
    () => buildCodexCommand({ prompt: 'test', workdir: './relative' }),
    /absolute path/,
  );
});

test('buildCodexCommand maps sandbox to Codex flags', () => {
  const readOnly = buildCodexCommand({ prompt: 'read', sandbox: 'read-only' });
  assert.ok(readOnly.args.includes('--sandbox'), 'read-only should set --sandbox');

  const write = buildCodexCommand({ prompt: 'write', sandbox: 'workspace-write' });
  assert.ok(write.args.includes('--sandbox'), 'workspace-write should set --sandbox');

  // Unknown sandbox should throw
  assert.throws(
    () => buildCodexCommand({ prompt: 'bad', sandbox: 'dangerous' }),
    /sandbox/,
  );
});

test('buildCodexCommand default sandbox is read-only', () => {
  const cmd = buildCodexCommand({ prompt: 'test' });
  assert.ok(cmd.args.includes('--sandbox'));
  const idx = cmd.args.indexOf('--sandbox');
  assert.equal(cmd.args[idx + 1], 'read-only');
});

test('buildCodexCommand stores timeout_ms in metadata without passing unsupported CLI flag', () => {
  const cmd = buildCodexCommand({ prompt: 'long task', timeout_ms: 300000 });
  assert.equal(cmd._meta.timeoutMs, 300000);
  assert.equal(cmd.args.includes('--timeout'), false);
});

test('buildCodexCommand uses --json without path and stores stdout path in metadata', () => {
  const cmd = buildCodexCommand({ prompt: 'test' });

  const jsonIdx = cmd.args.indexOf('--json');
  assert.ok(jsonIdx >= 0);
  assert.doesNotMatch(cmd.args[jsonIdx + 1] ?? '', /^\/tmp\/agent-hub-codex-/);
  assert.match(cmd._meta.outputJsonl, /^\/tmp\/agent-hub-codex-/);
});

test('buildCodexCommand output-last-message path goes to /tmp/agent-hub-codex-*', () => {
  const cmd = buildCodexCommand({ prompt: 'test' });

  const outputIdx = cmd.args.indexOf('--output-last-message');
  const path = cmd.args[outputIdx + 1];
  assert.match(path, /^\/tmp\/agent-hub-codex-/);
});

test('buildCodexCommand skips git repo check because iii worker workspace is not the host repo', () => {
  const cmd = buildCodexCommand({ prompt: 'test' });
  assert.ok(cmd.args.includes('--skip-git-repo-check'));
});

test('buildCodexCommand appends prompt as last argument', () => {
  const cmd = buildCodexCommand({ prompt: 'write a test' });
  const last = cmd.args[cmd.args.length - 1];
  assert.equal(last, 'write a test');
});

// ═══════ parseCodexOutput ═══════

test('parseCodexOutput parses valid JSON stdout', () => {
  assert.ok(parseCodexOutput, 'parseCodexOutput must be implemented');

  const stdout = '/tmp/agent-hub-codex-abc123.jsonl';
  const result = parseCodexOutput(stdout, 'hello world');

  assert.equal(result.exit_code, 0);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.last_message, 'hello world');
  assert.equal(result.stdout_path, '/tmp/agent-hub-codex-abc123.jsonl');
  assert.ok(typeof result.duration_ms === 'number');
});

test('parseCodexOutput marks non-zero exit as failed', () => {
  const result = parseCodexOutput('/tmp/agent-hub-codex-fail.jsonl', 'error', { exitCode: 1 });
  assert.equal(result.exit_code, 1);
  assert.equal(result.status, 'failed');
});

// ═══════ verifyLastMessageMatch ═══════

test('verifyLastMessageMatch returns true when file matches', async () => {
  assert.ok(verifyLastMessageMatch, 'verifyLastMessageMatch must be implemented');

  const tmpDir = join(tmp, 'codex-test-match');
  await mkdir(tmpDir, { recursive: true });
  const filePath = join(tmpDir, 'last-message.txt');
  const content = 'hello world\n';

  try {
    await writeFile(filePath, content);
    const match = await verifyLastMessageMatch(filePath, content);
    assert.equal(match, true);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test('verifyLastMessageMatch returns false when file differs by one byte', async () => {
  const tmpDir = join(tmp, 'codex-test-mismatch');
  await mkdir(tmpDir, { recursive: true });
  const filePath = join(tmpDir, 'last-message.txt');

  try {
    await writeFile(filePath, 'hello world!');
    const match = await verifyLastMessageMatch(filePath, 'hello world?');
    assert.equal(match, false);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test('verifyLastMessageMatch returns false when file missing', async () => {
  const match = await verifyLastMessageMatch('/tmp/agent-hub-codex-nonexistent.txt', '');
  assert.equal(match, false);
});

// ═══════ execCodexTask real-spawn wrapper ═══════

test('execCodexTask spawns codex and captures stdout JSONL plus last-message byte-match', async () => {
  assert.ok(execCodexTask, 'execCodexTask must be implemented');

  const writes = [];
  const result = await execCodexTask({ prompt: 'say hello' }, {
    spawnFn: (bin, args) => {
      assert.equal(bin, 'codex');
      assert.equal(args[0], 'exec');
      assert.ok(args.includes('--json'));
      return fakeChild({ stdout: ['{"type":"message"}\n'], exitCode: 0 });
    },
    appendFileFn: async (path, chunk) => writes.push([path, chunk.toString()]),
    readFileFn: async () => Buffer.from('hello from codex'),
    nowFn: (() => {
      let t = 1000;
      return () => { t += 10; return t; };
    })(),
  });

  assert.equal(result.status, 'succeeded');
  assert.equal(result.exit_code, 0);
  assert.equal(result.last_message, 'hello from codex');
  assert.equal(result.match_ok, true);
  assert.ok(writes.some(([, chunk]) => chunk.includes('"type":"message"')));
});

test('execCodexTask injects VM-to-host proxy env when process env has no proxy', async () => {
  let capturedEnv = null;
  const result = await execCodexTask({ prompt: 'proxy check' }, {
    spawnFn: (_bin, _args, options) => {
      capturedEnv = options.env;
      return fakeChild({ stdout: ['{}\n'], exitCode: 0 });
    },
    appendFileFn: async () => {},
    readFileFn: async () => Buffer.from('ok'),
    baseEnv: {},
  });

  assert.equal(result.status, 'succeeded');
  assert.equal(capturedEnv.HTTPS_PROXY, 'http://100.96.0.1:6152');
  assert.equal(capturedEnv.HTTP_PROXY, 'http://100.96.0.1:6152');
  assert.match(capturedEnv.NO_PROXY, /127\.0\.0\.1/);
});

test('execCodexTask respects CODEX_WORKER_PROXY_URL override', async () => {
  let capturedEnv = null;
  await execCodexTask({ prompt: 'proxy override' }, {
    spawnFn: (_bin, _args, options) => {
      capturedEnv = options.env;
      return fakeChild({ stdout: ['{}\n'], exitCode: 0 });
    },
    appendFileFn: async () => {},
    readFileFn: async () => Buffer.from('ok'),
    baseEnv: { CODEX_WORKER_PROXY_URL: 'http://proxy.example:8080' },
  });

  assert.equal(capturedEnv.HTTPS_PROXY, 'http://proxy.example:8080');
});

test('execCodexTask marks non-zero codex exit as failed and keeps stderr tail', async () => {
  const result = await execCodexTask({ prompt: 'fail' }, {
    spawnFn: () => fakeChild({ stderr: ['bad things'], exitCode: 2 }),
    appendFileFn: async () => {},
    readFileFn: async () => Buffer.from(''),
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.exit_code, 2);
  assert.match(result.error, /bad things/);
});

test('execCodexTask returns error when codex binary cannot spawn', async () => {
  const result = await execCodexTask({ prompt: 'missing' }, {
    spawnFn: () => fakeChild({ spawnError: new Error('spawn codex ENOENT') }),
    appendFileFn: async () => {},
    readFileFn: async () => Buffer.from(''),
  });

  assert.equal(result.status, 'error');
  assert.equal(result.exit_code, -1);
  assert.match(result.error, /ENOENT/);
});

function fakeChild({ stdout = [], stderr = [], exitCode = 0, spawnError = null } = {}) {
  const handlers = new Map();
  const stream = () => ({
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(fn);
      return this;
    },
  });
  const child = {
    stdout: stream(),
    stderr: stream(),
    kill() { child.killed = true; },
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(fn);
      return child;
    },
  };
  queueMicrotask(() => {
    if (spawnError) {
      for (const fn of handlers.get('error') ?? []) fn(spawnError);
      return;
    }
    for (const chunk of stdout) for (const fn of handlers.get('data') ?? []) fn(Buffer.from(chunk));
    for (const chunk of stderr) for (const fn of handlers.get('data') ?? []) fn(Buffer.from(chunk));
    for (const fn of handlers.get('close') ?? []) fn(exitCode, null);
  });
  return child;
}
