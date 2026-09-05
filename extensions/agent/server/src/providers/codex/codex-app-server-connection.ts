const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
// A terminal provider event may carry up to 8 Mi characters before Remux
// seals it into an artifact; JSON escaping can expand that substantially.
// Keep the transport ceiling aligned with the 64 MiB snapshot envelope.
export const MAX_CODEX_PROTOCOL_MESSAGE_BYTES = 64 * 1024 * 1024;
export const MAX_CODEX_DIAGNOSTIC_CHARS = 4_000;

export type CodexServerNotification = {
  method: string;
  params: unknown;
};

export type CodexServerRequest = {
  id: string | number;
  method: string;
  params: unknown;
};

export type CodexConnectionHandlers = {
  onNotification(notification: CodexServerNotification): void;
  onServerRequest(request: CodexServerRequest): Promise<unknown>;
  onExit(error: Error): void;
  onStderr?(line: string): void;
};

export type CodexRequestBeforeWrite = (method: string, requestId: number) => void;

export type CodexRequestErrorPhase = 'not-sent' | 'possibly-sent';

export class CodexRequestError extends Error {
  readonly phase: CodexRequestErrorPhase;
  readonly method: string;
  readonly requestId: number;
  readonly nativeCode?: number;

  constructor(input: { phase: CodexRequestErrorPhase; method: string; requestId: number;
    message: string; nativeCode?: number; cause?: unknown }) {
    super(input.message, input.cause === undefined ? undefined : { cause: input.cause });
    this.name = 'CodexRequestError';
    this.phase = input.phase;
    this.method = input.method;
    this.requestId = input.requestId;
    if (input.nativeCode !== undefined) this.nativeCode = input.nativeCode;
  }
}

export interface CodexAppServerConnection {
  request(method: string, params: unknown, timeoutMs?: number,
    beforeWrite?: CodexRequestBeforeWrite): Promise<unknown>;
  notify(method: string, params: unknown): void;
  close(): Promise<void>;
}

export type CodexAppServerLaunchOptions = {
  binaryPath: string;
  cwd: string;
  args?: readonly string[];
  environment?: NodeJS.ProcessEnv;
  handlers: CodexConnectionHandlers;
};

export type CodexAppServerConnectionFactory = (
  options: CodexAppServerLaunchOptions,
) => Promise<CodexAppServerConnection>;

type CodexJsonRpcTransport = {
  write(encoded: string): void;
  close(): Promise<void>;
};

/**
 * Transport-neutral JSON-RPC peer shared by stdio fixtures and the persistent
 * daemon socket. Process ownership deliberately lives outside this class.
 */
export class CodexJsonRpcPeer implements CodexAppServerConnection {
  private readonly handlers: CodexConnectionHandlers;
  private readonly transport: CodexJsonRpcTransport;
  private readonly pending = new Map<number, {
    requestId: number;
    method: string;
    enteredWrite: boolean;
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
    timeout: ReturnType<typeof setTimeout>;
  }>();
  private nextId = 1;
  private closed = false;
  private exitError: Error | null = null;

  constructor(handlers: CodexConnectionHandlers, transport: CodexJsonRpcTransport) {
    this.handlers = handlers;
    this.transport = transport;
  }

