// usage-worker — 周期采集 singleflight 守卫单测 (依赖注入, 不启动 iii engine / 不用真实计时器)
// 严格 TDD: 本文件先于实现存在, 预期 RED.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPeriodicUsageCollector } from '../src/collect.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('createPeriodicUsageCollector singleflight: 上一次仍在跑时跳过且不再次调用 runCheck', async () => {
  const d = deferred();
  let calls = 0;
  const warnings = [];
  const collectOnce = createPeriodicUsageCollector({
    runCheckFn: () => { calls += 1; return d.promise; },
    logger: { warn: (m) => warnings.push(m), error: () => {} },
  });

  const first = collectOnce();        // 持锁, 尚未 resolve
  const second = await collectOnce(); // 应被跳过

  assert.equal(second.skipped, true);
  assert.equal(calls, 1);
  assert.match(warnings[0], /skipped/);

  d.resolve({ alerted: false });
  await first;
});

test('createPeriodicUsageCollector 成功后释放 singleflight 锁', async () => {
  let calls = 0;
  const collectOnce = createPeriodicUsageCollector({
    runCheckFn: () => { calls += 1; return Promise.resolve({ alerted: false }); },
    logger: { warn: () => {}, error: () => {} },
  });
  const a = await collectOnce();
  const b = await collectOnce();
  assert.equal(a.skipped, false);
  assert.equal(b.skipped, false);
  assert.equal(calls, 2);
});

test('createPeriodicUsageCollector 失败后仍释放 singleflight 锁并 log error', async () => {
  let calls = 0;
  const errors = [];
  const collectOnce = createPeriodicUsageCollector({
    runCheckFn: () => { calls += 1; return Promise.reject(new Error('boom')); },
    logger: { warn: () => {}, error: (...a) => errors.push(a) },
  });
  const a = await collectOnce();
  const b = await collectOnce(); // 上次失败已释放锁, 这次应真正执行
  assert.equal(a.skipped, false);
  assert.equal(b.skipped, false);
  assert.equal(calls, 2);
  assert.equal(errors.length, 2);
});
