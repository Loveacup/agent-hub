// Phase 3b cc-worker — VM-to-host bridge client
import { resolveBridgeToken } from './token.js';

const DEFAULT_BRIDGE_BASE_URL = 'http://100.96.0.1:8767';

export function buildBridgeUrl(path = '/control', baseUrl = process.env.CC_HOST_BRIDGE_URL || DEFAULT_BRIDGE_BASE_URL) {
  const cleanBase = baseUrl.replace(/\/$/, '');
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  return `${cleanBase}${cleanPath}`;
}

export async function checkHostBridge({
  fetchFn = globalThis.fetch,
  token = resolveBridgeToken(),
  baseUrl = process.env.CC_HOST_BRIDGE_URL || DEFAULT_BRIDGE_BASE_URL,
} = {}) {
  try {
    const res = await fetchFn(buildBridgeUrl('/healthz', baseUrl), {
      method: 'GET',
      headers: { 'x-agent-hub-token': token },
    });
    if (!res.ok) {
      if (res.status === 401) return { kind: 'cc.bridge_status', status: 'error', error: 'host_bridge_unauthorized' };
      return { kind: 'cc.bridge_status', status: 'error', error: 'host_bridge_http_error', status_code: res.status };
    }
    return { kind: 'cc.bridge_status', status: 'ok', bridge: await res.json(), ts: new Date().toISOString() };
  } catch (err) {
    return { kind: 'cc.bridge_status', status: 'error', error: 'host_bridge_unavailable', detail: err?.message ?? String(err), ts: new Date().toISOString() };
  }
}

export async function callHostBridge(payload, {
  fetchFn = globalThis.fetch,
  token = resolveBridgeToken(),
  baseUrl = process.env.CC_HOST_BRIDGE_URL || DEFAULT_BRIDGE_BASE_URL,
} = {}) {
  try {
    const res = await fetchFn(buildBridgeUrl('/control', baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-agent-hub-token': token,
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      if (res.status === 401) {
        return { kind: 'cc.bridge', status: 'error', error: 'host_bridge_unauthorized' };
      }
      return {
        kind: 'cc.bridge',
        status: 'error',
        error: 'host_bridge_http_error',
        status_code: res.status,
        body: typeof res.text === 'function' ? await res.text() : '',
      };
    }

    return await res.json();
  } catch (err) {
    return {
      kind: 'cc.bridge',
      status: 'error',
      error: 'host_bridge_unavailable',
      detail: err?.message ?? String(err),
    };
  }
}
