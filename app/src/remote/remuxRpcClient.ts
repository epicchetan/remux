import type { RpcRequestPolicy } from '@remux/viewer-kit/rpc-policy';

import { logRemuxDebug } from './remuxDebug';

export type JsonRpcId = number | string;

type JsonRpcError = {
  code: number;
  data?: unknown;
  message: string;
};

type PendingRequest = {
  method: string;
  policy: RpcRequestPolicy;
  reject: (error: Error) => void;
  resolve: (value: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};

type RemuxConnectionClosedPhase = 'closed' | 'send';

export type RemuxRpcRequestContext = {
  resourceKey: string | null;
  tabId: string | null;
};

type RemuxRpcClientOptions = {
  connectionGeneration?: number;
  connectTimeoutMs?: number;
  /** Sent on the upgrade request (RN WebSocket third-arg headers). */
  headers?: Record<string, string>;
  onInbound?: (receivedAt: number) => void;
  onMessage?: (message: RemuxRpcMessage) => void;
  onStatus?: (status: RemuxRpcStatus) => void;
  url: string;
};

export type RemuxRpcStatus =
  | { type: 'idle' }
  | { type: 'connecting' }
  | { type: 'connected' }
  | { reason?: string; type: 'closed' }
  | { message: string; type: 'error' };

export type RemuxRpcMessage = {
  error?: unknown;
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
};

export class RemuxConnectionClosedError extends Error {
  readonly phase: RemuxConnectionClosedPhase;
  readonly readyState?: number;

  constructor(message: string, options: { phase: RemuxConnectionClosedPhase; readyState?: number }) {
    super(message);
    this.name = 'RemuxConnectionClosedError';
    this.phase = options.phase;
    this.readyState = options.readyState;
  }
}

export class RemuxRequestTimeoutError extends Error {
  constructor(
    readonly policy: RpcRequestPolicy,
    readonly phase: 'before-send' | 'connection-wait' | 'response',
    readonly timeoutMs: number,
    readonly details: {
      connectionGeneration?: number;
      lastInboundAt?: number;
      requestId?: JsonRpcId;
      sentAt?: number;
    } = {},
  ) {
    super(`${policy.method} timed out in ${phase} after ${timeoutMs}ms (${policy.name})`);
    this.name = 'RemuxRequestTimeoutError';
  }
}

export class RemuxRpcClient {
  private connectAbort: ((reason: string) => void) | null = null;
  private connectPromise: Promise<void> | null = null;
  private nextId = 1;
  private pending = new Map<JsonRpcId, PendingRequest>();
  private sendBlockedLog = { lastLoggedAtMs: 0, suppressedCount: 0 };
  private socket: WebSocket | null = null;
  private lastInboundAt = 0;

  constructor(private readonly options: RemuxRpcClientOptions) {}

  connect() {
    if (this.socket) {
      return this.connectPromise ?? Promise.resolve();
    }

    this.options.onStatus?.({ type: 'connecting' });
    logRemuxDebug('socket:connect:start', this.options.url);

    const connectTimeoutMs = this.options.connectTimeoutMs ?? 8000;
    const promise = new Promise<void>((resolve, reject) => {
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | null = null;
      // React Native's WebSocket takes headers as a third argument; the DOM
      // typings don't know about it.
      const RNWebSocket = WebSocket as unknown as new (
        url: string,
        protocols?: string | string[] | null,
        options?: { headers?: Record<string, string> },
      ) => WebSocket;
      const socket = this.options.headers
        ? new RNWebSocket(this.options.url, null, { headers: this.options.headers })
        : new WebSocket(this.options.url);
      this.socket = socket;

      const clearConnectTimeout = () => {
        if (timeout !== null) {
          clearTimeout(timeout);
          timeout = null;
        }
      };

      const settleConnected = () => {
        if (settled) {
          return;
        }

        settled = true;
        clearConnectTimeout();
        this.connectAbort = null;
        this.connectPromise = null;
        resolve();
      };

      const settleRejected = (error: Error) => {
        if (settled) {
          return;
        }

        settled = true;
        clearConnectTimeout();
        this.connectAbort = null;
        this.connectPromise = null;
        reject(error);
      };

      this.connectAbort = (reason) => {
        const error = new Error(reason);
        if (this.socket === socket) {
          this.socket = null;
        }

        settleRejected(error);
        try {
          socket.close();
        } catch (closeError) {
          logRemuxDebug('socket:close-request:failed', errorMessage(closeError));
        }
      };

      timeout = setTimeout(() => {
        const message = `WebSocket connection timed out after ${connectTimeoutMs}ms`;
        this.options.onStatus?.({ message, type: 'error' });
        logRemuxDebug('socket:connect:timeout', {
          timeoutMs: connectTimeoutMs,
          url: this.options.url,
        });
        this.connectAbort?.(message);
      }, connectTimeoutMs);

      socket.onopen = () => {
        logRemuxDebug('socket:open', this.options.url);
        this.options.onStatus?.({ type: 'connected' });
        settleConnected();
      };

      socket.onmessage = (event) => {
        logRemuxDebug(
          'socket:message',
          typeof event.data === 'string' ? `${event.data.length} bytes` : 'binary frame',
        );
        this.handleMessage(String(event.data));
      };

      socket.onerror = () => {
        const error = new Error('WebSocket connection failed');
        this.options.onStatus?.({ message: error.message, type: 'error' });
        logRemuxDebug('socket:error', error.message);
        settleRejected(error);
      };

      socket.onclose = (event) => {
        this.rejectAll(`WebSocket closed (${event.code})`);
        if (this.socket === socket) {
          this.socket = null;
        }
        const reason = event.reason || `code ${event.code}`;
        this.options.onStatus?.({ reason, type: 'closed' });
        logRemuxDebug('socket:close', {
          code: event.code,
          reason: event.reason || null,
          wasClean: event.wasClean,
        });
        settleRejected(new Error(event.reason || `WebSocket closed (${event.code})`));
      };
    });

    this.connectPromise = promise;
    return promise;
  }

  close(reason = 'WebSocket closed') {
    this.rejectAll(reason);
    logRemuxDebug('socket:close-request', {
      reason,
      readyState: this.socket?.readyState ?? null,
    });
    this.connectAbort?.(reason);
    this.connectAbort = null;
    this.connectPromise = null;
    this.socket?.close();
    this.socket = null;
    this.options.onStatus?.({ reason, type: 'closed' });
  }

  isOpen() {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  request<T>(
    policy: RpcRequestPolicy,
    params?: unknown,
    context?: RemuxRpcRequestContext | null,
    timeoutMs = policy.budget.totalMs,
    operationRemainingMs = timeoutMs,
  ): Promise<T> {
    const { method } = policy;
    const id = this.nextId++;
    const sentAt = Date.now();
    logRemuxDebug('rpc:request', `${method}#${id}`);
    this.send(requestMessage({
      context,
      id,
      method,
      params,
      policy,
      timeoutMs: operationRemainingMs,
    }));

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        logRemuxDebug('rpc:timeout', `${method}#${id}`);
        reject(new RemuxRequestTimeoutError(policy, 'response', timeoutMs, {
          connectionGeneration: this.options.connectionGeneration,
          lastInboundAt: this.lastInboundAt,
          requestId: id,
          sentAt,
        }));
      }, timeoutMs);

      this.pending.set(id, {
        method,
        policy,
        reject,
        resolve: resolve as (value: unknown) => void,
        timer,
      });
    });
  }

  notify(method: string, params?: unknown) {
    this.send(params === undefined ? { method } : { method, params });
  }

  respond(id: JsonRpcId, result: unknown) {
    this.send({ id, result });
  }

  respondError(id: JsonRpcId, error: JsonRpcError) {
    this.send({
      error,
      id,
    });
  }

  tryNotify(method: string, params?: unknown) {
    return this.trySend(params === undefined ? { method } : { method, params });
  }

  private handleMessage(raw: string) {
    let message: unknown;

    try {
      message = JSON.parse(raw);
    } catch {
      this.options.onStatus?.({
        message: 'Received invalid JSON from app-server',
        type: 'error',
      });
      logRemuxDebug('socket:invalid-json', raw.slice(0, 120));
      return;
    }

    if (!isRecord(message)) {
      return;
    }
    this.options.onInbound?.(Date.now());
    this.lastInboundAt = Date.now();

    if (isJsonRpcResponseMessage(message) && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id)!;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);

      if (isRecord(message.error)) {
        logRemuxDebug('rpc:error', `${pending.method}#${message.id}`);
        pending.reject(jsonRpcError(message.error, pending.method));
      } else {
        logRemuxDebug('rpc:result', `${pending.method}#${message.id}`);
        pending.resolve(message.result);
      }
      return;
    }

    this.options.onMessage?.(message as RemuxRpcMessage);
  }

  private rejectAll(reason: string) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new RemuxConnectionClosedError(reason, { phase: 'closed' }));
    }
    this.pending.clear();
  }

  private send(message: unknown) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      const detail = this.socket ? `readyState=${this.socket.readyState}` : 'no socket';
      this.logSendBlocked(detail);
      throw new RemuxConnectionClosedError('Remux app-server is not connected', {
        phase: 'send',
        readyState: this.socket?.readyState,
      });
    }

    this.socket.send(JSON.stringify(message));
  }

  private logSendBlocked(detail: string) {
    const now = Date.now();
    if (now - this.sendBlockedLog.lastLoggedAtMs < 1000) {
      this.sendBlockedLog.suppressedCount += 1;
      return;
    }

    logRemuxDebug('socket:send-blocked', {
      detail,
      suppressedCount: this.sendBlockedLog.suppressedCount,
    });
    this.sendBlockedLog = {
      lastLoggedAtMs: now,
      suppressedCount: 0,
    };
  }

  private trySend(message: unknown) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return false;
    }

    try {
      this.socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }
}

function requestMessage({
  context,
  id,
  method,
  params,
  policy,
  timeoutMs,
}: {
  context?: RemuxRpcRequestContext | null;
  id: JsonRpcId;
  method: string;
  params?: unknown;
  policy: RpcRequestPolicy;
  timeoutMs: number;
}) {
  return {
    jsonrpc: '2.0',
    id,
    method,
    remuxPolicy: { name: policy.name, remainingMs: timeoutMs },
    ...(params === undefined ? {} : { params }),
    ...(context ? { remuxContext: context } : {}),
  };
}

function jsonRpcError(error: Record<string, unknown>, method: string) {
  const normalized: JsonRpcError = {
    code: typeof error.code === 'number' ? error.code : -32000,
    data: error.data,
    message: typeof error.message === 'string' ? error.message : 'Unknown JSON-RPC error',
  };
  return new Error(`${method} failed (${normalized.code}): ${normalized.message}`);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function isJsonRpcResponseMessage(
  message: Record<string, unknown>,
): message is Record<string, unknown> & { id: JsonRpcId } {
  const id = message.id;
  return (
    (typeof id === 'number' || typeof id === 'string') &&
    typeof message.method !== 'string' &&
    ('result' in message || 'error' in message)
  );
}
