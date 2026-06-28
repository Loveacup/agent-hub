#!/usr/bin/env node
// H6 Multi-Worker Parallel Dispatch — CLI wrapper.
//
// Reads a plan.json describing N worker calls, dispatches them concurrently
// through the real iii client, and prints the aggregated JSON result to stdout.
//
// Usage:
//   call-parallel.mjs --plan plan.json
import { readFile } from 'node:fs/promises';
import { runParallelCalls } from './lib/parallel-runner.mjs';
import { DEFAULT_III_BIN, triggerIii as rawTriggerIii } from './lib/iii-client.mjs';

function usage() {
  return [
    'Usage: call-parallel.mjs --plan <plan.json>',
    '',
    'plan.json schema:',
    '  {',
    '    "calls": [ {"lane": "...", "action": "...", "payload": {...}} ],',
    `    "iii_bin": "${DEFAULT_III_BIN}",`,
    '    "address": "localhost",',
    '    "port": 49134,',
    '    "timeout_ms": 120000',
    '  }',
  ].join('\n');
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--plan') args.plan = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.plan) {
    process.stderr.write(`${usage()}\n`);
    process.exit(args.help ? 0 : 2);
  }

  const raw = await readFile(args.plan, 'utf8');
  const plan = JSON.parse(raw);

  const iii_bin = plan.iii_bin || DEFAULT_III_BIN;
  const address = plan.address || 'localhost';
  const port = plan.port != null ? plan.port : 49134;
  const timeout_ms = plan.timeout_ms != null ? plan.timeout_ms : 120_000;

  // Adapt the runner's injectable triggerIii signature ({ action, payload })
  // onto the real iii client, binding the connection config from the plan.
  const triggerIii = ({ action, payload }) =>
    rawTriggerIii({ iii_bin, action, payload, address, port, timeout_ms });

  const out = await runParallelCalls(plan.calls, { triggerIii, timeout_ms });
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

main().catch((err) => {
  process.stderr.write(`call-parallel failed: ${err && err.message ? err.message : err}\n`);
  process.exit(1);
});
