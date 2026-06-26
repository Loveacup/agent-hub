// Phase 7 Slice 2 — OMP profile discover tests (TDD; read-only, metadata-only, redacted).
//
// All filesystem access goes through an injected fake adapter — these tests
// NEVER touch the real ~/.omp directory and NEVER read file content. The fake
// records every adapter call so we can assert no readFile / no listing of
// secret/log/session/memory paths ever happens.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createNodeFsAdapter,
  discoverOmpProfiles,
  discoverOmpProfile,
} from '../src/discover.js';

const H = '/fake/home';

// Canonical fake tree: a populated default profile + a mix of valid/invalid
// named profile directories under ~/.omp/profiles.
function canonicalNodes() {
  return {
    [`${H}/.omp/agent`]: { type: 'dir', children: ['config.yml', 'mcp.json', '.env', '.env.example', 'agent.db', 'logs'] },
    [`${H}/.omp/agent/config.yml`]: { type: 'file', size: 120, mtime_ms: 1000 },
    [`${H}/.omp/agent/mcp.json`]: { type: 'file', size: 80, mtime_ms: 2000 },
    [`${H}/.omp/agent/.env`]: { type: 'file', size: 64, mtime_ms: 3000, mode: 0o600 },
    [`${H}/.omp/agent/.env.example`]: { type: 'file', size: 40, mtime_ms: 4000 },
    [`${H}/.omp/agent/agent.db`]: { type: 'file', size: 9999, mtime_ms: 5000 },
    [`${H}/.omp/agent/logs`]: { type: 'dir', children: ['a.log'] },
    [`${H}/.omp/agent/logs/a.log`]: { type: 'file', size: 1, mtime_ms: 1 },
    // sessions / memory exist on disk but discovery must never touch them
    [`${H}/.omp/agent/sessions`]: { type: 'dir', children: ['s1.json'] },
    [`${H}/.omp/agent/sessions/s1.json`]: { type: 'file', size: 5, mtime_ms: 5 },
    [`${H}/.omp/agent/memory`]: { type: 'dir', children: ['m.md'] },

    [`${H}/.omp/profiles`]: { type: 'dir', children: ['zeta', 'alpha', 'notadir', 'Bad Name', 'COM1'] },
    [`${H}/.omp/profiles/zeta`]: { type: 'dir', children: ['agent'] },
    [`${H}/.omp/profiles/zeta/agent`]: { type: 'dir', children: ['config.yml'] },
    [`${H}/.omp/profiles/zeta/agent/config.yml`]: { type: 'file', size: 10, mtime_ms: 10 },
    [`${H}/.omp/profiles/alpha`]: { type: 'dir', children: ['agent'] },
    [`${H}/.omp/profiles/alpha/agent`]: { type: 'dir', children: [] },
    [`${H}/.omp/profiles/notadir`]: { type: 'file', size: 3, mtime_ms: 3 },
    [`${H}/.omp/profiles/Bad Name`]: { type: 'dir', children: [] },
    [`${H}/.omp/profiles/COM1`]: { type: 'dir', children: [] },
  };
}

// Fake fs adapter over a flat path→node map. Records every call.
function buildFakeFs(nodes) {
  const calls = [];
  return {
    calls,
    stat(p) {
      calls.push(['stat', p]);
      const n = nodes[p];
      if (!n) return { exists: false, is_file: false, is_directory: false };
      return {
        exists: true,
        is_file: n.type === 'file',
        is_directory: n.type === 'dir',
        size: n.size ?? 0,
        mtime_ms: n.mtime_ms ?? 0,
        mode: n.mode ?? 0o644,
      };
    },
    readdir(p) {
      calls.push(['readdir', p]);
      const n = nodes[p];
      if (!n || n.type !== 'dir') return null;
      return (n.children ?? []).map((name) => {
        const c = nodes[`${p}/${name}`];
        return { name, is_directory: c?.type === 'dir', is_file: c?.type === 'file' };
      });
    },
    readFile(p) {
      calls.push(['readFile', p]);
      throw new Error(`readFile must not be called in Slice 2 discovery: ${p}`);
    },
  };
}

function discoverAll() {
  return discoverOmpProfiles({ homeDir: H, fsAdapter: buildFakeFs(canonicalNodes()) });
}

