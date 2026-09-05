import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

import {
  asCodexError,
  CodexJsonRpcPeer,
  MAX_CODEX_DIAGNOSTIC_CHARS,
  type CodexAppServerConnection,
  type CodexAppServerConnectionFactory,
  type CodexConnectionHandlers,
  type CodexRequestBeforeWrite,
} from './codex-app-server-connection.ts';

export type {
  CodexAppServerConnection,
  CodexAppServerConnectionFactory,
  CodexAppServerLaunchOptions,
  CodexConnectionHandlers,
  CodexRequestBeforeWrite,
  CodexRequestErrorPhase,
  CodexServerNotification,
  CodexServerRequest,
} from './codex-app-server-connection.ts';
export { CodexRequestError } from './codex-app-server-connection.ts';

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
  private readonly peer: CodexJsonRpcPeer;
  private spawnPromise: Promise<void>;

  constructor(child: ChildProcessWithoutNullStreams, handlers: CodexConnectionHandlers) {
    this.child = child;
    this.peer = new CodexJsonRpcPeer(handlers, {
      write: (encoded) => this.write(encoded),
      close: () => this.closeChild(),
    });
    this.spawnPromise = new Promise<void>((resolve, reject) => {
      if (child.pid) resolve();
      else {
        child.once('spawn', resolve);
        child.once('error', reject);
      }
    });

    const stdout = createInterface({ input: child.stdout, crlfDelay: Infinity });
    stdout.on('line', (line) => this.peer.receiveText(line));
    const stderr = createInterface({ input: child.stderr, crlfDelay: Infinity });
    stderr.on('line', (line) => {
      const cleaned = line.trim();
      if (cleaned) handlers.onStderr?.(cleaned.slice(0, MAX_CODEX_DIAGNOSTIC_CHARS));
    });

    child.once('error', (error) => this.peer.transportExited(asCodexError(error)));
    child.once('exit', (code, signal) => {
      const detail = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`;
      this.peer.transportExited(new Error(`Codex App Server exited with ${detail}.`));
    });
  }

  waitUntilSpawned() {
    return this.spawnPromise;
  }

  request(method: string, params: unknown, timeoutMs?: number, beforeWrite?: CodexRequestBeforeWrite) {
    return this.peer.request(method, params, timeoutMs, beforeWrite);
  }

  notify(method: string, params: unknown) {
    this.peer.notify(method, params);
  }

  close() {
    return this.peer.close();
  }

  private async closeChild() {
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

  private write(encoded: string) {
    if (!this.child.stdin.write(`${encoded}\n`)) {
      // Node's pipe buffer applies backpressure. Requests remain ordered by the
      // writable stream; app-server control messages are small.
      this.child.stdin.once('error', (error) => this.peer.transportExited(asCodexError(error)));
    }
  }
}
