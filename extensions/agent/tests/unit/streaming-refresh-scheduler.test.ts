import assert from 'node:assert/strict';
import { test } from '@playwright/test';

import type { AgentResourceInvalidation } from '../../shared/transcript.ts';
import { NATIVE_AGENT_PROTOCOL_VERSION } from '../../shared/native-agent-protocol.ts';
import { parseAgentInvalidationEnvelope } from '../../viewer/src/ipc/resourceInvalidations.ts';
import { partitionStreamingTranscriptInvalidations } from '../../viewer/src/transcript/streamingRefreshPolicy.ts';
import {
  StreamingRefreshScheduler,
  type StreamingRefreshSchedulerClock,
} from '../../viewer/src/transcript/streamingRefreshScheduler.ts';

test('partitions structural and cadence-limited transcript invalidations', () => {
  const streaming = transcriptInvalidation('runtimeEvent', false);
  const structural = transcriptInvalidation('sendAccepted', true);
  const scope: AgentResourceInvalidation = {
    type: 'executionScope',
    key: 'executionScope:conversation:turn:scope',
    conversationId: 'conversation',
    turnId: 'turn',
    scopeId: 'scope',
    reason: 'runtimeEvent',
    affectsLayout: true,
    basisSequence: 1,
  };

  assert.deepEqual(
    partitionStreamingTranscriptInvalidations([streaming, structural, scope]),
    {
      immediateInvalidations: [structural, scope],
      streamingInvalidations: [streaming],
    },
  );
});

test('accepts only versioned native resource invalidations', () => {
  assert.deepEqual(parseAgentInvalidationEnvelope({
    protocolVersion: NATIVE_AGENT_PROTOCOL_VERSION,
    basisSequence: 4,
    keys: ['agent/transcript:conversation:tail-24'],
    serverGeneration: 'generation-v2',
  }), {
    protocolVersion: NATIVE_AGENT_PROTOCOL_VERSION,
    basisSequence: 4,
    keys: ['agent/transcript:conversation:tail-24'],
    serverGeneration: 'generation-v2',
  });
  assert.deepEqual(parseAgentInvalidationEnvelope({
    protocolVersion: NATIVE_AGENT_PROTOCOL_VERSION,
    keys: ['agent/transcript:conversation:tail-24'],
    serverGeneration: 'generation-v2',
  }).keys, []);
  assert.deepEqual(parseAgentInvalidationEnvelope({
    protocolVersion: 1,
    basisSequence: 4,
    keys: ['agent/transcript:conversation:tail-24'],
    serverGeneration: 'generation-v1',
  }).keys, [], 'the V5 hard cut rejects legacy invalidations');
});

test('accepts native execution resource invalidations', () => {
  assert.deepEqual(parseAgentInvalidationEnvelope({
    protocolVersion: NATIVE_AGENT_PROTOCOL_VERSION,
    basisSequence: 7,
    keys: ['agent/execution:execution-1'],
    serverGeneration: 'generation-v2',
  }).keys, ['agent/execution:execution-1']);
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
): Extract<AgentResourceInvalidation, { type: 'transcript' }> {
  return {
    type: 'transcript',
    key: 'transcript:conversation',
    conversationId: 'conversation',
    turnId: 'turn',
    reason,
    affectsOrder,
    affectsLayout: true,
    basisSequence: 1,
  };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
