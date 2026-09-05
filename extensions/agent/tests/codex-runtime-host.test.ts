import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import WebSocket, { WebSocketServer } from 'ws';

import {
  CodexRuntimeHost,
  closeSocket,
  connectCodexDaemon,
  parseCodexRuntimeStatus,
  type CodexRuntimeCommandRunner,
} from '../server/src/providers/codex/codex-runtime-host.ts';

class CloseTestSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  closeCalls = 0;
  terminateCalls = 0;
  closeError: Error | null = null;
  acknowledgeClose = false;

  close(code: number, reason: string) {
    this.closeCalls += 1;
    assert.equal(code, 1000);
    assert.equal(reason, 'client closing');
    if (this.closeError) throw this.closeError;
    if (this.acknowledgeClose) {
      this.readyState = WebSocket.CLOSED;
      this.emit('close');
    }
  }

  terminate() {
    this.terminateCalls += 1;
    this.readyState = WebSocket.CLOSED;
  }
}

function asWebSocket(socket: CloseTestSocket) {
  return socket as unknown as WebSocket;
}

function observeCloseTimer(context: TestContext) {
  let callback: (() => void) | null = null;
  let cleared = 0;
  let unreferenced = 0;
  const timer = {
    unref: () => {
      unreferenced += 1;
      return timer;
    },
  } as unknown as NodeJS.Timeout;
  context.mock.method(globalThis, 'setTimeout', ((nextCallback: () => void) => {
    callback = nextCallback;
    return timer;
  }) as typeof setTimeout);
  context.mock.method(globalThis, 'clearTimeout', ((handle: NodeJS.Timeout) => {
    assert.equal(handle, timer);
    cleared += 1;
  }) as typeof clearTimeout);
  return {
    fire: () => {
      assert.ok(callback);
      callback();
    },
    counts: () => ({ cleared, unreferenced }),
  };
}

test('Codex daemon socket close releases its timer and listener after peer acknowledgement', async (context) => {
  const timer = observeCloseTimer(context);
  const socket = new CloseTestSocket();
  socket.acknowledgeClose = true;
  const existingListener = () => undefined;
  socket.on('close', existingListener);

  await closeSocket(asWebSocket(socket), 50);

  assert.equal(socket.closeCalls, 1);
  assert.equal(socket.terminateCalls, 0);
  assert.deepEqual(socket.listeners('close'), [existingListener]);
  assert.deepEqual(timer.counts(), { cleared: 1, unreferenced: 1 });
});

test('Codex daemon socket close terminates an unacknowledged peer within its bound', async (context) => {
  const timer = observeCloseTimer(context);
  const socket = new CloseTestSocket();
  const existingListener = () => undefined;
  socket.on('close', existingListener);

  const closing = closeSocket(asWebSocket(socket));
  timer.fire();
  await closing;

  assert.equal(socket.closeCalls, 1);
  assert.equal(socket.terminateCalls, 1);
  assert.deepEqual(socket.listeners('close'), [existingListener]);
  assert.deepEqual(timer.counts(), { cleared: 1, unreferenced: 1 });
});

test('Codex daemon socket close cleans up when initiating close throws', async (context) => {
  const timer = observeCloseTimer(context);
  const socket = new CloseTestSocket();
  socket.closeError = new Error('close failed');
  const existingListener = () => undefined;
  socket.on('close', existingListener);

  await assert.rejects(closeSocket(asWebSocket(socket), 50), /close failed/);

  assert.equal(socket.closeCalls, 1);
  assert.equal(socket.terminateCalls, 0);
  assert.deepEqual(socket.listeners('close'), [existingListener]);
  assert.deepEqual(timer.counts(), { cleared: 1, unreferenced: 1 });
});

test('Codex daemon socket close preserves closed and connecting behavior', async () => {
  const closed = new CloseTestSocket();
  closed.readyState = WebSocket.CLOSED;
  await closeSocket(asWebSocket(closed), 5);
  assert.equal(closed.closeCalls, 0);
  assert.equal(closed.terminateCalls, 0);

  const connecting = new CloseTestSocket();
  connecting.readyState = WebSocket.CONNECTING;
  await closeSocket(asWebSocket(connecting), 5);
  assert.equal(connecting.closeCalls, 0);
  assert.equal(connecting.terminateCalls, 1);
});

