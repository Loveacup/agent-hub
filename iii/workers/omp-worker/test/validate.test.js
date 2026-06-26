// Phase 7 Slice 5 — OMP validation helper tests (TDD; pure, no filesystem).
//
// These helpers validate INJECTED `.env` data, INJECTED `mcp.json` data, and
// metadata-only profile summaries. They perform NO filesystem access, never read
// the real ~/.omp / `.env` / `mcp.json`, never inspect process.env, and never
// echo raw secret values. Every function returns structured { errors, warnings }
// and MUST NOT throw on normal malformed input. These tests pass only injected
// inputs and assert no raw secret/body value ever appears in the output JSON.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateEnvInput,
  validateMcpInput,
  summarizeProfileMetadata,
  validateProfileMetadata,
} from '../src/validate.js';

// A recognizable secret marker — if any output JSON contains it, redaction failed.
const SECRET = 'sk-SECRET-VALUE-do-not-leak-0xDEADBEEF';
const BODY = 'BODY-TRANSCRIPT-do-not-leak-lorem-ipsum';

// ═══════════════════════════════ ENV ═══════════════════════════════════════

// ── 1. accepts injected `.env` string and extracts key names ─────────────────
test('validateEnvInput parses an injected .env string and extracts key names', () => {
  const res = validateEnvInput(`OPENAI_API_KEY=${SECRET}\nANTHROPIC_API_KEY=${SECRET}2`);
  assert.equal(res.ok, true);
  assert.deepEqual(res.keys, ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY']);
  assert.equal(res.secret_values_included, false);
});

// ── 2. ignores blank / comment lines ─────────────────────────────────────────
test('validateEnvInput ignores blank and comment lines', () => {
  const res = validateEnvInput([
    '# a comment',
    '',
    '   ',
    '# OPENAI_API_KEY=commented-out',
    `REAL_KEY=${SECRET}`,
  ].join('\n'));
  assert.equal(res.ok, true);
  assert.deepEqual(res.keys, ['REAL_KEY']);
});

// ── 3. redacts all values in the preview ─────────────────────────────────────
test('validateEnvInput redacts every value in redacted_preview', () => {
  const res = validateEnvInput(`OPENAI_API_KEY=${SECRET}\nFOO=${SECRET}`);
  assert.deepEqual(res.redacted_preview, ['OPENAI_API_KEY=***', 'FOO=***']);
  for (const line of res.redacted_preview) {
    assert.ok(!line.includes(SECRET), `preview line must not contain the secret: ${line}`);
  }
});

// ── 4. output JSON does not contain sample secret values ─────────────────────
test('validateEnvInput output JSON never contains the sample secret value', () => {
  const res = validateEnvInput(`OPENAI_API_KEY=${SECRET}`);
  assert.ok(!JSON.stringify(res).includes(SECRET), 'serialized result must not leak the secret');
  assert.equal(res.secret_values_included, false);
});

// ── 5. accepts object input and redacts values ───────────────────────────────
test('validateEnvInput accepts an object input and redacts its values', () => {
  const res = validateEnvInput({ OPENAI_API_KEY: SECRET, FOO: SECRET });
  assert.equal(res.ok, true);
  assert.deepEqual(res.keys, ['OPENAI_API_KEY', 'FOO']);
  assert.ok(!JSON.stringify(res).includes(SECRET));
});

// ── 6. rejects non-string/non-object input without throwing ──────────────────
test('validateEnvInput rejects non-string/non-object input without throwing', () => {
  for (const bad of [undefined, null, 42, true, ['x'], () => {}]) {
    let res;
    assert.doesNotThrow(() => {
      res = validateEnvInput(bad);
    }, `threw on ${String(bad)}`);
    assert.equal(res.ok, false);
    assert.ok(Array.isArray(res.errors) && res.errors.length >= 1);
    for (const e of res.errors) {
      assert.equal(typeof e.code, 'string');
      assert.equal(typeof e.path, 'string');
      assert.equal(typeof e.message, 'string');
    }
    assert.equal(res.secret_values_included, false);
  }
});

// ── 7. duplicate keys produce a warning, not a raw value leak ─────────────────
test('validateEnvInput warns on duplicate keys and never leaks raw values', () => {
  const res = validateEnvInput(`OPENAI_API_KEY=${SECRET}\nOPENAI_API_KEY=${SECRET}-second`);
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_KEY'));
  assert.deepEqual(res.keys, ['OPENAI_API_KEY'], 'duplicate key listed once');
  assert.ok(!JSON.stringify(res).includes(SECRET));
});

// ═══════════════════════════════ MCP ═══════════════════════════════════════

function mcpObject() {
  return {
    mcpServers: {
      filesystem: {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
        env: { SECRET_TOKEN: SECRET, OTHER: SECRET },
      },
      noargs: { command: 'node' },
    },
  };
}

// ── 8. accepts injected JSON object ──────────────────────────────────────────
test('validateMcpInput accepts an injected JSON object', () => {
  const res = validateMcpInput(mcpObject());
  assert.equal(res.ok, true);
  assert.equal(res.server_count, 2);
});

// ── 9. accepts injected JSON string ──────────────────────────────────────────
test('validateMcpInput accepts an injected JSON string', () => {
  const res = validateMcpInput(JSON.stringify(mcpObject()));
  assert.equal(res.ok, true);
  assert.equal(res.server_count, 2);
});

// ── 10. rejects invalid JSON string ──────────────────────────────────────────
test('validateMcpInput rejects an invalid JSON string without throwing', () => {
  let res;
  assert.doesNotThrow(() => {
    res = validateMcpInput('{ not valid json ');
  });
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => /JSON/i.test(e.message) || /JSON/i.test(e.code)));
});

