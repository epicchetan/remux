import assert from 'node:assert/strict';
import { test } from '@playwright/test';

import type { AgentResourceInvalidation } from '../../shared/transcript.ts';
import { partitionStreamingTranscriptInvalidations } from '../../viewer/src/transcript/streamingRefreshPolicy.ts';
import {
  StreamingRefreshScheduler,
  type StreamingRefreshSchedulerClock,
} from '../../viewer/src/transcript/streamingRefreshScheduler.ts';

test('partitions structural and cadence-limited transcript invalidations', () => {
  const streaming = transcriptInvalidation('runtimeEvent', false);
  const structural = transcriptInvalidation('sendAccepted', true);
  const group: AgentResourceInvalidation = {
    type: 'workGroup',
    key: 'workGroup:conversation:turn:segment:group',
    conversationId: 'conversation',
    turnId: 'turn',
    segmentId: 'segment',
    groupId: 'group',
    reason: 'runtimeEvent',
    affectsLayout: true,
  };

  assert.deepEqual(
    partitionStreamingTranscriptInvalidations([streaming, structural, group]),
    {
      immediateInvalidations: [structural, group],
      streamingInvalidations: [streaming],
    },
  );
});

test('publishes the leading refresh immediately and coalesces latest revisions', async () => {
  const clock = new ManualClock();
  const runs: Refresh[][] = [];
  const scheduler = new StreamingRefreshScheduler<Refresh>({
    cadenceMs: 125,
    clock,
    key: (refresh) => refresh.key,
    run: (refreshes) => {
      runs.push(refreshes);
    },
  });

  scheduler.enqueue([{ key: 'turn-1', revision: 1 }]);
  await flushPromises();
  scheduler.enqueue([{ key: 'turn-1', revision: 2 }]);
  scheduler.enqueue([{ key: 'turn-1', revision: 3 }, { key: 'turn-2', revision: 1 }]);
  clock.advanceBy(124);
  assert.equal(runs.length, 1);
  clock.advanceBy(1);
  assert.deepEqual(runs, [
    [{ key: 'turn-1', revision: 1 }],
    [{ key: 'turn-1', revision: 3 }, { key: 'turn-2', revision: 1 }],
  ]);
});

test('does not overlap refreshes and catches up with one latest batch', async () => {
  const clock = new ManualClock();
  const runs: Refresh[][] = [];
  let finish!: () => void;
  const first = new Promise<void>((resolve) => { finish = resolve; });
  const scheduler = new StreamingRefreshScheduler<Refresh>({
    cadenceMs: 125,
    clock,
    key: (refresh) => refresh.key,
    run: (refreshes) => {
      runs.push(refreshes);
      return runs.length === 1 ? first : undefined;
    },
  });

  scheduler.enqueue([{ key: 'turn', revision: 1 }]);
  scheduler.enqueue([{ key: 'turn', revision: 2 }]);
  scheduler.enqueue([{ key: 'turn', revision: 3 }]);
  clock.advanceBy(500);
  assert.equal(runs.length, 1);
  finish();
  await flushPromises();
  assert.deepEqual(runs.at(-1), [{ key: 'turn', revision: 3 }]);
});

type Refresh = { key: string; revision: number };

class ManualClock implements StreamingRefreshSchedulerClock {
  private nowMs = 0;
  private nextId = 1;
  private readonly timers = new Map<number, { callback: () => void; dueAt: number }>();

  clearTimer(timer: number) {
    this.timers.delete(timer);
  }

  now() {
    return this.nowMs;
  }

  setTimer(callback: () => void, delayMs: number) {
    const id = this.nextId++;
    this.timers.set(id, { callback, dueAt: this.nowMs + delayMs });
    return id;
  }

  advanceBy(durationMs: number) {
    this.nowMs += durationMs;
    while (true) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.dueAt <= this.nowMs)
        .sort((left, right) => left[1].dueAt - right[1].dueAt)[0];
      if (!due) return;
      this.timers.delete(due[0]);
      due[1].callback();
    }
  }
}

function transcriptInvalidation(
  reason: 'runtimeEvent' | 'sendAccepted',
  affectsOrder: boolean,
): AgentResourceInvalidation {
  return {
    type: 'transcript',
    key: 'transcript:conversation',
    conversationId: 'conversation',
    turnId: 'turn',
    reason,
    affectsOrder,
    affectsLayout: true,
  };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
