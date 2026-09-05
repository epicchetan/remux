import { execFile as execFileCallback } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import WebSocket, { type RawData } from 'ws';

import {
  asCodexError,
  CodexJsonRpcPeer,
  MAX_CODEX_PROTOCOL_MESSAGE_BYTES,
  type CodexAppServerConnection,
  type CodexAppServerConnectionFactory,
  type CodexAppServerLaunchOptions,
} from './codex-app-server-connection.ts';

const execFile = promisify(execFileCallback);
const STATUS_TIMEOUT_MS = 10_000;
const START_TIMEOUT_MS = 30_000;
const CONNECT_TIMEOUT_MS = 2_000;
const STARTUP_TIMEOUT_MS = 10_000;
const RETRY_DELAY_MS = 100;
const READY_STATUS_TTL_MS = 30_000;

export type CodexRuntimeState = 'running' | 'stopped' | 'starting' | 'stopping' | 'failed';

export type CodexRuntimeStatus = {
  state: CodexRuntimeState;
  socketPath: string | null;
  managedCodexPath: string | null;
  installedVersion: string | null;
  runningVersion: string | null;
  restartRequired: boolean;
  lastError: string | null;
};

export type CodexRuntimeCommandResult = {
  stdout: string;
  stderr: string;
};

export type CodexRuntimeCommandRunner = (input: {
  binaryPath: string;
  args: readonly string[];
  cwd: string;
  environment: NodeJS.ProcessEnv;
  timeoutMs: number;
}) => Promise<CodexRuntimeCommandResult>;

export type CodexDaemonConnector = (
  socketPath: string,
  options: CodexAppServerLaunchOptions,
) => Promise<CodexAppServerConnection>;

export type CodexRuntimeHostOptions = {
  binaryPath?: string;
  environment?: Readonly<Record<string, string | undefined>>;
  runCommand?: CodexRuntimeCommandRunner;
  connectDaemon?: CodexDaemonConnector;
  now?: () => number;
  retryDelay?: (milliseconds: number) => Promise<void>;
};

/**
 * Owns Codex installation discovery and daemon availability for one provider
 * instance. Logical provider sessions receive independent WebSocket clients,
 * but every client talks to the same daemon and therefore the same in-process
 * thread writer registry.
 */
export class CodexRuntimeHost {
  readonly connectionFactory: CodexAppServerConnectionFactory;

  private readonly binaryPath: string;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly runCommand: CodexRuntimeCommandRunner;
  private readonly connectDaemon: CodexDaemonConnector;
  private readonly now: () => number;
  private readonly retryDelay: (milliseconds: number) => Promise<void>;
  private startup: Promise<CodexRuntimeStatus> | null = null;
  private readyStatus: { value: CodexRuntimeStatus; readAt: number } | null = null;

  constructor(options: CodexRuntimeHostOptions = {}) {
    this.binaryPath = options.binaryPath ?? 'codex';
    this.environment = { ...process.env, ...options.environment };
    // Federation authorization is scoped to thread-local MCP configuration.
    // Never let a stale ambient credential enter the shared daemon environment
    // where model-launched commands from unrelated threads could inherit it.
    delete this.environment.REMUX_FEDERATION_MCP_BEARER_TOKEN;
    this.runCommand = options.runCommand ?? runCodexCommand;
    this.connectDaemon = options.connectDaemon ?? connectCodexDaemon;
    this.now = options.now ?? Date.now;
    this.retryDelay = options.retryDelay ?? delay;
    this.connectionFactory = (input) => this.connect(input);
  }

  async readStatus(cwd = process.cwd()): Promise<CodexRuntimeStatus> {
    try {
      const result = await this.runCommand({
        binaryPath: this.binaryPath,
        args: ['app-server', 'daemon', 'version'],
        cwd,
        environment: this.environment,
        timeoutMs: STATUS_TIMEOUT_MS,
      });
      const status = parseCodexRuntimeStatus(result.stdout, fallbackSocketPath(this.environment));
      if (status.state === 'running' && status.socketPath) {
        this.readyStatus = { value: status, readAt: this.now() };
      } else {
        this.readyStatus = null;
      }
      return status;
    } catch (error) {
      return {
        state: 'failed',
        socketPath: fallbackSocketPath(this.environment),
        managedCodexPath: null,
        installedVersion: null,
        runningVersion: null,
        restartRequired: false,
        lastError: safeMessage(error),
      };
    }
  }

