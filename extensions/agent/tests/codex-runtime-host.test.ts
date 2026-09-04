import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { WebSocketServer } from 'ws';

import {
  CodexRuntimeHost,
  connectCodexDaemon,
  parseCodexRuntimeStatus,
  type CodexRuntimeCommandRunner,
} from '../server/src/providers/codex/codex-runtime-host.ts';

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
