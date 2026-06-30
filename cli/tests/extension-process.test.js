const assert = require('node:assert/strict');
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const test = require('node:test');

const { createExtensionProcess } = require('../extensionProcess.cjs');
const { JsonRpcError } = require('../jsonRpc.cjs');

test('createExtensionProcess proxies requests and broadcasts extension notifications', async () => {
  const fixture = createProcessFixture();
  const extension = {
    id: 'fixture',
    server: {
      args: [fixture.script],
      command: process.execPath,
      cwd: fixture.root,
    },
  };
  const broadcasts = [];
  const fatals = [];
  const notifications = [];
  const processServer = createExtensionProcess({
    extension,
    log: silentLog(),
    requestTimeoutMs: 1_000,
  });

  try {
    await processServer.start({
      broadcast(message) {
        broadcasts.push(message);
      },
      fatal(reason) {
        fatals.push(reason);
      },
      async handleExtensionNotification(message) {
        notifications.push(message);
        return true;
      },
    });

    assert.deepEqual(
      await processServer.handleRpc({
        method: 'ping',
        params: { value: 1 },
      }),
      { method: 'ping', params: { value: 1 } },
    );

    await processServer.handleRpc({ method: 'notify' });
    assert.equal(broadcasts.length, 1);
    assert.equal(broadcasts[0].method, 'fixture/event');
    assert.deepEqual(broadcasts[0].params, { ok: true });

    await processServer.handleRpc({ method: 'notify-remux' });
    assert.equal(broadcasts.length, 1);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].method, 'remux/notifications/request');
    assert.deepEqual(notifications[0].params, {
      extensionId: 'fixture',
      id: 'notification-1',
      target: {
        resourceId: 'thread-1',
        resourceKind: 'thread',
      },
      title: 'Fixture complete',
    });
    assert.deepEqual(fatals, []);
  } finally {
    await processServer.stop();
    fixture.cleanup();
  }
});

test('createExtensionProcess turns extension error responses into JsonRpcError', async () => {
  const fixture = createProcessFixture();
  const processServer = createExtensionProcess({
    extension: {
      id: 'fixture',
      server: {
        args: [fixture.script],
        command: process.execPath,
        cwd: fixture.root,
      },
    },
    log: silentLog(),
    requestTimeoutMs: 1_000,
  });

  try {
    await processServer.start({
      broadcast() {},
      fatal(error) {
        throw new Error(error);
      },
    });

    await assert.rejects(
      () => processServer.handleRpc({ method: 'fail' }),
      (error) => {
        assert.equal(error instanceof JsonRpcError, true);
        assert.equal(error.code, -32010);
        assert.match(error.message, /fail failed: fixture failed/u);
        return true;
      },
    );
  } finally {
    await processServer.stop();
    fixture.cleanup();
  }
});

test('createExtensionProcess writes notifications without registering an RPC request', async () => {
  const fixture = createProcessFixture();
  const processServer = createExtensionProcess({
    extension: {
      id: 'fixture',
      server: {
        args: [fixture.script],
        command: process.execPath,
        cwd: fixture.root,
      },
    },
    log: silentLog(),
    requestTimeoutMs: 1_000,
  });

  try {
    await processServer.start({
      broadcast() {},
      fatal(error) {
        throw new Error(error);
      },
    });

    processServer.handleNotification({
      method: 'typed-input',
      params: { value: 'a' },
    });

    await waitFor(async () => {
      const result = await processServer.handleRpc({ method: 'notifications' });
      return result.notifications.length === 1;
    });

    assert.deepEqual(
      await processServer.handleRpc({ method: 'notifications' }),
      {
        notifications: [
          {
            hasId: false,
            method: 'typed-input',
            params: { value: 'a' },
          },
        ],
      },
    );
  } finally {
    await processServer.stop();
    fixture.cleanup();
  }
});

test('createExtensionProcess logs extension stderr diagnostics', async () => {
  const fixture = createProcessFixture();
  const events = [];
  const processServer = createExtensionProcess({
    extension: {
      id: 'fixture',
      server: {
        args: [fixture.script],
        command: process.execPath,
        cwd: fixture.root,
      },
    },
    log: {
      event(entry) {
        events.push(entry);
      },
      warn() {},
    },
    requestTimeoutMs: 1_000,
  });

  try {
    await processServer.start({
      broadcast() {},
      fatal(error) {
        throw new Error(error);
      },
    });

    await processServer.handleRpc({ method: 'stderr' });
    await waitFor(() => events.some((event) => (
      event.label === 'extension:stderr' &&
      event.source === 'extension:fixture' &&
      event.detail?.line === 'fixture diagnostic'
    )));
  } finally {
    await processServer.stop();
    fixture.cleanup();
  }
});

function createProcessFixture() {
  const root = mkdtempSync(join(tmpdir(), 'remux-extension-process-'));
  const script = join(root, 'extension.cjs');
  writeFileSync(script, [
    "const readline = require('node:readline');",
    'const notifications = [];',
    "const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });",
    "input.on('line', (line) => {",
    "  const request = JSON.parse(line);",
    "  if (!Object.prototype.hasOwnProperty.call(request, 'id')) {",
    "    notifications.push({ hasId: false, method: request.method, params: request.params });",
    '    return;',
    '  }',
    "  if (request.method === 'notifications') {",
    "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { notifications } }) + '\\n');",
    '    return;',
    '  }',
    "  if (request.method === 'fail') {",
    "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32010, message: 'fixture failed' } }) + '\\n');",
    '    return;',
    '  }',
    "  if (request.method === 'notify') {",
    "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'fixture/event', params: { ok: true } }) + '\\n');",
    '  }',
    "  if (request.method === 'notify-remux') {",
    "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'remux/notifications/request', params: { extensionId: 'spoofed', id: 'notification-1', target: { resourceId: 'thread-1', resourceKind: 'thread' }, title: 'Fixture complete' } }) + '\\n');",
    '  }',
    "  if (request.method === 'stderr') {",
    "    process.stderr.write('fixture diagnostic\\n');",
    '  }',
    "  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { method: request.method, params: request.params } }) + '\\n');",
    '});',
  ].join('\n'));

  return {
    cleanup() {
      rmSync(root, { force: true, recursive: true });
    },
    root,
    script,
  };
}

function silentLog() {
  return {
    warn() {},
  };
}

async function waitFor(predicate, timeoutMs = 1_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }

  assert.fail('Timed out waiting for condition');
}
