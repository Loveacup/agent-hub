// Phase 8 Slice 1 — host registry validator + safe lister tests (pure, no fs).
//
// registry.js is PURE: it imports no fs/subprocess/socket and reads text only
// through an INJECTED reader. Validation is fail-closed: malformed input returns
// a structured { ok:false, errors } result and never throws. The safe listing
// emits only enabled hosts and never leaks SSH connection details.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { loadHostRegistryFromObject, readHostRegistry, listHosts } from '../src/registry.js';

const validUrl = new URL('./fixtures/hosts.valid.json', import.meta.url);
const invalidUrl = new URL('./fixtures/hosts.invalid.json', import.meta.url);
const validText = readFileSync(validUrl, 'utf8');
const invalidText = readFileSync(invalidUrl, 'utf8');
const validObj = JSON.parse(validText);
const invalidObj = JSON.parse(invalidText);

function codes(res) {
  return res.errors.map((e) => e.code);
}

// ── registry.js imports no fs/subprocess/socket capability ───────────────────
test('registry.js imports no fs/subprocess/socket', () => {
  const src = readFileSync(fileURLToPath(new URL('../src/registry.js', import.meta.url)), 'utf8');
  assert.ok(!/from\s+['"]node:fs|from\s+['"]fs['"]|require\(/.test(src), 'must not import fs');
  assert.ok(!/node:child_process|child_process|spawn|execSync/.test(src), 'must not import subprocess');
  assert.ok(!/node:net|node:https?|fetch\(/.test(src), 'must not import net/http');
});

// ── valid registry loads + normalizes ───────────────────────────────────────
test('valid registry loads ok with both hosts', () => {
  const res = loadHostRegistryFromObject(validObj);
  assert.equal(res.ok, true, JSON.stringify(res.errors));
  assert.equal(res.errors.length, 0);
  assert.equal(res.registry.kind, 'ssh.host.registry');
  assert.equal(res.registry.version, 1);
  assert.equal(res.registry.hosts.length, 2);
  assert.deepEqual(res.registry.hosts.map((h) => h.id), ['nas-01', 'pi-02']);
});

// ── invalid registry: missing fields / duplicate id / bad id / secret field ──
test('invalid registry fails closed with structured error codes', () => {
  const res = loadHostRegistryFromObject(invalidObj);
  assert.equal(res.ok, false);
  assert.equal(res.registry, null);
  const cs = codes(res);
  assert.ok(cs.includes('missing_field'), 'missing required fields flagged');
  assert.ok(cs.includes('duplicate_id'), 'duplicate id flagged');
  assert.ok(cs.includes('bad_id'), 'bad_id! flagged');
  assert.ok(cs.includes('secret_field'), 'ssh_key secret field flagged');
});

// ── secret fields are rejected explicitly ────────────────────────────────────
test('each secret-shaped field is rejected', () => {
  for (const secret of ['ssh_key', 'private_key', 'token', 'password', 'env']) {
    const res = loadHostRegistryFromObject({
      version: 1,
      hosts: [
        {
          id: 'h1',
          ssh_alias: 'h1',
          ssh_host: 'h1.local',
          ssh_port: 22,
          ssh_user: 'u',
          runtimes: [{ name: 'codex' }],
          enabled: true,
          [secret]: 'x',
        },
      ],
    });
    assert.equal(res.ok, false, `${secret} must be rejected`);
    assert.ok(codes(res).includes('secret_field'), `${secret} -> secret_field`);
  }
});

// ── secret fields inside a runtime sub-object are rejected ───────────────────
test('secret-shaped fields inside runtimes[j] are rejected', () => {
  const res = loadHostRegistryFromObject({
    version: 1,
    hosts: [
      {
        id: 'h1',
        ssh_alias: 'h1',
        ssh_host: 'h1.local',
        ssh_port: 22,
        ssh_user: 'u',
        runtimes: [{ name: 'codex', env: {}, token: 'x' }],
        enabled: true,
      },
    ],
  });
  assert.equal(res.ok, false, 'runtime secret must be rejected');
  const cs = codes(res);
  assert.ok(cs.includes('secret_field'), 'runtime secret -> secret_field');
  const paths = res.errors.filter((e) => e.code === 'secret_field').map((e) => e.path);
  assert.ok(paths.includes('hosts[0].runtimes[0].env'), 'env path flagged');
  assert.ok(paths.includes('hosts[0].runtimes[0].token'), 'token path flagged');
});

// ── malformed input fails closed, never throws ───────────────────────────────
test('malformed top-level input fails closed without throwing', () => {
  for (const bad of [undefined, null, 42, 'str', ['x'], () => {}]) {
    let res;
    assert.doesNotThrow(() => {
      res = loadHostRegistryFromObject(bad);
    }, `threw on ${String(bad)}`);
    assert.equal(res.ok, false);
    assert.equal(res.registry, null);
  }
});

// ── bad version / hosts not array ────────────────────────────────────────────
test('bad version and non-array hosts are flagged', () => {
  assert.ok(codes(loadHostRegistryFromObject({ version: 0, hosts: [] })).includes('bad_version'));
  assert.ok(codes(loadHostRegistryFromObject({ version: 1, hosts: {} })).includes('hosts_not_array'));
});

// ── readHostRegistry uses an INJECTED reader (no fs in module) ────────────────
test('readHostRegistry parses via injected readText', () => {
  const res = readHostRegistry({ path: '/any/hosts.json' }, { readText: () => validText });
  assert.equal(res.ok, true, JSON.stringify(res.errors));
  assert.equal(res.registry.hosts.length, 2);
});

test('readHostRegistry fails closed on a throwing reader / bad json / no reader', () => {
  const thrown = readHostRegistry({ path: 'x' }, { readText: () => { throw new Error('eacces'); } });
  assert.equal(thrown.ok, false);
  assert.ok(codes(thrown).includes('read_failed'));

  const badJson = readHostRegistry({ path: 'x' }, { readText: () => '{not json' });
  assert.equal(badJson.ok, false);
  assert.ok(codes(badJson).includes('bad_json'));

  const noReader = readHostRegistry({ path: 'x' }, {});
  assert.equal(noReader.ok, false);
  assert.ok(codes(noReader).includes('no_reader'));
});

// ── listHosts returns only enabled hosts, safe metadata only ─────────────────
test('listHosts returns only enabled hosts with safe metadata', () => {
  const { registry } = loadHostRegistryFromObject(validObj);
  const { hosts } = listHosts({ registry });
  assert.equal(hosts.length, 1, 'only the enabled host is listed');
  const h = hosts[0];
  assert.equal(h.id, 'nas-01');
  assert.equal(h.label, 'NAS 01');
  assert.deepEqual(h.runtimes, ['codex']);
  assert.equal(h.askills_device_id, 'alex-nas');
  assert.equal(h.status_hint, 'unknown');
});

// ── listHosts never leaks SSH connection details ─────────────────────────────
test('listHosts excludes ssh_host/ssh_port/ssh_user/ssh_alias', () => {
  const { registry } = loadHostRegistryFromObject(validObj);
  const { hosts } = listHosts({ registry });
  const json = JSON.stringify(hosts);
  assert.ok(!json.includes('nas.local'), 'no ssh_host');
  assert.ok(!json.includes('pi.local'), 'no disabled host detail');
  assert.ok(!json.includes('"alex"'), 'no ssh_user');
  assert.ok(!/ssh_host|ssh_port|ssh_user|ssh_alias/.test(json), 'no connection keys');
  for (const h of hosts) {
    for (const k of ['ssh_host', 'ssh_port', 'ssh_user', 'ssh_alias']) {
      assert.ok(!Object.prototype.hasOwnProperty.call(h, k), `listed host must not carry ${k}`);
    }
  }
});

// ── listHosts is fail-soft on garbage registry ───────────────────────────────
test('listHosts returns empty list on invalid registry, never throws', () => {
  for (const bad of [undefined, null, 42, {}, { hosts: 'x' }]) {
    let out;
    assert.doesNotThrow(() => {
      out = listHosts({ registry: bad });
    });
    assert.deepEqual(out.hosts, []);
  }
});
