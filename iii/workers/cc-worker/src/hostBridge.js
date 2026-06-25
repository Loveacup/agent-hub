// Phase 3b cc-worker — host bridge contract helpers
const ALLOWED_ACTIONS = new Set(['execute', 'monitor', 'intervene', 'interrupt']);

export function validateBridgeRequest(req = {}) {
  if (!ALLOWED_ACTIONS.has(req.action)) {
    throw new Error('action_not_allowed');
  }
  if (req.action === 'execute') {
    if (!req.context_path || typeof req.context_path !== 'string' || !req.context_path.startsWith('/')) {
      throw new Error('absolute context_path required');
    }
  }
  if ((req.action === 'monitor' || req.action === 'intervene' || req.action === 'interrupt') && !req.session_id) {
    throw new Error('session_id_required');
  }
  return true;
}

export function buildBridgeResponse(kind, fields = {}) {
  return {
    kind,
    source: 'cc-host-bridge',
    ...fields,
    ts: new Date().toISOString(),
  };
}

export function buildInterventionContextPath({ session_id = 'unknown', now_ms = Date.now() } = {}) {
  const safeSession = String(session_id).replace(/[^A-Za-z0-9._-]/g, '_');
  return `/tmp/agent-hub-cc-intervention-${safeSession}-${now_ms}.md`;
}

export function buildMonitorRequiredRefusal({ session_id = '' } = {}) {
  return buildBridgeResponse('cc.intervention', {
    session_id,
    status: 'refused',
    error: 'monitor_required',
  });
}

export function buildInterruptRefusal({ session_id = '', confirm = false, reason = '' } = {}) {
  if (!confirm) {
    return buildBridgeResponse('cc.interrupt', {
      session_id,
      status: 'refused',
      error: 'confirm_required',
    });
  }
  if (!reason || typeof reason !== 'string' || reason.trim() === '') {
    return buildBridgeResponse('cc.interrupt', {
      session_id,
      status: 'refused',
      error: 'reason_required',
    });
  }
  return buildBridgeResponse('cc.interrupt', {
    session_id,
    status: 'allowed',
    reason,
  });
}
