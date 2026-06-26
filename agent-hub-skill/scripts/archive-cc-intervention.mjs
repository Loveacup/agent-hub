#!/usr/bin/env node
// Phase 5 Runtime Orchestrator — approved cc::intervene archive wrapper.
// This wrapper never auto-intervenes: it requires explicit --confirm and appends audit evidence.
import { appendFile, readFile } from 'node:fs/promises';
import { triggerIii, DEFAULT_III_BIN } from './lib/iii-client.mjs';

function usage() {
  return `Usage: archive-cc-intervention.mjs --manifest <path> --session <id> --message <text> --reason <text> --monitor-snapshot-id <id> --confirm [options]\n\nOptions:\n  --iii-bin <path>          default: ${DEFAULT_III_BIN}\n  --iii-address <host>      default: localhost\n  --iii-port <port>         default: 49134\n  --timeout-ms <ms>         default: 60000\n`;
}

function parseArgs(argv) {
  const args = { iii_bin: DEFAULT_III_BIN, iii_address: 'localhost', iii_port: 49134, timeout_ms: 60_000, confirm: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--manifest') args.manifest = argv[++i];
    else if (a === '--session') args.session_id = argv[++i];
    else if (a === '--message') args.message = argv[++i];
    else if (a === '--reason') args.reason = argv[++i];
    else if (a === '--monitor-snapshot-id') args.monitor_snapshot_id = argv[++i];
    else if (a === '--iii-bin') args.iii_bin = argv[++i];
    else if (a === '--iii-address') args.iii_address = argv[++i];
    else if (a === '--iii-port') args.iii_port = Number(argv[++i]);
    else if (a === '--timeout-ms') args.timeout_ms = Number(argv[++i]);
    else if (a === '--confirm') args.confirm = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else throw new Error(`unknown arg: ${a}`);
  }
  return args;
}

function validateArgs(args) {
  const missing = [];
  if (!args.manifest) missing.push('--manifest');
  if (!args.session_id) missing.push('--session');
  if (!args.message) missing.push('--message');
  if (!args.reason) missing.push('--reason');
  if (!args.monitor_snapshot_id) missing.push('--monitor-snapshot-id');
  if (missing.length) throw new Error(`missing required args: ${missing.join(', ')}`);
  if (!args.confirm) throw new Error('confirm required for approved intervention archive');
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function countJsonl(path) {
  try {
    const text = await readFile(path, 'utf8');
    return text.trim().split('\n').filter(Boolean).length;
  } catch (err) {
    if (err?.code === 'ENOENT') return 0;
    throw err;
  }
}

async function archiveIntervention(args) {
  const manifest = await readJson(args.manifest);
  const result = await triggerIii({
    iii_bin: args.iii_bin,
    action: 'cc::intervene',
    payload: {
      session_id: args.session_id,
      message: args.message,
      reason: args.reason,
      monitor_snapshot_id: args.monitor_snapshot_id,
    },
    address: args.iii_address,
    port: args.iii_port,
    timeout_ms: args.timeout_ms,
  });
  const record = {
    kind: 'agent_hub.cc_run_intervention',
    run_id: manifest.run_id,
    approved: true,
    session_id: args.session_id,
    message: args.message,
    reason: args.reason,
    monitor_snapshot_id: args.monitor_snapshot_id,
    send_result: result,
    ts: new Date().toISOString(),
  };
  await appendFile(manifest.paths.interventions, `${JSON.stringify(record)}\n`, 'utf8');
  const interventions_count = await countJsonl(manifest.paths.interventions);
  const status = result?.status || 'unknown';
  return {
    kind: 'agent_hub.cc_run_intervention_result',
    run_id: manifest.run_id,
    status,
    interventions_count,
    interventions_path: manifest.paths.interventions,
    send_result: result,
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
  try {
    validateArgs(args);
    const payload = await archiveIntervention(args);
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    process.exit(payload.status === 'sent' || payload.status === 'ok' ? 0 : 1);
  } catch (err) {
    process.stderr.write(`${err?.message || String(err)}\n`);
    process.exit(2);
  }
}

main();
