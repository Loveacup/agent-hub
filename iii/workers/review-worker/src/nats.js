// Minimal NATS JSON publisher for review-worker audit events.
import net from 'node:net';

export function buildNatsPublishFrame(subject, payloadText) {
  const text = String(payloadText ?? '');
  return Buffer.from(`PUB ${subject} ${Buffer.byteLength(text)}\r\n${text}\r\n`);
}

export function publishNatsJson({
  subject,
  payload,
  host = process.env.NATS_HOST || 'localhost',
  port = Number(process.env.NATS_PORT || 4222),
  timeout_ms = Number(process.env.NATS_TIMEOUT_MS || 1000),
  connect = net.createConnection,
} = {}) {
  if (!subject) throw new Error('subject is required');
  const payloadText = JSON.stringify(payload ?? {});
  const frame = buildNatsPublishFrame(subject, payloadText);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      try { socket.end(); } catch {}
      resolve(result);
    };
    const socket = connect({ host, port });
    socket.setTimeout(timeout_ms);
    socket.once('data', () => {
      socket.write(frame);
      finish({ status: 'published', subject, bytes: frame.length });
    });
    socket.once('timeout', () => {
      try { socket.destroy(); } catch {}
      finish({ status: 'publish_failed', subject, error: 'timeout' });
    });
    socket.once('error', (err) => {
      finish({ status: 'publish_failed', subject, error: err?.message ?? String(err) });
    });
  });
}
