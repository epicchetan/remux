const assert = require('node:assert/strict');
const { join } = require('node:path');
const test = require('node:test');

const {
  contentType,
  isViewerRequest,
  staticAssetPath,
} = require('../viewerProvider.cjs');

test('staticAssetPath serves the entry for the viewer route', () => {
  const entry = join('/tmp/remux/extensions/codex', 'viewer/dist/index.html');

  assert.equal(
    staticAssetPath({
      entry,
      requestUrl: '/viewers/codex/',
      route: '/viewers/codex',
    }),
    entry,
  );
});

test('staticAssetPath resolves assets under the built viewer directory', () => {
  const entry = join('/tmp/remux/extensions/codex', 'viewer/dist/index.html');

  assert.equal(
    staticAssetPath({
      entry,
      requestUrl: '/viewers/codex/assets/index.js',
      route: '/viewers/codex',
    }),
    join('/tmp/remux/extensions/codex', 'viewer/dist/assets/index.js'),
  );
});

test('staticAssetPath falls back to the entry on traversal attempts', () => {
  const entry = join('/tmp/remux/extensions/codex', 'viewer/dist/index.html');

  assert.equal(
    staticAssetPath({
      entry,
      requestUrl: '/viewers/codex/../../secret.txt',
      route: '/viewers/codex',
    }),
    entry,
  );
});

test('contentType maps common viewer assets', () => {
  assert.equal(contentType('/tmp/index.html'), 'text/html; charset=utf-8');
  assert.equal(contentType('/tmp/index.css'), 'text/css; charset=utf-8');
  assert.equal(contentType('/tmp/index.js'), 'text/javascript; charset=utf-8');
  assert.equal(contentType('/tmp/icon.svg'), 'image/svg+xml');
});

test('isViewerRequest matches only the mounted viewer route', () => {
  assert.equal(isViewerRequest('/viewers/codex', '/viewers/codex'), true);
  assert.equal(isViewerRequest('/viewers/codex', '/viewers/codex/asset.js'), true);
  assert.equal(isViewerRequest('/viewers/codex', '/viewers/editor'), false);
});
