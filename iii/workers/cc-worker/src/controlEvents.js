// Phase 3b cc-worker — control event publishing helpers
import { publishFrame } from './publish.js';

const ALLOWED_CONTROL_ACTIONS = new Set(['bridge_status', 'monitor', 'intervene', 'execute', 'interrupt']);

export function buildControlSubject(action) {
  if (!ALLOWED_CONTROL_ACTIONS.has(action)) throw new Error(`invalid control action: ${action}`);
  return `agent.cc.control.${action}`;
}

export async function callAndPublishControl(action, callFn, { publishFn = publishFrame } = {}) {
  const result = await callFn();
  try {
    await publishFn(buildControlSubject(action), result);
    return { ...result, event_published: true };
  } catch (err) {
    return {
      ...result,
      event_published: false,
      event_publish_error: err?.message ?? String(err),
    };
  }
}