// ── 1. default profile discovered ─────────────────────────────────────────────
test('discoverOmpProfiles discovers the default profile from an injected fake home', () => {
  const res = discoverAll();
  assert.equal(res.kind, 'omp.profile.discovery');
  const def = res.profiles.find((p) => p.kind === 'default');
  assert.ok(def, 'default profile present');
  assert.equal(def.name, 'default');
  assert.equal(def.root_dir, '~/.omp/agent');
  assert.equal(def.paths.agent_dir.exists, true);
  assert.equal(def.paths.agent_dir.is_directory, true);
  assert.equal(def.paths.config.exists, true);
  assert.equal(def.paths.config.is_file, true);
  assert.equal(def.paths.config.size, 120);
  assert.equal(def.paths.mcp.exists, true);
});

// ── 2. named profiles under ~/.omp/profiles/*/agent ──────────────────────────
test('discoverOmpProfiles discovers named profiles under ~/.omp/profiles/*/agent', () => {
  const res = discoverAll();
  const named = res.profiles.filter((p) => p.kind === 'named');
  assert.deepEqual(named.map((p) => p.name), ['alpha', 'zeta']);
  const zeta = res.profiles.find((p) => p.name === 'zeta');
  assert.equal(zeta.kind, 'named');
  assert.equal(zeta.root_dir, '~/.omp/profiles/zeta/agent');
  assert.equal(zeta.paths.agent_dir.exists, true);
  assert.equal(zeta.paths.config.exists, true);
  assert.equal(zeta.paths.config.size, 10);
});

// ── 3. deterministic order: default first, named sorted by name ──────────────
test('discoverOmpProfiles returns default first then named profiles sorted by name', () => {
  const res = discoverAll();
  assert.equal(res.profiles[0].kind, 'default');
  assert.deepEqual(res.profiles.slice(1).map((p) => p.name), ['alpha', 'zeta']);
});

// ── 4. missing default dir and missing profiles dir do not throw ─────────────
test('missing default dir and missing profiles dir do not throw', () => {
  let res;
  assert.doesNotThrow(() => {
    res = discoverOmpProfiles({ homeDir: H, fsAdapter: buildFakeFs({}) });
  });
  assert.equal(res.profiles[0].kind, 'default');
  assert.equal(res.profiles[0].paths.agent_dir.exists, false);
  assert.equal(res.profiles[0].paths.config.exists, false);
  assert.equal(res.profiles.filter((p) => p.kind === 'named').length, 0);
});

// ── 5. discoverOmpProfile rejects invalid names with structured errors ───────
test('discoverOmpProfile rejects invalid profile names without throwing', () => {
  const bad = ['Page', 'page profile', '.', '..', 'page.', 'con', 'COM1', 'a/b', ''];
  for (const name of bad) {
    let res;
    assert.doesNotThrow(() => {
      res = discoverOmpProfile(name, { homeDir: H, fsAdapter: buildFakeFs(canonicalNodes()) });
    }, `discoverOmpProfile threw on ${JSON.stringify(name)}`);
    assert.deepEqual(res.profiles, [], `no profile for ${JSON.stringify(name)}`);
    assert.ok(res.errors.length >= 1, `expected errors for ${JSON.stringify(name)}`);
    for (const e of res.errors) {
      assert.equal(typeof e.code, 'string');
      assert.equal(typeof e.message, 'string');
    }
  }
});

test('discoverOmpProfile maps `default` to the default profile and resolves valid named profiles', () => {
  const d = discoverOmpProfile('default', { homeDir: H, fsAdapter: buildFakeFs(canonicalNodes()) });
  assert.equal(d.profiles.length, 1);
  assert.equal(d.profiles[0].kind, 'default');
  assert.equal(d.errors.length, 0);

  const a = discoverOmpProfile('alpha', { homeDir: H, fsAdapter: buildFakeFs(canonicalNodes()) });
  assert.equal(a.profiles.length, 1);
  assert.equal(a.profiles[0].name, 'alpha');
  assert.equal(a.profiles[0].kind, 'named');
});

