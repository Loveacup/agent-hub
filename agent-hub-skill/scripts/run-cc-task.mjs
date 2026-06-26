#!/usr/bin/env node
// Phase 5 Runtime Orchestrator — run CC task skeleton.
// Slice 2: parse args, validate context, create run manifest. Does not call iii unless future slices enable it.
import { isAbsolute } from 'node:path';
import {
  buildInitialManifest,
  buildRunId,
  buildRunPaths,
  DEFAULT_RUN_BASE_DIR,
  writeManifest,
} from './lib/cc-run-manifest.mjs';

function usage() {
  return `Usage: run-cc-task.mjs --target <name> --task <text> --context <absolute-path> [options]\n\nOptions:\n  --topic <topic-id>\n  --effort <high|medium|low>       default: high\n  --base-dir <dir>                 default: ${DEFAULT_RUN_BASE_DIR}\n  --init-only                      create manifest only; do not call iii/CC\n  --help, -h\n`;
}

function parseArgs(argv) {
  const args = { effort: 'high', base_dir: DEFAULT_RUN_BASE_DIR, init_only: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--target') args.target = argv[++i];
    else if (a === '--task') args.task = argv[++i];
    else if (a === '--context') args.context_path = argv[++i];
    else if (a === '--topic') args.topic = argv[++i];
    else if (a === '--effort') args.effort = argv[++i];
    else if (a === '--base-dir') args.base_dir = argv[++i];
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

  try {
    validateArgs(args);
    if (!args.init_only) {
      throw new Error('only --init-only is implemented in Slice 2; iii/CC execution starts in later slices');
    }

    const run_id = buildRunId();
    const paths = buildRunPaths({ base_dir: args.base_dir, run_id });
    const manifest = buildInitialManifest({
      run_id,
      target: args.target,
      task: args.task,
      context_path: args.context_path,
      topic: args.topic || '',
      effort: args.effort,
      paths,
    });
    await writeManifest(manifest);

    process.stdout.write(`${JSON.stringify({
      kind: 'agent_hub.cc_run',
      status: manifest.status,
      run_id,
      manifest_path: paths.manifest,
      watch_path: paths.watch,
      suggestions_path: paths.suggestions,
      interventions_path: paths.interventions,
      final_path: paths.final,
    })}\n`);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(2);
  }
}

main().catch((err) => {
  process.stderr.write(`${err?.message || String(err)}\n`);
  process.exit(1);
});
