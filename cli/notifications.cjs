const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { dirname, join } = require('node:path');

const clientRegisterMethod = 'remux/clients/register';
const notificationRequestMethod = 'remux/notifications/request';
const visibilityCheckMethod = 'remux/notifications/visibility/check';
const notificationDataKey = 'remuxNotificationIntent';
const visibilityCheckTimeoutMs = 500;
const expoPushSendUrl = 'https://exp.host/--/api/v2/push/send';
const codexCompactRequestMethod = 'remux/codex/thread/compact';

const codexTurnRequestMethods = new Set([
  'remux/codex/thread/message/edit',
  'remux/codex/thread/message/fork',
  'remux/codex/thread/message/send',
  'remux/codex/thread/message/start',
]);

function createNotificationManager({
  fetchImpl = globalThis.fetch,
  log = console,
  rootDir = process.cwd(),
} = {}) {
  const storePath = join(rootDir, '.remux', 'notifications', 'clients.json');
  const clients = loadPersistedClients(storePath);
  const pendingAudiences = new Map();

  return {
    canHandleClientRequest(method) {
      return method === clientRegisterMethod;
    },

    async handleClientRequest({ client, method, params }) {
      if (method !== clientRegisterMethod) {
        throw new Error(`Method not found: ${method}`);
      }

      const registration = parseClientRegistration(params);
      registerClientSession({
        client,
        clients,
        log,
        registration,
        storePath,
      });
      return { ok: true };
    },

    async handleExtensionNotification(message) {
      if (message.method !== notificationRequestMethod) {
        return false;
      }

      const intent = parseNotificationIntent(message.params);
      if (!intent) {
        logEvent(log, {
          detail: message.params,
          label: 'notifications:intent:invalid',
          level: 'warn',
        });
        return true;
      }

      const audienceKey = notificationAudienceKey(intent);
      const audience = audienceKey ? pendingAudiences.get(audienceKey) : null;
      if (!audience) {
        logEvent(log, {
          detail: notificationLogDetail(intent),
          label: 'notifications:intent:no-audience',
        });
        return true;
      }

      pendingAudiences.delete(audienceKey);
      await deliverNotification({
        audience,
        clients,
        fetchImpl,
        intent,
        log,
        storePath,
      });
      return true;
    },

    onClientDisconnected(client) {
      unregisterClientSession({ client, clients, log });
    },

    recordClientRequest({ client, request, result }) {
      if (!client.clientId) {
        return;
      }

      const target = notificationTargetForClientRequest(request, result);
      if (!target) {
        return;
      }

      const key = notificationAudienceKey({
        extensionId: 'codex',
        id: 'pending',
        target,
        title: 'pending',
        viewId: 'main',
      });
      if (!key) {
        return;
      }

      pendingAudiences.set(key, {
        clientId: client.clientId,
        createdAt: Date.now(),
        sessionId: client.sessionId ?? null,
        target,
      });
      logEvent(log, {
        detail: {
          clientId: client.clientId,
          method: request.method,
          sessionId: client.sessionId ?? null,
          target,
        },
        label: 'notifications:audience:recorded',
        terminal: 'silent',
      });
    },
  };
}

function notificationTargetForClientRequest(request, result) {
  if (codexTurnRequestMethods.has(request.method)) {
    const threadId = requiredString(result?.threadId);
    const turnId = requiredString(result?.turnId);
    if (!threadId || !turnId) {
      return null;
    }

    return {
      extensionId: 'codex',
      focusId: turnId,
      focusKind: 'turn',
      resourceId: threadId,
      resourceKind: 'thread',
      viewId: 'main',
    };
  }

  if (request.method === codexCompactRequestMethod) {
    const threadId = requiredString(result?.threadId);
    if (!threadId) {
      return null;
    }

    return {
      extensionId: 'codex',
      focusId: threadId,
      focusKind: 'thread',
      resourceId: threadId,
      resourceKind: 'thread',
      viewId: 'main',
    };
  }

  return null;
}