// ── 11. rejects missing / non-object mcpServers ──────────────────────────────
test('validateMcpInput rejects missing or non-object mcpServers', () => {
  for (const bad of [{}, { mcpServers: null }, { mcpServers: [] }, { mcpServers: 'x' }, 42, null, ['x']]) {
    let res;
    assert.doesNotThrow(() => {
      res = validateMcpInput(bad);
    });
    assert.equal(res.ok, false, `expected invalid for ${JSON.stringify(bad)}`);
    assert.ok(res.errors.length >= 1);
  }
});

// ── 12. rejects a non-object server entry ────────────────────────────────────
test('validateMcpInput rejects a non-object server entry', () => {
  const res = validateMcpInput({ mcpServers: { bad: 'not-an-object' } });
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => /mcpServers\.bad/.test(e.path)));
});

// ── 13. rejects malformed command / args / env types ─────────────────────────
test('validateMcpInput rejects malformed command/args/env types', () => {
  const resCommand = validateMcpInput({ mcpServers: { a: { command: 123 } } });
  assert.equal(resCommand.ok, false);
  assert.ok(resCommand.errors.some((e) => /command/.test(e.path)));

  const resArgs = validateMcpInput({ mcpServers: { a: { args: 'x' } } });
  assert.equal(resArgs.ok, false);
  assert.ok(resArgs.errors.some((e) => /args/.test(e.path)));

  const resEnv = validateMcpInput({ mcpServers: { a: { env: ['x'] } } });
  assert.equal(resEnv.ok, false);
  assert.ok(resEnv.errors.some((e) => /env/.test(e.path)));
});

// ── 14. summarizes command, args_count, env_keys without env values ──────────
test('validateMcpInput reports command, args_count, env_keys (names only)', () => {
  const res = validateMcpInput(mcpObject());
  const fs = res.servers.find((s) => s.name === 'filesystem');
  assert.equal(fs.command, 'npx');
  assert.equal(fs.args_count, 3);
  assert.deepEqual(fs.env_keys, ['SECRET_TOKEN', 'OTHER']);
  const noargs = res.servers.find((s) => s.name === 'noargs');
  assert.equal(noargs.command, 'node');
  assert.equal(noargs.args_count, 0);
  assert.deepEqual(noargs.env_keys, []);
});

// ── 15. output JSON does not contain sample env secret values ─────────────────
test('validateMcpInput output JSON never contains injected env secret values', () => {
  const res = validateMcpInput(mcpObject());
  assert.ok(!JSON.stringify(res).includes(SECRET), 'serialized mcp result must not leak env values');
});

// ═════════════════════════════ SUMMARY ═════════════════════════════════════

function metadataProfile() {
  return {
    name: 'page',
    status: 'planned',
    risk_level: 'read_only',
    permissions: {
      read_profile_metadata: true,
      write_files: false,
    },
    subjects: {
      summary: 'agent.omp.profile.page.summary',
      audit: 'agent.omp.profile.page.audit',
    },
    gateway: { mode: 'none', platforms: [] },
  };
}

