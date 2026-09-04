import assert from 'node:assert/strict';
import { test } from '@playwright/test';

import { ResourceRefreshQueue } from '../../viewer/src/app/resourceRefreshQueue.ts';

test('coalesces startup refreshes and never overlaps resource reads', async () => {
  const runs: Array<string[] | undefined> = [];
  const releases: Array<() => void> = [];
  let active = 0;
  let maxActive = 0;
  const queue = new ResourceRefreshQueue<string>(async (keys) => {
    runs.push(keys);
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise<void>((resolve) => releases.push(resolve));
    active -= 1;
  });

  const first = queue.enqueue(['providers']);
  const second = queue.enqueue(['runtime']);
  await flushPromises();
  assert.deepEqual(runs, [['providers', 'runtime']]);

  const third = queue.enqueue(['queue']);
  assert.equal(runs.length, 1);
  releases.shift()?.();
  await first;
  await second;
  await flushPromises();
  assert.deepEqual(runs, [['providers', 'runtime'], ['queue']]);
  releases.shift()?.();
  await third;
  assert.equal(maxActive, 1);
});

test('an all-resource refresh subsumes queued keyed refreshes', async () => {
  const runs: Array<string[] | undefined> = [];
  const queue = new ResourceRefreshQueue<string>(async (keys) => {
    runs.push(keys);
  });
  await Promise.all([
    queue.enqueue(['providers']),
    queue.enqueue(),
    queue.enqueue(['runtime']),
  ]);
  assert.deepEqual(runs, [undefined]);
});

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}
