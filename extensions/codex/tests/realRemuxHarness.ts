import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, type WriteStream } from 'node:fs';
import {
  access,
  cp,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { BrowserContext, Page } from '@playwright/test';
import WebSocket from 'ws';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const fixtureThreadId = '019-narration-real-0000-7000-8000-000000000001';
const authToken = 'narration-real-token-narration-real-token-narration-real-token-01';

export type RealRemuxRuntime = {
  baseUrl: string;
  codeHome: string;
  guardianPort: number;
  lockPath: string;
  log: WriteStream;
  logPath: string;
  port: number;
  process: ChildProcess;
  root: string;
  rpc: RealRemuxRpc;
  threadId: string;
  token: string;
};

export async function startRealRemuxRuntime(): Promise<RealRemuxRuntime> {
  const installedCodexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex');
  const prerequisites = {
    codexServer: '/tmp/remux-codex-server-target/release/remux-codex-server',
    codexViewer: join(repoRoot, 'extensions/codex/viewer/dist/index.html'),
    model: process.env.REMUX_NARRATION_MODEL_DIR ?? join(
      installedCodexHome,
      'remux/narration/models/kokoro-82m-onnx-duration-v1',
    ),
    narrateServer: '/tmp/remux-narrate-server-target/release/remux-narrate-server',
    remux: join(repoRoot, 'target/release/remux'),
  };
  for (const [name, path] of Object.entries(prerequisites)) {
    try {
      await access(path.includes('kokoro-82m') ? join(path, 'asset-manifest.json') : path);
    } catch {
      throw new Error(`Real narration prerequisite ${name} is missing at ${path}. Run npm run build:codex:narration-real first.`);
    }
  }

  const lockPath = join(tmpdir(), 'remux-narration-real.lock');
  await acquireHarnessLock(lockPath);
  let root: string | null = null;
  let log: WriteStream | null = null;
  let runtime: RealRemuxRuntime | null = null;
  try {
    root = await mkdtemp(join(tmpdir(), 'remux-narration-real-'));
    const codeHome = join(root, 'codex-home');
    const sessionDir = join(codeHome, 'sessions/2026/07/17');
    await mkdir(sessionDir, { recursive: true });
    await stageCodexRuntime(codeHome, installedCodexHome);
    await cp(
      join(here, 'fixtures/narration-rollout.jsonl'),
      join(sessionDir, `rollout-2026-07-17T00-00-00-000Z-${fixtureThreadId}.jsonl`),
    );

    await stageExtension(root, 'codex', prerequisites.codexServer);
    await stageExtension(root, 'narrate', prerequisites.narrateServer);
    const stagedModel = join(root, '.remux/models/narrate/kokoro-82m-onnx-duration-v1');
    await mkdir(dirname(stagedModel), { recursive: true });
    await symlink(prerequisites.model, stagedModel, 'dir');

    const [port, guardianPort] = await Promise.all([freePort(), freePort()]);
    await mkdir(join(root, '.remux'), { recursive: true });
    await writeFile(join(root, '.remux/config.toml'), [
      'host = "127.0.0.1"',
      `port = ${port}`,
      `guardian_port = ${guardianPort}`,
      'require_auth = true',
      '',
    ].join('\n'));

    const logPath = join(root, 'runtime.log');
    log = createWriteStream(logPath, { flags: 'a' });
    const environment = { ...process.env };
    delete environment.REMUX_EXTENSION_ROOTS;
    delete environment.REMUX_WORKER;
    delete environment.REMUX_WORKLOAD_EXEC;
    Object.assign(environment, {
      CODEX_HOME: codeHome,
      REMUX_AUTH_TOKEN: authToken,
      REMUX_RESOURCE_GOVERNANCE: '1',
    });
    const child = spawn(prerequisites.remux, ['--root', root, 'start', '--foreground'], {
      cwd: root,
      // The nested Remux guardian may signal its own process group during
      // shutdown. Keep that group separate from Playwright/the workload, then
      // stop the supervisor by its positive PID below.
      detached: true,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.pipe(log);
    child.stderr?.pipe(log);

    runtime = {
      baseUrl: `http://127.0.0.1:${port}`,
      codeHome,
      guardianPort,
      lockPath,
      log,
      logPath,
      port,
      process: child,
      root,
      rpc: new RealRemuxRpc(`ws://127.0.0.1:${port}/ws`, authToken),
      threadId: fixtureThreadId,
      token: authToken,
    };
    await waitForRuntime(runtime);
    await runtime.rpc.connect();
    return runtime;
  } catch (error) {
    if (runtime) {
      await stopRealRemuxRuntime(runtime);
    } else {
      if (log) await endLog(log);
      if (root) await rm(root, { force: true, recursive: true });
      await rm(lockPath, { force: true, recursive: true });
    }
    throw error;
  }
}

async function stageCodexRuntime(codeHome: string, installedCodexHome: string) {
  await mkdir(join(codeHome, 'packages'), { recursive: true });
  await symlink(
    join(installedCodexHome, 'packages/standalone'),
    join(codeHome, 'packages/standalone'),
    'dir',
  );
  for (const name of ['auth.json', 'config.toml', 'installation_id', 'version.json']) {
    try {
      await copyFile(join(installedCodexHome, name), join(codeHome, name));
    } catch {
      if (name === 'auth.json' || name === 'config.toml') {
        throw new Error(`Real narration prerequisite Codex ${name} is missing`);
      }
    }
  }
}

export async function stopRealRemuxRuntime(runtime: RealRemuxRuntime) {
  try {
    // Stopping the nested Codex app-server workload directly can stop the
    // enclosing acceptance workload too, because descendants inherit that
    // OS workload scope. The nested Remux supervisor owns extension teardown.
    runtime.rpc.close();
    try {
      if (processRunning(runtime.process) && runtime.process.pid) {
        runtime.process.kill('SIGTERM');
        await waitForExit(runtime.process, 8_000);
      }
      if (processRunning(runtime.process) && runtime.process.pid) {
        runtime.process.kill('SIGKILL');
        await waitForExit(runtime.process, 2_000);
      }
    } catch {
      // Continue through log, root, and lock cleanup after a process error.
    }
    await endLog(runtime.log);
    const retainedLogs = join(repoRoot, 'test-results/codex-narration-real-runtime-logs');
    try {
      await rm(retainedLogs, { force: true, recursive: true });
      await mkdir(retainedLogs, { recursive: true });
      try { await copyFile(runtime.logPath, join(retainedLogs, 'runtime.log')); } catch { /* No runtime log. */ }
      try {
        await cp(join(runtime.root, '.remux/logs'), join(retainedLogs, 'extension-logs'), {
          recursive: true,
        });
      } catch {
        // Startup can fail before the extension log tree exists.
      }
    } catch {
      // Retaining diagnostics must not prevent cleanup.
    }
    await rm(runtime.root, { force: true, recursive: true });
  } finally {
    await rm(runtime.lockPath, { force: true, recursive: true });
  }
}

export async function installRealViewerBridge(
  context: BrowserContext,
  runtime: RealRemuxRuntime,
) {
  await context.addCookies([{
    domain: '127.0.0.1',
    httpOnly: true,
    name: 'remux_auth',
    path: '/',
    sameSite: 'Lax',
    secure: false,
    value: runtime.token,
  }]);
  await context.addInitScript(({ port, threadId }) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const queue: string[] = [];
    const methods: string[] = [];
    let lifecycleEpoch = 1;

    const dispatch = (message: unknown) => {
      const event = new MessageEvent('message', { data: JSON.stringify(message) });
      window.dispatchEvent(event);
    };
    const send = (message: unknown) => {
      const encoded = JSON.stringify(message);
      if (socket.readyState === WebSocket.OPEN) socket.send(encoded);
      else queue.push(encoded);
    };
    const hostResult = (id: string | number, result: unknown) => dispatch({
      id,
      result,
      type: 'remux/response',
    });
    const publishConnected = () => {
      dispatch({
        error: null,
        status: { cwd: '/tmp/remux-narration-real', generation: 1, type: 'connected' },
        type: 'remux/status',
      });
      dispatch({
        lifecycle: { epoch: lifecycleEpoch, reason: 'connect', state: 'active' },
        type: 'remux/lifecycle',
      });
      for (const [method, params] of [
        ['host/connection', { generation: 1, status: 'connected' }],
        ['host/active', { active: true }],
        ['host/theme', { theme: 'dark' }],
      ]) dispatch({ message: { jsonrpc: '2.0', method, params }, type: 'remux/event' });
    };

    socket.addEventListener('open', () => {
      for (const message of queue.splice(0)) socket.send(message);
      publishConnected();
    });
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id != null && message.error) {
        dispatch({ error: message.error, id: message.id, type: 'remux/error' });
      } else if (message.id != null && Object.prototype.hasOwnProperty.call(message, 'result')) {
        dispatch({ id: message.id, result: message.result, type: 'remux/response' });
      } else if (typeof message.method === 'string') {
        dispatch({ message, type: 'remux/event' });
      }
    });
    socket.addEventListener('close', () => dispatch({
      error: 'Real Remux socket closed',
      status: { reason: 'Real Remux socket closed', type: 'closed' },
      type: 'remux/status',
    }));

    Object.defineProperty(window, '__realNarrationBridge', {
      configurable: true,
      value: {
        lifecycle(state: 'active' | 'background' | 'inactive') {
          lifecycleEpoch += 1;
          dispatch({
            lifecycle: { epoch: lifecycleEpoch, reason: 'appState', state },
            type: 'remux/lifecycle',
          });
        },
        methods,
      },
    });
    Object.defineProperty(window, 'ReactNativeWebView', {
      configurable: true,
      value: {
        postMessage(raw: string) {
          const message = JSON.parse(raw);
          if (typeof message.method === 'string') methods.push(message.method);
          if (message.type === 'remux/ready') {
            if (socket.readyState === WebSocket.OPEN) publishConnected();
            return;
          }
          if (message.type === 'remux/cancel') {
            send({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id: message.id } });
            return;
          }
          if (message.type === 'remux/notify') return;
          if (message.type !== 'remux/request') return;
          if (message.method === 'host/viewport/get') {
            hostResult(message.id, {
              keyboardHeight: 0,
              keyboardVisible: false,
              visibleBottom: window.innerHeight,
              visibleTop: 0,
              viewportHeight: window.innerHeight,
              viewportWidth: window.innerWidth,
            });
            return;
          }
          if (message.method === 'host/theme/get') {
            hostResult(message.id, { theme: 'dark' });
            return;
          }
          if (message.method.startsWith('host/')) {
            hostResult(message.id, { ok: true });
            return;
          }
          send({
            jsonrpc: '2.0',
            id: message.id,
            method: message.method,
            params: message.params,
            remuxContract: message.contract,
            remuxContext: { resourceKey: `thread:${threadId}`, tabId: 'narration-real-tab' },
          });
        },
      },
    });
  }, { port: runtime.port, threadId: runtime.threadId });
}

