// Phase 3 cc-worker — scan module
// Reads /tmp/cc-status-* files, parses cc-tmux state, provides fallback.
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { basename } from 'node:path';

const HEARTBEAT_FRESH_MS = 5 * 60_000; // 5 minutes
const CC_STATUS_PREFIX = 'cc-status-';
const CC_TMP_DIR = '/tmp';

/**
 * Read and parse a single cc-status JSON file.
 * Returns null if the file doesn't exist or is unreadable.
 *
 * @param {string} path
 * @returns {Promise<object|null>}
 */
export async function readStatusFile(path) {
  try {
    const raw = await readFile(path, 'utf-8');
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      // Return a sentinel so scanSessions can emit observer_error
      return { _json_error: true, path };
    }
    data._source = 'file';
    data._path = path;
    return data;
  } catch {
    return null;
  }
}

/**
 * Parse raw status data into the standard session shape.
 *
 * @param {object} raw — from cc-status JSON
 * @returns {{ session_id: string, state: string, heartbeat_fresh: boolean, observer_error: string|null, _source: string, status_path: string }}
 */
export function parseStatusFile(raw) {
  const now = Date.now();
  const lastHb = raw.last_heartbeat ? new Date(raw.last_heartbeat).getTime() : 0;
  const heartbeatFresh = (now - lastHb) < HEARTBEAT_FRESH_MS;

  return {
    session_id: raw.session_id || 'unknown',
    state: raw.state || 'UNKNOWN',
    heartbeat_fresh: heartbeatFresh,
    observer_error: null,
    _source: raw._source || 'file',
    status_path: raw.status_path || '',
    turn_done_path: raw.turn_done_path || '',
  };
}

/**
 * Scan /tmp for cc-status-* files and return parsed sessions.
 *
 * @param {string} [dir='/tmp'] — directory to scan
 * @returns {Promise<object[]>}
 */
export async function scanSessions(dir = CC_TMP_DIR) {
  try {
    const entries = await readdir(dir);
    const statusFiles = entries.filter((e) => e.startsWith(CC_STATUS_PREFIX) && e.endsWith('.json'));

    const sessions = [];
    for (const file of statusFiles) {
      const path = join(dir, file);
      const raw = await readStatusFile(path);

      if (!raw) {
        sessions.push(fallbackStatus(file, 'UNKNOWN', 'file not readable'));
        continue;
      }

      if (raw._json_error) {
        sessions.push(fallbackStatus(file, 'UNKNOWN', 'invalid JSON'));
        continue;
      }

      try {
        const parsed = parseStatusFile(raw);
        parsed.status_path = path;
        sessions.push(parsed);
      } catch (err) {
        sessions.push(fallbackStatus(file, 'UNKNOWN', `parse error: ${err.message}`));
      }
    }

    return sessions;
  } catch (err) {
    // Directory doesn't exist or not readable — return empty
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

/**
 * Build a fallback session entry when cc-status file is missing or corrupt.
 * Uses tmux capture-pane when available, otherwise marks observer_error.
 *
 * @param {string} sessionId
 * @param {string} state
 * @param {string} [observerError]
 * @returns {{ session_id: string, state: string, heartbeat_fresh: boolean, observer_error: string|null, _source: string }}
 */
export function fallbackStatus(sessionId, state, observerError = null) {
  let error;
  if (observerError) {
    error = observerError;
  } else if (state === 'UNKNOWN') {
    error = 'state UNKNOWN from fallback';
  } else {
    error = null;
  }

  return {
    session_id: sessionId,
    state: state,
    heartbeat_fresh: true, // assume fresh when falling back — we can't tell
    observer_error: error,
    _source: 'fallback',
    status_path: '',
    turn_done_path: '',
  };
}

/**
 * Run tmux capture-pane to get raw pane content as fallback.
 *
 * @param {string} sessionId
 * @returns {Promise<string>}
 */
export async function capturePaneFallback(sessionId) {
  return new Promise((resolve) => {
    execFile('tmux', ['capture-pane', '-t', sessionId, '-p'], {
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    }, (err, stdout) => {
      if (err) {
        resolve('');
        return;
      }
      resolve(stdout.trim());
    });
  });
}