  private async connect(input: CodexAppServerLaunchOptions) {
    if ((input.args?.length ?? 0) > 0) {
      throw new Error(
        'Codex daemon transport does not accept process-scoped app-server arguments; '
        + 'supply provider configuration on thread/start or thread/resume.',
      );
    }
    const status = await this.ensureRunning(input.cwd);
    let firstError: Error | undefined;
    try {
      return await this.connectStatus(status, input);
    } catch (error) {
      firstError = asCodexError(error);
    }

    // A daemon can exit between status and connect. Serialize the recovery so
    // concurrent model/history probes do not launch competing start commands.
    const recovered = await this.ensureStarted(input.cwd, firstError);
    const deadline = this.now() + STARTUP_TIMEOUT_MS;
    let lastError = firstError;
    while (this.now() < deadline) {
      try {
        return await this.connectStatus(recovered, input);
      } catch (error) {
        lastError = asCodexError(error);
        await this.retryDelay(Math.min(RETRY_DELAY_MS, Math.max(0, deadline - this.now())));
      }
    }
    throw new Error(`Failed to connect to the Codex App Server daemon: ${lastError?.message ?? 'unknown error'}`);
  }

  private async ensureRunning(cwd: string) {
    if (this.readyStatus && this.now() - this.readyStatus.readAt < READY_STATUS_TTL_MS) {
      return this.readyStatus.value;
    }
    const status = await this.readStatus(cwd);
    return status.state === 'running' && status.socketPath
      ? status
      : this.ensureStarted(cwd, status.lastError ? new Error(status.lastError) : undefined);
  }

  private ensureStarted(cwd: string, cause?: Error) {
    if (this.startup) return this.startup;
    this.startup = this.startDaemon(cwd, cause).finally(() => {
      this.startup = null;
    });
    return this.startup;
  }

  private async startDaemon(cwd: string, cause?: Error) {
    try {
      this.readyStatus = null;
      await this.runCommand({
        binaryPath: this.binaryPath,
        args: ['app-server', 'daemon', 'start'],
        cwd,
        environment: this.environment,
        timeoutMs: START_TIMEOUT_MS,
      });
    } catch (error) {
      const message = safeMessage(error);
      throw new Error(cause
        ? `Codex daemon connection failed (${cause.message}); restart failed: ${message}`
        : `Codex daemon start failed: ${message}`);
    }
    const status = await this.readStatus(cwd);
    if (!status.socketPath || status.state === 'failed') {
      throw new Error(status.lastError ?? 'Codex daemon did not report a control socket after start.');
    }
    return status;
  }

  private connectStatus(status: CodexRuntimeStatus, input: CodexAppServerLaunchOptions) {
    if (!status.socketPath) throw new Error('Codex daemon status did not include a control socket.');
    return this.connectDaemon(status.socketPath, {
      ...input,
      binaryPath: this.binaryPath,
      environment: this.environment,
    });
  }
}

export function parseCodexRuntimeStatus(
  stdout: string,
  fallbackSocket: string | null = null,
): CodexRuntimeStatus {
  let value: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(stdout.trim());
    if (isRecord(parsed)) value = parsed;
  } catch {
    return {
      state: 'failed',
      socketPath: fallbackSocket,
      managedCodexPath: null,
      installedVersion: null,
      runningVersion: null,
      restartRequired: false,
      lastError: 'Codex daemon version returned invalid JSON.',
    };
  }
  const installedVersion = nonempty(value.cliVersion);
  const runningVersion = nonempty(value.appServerVersion);
  return {
    state: runtimeState(value.status),
    socketPath: nonempty(value.socketPath) ?? fallbackSocket,
    managedCodexPath: nonempty(value.managedCodexPath),
    installedVersion,
    runningVersion,
    restartRequired: Boolean(installedVersion && runningVersion && installedVersion !== runningVersion),
    lastError: null,
  };
}

