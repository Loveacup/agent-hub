// Phase 3 cc-worker — publish module
// NATS PUB frame builder, subject sanitization, status payloads, tmux discovery.
import { createConnection } from 'node:net';

/**
 * Sanitize a NATS subject token — alphanumeric, hyphens, underscores only.
 * No dots, spaces, asterisks, or greater-than signs.
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
 * Build a raw TCP NATS PUB frame.
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
 * Publish a frame to NATS via raw TCP. Fire-and-forget.
 *
 * @param {string} subject
 * @param {object} payload
 * @param {{ host?: string, port?: number }} [opts]
 * @returns {Promise<void>}
 */
export async function publishFrame(subject, payload, { host = '127.0.0.1', port = 4222 } = {}) {
  const frame = buildNatsPublishFrame(subject, payload);
  return new Promise((resolve, reject) => {
    const sock = createConnection({ host, port }, () => {
      sock.write(frame, (err) => {
        sock.destroy();
        if (err) return reject(err);
        resolve();
      });
    });
    sock.on('error', reject);
  });
}

/**
 * Build a pool-level cc.status payload from session list.
 * Strips internal fields (_source).
 *
 * @param {object[]} sessions
 * @returns {{ kind: string, source: string, sessions: object[], ts: string }}
 */
export function buildPoolStatus(sessions = []) {
  return {
    kind: 'cc.status',
    source: 'cc-worker',
    sessions: sessions.map((s) => {
      const { _source, ...rest } = s;
      return rest;
    }),
    ts: new Date().toISOString(),
  };
}

/**
 * Build a per-session NATS status payload with subject.
 * Returns null if session_id cannot be parsed into agent/topic.
 *
 * @param {object} session
 * @returns {{ subject: string, payload: object }|null}
 */
export function buildSessionStatus(session) {
  // session_id format: hermes-cc-<agent>-<topic>[-...]
  const match = session.session_id?.match(/^hermes-cc-([\w-]+?)-(.+)$/);
  if (!match) return null;

  const agent = sanitizeSubjectToken(match[1]);
  const topic = sanitizeSubjectToken(match[2]);
  const sessionTok = sanitizeSubjectToken(session.session_id);

  return {
    subject: `agent.cc.${agent}.${topic}.${sessionTok}.status`,
    payload: buildPoolStatus([session]),
  };
}

/**
 * Parse `tmux list-sessions` output and filter to hermes-cc-* sessions.
 *
 * @param {string[]} lines — output of `tmux list-sessions -F '#{session_name}'`
 * @returns {string[]}
 */
export function discoverSessions(lines = []) {
  return lines
    .map((l) => l.split(':')[0]?.trim())
    .filter((name) => name && name.startsWith('hermes-cc-'));
}
