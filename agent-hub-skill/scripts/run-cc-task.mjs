#!/usr/bin/env node
// Phase 5 Runtime Orchestrator — run single CC task.
// Current slice: manifest → bridge_status → execute → detached watcher spawn.
import { execPath } from 'node:process';
import { isAbsolute } from 'node:path';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import {
  buildInitialManifest,
  buildRunId,
  buildRunPaths,
  DEFAULT_RUN_BASE_DIR,
  updateManifestStatus,
  writeManifest,
} from './lib/cc-run-manifest.mjs';
import { DEFAULT_III_BIN, triggerIii } from './lib/iii-client.mjs';

const DEFAULT_WATCHER_BIN = new URL('./cc-watch-session.mjs', import.meta.url).pathname;

function usage() {
  return `Usage: run-cc-task.mjs --target <name> --task <text> --context <absolute-path> [options]\n\nOptions:\n  --topic <topic-id>\n  --effort <high|medium|low>       default: high\n  --base-dir <dir>                 default: ${DEFAULT_RUN_BASE_DIR}\n  --iii-bin <path>                 default: ${DEFAULT_III_BIN}\n  --iii-address <host>             default: localhost\n  --iii-port <port>                default: 49134\n  --timeout-ms <ms>                default: 60000\n  --watcher-bin <path>             default: ${DEFAULT_WATCHER_BIN}\n  --watch-interval-ms <ms>         default: 15000\n  --watch-max-ticks <n>            default: 120\n  --watch-stale-after-ticks <n>    default: 8\n  --bridge-check-only              check bridge_status only; do not execute or spawn watcher\n  --init-only                      create manifest only; do not call iii/CC\n  --help, -h\n  --ack-active                     pass ack_active=true to cc::execute (acknowledge active sessions)\n`;
}

function parseArgs(argv) {
  const args = { effort: 'high', base_dir: DEFAULT_RUN_BASE_DIR, init_only: false, bridge_check_only: false, ack_active: false, iii_bin: DEFAULT_III_BIN, iii_address: 'localhost', iii_port: 49134, timeout_ms: 60_000, watcher_bin: DEFAULT_WATCHER_BIN, watch_interval_ms: 15_000, watch_max_ticks: 120, watch_stale_after_ticks: 8 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--target') args.target = argv[++i];
    else if (a === '--task') args.task = argv[++i];
    else if (a === '--context') args.context_path = argv[++i];
    else if (a === '--topic') args.topic = argv[++i];
    else if (a === '--effort') args.effort = argv[++i];
    else if (a === '--base-dir') args.base_dir = argv[++i];
    else if (a === '--iii-bin') args.iii_bin = argv[++i];
    else if (a === '--iii-address') args.iii_address = argv[++i];
    else if (a === '--iii-port') args.iii_port = Number(argv[++i]);
    else if (a === '--timeout-ms') args.timeout_ms = Number(argv[++i]);
    else if (a === '--watcher-bin') args.watcher_bin = argv[++i];
    else if (a === '--watch-interval-ms') args.watch_interval_ms = Number(argv[++i]);
    else if (a === '--watch-max-ticks') args.watch_max_ticks = Number(argv[++i]);
    else if (a === '--watch-stale-after-ticks') args.watch_stale_after_ticks = Number(argv[++i]);
    else if (a === '--bridge-check-only') args.bridge_check_only = true;
    else if (a === '--init-only') args.init_only = true;
    else if (a === '--ack-active') args.ack_active = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else throw new Error(`unknown arg: ${a}`);
  }
  return args;
}

function validateArgs(args) {
  const missing = [];
  if (!args.target) missing.push('--target');
  if (!args.task) missing.push('--task');
  if (!args.context_path) missing.push('--context');
  if (missing.length) throw new Error(`missing required args: ${missing.join(', ')}`);
  if (!isAbsolute(args.context_path)) throw new Error('context path must be absolute');
  if (!isAbsolute(args.base_dir)) throw new Error('base dir must be absolute');
}

