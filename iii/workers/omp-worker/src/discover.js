// Phase 7 Slice 2 — OMP profile discover (read-only, metadata-only, redacted).
//
// Scope (Slice 2): discover the default profile (~/.omp/agent) and named
// profiles (~/.omp/profiles/<name>/agent) and report SAFE metadata only.
//
// Hard privacy rules enforced here:
//   - NEVER read file content (no readFile on any path).
//   - `.env`     → existence / type / readability / mode-ish ONLY. No size, no mtime.
//   - `agent.db` → existence / type ONLY. No size, no mtime.
//   - `logs`     → existence / type ONLY. Never listed.
//   - sessions / memory / cookies / tokens → never accessed at all.
//   - config / mcp / .env.example → metadata (size + mtime) only; content NOT read.
//
// All filesystem access goes through an injected adapter so tests can use fakes
// and never touch the real ~/.omp directory. Functions never throw on normal
// discovery failures — they return structured { errors } instead.
import fs from 'node:fs';
import { join } from 'node:path';
import { validateProfileName } from './validator.js';

const DISCOVERY_KIND = 'omp.profile.discovery';

// Files/dirs inspected inside an agent dir (relative names).
const REL = {
  config: 'config.yml',
  mcp: 'mcp.json',
  env: '.env',
  env_example: '.env.example',
  agent_db: 'agent.db',
  logs: 'logs',
};

function dErr(code, path, message, extra) {
  return { code, path, message, ...(extra ? { errors: extra } : {}) };
}

// Real-filesystem adapter. Constructing it performs NO filesystem access.
// `readFile` exists only for interface completeness — Slice 2 discovery never
// calls it (metadata-only). Every method is fail-soft: a missing path or a
// permission error returns a non-existent / null result instead of throwing.
export function createNodeFsAdapter() {
  return {
    stat(absPath) {
      try {
        const st = fs.statSync(absPath);
        return {
          exists: true,
          is_file: st.isFile(),
          is_directory: st.isDirectory(),
          size: st.size,
          mtime_ms: st.mtimeMs,
          mode: st.mode,
        };
      } catch {
        return { exists: false, is_file: false, is_directory: false };
      }
    },
    readdir(absPath) {
      try {
        return fs.readdirSync(absPath, { withFileTypes: true }).map((d) => ({
          name: d.name,
          is_directory: d.isDirectory(),
          is_file: d.isFile(),
        }));
      } catch {
        return null;
      }
    },
    readFile(absPath) {
      // Intentionally never called by discovery. Present only so the adapter
      // contract is complete; callers that need content must be a later slice.
      return fs.readFileSync(absPath);
    },
  };
}

// config / mcp / .env.example: metadata incl. size + mtime (content NOT read).
function fileMetaFull(adapter, absPath) {
  const st = adapter.stat(absPath);
  if (!st.exists) return { exists: false, is_file: false };
  const meta = { exists: true, is_file: !!st.is_file };
  if (typeof st.size === 'number') meta.size = st.size;
  if (typeof st.mtime_ms === 'number') meta.mtime_ms = st.mtime_ms;
  return meta;
}

// .env: REDACTED — existence / type / readability / mode-known only.
function envMeta(adapter, absPath) {
  const st = adapter.stat(absPath);
  if (!st.exists) return { exists: false, is_file: false };
  const mode_known = typeof st.mode === 'number';
  return {
    exists: true,
    is_file: !!st.is_file,
    readable: mode_known ? (st.mode & 0o400) !== 0 : null,
    mode_known,
  };
}

// agent.db: REDACTED — existence / type only.
function dbMeta(adapter, absPath) {
  const st = adapter.stat(absPath);
  return { exists: !!st.exists, is_file: !!st.is_file };
}

// logs dir: REDACTED — existence / type only, never listed.
function dirMeta(adapter, absPath) {
  const st = adapter.stat(absPath);
  return { exists: !!st.exists, is_directory: !!st.is_directory };
}