// ── 16. returns a metadata-only profile summary ──────────────────────────────
test('summarizeProfileMetadata returns a metadata-only, redacted summary', () => {
  const summary = summarizeProfileMetadata(metadataProfile());
  assert.equal(summary.kind, 'omp.profile.summary');
  assert.equal(summary.profile, 'page');
  assert.equal(summary.status, 'planned');
  assert.equal(summary.risk_level, 'read_only');
  assert.equal(summary.gateway_mode, 'none');
  assert.equal(summary.metadata_only, true);
  assert.equal(summary.redacted, true);
  assert.equal(summary.has_secrets, false);
  assert.deepEqual(summary.errors, []);
});

// ── 17. counts file actions / conflicts / warnings from render/apply metadata ─
test('summarizeProfileMetadata counts actions/conflicts/warnings from a render plan', () => {
  const renderPlan = {
    actions: [{ type: 'render_file' }, { type: 'render_file' }],
    conflicts: [{ type: 'target_exists' }],
    warnings: [{ code: 'MISSING_PATH' }, { code: 'MISSING_PATH' }, { code: 'X' }],
  };
  const summary = summarizeProfileMetadata(metadataProfile(), { renderPlan });
  assert.equal(summary.file_action_count, 2);
  assert.equal(summary.conflict_count, 1);
  assert.equal(summary.warning_count, 3);
});

// ── 18. counts env keys and MCP servers from validation outputs ──────────────
test('summarizeProfileMetadata counts env keys and MCP servers from validation outputs', () => {
  const envValidation = validateEnvInput({ A: SECRET, B: SECRET, C: SECRET });
  const mcpValidation = validateMcpInput(mcpObject());
  const summary = summarizeProfileMetadata(metadataProfile(), { envValidation, mcpValidation });
  assert.equal(summary.env_key_count, 3);
  assert.equal(summary.mcp_server_count, 2);
  assert.ok(!JSON.stringify(summary).includes(SECRET));
});

// ── 19. omits session/memory/log/body/content/transcript even if present ─────
test('summarizeProfileMetadata omits forbidden content fields from output', () => {
  const profile = {
    ...metadataProfile(),
    session: { id: 'x' },
    memory: ['m'],
    logs: ['l'],
    body: BODY,
    content: BODY,
    transcript: BODY,
  };
  const summary = summarizeProfileMetadata(profile);
  for (const forbidden of ['session', 'memory', 'logs', 'log', 'body', 'content', 'transcript']) {
    assert.ok(!(forbidden in summary), `summary must not expose field: ${forbidden}`);
  }
  assert.equal(summary.metadata_only, true);
});

// ── 20. output JSON does not contain injected secret / body strings ──────────
test('summarizeProfileMetadata output JSON never leaks injected secret/body strings', () => {
  const profile = {
    ...metadataProfile(),
    body: BODY,
    transcript: BODY,
    permissions: { write_files: false, injected: SECRET },
  };
  const envValidation = validateEnvInput({ OPENAI_API_KEY: SECRET });
  const summary = summarizeProfileMetadata(profile, { envValidation });
  const json = JSON.stringify(summary);
  assert.ok(!json.includes(SECRET), 'must not leak secret');
  assert.ok(!json.includes(BODY), 'must not leak body/transcript');
});

// ── 21. malformed profile metadata returns structured errors and no throw ────
test('validateProfileMetadata + summarize never throw on malformed metadata', () => {
  for (const bad of [undefined, null, 42, 'string', ['x'], () => {}]) {
    let v;
    assert.doesNotThrow(() => {
      v = validateProfileMetadata(bad);
    });
    assert.equal(v.ok, false);
    assert.ok(Array.isArray(v.errors) && v.errors.length >= 1);
    for (const e of v.errors) {
      assert.equal(typeof e.code, 'string');
      assert.equal(typeof e.path, 'string');
      assert.equal(typeof e.message, 'string');
    }
    let s;
    assert.doesNotThrow(() => {
      s = summarizeProfileMetadata(bad);
    });
    assert.equal(s.kind, 'omp.profile.summary');
    assert.equal(s.profile, null);
    assert.equal(s.metadata_only, true);
  }

  // a profile carrying forbidden content fields is flagged but never throws
  const flagged = validateProfileMetadata({ name: 'page', body: BODY });
  assert.equal(flagged.ok, false);
  assert.ok(flagged.errors.some((e) => e.code === 'FORBIDDEN_FIELD'));
  assert.ok(!JSON.stringify(flagged).includes(BODY), 'validation errors must not echo body content');
});
