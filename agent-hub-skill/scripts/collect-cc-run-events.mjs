#!/usr/bin/env node
// Phase 5 Runtime Orchestrator — collect watcher JSONL into durable run evidence.
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { updateManifestStatus, writeManifest } from './lib/cc-run-manifest.mjs';

function usage() {
  return 'Usage: collect-cc-run-events.mjs --manifest <path>\n';
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--manifest') args.manifest = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
    else throw new Error(`unknown arg: ${a}`);
  }
  return args;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function readJsonl(path) {
  try {
    const text = await readFile(path, 'utf8');
    return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
}

function finalStatusForEvent(event = {}) {
  if (event.status === 'timeout') return 'timeout';
  const state = String(event.state || '').toUpperCase();
  if (state === 'COMPLETED') return 'completed';
  if (state === 'BLOCKED') return 'blocked';
  if (state === 'FREEZE' || state === 'FROZEN') return 'blocked';
  if (state === 'ERROR' || event.status === 'error') return 'failed';
  return event.terminal ? 'failed' : 'watching';
}

async function writeSuggestions(paths, events) {
  let count = 0;
  await writeFile(paths.suggestions, '', 'utf8');
  for (const event of events) {
    if (!event.suggestion) continue;
    await appendFile(paths.suggestions, `${JSON.stringify({ kind: 'agent_hub.cc_run_suggestion', event, suggestion: event.suggestion, ts: event.ts || new Date().toISOString() })}\n`, 'utf8');
    count += 1;
  }
  return count;
}

async function collect({ manifest_path }) {
  const manifest = await readJson(manifest_path);
  const paths = manifest.paths;
  const events = await readJsonl(paths.watch);
  const suggestions_count = await writeSuggestions(paths, events);
  const terminal_event = events.findLast?.((event) => event.terminal) ?? [...events].reverse().find((event) => event.terminal);

  if (!terminal_event) {
    return {
      kind: 'agent_hub.cc_run_collect',
      run_id: manifest.run_id,
      status: manifest.status || 'watching',
      events_count: events.length,
      suggestions_count,
      suggestions_path: paths.suggestions,
      final_path: paths.final,
      manifest_path,
    };
  }

  const status = finalStatusForEvent(terminal_event);
  const final = {
    kind: 'agent_hub.cc_run_final',
    run_id: manifest.run_id,
    status,
    events_count: events.length,
    suggestions_count,
    terminal_event,
    ts: new Date().toISOString(),
  };
  await writeFile(paths.final, `${JSON.stringify(final, null, 2)}\n`, 'utf8');
  const updated = updateManifestStatus(manifest, { status, extra: { final_status: status, events_count: events.length, suggestions_count } });
  await writeManifest(updated);
  return {
    kind: 'agent_hub.cc_run_collect',
    run_id: manifest.run_id,
    status,
    events_count: events.length,
    suggestions_count,
    suggestions_path: paths.suggestions,
    final_path: paths.final,
    manifest_path,
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
    return;
  }
  if (!args.manifest) {
    process.stderr.write(`missing required arg: --manifest\n${usage()}`);
    process.exit(2);
  }
  try {
    const payload = await collect({ manifest_path: args.manifest });
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    process.exit(payload.status === 'timeout' ? 2 : payload.status === 'failed' ? 1 : 0);
  } catch (err) {
    process.stderr.write(`${err?.message || String(err)}\n`);
    process.exit(1);
  }
}

main();
