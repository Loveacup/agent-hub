// Phase 6 Slice 5 NATS publisher tests (RED phase)
import { test } from 'node:test';
import assert from 'node:assert/strict';

const mod = await import('../src/nats.js').catch(() => ({}));
const { buildNatsPublishFrame, publishNatsJson } = mod;

test('buildNatsPublishFrame builds exact NATS PUB frame with byte length', () => {
  assert.ok(buildNatsPublishFrame, 'buildNatsPublishFrame must be implemented');
  const payload = JSON.stringify({ msg: '你好' });
  const frame = buildNatsPublishFrame('agent.route.decision', payload);
  assert.equal(frame.toString(), `PUB agent.route.decision ${Buffer.byteLength(payload)}\r\n${payload}\r\n`);
});

test('publishNatsJson writes INFO handshake then PUB frame', async () => {
  assert.ok(publishNatsJson, 'publishNatsJson must be implemented');
  const writes = [];
  const fakeSocket = {
    onceHandlers: {},
    setTimeout(ms) { this.timeout = ms; return this; },
    once(event, cb) { this.onceHandlers[event] = cb; return this; },
    write(data) { writes.push(Buffer.isBuffer(data) ? data.toString() : String(data)); return true; },
    end() { this.ended = true; },
    destroy() { this.destroyed = true; },
  };
  const connect = () => fakeSocket;
  const promise = publishNatsJson({
    subject: 'agent.route.decision',
    payload: { lane: 'review' },
    connect,
    timeout_ms: 100,
  });
  fakeSocket.onceHandlers.data(Buffer.from('INFO {"server_id":"test"}\r\n'));
  const result = await promise;
  assert.equal(result.status, 'published');
  assert.equal(writes[0], 'PUB agent.route.decision 17\r\n{"lane":"review"}\r\n');
  assert.equal(fakeSocket.ended, true);
});
