// H6 Multi-Worker Parallel Dispatch — pure logic, no IO.
//
// Fan out multiple iii worker calls concurrently via an injected triggerIii.
// Error isolation is the whole point: one worker failing/timing out must not
// kill the others, so we use Promise.allSettled and wrap every call.
//
// Pure logic only: no filesystem, no network, no environment reads. triggerIii
// is the only dependency and it is injected by the caller (the CLI wires in
// lib/iii-client.mjs).

const TIMEOUT = Symbol('parallel-runner-timeout');

function now() {
  return performance.now();
}

function elapsed(start) {
  return Math.round(now() - start);
}

// Run a single call, never throwing. Returns a normalized result object.
async function runOne(call, triggerIii, defaultTimeoutMs) {
  const start = now();
  const lane = call && call.lane !== undefined ? call.lane : null;
  const action = call ? call.action : undefined;
  const payload = call && call.payload ? call.payload : {};
  const timeoutMs = call && call.timeout_ms != null ? call.timeout_ms : defaultTimeoutMs;

  let timer;
  try {
    if (typeof triggerIii !== 'function') {
      throw new Error('triggerIii must be a function');
    }
    // Defer the call into a promise so a synchronous throw is captured here too.
    const callPromise = Promise.resolve().then(() => triggerIii({ action, payload }));

    let data;
    if (timeoutMs && timeoutMs > 0) {
      const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => reject(TIMEOUT), timeoutMs);
      });
      data = await Promise.race([callPromise, timeoutPromise]);
    } else {
      data = await callPromise;
    }
    return { lane, action, status: 'ok', data, duration_ms: elapsed(start) };
  } catch (err) {
    if (err === TIMEOUT) {
      return {
        lane,
        action,
        status: 'timeout',
        error: `timed out after ${timeoutMs}ms`,
        duration_ms: elapsed(start),
      };
    }
    return {
      lane,
      action,
      status: 'error',
      error: err && err.message ? err.message : String(err),
      duration_ms: elapsed(start),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Run a batch of worker calls concurrently.
 *
 * @param {Array<{lane:string, action:string, payload?:object, timeout_ms?:number}>} calls
 * @param {{ triggerIii?: Function, timeout_ms?: number }} options
 * @returns {Promise<{ results: Array<object>, summary: object }>}
 */
export async function runParallelCalls(calls, { triggerIii, timeout_ms } = {}) {
  const list = Array.isArray(calls) ? calls : [];
  const overallStart = now();

  const settled = await Promise.allSettled(
    list.map((call) => runOne(call, triggerIii, timeout_ms)),
  );

  // runOne never throws, but guard the rejected branch defensively.
  const results = settled.map((s, i) => {
    if (s.status === 'fulfilled') return s.value;
    const call = list[i] || {};
    return {
      lane: call.lane !== undefined ? call.lane : null,
      action: call.action,
      status: 'error',
      error: s.reason && s.reason.message ? s.reason.message : String(s.reason),
      duration_ms: 0,
    };
  });

  const summary = {
    total: results.length,
    ok: results.filter((r) => r.status === 'ok').length,
    error: results.filter((r) => r.status === 'error').length,
    timeout: results.filter((r) => r.status === 'timeout').length,
    total_duration_ms: Math.round(now() - overallStart),
  };

  return { results, summary };
}