// ── 6. non-directory entries skipped; invalid dirs reported ──────────────────
test('non-directory entries under ~/.omp/profiles are skipped silently; invalid dir names reported', () => {
  const res = discoverAll();
  const named = res.profiles.filter((p) => p.kind === 'named').map((p) => p.name);
  assert.ok(!named.includes('notadir'), 'file entry must not be a profile');
  assert.ok(!named.includes('Bad Name'));
  assert.ok(!named.includes('COM1'));
  // invalid directory names produce structured errors
  assert.ok(res.errors.some((e) => /COM1/.test(e.message)));
  assert.ok(res.errors.some((e) => /Bad Name/.test(e.message)));
  // a non-directory entry is skipped without an error
  assert.ok(!res.errors.some((e) => /notadir/.test(e.message)));
  for (const e of res.errors) {
    assert.equal(typeof e.code, 'string');
    assert.equal(typeof e.path, 'string');
    assert.equal(typeof e.message, 'string');
  }
});

// ── 7. .env metadata redacted: no content, no size, no mtime ──────────────────
test('.env metadata is redacted (existence/type/readability/mode only)', () => {
  const def = discoverAll().profiles[0];
  const env = def.paths.env;
  assert.equal(env.exists, true);
  assert.equal(env.is_file, true);
  assert.ok(!('size' in env), '.env must not expose size');
  assert.ok(!('mtime_ms' in env), '.env must not expose mtime');
  assert.ok(!('content' in env));
  assert.equal(typeof env.readable, 'boolean');
  assert.equal(env.mode_known, true);
});

// ── 8. agent.db metadata redacted: existence/type only ───────────────────────
test('agent.db metadata is redacted (existence/type only)', () => {
  const def = discoverAll().profiles[0];
  const db = def.paths.agent_db;
  assert.equal(db.exists, true);
  assert.equal(db.is_file, true);
  assert.ok(!('size' in db), 'agent.db must not expose size');
  assert.ok(!('mtime_ms' in db), 'agent.db must not expose mtime');
  assert.ok(!('content' in db));
});

// ── 9. no readFile, no listing of secret/log/session/memory paths ────────────
test('fake fs records no readFile and never lists logs/sessions/memory/secret bodies', () => {
  const fake = buildFakeFs(canonicalNodes());
  discoverOmpProfiles({ homeDir: H, fsAdapter: fake });

  const readFileCalls = fake.calls.filter((c) => c[0] === 'readFile');
  assert.deepEqual(readFileCalls, [], 'discovery must never read file content');

  // The only directory listing allowed is the profiles root — never logs,
  // sessions, memory, or the agent dir itself.
  const readdirPaths = fake.calls.filter((c) => c[0] === 'readdir').map((c) => c[1]);
  assert.deepEqual(readdirPaths, [`${H}/.omp/profiles`]);

  // No call (stat/readdir/readFile) may target a session/memory/cookie/token path.
  const allPaths = fake.calls.map((c) => c[1]);
  for (const p of allPaths) {
    assert.ok(!/sessions|memory|cookies|token/i.test(p), `must not touch sensitive path: ${p}`);
  }
});

// ── 10. validation status exists for each profile ─────────────────────────────
test('every discovered profile carries a validation status', () => {
  const res = discoverAll();
  assert.ok(res.profiles.length >= 1);
  for (const p of res.profiles) {
    assert.ok(p.validation && typeof p.validation.ok === 'boolean');
    assert.ok(Array.isArray(p.validation.errors));
  }
});

// ── 11. normal discovery failures return structured errors, not thrown ───────
test('discovery returns structured errors instead of throwing on bad input', () => {
  let res;
  assert.doesNotThrow(() => {
    res = discoverOmpProfiles({ homeDir: 42, fsAdapter: buildFakeFs({}) });
  });
  assert.equal(res.kind, 'omp.profile.discovery');
  assert.deepEqual(res.profiles, []);
  assert.ok(res.errors.length >= 1);
  for (const e of res.errors) {
    assert.equal(typeof e.code, 'string');
    assert.equal(typeof e.path, 'string');
    assert.equal(typeof e.message, 'string');
  }

  const r2 = discoverOmpProfile('Bad Name', { homeDir: H, fsAdapter: buildFakeFs(canonicalNodes()) });
  assert.ok(r2.errors.every((e) => typeof e.code === 'string' && typeof e.message === 'string'));
});

// node adapter is constructible without touching ~/.omp (no fs access at build time)
test('createNodeFsAdapter returns an adapter with stat/readdir/readFile', () => {
  const adapter = createNodeFsAdapter();
  assert.equal(typeof adapter.stat, 'function');
  assert.equal(typeof adapter.readdir, 'function');
  assert.equal(typeof adapter.readFile, 'function');
});
