#!/usr/bin/env node
// agent-hub Phase 3b — bounded CC session watcher.
// Polls cc::monitor through iii and emits JSONL watch events on state changes/terminal.
import { execFile } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import {
  buildWatchEvent,
  buildInterventionSuggestion,
  normalizeWatchState,
  shouldEmitWatchEvent,
  shouldStopWatch,
  shouldSuggestIntervention,
} from '../../iii/workers/cc-worker/src/watchLoop.js';

function parseArgs(argv) {
  const args = { interval_ms: 15000, max_ticks: 120, output: '', stale_after_ticks: 0 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--session') args.session_id = argv[++i];
    else if (a === '--interval-ms') args.interval_ms = Number(argv[++i]);
    else if (a === '--max-ticks') args.max_ticks = Number(argv[++i]);
    else if (a === '--output') args.output = argv[++i];
    else if (a === '--stale-after-ticks') args.stale_after_ticks = Number(argv[++i]);
    else if (a === '--iii-bin') args.iii_bin = argv[++i];
    else if (a === '--address') args.address = argv[++i];
    else if (a === '--port') args.port = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
    else throw new Error(`unknown arg: ${a}`);
  }
  return args;
}

function usage() {
  return `Usage: cc-watch-session.mjs --session <tmux-session> [--interval-ms 15000] [--max-ticks 120] [--stale-after-ticks 0] [--output /tmp/watch.jsonl]\n`;
}

function runIiiMonitor({ session_id, iii_bin = `${process.env.HOME || '/Users/alexcai'}/.local/bin/iii`, address = 'localhost', port = '49134' }) {
  return new Promise((resolve) => {
    execFile(iii_bin, [
      'trigger', 'cc::monitor',
      '--json', JSON.stringify({ session_id }),
      '--address', address,
      '--port', String(port),
      '--timeout-ms', '60000',
    ], { timeout: 75_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        resolve({ kind: 'cc.monitor', status: 'error', error: err.message, stderr: stderr || '', stdout: stdout || '' });
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (parseErr) {
        resolve({ kind: 'cc.monitor', status: 'error', error: `parse_failed: ${parseErr.message}`, stdout, stderr: stderr || '' });
      }
    });
  });
}

async function emit(event, output) {
  const line = `${JSON.stringify(event)}\n`;
  process.stdout.write(line);
  if (output) await appendFile(output, line, 'utf8');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.session_id) {
    process.stdout.write(usage());
    process.exit(args.help ? 0 : 2);
  }

  let previous = null;
  let repeatedTicks = 0;
  for (let sequence = 1; sequence <= args.max_ticks; sequence += 1) {
    const monitor = await runIiiMonitor(args);
    const state = normalizeWatchState(monitor);
    const previousState = previous ? normalizeWatchState(previous) : null;
    repeatedTicks = previousState === state ? repeatedTicks + 1 : 1;
    const suggestion = shouldSuggestIntervention({
      repeated_ticks: repeatedTicks,
      stale_after_ticks: args.stale_after_ticks,
      monitor,
    }) ? buildInterventionSuggestion({
      session_id: args.session_id,
      state,
      repeated_ticks: repeatedTicks,
      interval_ms: args.interval_ms,
      monitor_snapshot_id: monitor.monitor_snapshot_id ?? null,
    }) : null;
    const event = buildWatchEvent({ session_id: args.session_id, sequence, monitor, suggestion });
    if (shouldEmitWatchEvent(previous, monitor) || event.terminal || suggestion) await emit(event, args.output);
    if (shouldStopWatch(monitor)) process.exit(monitor.status === 'error' ? 1 : 0);
    previous = monitor;
    if (sequence < args.max_ticks) await new Promise((r) => setTimeout(r, args.interval_ms));
  }
  await emit({ kind: 'cc.watch.event', source: 'cc-watch-session', session_id: args.session_id, status: 'timeout', terminal: true, ts: new Date().toISOString() }, args.output);
  process.exit(2);
}

main().catch((err) => {
  console.error(JSON.stringify({ kind: 'cc.watch.event', status: 'error', error: err?.message ?? String(err), terminal: true }));
  process.exit(1);
});
