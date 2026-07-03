const assert = require('node:assert/strict');
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { delimiter, join } = require('node:path');
const test = require('node:test');

const {
  discoverExtensions,
  extensionRoots,
} = require('../extensionRegistry.cjs');
const {
  loadExtensionManifest,
  validateManifest,
} = require('../extensionManifest.cjs');

test('discoverExtensions loads JSON manifests and ignores folders without one', () => {
  const fixture = createRegistryFixture();

  try {
    mkdirSync(join(fixture.root, 'extensions', 'notes'), { recursive: true });
    writeManifest(join(fixture.root, 'extensions', 'codex'), {
      version: 1,
      display: {
        icon: 'assets/codex.png',
        iconDark: 'assets/codex-dark.png',
        title: 'Codex Mobile',
      },
      id: 'codex',
      name: 'Codex',
      launchers: [
        {
          id: 'new-chat',
          icon: 'assets/launcher.png',
          label: 'New Chat',
          route: {
            kind: 'launch',
            launch: 'new-chat',
            resourceKind: 'draft',
          },
          view: 'main',
        },
      ],
      fileHandlers: [
        {
          id: 'text',
          extensions: ['md', 'TXT'],
          label: 'Text',
          view: 'main',
        },
      ],
      server: {
        transport: 'stdio',
        command: 'node',
        args: ['server.cjs'],
        cwd: '.',
      },
      views: {
        main: {
          route: '/viewers/codex/',
          entry: 'viewer/dist/index.html',
        },
      },
    });

    const extensions = discoverExtensions({ rootDir: fixture.root });

    assert.deepEqual(extensions.map((extension) => extension.id), ['codex']);
    assert.deepEqual(extensions[0].display, {
      icon: join(fixture.root, 'extensions', 'codex', 'assets/codex.png'),
      iconDark: join(fixture.root, 'extensions', 'codex', 'assets/codex-dark.png'),
      title: 'Codex Mobile',
    });
    assert.equal(extensions[0].name, 'Codex');
    assert.equal(extensions[0].server.cwd, join(fixture.root, 'extensions', 'codex'));
    assert.deepEqual(extensions[0].server.args, ['server.cjs']);
    assert.equal(extensions[0].views.main.route, '/viewers/codex');
    assert.equal(extensions[0].views.main.entry, join(fixture.root, 'extensions', 'codex', 'viewer/dist/index.html'));
    assert.deepEqual(extensions[0].launchers, [
      {
        // Own icon: display.iconDark must NOT be inherited as its dark variant.
        icon: join(fixture.root, 'extensions', 'codex', 'assets/launcher.png'),
        iconDark: null,
        id: 'new-chat',
        label: 'New Chat',
        route: {
          kind: 'launch',
          launch: 'new-chat',
          resourceKind: 'draft',
        },
        view: 'main',
        viewRoute: '/viewers/codex',
      },
    ]);
    assert.deepEqual(extensions[0].fileHandlers, [
      {
        extensions: ['md', 'txt'],
        // No own icon: inherits the display icon/iconDark pair.
        icon: join(fixture.root, 'extensions', 'codex', 'assets/codex.png'),
        iconDark: join(fixture.root, 'extensions', 'codex', 'assets/codex-dark.png'),
        id: 'text',
        label: 'Text',
        view: 'main',
        viewRoute: '/viewers/codex',
      },
    ]);
  } finally {
    fixture.cleanup();
  }
});

test('discoverExtensions can read extension roots from REMUX_EXTENSION_ROOTS', () => {
  const fixture = createRegistryFixture();

  try {
    const firstRoot = join(fixture.root, 'one');
    const secondRoot = join(fixture.root, 'two');
    writeManifest(join(firstRoot, 'beta'), validManifest({ id: 'beta' }));
    writeManifest(join(secondRoot, 'alpha'), validManifest({ id: 'alpha' }));

    const extensions = discoverExtensions({
      env: {
        REMUX_EXTENSION_ROOTS: `${firstRoot}${delimiter}${secondRoot}`,
      },
      rootDir: fixture.root,
    });

    assert.deepEqual(extensions.map((extension) => extension.id), ['alpha', 'beta']);
    assert.deepEqual(extensionRoots({
      env: {
        REMUX_EXTENSION_ROOTS: `${firstRoot}${delimiter}${secondRoot}`,
      },
      rootDir: fixture.root,
    }), [firstRoot, secondRoot]);
  } finally {
    fixture.cleanup();
  }
});

