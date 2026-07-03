const assert = require('node:assert/strict');
const http = require('node:http');
const { join } = require('node:path');
const test = require('node:test');

const { createRemuxServer } = require('../httpServer.cjs');

// Two distinct real files so light/dark responses can be told apart by body.
const lightIconPath = __filename;
const darkIconPath = join(__dirname, 'extension-registry.test.js');

test('createRemuxServer serves health, root redirect, and viewer providers', async () => {
  const server = createRemuxServer({
    defaultExtension: {
      id: 'codex',
      name: 'Codex',
      views: {
        main: { route: '/viewers/codex' },
      },
    },
    extensions: [
      {
        display: {
          icon: lightIconPath,
          iconDark: darkIconPath,
          title: 'Codex Mobile',
        },
        id: 'codex',
        launchers: [
          {
            icon: lightIconPath,
            iconDark: darkIconPath,
            id: 'new-chat',
            label: 'New Chat',
            route: null,
            view: 'main',
          },
          {
            icon: lightIconPath,
            id: 'plain',
            label: 'Plain',
            route: null,
            view: 'main',
          },
        ],
        name: 'Codex',
        views: {
          main: { route: '/viewers/codex' },
        },
      },
    ],
    viewerProviders: [
      {
        handle(request, response) {
          if (request.url === '/viewers/codex/') {
            response.writeHead(200, { 'content-type': 'text/plain' });
            response.end('viewer');
            return true;
          }

          return false;
        },
      },
    ],
  });

  await listen(server);

  try {
    const health = await request(server, '/health');
    assert.equal(health.statusCode, 200);
    assert.deepEqual(JSON.parse(health.body), { ok: true, defaultExtension: 'codex', service: 'remux' });

    const catalog = await request(server, '/remux/extensions');
    assert.equal(catalog.statusCode, 200);
    assert.deepEqual(JSON.parse(catalog.body), {
      defaultExtensionId: 'codex',
      extensions: [
        {
          display: {
            iconDarkUrl: '/remux/extensions/codex/icon?format=js&variant=dark',
            iconUrl: '/remux/extensions/codex/icon?format=js',
            title: 'Codex Mobile',
          },
          fileHandlers: [],
          id: 'codex',
          launchers: [
            {
              extensionId: 'codex',
              iconDarkUrl: '/remux/extensions/codex/icon?format=js&kind=launcher&id=new-chat&variant=dark',
              iconUrl: '/remux/extensions/codex/icon?format=js&kind=launcher&id=new-chat',
              id: 'new-chat',
              label: 'New Chat',
              route: null,
              view: 'main',
            },
            {
              extensionId: 'codex',
              iconDarkUrl: null,
              iconUrl: '/remux/extensions/codex/icon?format=js&kind=launcher&id=plain',
              id: 'plain',
              label: 'Plain',
              route: null,
              view: 'main',
            },
          ],
          name: 'Codex',
          views: {
            main: {
              route: '/viewers/codex',
            },
          },
        },
      ],
      service: 'remux',
    });

    const root = await request(server, '/');
    assert.equal(root.statusCode, 302);
    assert.equal(root.headers.location, '/viewers/codex/');

    const icon = await request(server, '/remux/extensions/codex/icon');
    assert.equal(icon.statusCode, 200);
    assert.equal(icon.headers['content-type'], 'application/octet-stream');
    assert.match(icon.body, /createRemuxServer serves health/u);

    const darkIcon = await request(server, '/remux/extensions/codex/icon?variant=dark');
    assert.equal(darkIcon.statusCode, 200);
    assert.match(darkIcon.body, /discoverExtensions loads JSON manifests/u);

    const launcherIcon = await request(server, '/remux/extensions/codex/icon?kind=launcher&id=new-chat&variant=dark');
    assert.equal(launcherIcon.statusCode, 200);
    assert.match(launcherIcon.body, /discoverExtensions loads JSON manifests/u);

    // A dark request for an entry without iconDark falls back to the light icon.
    const fallbackIcon = await request(server, '/remux/extensions/codex/icon?kind=launcher&id=plain&variant=dark');
    assert.equal(fallbackIcon.statusCode, 200);
    assert.match(fallbackIcon.body, /createRemuxServer serves health/u);

    const viewer = await request(server, '/viewers/codex/');
    assert.equal(viewer.statusCode, 200);
    assert.equal(viewer.body, 'viewer');

    const missing = await request(server, '/missing');
    assert.equal(missing.statusCode, 404);
  } finally {
    await close(server);
  }
});

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function request(server, path) {
  const address = server.address();
  return new Promise((resolve, reject) => {
    const req = http.get({
      host: '127.0.0.1',
      path,
      port: address.port,
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        resolve({ body, headers: res.headers, statusCode: res.statusCode });
      });
    });
    req.on('error', reject);
  });
}
