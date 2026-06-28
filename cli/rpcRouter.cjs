const { JsonRpcError } = require('./jsonRpc.cjs');
const { isCoreMethod } = require('./core/coreRouter.cjs');

const extensionStatusMethod = 'remux/extensions/status';
const extensionStartMethod = 'remux/extensions/start';
const extensionStopMethod = 'remux/extensions/stop';
const extensionRestartMethod = 'remux/extensions/restart';
const systemRestartMethod = 'remux/system/restart';

function createRpcRouter({
  coreRouter,
  defaultExtensionId,
  defaultExtensionServer,
  extensionServers,
  log = console,
  system = {},
} = {}) {
  const servers = normalizeExtensionServers({
    defaultExtensionId,
    defaultExtensionServer,
    extensionServers,
  });
  let ctx = null;

  return {
    async start(nextCtx) {
      ctx = nextCtx;
      await Promise.all([...servers.values()].map((server) => server.start?.(nextCtx)));
    },

    async handleRequest(request) {
      if (isSystemMethod(request.method)) {
        return handleSystemRequest({
          request,
          system,
        });
      }

      if (isExtensionManagementMethod(request.method)) {
        return handleExtensionManagementRequest({
          ctx,
          request,
          servers,
        });
      }

      if (isCoreMethod(request.method)) {
        if (!coreRouter?.handleRpc) {
          throw new JsonRpcError(-32601, `Method not found: ${request.method}`);
        }

        return coreRouter.handleRpc(request);
      }

      const extensionId = extensionIdFromMethod(request.method) || defaultExtensionId;
      const server = extensionId ? servers.get(extensionId) : null;

      if (!server?.handleRpc) {
        throw new JsonRpcError(-32601, `Method not found: ${request.method}`);
      }

      return server.handleRpc(request);
    },

    async stop() {
      await Promise.all([...servers.entries()].map(async ([extensionId, server]) => {
        try {
          await server.stop?.();
        } catch (error) {
          log.warn?.(`[remux] extension ${extensionId} stop failed: ${errorMessage(error)}`);
        }
      }));
      ctx = null;
    },
  };
}

async function handleSystemRequest({ request, system }) {
  if (request.method === systemRestartMethod) {
    if (typeof system.restart !== 'function') {
      return {
        restartable: false,
        restarting: false,
      };
    }

    await system.restart();
    return {
      restartable: true,
      restarting: true,
    };
  }

  throw new JsonRpcError(-32601, `Method not found: ${request.method}`);
}

function isSystemMethod(method) {
  return method === systemRestartMethod;
}

async function handleExtensionManagementRequest({ ctx, request, servers }) {
  if (request.method === extensionStatusMethod) {
    return {
      extensions: [...servers.entries()].map(([extensionId, server]) => ({
        extensionId,
        ...extensionServerStatus(server),
      })),
    };
  }

  if (request.method === extensionStartMethod) {
    const extensionId = extensionIdFromParams(request.params, extensionStartMethod);
    const server = servers.get(extensionId);
    if (!server || typeof server.start !== 'function' || !ctx) {
      return {
        extensionId,
        restartable: false,
        running: false,
        started: false,
      };
    }

    const status = await server.start(ctx);
    return {
      extensionId,
      ...extensionServerStatusFromResult(status ?? extensionServerStatus(server)),
      started: true,
    };
  }

  if (request.method === extensionStopMethod) {
    const extensionId = extensionIdFromParams(request.params, extensionStopMethod);
    const server = servers.get(extensionId);
    if (!server || typeof server.stop !== 'function') {
      return {
        extensionId,
        restartable: false,
        running: false,
        stopped: false,
      };
    }

    const status = await server.stop();
    return {
      extensionId,
      ...extensionServerStatusFromResult(status ?? extensionServerStatus(server)),
      stopped: true,
    };
  }

  if (request.method === extensionRestartMethod) {
    const extensionId = extensionIdFromParams(request.params, extensionRestartMethod);
    const server = servers.get(extensionId);
    if (!server) {
      return {
        extensionId,
        restartable: false,
        restarted: false,
        running: false,
      };
    }

    if (typeof server.restart === 'function') {
      const status = await server.restart(ctx);
      return {
        extensionId,
        ...extensionServerStatusFromResult(status),
        restarted: true,
      };
    }

    if (!ctx || typeof server.stop !== 'function' || typeof server.start !== 'function') {
      return {
        extensionId,
        ...extensionServerStatus(server),
        restarted: false,
      };
    }

    await server.stop();
    await server.start(ctx);
    return {
      extensionId,
      ...extensionServerStatus(server),
      restarted: true,
    };
  }

  throw new JsonRpcError(-32601, `Method not found: ${request.method}`);
}

function isExtensionManagementMethod(method) {
  return (
    method === extensionStatusMethod ||
    method === extensionStartMethod ||
    method === extensionStopMethod ||
    method === extensionRestartMethod
  );
}

function extensionIdFromParams(params, method) {
  const extensionId = isRecord(params) && typeof params.extensionId === 'string'
    ? params.extensionId
    : null;

  if (!extensionId) {
    throw new JsonRpcError(-32602, `Invalid ${method} params`);
  }

  return extensionId;
}

function extensionServerStatus(server) {
  if (typeof server?.status === 'function') {
    return extensionServerStatusFromResult(server.status());
  }

  return {
    restartable: Boolean(server?.start && server?.stop),
    running: Boolean(server),
  };
}

function extensionServerStatusFromResult(result) {
  return {
    restartable: Boolean(result?.restartable),
    running: Boolean(result?.running),
  };
}

function normalizeExtensionServers({
  defaultExtensionId,
  defaultExtensionServer,
  extensionServers,
}) {
  if (extensionServers instanceof Map) {
    return extensionServers;
  }

  const servers = new Map();
  if (defaultExtensionId && defaultExtensionServer) {
    servers.set(defaultExtensionId, defaultExtensionServer);
  }

  return servers;
}

function extensionIdFromMethod(method) {
  if (typeof method !== 'string') {
    return null;
  }

  const match = /^remux\/([^/]+)\//u.exec(method);
  return match ? match[1] : null;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

module.exports = {
  createRpcRouter,
  extensionIdFromMethod,
  extensionRestartMethod,
  extensionStartMethod,
  extensionStatusMethod,
  extensionStopMethod,
  systemRestartMethod,
};
