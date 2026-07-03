const assert = require('node:assert/strict');
const test = require('node:test');

const { isPathWithin } = require('../core/fs.cjs');
const { createFsRelay, fsDidChangeMethod } = require('../fsRelay.cjs');

const silentLog = { error() {}, log() {}, warn() {} };

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function createWatchRegistry() {
  const watchers = new Map();

  return {
    emit(target, eventType = 'change', filename = null) {
      const entry = watchers.get(target);
      if (entry && !entry.closed) {
        entry.onEvent(eventType, filename);
      }
    },
    get(target) {
      return watchers.get(target);
    },
    watchPath(target, onEvent, onError) {
      const entry = { closed: false, onError, onEvent };
      watchers.set(target, entry);
      return {
        close() {
          entry.closed = true;
        },
      };
    },
  };
}

function createHarness({ relayOptions = {}, statusOutputs = [''] } = {}) {
  const registry = createWatchRegistry();
  const events = [];
  let statusCalls = 0;

  const relay = createFsRelay({
    debounceMs: 1,
    log: silentLog,
    minIntervalMs: 1,
    pollIntervalMs: 10_000,
    runGitStatus: async (repoRoot) => {
      statusCalls += 1;
      const output = statusOutputs[Math.min(statusCalls - 1, statusOutputs.length - 1)];
      events.push({ repoRoot, type: 'status' });
      return output;
    },
    watchPath: registry.watchPath,
    ...relayOptions,
  });

  relay.start({
    broadcast: (message) => {
      events.push({ message, type: 'broadcast' });
    },
    fs: {
      invalidate: (target) => {
        events.push({ target, type: 'invalidate' });
      },
    },
  });

  return {
    broadcasts: () => events.filter((event) => event.type === 'broadcast').map((event) => event.message),
    events,
    registry,
    relay,
    statusCalls: () => statusCalls,
  };
}

test('fs relay broadcasts served-directory events with repo rollup and invalidates first', async () => {
  const harness = createHarness();
  harness.relay.onDirectoryServed({ path: '/repo/src', repoRoot: '/repo', type: 'directoryServed' });

  harness.registry.emit('/repo/src');
  await delay(30);

  const broadcasts = harness.broadcasts();
  assert.equal(broadcasts.length, 1);
  assert.equal(broadcasts[0].method, fsDidChangeMethod);
  assert.deepEqual(broadcasts[0].params, {
    changedPaths: ['/repo/src'],
    gitDirtyRoots: ['/repo'],
  });

  const kinds = harness.events.map((event) => event.type);
  const invalidateIndex = kinds.indexOf('invalidate');
  const broadcastIndex = kinds.indexOf('broadcast');
  assert.ok(invalidateIndex >= 0 && invalidateIndex < broadcastIndex, 'invalidate must precede broadcast');
  assert.deepEqual(harness.events[invalidateIndex].target, {
    paths: ['/repo/src'],
    underRoots: ['/repo'],
  });

  harness.relay.close();
});

test('fs relay throttles broadcasts with a merged trailing send', async () => {
  const harness = createHarness({ relayOptions: { minIntervalMs: 60 } });
  harness.relay.onDirectoryServed({ path: '/repo/a', repoRoot: null, type: 'directoryServed' });
  harness.relay.onDirectoryServed({ path: '/repo/b', repoRoot: null, type: 'directoryServed' });

  harness.registry.emit('/repo/a');
  await delay(20);
  assert.equal(harness.broadcasts().length, 1);

  harness.registry.emit('/repo/a');
  harness.registry.emit('/repo/b');
  await delay(20);
  assert.equal(harness.broadcasts().length, 1, 'second burst is throttled');

  await delay(80);
  const broadcasts = harness.broadcasts();
  assert.equal(broadcasts.length, 2, 'trailing send fires after the interval');
  assert.deepEqual(broadcasts[1].params.changedPaths, ['/repo/a', '/repo/b']);

  harness.relay.close();
});

