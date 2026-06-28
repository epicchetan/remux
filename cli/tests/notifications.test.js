const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const test = require('node:test');

const { createNotificationManager } = require('../notifications.cjs');

test('notification manager pushes turn completion to the originating client', async () => {
  const fixture = createNotificationFixture();
  const pushRequests = [];
  const manager = createNotificationManager({
    fetchImpl: async (url, request) => {
      pushRequests.push({ request, url });
      return jsonResponse({ data: { id: 'ticket-1', status: 'ok' } });
    },
    log: silentLog(),
    rootDir: fixture.root,
  });
  const client = createClient({ visible: false });

  try {
    await manager.handleClientRequest({
      client,
      method: 'remux/clients/register',
      params: {
        clientId: 'client-1',
        expoPushToken: 'ExponentPushToken[test]',
        sessionId: 'session-1',
      },
    });
    manager.recordClientRequest({
      client,
      request: { method: 'remux/codex/thread/message/send' },
      result: {
        threadId: 'thread-1',
        turnId: 'turn-1',
      },
    });

    assert.equal(await manager.handleExtensionNotification(turnCompletedIntent()), true);
    assert.equal(pushRequests.length, 1);
    assert.equal(pushRequests[0].url, 'https://exp.host/--/api/v2/push/send');
    assert.deepEqual(JSON.parse(pushRequests[0].request.body), {
      body: 'Open the thread to review the result.',
      data: {
        remuxNotificationIntent: {
          ...turnCompletedIntent().params,
          target: {
            ...turnCompletedIntent().params.target,
            handlerId: null,
            launch: null,
          },
        },
      },
      title: 'Codex finished',
      to: 'ExponentPushToken[test]',
    });
  } finally {
    fixture.cleanup();
  }
});

test('notification manager logs push body preview metadata', async () => {
  const fixture = createNotificationFixture();
  const events = [];
  const manager = createNotificationManager({
    fetchImpl: async () => jsonResponse({ data: { id: 'ticket-1', status: 'ok' } }),
    log: collectingLog(events),
    rootDir: fixture.root,
  });
  const client = createClient({ visible: false });

  try {
    await manager.handleClientRequest({
      client,
      method: 'remux/clients/register',
      params: {
        clientId: 'client-1',
        expoPushToken: 'ExponentPushToken[test]',
        sessionId: 'session-1',
      },
    });
    manager.recordClientRequest({
      client,
      request: { method: 'remux/codex/thread/message/send' },
      result: {
        threadId: 'thread-1',
        turnId: 'turn-1',
      },
    });

    assert.equal(await manager.handleExtensionNotification(turnCompletedIntent()), true);
    const sent = events.find((event) => event.label === 'notifications:push:sent');
    assert.equal(sent?.detail.intent.title, 'Codex finished');
    assert.equal(sent?.detail.intent.bodyPreview, 'Open the thread to review the result.');
    assert.equal(sent?.detail.intent.bodyLength, 37);
  } finally {
    fixture.cleanup();
  }
});

test('notification manager suppresses push when originating client is viewing target', async () => {
  const fixture = createNotificationFixture();
  const pushRequests = [];
  const manager = createNotificationManager({
    fetchImpl: async (url, request) => {
      pushRequests.push({ request, url });
      return jsonResponse({ data: { id: 'ticket-1', status: 'ok' } });
    },
    log: silentLog(),
    rootDir: fixture.root,
  });
  const client = createClient({ visible: true });

  try {
    await manager.handleClientRequest({
      client,
      method: 'remux/clients/register',
      params: {
        clientId: 'client-1',
        expoPushToken: 'ExponentPushToken[test]',
        sessionId: 'session-1',
      },
    });
    manager.recordClientRequest({
      client,
      request: { method: 'remux/codex/thread/message/send' },
      result: {
        threadId: 'thread-1',
        turnId: 'turn-1',
      },
    });

    assert.equal(await manager.handleExtensionNotification(turnCompletedIntent()), true);
    assert.equal(pushRequests.length, 0);
  } finally {
    fixture.cleanup();
  }
});

