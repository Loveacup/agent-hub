// Phase 3b cc-worker — control event publishing tests (RED phase)
import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  buildControlSubject,
  callAndPublishControl,
} = await (async () => {
  try {
    return await import('../src/controlEvents.js');
  } catch {
    return { buildControlSubject: null, callAndPublishControl: null };
  }
})();

test('buildControlSubject maps actions to stable NATS subjects', () => {
  assert.ok(buildControlSubject, 'buildControlSubject must be implemented');
  assert.equal(buildControlSubject('bridge_status'), 'agent.cc.control.bridge_status');
  assert.equal(buildControlSubject('monitor'), 'agent.cc.control.monitor');
  assert.equal(buildControlSubject('intervene'), 'agent.cc.control.intervene');
  assert.equal(buildControlSubject('execute'), 'agent.cc.control.execute');
  assert.equal(buildControlSubject('interrupt'), 'agent.cc.control.interrupt');
});

test('callAndPublishControl publishes successful control result without changing payload', async () => {
  assert.ok(callAndPublishControl, 'callAndPublishControl must be implemented');
  const published = [];
  const result = await callAndPublishControl('monitor', async () => ({ kind: 'cc.monitor', status: 'ok', session_id: 's' }), {
    publishFn: async (subject, payload) => published.push({ subject, payload }),
  });

  assert.equal(result.kind, 'cc.monitor');
  assert.equal(result.status, 'ok');
  assert.equal(result.event_published, true);
  assert.equal(published.length, 1);
  assert.equal(published[0].subject, 'agent.cc.control.monitor');
  assert.equal(published[0].payload.kind, 'cc.monitor');
});

test('callAndPublishControl keeps control result when NATS publish fails', async () => {
  const result = await callAndPublishControl('intervene', async () => ({ kind: 'cc.intervention', status: 'sent', session_id: 's' }), {
    publishFn: async () => { throw new Error('ECONNREFUSED'); },
  });

  assert.equal(result.kind, 'cc.intervention');
  assert.equal(result.status, 'sent');
  assert.equal(result.event_published, false);
  assert.equal(result.event_publish_error, 'ECONNREFUSED');
});