test('loadExtensionManifest defaults route, name, and optional arrays', () => {
  const fixture = createRegistryFixture();

  try {
    const extensionDir = join(fixture.root, 'extensions', 'files');
    writeManifest(extensionDir, {
      version: 1,
      id: 'files',
      views: {
        main: {
          entry: 'viewer/dist/index.html',
        },
      },
    });

    const extension = loadExtensionManifest(join(extensionDir, 'remux-extension.json'));

    assert.equal(extension.name, 'files');
    assert.deepEqual(extension.display, {
      icon: null,
      iconDark: null,
      title: 'files',
    });
    assert.equal(extension.views.main.route, '/viewers/files');
    assert.equal(extension.server, null);
    assert.deepEqual(extension.launchers, []);
    assert.deepEqual(extension.fileHandlers, []);
  } finally {
    fixture.cleanup();
  }
});

test('validateManifest rejects invalid manifests', () => {
  assert.throws(
    () => validateManifest(null, '/tmp/bad'),
    /manifest must be an object/u,
  );

  assert.throws(
    () => validateManifest({ id: '', version: 1, server: {}, views: {} }, '/tmp/bad'),
    /id must be a non-empty string/u,
  );

  assert.throws(
    () => validateManifest({
      id: 'bad',
      views: { main: { entry: 'index.html' } },
    }),
    /version must be 1/u,
  );

  assert.throws(
    () => validateManifest({
      version: 1,
      id: 'bad',
      server: { transport: 'http', command: 'node' },
      views: { main: { entry: 'index.html' } },
    }),
    /server\.transport must be stdio/u,
  );

  assert.throws(
    () => validateManifest({
      version: 1,
      id: 'bad',
      server: { transport: 'stdio', command: 'node' },
      views: { main: { route: 'viewers/bad', entry: 'index.html' } },
    }),
    /views\.main\.route must start with \//u,
  );

  assert.throws(
    () => validateManifest({
      version: 1,
      id: 'bad',
      server: { transport: 'stdio', command: 'node' },
      views: { main: { entry: 'index.html', dev: { command: 'npm', url: '' } } },
    }),
    /views\.main\.dev is not supported/u,
  );

  assert.throws(
    () => validateManifest({
      version: 1,
      display: { icon: '' },
      id: 'bad',
      server: { transport: 'stdio', command: 'node' },
      views: { main: { entry: 'index.html' } },
    }),
    /display\.icon must be a non-empty string/u,
  );

  assert.throws(
    () => validateManifest({
      version: 1,
      display: { icon: 'assets/icon.svg' },
      id: 'bad',
      server: { transport: 'stdio', command: 'node' },
      views: { main: { entry: 'index.html' } },
    }),
    /display\.icon must be a raster image/u,
  );

  assert.throws(
    () => validateManifest({
      version: 1,
      display: { iconDark: 'assets/icon-dark.png' },
      id: 'bad',
      server: { transport: 'stdio', command: 'node' },
      views: { main: { entry: 'index.html' } },
    }),
    /display\.iconDark requires display\.icon/u,
  );

  assert.throws(
    () => validateManifest({
      version: 1,
      id: 'bad',
      launchers: [
        { id: 'go', icon: 'assets/icon.png', iconDark: 'assets/icon-dark.svg', view: 'main' },
      ],
      server: { transport: 'stdio', command: 'node' },
      views: { main: { entry: 'index.html' } },
    }),
    /launchers\.iconDark must be a raster image/u,
  );

  assert.throws(
    () => validateManifest({
      version: 1,
      id: 'bad',
      launchers: [
        { id: 'go', iconDark: 'assets/icon-dark.png', view: 'main' },
      ],
      server: { transport: 'stdio', command: 'node' },
      views: { main: { entry: 'index.html' } },
    }),
    /launchers\.iconDark requires launchers\.icon/u,
  );
});

function validManifest({ id }) {
  return {
    version: 1,
    id,
    views: {
      main: {
        entry: 'viewer/dist/index.html',
      },
    },
  };
}

function writeManifest(extensionDir, manifest) {
  mkdirSync(extensionDir, { recursive: true });
  writeFileSync(
    join(extensionDir, 'remux-extension.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

function createRegistryFixture() {
  const root = mkdtempSync(join(tmpdir(), 'remux-registry-'));
  mkdirSync(join(root, 'extensions'), { recursive: true });

  return {
    cleanup() {
      rmSync(root, { force: true, recursive: true });
    },
    root,
  };
}
