#!/usr/bin/env node
// Phase 5 Runtime Orchestrator — run CC task skeleton.
// Slice 2: parse args, validate context, create run manifest. Does not call iii unless future slices enable it.
import { isAbsolute } from 'node:path';
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

function usage() {
  return `Usage: run-cc-task.mjs --target <name> --task <text> --context <absolute-path> [options]\n\nOptions:\n  --topic <topic-id>\n  --effort <high|medium|low>       default: high\n  --base-dir <dir>                 default: ${DEFAULT_RUN_BASE_DIR}\n  --iii-bin <path>                 default: ${DEFAULT_III_BIN}\n  --iii-address <host>             default: localhost\n  --iii-port <port>                default: 49134\n  --timeout-ms <ms>                default: 60000\n  --init-only                      create manifest only; do not call iii/CC\n  --help, -h\n`;
}

function parseArgs(argv) {
  const args = { effort: 'high', base_dir: DEFAULT_RUN_BASE_DIR, init_only: false, iii_bin: DEFAULT_III_BIN, iii_address: 'localhost', iii_port: 49134, timeout_ms: 60_000 };
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
    else if (a === '--init-only') args.init_only = true;
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
    manifest_path: paths.manifest,
    watch_path: paths.watch,
    suggestions_path: paths.suggestions,
    interventions_path: paths.interventions,
    final_path: paths.final,
    ...extra,
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
      },
      address: args.iii_address,
      port: args.iii_port,
      timeout_ms: args.timeout_ms,
    });
    if (execute?.lifecycle_state !== 'sent_not_completed') {
      const error = `execute did not return sent_not_completed: ${execute?.lifecycle_state || execute?.status || 'unknown'}`;
      manifest = updateManifestStatus(manifest, { status: 'failed', extra: { error, execute } });
      await writeManifest(manifest);
      await writeFinal(paths, { kind: 'agent_hub.cc_run_final', status: 'failed', run_id, error, execute });
      process.stdout.write(`${JSON.stringify(outputPayload({ manifest, paths, extra: { error } }))}\n`);
      process.exit(1);
    }

    manifest = updateManifestStatus(manifest, { status: 'watching', session_id: execute.session_id || '' });
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
