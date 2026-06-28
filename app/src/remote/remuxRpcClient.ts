import { logRemuxDebug } from './remuxDebug';

export type JsonRpcId = number | string;

type JsonRpcError = {
  code: number;
  data?: unknown;
  message: string;
};

type PendingRequest = {
  method: string;
  reject: (error: Error) => void;
  resolve: (value: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};

type RemuxConnectionClosedPhase = 'closed' | 'send';

type RemuxRpcClientOptions = {
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

export class RemuxRpcClient {
  private nextId = 1;
  private pending = new Map<JsonRpcId, PendingRequest>();
  private sendBlockedLog = { lastLoggedAtMs: 0, suppressedCount: 0 };
  private socket: WebSocket | null = null;

  constructor(private readonly options: RemuxRpcClientOptions) {}

  connect() {
    if (this.socket) {
      return Promise.resolve();
    }

    this.options.onStatus?.({ type: 'connecting' });
    logRemuxDebug('socket:connect:start', this.options.url);

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const socket = new WebSocket(this.options.url);
      this.socket = socket;

      socket.onopen = () => {
        logRemuxDebug('socket:open', this.options.url);
        settled = true;
        this.options.onStatus?.({ type: 'connected' });
        resolve();
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
        if (!settled) {
          settled = true;
          reject(error);
        }
      };

      socket.onclose = (event) => {
        this.rejectAll(`WebSocket closed (${event.code})`);
        this.socket = null;
        const reason = event.reason || `code ${event.code}`;
        this.options.onStatus?.({ reason, type: 'closed' });
        logRemuxDebug('socket:close', {
          code: event.code,
          reason: event.reason || null,
          wasClean: event.wasClean,
        });
        if (!settled) {
          settled = true;
          reject(new Error(event.reason || `WebSocket closed (${event.code})`));
        }
      };
    });
  }

  close() {
    this.rejectAll('WebSocket closed');
    logRemuxDebug('socket:close-request');
    this.socket?.close();
    this.socket = null;
    this.options.onStatus?.({ type: 'closed' });
  }

  isOpen() {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  request<T>(method: string, params?: unknown, timeoutMs = 300_000): Promise<T> {
    const id = this.nextId++;
    logRemuxDebug('rpc:request', `${method}#${id}`);
    this.send(params === undefined ? { id, method } : { id, method, params });

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        logRemuxDebug('rpc:timeout', `${method}#${id}`);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);

      this.pending.set(id, {
        method,
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

function jsonRpcError(error: Record<string, unknown>, method: string) {
  const normalized: JsonRpcError = {
    code: typeof error.code === 'number' ? error.code : -32000,
    data: error.data,
    message: typeof error.message === 'string' ? error.message : 'Unknown JSON-RPC error',
  };
  return new Error(`${method} failed (${normalized.code}): ${normalized.message}`);
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
