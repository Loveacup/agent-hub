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
} = await (async () => {
  try {
    return await import('../src/exec.js');
  } catch {
    return { buildCodexCommand: null, parseCodexOutput: null, verifyLastMessageMatch: null };
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

  assert.ok(cmd.args.includes('--workdir'));
  const idx = cmd.args.indexOf('--workdir');
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

test('buildCodexCommand includes timeout_ms when specified', () => {
  const cmd = buildCodexCommand({ prompt: 'long task', timeout_ms: 300000 });
  assert.ok(cmd.args.includes('--timeout'));
  const idx = cmd.args.indexOf('--timeout');
  assert.equal(cmd.args[idx + 1], '300000');
});

test('buildCodexCommand output paths go to /tmp/agent-hub-codex-*', () => {
  const cmd = buildCodexCommand({ prompt: 'test' });

  const outputIdx = cmd.args.indexOf('--output-last-message');
  const path = cmd.args[outputIdx + 1];
  assert.match(path, /^\/tmp\/agent-hub-codex-/);
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
