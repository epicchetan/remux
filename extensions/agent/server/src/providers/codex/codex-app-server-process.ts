import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
// A terminal provider event may carry up to 8 Mi characters before Remux
// seals it into an artifact; JSON escaping can expand that substantially.
// Keep the transport ceiling aligned with the 64 MiB snapshot envelope.
const MAX_PROTOCOL_LINE_BYTES = 64 * 1024 * 1024;
const MAX_STDERR_LINE_CHARS = 4_000;

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

export interface CodexAppServerConnection {
  request(method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
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

export const launchCodexAppServer: CodexAppServerConnectionFactory = async (options) => {
  const child = spawn(options.binaryPath, ['app-server', '--stdio', ...(options.args ?? [])], {
    cwd: options.cwd,
    env: options.environment ?? process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const connection = new ProcessCodexAppServerConnection(child, options.handlers);
  await connection.waitUntilSpawned();
  return connection;
};

class ProcessCodexAppServerConnection implements CodexAppServerConnection {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly handlers: CodexConnectionHandlers;
  private readonly pending = new Map<number, {
    method: string;
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
    timeout: ReturnType<typeof setTimeout>;
  }>();
  private nextId = 1;
  private closed = false;
  private exitError: Error | null = null;
  private spawnPromise: Promise<void>;

  constructor(child: ChildProcessWithoutNullStreams, handlers: CodexConnectionHandlers) {
    this.child = child;
    this.handlers = handlers;
    this.spawnPromise = new Promise<void>((resolve, reject) => {
      if (child.pid) resolve();
      else {
        child.once('spawn', resolve);
        child.once('error', reject);
      }
    });

    const stdout = createInterface({ input: child.stdout, crlfDelay: Infinity });
    stdout.on('line', (line) => this.handleLine(line));
    const stderr = createInterface({ input: child.stderr, crlfDelay: Infinity });
    stderr.on('line', (line) => {
      const cleaned = line.trim();
      if (cleaned) this.handlers.onStderr?.(cleaned.slice(0, MAX_STDERR_LINE_CHARS));
    });

    child.once('error', (error) => this.handleExit(asError(error)));
    child.once('exit', (code, signal) => {
      const detail = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`;
      this.handleExit(new Error(`Codex App Server exited with ${detail}.`));
    });
  }

  waitUntilSpawned() {
    return this.spawnPromise;
  }

  request(method: string, params: unknown, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
    if (this.closed) return Promise.reject(this.exitError ?? new Error('Codex App Server is closed.'));
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex App Server request ${method} timed out after ${timeoutMs} ms.`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timeout });
      try {
        this.write({ id, method, params });
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error);
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
    this.child.stdin.end();
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.kill('SIGTERM');
    await Promise.race([
      new Promise<void>((resolve) => this.child.once('exit', () => resolve())),
      new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGKILL');
          resolve();
        }, 2_000);
        timeout.unref();
      }),
    ]);
  }

  private write(value: unknown) {
    const encoded = `${JSON.stringify(value)}\n`;
    if (!this.child.stdin.write(encoded)) {
      // Node's pipe buffer applies backpressure. Requests remain ordered by the
      // writable stream; app-server control messages are small.
      this.child.stdin.once('error', (error) => this.handleExit(asError(error)));
    }
  }

  private handleLine(line: string) {
    if (Buffer.byteLength(line, 'utf8') > MAX_PROTOCOL_LINE_BYTES) {
      this.handleExit(new Error('Codex App Server emitted an oversized protocol line.'));
      void this.close();
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      this.handlers.onStderr?.(`Ignored non-JSON Codex stdout: ${line.slice(0, 500)}`);
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
      // Provider stdout is an untrusted process boundary. A consumer bug while
      // projecting one notification must not escape the readline callback and
      // terminate the Agent extension (and every native session it owns).
      try {
        this.handlers.onStderr?.(
          `Ignored Codex notification ${value.method}: ${asError(error).message}`,
        );
      } catch {
        // Diagnostics are best-effort and cannot alter transport behavior.
      }
    }
  }

  private handleResponse(value: Record<string, unknown>) {
    const id = typeof value.id === 'number' ? value.id : Number(value.id);
    if (!Number.isSafeInteger(id)) return;
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(id);
    if ('error' in value && value.error !== undefined && value.error !== null) {
      pending.reject(protocolError(pending.method, value.error));
    } else {
      pending.resolve(value.result);
    }
  }

  private async handleServerRequest(request: CodexServerRequest) {
    try {
      const result = await this.handlers.onServerRequest(request);
      this.write({ id: request.id, result });
    } catch (error) {
      const normalized = asError(error);
      this.write({
        id: request.id,
        error: { code: -32090, message: normalized.message },
      });
    }
  }

  private handleExit(error: Error) {
    if (this.exitError) return;
    this.exitError = error;
    this.closed = true;
    this.rejectPending(error);
    this.handlers.onExit(error);
  }

  private rejectPending(error: Error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function protocolError(method: string, value: unknown) {
  if (!isRecord(value)) return new Error(`Codex App Server ${method} failed.`);
  const code = typeof value.code === 'number' ? ` (${value.code})` : '';
  const message = typeof value.message === 'string' ? value.message : 'Unknown protocol error.';
  return new Error(`Codex App Server ${method} failed${code}: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error));
}
