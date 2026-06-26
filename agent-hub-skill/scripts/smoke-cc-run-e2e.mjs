#!/usr/bin/env node
// Phase 5 Runtime Orchestrator — fake end-to-end smoke.
// Orchestrates run → watcher output → collect → approved intervention archive without real CC.
import { execFile } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { DEFAULT_III_BIN } from './lib/iii-client.mjs';

const RUN_SCRIPT = new URL('./run-cc-task.mjs', import.meta.url).pathname;
const COLLECT_SCRIPT = new URL('./collect-cc-run-events.mjs', import.meta.url).pathname;
const INTERVENE_SCRIPT = new URL('./archive-cc-intervention.mjs', import.meta.url).pathname;
const DEFAULT_WATCHER_BIN = new URL('./cc-watch-session.mjs', import.meta.url).pathname;

function usage() {
  return `Usage: smoke-cc-run-e2e.mjs [options]\n\nOptions:\n  --base-dir <dir>\n  --iii-bin <path>\n  --watcher-bin <path>\n  --topic <topic>\n`;
}

function parseArgs(argv) {
  const args = {
    base_dir: join(tmpdir(), `agent-hub-e2e-${randomBytes(3).toString('hex')}`),
    iii_bin: DEFAULT_III_BIN,
    watcher_bin: DEFAULT_WATCHER_BIN,
    topic: '58478',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--base-dir') args.base_dir = argv[++i];
    else if (a === '--iii-bin') args.iii_bin = argv[++i];
    else if (a === '--watcher-bin') args.watcher_bin = argv[++i];
    else if (a === '--topic') args.topic = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
    else throw new Error(`unknown arg: ${a}`);
  }
  return args;
}

function runNode(script, args) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [script, ...args], { timeout: 20_000, maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function waitForFile(path, attempts = 40) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const s = await stat(path);
      if (s.size > 0) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`file did not appear: ${path}`);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}\n${usage()}`);
    process.exit(2);
  }
  if (args.help) {
    process.stdout.write(usage());
    return;
  }

  const context_path = join(args.base_dir, 'context.md');
  await mkdir(args.base_dir, { recursive: true });
  await writeFile(context_path, 'fake e2e smoke context\n', 'utf8');

  const runRes = await runNode(RUN_SCRIPT, [
    '--target', 'agent-hub',
    '--task', 'fake e2e smoke',
    '--context', context_path,
    '--topic', args.topic,
    '--effort', 'high',
    '--base-dir', args.base_dir,
    '--iii-bin', args.iii_bin,
    '--watcher-bin', args.watcher_bin,
    '--watch-interval-ms', '10',
    '--watch-max-ticks', '1',
  ]);
  const run = JSON.parse(runRes.stdout);
  await waitForFile(run.watch_path);

  const collectRes = await runNode(COLLECT_SCRIPT, ['--manifest', run.manifest_path]);
  const collect = JSON.parse(collectRes.stdout);

  const suggestionsText = await readFile(collect.suggestions_path, 'utf8');
  const firstSuggestion = JSON.parse(suggestionsText.trim().split('\n')[0]);
  const suggestion = firstSuggestion.suggestion;
  const message = suggestion.message || 'please summarize current state';
  const reason = suggestion.reason || 'operator approved suggestion';
  const monitorSnapshotId = suggestion.monitor_snapshot_id || 'unknown';

  const interventionRes = await runNode(INTERVENE_SCRIPT, [
    '--manifest', run.manifest_path,
    '--session', run.session_id,
    '--message', message,
    '--reason', reason,
    '--monitor-snapshot-id', monitorSnapshotId,
    '--iii-bin', args.iii_bin,
    '--confirm',
  ]);
  const intervention = JSON.parse(interventionRes.stdout);
  const manifest = await readJson(run.manifest_path);

  process.stdout.write(`${JSON.stringify({
    kind: 'agent_hub.cc_run_e2e_smoke',
    status: intervention.status,
    run,
    collect,
    intervention,
    paths: manifest.paths,
  })}\n`);
}

main().catch((err) => {
  process.stderr.write(`${err?.message || String(err)}\n${err?.stderr || ''}`);
  process.exit(1);
});