export async function narrationDebugSnapshot(page: Page) {
  return page.evaluate(() => (
    window as typeof window & { __remuxNarrationDebugSnapshot?: () => unknown }
  ).__remuxNarrationDebugSnapshot?.());
}

async function stageExtension(root: string, id: 'codex' | 'narrate', serverBinary: string) {
  const source = join(repoRoot, 'extensions', id);
  const destination = join(root, 'extensions', id);
  await mkdir(destination, { recursive: true });
  const manifest = JSON.parse(await readFile(join(source, 'remux-extension.json'), 'utf8'));
  manifest.server.command = serverBinary;
  manifest.server.cwd = '.';
  delete manifest.server.build;
  for (const view of Object.values(manifest.views) as Array<Record<string, unknown>>) {
    delete view.build;
    delete view.watch;
  }
  await writeFile(
    join(destination, 'remux-extension.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  await cp(join(source, 'viewer/dist'), join(destination, 'viewer/dist'), { recursive: true });
  await cp(join(source, 'assets'), join(destination, 'assets'), { recursive: true });
}

async function waitForRuntime(runtime: RealRemuxRuntime) {
  const deadline = Date.now() + 45_000;
  let lastError = 'runtime did not answer';
  while (Date.now() < deadline) {
    if (runtime.process.exitCode !== null) break;
    try {
      const response = await fetch(`${runtime.baseUrl}/api/status`, {
        headers: { authorization: `Bearer ${runtime.token}` },
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) {
        const status = await response.json() as any;
        const extensions = status.extensions?.extensions ?? [];
        const codex = extensions.find((extension: any) => extension.extensionId === 'codex');
        const narrate = extensions.find((extension: any) => extension.extensionId === 'narrate');
        if (
          codex?.running === true
          && narrate?.running === true
          && status.resources?.resourceProtection?.protectedMode === true
        ) return;
        lastError = `extensions/resources not ready: ${JSON.stringify({ codex, narrate, resources: status.resources })}`;
      } else {
        lastError = `status returned HTTP ${response.status}`;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(250);
  }
  let logs = '';
  try { logs = await readFile(runtime.logPath, 'utf8'); } catch { /* No logs yet. */ }
  throw new Error(`Real Remux did not become ready: ${lastError}\n${logs.slice(-8_000)}`);
}

async function freePort() {
  return new Promise<number>((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolvePort(port));
    });
  });
}

async function waitForExit(child: ChildProcess, timeoutMs: number) {
  if (!processRunning(child)) return;
  await Promise.race([
    new Promise<void>((resolveExit) => child.once('exit', () => resolveExit())),
    delay(timeoutMs),
  ]);
}

async function endLog(log: WriteStream) {
  if (log.writableEnded) return;
  await new Promise<void>((resolveLog) => log.end(resolveLog));
}

function processRunning(child: ChildProcess) {
  return child.exitCode === null && child.signalCode === null;
}

function delay(milliseconds: number) {
  return new Promise<void>((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function acquireHarnessLock(lockPath: string) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await mkdir(lockPath);
      try {
        await writeFile(join(lockPath, 'owner.json'), JSON.stringify({ pid: process.pid }));
      } catch (error) {
        await rm(lockPath, { force: true, recursive: true });
        throw error;
      }
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let ownerPid: number | null = null;
      try {
        ownerPid = JSON.parse(await readFile(join(lockPath, 'owner.json'), 'utf8')).pid ?? null;
      } catch { /* An interrupted owner may not have written metadata. */ }
      let ownerAlive = false;
      if (ownerPid) {
        try {
          process.kill(ownerPid, 0);
          ownerAlive = true;
        } catch { /* Stale lock. */ }
      }
      if (ownerAlive) {
        throw new Error(`Another real narration acceptance run is active (pid ${ownerPid}).`);
      }
      await rm(lockPath, { force: true, recursive: true });
    }
  }
  throw new Error('Could not acquire the real narration acceptance lock.');
}

export class RealRemuxRpc {
  private id = 0;
  private pending = new Map<number, {
    reject: (error: Error) => void;
    resolve: (value: any) => void;
    timeout: ReturnType<typeof setTimeout>;
  }>();
  private socket: WebSocket | null = null;

  constructor(private readonly url: string, private readonly token: string) {}

  connect() {
    if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise<void>((resolveConnection, reject) => {
      const socket = new WebSocket(this.url, { headers: { authorization: `Bearer ${this.token}` } });
      this.socket = socket;
      socket.once('open', () => resolveConnection());
      socket.once('error', reject);
      socket.on('message', (raw) => {
        const message = JSON.parse(String(raw));
        if (typeof message.id !== 'number') return;
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timeout);
        if (message.error) pending.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
        else pending.resolve(message.result);
      });
      socket.on('close', () => {
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timeout);
          pending.reject(new Error('Real Remux socket closed'));
        }
        this.pending.clear();
      });
    });
  }

  async request(
    method: string,
    params: unknown,
    contract: Record<string, unknown> = { kind: 'query' },
  ): Promise<any> {
    await this.connect();
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error('Real Remux socket is unavailable');
    const id = ++this.id;
    return new Promise((resolveRequest, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Real Remux request timed out: ${method}`));
      }, 15_000);
      this.pending.set(id, { reject, resolve: resolveRequest, timeout });
      socket.send(JSON.stringify({
        jsonrpc: '2.0',
        id,
        method,
        ...(params === undefined ? {} : { params }),
        remuxContract: contract,
        remuxContext: { resourceKey: 'thread:narration-real', tabId: 'narration-real-harness' },
      }));
    });
  }

  close() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Real Remux RPC client closed'));
    }
    this.pending.clear();
    this.socket?.close();
    this.socket = null;
  }
}
