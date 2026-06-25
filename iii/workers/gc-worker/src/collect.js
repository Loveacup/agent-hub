// Phase 2 gc-worker — orchestration + side-effect boundary
// Real fs/process/NATS calls are isolated here and injectable for tests.
import { execFile } from 'node:child_process';
import { connect } from 'node:net';
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  classifyRuntimeArtifacts,
  planGcActions,
  buildGcReport,
  executePlan,
} from './gc.js';

const NATS_SUBJECT = 'agent.gc.report';
const NATS_SERVER = process.env.NATS_URL || 'nats://100.96.0.1:4222';

export function buildNatsPublishFrame(subject, payload) {
  const body = JSON.stringify(payload);
  return `PUB ${subject} ${Buffer.byteLength(body)}\r\n${body}\r\n`;
}

function parseNatsUrl(url = NATS_SERVER) {
  const u = new URL(url);
  return { host: u.hostname, port: Number(u.port || 4222) };
}

export function defaultPublish(subject, payload) {
  const { host, port } = parseNatsUrl(process.env.NATS_URL || NATS_SERVER);
  const frame = buildNatsPublishFrame(subject, payload);

  return new Promise((resolve, reject) => {
    const socket = connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`NATS publish timeout ${host}:${port}`));
    }, 5000);

    socket.on('connect', () => {
      socket.write(frame, () => {
        clearTimeout(timer);
        socket.destroy();
        resolve();
      });
    });
    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    socket.on('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function execFileText(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: 'utf8', maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve('');
      return resolve(stdout || '');
    });
  });
}

async function listTmpCcArtifacts({ tmpDir = '/tmp' } = {}) {
  const entries = await readdir(tmpDir, { withFileTypes: true });
  const ccEntries = entries.filter((entry) => entry.name.startsWith('cc-'));
  const artifacts = [];

  for (const entry of ccEntries) {
    const path = join(tmpDir, entry.name);
    const s = await stat(path);
    artifacts.push({
      kind: 'file',
      path,
      mtimeMs: s.mtimeMs,
      size: s.size,
      isDirectory: entry.isDirectory(),
    });
  }
  return artifacts;
}

async function listProcesses() {
  const output = await execFileText('ps', ['-axo', 'pid=,comm=,args=']);
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [pidText, comm, ...args] = line.split(/\s+/);
      return {
        kind: 'process',
        pid: Number(pidText),
        name: [comm, ...args].join(' '),
        path: null,
      };
    })
    .filter((item) => Number.isFinite(item.pid));
}

export async function defaultCollectArtifacts() {
  const artifacts = [];
  try {
    artifacts.push(...await listTmpCcArtifacts());
  } catch {
    // Best-effort scanner: inability to read /tmp should not make iii trigger fail.
  }
  try {
    artifacts.push(...await listProcesses());
  } catch {
    // Same: process listing is advisory evidence, not a hard dependency.
  }
  return artifacts;
}

function normalizeActivePids(activePids = new Set([process.pid])) {
  if (activePids instanceof Set) return activePids;
  if (Array.isArray(activePids)) return new Set(activePids.map(Number));
  return new Set([process.pid]);
}

export async function runScan({
  collectArtifacts = defaultCollectArtifacts,
  publishFn = defaultPublish,
  now = Date.now(),
  nowIso = new Date(now).toISOString(),
  activePids = new Set([process.pid]),
  ttlMs,
} = {}) {
  const artifacts = await collectArtifacts();
  const classified = classifyRuntimeArtifacts(artifacts, { now, activePids: normalizeActivePids(activePids), ttlMs });
  const blocked = classified.filter((item) => item.status === 'blocked');
  const actions = planGcActions(classified);
  const report = buildGcReport(actions, { ts: nowIso, blocked });
  await publishFn(NATS_SUBJECT, report);
  return report;
}

export async function runPlan(options = {}) {
  return runScan(options);
}

async function statForExecute(path) {
  try {
    const s = await stat(path);
    return { mtimeMs: s.mtimeMs, isDirectory: s.isDirectory(), size: s.size };
  } catch {
    return null;
  }
}

export async function runExecute({
  actions = [],
  confirm = false,
  confirmedActionIds = new Set(),
  deleteFile = async (path) => rm(path, { force: true, recursive: false }),
  killProcess = async (pid) => process.kill(pid, 'SIGTERM'),
  statPath = statForExecute,
} = {}) {
  return executePlan(actions, { confirm, confirmedActionIds, deleteFile, killProcess, statPath });
}
