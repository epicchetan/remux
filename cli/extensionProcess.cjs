const { spawn } = require('node:child_process');
const readline = require('node:readline');

const { JsonRpcError } = require('./jsonRpc.cjs');

const defaultRequestTimeoutMs = 300_000;
const remuxNotificationMethodPrefix = 'remux/notifications/';

function createExtensionProcess({ extension, log = console, requestTimeoutMs = defaultRequestTimeoutMs }) {
  let child = null;
  let childGeneration = 0;
  let ctx = null;
  let nextId = 1;
  let stopping = false;
  const pending = new Map();

  return {
    async start(nextCtx) {
      if (child && !child.killed) {
        ctx = nextCtx;
        stopping = false;
        return this.status();
      }

      ctx = nextCtx;
      stopping = false;
      const generation = childGeneration + 1;
      childGeneration = generation;
      logEvent(log, {
        detail: {
          args: extension.server.args,
          command: extension.server.command,
          cwd: extension.server.cwd,
        },
        label: 'extension:start',
        source: `extension:${extension.id}`,
      });
      child = spawn(extension.server.command, extension.server.args, {
        cwd: extension.server.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      child.on('error', (error) => {
        if (generation !== childGeneration) {
          return;
        }

        logEvent(log, {
          detail: {
            message: error.message,
          },
          label: 'extension:error',
          level: 'error',
          source: `extension:${extension.id}`,
        });
        nextCtx.fatal(`extension ${extension.id} failed to start: ${error.message}`, 1);
      });
      child.on('exit', (code, signal) => {
        if (generation !== childGeneration) {
          return;
        }

        logEvent(log, {
          detail: {
            code,
            signal,
            stopping,
          },
          label: 'extension:exit',
          level: stopping || (!signal && (!code || code === 0)) ? 'info' : 'error',
          source: `extension:${extension.id}`,
        });
        rejectPending(new JsonRpcError(-32000, `extension ${extension.id} exited`));
        child = null;
        if (stopping) {
          return;
        }
        if (signal || (code && code !== 0)) {
          const reason = signal
            ? `extension ${extension.id} exited from ${signal}`
            : `extension ${extension.id} exited with code ${code}`;
          nextCtx.fatal(reason, code && code !== 0 ? code : 1);
        }
      });

      const output = readline.createInterface({
        crlfDelay: Infinity,
        input: child.stdout,
      });
      output.on('line', (line) => {
        if (generation !== childGeneration) {
          return;
        }
        handleProtocolLine(line);
      });

      const diagnostics = readline.createInterface({
        crlfDelay: Infinity,
        input: child.stderr,
      });
      diagnostics.on('line', (line) => {
        if (generation !== childGeneration || line.trim().length === 0) {
          return;
        }

        logEvent(log, {
          detail: {
            line,
          },
          label: 'extension:stderr',
          source: `extension:${extension.id}`,
        });
      });
    },

    status() {
      return {
        restartable: true,
        running: Boolean(child && !child.killed),
      };
    },

    async handleRpc({ method, params }) {
      if (!child || !child.stdin.writable) {
        throw new JsonRpcError(-32000, `extension ${extension.id} is not running`);
      }

      const id = nextId++;
      const message = params === undefined
        ? { jsonrpc: '2.0', id, method }
        : { jsonrpc: '2.0', id, method, params };

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new JsonRpcError(-32000, `${method} timed out`));
        }, requestTimeoutMs);

        pending.set(id, {
          method,
          reject,
          resolve,
          timer,
        });

        child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
          if (!error) {
            return;
          }

          clearTimeout(timer);
          pending.delete(id);
          reject(new JsonRpcError(-32000, error.message));
        });
      });
    },

    handleNotification({ method, params }) {
      if (!child || !child.stdin.writable) {
        return;
      }

      const message = params === undefined
        ? { jsonrpc: '2.0', method }
        : { jsonrpc: '2.0', method, params };

      child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) {
          log.warn?.(`[remux] failed to send notification to extension ${extension.id}: ${error.message}`);
        }
      });
    },

    async stop() {
      logEvent(log, {
        label: 'extension:stop',
        source: `extension:${extension.id}`,
      });
      stopping = true;
      rejectPending(new JsonRpcError(-32000, `extension ${extension.id} stopped`));
      if (child && !child.killed) {
        child.kill('SIGTERM');
      }
      child = null;
      ctx = null;
      return this.status();
    },

    async restart() {
      logEvent(log, {
        label: 'extension:restart',
        source: `extension:${extension.id}`,
      });
      const restartCtx = ctx;
      if (!restartCtx) {
        throw new JsonRpcError(-32000, `extension ${extension.id} cannot restart before remux starts`);
      }

      await this.stop();
      await this.start(restartCtx);
      return this.status();
    },
  };

  function handleProtocolLine(line) {
    if (line.trim().length === 0) {
      return;
    }

    let message;
    try {
      message = JSON.parse(line);
    } catch {
      log.warn?.(`[remux] ignored invalid protocol line from extension ${extension.id}`);
      return;
    }

    if (isJsonRpcResponse(message)) {
      const pendingRequest = pending.get(message.id);
      if (!pendingRequest) {
        return;
      }

      clearTimeout(pendingRequest.timer);
      pending.delete(message.id);

      if (message.error) {
        pendingRequest.reject(errorFromResponse(message.error, pendingRequest.method));
      } else {
        pendingRequest.resolve(message.result);
      }
      return;
    }

    if (message && typeof message.method === 'string') {
      const normalized = normalizeExtensionNotification(message, extension.id);
      if (
        isRemuxNotificationMethod(normalized.method) &&
        typeof ctx?.handleExtensionNotification === 'function'
      ) {
        void ctx.handleExtensionNotification(normalized)
          .then((handled) => {
            if (!handled) {
              ctx?.broadcast?.(normalized);
            }
          })
          .catch((error) => {
            log.warn?.(`[remux] failed to handle notification from extension ${extension.id}: ${errorMessage(error)}`);
          });
        return;
      }

      ctx?.broadcast?.(normalized);
    }
  }

  function rejectPending(error) {
    for (const [id, pendingRequest] of pending) {
      clearTimeout(pendingRequest.timer);
      pendingRequest.reject(error);
      pending.delete(id);
    }
  }
}

