const WebSocket = require('ws');
const WebSocketServer = WebSocket.Server;

const {
  JsonRpcError,
  errorMessage,
  isJsonRpcResponse,
  isJsonRpcRequest,
  parseJsonRpcFrame,
  responseMessage,
  withJsonRpcVersion,
} = require('./jsonRpc.cjs');

const remuxWebSocketPath = '/ws';

function attachRemuxWebSocketServer({
  fsWatch,
  log = console,
  onFatal,
  notifications,
  router,
  server,
}) {
  const clients = new Set();
  const wss = new WebSocketServer({ noServer: true });

  const broadcast = (message) => {
    const payload = JSON.stringify(withJsonRpcVersion(message));
    for (const client of clients) {
      if (client.socket.readyState === WebSocket.OPEN) {
        client.socket.send(payload);
      }
    }
  };

  const ctx = {
    broadcast,
    fatal: (reason, code = 1) => {
      if (onFatal) {
        onFatal(reason, code);
        return;
      }

      log.error?.(reason);
      process.exit(code);
    },
    log: {
      error(message, extra) {
        log.error?.(formatLog(message, extra));
      },
      info(message, extra) {
        log.log?.(formatLog(message, extra));
      },
      warn(message, extra) {
        log.warn?.(formatLog(message, extra));
      },
    },
    async handleExtensionNotification(message) {
      return notifications?.handleExtensionNotification?.(message) ?? false;
    },
  };

  server.on('upgrade', (request, socket, head) => {
    if (!isRemuxWebSocketPath(request.url)) {
      return;
    }

    wss.handleUpgrade(request, socket, head, (downstream) => {
      const client = createDownstreamClient(downstream);
      clients.add(client);
      fsWatch?.onClientCountChanged?.(clients.size);
      log.log?.(`[remux] websocket opened ${request.socket.remoteAddress || 'unknown-remote'}`);

      downstream.on('message', (frame) => {
        void handleDownstreamFrame({ client, frame, log, notifications, router });
      });

      downstream.on('close', (code, reason) => {
        clients.delete(client);
        fsWatch?.onClientCountChanged?.(clients.size);
        client.rejectPendingRequests(new Error(`WebSocket closed (${code})`));
        notifications?.onClientDisconnected?.(client);
        log.log?.(`[remux] websocket closed code=${code} reason=${reason || '(empty)'}`);
      });

      downstream.on('error', () => {
        clients.delete(client);
        fsWatch?.onClientCountChanged?.(clients.size);
        client.rejectPendingRequests(new Error('WebSocket error'));
        notifications?.onClientDisconnected?.(client);
      });
    });
  });

  return {
    broadcast,
    close() {
      for (const client of clients) {
        client.socket.close();
        client.rejectPendingRequests(new Error('WebSocket closed'));
      }
      clients.clear();
      wss.close();
    },
    ctx,
  };
}

async function handleDownstreamFrame({ client, frame, log, notifications, router }) {
  const parsed = parseJsonRpcFrame(frame);
  if (parsed.error) {
    sendJsonRpcMessage(client.socket, errorMessage(parsed.id, parsed.error));
    return;
  }

  const message = parsed.message;
  if (isJsonRpcResponse(message)) {
    if (!client.resolvePendingRequest(message)) {
      log.warn?.(`[remux] ignored unmatched downstream response: ${message.id}`);
    }
    return;
  }

  if (!isJsonRpcRequest(message)) {
    if (message && typeof message.method === 'string') {
      if (message.method === 'remux/app/log') {
        logAppDiagnostic(message.params, log);
        return;
      }

      if (typeof router?.handleNotification === 'function') {
        void router.handleNotification({
          method: message.method,
          params: message.params,
        }).catch((error) => {
          log.warn?.(`[remux] downstream notification failed: ${message.method}: ${errorMessageForLog(error)}`);
        });
        return;
      }

      log.warn?.(`[remux] ignored downstream notification: ${message.method}`);
      return;
    }

    sendJsonRpcMessage(client.socket, errorMessage(parsed.id, new JsonRpcError(-32600, 'Invalid request')));
    return;
  }

  try {
    const result = notifications?.canHandleClientRequest?.(message.method)
      ? await notifications.handleClientRequest({
        client,
        method: message.method,
        params: message.params,
      })
      : await router.handleRequest({
        client,
        method: message.method,
        params: message.params,
      });
    notifications?.recordClientRequest?.({ client, request: message, result });
    sendJsonRpcMessage(client.socket, responseMessage(message.id, result));
  } catch (error) {
    sendJsonRpcMessage(client.socket, errorMessage(message.id, error));
  }
}

function errorMessageForLog(error) {
  return error instanceof Error ? error.message : String(error);
}

function createDownstreamClient(socket) {
  let nextRequestId = 1;
  const pendingRequests = new Map();

  return {
    clientId: null,
    request(method, params, timeoutMs = 1_000) {
      const id = `remux-host:${nextRequestId++}`;
      const payload = params === undefined
        ? { jsonrpc: '2.0', id, method }
        : { jsonrpc: '2.0', id, method, params };

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingRequests.delete(id);
          reject(new Error(`${method} timed out`));
        }, timeoutMs);

        pendingRequests.set(id, { reject, resolve, timer });
        sendJsonRpcMessage(socket, payload);
      });
    },
    rejectPendingRequests(error) {
      for (const [id, pending] of pendingRequests) {
        clearTimeout(pending.timer);
        pending.reject(error);
        pendingRequests.delete(id);
      }
    },
    resolvePendingRequest(message) {
      const pending = pendingRequests.get(message.id);
      if (!pending) {
        return false;
      }

      clearTimeout(pending.timer);
      pendingRequests.delete(message.id);
      if (message.error) {
        pending.reject(new JsonRpcError(
          typeof message.error.code === 'number' ? message.error.code : -32000,
          typeof message.error.message === 'string' ? message.error.message : 'Client request failed',
          message.error.data,
        ));
      } else {
        pending.resolve(message.result);
      }
      return true;
    },
    sessionId: null,
    socket,
  };
}

function sendJsonRpcMessage(socket, payload) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

function isRemuxWebSocketPath(url) {
  if (!url) {
    return false;
  }

  const pathname = new URL(url, 'http://remux.local').pathname;
  return pathname === remuxWebSocketPath;
}

function formatLog(message, extra) {
  if (extra === undefined) {
    return message;
  }

  return `${message} ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`;
}

function logAppDiagnostic(params, log) {
  if (!isRecord(params) || typeof params.label !== 'string') {
    logDiagnosticEvent(log, {
      label: 'invalid-diagnostic-payload',
      level: 'warn',
      message: '[remux:app] invalid diagnostic payload',
      source: 'app',
    });
    return;
  }

  const timestamp = typeof params.timestamp === 'string' ? params.timestamp : new Date().toISOString();
  const detail = params.detail === undefined ? undefined : params.detail;
  logDiagnosticEvent(log, {
    detail,
    label: params.label,
    level: 'info',
    message: `[remux:app] ${timestamp} ${params.label}${detail === undefined ? '' : ` ${safeJson(detail)}`}`,
    source: 'app',
    ts: timestamp,
  });
}

function logDiagnosticEvent(log, event) {
  if (typeof log.event === 'function') {
    log.event(event);
    return;
  }

  if (event.level === 'warn') {
    log.warn?.(event.message);
    return;
  }

  if (event.level === 'error') {
    log.error?.(event.message);
    return;
  }

  log.log?.(event.message);
}

function safeJson(value) {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

module.exports = {
  attachRemuxWebSocketServer,
  remuxWebSocketPath,
};