function inspectProfile({ name, kind, agentAbsDir, agentDisplayDir, adapter, validation }) {
  const at = (rel) => join(agentAbsDir, rel);
  return {
    name,
    kind,
    root_dir: agentDisplayDir,
    paths: {
      agent_dir: dirMeta(adapter, agentAbsDir),
      config: fileMetaFull(adapter, at(REL.config)),
      mcp: fileMetaFull(adapter, at(REL.mcp)),
      env: envMeta(adapter, at(REL.env)),
      env_example: fileMetaFull(adapter, at(REL.env_example)),
      agent_db: dbMeta(adapter, at(REL.agent_db)),
      logs_dir: dirMeta(adapter, at(REL.logs)),
    },
    validation,
  };
}

function buildDefaultProfile(homeDir, adapter) {
  return inspectProfile({
    name: 'default',
    kind: 'default',
    agentAbsDir: join(homeDir, '.omp', 'agent'),
    agentDisplayDir: '~/.omp/agent',
    adapter,
    validation: { ok: true, errors: [] },
  });
}

function buildNamedProfile(homeDir, name, adapter) {
  const nameRes = validateProfileName(name);
  return inspectProfile({
    name,
    kind: 'named',
    agentAbsDir: join(homeDir, '.omp', 'profiles', name, 'agent'),
    agentDisplayDir: `~/.omp/profiles/${name}/agent`,
    adapter,
    validation: { ok: nameRes.ok, errors: nameRes.errors },
  });
}

function resolveOptions(options) {
  const homeDir = options.homeDir ?? process.env.HOME;
  const fsAdapter = options.fsAdapter ?? createNodeFsAdapter();
  return { homeDir, fsAdapter };
}

function invalidHome(homeDir) {
  return typeof homeDir !== 'string' || homeDir.length === 0;
}

// Discover the default profile plus every valid named profile under
// ~/.omp/profiles. Deterministic order: default first, named sorted by name.
export function discoverOmpProfiles(options = {}) {
  const { homeDir, fsAdapter } = resolveOptions(options);
  const errors = [];
  const profiles = [];

  if (invalidHome(homeDir)) {
    errors.push(dErr('INVALID_HOME', 'homeDir', 'homeDir must be a non-empty string'));
    return { kind: DISCOVERY_KIND, profiles, errors };
  }

  profiles.push(buildDefaultProfile(homeDir, fsAdapter));

  const profilesRoot = join(homeDir, '.omp', 'profiles');
  const entries = fsAdapter.readdir(profilesRoot);
  if (entries) {
    const validNames = [];
    for (const entry of entries) {
      if (!entry.is_directory) continue; // non-directory entries skipped silently
      const nameRes = validateProfileName(entry.name);
      if (!nameRes.ok) {
        errors.push(dErr(
          'INVALID_PROFILE_DIR',
          `profiles/${entry.name}`,
          `skipped invalid profile directory name: ${entry.name}`,
          nameRes.errors,
        ));
        continue;
      }
      validNames.push(entry.name);
    }
    validNames.sort();
    for (const name of validNames) {
      profiles.push(buildNamedProfile(homeDir, name, fsAdapter));
    }
  }

  return { kind: DISCOVERY_KIND, profiles, errors };
}

// Discover a single profile. `default` (only) maps to the default profile;
// every other name is validated and rejected with structured errors (never
// thrown) when malformed.
export function discoverOmpProfile(profileName, options = {}) {
  const { homeDir, fsAdapter } = resolveOptions(options);
  const errors = [];

  if (invalidHome(homeDir)) {
    errors.push(dErr('INVALID_HOME', 'homeDir', 'homeDir must be a non-empty string'));
    return { kind: DISCOVERY_KIND, profiles: [], errors };
  }

  if (profileName === 'default') {
    return { kind: DISCOVERY_KIND, profiles: [buildDefaultProfile(homeDir, fsAdapter)], errors };
  }

  const nameRes = validateProfileName(profileName);
  if (!nameRes.ok) {
    errors.push(...nameRes.errors);
    return { kind: DISCOVERY_KIND, profiles: [], errors };
  }

  return { kind: DISCOVERY_KIND, profiles: [buildNamedProfile(homeDir, profileName, fsAdapter)], errors };
}