function normalizeExtensionNotification(message, extensionId) {
  if (!isRemuxNotificationMethod(message.method)) {
    return message;
  }

  return {
    ...message,
    params: {
      ...(isRecord(message.params) ? message.params : {}),
      extensionId,
    },
  };
}

function isRemuxNotificationMethod(method) {
  return typeof method === 'string' && method.startsWith(remuxNotificationMethodPrefix);
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function logEvent(log, event) {
  if (typeof log?.event === 'function') {
    log.event(event);
    return;
  }

  const message = event.detail === undefined
    ? `[remux] ${event.label} ${event.source || ''}`.trim()
    : `[remux] ${event.label} ${event.source || ''} ${JSON.stringify(event.detail)}`.trim();

  if (event.level === 'error') {
    log?.error?.(message);
    return;
  }

  if (event.level === 'warn') {
    log?.warn?.(message);
    return;
  }

  log?.log?.(message);
}

function errorFromResponse(error, method) {
  return new JsonRpcError(
    typeof error?.code === 'number' ? error.code : -32000,
    `${method} failed: ${typeof error?.message === 'string' ? error.message : 'Unknown JSON-RPC error'}`,
    error?.data,
  );
}

function isJsonRpcResponse(message) {
  return (
    message &&
    typeof message === 'object' &&
    (typeof message.id === 'string' || typeof message.id === 'number') &&
    typeof message.method !== 'string' &&
    ('result' in message || 'error' in message)
  );
}

module.exports = {
  createExtensionProcess,
};