  request(method: string, params: unknown, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    beforeWrite?: CodexRequestBeforeWrite) {
    const id = this.nextId++;
    if (this.closed) return Promise.reject(requestError('not-sent', method, id,
      this.exitError ?? new Error('Codex App Server is closed.')));
    let encoded: string;
    try {
      encoded = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    } catch (error) {
      return Promise.reject(requestError('not-sent', method, id, error));
    }
    if (this.closed) return Promise.reject(requestError('not-sent', method, id,
      this.exitError ?? new Error('Codex App Server is closed.')));
    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexRequestError({ phase: 'possibly-sent', method, requestId: id,
          message: `Codex App Server request ${method} timed out after ${timeoutMs} ms.` }));
      }, timeoutMs);
      const pending = { requestId: id, method, resolve, reject, timeout, enteredWrite: false };
      this.pending.set(id, pending);
      try {
        beforeWrite?.(method, id);
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(requestError('not-sent', method, id, error));
        return;
      }
      if (this.closed) return;
      try {
        pending.enteredWrite = true;
        this.transport.write(encoded);
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(requestError('possibly-sent', method, id, error));
      }
    });
  }

  notify(method: string, params: unknown) {
    if (this.closed) throw this.exitError ?? new Error('Codex App Server is closed.');
    this.write({ method, params });
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.rejectPending(new Error('Codex App Server connection closed.'));
    await this.transport.close();
  }

  receiveText(message: string) {
    if (this.closed) return;
    if (Buffer.byteLength(message, 'utf8') > MAX_CODEX_PROTOCOL_MESSAGE_BYTES) {
      this.transportExited(new Error('Codex App Server emitted an oversized protocol message.'));
      void this.transport.close();
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(message);
    } catch {
      this.diagnostic(`Ignored non-JSON Codex message: ${message.slice(0, 500)}`);
      return;
    }
    if (!isRecord(value)) return;
    if ('id' in value && ('result' in value || 'error' in value) && !('method' in value)) {
      this.handleResponse(value);
      return;
    }
    if (typeof value.method !== 'string') return;
    if ('id' in value && (typeof value.id === 'number' || typeof value.id === 'string')) {
      void this.handleServerRequest({ id: value.id, method: value.method, params: value.params });
      return;
    }
    try {
      this.handlers.onNotification({ method: value.method, params: value.params });
    } catch (error) {
      // Provider messages are an untrusted process boundary. A projection bug
      // in one notification cannot terminate the Agent extension or peer.
      this.diagnostic(`Ignored Codex notification ${value.method}: ${asCodexError(error).message}`);
    }
  }

  transportExited(error: Error) {
    if (this.closed || this.exitError) return;
    this.exitError = error;
    this.closed = true;
    this.rejectPending(error);
    this.handlers.onExit(error);
  }

  private write(value: Record<string, unknown>) {
    this.transport.write(JSON.stringify({ jsonrpc: '2.0', ...value }));
  }

  private handleResponse(value: Record<string, unknown>) {
    const id = typeof value.id === 'number' ? value.id : Number(value.id);
    if (!Number.isSafeInteger(id)) return;
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(id);
    if ('error' in value && value.error !== undefined && value.error !== null) {
      pending.reject(protocolError(pending.method, pending.requestId, value.error));
    } else {
      pending.resolve(value.result);
    }
  }

  private async handleServerRequest(request: CodexServerRequest) {
    try {
      const result = await this.handlers.onServerRequest(request);
      this.write({ id: request.id, result });
    } catch (error) {
      this.write({
        id: request.id,
        error: { code: -32090, message: asCodexError(error).message },
      });
    }
  }

  private rejectPending(error: Error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(requestError(pending.enteredWrite ? 'possibly-sent' : 'not-sent',
        pending.method, pending.requestId, error));
    }
    this.pending.clear();
  }

  private diagnostic(message: string) {
    try {
      this.handlers.onStderr?.(message.slice(0, MAX_CODEX_DIAGNOSTIC_CHARS));
    } catch {
      // Diagnostics are best-effort and cannot alter transport behavior.
    }
  }
}

function protocolError(method: string, requestId: number, value: unknown) {
  if (!isRecord(value)) return new CodexRequestError({ phase: 'possibly-sent', method, requestId,
    message: `Codex App Server ${method} failed.` });
  const nativeCode = typeof value.code === 'number' && Number.isFinite(value.code) ? value.code : undefined;
  const code = nativeCode === undefined ? '' : ` (${nativeCode})`;
  const detail = typeof value.message === 'string'
    ? value.message.slice(0, MAX_CODEX_DIAGNOSTIC_CHARS)
    : 'Unknown protocol error.';
  return new CodexRequestError({ phase: 'possibly-sent', method, requestId, nativeCode,
    message: `Codex App Server ${method} failed${code}: ${detail}` });
}

function requestError(phase: CodexRequestErrorPhase, method: string, requestId: number, error: unknown) {
  const cause = asCodexError(error);
  return new CodexRequestError({ phase, method, requestId, cause,
    message: cause.message || `Codex App Server ${method} request failed.` });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function asCodexError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error));
}
