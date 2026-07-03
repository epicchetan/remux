const previewInvalidateMethod = 'remux/previews/invalidate';
const defaultMinIntervalMs = 1_000;
const staleResourceStateMs = 60_000;
const resourceStateSweepThreshold = 512;

// Relays extension preview invalidations to connected clients while guarding
// the websocket: at most one broadcast per second per resource, with a
// trailing send so the last invalidation of a burst always gets through.
function createPreviewRelay({ log = console, minIntervalMs = defaultMinIntervalMs } = {}) {
  const resources = new Map();

  return {
    close() {
      for (const state of resources.values()) {
        if (state.timer) {
          clearTimeout(state.timer);
        }
      }
      resources.clear();
    },

    handleExtensionNotification({ broadcast, message }) {
      if (message.method !== previewInvalidateMethod) {
        return false;
      }

      const target = parsePreviewInvalidationTarget(message.params);
      if (!target) {
        logEvent(log, {
          detail: message.params,
          label: 'previews:invalidate:invalid',
          level: 'warn',
        });
        return true;
      }

      sweepStaleResourceStates(resources);

      const key = previewResourceKey(target);
      const payload = {
        method: previewInvalidateMethod,
        params: previewInvalidationParams(target),
      };
      let state = resources.get(key);
      if (!state) {
        state = { lastSentAt: 0, pending: null, timer: null };
        resources.set(key, state);
      }

      const now = Date.now();
      if (!state.timer && now - state.lastSentAt >= minIntervalMs) {
        state.lastSentAt = now;
        broadcast(payload);
        return true;
      }

      state.pending = payload;
      if (!state.timer) {
        const wait = Math.max(0, state.lastSentAt + minIntervalMs - now);
        state.timer = setTimeout(() => {
          state.timer = null;
          const pending = state.pending;
          state.pending = null;
          if (pending) {
            state.lastSentAt = Date.now();
            broadcast(pending);
          }
        }, wait);
        state.timer.unref?.();
      }
      return true;
    },
  };
}

function parsePreviewInvalidationTarget(params) {
  if (!isRecord(params)) {
    return null;
  }

  const extensionId = optionalString(params.extensionId);
  if (!extensionId) {
    return null;
  }

  return {
    extensionId,
    resourceId: optionalString(params.resourceId),
    resourceKind: optionalString(params.resourceKind),
    viewId: optionalString(params.viewId),
  };
}

function previewInvalidationParams(target) {
  return {
    extensionId: target.extensionId,
    ...(target.resourceKind ? { resourceKind: target.resourceKind } : {}),
    ...(target.resourceId ? { resourceId: target.resourceId } : {}),
    ...(target.viewId ? { viewId: target.viewId } : {}),
  };
}

function previewResourceKey(target) {
  return [
    target.extensionId,
    target.viewId || 'main',
    target.resourceKind || '',
    target.resourceId || '',
  ].join(':');
}

function sweepStaleResourceStates(resources) {
  if (resources.size < resourceStateSweepThreshold) {
    return;
  }

  const cutoff = Date.now() - staleResourceStateMs;
  for (const [key, state] of resources) {
    if (!state.timer && state.lastSentAt < cutoff) {
      resources.delete(key);
    }
  }
}

function logEvent(log, event) {
  if (typeof log?.event === 'function') {
    log.event(event);
    return;
  }

  const message = event.detail === undefined
    ? `[remux] ${event.label}`
    : `[remux] ${event.label} ${JSON.stringify(event.detail)}`;
  if (event.level === 'warn') {
    log?.warn?.(message);
    return;
  }
  log?.log?.(message);
}

function optionalString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

module.exports = {
  createPreviewRelay,
  previewInvalidateMethod,
};
