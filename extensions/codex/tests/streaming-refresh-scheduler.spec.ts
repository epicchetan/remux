import { expect, test } from '@playwright/test';

import {
  StreamingRefreshScheduler,
  type StreamingRefreshSchedulerClock,
} from '../viewer/transcript/streamingRefreshScheduler';
import { partitionStreamingTranscriptInvalidations } from '../viewer/transcript/streamingRefreshPolicy';

type Refresh = {
  key: string;
  revision: number;
};

test.describe('streaming refresh scheduler', () => {
  test('coalesces assistant resources without delaying unrelated work items', () => {
    const turn = turnInvalidation('turn-1');
    const assistantWorkItem = workItemInvalidation('turn-1', 'assistant-1');
    const toolWorkItem = workItemInvalidation('turn-2', 'tool-1');

    expect(partitionStreamingTranscriptInvalidations({
      shouldRefreshTranscript: false,
      turnInvalidations: [turn],
      workItemInvalidations: [assistantWorkItem, toolWorkItem],
    })).toEqual({
      immediateWorkItemInvalidations: [toolWorkItem],
      streamingInvalidations: [turn, assistantWorkItem],
    });
  });

  test('keeps structural completion refresh work immediate', () => {
    const turn = turnInvalidation('turn-1');
    const assistantWorkItem = workItemInvalidation('turn-1', 'assistant-1');

    expect(partitionStreamingTranscriptInvalidations({
      shouldRefreshTranscript: true,
      turnInvalidations: [turn],
      workItemInvalidations: [assistantWorkItem],
    })).toEqual({
      immediateWorkItemInvalidations: [assistantWorkItem],
      streamingInvalidations: [],
    });
  });

  test('runs the leading refresh immediately then publishes latest values at the cadence', async () => {
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
    expect(runs).toEqual([[{ key: 'turn-1', revision: 1 }]]);
    await flushPromises();

    scheduler.enqueue([{ key: 'turn-1', revision: 2 }]);
    scheduler.enqueue([
      { key: 'turn-1', revision: 3 },
      { key: 'turn-2', revision: 1 },
    ]);
    clock.advanceBy(124);
    expect(runs).toHaveLength(1);

    clock.advanceBy(1);
    expect(runs[1]).toEqual([
      { key: 'turn-1', revision: 3 },
      { key: 'turn-2', revision: 1 },
    ]);
  });

  test('never overlaps refreshes and catches up with one latest batch', async () => {
    const clock = new ManualClock();
    const runs: Refresh[][] = [];
    let finishFirstRun!: () => void;
    const firstRun = new Promise<void>((resolve) => {
      finishFirstRun = resolve;
    });
    const scheduler = new StreamingRefreshScheduler<Refresh>({
      cadenceMs: 125,
      clock,
      key: (refresh) => refresh.key,
      run: (refreshes) => {
        runs.push(refreshes);
        return runs.length === 1 ? firstRun : undefined;
      },
    });

    scheduler.enqueue([{ key: 'turn-1', revision: 1 }]);
    scheduler.enqueue([{ key: 'turn-1', revision: 2 }]);
    scheduler.enqueue([{ key: 'turn-1', revision: 3 }]);
    clock.advanceBy(500);
    expect(runs).toEqual([[{ key: 'turn-1', revision: 1 }]]);

    finishFirstRun();
    await flushPromises();
    expect(runs).toEqual([
      [{ key: 'turn-1', revision: 1 }],
      [{ key: 'turn-1', revision: 3 }],
    ]);
  });

  test('cancels obsolete pending work and resets the leading cadence', async () => {
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
    scheduler.cancelPending();
    clock.advanceBy(125);
    expect(runs).toHaveLength(1);

    scheduler.enqueue([{ key: 'turn-2', revision: 1 }]);
    expect(runs).toEqual([
      [{ key: 'turn-1', revision: 1 }],
      [{ key: 'turn-2', revision: 1 }],
    ]);
  });
});

class ManualClock implements StreamingRefreshSchedulerClock {
  private currentTime = 0;
  private nextTimer = 1;
  private readonly timers = new Map<number, { callback: () => void; dueAt: number }>();

  clearTimer(timer: number) {
    this.timers.delete(timer);
  }

  now() {
    return this.currentTime;
  }

  setTimer(callback: () => void, delayMs: number) {
    const timer = this.nextTimer;
    this.nextTimer += 1;
    this.timers.set(timer, {
      callback,
      dueAt: this.currentTime + delayMs,
    });
    return timer;
  }

  advanceBy(durationMs: number) {
    this.currentTime += durationMs;
    while (true) {
      const dueTimer = Array.from(this.timers.entries())
        .filter(([, timer]) => timer.dueAt <= this.currentTime)
        .sort((left, right) => left[1].dueAt - right[1].dueAt)[0];
      if (!dueTimer) {
        return;
      }

      this.timers.delete(dueTimer[0]);
      dueTimer[1].callback();
    }
  }
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function turnInvalidation(turnId: string) {
  return {
    key: `turn:thread-1:${turnId}`,
    reason: 'appServerEvent' as const,
    threadId: 'thread-1',
    turnId,
    type: 'turn' as const,
  };
}

function workItemInvalidation(turnId: string, itemId: string) {
  return {
    itemId,
    key: `workItem:thread-1:${turnId}:${itemId}`,
    reason: 'appServerEvent' as const,
    threadId: 'thread-1',
    turnId,
    type: 'workItem' as const,
  };
}