function registerClientSession({
  client,
  clients,
  log,
  registration,
  storePath,
}) {
  let clientState = clients.get(registration.clientId);
  if (!clientState) {
    clientState = {
      clientId: registration.clientId,
      expoPushToken: null,
      sessions: new Map(),
      updatedAt: null,
    };
    clients.set(registration.clientId, clientState);
  }

  if (registration.expoPushToken) {
    clientState.expoPushToken = registration.expoPushToken;
    clientState.updatedAt = new Date().toISOString();
    persistClients(storePath, clients);
  }

  const previousClientId = client.clientId;
  const previousSessionId = client.sessionId;
  if (
    previousClientId &&
    previousSessionId &&
    (previousClientId !== registration.clientId || previousSessionId !== registration.sessionId)
  ) {
    clients.get(previousClientId)?.sessions.delete(previousSessionId);
  }

  client.clientId = registration.clientId;
  client.sessionId = registration.sessionId;
  clientState.sessions.set(registration.sessionId, {
    activeTarget: registration.activeTarget,
    appState: registration.appState,
    client,
    lastSeenAt: Date.now(),
    platform: registration.platform,
    sessionId: registration.sessionId,
  });

  logEvent(log, {
    detail: {
      appState: registration.appState,
      clientId: registration.clientId,
      hasExpoPushToken: Boolean(clientState.expoPushToken),
      sessionId: registration.sessionId,
      target: registration.activeTarget,
    },
    label: 'notifications:client:registered',
    terminal: 'silent',
  });
}

function unregisterClientSession({ client, clients, log }) {
  if (!client.clientId || !client.sessionId) {
    return;
  }

  const clientState = clients.get(client.clientId);
  clientState?.sessions.delete(client.sessionId);
  logEvent(log, {
    detail: {
      clientId: client.clientId,
      sessionId: client.sessionId,
    },
    label: 'notifications:client:disconnected',
    terminal: 'silent',
  });
}

async function deliverNotification({
  audience,
  clients,
  fetchImpl,
  intent,
  log,
  storePath,
}) {
  const clientState = clients.get(audience.clientId);
  if (!clientState?.expoPushToken) {
    logEvent(log, {
      detail: {
        audience,
        intent: notificationLogDetail(intent),
      },
      label: 'notifications:push:no-token',
    });
    return;
  }

  if (await isClientViewingIntent(clientState, intent, log)) {
    logEvent(log, {
      detail: notificationLogDetail(intent),
      label: 'notifications:push:suppressed-visible',
      terminal: 'silent',
    });
    return;
  }

  await sendExpoPush({
    clients,
    clientState,
    fetchImpl,
    intent,
    log,
    storePath,
  });
}

async function isClientViewingIntent(clientState, intent, log) {
  const sessions = [...clientState.sessions.values()];
  if (sessions.length === 0) {
    return false;
  }

  const results = await Promise.all(sessions.map(async (session) => {
    try {
      const result = await session.client.request(
        visibilityCheckMethod,
        intent,
        visibilityCheckTimeoutMs,
      );
      return result?.visible === true;
    } catch (error) {
      logEvent(log, {
        detail: {
          clientId: clientState.clientId,
          error: errorMessage(error),
          sessionId: session.sessionId,
        },
        label: 'notifications:visibility-check:failed',
        terminal: 'silent',
      });
      return false;
    }
  }));

  return results.some(Boolean);
}

async function sendExpoPush({
  clients,
  clientState,
  fetchImpl,
  intent,
  log,
  storePath,
}) {
  if (typeof fetchImpl !== 'function') {
    logEvent(log, {
      detail: notificationLogDetail(intent),
      label: 'notifications:push:fetch-unavailable',
      level: 'warn',
    });
    return;
  }

  const response = await fetchImpl(expoPushSendUrl, {
    body: JSON.stringify({
      body: intent.body ?? undefined,
      data: {
        [notificationDataKey]: intent,
      },
      title: intent.title,
      to: clientState.expoPushToken,
    }),
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
    },
    method: 'POST',
  });

  const body = await parseResponseBody(response);
  if (!response.ok) {
    logEvent(log, {
      detail: {
        body,
        intent: notificationLogDetail(intent),
        status: response.status,
      },
      label: 'notifications:push:failed',
      level: 'warn',
    });
    return;
  }

  const ticket = Array.isArray(body?.data) ? body.data[0] : body?.data;
  if (ticket?.status === 'error') {
    if (ticket.details?.error === 'DeviceNotRegistered') {
      clientState.expoPushToken = null;
      clientState.updatedAt = new Date().toISOString();
      persistClients(storePath, clients);
    }

    logEvent(log, {
      detail: {
        intent: notificationLogDetail(intent),
        ticket,
      },
      label: 'notifications:push:ticket-error',
      level: 'warn',
    });
    return;
  }

  logEvent(log, {
    detail: {
      intent: notificationLogDetail(intent),
      ticket,
    },
    label: 'notifications:push:sent',
    terminal: 'silent',
  });
}