export async function connectCodexDaemon(
  socketPath: string,
  options: CodexAppServerLaunchOptions,
): Promise<CodexAppServerConnection> {
  if (!socketPath.startsWith('/')) {
    throw new Error(`Codex daemon socket path must be absolute: ${JSON.stringify(socketPath)}.`);
  }
  if (socketPath.includes(':')) {
    throw new Error('Codex daemon socket paths containing a colon are unsupported by the WebSocket transport.');
  }
  const socket = new WebSocket(`ws+unix://${socketPath}:/`, {
    handshakeTimeout: CONNECT_TIMEOUT_MS,
    maxPayload: MAX_CODEX_PROTOCOL_MESSAGE_BYTES,
    perMessageDeflate: false,
  });
  let peer: CodexJsonRpcPeer;
  const opened = new Promise<void>((resolve, reject) => {
    const onOpen = () => {
      socket.off('error', onError);
      resolve();
    };
    const onError = (error: Error) => {
      socket.off('open', onOpen);
      reject(error);
    };
    socket.once('open', onOpen);
    socket.once('error', onError);
  });
  peer = new CodexJsonRpcPeer(options.handlers, {
    write: (encoded) => socket.send(encoded),
    close: () => closeSocket(socket),
  });
  socket.on('message', (raw: RawData) => peer.receiveText(raw.toString()));
  socket.on('close', (code, reason) => {
    const detail = reason.length > 0 ? `: ${reason.toString()}` : '';
    peer.transportExited(new Error(`Codex daemon connection closed with code ${code}${detail}.`));
  });
  socket.on('error', (error) => peer.transportExited(asCodexError(error)));
  try {
    await opened;
    return peer;
  } catch (error) {
    socket.terminate();
    throw error;
  }
}

export async function closeSocket(socket: WebSocket, timeoutMs = 2_000) {
  if (socket.readyState === WebSocket.CLOSED) return;
  if (socket.readyState === WebSocket.CONNECTING) {
    socket.terminate();
    return;
  }
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.off('close', onClose);
      if (error === undefined) resolve();
      else reject(error);
    };
    const onClose = () => finish();
    const timeout = setTimeout(() => {
      try {
        if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
        finish();
      } catch (error) {
        finish(error);
      }
    }, timeoutMs);
    timeout.unref();
    socket.once('close', onClose);
    try {
      socket.close(1000, 'client closing');
    } catch (error) {
      finish(error);
    }
  });
}

async function runCodexCommand(input: {
  binaryPath: string;
  args: readonly string[];
  cwd: string;
  environment: NodeJS.ProcessEnv;
  timeoutMs: number;
}): Promise<CodexRuntimeCommandResult> {
  try {
    const result = await execFile(input.binaryPath, [...input.args], {
      cwd: input.cwd,
      encoding: 'utf8',
      env: input.environment,
      maxBuffer: 1024 * 1024,
      timeout: input.timeoutMs,
    });
    return { stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const record = isRecord(error) ? error : {};
    const stderr = typeof record.stderr === 'string' ? record.stderr.trim() : '';
    const stdout = typeof record.stdout === 'string' ? record.stdout.trim() : '';
    throw new Error([safeMessage(error), stderr, stdout].filter(Boolean).join(': ').slice(0, 4_000));
  }
}

function fallbackSocketPath(environment: NodeJS.ProcessEnv) {
  const configured = nonempty(environment.CODEX_HOME);
  const codexHome = configured ?? join(homedir(), '.codex');
  return join(codexHome, 'app-server-control', 'app-server-control.sock');
}

function runtimeState(value: unknown): CodexRuntimeState {
  return value === 'running' || value === 'starting' || value === 'stopping' || value === 'failed'
    ? value
    : 'stopped';
}

function safeMessage(error: unknown) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/Bearer\s+\S+/giu, 'Bearer [redacted]')
    .slice(0, 4_000);
}

function nonempty(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
