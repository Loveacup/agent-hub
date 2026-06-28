// Phase 5 Runtime Orchestrator — CC run manifest helpers
import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { normalizeConstraints } from './run-constraints.mjs';

export const DEFAULT_RUN_BASE_DIR = '/tmp/agent-hub-runs';

function iso(now = new Date()) {
  return now instanceof Date ? now.toISOString() : new Date(now).toISOString();
}

export function buildRunId({ now = new Date(), suffix = randomBytes(3).toString('hex') } = {}) {
  const d = now instanceof Date ? now : new Date(now);
  const compact = d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, '').replace('T', '-');
  return `ccrun-${compact}-${suffix}`;
}

export function buildRunPaths({ base_dir = DEFAULT_RUN_BASE_DIR, run_id } = {}) {
  if (!run_id) throw new Error('run_id is required');
  const run_dir = join(base_dir, run_id);
  return {
    run_dir,
    manifest: join(run_dir, 'manifest.json'),
    watch: join(run_dir, 'watch.jsonl'),
    suggestions: join(run_dir, 'suggestions.jsonl'),
    interventions: join(run_dir, 'interventions.jsonl'),
    final: join(run_dir, 'final.json'),
  };
}

export function buildInitialManifest({
  run_id,
  target,
  task,
  context_path,
  topic = '',
  effort = 'high',
  paths,
  constraints,
  now = new Date(),
} = {}) {
  if (!run_id) throw new Error('run_id is required');
  if (!target) throw new Error('target is required');
  if (!task) throw new Error('task is required');
  if (!context_path) throw new Error('context_path is required');
  if (!isAbsolute(context_path)) throw new Error('context_path must be absolute');
  if (!paths) throw new Error('paths is required');
  const ts = iso(now);
  const normalizedConstraints = normalizeConstraints(constraints);
  return {
    kind: 'agent_hub.cc_run_manifest',
    run_id,
    created_at: ts,
    updated_at: ts,
    target,
    topic,
    task,
    context_path,
    effort,
    status: 'starting',
    paths,
    constraints: normalizedConstraints,
    history: [
      { status: 'starting', ts },
    ],
  };
}

export async function writeManifest(manifest) {
  if (!manifest?.paths?.manifest || !manifest?.paths?.run_dir) throw new Error('manifest.paths.manifest and run_dir are required');
  await mkdir(manifest.paths.run_dir, { recursive: true });
  await writeFile(manifest.paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest.paths.manifest;
}

export function updateManifestStatus(manifest, { status, session_id, now = new Date(), extra = {} } = {}) {
  if (!manifest) throw new Error('manifest is required');
  if (!status) throw new Error('status is required');
  const ts = iso(now);
  const history = Array.isArray(manifest.history) ? [...manifest.history] : [];
  history.push({ status, ts, ...(session_id ? { session_id } : {}), ...extra });
  return {
    ...manifest,
    ...extra,
    ...(session_id ? { session_id } : {}),
    status,
    updated_at: ts,
    history,
  };
}