async function writeFinal(paths, payload) {
  await writeFile(paths.final, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return paths.final;
}

function outputPayload({ manifest, paths, extra = {} }) {
  return {
    kind: 'agent_hub.cc_run',
    status: manifest.status,
    run_id: manifest.run_id,
    ...(manifest.session_id ? { session_id: manifest.session_id } : {}),
    ...(manifest.watcher?.pid ? { watcher_pid: manifest.watcher.pid, watcher_command: manifest.watcher.command } : {}),
    manifest_path: paths.manifest,
    watch_path: paths.watch,
    suggestions_path: paths.suggestions,
    interventions_path: paths.interventions,
    final_path: paths.final,
    ...extra,
  };
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function buildWatcherArgs({ session_id, paths, args }) {
  const watcherArgs = [
    '--session', session_id,
    '--interval-ms', String(args.watch_interval_ms),
    '--max-ticks', String(args.watch_max_ticks),
    '--output', paths.watch,
  ];
  if (args.watch_stale_after_ticks > 0) {
    watcherArgs.push('--stale-after-ticks', String(args.watch_stale_after_ticks));
  }
  return watcherArgs;
}

function spawnWatcher({ session_id, paths, args }) {
  const watcherArgs = buildWatcherArgs({ session_id, paths, args });
  const child = spawn(execPath, [args.watcher_bin, ...watcherArgs], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return {
    pid: child.pid,
    bin: args.watcher_bin,
    args: watcherArgs,
    output: paths.watch,
    command: [execPath, args.watcher_bin, ...watcherArgs].map(shellQuote).join(' '),
  };
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
    process.exit(0);
  }

  let manifest;
  let paths;
  let run_id;
  try {
    validateArgs(args);

    run_id = buildRunId();
    paths = buildRunPaths({ base_dir: args.base_dir, run_id });
    manifest = buildInitialManifest({
      run_id,
      target: args.target,
      task: args.task,
      context_path: args.context_path,
      topic: args.topic || '',
      effort: args.effort,
      paths,
    });
    await writeManifest(manifest);

    if (args.init_only) {
      process.stdout.write(`${JSON.stringify(outputPayload({ manifest, paths }))}\n`);
      return;
    }

    manifest = updateManifestStatus(manifest, { status: 'bridge_checking' });
    await writeManifest(manifest);
    const bridge = await triggerIii({
      iii_bin: args.iii_bin,
      action: 'cc::bridge_status',
      payload: {},
      address: args.iii_address,
      port: args.iii_port,
      timeout_ms: args.timeout_ms,
    });
    if (bridge?.status !== 'ok') {
      const error = `bridge_status failed: ${bridge?.error || bridge?.status || 'unknown'}`;
      manifest = updateManifestStatus(manifest, { status: 'failed', extra: { error } });
      await writeManifest(manifest);
      await writeFinal(paths, { kind: 'agent_hub.cc_run_final', status: 'failed', run_id, error, bridge });
      process.stdout.write(`${JSON.stringify(outputPayload({ manifest, paths, extra: { error } }))}\n`);
      process.exit(1);
    }

    if (args.bridge_check_only) {
      manifest = updateManifestStatus(manifest, { status: 'bridge_ok', extra: { bridge_check_only: true, bridge } });
      await writeManifest(manifest);
      await writeFinal(paths, { kind: 'agent_hub.cc_run_final', status: 'bridge_ok', run_id, bridge_check_only: true, bridge });
      process.stdout.write(`${JSON.stringify(outputPayload({ manifest, paths, extra: { bridge_check_only: true } }))}\n`);
      return;
    }

    manifest = updateManifestStatus(manifest, { status: 'executing' });
    await writeManifest(manifest);
    const execute = await triggerIii({
      iii_bin: args.iii_bin,
      action: 'cc::execute',
      payload: {
        target: args.target,
        task: args.task,
        context_path: args.context_path,
        topic: args.topic || '',
        effort: args.effort,
        ack_active: args.ack_active,
      },
      address: args.iii_address,
      port: args.iii_port,
      timeout_ms: args.timeout_ms,
    });
    if (execute?.lifecycle_state === 'active_sessions_require_ack' || execute?.error === 'active_sessions_require_ack') {
      const error = 'active_sessions_require_ack';
      manifest = updateManifestStatus(manifest, { status: 'blocked', extra: { error, execute } });
      await writeManifest(manifest);
      await writeFinal(paths, { kind: 'agent_hub.cc_run_final', status: 'blocked', run_id, error, execute });
      process.stdout.write(`${JSON.stringify(outputPayload({ manifest, paths, extra: { error } }))}\n`);
      process.exit(3);
    }
    if (execute?.lifecycle_state !== 'sent_not_completed') {
      const error = `execute did not return sent_not_completed: ${execute?.lifecycle_state || execute?.status || 'unknown'}`;
      manifest = updateManifestStatus(manifest, { status: 'failed', extra: { error, execute } });
      await writeManifest(manifest);
      await writeFinal(paths, { kind: 'agent_hub.cc_run_final', status: 'failed', run_id, error, execute });
      process.stdout.write(`${JSON.stringify(outputPayload({ manifest, paths, extra: { error } }))}\n`);
      process.exit(1);
    }

    const session_id = execute.session_id || '';
    const watcher = spawnWatcher({ session_id, paths, args });
    manifest = updateManifestStatus(manifest, { status: 'watching', session_id, extra: { watcher } });
    await writeManifest(manifest);
    process.stdout.write(`${JSON.stringify(outputPayload({ manifest, paths }))}\n`);
  } catch (err) {
    if (manifest && paths) {
      const error = err?.message || String(err);
      manifest = updateManifestStatus(manifest, { status: 'failed', extra: { error } });
      await writeManifest(manifest);
      await writeFinal(paths, { kind: 'agent_hub.cc_run_final', status: 'failed', run_id, error });
      process.stdout.write(`${JSON.stringify(outputPayload({ manifest, paths, extra: { error } }))}\n`);
      process.exit(1);
    }
    process.stderr.write(`${err.message}\n`);
    process.exit(2);
  }
}

main().catch((err) => {
  process.stderr.write(`${err?.message || String(err)}\n`);
  process.exit(1);
});
