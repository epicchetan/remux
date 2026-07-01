const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { dirname, join } = require('node:path');

const clientRegisterMethod = 'remux/clients/register';
const notificationAudienceRemoveMethod = 'remux/notifications/audience/remove';
const notificationRequestMethod = 'remux/notifications/request';
const visibilityCheckMethod = 'remux/notifications/visibility/check';
const notificationDataKey = 'remuxNotificationIntent';
const notificationChannelId = 'remux-extension-events';
const visibilityCheckTimeoutMs = 500;
const expoPushSendUrl = 'https://exp.host/--/api/v2/push/send';
const codexCompactRequestMethod = 'remux/codex/thread/compact';
const terminalSessionAttachMethod = 'remux/terminal/session/attach';
const terminalSessionKillMethod = 'remux/terminal/session/kill';
const terminalSessionStartMethod = 'remux/terminal/session/start';

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
  const audiences = new Map();

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
      if (message.method === notificationAudienceRemoveMethod) {
        const target = parseNotificationAudienceTarget(message.params);
        if (!target) {
          logEvent(log, {
            detail: message.params,
            label: 'notifications:audience-remove:invalid',
            level: 'warn',
          });
          return true;
        }

        removeNotificationAudiences({
          audiences,
          log,
          reason: 'extension',
          target,
        });
        return true;
      }

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
      const audienceBucket = audienceKey ? audiences.get(audienceKey) : null;
      const deliveryAudiences = audienceBucket ? [...audienceBucket.values()] : [];
      if (deliveryAudiences.length === 0) {
        logEvent(log, {
          detail: notificationLogDetail(intent),
          label: 'notifications:intent:no-audience',
        });
        return true;
      }

      for (const audience of deliveryAudiences) {
        if (audience.lifetime === 'once') {
          audienceBucket.delete(audience.clientId);
        }

        await deliverNotification({
          audience,
          clients,
          fetchImpl,
          intent,
          log,
          storePath,
        });
      }
      if (audienceBucket.size === 0) {
        audiences.delete(audienceKey);
      }
      return true;
    },

    onClientDisconnected(client) {
      unregisterClientSession({ client, clients, log });
    },

    recordClientRequest({ client, request, result }) {
      if (!client.clientId) {
        return;
      }

      const change = notificationAudienceChangeForClientRequest(request, result);
      if (!change) {
        return;
      }

      if (change.type === 'remove') {
        removeNotificationAudiences({
          audiences,
          log,
          reason: request.method,
          target: change.target,
        });
        return;
      }

      recordNotificationAudience({
        audiences,
        client,
        lifetime: change.lifetime,
        log,
        method: request.method,
        origin: parseRemuxContext(request.remuxContext),
        target: change.target,
      });
    },
  };
}

function notificationAudienceChangeForClientRequest(request, result) {
  if (codexTurnRequestMethods.has(request.method)) {
    const threadId = requiredString(result?.threadId);
    const turnId = requiredString(result?.turnId);
    if (!threadId || !turnId) {
      return null;
    }

    return {
      lifetime: 'once',
      target: {
        extensionId: 'codex',
        focusId: turnId,
        focusKind: 'turn',
        resourceId: threadId,
        resourceKind: 'thread',
        viewId: 'main',
      },
      type: 'record',
    };
  }

  if (request.method === codexCompactRequestMethod) {
    const threadId = requiredString(result?.threadId);
    if (!threadId) {
      return null;
    }

    return {
      lifetime: 'once',
      target: {
        extensionId: 'codex',
        focusId: threadId,
        focusKind: 'thread',
        resourceId: threadId,
        resourceKind: 'thread',
        viewId: 'main',
      },
      type: 'record',
    };
  }

  if (request.method === terminalSessionStartMethod || request.method === terminalSessionAttachMethod) {
    const sessionId = requiredString(result?.sessionId);
    const status = optionalString(result?.status);
    if (!sessionId || status === 'exited') {
      return null;
    }

    return {
      lifetime: 'target',
      target: terminalNotificationTarget(sessionId),
      type: 'record',
    };
  }

  if (request.method === terminalSessionKillMethod) {
    const sessionId = requiredString(request.params?.sessionId);
    if (!sessionId) {
      return null;
    }

    return {
      target: terminalNotificationTarget(sessionId),
      type: 'remove',
    };
  }

  return null;
}

function terminalNotificationTarget(sessionId) {
  return {
    extensionId: 'terminal',
    focusId: sessionId,
    focusKind: 'session',
    resourceId: sessionId,
    resourceKind: 'terminalSession',
    viewId: 'main',
  };
}

