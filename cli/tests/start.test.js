const assert = require('node:assert/strict');
const test = require('node:test');

const {
  bindDisplayUrl,
  defaultLaunchExtension,
  loadRuntimeValues,
} = require('../start.cjs');

test('loadRuntimeValues keeps dev defaults', () => {
  assert.deepEqual(loadRuntimeValues({}), {
    host: '0.0.0.0',
    port: 48123,
  });
});

test('loadRuntimeValues reads Remux host and port env values', () => {
  assert.deepEqual(loadRuntimeValues({
    REMUX_HOST: '127.0.0.1',
    REMUX_PORT: '5999',
  }), {
    host: '127.0.0.1',
    port: 5999,
  });
});

test('loadRuntimeValues rejects invalid ports', () => {
  assert.throws(
    () => loadRuntimeValues({ REMUX_PORT: 'nope' }),
    /Invalid REMUX_PORT value: nope/u,
  );
});

test('bindDisplayUrl formats wildcard and IPv6 hosts', () => {
  assert.equal(bindDisplayUrl('0.0.0.0', 48123), 'http://0.0.0.0:48123 (all IPv4 interfaces)');
  assert.equal(bindDisplayUrl('::', 48123), 'http://[::]:48123 (all IPv6 interfaces)');
  assert.equal(bindDisplayUrl('fd7a:115c:a1e0::1', 48123), 'http://[fd7a:115c:a1e0::1]:48123');
});

test('defaultLaunchExtension prefers extensions with launchers', () => {
  const editor = { id: 'editor', launchers: [] };
  const codex = { id: 'codex', launchers: [{ id: 'new-chat' }] };

  assert.equal(defaultLaunchExtension([editor, codex]), codex);
  assert.equal(defaultLaunchExtension([editor]), editor);
});
