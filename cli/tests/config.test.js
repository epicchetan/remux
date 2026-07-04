const assert = require('node:assert/strict');
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const test = require('node:test');

const {
  loadRemuxConfig,
  parseRemuxConfigToml,
  resolveExtensionRoots,
} = require('../config.cjs');

test('parseRemuxConfigToml reads runtime values and extension roots', () => {
  assert.deepEqual(parseRemuxConfigToml(`
host = "127.0.0.1"
port = 5999
extension_roots = ["extensions", "/home/ubuntu"]
`), {
    extensionRoots: ['extensions', '/home/ubuntu'],
    host: '127.0.0.1',
    port: 5999,
  });
});

test('parseRemuxConfigToml accepts camelCase extensionRoots', () => {
  assert.deepEqual(parseRemuxConfigToml('extensionRoots = ["extensions"]'), {
    extensionRoots: ['extensions'],
  });
});

test('parseRemuxConfigToml rejects unknown keys and sections', () => {
  assert.throws(
    () => parseRemuxConfigToml('extensions = []'),
    /unknown Remux config key extensions/u,
  );
  assert.throws(
    () => parseRemuxConfigToml('[runtime]\nport = 1'),
    /sections are not supported/u,
  );
});

test('loadRemuxConfig reads .remux/config.toml when present', () => {
  const root = mkdtempSync(join(tmpdir(), 'remux-config-'));

  try {
    mkdirSync(join(root, '.remux'), { recursive: true });
    writeFileSync(join(root, '.remux', 'config.toml'), 'port = 48124\n');

    assert.deepEqual(loadRemuxConfig({ rootDir: root }), { port: 48124 });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('resolveExtensionRoots resolves relative roots from runtime root', () => {
  assert.deepEqual(resolveExtensionRoots(['extensions', '/tmp/ext'], '/repo/remux'), [
    '/repo/remux/extensions',
    '/tmp/ext',
  ]);
});