test('notification manager records edit and fork as turn notification audiences', async () => {
  for (const method of [
    'remux/codex/thread/message/edit',
    'remux/codex/thread/message/fork',
  ]) {
    const fixture = createNotificationFixture();
    const pushRequests = [];
    const manager = createNotificationManager({
      fetchImpl: async (url, request) => {
        pushRequests.push({ request, url });
        return jsonResponse({ data: { id: 'ticket-1', status: 'ok' } });
      },
      log: silentLog(),
      rootDir: fixture.root,
    });
    const client = createClient({ visible: false });

    try {
      await manager.handleClientRequest({
        client,
        method: 'remux/clients/register',
        params: {
          clientId: 'client-1',
          expoPushToken: 'ExponentPushToken[test]',
          sessionId: 'session-1',
        },
      });
      manager.recordClientRequest({
        client,
        request: { method },
        result: {
          threadId: 'thread-1',
          turnId: 'turn-1',
        },
      });

      assert.equal(await manager.handleExtensionNotification(turnCompletedIntent()), true);
      assert.equal(pushRequests.length, 1, `${method} should notify`);
    } finally {
      fixture.cleanup();
    }
  }
});

test('notification manager pushes compaction completion to the originating client', async () => {
  const fixture = createNotificationFixture();
  const pushRequests = [];
  const manager = createNotificationManager({
    fetchImpl: async (url, request) => {
      pushRequests.push({ request, url });
      return jsonResponse({ data: { id: 'ticket-1', status: 'ok' } });
    },
    log: silentLog(),
    rootDir: fixture.root,
  });
  const client = createClient({ visible: false });

  try {
    await manager.handleClientRequest({
      client,
      method: 'remux/clients/register',
      params: {
        clientId: 'client-1',
        expoPushToken: 'ExponentPushToken[test]',
        sessionId: 'session-1',
      },
    });
    manager.recordClientRequest({
      client,
      request: { method: 'remux/codex/thread/compact' },
      result: {
        threadId: 'thread-1',
      },
    });

    assert.equal(await manager.handleExtensionNotification(threadCompactedIntent()), true);
    assert.equal(pushRequests.length, 1);
    assert.deepEqual(JSON.parse(pushRequests[0].request.body), {
      body: 'Open the thread to continue.',
      data: {
        remuxNotificationIntent: {
          ...threadCompactedIntent().params,
          target: {
            ...threadCompactedIntent().params.target,
            handlerId: null,
            launch: null,
          },
        },
      },
      title: 'Codex compacted context',
      to: 'ExponentPushToken[test]',
    });
  } finally {
    fixture.cleanup();
  }
});

test('notification manager suppresses compaction push when originating client is viewing thread', async () => {
  const fixture = createNotificationFixture();
  const pushRequests = [];
  const manager = createNotificationManager({
    fetchImpl: async (url, request) => {
      pushRequests.push({ request, url });
      return jsonResponse({ data: { id: 'ticket-1', status: 'ok' } });
    },
    log: silentLog(),
    rootDir: fixture.root,
  });
  const client = createClient({ visible: true });

  try {
    await manager.handleClientRequest({
      client,
      method: 'remux/clients/register',
      params: {
        clientId: 'client-1',
        expoPushToken: 'ExponentPushToken[test]',
        sessionId: 'session-1',
      },
    });
    manager.recordClientRequest({
      client,
      request: { method: 'remux/codex/thread/compact' },
      result: {
        threadId: 'thread-1',
      },
    });

    assert.equal(await manager.handleExtensionNotification(threadCompactedIntent()), true);
    assert.equal(pushRequests.length, 0);
  } finally {
    fixture.cleanup();
  }
});

function turnCompletedIntent() {
  return {
    method: 'remux/notifications/request',
    params: {
      body: 'Open the thread to review the result.',
      extensionId: 'codex',
      id: 'codex:turn-completed:thread-1:turn-1',
      target: {
        focusId: 'turn-1',
        focusKind: 'turn',
        resourceId: 'thread-1',
        resourceKind: 'thread',
      },
      title: 'Codex finished',
      viewId: 'main',
    },
  };
}

function threadCompactedIntent() {
  return {
    method: 'remux/notifications/request',
    params: {
      body: 'Open the thread to continue.',
      extensionId: 'codex',
      id: 'codex:thread-compacted:thread-1',
      target: {
        focusId: 'thread-1',
        focusKind: 'thread',
        resourceId: 'thread-1',
        resourceKind: 'thread',
      },
      title: 'Codex compacted context',
      viewId: 'main',
    },
  };
}

function createClient({ visible }) {
  return {
    async request(method) {
      assert.equal(method, 'remux/notifications/visibility/check');
      return { visible };
    },
  };
}

function createNotificationFixture() {
  const root = mkdtempSync(join(tmpdir(), 'remux-notifications-'));
  return {
    cleanup() {
      rmSync(root, { force: true, recursive: true });
    },
    root,
  };
}

function jsonResponse(body) {
  return {
    async json() {
      return body;
    },
    ok: true,
    status: 200,
  };
}

function silentLog() {
  return {
    event() {},
  };
}

function collectingLog(events) {
  return {
    event(event) {
      events.push(event);
    },
  };
}
