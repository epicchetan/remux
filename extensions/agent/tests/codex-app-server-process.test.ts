import assert from 'node:assert/strict';
import { chmod } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  launchCodexAppServer,
  type CodexServerNotification,
} from '../server/src/providers/codex/codex-app-server-process.ts';

const mockBinary = fileURLToPath(new URL('./helpers/mock-codex-app-server.mjs', import.meta.url));

test('Codex stdio transport routes responses, notifications, and server requests', async () => {
  await chmod(mockBinary, 0o755);
  const notifications: CodexServerNotification[] = [];
  const exits: Error[] = [];
  const connection = await launchCodexAppServer({
    binaryPath: mockBinary,
    cwd: process.cwd(),
    handlers: {
      onNotification: (notification) => notifications.push(notification),
      onServerRequest: async (request) => {
        assert.equal(request.method, 'item/tool/requestUserInput');
        return { answers: {} };
      },
      onExit: (error) => exits.push(error),
    },
  });
  const beforeWrites: Array<[string, number]> = [];
  assert.deepEqual(await connection.request('test/roundtrip', {}, undefined,
    (method, requestId) => beforeWrites.push([method, requestId])), { ok: true });
  assert.deepEqual(beforeWrites, [['test/roundtrip', 1]]);
  assert.deepEqual(notifications, [{
    method: 'test/notification',
    params: { accepted: true },
  }]);
  await assert.rejects(
    connection.request('test/failure', {}),
    /test\/failure failed \(-32001\): fixture failure/u,
  );
  await connection.close();
  assert.ok(exits.length <= 1);
});

test('Codex stdio transport contains notification consumer failures', async () => {
  await chmod(mockBinary, 0o755);
  const diagnostics: string[] = [];
  const connection = await launchCodexAppServer({
    binaryPath: mockBinary,
    cwd: process.cwd(),
    handlers: {
      onNotification: () => {
        throw new Error('projection exploded');
      },
      onServerRequest: async () => ({ answers: {} }),
      onExit: () => undefined,
      onStderr: (line) => diagnostics.push(line),
    },
  });
  assert.deepEqual(await connection.request('test/roundtrip', {}), { ok: true });
  assert.ok(diagnostics.some((line) =>
    line.includes('Ignored Codex notification test/notification: projection exploded')));
  await connection.close();
});
