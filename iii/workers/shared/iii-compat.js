// iii-compat.js — iii-sdk version compatibility adapter
//
// Purpose
// -------
// A single seam that isolates every worker from version-specific quirks of
// `iii-sdk`. Workers SHOULD route SDK access through this module so that a
// future iii upgrade is a one-file change here instead of an edit in every
// worker.
//
// Verified facts (0.19.x → 0.20.0)
// --------------------------------
//   - `iii-sdk` still exports `registerWorker` from the package root. The
//     returned client changed type (ISdk → IIIClient) but keeps the same
//     surface used by the workers: `client.registerFunction(name, handler)`.
//   - `iii-sdk@0.20.0` pulls in `@iii-dev/helpers@0.20.0` transitively.
//   - `@iii-dev/observability` is deprecated; observability now lives under
//     `@iii-dev/helpers/observability`. No worker imports it directly.
//   - Engine WS URL resolution is unchanged.
//
// Future iii upgrades: bump SUPPORTED_RANGE, and if `registerWorker` ever
// moves or its signature changes, branch inside `getRegisterWorker()`.

// Best-effort target version. Informational only — actual behaviour is driven
// by what the installed `iii-sdk` exports, not by this string.
export const III_SDK_VERSION = process.env.III_SDK_VERSION || '0.20.0';

// Versions this adapter has been validated against. Major bumps beyond this
// range should be treated as "needs a new adapter branch".
export const SUPPORTED_RANGE = '>=0.19.0 <0.21.0';

/**
 * Detect the installed iii-sdk version from package metadata.
 * Returns the version string or null if iii-sdk is not installed.
 * @param {string} [cwd] — directory to resolve from (default: current file's dir)
 * @returns {string|null}
 */
export async function detectSdkVersion(cwd) {
  try {
    const { createRequire } = await import('node:module');
    const req = createRequire(cwd || import.meta.url);
    const pkg = req('iii-sdk/package.json');
    return pkg?.version || null;
  } catch {
    return null;
  }
}

const DEFAULT_ENGINE_URL = 'ws://localhost:49134';

/**
 * Resolve the engine WebSocket URL the same way every worker does.
 * Precedence: III_ENGINE_URL → III_URL → default.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function getEngineUrl(env = process.env) {
  return env.III_ENGINE_URL || env.III_URL || DEFAULT_ENGINE_URL;
}

/**
 * Return the `registerWorker` factory from `iii-sdk`, tolerant of the export
 * shape across supported versions.
 *
 * `loader` is injectable purely for tests; in production it dynamically
 * imports `iii-sdk` (each worker has its own copy installed).
 *
 * @param {() => Promise<any>} [loader]
 * @returns {Promise<Function>} the registerWorker factory
 */
export async function getRegisterWorker(loader = () => import('iii-sdk')) {
  const mod = await loader();
  // 0.19.x and 0.20.x both export from root; tolerate default-wrapped builds.
  const registerWorker = mod.registerWorker ?? mod.default?.registerWorker;
  if (typeof registerWorker !== 'function') {
    throw new Error(
      `iii-compat: 'registerWorker' not found in iii-sdk export ` +
        `(expected a function for ${SUPPORTED_RANGE}). ` +
        `The SDK export shape may have changed — add an adapter branch in iii-compat.js.`,
    );
  }
  return registerWorker;
}

/**
 * Convenience: load `registerWorker` and create a client in one call.
 * @param {string} workerName
 * @param {object} [opts]
 * @param {string} [opts.engineUrl] — overrides env-derived URL
 * @param {() => Promise<any>} [opts.loader] — injectable for tests
 * @returns {Promise<any>} the iii client (exposes `.registerFunction`)
 */
export async function createWorker(workerName, opts = {}) {
  const { engineUrl = getEngineUrl(), loader } = opts;
  const registerWorker = await getRegisterWorker(loader);
  return registerWorker(engineUrl, { workerName });
}
