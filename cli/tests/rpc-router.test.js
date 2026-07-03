const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createCoreRouter } = require('../core/coreRouter.cjs');
const {
  createRpcRouter,
  extensionIdFromMethod,
} = require('../rpcRouter.cjs');

test('extensionIdFromMethod extracts remux method namespaces', () => {
  assert.equal(extensionIdFromMethod('remux/codex/transcript/read'), 'codex');
  assert.equal(extensionIdFromMethod('remux/files/list'), 'files');
  assert.equal(extensionIdFromMethod('host/viewport/get'), null);
  assert.equal(extensionIdFromMethod('ping'), null);
});

test('createRpcRouter starts all extensions and routes by remux namespace', async () => {
  const calls = [];
  const router = createRpcRouter({
    coreRouter: {
      async handleRpc(request) {
        return {
          core: true,
          method: request.method,
          params: request.params,
        };
      },
    },
    defaultExtensionId: 'codex',
    extensionServers: new Map([
      ['codex', fixtureServer('codex', calls)],
      ['fs', fixtureServer('fs-extension', calls)],
      ['files', fixtureServer('files', calls)],
    ]),
    system: {
      async info() {
        calls.push('system:info');
        return {
          cwd: '/tmp/remux-runtime',
        };
      },
      async restart() {
        calls.push('system:restart');
      },
    },
  });

  await router.start({});

  assert.deepEqual(calls, ['codex:start', 'fs-extension:start', 'files:start']);
  assert.deepEqual(
    await router.handleRequest({ method: 'remux/fs/readDirectory', params: { path: '/tmp' } }),
    { core: true, method: 'remux/fs/readDirectory', params: { path: '/tmp' } },
  );
  assert.deepEqual(
    await router.handleRequest({ method: 'remux/fs/readDirectories', params: { paths: ['/tmp'] } }),
    { core: true, method: 'remux/fs/readDirectories', params: { paths: ['/tmp'] } },
  );
  assert.deepEqual(
    await router.handleRequest({ method: 'remux/fs/readFile', params: { path: '/tmp/file.ts' } }),
    { core: true, method: 'remux/fs/readFile', params: { path: '/tmp/file.ts' } },
  );
  assert.deepEqual(
    await router.handleRequest({ method: 'remux/files/list', params: { cwd: '/tmp' } }),
    { extensionId: 'files', method: 'remux/files/list', params: { cwd: '/tmp' } },
  );
  assert.deepEqual(
    await router.handleRequest({ method: 'legacy/ping' }),
    { extensionId: 'codex', method: 'legacy/ping', params: undefined },
  );
  assert.deepEqual(
    await router.handleRequest({ method: 'remux/extensions/status' }),
    {
      extensions: [
        { extensionId: 'codex', restartable: true, running: true },
        { extensionId: 'fs', restartable: true, running: true },
        { extensionId: 'files', restartable: true, running: true },
      ],
    },
  );
  assert.deepEqual(
    await router.handleRequest({ method: 'remux/extensions/restart', params: { extensionId: 'files' } }),
    { extensionId: 'files', restartable: true, restarted: true, running: true },
  );
  assert.deepEqual(
    await router.handleRequest({ method: 'remux/extensions/stop', params: { extensionId: 'files' } }),
    { extensionId: 'files', restartable: true, stopped: true, running: false },
  );
  assert.deepEqual(
    await router.handleRequest({ method: 'remux/extensions/start', params: { extensionId: 'files' } }),
    { extensionId: 'files', restartable: true, started: true, running: true },
  );
  assert.deepEqual(
    await router.handleRequest({ method: 'remux/system/ping' }),
    { ok: true },
  );
  assert.deepEqual(
    await router.handleRequest({ method: 'remux/system/info' }),
    { cwd: '/tmp/remux-runtime' },
  );
  assert.deepEqual(
    await router.handleRequest({ method: 'remux/system/restart' }),
    { restartable: true, restarting: true },
  );

  await router.stop();
  assert.deepEqual(calls, [
    'codex:start',
    'fs-extension:start',
    'files:start',
    'files:stop',
    'files:start',
    'files:stop',
    'files:start',
    'system:info',
    'system:restart',
    'codex:stop',
    'fs-extension:stop',
    'files:stop',
  ]);
});

test('createCoreRouter handles readFile git metadata', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'remux-core-router-'));
  const filePath = path.join(root, 'file.txt');
  await fs.writeFile(filePath, 'hello\n');

  const router = createCoreRouter({ rootDir: root });
  const result = await router.handleRpc({
    method: 'remux/fs/readFile',
    params: {
      git: { includeBase: true, includeStatus: true },
      path: filePath,
    },
  });

  assert.equal(result.content, 'hello\n');
  assert.equal(result.git.status, null);
  assert.equal(result.git.repoRoot, null);
  assert.deepEqual(result.git.base, {
    content: null,
    encoding: null,
    isBinary: false,
    path: filePath,
    ref: 'HEAD',
    repoRoot: null,
    sizeBytes: null,
    status: null,
    tooLarge: false,
    unavailableReason: 'File is not in a git repository.',
  });
});

function fixtureServer(extensionId, calls) {
  let running = false;

  return {
    async handleRpc(request) {
      return {
        extensionId,
        method: request.method,
        params: request.params,
      };
    },
    async start() {
      running = true;
      calls.push(`${extensionId}:start`);
      return this.status();
    },
    async stop() {
      running = false;
      calls.push(`${extensionId}:stop`);
      return this.status();
    },
    status() {
      return {
        restartable: true,
        running,
      };
    },
  };
}