async function parseResponseBody(response) {
  try {
    return await response.json();
  } catch {
    try {
      return await response.text();
    } catch {
      return null;
    }
  }
}

function parseClientRegistration(value) {
  if (!isRecord(value)) {
    throw new Error('Invalid client registration params');
  }

  const clientId = requiredString(value.clientId);
  const sessionId = requiredString(value.sessionId);
  if (!clientId || !sessionId) {
    throw new Error('Invalid client registration params');
  }

  return {
    activeTarget: parseBrowserTabTarget(value.activeTarget),
    appState: optionalString(value.appState) ?? 'unknown',
    clientId,
    expoPushToken: optionalString(value.expoPushToken),
    platform: optionalString(value.platform) ?? 'unknown',
    sessionId,
  };
}

function parseNotificationIntent(value) {
  if (!isRecord(value)) {
    return null;
  }

  const id = requiredString(value.id);
  const extensionId = requiredString(value.extensionId);
  const title = requiredString(value.title);
  if (!id || !extensionId || !title) {
    return null;
  }

  const target = isRecord(value.target) ? value.target : {};
  return {
    body: optionalString(value.body),
    extensionId,
    id,
    target: {
      focusId: optionalString(target.focusId),
      focusKind: optionalString(target.focusKind),
      handlerId: optionalString(target.handlerId),
      launch: optionalString(target.launch),
      resourceId: optionalString(target.resourceId),
      resourceKind: optionalString(target.resourceKind),
    },
    title,
    viewId: optionalString(value.viewId) ?? 'main',
  };
}

function parseBrowserTabTarget(value) {
  if (!isRecord(value)) {
    return null;
  }

  const extensionId = requiredString(value.extensionId);
  if (!extensionId) {
    return null;
  }

  return {
    extensionId,
    handlerId: optionalString(value.handlerId),
    launch: optionalString(value.launch),
    resourceId: optionalString(value.resourceId),
    resourceKind: optionalString(value.resourceKind),
    viewId: optionalString(value.viewId) ?? 'main',
  };
}

function notificationAudienceKey(intent) {
  const target = intent.target ?? {};
  if (
    !intent.extensionId ||
    !target.resourceKind ||
    !target.resourceId ||
    !target.focusKind ||
    !target.focusId
  ) {
    return null;
  }

  return [
    intent.extensionId,
    intent.viewId || 'main',
    target.resourceKind,
    target.resourceId,
    target.focusKind,
    target.focusId,
  ].join(':');
}

function notificationLogDetail(intent) {
  return {
    bodyLength: intent.body?.length ?? 0,
    bodyPreview: intent.body ? intent.body.slice(0, 120) : null,
    extensionId: intent.extensionId,
    focusId: intent.target.focusId,
    focusKind: intent.target.focusKind,
    id: intent.id,
    resourceId: intent.target.resourceId,
    resourceKind: intent.target.resourceKind,
    title: intent.title,
    viewId: intent.viewId,
  };
}

function loadPersistedClients(storePath) {
  try {
    const parsed = JSON.parse(readFileSync(storePath, 'utf8'));
    if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.clients)) {
      return new Map();
    }

    return new Map(Object.entries(parsed.clients).flatMap(([clientId, client]) => {
      if (!isRecord(client)) {
        return [];
      }

      return [[clientId, {
        clientId,
        expoPushToken: optionalString(client.expoPushToken),
        sessions: new Map(),
        updatedAt: optionalString(client.updatedAt),
      }]];
    }));
  } catch {
    return new Map();
  }
}

function persistClients(storePath, clients) {
  mkdirSync(dirname(storePath), { recursive: true });
  writeFileSync(storePath, JSON.stringify({
    clients: Object.fromEntries([...clients.entries()].map(([clientId, client]) => [
      clientId,
      {
        expoPushToken: client.expoPushToken,
        updatedAt: client.updatedAt,
      },
    ])),
    version: 1,
  }, null, 2));
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
  if (event.level === 'error') {
    log?.error?.(message);
    return;
  }
  log?.log?.(message);
}

function requiredString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function optionalString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

module.exports = {
  clientRegisterMethod,
  createNotificationManager,
  notificationRequestMethod,
};
