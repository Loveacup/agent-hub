// Phase 3b cc-worker — VM-to-host bridge client
const DEFAULT_BRIDGE_BASE_URL = 'http://100.96.0.1:8767';

export function buildBridgeUrl(path = '/control', baseUrl = process.env.CC_HOST_BRIDGE_URL || DEFAULT_BRIDGE_BASE_URL) {
  const cleanBase = baseUrl.replace(/\/$/, '');
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  return `${cleanBase}${cleanPath}`;
}

export async function callHostBridge(payload, {
  fetchFn = globalThis.fetch,
  token = process.env.CC_HOST_BRIDGE_TOKEN || '',
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
