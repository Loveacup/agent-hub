// Phase 3b cc-host-bridge execute contract tests (RED phase)
import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  parseStartSessionName,
  buildStartArgs,
  executeFlow,
} = await (async () => {
  try {
    return await import('../src/executeFlow.js');
  } catch {
    return { parseStartSessionName: null, buildStartArgs: null, executeFlow: null };
  }
})();

test('parseStartSessionName extracts final hermes-cc session from cc-start stdout', () => {
  assert.ok(parseStartSessionName, 'parseStartSessionName must be implemented');
  const session = parseStartSessionName('noise\nhermes-cc-default-agent-hub-0625-1530\n');
  assert.equal(session, 'hermes-cc-default-agent-hub-0625-1530');
});

test('buildStartArgs maps execute request to cc-start safe args', () => {
  assert.ok(buildStartArgs, 'buildStartArgs must be implemented');
  const args = buildStartArgs({
    target: 'agent-hub',
    task: 'do work',
    effort: 'high',
    model: 'claude-opus-4-8',
    topic: '58478',
    ack_active: true,
  });
  assert.deepEqual(args, [
    '--target', 'agent-hub',
    '--task', 'do work',
    '--effort', 'high',
    '--model', 'claude-opus-4-8',
    '--topic', '58478',
    '--ack-active',
  ]);
});

test('executeFlow starts new session, sends context, then monitors', async () => {
  assert.ok(executeFlow, 'executeFlow must be implemented');
  const calls = [];
  const res = await executeFlow({
    target: 'agent-hub',
    task: 'do work',
    context_path: '/tmp/context.md',
  }, {
    runFn: async (script, args) => {
      calls.push({ script, args });
      if (script.endsWith('cc-start.sh')) return { ok: true, stdout: 'hermes-cc-default-agent-hub-0625-1530\n', stderr: '', exit_code: 0 };
      if (script.endsWith('cc-send.sh')) return { ok: true, stdout: '✓ Sent\n', stderr: '', exit_code: 0 };
      if (script.endsWith('cc-monitor.sh')) return { ok: true, stdout: '===📡 BEGIN===\n📡 ok\n===📡 END===\n', stderr: '', exit_code: 0 };
      throw new Error(`unexpected script ${script}`);
    },
  });

  assert.equal(res.kind, 'cc.execute');
  assert.equal(res.status, 'sent');
  assert.equal(res.session_id, 'hermes-cc-default-agent-hub-0625-1530');
  assert.equal(res.monitor_before.status, 'ok');
  assert.equal(res.monitor_after.status, 'ok');
  assert.equal(calls.length, 4);
});

test('executeFlow reports active sessions requiring ack instead of forcing start', async () => {
  const res = await executeFlow({ target: 'agent-hub', task: 'do work', context_path: '/tmp/context.md' }, {
    runFn: async (script) => {
      if (script.endsWith('cc-start.sh')) return { ok: false, exit_code: 3, stdout: 'active report', stderr: 'needs ack' };
      throw new Error('should not send after failed start');
    },
  });

  assert.equal(res.status, 'refused');
  assert.equal(res.error, 'active_sessions_require_ack');
  assert.match(res.relay, /active report/);
});