function recordNotificationAudience({
  audiences,
  client,
  lifetime,
  log,
  method,
  origin,
  target,
}) {
  const key = notificationAudienceKey({
    extensionId: target.extensionId,
    id: 'pending',
    target,
    title: 'pending',
    viewId: target.viewId,
  });
  if (!key) {
    return;
  }

  let audienceBucket = audiences.get(key);
  if (!audienceBucket) {
    audienceBucket = new Map();
    audiences.set(key, audienceBucket);
  }

  audienceBucket.set(client.clientId, {
    clientId: client.clientId,
    createdAt: Date.now(),
    lifetime,
    originResourceKey: origin.resourceKey,
    originTabId: origin.tabId,
    sessionId: client.sessionId ?? null,
    target,
  });
  logEvent(log, {
    detail: {
      clientId: client.clientId,
      lifetime,
      method,
      origin,
      sessionId: client.sessionId ?? null,
      target,
    },
    label: 'notifications:audience:recorded',
    terminal: 'silent',
  });
}

function removeNotificationAudiences({
  audiences,
  log,
  reason,
  target,
}) {
  const keys = notificationAudienceRemovalKeys(audiences, target);
  let removed = 0;
  for (const key of keys) {
    const bucket = audiences.get(key);
    if (!bucket) {
      continue;
    }
    removed += bucket.size;
    audiences.delete(key);
  }

  logEvent(log, {
    detail: {
      reason,
      removed,
      target,
    },
    label: 'notifications:audience:removed',
    terminal: 'silent',
  });
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

  const deliveredIntent = intentForAudience(intent, audience);

  if (await isClientViewingIntent(clientState, deliveredIntent, log)) {
    logEvent(log, {
      detail: notificationLogDetail(deliveredIntent),
      label: 'notifications:push:suppressed-visible',
      terminal: 'silent',
    });
    return;
  }

  await sendExpoPush({
    clients,
    clientState,
    fetchImpl,
    intent: deliveredIntent,
    log,
    storePath,
  });
}

function intentForAudience(intent, audience) {
  return {
    ...intent,
    target: {
      ...intent.target,
      originResourceKey: audience.originResourceKey ?? null,
      originTabId: audience.originTabId ?? null,
    },
  };
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
      channelId: notificationChannelId,
      data: {
        [notificationDataKey]: intent,
      },
      interruptionLevel: 'active',
      priority: 'high',
      sound: 'default',
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
    activeTarget: parseBrowserResourceTarget(value.activeTarget),
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
      originResourceKey: optionalString(target.originResourceKey),
      originTabId: optionalString(target.originTabId),
      resourceId: optionalString(target.resourceId),
      resourceKind: optionalString(target.resourceKind),
    },
    title,
    viewId: optionalString(value.viewId) ?? 'main',
  };
}

function parseRemuxContext(value) {
  if (!isRecord(value)) {
    return {
      resourceKey: null,
      tabId: null,
    };
  }

  return {
    resourceKey: optionalString(value.resourceKey),
    tabId: optionalString(value.tabId),
  };
}

function parseNotificationAudienceTarget(value) {
  if (!isRecord(value)) {
    return null;
  }

  const extensionId = requiredString(value.extensionId);
  if (!extensionId) {
    return null;
  }

  const target = isRecord(value.target) ? value.target : {};
  return {
    extensionId,
    focusId: optionalString(target.focusId),
    focusKind: optionalString(target.focusKind),
    handlerId: optionalString(target.handlerId),
    launch: optionalString(target.launch),
    resourceId: optionalString(target.resourceId),
    resourceKind: optionalString(target.resourceKind),
    viewId: optionalString(value.viewId) ?? 'main',
  };
}

function parseBrowserResourceTarget(value) {
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
    target.handlerId || '',
    target.launch || '',
    target.resourceKind,
    target.resourceId,
    target.focusKind,
    target.focusId,
  ].join(':');
}

function notificationAudienceRemovalKeys(audiences, target) {
  const exactKey = notificationAudienceKey({
    extensionId: target.extensionId,
    id: 'pending',
    target,
    title: 'pending',
    viewId: target.viewId,
  });
  if (exactKey) {
    return audiences.has(exactKey) ? [exactKey] : [];
  }

  return [...audiences.entries()].flatMap(([key, bucket]) => {
    const audience = bucket.values().next().value;
    return audience && notificationTargetsShareTabTarget(audience.target, target) ? [key] : [];
  });
}

function notificationTargetsShareTabTarget(left, right) {
  return left.extensionId === right.extensionId &&
    (left.viewId || 'main') === (right.viewId || 'main') &&
    nullableString(left.handlerId) === nullableString(right.handlerId) &&
    nullableString(left.launch) === nullableString(right.launch) &&
    nullableString(left.resourceKind) === nullableString(right.resourceKind) &&
    nullableString(left.resourceId) === nullableString(right.resourceId);
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

function nullableString(value) {
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
  notificationAudienceRemoveMethod,
  notificationRequestMethod,
};
