// Phase 7 Slice 1 — OMP profile registry validator tests (TDD, pure logic, no fs/net/.omp access)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  validateProfileName,
  validateProfileEntry,
  validateRegistry,
} from '../src/validator.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const registryPath = resolve(
  __dirname,
  '../../../../agent-hub-skill/config/omp-profiles.json',
);

function loadShippedRegistry() {
  return JSON.parse(readFileSync(registryPath, 'utf8'));
}

function validPageEntry() {
  // Deep clone the canonical shipped entry so each test can mutate freely.
  return JSON.parse(JSON.stringify(loadShippedRegistry().profiles[0]));
}

// ── 1. valid registry with `page` ─────────────────────────────────────────────
test('validateRegistry accepts the shipped read-only `page` registry', () => {
  const res = validateRegistry(loadShippedRegistry());
  assert.equal(res.ok, true);
  assert.deepEqual(res.errors, []);
});

test('validateProfileEntry accepts the canonical page entry', () => {
  const res = validateProfileEntry(validPageEntry());
  assert.equal(res.ok, true);
  assert.deepEqual(res.errors, []);
});

// ── 2. invalid names ──────────────────────────────────────────────────────────
test('validateProfileName rejects malformed names', () => {
  const bad = ['Page', 'page profile', '.', '..', 'page.', 'con', 'COM1', 'a/b', ''];
  for (const name of bad) {
    const res = validateProfileName(name);
    assert.equal(res.ok, false, `expected ${JSON.stringify(name)} to be invalid`);
    assert.ok(res.errors.length >= 1, `expected errors for ${JSON.stringify(name)}`);
    for (const e of res.errors) {
      assert.equal(typeof e.code, 'string');
      assert.equal(typeof e.message, 'string');
    }
  }
});

test('validateProfileName accepts a well-formed lowercase name', () => {
  const res = validateProfileName('page');
  assert.equal(res.ok, true);
  assert.deepEqual(res.errors, []);
});

// ── 3. `default` rejected as a named profile ──────────────────────────────────
test('validateProfileName rejects reserved `default`', () => {
  const res = validateProfileName('default');
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => /default/i.test(e.message) || /reserved/i.test(e.code)));
});

// ── 4. unknown status rejected ────────────────────────────────────────────────
test('validateProfileEntry rejects an unknown status', () => {
  const entry = validPageEntry();
  entry.status = 'archived';
  const res = validateProfileEntry(entry);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.path === 'status'));
});

// ── 5. unknown risk_level rejected ────────────────────────────────────────────
test('validateProfileEntry rejects an unknown risk_level', () => {
  const entry = validPageEntry();
  entry.risk_level = 'spicy';
  const res = validateProfileEntry(entry);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.path === 'risk_level'));
});

// ── 6. non-boolean permission rejected ────────────────────────────────────────
test('validateProfileEntry rejects a non-boolean permission value', () => {
  const entry = validPageEntry();
  entry.permissions.write_files = 'false';
  const res = validateProfileEntry(entry);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => /permissions\.write_files/.test(e.path)));
});

// ── 7. read_only profile cannot enable write/network permissions ──────────────
test('validateProfileEntry rejects read_only profile enabling write_files', () => {
  const entry = validPageEntry();
  entry.permissions.write_files = true;
  const res = validateProfileEntry(entry);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => /read_only/i.test(e.message)));
});

test('validateProfileEntry rejects read_only profile enabling external_network', () => {
  const entry = validPageEntry();
  entry.permissions.external_network = true;
  const res = validateProfileEntry(entry);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => /read_only/i.test(e.message)));
});

// ── 8. wrong summary/audit subject rejected ───────────────────────────────────
test('validateProfileEntry rejects a wrong summary subject', () => {
  const entry = validPageEntry();
  entry.subjects.summary = 'agent.omp.profile.page.metrics';
  const res = validateProfileEntry(entry);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.path === 'subjects.summary'));
});

test('validateProfileEntry rejects an audit subject naming a different profile', () => {
  const entry = validPageEntry();
  entry.subjects.audit = 'agent.omp.profile.other.audit';
  const res = validateProfileEntry(entry);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.path === 'subjects.audit'));
});

// ── 9. named profile path outside ~/.omp/profiles/<name>/agent rejected ───────
test('validateProfileEntry rejects an agent_dir outside ~/.omp/profiles/<name>/agent', () => {
  const entry = validPageEntry();
  entry.paths.agent_dir = '~/.omp/profiles/other/agent';
  const res = validateProfileEntry(entry);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => /paths\./.test(e.path)));
});

test('validateProfileEntry rejects a config path escaping the profile agent dir', () => {
  const entry = validPageEntry();
  entry.paths.config = '~/.omp/profiles/page/../page2/agent/config.yml';
  const res = validateProfileEntry(entry);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => /paths\.config/.test(e.path)));
});

// ── 10. duplicate profile names rejected ──────────────────────────────────────
test('validateRegistry rejects duplicate profile names', () => {
  const registry = loadShippedRegistry();
  registry.profiles.push(validPageEntry());
  const res = validateRegistry(registry);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.code === 'DUPLICATE_NAME'));
});

// ── 11. normal validation failures return structured errors, not thrown ───────
test('validators never throw on malformed input and return structured errors', () => {
  const inputs = [undefined, null, 42, 'string', {}, { profiles: 'nope' }, []];
  for (const input of inputs) {
    let res;
    assert.doesNotThrow(() => {
      res = validateRegistry(input);
    }, `validateRegistry threw on ${JSON.stringify(input)}`);
    assert.equal(res.ok, false);
    assert.ok(Array.isArray(res.errors) && res.errors.length >= 1);
    for (const e of res.errors) {
      assert.equal(typeof e.code, 'string');
      assert.equal(typeof e.path, 'string');
      assert.equal(typeof e.message, 'string');
    }
  }

  for (const input of [undefined, null, 42, [], {}]) {
    assert.doesNotThrow(() => validateProfileEntry(input));
    assert.doesNotThrow(() => validateProfileName(input));
    assert.equal(validateProfileEntry(input).ok, false);
    assert.equal(validateProfileName(input).ok, false);
  }
});
