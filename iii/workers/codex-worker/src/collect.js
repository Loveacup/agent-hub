// Phase 4 codex-worker — collect module
// NATS PUB frame builder, subject sanitization, status/report payloads.
import { createConnection } from 'node:net';

/**
 * Build a raw TCP NATS PUB frame (not via nats CLI).
 *
 * @param {string} subject
 * @param {object} payload
 * @returns {string}
 */
export function buildNatsPublishFrame(subject, payload) {
  const body = JSON.stringify(payload);
  const len = Buffer.byteLength(body);
  return `PUB ${subject} ${len}\r\n${body}\r\n`;
}

/**
 * Publish a frame to NATS via raw TCP.
 * Fire-and-forget — no ack expected.
 *
 * @param {string} subject
 * @param {object} payload
 * @param {{ host?: string, port?: number }} [opts]
 * @returns {Promise<void>}
 */
export async function publishToNats(subject, payload, { host = '127.0.0.1', port = 4222 } = {}) {
  const frame = buildNatsPublishFrame(subject, payload);

  return new Promise((resolve, reject) => {
    const sock = createConnection({ host, port }, () => {
      sock.write(frame, (err) => {
        if (err) {
          sock.destroy();
          return reject(err);
        }
        sock.destroy();
        resolve();
      });
    });
    sock.on('error', reject);
  });
}

/**
 * Sanitize a NATS subject token — alphanumeric, hyphens, underscores only.
 *
 * @param {string} token
 * @returns {string}
 */
export function sanitizeSubjectToken(token) {
  if (typeof token !== 'string') return '';
  if (token === '') return '';
  if (/[. *>]/.test(token)) {
    throw new Error(`invalid subject token: ${token}`);
  }
  return token;
}

/**
 * Build a codex.status payload.
 *
 * @param {object[]} jobs
 * @returns {{ kind: string, source: string, jobs: object[], ts: string }}
 */
export function buildCodexStatus(jobs = []) {
  return {
    kind: 'codex.status',
    source: 'codex-worker',
    jobs: jobs.map((j) => ({
      job_id: j.job_id,
      state: j.state,
      workdir: j.workdir,
      started_at: j.started_at,
    })),
    ts: new Date().toISOString(),
  };
}

/**
 * Build a codex.retention_report payload.
 *
 * @param {{ sessions_count: number, bytes: number, oldest: string, newest: string }} data
 * @returns {{ kind: string, source: string, sessions_count: number, bytes: number, oldest: string, newest: string, recommendations: string[], ts: string }}
 */
export function buildRetentionReport(data = {}) {
  return {
    kind: 'codex.retention_report',
    source: 'codex-worker',
    sessions_count: data.sessions_count ?? 0,
    bytes: data.bytes ?? 0,
    oldest: data.oldest ?? '',
    newest: data.newest ?? '',
    recommendations: [],
    ts: new Date().toISOString(),
  };
}
