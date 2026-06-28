// Tests for parallel-runner.mjs — pure, no fs/network, fake triggerIii only.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runParallelCalls } from '../lib/parallel-runner.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// behaviors: Map of `action → { delay_ms, result, error }`
function fakeTriggerIii(behaviors) {
  return async ({ action, payload }) => {
    const behavior = behaviors.get(action);
    if (!behavior) throw new Error(`unexpected action: ${action}`);
    if (behavior.delay_ms) await sleep(behavior.delay_ms);
    if (behavior.error) throw behavior.error;
    return behavior.result ?? { ok: true, action, echo: payload };
  };
}

// 1. two workers both succeed in parallel
test('2 workers both succeed in parallel', async () => {
  const triggerIii = fakeTriggerIii(new Map([
    ['cc::execute', { result: { who: 'cc' } }],
    ['codex::exec', { result: { who: 'codex' } }],
  ]));
  const calls = [
    { lane: 'cc-worker', action: 'cc::execute', payload: { a: 1 } },
    { lane: 'codex-worker', action: 'codex::exec', payload: { b: 2 } },
  ];
  const { results, summary } = await runParallelCalls(calls, { triggerIii });
  assert.equal(results.length, 2);
  assert.ok(results.every((r) => r.status === 'ok'));
  assert.deepEqual(results[0].data, { who: 'cc' });
  assert.deepEqual(results[1].data, { who: 'codex' });
  assert.equal(summary.ok, 2);
  assert.equal(summary.error, 0);
  assert.equal(summary.timeout, 0);
  assert.equal(summary.total, 2);
});

// 2. three workers, one fails → partial failure
test('3 workers, one fails → 2 ok + 1 error', async () => {
  const triggerIii = fakeTriggerIii(new Map([
    ['a', { result: { ok: 1 } }],
    ['b', { error: new Error('boom') }],
    ['c', { result: { ok: 3 } }],
  ]));
  const calls = [
    { lane: 'l1', action: 'a', payload: {} },
    { lane: 'l2', action: 'b', payload: {} },
    { lane: 'l3', action: 'c', payload: {} },
  ];
  const { results, summary } = await runParallelCalls(calls, { triggerIii });
  assert.equal(summary.ok, 2);
  assert.equal(summary.error, 1);
  const failed = results.find((r) => r.status === 'error');
  assert.equal(failed.lane, 'l2');
  assert.equal(failed.error, 'boom');
});

// 3. timeout handling
test('timeout handling → slow worker returns timeout status', async () => {
  const triggerIii = fakeTriggerIii(new Map([
    ['fast', { delay_ms: 5, result: { ok: true } }],
    ['slow', { delay_ms: 200, result: { ok: true } }],
  ]));
  const calls = [
    { lane: 'fast', action: 'fast', payload: {}, timeout_ms: 100 },
    { lane: 'slow', action: 'slow', payload: {}, timeout_ms: 30 },
  ];
  const { results, summary } = await runParallelCalls(calls, { triggerIii });
  const slow = results.find((r) => r.lane === 'slow');
  const fast = results.find((r) => r.lane === 'fast');
  assert.equal(slow.status, 'timeout');
  assert.ok(/timed out/.test(slow.error));
  assert.equal(fast.status, 'ok');
  assert.equal(summary.timeout, 1);
  assert.equal(summary.ok, 1);
});

// 4. empty calls array
test('empty calls array → total=0, results=[]', async () => {
  const triggerIii = fakeTriggerIii(new Map());
  const { results, summary } = await runParallelCalls([], { triggerIii });
  assert.deepEqual(results, []);
  assert.equal(summary.total, 0);
  assert.equal(summary.ok, 0);
});

// 5. calls is undefined / null
test('calls undefined or null → handled gracefully', async () => {
  const triggerIii = fakeTriggerIii(new Map());
  const undef = await runParallelCalls(undefined, { triggerIii });
  assert.equal(undef.summary.total, 0);
  assert.deepEqual(undef.results, []);

  const nul = await runParallelCalls(null, { triggerIii });
  assert.equal(nul.summary.total, 0);
  assert.deepEqual(nul.results, []);

  // even with no options at all
  const bare = await runParallelCalls();
  assert.equal(bare.summary.total, 0);
});

