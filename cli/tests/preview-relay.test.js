const assert = require('node:assert/strict');
const test = require('node:test');

const { createPreviewRelay, previewInvalidateMethod } = require('../previewRelay.cjs');

function createHarness({ minIntervalMs } = {}) {
  const broadcasts = [];
  const warnings = [];
  const relay = createPreviewRelay({
    log: {
      log() {},
      warn(message) {
        warnings.push(message);
      },
    },
    ...(minIntervalMs === undefined ? {} : { minIntervalMs }),
  });

  return {
    broadcasts,
    relay,
    warnings,
    send(params) {
      return relay.handleExtensionNotification({
        broadcast: (message) => broadcasts.push(message),
        message: { method: previewInvalidateMethod, params },
      });
    },
  };
}

function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('preview relay ignores unrelated methods', () => {
  const { relay } = createHarness();

  try {
    const handled = relay.handleExtensionNotification({
      broadcast: () => assert.fail('must not broadcast'),
      message: { method: 'remux/notifications/request', params: {} },
    });
    assert.equal(handled, false);
  } finally {
    relay.close();
  }
});

test('preview relay broadcasts the first invalidation immediately', () => {
  const harness = createHarness();

  try {
    const handled = harness.send({
      extensionId: 'terminal',
      resourceId: 'session-1',
      resourceKind: 'terminalSession',
    });

    assert.equal(handled, true);
    assert.equal(harness.broadcasts.length, 1);
    assert.deepEqual(harness.broadcasts[0], {
      method: previewInvalidateMethod,
      params: {
        extensionId: 'terminal',
        resourceId: 'session-1',
        resourceKind: 'terminalSession',
      },
    });
  } finally {
    harness.relay.close();
  }
});

test('preview relay coalesces a burst into one trailing broadcast', async () => {
  const harness = createHarness({ minIntervalMs: 40 });

  try {
    for (let index = 0; index < 5; index += 1) {
      harness.send({
        extensionId: 'terminal',
        resourceId: 'session-1',
        resourceKind: 'terminalSession',
      });
    }

    assert.equal(harness.broadcasts.length, 1);
    await waitMs(80);
    assert.equal(harness.broadcasts.length, 2);
  } finally {
    harness.relay.close();
  }
});

test('preview relay rate-limits per resource, not globally', () => {
  const harness = createHarness();

  try {
    harness.send({ extensionId: 'terminal', resourceId: 'session-1', resourceKind: 'terminalSession' });
    harness.send({ extensionId: 'terminal', resourceId: 'session-2', resourceKind: 'terminalSession' });
    harness.send({ extensionId: 'codex', resourceId: 'thread-1', resourceKind: 'thread' });

    assert.equal(harness.broadcasts.length, 3);
  } finally {
    harness.relay.close();
  }
});

test('preview relay drops invalidations without an extension id', () => {
  const harness = createHarness();

  try {
    const handled = harness.send({ resourceId: 'session-1', resourceKind: 'terminalSession' });

    assert.equal(handled, true);
    assert.equal(harness.broadcasts.length, 0);
    assert.equal(harness.warnings.length, 1);
  } finally {
    harness.relay.close();
  }
});

test('preview relay trims params and omits empty resource fields', () => {
  const harness = createHarness();

  try {
    harness.send({ extensionId: '  codex  ', resourceId: '', resourceKind: null, viewId: 'main' });

    assert.equal(harness.broadcasts.length, 1);
    assert.deepEqual(harness.broadcasts[0].params, {
      extensionId: 'codex',
      viewId: 'main',
    });
  } finally {
    harness.relay.close();
  }
});

test('preview relay close cancels pending trailing broadcasts', async () => {
  const harness = createHarness({ minIntervalMs: 30 });

  try {
    harness.send({ extensionId: 'terminal', resourceId: 'session-1', resourceKind: 'terminalSession' });
    harness.send({ extensionId: 'terminal', resourceId: 'session-1', resourceKind: 'terminalSession' });
    assert.equal(harness.broadcasts.length, 1);
  } finally {
    harness.relay.close();
  }

  await waitMs(60);
  assert.equal(harness.broadcasts.length, 1);
});