test('fs relay evicts the least-recently-touched directory watcher over the cap', async () => {
  const harness = createHarness({ relayOptions: { maxWatchedDirectories: 2 } });
  harness.relay.onDirectoryServed({ path: '/d1', repoRoot: null, type: 'directoryServed' });
  await delay(2);
  harness.relay.onDirectoryServed({ path: '/d2', repoRoot: null, type: 'directoryServed' });
  await delay(2);
  harness.relay.onDirectoryServed({ path: '/d3', repoRoot: null, type: 'directoryServed' });

  assert.equal(harness.registry.get('/d1').closed, true, 'oldest watcher evicted');
  assert.equal(harness.registry.get('/d2').closed, false);
  assert.equal(harness.registry.get('/d3').closed, false);

  harness.relay.close();
});

test('fs relay maps .git HEAD/index events to gitDirtyRoots only, after a status confirm', async () => {
  const harness = createHarness({ statusOutputs: [' M src/a.ts\0', ''] });
  harness.relay.onDirectoryServed({ path: '/repo', repoRoot: '/repo', type: 'directoryServed' });
  await delay(10);
  assert.equal(harness.statusCalls(), 1, 'baseline is seeded at registration');

  harness.registry.emit('/repo/.git', 'change', 'index.lock');
  await delay(30);
  assert.equal(harness.broadcasts().length, 0, 'index.lock churn is ignored');

  harness.registry.emit('/repo/.git', 'change', 'HEAD');
  await delay(30);

  const broadcasts = harness.broadcasts();
  assert.equal(broadcasts.length, 1);
  assert.deepEqual(broadcasts[0].params, {
    changedPaths: [],
    gitDirtyRoots: ['/repo'],
  });

  harness.relay.close();
});

test('fs relay .git confirm stays silent when the status snapshot is unchanged', async () => {
  const harness = createHarness({ statusOutputs: [' M src/a.ts\0'] });
  harness.relay.onDirectoryServed({ path: '/repo', repoRoot: '/repo', type: 'directoryServed' });
  await delay(10);

  harness.registry.emit('/repo/.git', 'change', 'HEAD');
  await delay(30);
  assert.equal(harness.broadcasts().length, 0, 'snapshot matches the seeded baseline');

  harness.registry.emit('/repo/.git', 'change', 'HEAD');
  await delay(30);
  assert.equal(harness.broadcasts().length, 0, 'unchanged snapshot never emits');

  harness.relay.close();
});

test('fs relay poller is gated on connected clients and diffs snapshots into changed directories', async () => {
  const harness = createHarness({
    relayOptions: { pollIntervalMs: 10 },
    statusOutputs: [
      '?? src/new.ts\0',
      '?? src/new.ts\0 M lib/util.js\0',
    ],
  });
  harness.relay.onDirectoryServed({ path: '/repo', repoRoot: '/repo', type: 'directoryServed' });

  await delay(40);
  assert.equal(harness.statusCalls(), 1, 'only the baseline seed runs with zero clients');

  harness.relay.onClientCountChanged(1);
  await delay(60);

  const broadcasts = harness.broadcasts();
  assert.ok(harness.statusCalls() >= 2, 'poller runs while a client is connected');
  assert.equal(broadcasts.length, 1, 'only the diff against the seeded baseline emits');
  assert.deepEqual(broadcasts[0].params, {
    changedPaths: ['/repo/lib'],
    gitDirtyRoots: ['/repo'],
  });

  harness.relay.close();
});

test('fs relay close is idempotent and silences all layers', async () => {
  const harness = createHarness();
  harness.relay.onDirectoryServed({ path: '/repo/src', repoRoot: '/repo', type: 'directoryServed' });
  harness.relay.onClientCountChanged(1);

  harness.relay.close();
  harness.relay.close();

  harness.registry.emit('/repo/src');
  harness.registry.emit('/repo/.git', 'change', 'HEAD');
  await delay(30);

  assert.equal(harness.broadcasts().length, 0);
  assert.equal(harness.registry.get('/repo/src').closed, true);
});

test('isPathWithin includes the root itself and respects path boundaries', () => {
  assert.equal(isPathWithin('/repo', '/repo'), true);
  assert.equal(isPathWithin('/repo', '/repo/src/deep'), true);
  assert.equal(isPathWithin('/repo', '/repo2'), false);
  assert.equal(isPathWithin('/repo/src', '/repo'), false);
});