// 6. single worker dispatch
test('single worker dispatch → works, duration_ms > 0', async () => {
  const triggerIii = fakeTriggerIii(new Map([
    ['solo', { delay_ms: 10, result: { done: true } }],
  ]));
  const { results, summary } = await runParallelCalls(
    [{ lane: 'only', action: 'solo', payload: {} }],
    { triggerIii },
  );
  assert.equal(results.length, 1);
  assert.equal(results[0].status, 'ok');
  assert.deepEqual(results[0].data, { done: true });
  assert.ok(results[0].duration_ms > 0);
  assert.equal(summary.ok, 1);
});

// 7. per-worker error isolation
test('per-worker error isolation → worker 1 failure does not affect worker 2', async () => {
  const triggerIii = fakeTriggerIii(new Map([
    ['w1', { error: new Error('w1 down') }],
    ['w2', { delay_ms: 20, result: { healthy: true } }],
  ]));
  const calls = [
    { lane: 'w1', action: 'w1', payload: {} },
    { lane: 'w2', action: 'w2', payload: {} },
  ];
  const { results } = await runParallelCalls(calls, { triggerIii });
  const w1 = results.find((r) => r.lane === 'w1');
  const w2 = results.find((r) => r.lane === 'w2');
  assert.equal(w1.status, 'error');
  assert.equal(w2.status, 'ok');
  assert.deepEqual(w2.data, { healthy: true });
});

// 8. parallel timing — proves real parallelism, not serial execution
test('parallel timing → 3 calls of 50ms each finish in < 150ms', async () => {
  const triggerIii = fakeTriggerIii(new Map([
    ['t1', { delay_ms: 50, result: 1 }],
    ['t2', { delay_ms: 50, result: 2 }],
    ['t3', { delay_ms: 50, result: 3 }],
  ]));
  const calls = [
    { lane: 'a', action: 't1', payload: {} },
    { lane: 'b', action: 't2', payload: {} },
    { lane: 'c', action: 't3', payload: {} },
  ];
  const { summary } = await runParallelCalls(calls, { triggerIii });
  assert.equal(summary.ok, 3);
  // Serial would be ~150ms+; parallel should be ~50ms.
  assert.ok(summary.total_duration_ms < 150, `expected < 150ms, got ${summary.total_duration_ms}`);
});

// 9. duplicate lane names
test('duplicate lane names → both execute, results distinct', async () => {
  const triggerIii = fakeTriggerIii(new Map([
    ['x', { result: { n: 1 } }],
    ['y', { result: { n: 2 } }],
  ]));
  const calls = [
    { lane: 'dup', action: 'x', payload: {} },
    { lane: 'dup', action: 'y', payload: {} },
  ];
  const { results, summary } = await runParallelCalls(calls, { triggerIii });
  assert.equal(results.length, 2);
  assert.equal(summary.ok, 2);
  assert.equal(results[0].lane, 'dup');
  assert.equal(results[1].lane, 'dup');
  assert.notDeepEqual(results[0].data, results[1].data);
  assert.deepEqual(results[0].data, { n: 1 });
  assert.deepEqual(results[1].data, { n: 2 });
});

// 10. summary stats accurate across all statuses
test('summary stats accurate → ok/error/timeout counts match', async () => {
  const triggerIii = fakeTriggerIii(new Map([
    ['ok1', { result: 1 }],
    ['ok2', { result: 2 }],
    ['err1', { error: new Error('nope') }],
    ['slow1', { delay_ms: 200, result: 3 }],
  ]));
  const calls = [
    { lane: 'a', action: 'ok1', payload: {} },
    { lane: 'b', action: 'ok2', payload: {} },
    { lane: 'c', action: 'err1', payload: {} },
    { lane: 'd', action: 'slow1', payload: {}, timeout_ms: 25 },
  ];
  const { results, summary } = await runParallelCalls(calls, { triggerIii });
  assert.equal(summary.total, 4);
  assert.equal(summary.ok, 2);
  assert.equal(summary.error, 1);
  assert.equal(summary.timeout, 1);
  assert.equal(summary.ok + summary.error + summary.timeout, results.length);
});