test('Codex runtime status separates installed and running daemon versions', () => {
  assert.deepEqual(parseCodexRuntimeStatus(JSON.stringify({
    status: 'running',
    managedCodexPath: '/managed/codex',
    socketPath: '/tmp/codex.sock',
    cliVersion: '0.154.0',
    appServerVersion: '0.153.2',
  })), {
    state: 'running',
    socketPath: '/tmp/codex.sock',
    managedCodexPath: '/managed/codex',
    installedVersion: '0.154.0',
    runningVersion: '0.153.2',
    restartRequired: true,
    lastError: null,
  });
});

test('Codex runtime host starts one daemon and gives sessions independent clients', async () => {
  let running = false;
  const commands: string[][] = [];
  const connected: string[] = [];
  const environments: NodeJS.ProcessEnv[] = [];
  const runner: CodexRuntimeCommandRunner = async ({ args, environment }) => {
    commands.push([...args]);
    environments.push(environment);
    if (args.at(-1) === 'start') {
      running = true;
      return { stdout: '', stderr: '' };
    }
    return {
      stdout: JSON.stringify({
        status: running ? 'running' : 'stopped',
        socketPath: '/tmp/codex-runtime-host.sock',
        cliVersion: '0.153.2',
        ...(running ? { appServerVersion: '0.153.2' } : {}),
      }),
      stderr: '',
    };
  };
  const host = new CodexRuntimeHost({
    environment: { REMUX_FEDERATION_MCP_BEARER_TOKEN: 'must-not-reach-daemon' },
    runCommand: runner,
    connectDaemon: async (socketPath) => {
      connected.push(socketPath);
      return {
        request: async () => ({}),
        notify: () => undefined,
        close: async () => undefined,
      };
    },
  });
  const handlers = {
    onNotification: () => undefined,
    onServerRequest: async () => ({}),
    onExit: () => undefined,
  };

  const first = await host.connectionFactory({
    binaryPath: 'ignored',
    cwd: process.cwd(),
    handlers,
  });
  const second = await host.connectionFactory({
    binaryPath: 'ignored',
    cwd: process.cwd(),
    handlers,
  });

  assert.notEqual(first, second);
  assert.deepEqual(commands, [
    ['app-server', 'daemon', 'version'],
    ['app-server', 'daemon', 'start'],
    ['app-server', 'daemon', 'version'],
  ]);
  assert.deepEqual(connected, [
    '/tmp/codex-runtime-host.sock',
    '/tmp/codex-runtime-host.sock',
  ]);
  assert.ok(environments.every((environment) =>
    environment.REMUX_FEDERATION_MCP_BEARER_TOKEN === undefined));
});

test('Codex daemon transport speaks JSON-RPC over its Unix WebSocket', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'remux-codex-daemon-'));
  const socketPath = join(directory, 'app-server.sock');
  const server = createServer();
  const sockets = new WebSocketServer({ server });
  context.after(async () => {
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  sockets.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (message.method === 'test/roundtrip') {
        socket.send(JSON.stringify({
          jsonrpc: '2.0',
          id: 'server-request-1',
          method: 'item/tool/requestUserInput',
          params: { questions: [] },
        }));
      } else if (message.id === 'server-request-1') {
        socket.send(JSON.stringify({
          jsonrpc: '2.0',
          method: 'test/notification',
          params: { accepted: true },
        }));
        socket.send(JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: { ok: true },
        }));
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve());
  });

  const notifications: string[] = [];
  const connection = await connectCodexDaemon(socketPath, {
    binaryPath: 'codex',
    cwd: process.cwd(),
    handlers: {
      onNotification: ({ method }) => notifications.push(method),
      onServerRequest: async () => ({ answers: {} }),
      onExit: () => undefined,
    },
  });
  assert.deepEqual(await connection.request('test/roundtrip', {}), { ok: true });
  assert.deepEqual(notifications, ['test/notification']);
  await connection.close();
});
