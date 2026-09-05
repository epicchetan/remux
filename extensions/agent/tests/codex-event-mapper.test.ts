import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CodexEventMapper,
  normalizeCodexAccountUsage,
} from '../server/src/providers/codex/codex-event-mapper.ts';
import { jsonPreviewByteLength } from '../server/src/providers/preview.ts';
import { PROVIDER_RUNTIME_LIMITS } from '../shared/provider-runtime.ts';

const ROOT_THREAD = 'codex-thread-root';
const NATIVE_TURN = 'codex-turn-native-1';

function mapper(options: {
  observedAt?: () => number;
  executionId?: string;
  nativeSessionId?: string;
  inheritedNativeTurnIds?: readonly string[];
} = {}) {
  return new CodexEventMapper({
    providerInstanceId: 'codex-local',
    conversationId: 'conversation-1',
    executionId: options.executionId ?? 'execution-1',
    nativeSessionId: options.nativeSessionId ?? ROOT_THREAD,
    inheritedNativeTurnIds: options.inheritedNativeTurnIds,
    observedAt: options.observedAt ?? (() => 42),
  });
}

test('Codex live item events reconcile by native identity with a later thread snapshot', () => {
  const subject = mapper();
  subject.expectTurn('remux-turn-1');
  const started = subject.mapNotification({
    method: 'turn/started',
    params: {
      threadId: ROOT_THREAD,
      turn: { id: NATIVE_TURN, status: 'inProgress', items: [] },
    },
  });
  assert.equal(started[0]?.scope.kind, 'turn');
  if (started[0]?.scope.kind === 'turn') assert.equal(started[0].scope.turnId, 'remux-turn-1');
  assert.equal(started[0]?.native.turnId, NATIVE_TURN);

  const live = subject.mapNotification({
    method: 'item/completed',
    params: {
      threadId: ROOT_THREAD,
      turnId: NATIVE_TURN,
      item: {
        id: 'assistant-1',
        type: 'agentMessage',
        phase: 'final_answer',
        text: 'Implemented.',
      },
    },
  });
  const snapshot = subject.mapThreadSnapshot({
    id: ROOT_THREAD,
    status: { type: 'idle' },
    turns: [{
      id: NATIVE_TURN,
      status: 'completed',
      items: [{
        id: 'assistant-1',
        type: 'agentMessage',
        phase: 'final_answer',
        text: 'Implemented.',
      }],
    }],
  });

  const liveAssistant = live.find(({ event }) => event.type === 'turn.block.completed' &&
    event.block.kind === 'final-message');
  const snapshotAssistant = snapshot.find(({ event }) => event.type === 'turn.block.completed' &&
    event.block.kind === 'final-message');
  assert.ok(liveAssistant);
  assert.ok(snapshotAssistant);
  assert.equal(liveAssistant.eventId, snapshotAssistant.eventId);
  assert.equal(snapshotAssistant.scope.kind, 'turn');
  if (snapshotAssistant.scope.kind === 'turn') {
    assert.equal(snapshotAssistant.scope.turnId, 'remux-turn-1');
  }
  assert.ok(snapshot.some(({ event }) =>
    event.type === 'turn.completed' && event.outcome === 'completed'));
});

test('Codex resumed live blocks start after the durable journal ordinal floor', () => {
  const subject = mapper();
  subject.bindTurn('remux-turn-1', NATIVE_TURN, 12);
  subject.mapThreadSnapshot({
    id: ROOT_THREAD,
    status: { type: 'active' },
    turns: [{
      id: NATIVE_TURN,
      status: 'inProgress',
      items: [{
        id: 'reasoning-before-restart', type: 'reasoning', summary: ['Before restart.'],
      }],
    }],
  });

  const [live] = subject.mapNotification({
    method: 'item/started',
    params: {
      threadId: ROOT_THREAD,
      turnId: NATIVE_TURN,
      item: {
        id: 'command-after-restart', type: 'commandExecution', status: 'inProgress',
        command: 'git status --short', cwd: '/workspace/remux',
      },
    },
  });
  assert.equal(live?.event.type, 'turn.block.started');
  if (live?.event.type === 'turn.block.started') {
    assert.equal(live.event.structure.blockOrdinal, 12);
  }
});

test('Codex deltas remain ordered and resume from the authoritative snapshot offset', () => {
  const subject = mapper();
  subject.bindTurn('remux-turn-1', NATIVE_TURN);
  assert.deepEqual(subject.mapNotification({
    method: 'item/started',
    params: {
      threadId: ROOT_THREAD,
      turnId: NATIVE_TURN,
      item: { id: 'assistant-1', type: 'agentMessage', phase: 'final_answer', text: '' },
    },
  }), []);
  const first = subject.mapNotification({
    method: 'item/agentMessage/delta',
    params: { threadId: ROOT_THREAD, turnId: NATIVE_TURN, itemId: 'assistant-1', delta: 'Hel' },
  })[0];
  const second = subject.mapNotification({
    method: 'item/agentMessage/delta',
    params: { threadId: ROOT_THREAD, turnId: NATIVE_TURN, itemId: 'assistant-1', delta: 'lo' },
  })[0];
  const completed = subject.mapNotification({
    method: 'item/completed',
    params: {
      threadId: ROOT_THREAD,
      turnId: NATIVE_TURN,
      item: { id: 'assistant-1', type: 'agentMessage', phase: 'final_answer', text: 'Hello' },
    },
  })[0];

  assert.ok(first && second && completed);
  assert.notEqual(first.eventId, second.eventId);
  assert.notEqual(second.eventId, completed.eventId);
  assert.equal(first.event.type, 'turn.block.started');
  assert.equal(second.event.type, 'turn.block.revised');
  if (first.event.type === 'turn.block.started') {
    assert.equal(first.event.block.payload.kind, 'final-message');
  }
  if (first.event.type === 'turn.block.started' && first.event.block.payload.kind === 'final-message') {
    assert.equal(first.event.block.payload.text, 'Hel');
  }
  if (second.event.type === 'turn.block.revised' && second.event.block.payload.kind === 'final-message') {
    assert.equal(second.event.block.payload.text, 'Hello');
  }
  assert.deepEqual(first.native.position, { kind: 'native-sequence', sequence: 1, subIndex: 0 });
  assert.deepEqual(second.native.position, { kind: 'native-sequence', sequence: 2, subIndex: 0 });

  const resumed = mapper();
  resumed.bindTurn('remux-turn-1', NATIVE_TURN);
  resumed.mapThreadSnapshot({
    id: ROOT_THREAD,
    status: { type: 'active' },
    turns: [{
      id: NATIVE_TURN,
      status: 'inProgress',
      items: [{ id: 'assistant-1', type: 'agentMessage', phase: 'final_answer', text: 'Hello' }],
    }],
  });
  const continued = resumed.mapNotification({
    method: 'item/agentMessage/delta',
    params: { threadId: ROOT_THREAD, turnId: NATIVE_TURN, itemId: 'assistant-1', delta: 'Hel' },
  })[0];
  const replayed = mapper();
  replayed.bindTurn('remux-turn-1', NATIVE_TURN);
  replayed.mapThreadSnapshot({
    id: ROOT_THREAD,
    status: { type: 'active' },
    turns: [{
      id: NATIVE_TURN,
      status: 'inProgress',
      items: [{ id: 'assistant-1', type: 'agentMessage', phase: 'final_answer', text: 'Hello' }],
    }],
  });
  const continuedReplay = replayed.mapNotification({
    method: 'item/agentMessage/delta',
    params: { threadId: ROOT_THREAD, turnId: NATIVE_TURN, itemId: 'assistant-1', delta: 'Hel' },
  })[0];
  assert.ok(continued && continuedReplay);
  assert.notEqual(continued.eventId, first.eventId,
    'a post-restart delta cannot collide with the same content at the old zero offset');
  assert.equal(continuedReplay.eventId, continued.eventId,
    'replaying the same snapshot and continuation keeps a stable event ID');
});

test('Codex command output remains byte-bounded without poisoning mapper block state', () => {
  const subject = mapper();
  subject.bindTurn('remux-turn-1', NATIVE_TURN);
  const [started] = subject.mapNotification({
    method: 'item/started',
    params: {
      threadId: ROOT_THREAD,
      turnId: NATIVE_TURN,
      item: {
        id: 'command-1',
        type: 'commandExecution',
        command: 'npm run build:viewer',
        cwd: '/workspace/remux',
        status: 'inProgress',
      },
    },
  });
  assert.equal(started?.event.type, 'turn.block.started');

  let latest = started;
  for (let index = 0; index < 1_024; index += 1) {
    [latest] = subject.mapNotification({
      method: 'item/commandExecution/outputDelta',
      params: {
        threadId: ROOT_THREAD,
        turnId: NATIVE_TURN,
        itemId: 'command-1',
        delta: `${index}:\u001b[2K\r${'"😀"'.repeat(128)}${'x'.repeat(768)}\n`,
      },
    });
    assert.ok(latest);
    if (latest.event.type === 'turn.block.revised') {
      assert.ok(jsonPreviewByteLength(latest.event.block.payload.kind === 'tool'
        ? latest.event.block.payload.outputPreview
        : null) <= PROVIDER_RUNTIME_LIMITS.previewBytes);
    }
  }
  assert.equal(latest?.event.type, 'turn.block.revised');
  if (latest?.event.type === 'turn.block.revised' && latest.event.block.payload.kind === 'tool') {
    const output = latest.event.block.payload.outputPreview;
    assert.ok(output && typeof output === 'object' && !Array.isArray(output));
    const outputRecord = output as { readonly delta?: unknown };
    assert.match(String(outputRecord.delta), /1023:/u);
  }

  const authoritativeOutput = `${'snapshot-start\n'}${'z'.repeat(150_000)}\nSNAPSHOT_TAIL`;
  const reconciled = subject.mapNotification({
    method: 'item/completed',
    params: {
      threadId: ROOT_THREAD,
      turnId: NATIVE_TURN,
      item: {
        id: 'command-1',
        type: 'commandExecution',
        command: 'npm run build:viewer',
        cwd: '/workspace/remux',
        status: 'completed',
        aggregatedOutput: authoritativeOutput,
      },
    },
  });
  const terminal = reconciled.at(-1);
  assert.equal(terminal?.event.type, 'turn.block.completed');
  if (terminal?.event.type === 'turn.block.completed' && terminal.event.block.payload.kind === 'tool') {
    const output = terminal.event.block.payload.outputPreview;
    assert.ok(jsonPreviewByteLength(output) <= PROVIDER_RUNTIME_LIMITS.previewBytes);
    assert.ok(output && typeof output === 'object' && !Array.isArray(output));
    const outputRecord = output as { readonly delta?: unknown };
    assert.match(String(outputRecord.delta), /output truncated/u);
    assert.match(String(outputRecord.delta), /SNAPSHOT_TAIL$/u);
    assert.doesNotMatch(String(outputRecord.delta), /1023:/u,
      'the authoritative aggregate replaces, rather than duplicates, streamed output');
  }

  assert.throws(() => subject.mapNotification({
    method: 'item/reasoning/summaryTextDelta',
    params: {
      threadId: ROOT_THREAD,
      turnId: NATIVE_TURN,
      itemId: 'invalid-reasoning',
      summaryIndex: 0,
      delta: 'r'.repeat(300_000),
    },
  }), /exceeds 262144 (?:characters|bytes)/u);
  const [recovered] = subject.mapNotification({
    method: 'item/reasoning/summaryTextDelta',
    params: {
      threadId: ROOT_THREAD,
      turnId: NATIVE_TURN,
      itemId: 'invalid-reasoning',
      summaryIndex: 0,
      delta: 'Recovered.',
    },
  });
  assert.equal(recovered?.event.type, 'turn.block.started',
    'a rejected block revision must not be committed to mapper state');
});

test('Codex streams an agent message with its lifecycle commentary phase', () => {
  const subject = mapper();
  subject.bindTurn('remux-turn-1', NATIVE_TURN);
  assert.deepEqual(subject.mapNotification({
    method: 'item/started',
    params: {
      threadId: ROOT_THREAD,
      turnId: NATIVE_TURN,
      item: {
        id: 'assistant-progress-1',
        type: 'agentMessage',
        phase: 'commentary',
        text: '',
      },
    },
  }), []);
  const [streamed] = subject.mapNotification({
    method: 'item/agentMessage/delta',
    params: {
      threadId: ROOT_THREAD,
      turnId: NATIVE_TURN,
      itemId: 'assistant-progress-1',
      delta: 'Inspecting the workspace.',
    },
  });
  const [completed] = subject.mapNotification({
    method: 'item/completed',
    params: {
      threadId: ROOT_THREAD,
      turnId: NATIVE_TURN,
      item: {
        id: 'assistant-progress-1',
        type: 'agentMessage',
        phase: 'commentary',
        text: 'Inspecting the workspace.',
      },
    },
  });

  assert.ok(streamed?.event.type === 'turn.block.started');
  assert.ok(completed?.event.type === 'turn.block.completed');
  if (streamed?.event.type !== 'turn.block.started' ||
      completed?.event.type !== 'turn.block.completed') return;
  assert.equal(streamed.event.block.payload.kind, 'commentary');
  assert.equal(streamed.event.structure.blockId, completed.event.structure.blockId);
  assert.equal(completed.event.block.payload.kind, 'commentary');
  assert.deepEqual(completed.native.position, {
    kind: 'native-sequence', sequence: 2, subIndex: 0,
  });
});

test('Codex buffers an agent delta until a reordered lifecycle item supplies its phase', () => {
  const subject = mapper();
  subject.bindTurn('remux-turn-1', NATIVE_TURN);
  assert.deepEqual(subject.mapNotification({
    method: 'item/agentMessage/delta',
    params: {
      threadId: ROOT_THREAD,
      turnId: NATIVE_TURN,
      itemId: 'assistant-progress-1',
      delta: 'Inspecting the workspace.',
    },
  }), []);

  const [streamed] = subject.mapNotification({
    method: 'item/started',
    params: {
      threadId: ROOT_THREAD,
      turnId: NATIVE_TURN,
      item: {
        id: 'assistant-progress-1',
        type: 'agentMessage',
        phase: 'commentary',
        text: '',
      },
    },
  });
  assert.equal(streamed?.event.type, 'turn.block.started');
  if (streamed?.event.type !== 'turn.block.started') return;
  assert.deepEqual(streamed.event.block.payload, {
    kind: 'commentary',
    text: 'Inspecting the workspace.',
  });
});

test('Codex completes buffered commentary without ever projecting a provisional final answer', () => {
  const subject = mapper();
  subject.bindTurn('remux-turn-1', NATIVE_TURN);
  const streamed = subject.mapNotification({
    method: 'item/agentMessage/delta',
    params: {
      threadId: ROOT_THREAD,
      turnId: NATIVE_TURN,
      itemId: 'assistant-progress-1',
      delta: 'Inspecting the workspace.',
    },
  });
  const completed = subject.mapNotification({
    method: 'item/completed',
    params: {
      threadId: ROOT_THREAD,
      turnId: NATIVE_TURN,
      item: {
        id: 'assistant-progress-1',
        type: 'agentMessage',
        phase: 'commentary',
        text: 'Inspecting the workspace.',
      },
    },
  });

  assert.deepEqual(streamed, []);
  assert.equal(completed.length, 1);
  assert.equal(completed[0]?.event.type, 'turn.block.completed');
  if (completed[0]?.event.type !== 'turn.block.completed') return;
  assert.deepEqual(completed[0].event.block.payload, {
    kind: 'commentary',
    text: 'Inspecting the workspace.',
  });
});

test('Codex restores an active commentary phase from a thread snapshot before later deltas', () => {
  const subject = mapper();
  subject.bindTurn('remux-turn-1', NATIVE_TURN);
  subject.mapThreadSnapshot({
    id: ROOT_THREAD,
    status: { type: 'active' },
    turns: [{
      id: NATIVE_TURN,
      status: 'inProgress',
      items: [{
        id: 'assistant-progress-1',
        type: 'agentMessage',
        phase: 'commentary',
        text: 'Inspecting',
      }],
    }],
  });

  const [continued] = subject.mapNotification({
    method: 'item/agentMessage/delta',
    params: {
      threadId: ROOT_THREAD,
      turnId: NATIVE_TURN,
      itemId: 'assistant-progress-1',
      delta: ' the workspace.',
    },
  });
  assert.equal(continued?.event.type, 'turn.block.revised');
  if (continued?.event.type !== 'turn.block.revised') return;
  assert.deepEqual(continued.event.block.payload, {
    kind: 'commentary',
    text: 'Inspecting the workspace.',
  });
});

test('Codex preserves native reasoning summary parts while streaming and on completion', () => {
  const subject = mapper();
  subject.bindTurn('remux-turn-1', NATIVE_TURN);
  assert.deepEqual(subject.mapNotification({
    method: 'item/reasoning/summaryPartAdded',
    params: {
      threadId: ROOT_THREAD,
      turnId: NATIVE_TURN,
      itemId: 'reasoning-1',
      summaryIndex: 0,
    },
  }), []);
  const [first] = subject.mapNotification({
    method: 'item/reasoning/summaryTextDelta',
    params: {
      threadId: ROOT_THREAD,
      turnId: NATIVE_TURN,
      itemId: 'reasoning-1',
      summaryIndex: 0,
      delta: '**Inspecting files**',
    },
  });
  const [second] = subject.mapNotification({
    method: 'item/reasoning/summaryTextDelta',
    params: {
      threadId: ROOT_THREAD,
      turnId: NATIVE_TURN,
      itemId: 'reasoning-1',
      summaryIndex: 1,
      delta: 'Comparing the implementation with its contract.',
    },
  });
  const [completed] = subject.mapNotification({
    method: 'item/completed',
    params: {
      threadId: ROOT_THREAD,
      turnId: NATIVE_TURN,
      item: {
        id: 'reasoning-1',
        type: 'reasoning',
        summary: ['**Inspecting files**', 'Comparing the implementation with its contract.'],
      },
    },
  });

  for (const envelope of [first, second, completed]) {
    assert.ok(envelope?.event.type === 'turn.block.started' ||
      envelope?.event.type === 'turn.block.revised' ||
      envelope?.event.type === 'turn.block.completed');
  }
  if (second?.event.type !== 'turn.block.revised' ||
      completed?.event.type !== 'turn.block.completed') return;
  assert.deepEqual(second.event.block.payload, {
    kind: 'reasoning-summary',
    text: '**Inspecting files**\nComparing the implementation with its contract.',
    parts: ['**Inspecting files**', 'Comparing the implementation with its contract.'],
  });
  assert.deepEqual(completed.event.block.payload, second.event.block.payload);
});

test('Codex exposes exact file patches on live and snapshot file changes', () => {
  const subject = mapper();
  subject.bindTurn('remux-turn-1', NATIVE_TURN);
  const liveEvents = subject.mapNotification({
    method: 'item/fileChange/patchUpdated',
    params: {
      threadId: ROOT_THREAD,
      turnId: NATIVE_TURN,
      itemId: 'patch-1',
      changes: [{
        path: '/workspace/remux/a.ts',
        kind: 'update',
        diff: '@@ -1 +1 @@\n-old\n+new\n',
      }],
    },
  });
  const live = liveEvents.find(({ event }) => event.type === 'turn.file-changed');
  const liveBlock = liveEvents.find(({ event }) => event.type === 'turn.block.started');
  assert.ok(live?.event.type === 'turn.file-changed');
  assert.ok(liveBlock?.event.type === 'turn.block.started');
  if (live?.event.type === 'turn.file-changed') {
    assert.equal(live.event.change.diff, '@@ -1 +1 @@\n-old\n+new\n');
    assert.equal(live.event.blockId, liveBlock?.event.type === 'turn.block.started'
      ? liveBlock.event.structure.blockId
      : null);
  }

  const snapshot = subject.mapThreadSnapshot({
    id: ROOT_THREAD,
    status: { type: 'idle' },
    turns: [{
      id: NATIVE_TURN,
      status: 'completed',
      items: [{
        id: 'patch-1',
        type: 'fileChange',
        status: 'completed',
        changes: [{
          path: '/workspace/remux/a.ts',
          kind: { type: 'update', move_path: null },
          diff: '@@ -1 +1 @@\n-old\n+new\n',
        }],
      }],
    }],
  });
  const change = snapshot.find(({ event }) => event.type === 'turn.file-changed');
  assert.ok(change?.event.type === 'turn.file-changed');
  if (change?.event.type === 'turn.file-changed') {
    assert.equal(change.event.change.diff, '@@ -1 +1 @@\n-old\n+new\n');
  }
});

test('Codex snapshots import user content, tools, file changes, reasoning, and usage semantically', () => {
  const subject = mapper();
  const snapshot = subject.mapThreadSnapshot({
    id: ROOT_THREAD,
    status: { type: 'idle' },
    turns: [{
      id: NATIVE_TURN,
      status: 'completed',
      items: [
        { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: 'Fix it.' }] },
        { id: 'reasoning-1', type: 'reasoning', summary: ['Inspecting.', 'Editing.'] },
        {
          id: 'command-1',
          type: 'commandExecution',
          command: 'npm test',
          cwd: '/workspace/remux',
          status: 'completed',
          commandActions: [{
            type: 'read',
            command: "sed -n '1,80p' src/a.ts",
            name: 'a.ts',
            path: '/workspace/remux/src/a.ts',
          }],
        },
        {
          id: 'file-1',
          type: 'fileChange',
          status: 'completed',
          changes: [{ path: '/workspace/remux/a.ts', kind: { type: 'update', move_path: null } }],
        },
      ],
    }],
  });

  assert.ok(snapshot.some(({ event }) => event.type === 'user.message'));
  assert.ok(snapshot.some(({ event }) =>
    event.type === 'turn.block.completed' && event.block.payload.kind === 'reasoning-summary' &&
    event.block.payload.text === 'Inspecting.\nEditing.' &&
    event.block.payload.parts?.join('|') === 'Inspecting.|Editing.'));
  assert.ok(snapshot.some(({ event }) =>
    event.type === 'turn.block.started' && event.block.payload.kind === 'tool' &&
    event.block.payload.tool.name === 'shell'));
  assert.ok(snapshot.some(({ event }) =>
    event.type === 'turn.block.completed' && event.block.payload.kind === 'tool' &&
    event.block.payload.tool.callId === 'command-1'));
  assert.ok(snapshot.some(({ event }) =>
    event.type === 'turn.block.started' && event.block.payload.kind === 'tool' &&
    event.block.payload.tool.callId === 'file-1'));
  assert.ok(snapshot.some(({ event }) =>
    event.type === 'turn.file-changed' && event.change.kind === 'update'));

  const usage = subject.mapNotification({
    method: 'thread/tokenUsage/updated',
    params: {
      threadId: ROOT_THREAD,
      turnId: NATIVE_TURN,
      modelContextWindow: 200,
      tokenUsage: {
        last: {
          inputTokens: 60,
          cachedInputTokens: 30,
          outputTokens: 8,
          reasoningOutputTokens: 2,
          totalTokens: 70,
        },
        total: {
          inputTokens: 100,
          cachedInputTokens: 60,
          outputTokens: 25,
          reasoningOutputTokens: 5,
          totalTokens: 125,
        },
      },
    },
  });
  assert.deepEqual(usage[0]?.event, {
    type: 'turn.usage-updated',
    usage: {
      turn: {
        inputTokens: 60,
        cachedInputTokens: 30,
        cacheWriteInputTokens: null,
        outputTokens: 8,
        reasoningOutputTokens: 2,
        totalTokens: 70,
      },
      cumulative: {
        tokens: {
          inputTokens: 100,
          cachedInputTokens: 60,
          cacheWriteInputTokens: null,
          outputTokens: 25,
          reasoningOutputTokens: 5,
          totalTokens: 125,
        },
        scope: 'native-conversation',
        epochId: ROOT_THREAD,
      },
      context: {
        usedTokens: 70,
        windowTokens: 200,
        percent: 35,
        measurement: 'derived',
        freshness: 'live',
        observedAt: 42,
        turnId: 'codex-turn-9964466bb90c16c28cbc2768',
      },
      estimatedCost: null,
    },
  });
});

test('Codex restored usage anchors compaction control turns to the latest visible turn', () => {
  const subject = mapper();
  subject.bindTurn('remux-turn-1', NATIVE_TURN);
  subject.mapThreadSnapshot({
    id: ROOT_THREAD,
    status: { type: 'idle' },
    turns: [
      {
        id: NATIVE_TURN,
        status: 'completed',
        items: [{ id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: 'Review.' }] }],
      },
      {
        id: 'native-compaction-turn',
        status: 'completed',
        items: [{ id: 'compact-1', type: 'contextCompaction' }],
      },
    ],
  });

  const [usage] = subject.mapNotification({
    method: 'thread/tokenUsage/updated',
    params: {
      threadId: ROOT_THREAD,
      turnId: 'native-compaction-turn',
      tokenUsage: {
        last: { inputTokens: 80, outputTokens: 10, totalTokens: 90 },
        total: { inputTokens: 800, outputTokens: 100, totalTokens: 900 },
        modelContextWindow: 200,
      },
    },
  });

  assert.equal(usage?.scope.kind, 'turn');
  if (usage?.scope.kind === 'turn') assert.equal(usage.scope.turnId, 'remux-turn-1');
  assert.equal(usage?.native.turnId, 'native-compaction-turn');
  assert.equal(
    usage?.event.type === 'turn.usage-updated' ? usage.event.usage.context?.percent : null,
    45,
  );
});

test('Codex usage identity is stable across resume probes and changes with token counts', () => {
  const usageNotification = (totalTokens: number) => ({
    method: 'thread/tokenUsage/updated',
    params: {
      threadId: ROOT_THREAD,
      turnId: NATIVE_TURN,
      tokenUsage: {
        last: { inputTokens: totalTokens - 10, outputTokens: 10, totalTokens },
        total: { inputTokens: totalTokens * 2 - 10, outputTokens: 10, totalTokens: totalTokens * 2 },
        modelContextWindow: 200,
      },
    },
  });
  const first = mapper({ observedAt: () => 10 });
  first.bindTurn('remux-turn-1', NATIVE_TURN);
  const resumed = mapper({ observedAt: () => 20 });
  resumed.bindTurn('remux-turn-1', NATIVE_TURN);

  const [firstUsage] = first.mapNotification(usageNotification(90));
  const [resumedUsage] = resumed.mapNotification(usageNotification(90));
  const [changedUsage] = resumed.mapNotification(usageNotification(100));

  assert.equal(firstUsage?.eventId, resumedUsage?.eventId);
  assert.notEqual(resumedUsage?.eventId, changedUsage?.eventId);
});

test('Codex snapshot mapping never embeds historical image data URLs in provider events', () => {
  const dataUrl = `data:image/png;base64,${'a'.repeat(400_000)}`;
  const snapshot = mapper().mapThreadSnapshot({
    id: ROOT_THREAD,
    status: { type: 'idle' },
    turns: [{
      id: NATIVE_TURN,
      status: 'completed',
      items: [{
        id: 'user-image-1',
        type: 'userMessage',
        content: [{ type: 'image', detail: 'auto', url: dataUrl }],
      }],
    }],
  });
  const message = snapshot.find(({ event }) => event.type === 'user.message');
  assert.ok(message?.event.type === 'user.message');
  if (message?.event.type === 'user.message') {
    assert.deepEqual(message.event.content, [{ type: 'text', text: '[Attached image]' }]);
  }
  assert.doesNotMatch(JSON.stringify(snapshot), /base64/iu);
});

test('Codex account pushes merge sparse windows without inventing zero usage', () => {
  const subject = mapper();
  const initial = subject.mapAccountUsage({
    rateLimits: {
      limitId: 'codex',
      primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 100 },
      secondary: { usedPercent: 40, windowDurationMins: 10_080, resetsAt: 200 },
    },
    rateLimitsByLimitId: {
      codex_bengalfox: {
        limitId: 'codex_bengalfox',
        limitName: 'GPT-5.3-Codex-Spark',
        primary: { usedPercent: 5, windowDurationMins: 300, resetsAt: 300 },
        secondary: { usedPercent: 9, windowDurationMins: 10_080, resetsAt: 400 },
      },
    },
  }, 'provider-read')[0];
  assert.equal(initial?.scope.kind, 'account');
  assert.equal(initial?.scope.providerInstanceId, 'codex-local');
  assert.equal(initial?.event.type, 'account.usage-updated');
  if (initial?.event.type === 'account.usage-updated') {
    assert.deepEqual(initial.event.usage.windows.map(({ id, usedPercent }) => [id, usedPercent]), [
      ['codex:primary', 20],
      ['codex:secondary', 40],
      ['codex_bengalfox:primary', 5],
      ['codex_bengalfox:secondary', 9],
    ]);
    assert.deepEqual(initial.event.usage.windows.slice(2).map(({ model }) => model), [
      'GPT-5.3-Codex-Spark',
      'GPT-5.3-Codex-Spark',
    ]);
    assert.deepEqual(
      initial.event.usage.windows.slice(0, 2).map(({ label, kind, resetsAt }) => [label, kind, resetsAt]),
      [
        ['5 hours', 'rolling', 100_000],
        ['Weekly', 'weekly', 200_000],
      ],
    );
    assert.equal(initial.event.usage.freshness, 'live');
  }

  const sparse = subject.mapNotification({
    method: 'account/rateLimits/updated',
    params: {
      rateLimits: {
        limitId: 'codex',
        primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 110 },
      },
    },
  })[0];
  assert.equal(sparse?.event.type, 'account.usage-updated');
  if (sparse?.event.type === 'account.usage-updated') {
    assert.deepEqual(sparse.event.usage.windows.map(({ id, usedPercent }) => [id, usedPercent]), [
      ['codex:primary', 25],
      ['codex:secondary', 40],
      ['codex_bengalfox:primary', 5],
      ['codex_bengalfox:secondary', 9],
    ]);
  }

  const empty = mapper().mapAccountUsage({ rateLimits: {} }, 'provider-read')[0];
  assert.equal(empty?.event.type, 'account.usage-updated');
  if (empty?.event.type === 'account.usage-updated') {
    assert.equal(empty.event.usage.availability, 'unknown');
    assert.deepEqual(empty.event.usage.windows, []);
  }
});

test('Codex account windows preserve short durations and avoid guessing when duration is absent', () => {
  const usage = normalizeCodexAccountUsage({
    rateLimits: {
      limitId: 'codex',
      primary: { usedPercent: 25, windowDurationMins: 15, resetsAt: 100 },
      secondary: { usedPercent: 40, resetsAt: 200 },
    },
  }, 'provider-read', 50);

  assert.deepEqual(usage.windows.map(({ label, kind, resetsAt }) => [label, kind, resetsAt]), [
    ['15 min', 'rolling', 100_000],
    ['Secondary limit', 'rolling', 200_000],
  ]);

  const durationless = normalizeCodexAccountUsage({
    rateLimits: {
      limitId: 'codex',
      primary: { usedPercent: 25 },
    },
  }, 'provider-read', 50);
  assert.equal(durationless.windows[0]?.label, 'Primary limit');
});

test('Codex native compaction turns stay conversation-scoped and complete one manual operation', () => {
  const subject = mapper();
  const nativeCompactionTurn = 'codex-compact-turn-1';
  subject.expectManualCompaction('manual-compact-1');

  assert.deepEqual(subject.mapNotification({
    method: 'turn/started',
    params: {
      threadId: ROOT_THREAD,
      turn: { id: nativeCompactionTurn, status: 'inProgress', items: [] },
    },
  }), []);
  assert.deepEqual(subject.mapNotification({
    method: 'item/started',
    params: {
      threadId: ROOT_THREAD,
      turnId: nativeCompactionTurn,
      item: { id: 'compact-item-1', type: 'contextCompaction' },
    },
  }), []);
  const completed = subject.mapNotification({
    method: 'item/completed',
    params: {
      threadId: ROOT_THREAD,
      turnId: nativeCompactionTurn,
      item: { id: 'compact-item-1', type: 'contextCompaction' },
    },
  });
  assert.equal(completed.length, 1);
  assert.equal(completed[0]?.scope.kind, 'conversation');
  assert.deepEqual(completed[0]?.event, {
    type: 'context.compaction.completed',
    trigger: 'manual',
    operationId: 'manual-compact-1',
    beforeTokens: null,
    afterTokens: null,
  });
  assert.deepEqual(subject.mapNotification({
    method: 'turn/completed',
    params: {
      threadId: ROOT_THREAD,
      turn: { id: nativeCompactionTurn, status: 'completed', items: [] },
    },
  }), []);
  assert.deepEqual(subject.mapNotification({
    method: 'thread/compacted',
    params: { threadId: ROOT_THREAD, turnId: nativeCompactionTurn },
  }), []);
});

test('Codex inline automatic compaction preserves the owning turn and all later work', () => {
  const subject = mapper();
  subject.bindTurn('remux-turn-1', NATIVE_TURN);

  const started = subject.mapNotification({
    method: 'item/started',
    params: {
      threadId: ROOT_THREAD,
      turnId: NATIVE_TURN,
      item: { id: 'compact-inline-1', type: 'contextCompaction' },
    },
  });
  const completed = subject.mapNotification({
    method: 'item/completed',
    params: {
      threadId: ROOT_THREAD,
      turnId: NATIVE_TURN,
      item: { id: 'compact-inline-1', type: 'contextCompaction' },
    },
  });
  const postCompaction = subject.mapNotification({
    method: 'item/completed',
    params: {
      threadId: ROOT_THREAD,
      turnId: NATIVE_TURN,
      item: {
        id: 'assistant-after-compact',
        type: 'agentMessage',
        phase: 'final_answer',
        text: 'Completed after compacting.',
      },
    },
  });
  const terminal = subject.mapNotification({
    method: 'turn/completed',
    params: {
      threadId: ROOT_THREAD,
      turn: { id: NATIVE_TURN, status: 'completed', items: [] },
    },
  });

  assert.equal(started.length, 2);
  assert.equal(started[0]?.scope.kind, 'conversation');
  assert.equal(started[0]?.event.type, 'context.compaction.started');
  assert.equal(started[1]?.scope.kind, 'turn');
  assert.equal(started[1]?.event.type, 'turn.block.started');
  if (started[1]?.event.type === 'turn.block.started') {
    assert.equal(started[1].event.block.payload.kind, 'compatibility-notice');
    if (started[1].event.block.payload.kind === 'compatibility-notice') {
      assert.equal(started[1].event.block.payload.code, 'context-compaction');
      assert.equal(started[1].event.block.payload.message, 'Compacting');
    }
  }
  assert.equal(completed.length, 2);
  assert.equal(completed[0]?.event.type, 'context.compaction.completed');
  assert.equal(completed[1]?.event.type, 'turn.block.completed');
  if (started[1]?.event.type === 'turn.block.started' &&
      completed[1]?.event.type === 'turn.block.completed') {
    assert.equal(started[1].event.structure.blockId, completed[1].event.structure.blockId);
  }
  assert.ok(postCompaction.some(({ event }) =>
    event.type === 'turn.block.completed' && event.block.kind === 'final-message'));
  assert.ok(terminal.some(({ event }) =>
    event.type === 'turn.completed' && event.outcome === 'completed'));
});

test('Codex live and resumed compaction identities converge when App Server rewrites item ids', () => {
  const liveMapper = mapper();
  liveMapper.bindTurn('remux-turn-1', NATIVE_TURN);
  const live = liveMapper.mapNotification({
    method: 'item/completed',
    params: {
      threadId: ROOT_THREAD,
      turnId: NATIVE_TURN,
      item: {
        id: '01a066ac-330d-76e2-b8c5-f21088347495',
        type: 'contextCompaction',
      },
    },
  });

  const resumedSessionId = 'codex-thread-resumed';
  const resumedMapper = mapper({ executionId: 'execution-2', nativeSessionId: resumedSessionId });
  resumedMapper.bindTurn('remux-turn-1', NATIVE_TURN);
  const resumed = resumedMapper.mapThreadSnapshot({
    id: resumedSessionId,
    status: { type: 'idle' },
    turns: [{
      id: NATIVE_TURN,
      status: 'completed',
      items: [
        { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: 'Continue.' }] },
        { id: 'item-43', type: 'contextCompaction' },
        { id: 'item-44', type: 'agentMessage', phase: 'final_answer', text: 'Done.' },
      ],
    }],
  });

  const liveControl = live.find(({ event }) => event.type === 'context.compaction.completed');
  const resumedControl = resumed.find(({ event }) => event.type === 'context.compaction.completed');
  assert.ok(liveControl);
  assert.ok(resumedControl);
  assert.equal(liveControl.eventId, resumedControl.eventId);
  assert.equal(liveControl.event.type, 'context.compaction.completed');
  assert.equal(resumedControl.event.type, 'context.compaction.completed');
  if (liveControl.event.type === 'context.compaction.completed' &&
      resumedControl.event.type === 'context.compaction.completed') {
    assert.equal(liveControl.event.operationId, resumedControl.event.operationId);
  }
});

test('Codex snapshot controls expose stable subjects and structural neighbours across resume', () => {
  const subject = mapper({
    executionId: 'execution-resumed',
    inheritedNativeTurnIds: ['native-before'],
  });
  const snapshot = subject.mapThreadSnapshot({
    id: ROOT_THREAD,
    status: { type: 'idle' },
    turns: [{
      id: 'native-before', status: 'completed',
      items: [{ id: 'user-before', type: 'userMessage', content: [{ type: 'text', text: 'Before.' }] }],
    }, {
      id: 'native-control', status: 'completed',
      items: [{ id: 'rewritten-item-77', type: 'contextCompaction' }],
    }, {
      id: 'native-after', status: 'completed',
      items: [{ id: 'user-after', type: 'userMessage', content: [{ type: 'text', text: 'After.' }] }],
    }],
  });
  const control = snapshot.find(({ event }) => event.type === 'context.compaction.completed');
  assert.deepEqual(control?.native.subject, {
    kind: 'context-compaction',
    key: 'codex:context-compaction:native-control:0',
  });
  assert.deepEqual(control?.native.timeline, {
    previousTurnId: 'native-before',
    nextTurnId: 'native-after',
  });
});

test('Codex snapshots preserve a same-id inline compaction marker after live completion', () => {
  const subject = mapper();
  subject.bindTurn('remux-turn-1', NATIVE_TURN);
  const live = subject.mapNotification({
    method: 'item/completed',
    params: {
      threadId: ROOT_THREAD,
      turnId: NATIVE_TURN,
      item: { id: 'compact-inline', type: 'contextCompaction' },
    },
  });
  assert.ok(live.some(({ event }) =>
    event.type === 'turn.block.completed' &&
    event.block.payload.kind === 'compatibility-notice' &&
    event.block.payload.code === 'context-compaction'));

  const snapshot = subject.mapThreadSnapshot({
    id: ROOT_THREAD,
    status: { type: 'idle' },
    turns: [{
      id: NATIVE_TURN,
      status: 'completed',
      items: [
        {
          id: 'tool-before', type: 'commandExecution', command: 'rg before',
          cwd: '/workspace', status: 'completed',
        },
        { id: 'compact-inline', type: 'contextCompaction' },
        {
          id: 'tool-after', type: 'commandExecution', command: 'rg after',
          cwd: '/workspace', status: 'completed',
        },
      ],
    }],
  });

  const marker = snapshot.find(({ event }) =>
    event.type === 'turn.block.completed' &&
    event.block.payload.kind === 'compatibility-notice' &&
    event.block.payload.code === 'context-compaction');
  assert.ok(marker);
  assert.deepEqual(marker.native.position, { kind: 'snapshot-index', itemIndex: 1, subIndex: 0 });
});

test('Codex command snapshots omit unavailable preview fields instead of emitting empty strings', () => {
  const subject = mapper();
  subject.bindTurn('remux-turn-1', NATIVE_TURN);
  const snapshot = subject.mapThreadSnapshot({
    id: ROOT_THREAD,
    status: { type: 'idle' },
    turns: [{
      id: NATIVE_TURN,
      status: 'completed',
      items: [{
        id: 'tool-without-cwd', type: 'commandExecution', command: 'pwd', status: 'completed',
      }],
    }],
  });

  const started = snapshot.find(({ event }) =>
    event.type === 'turn.block.started' && event.block.payload.kind === 'tool');
  assert.equal(started?.event.type, 'turn.block.started');
  if (started?.event.type === 'turn.block.started' && started.event.block.payload.kind === 'tool') {
    assert.deepEqual(started.event.block.payload.inputPreview, {
      command: 'pwd',
      commandActions: [],
    });
  }
});

test('Codex snapshots retain work on both sides of an inline compaction', () => {
  const subject = mapper();
  subject.bindTurn('remux-turn-1', NATIVE_TURN);
  const snapshot = subject.mapThreadSnapshot({
    id: ROOT_THREAD,
    status: { type: 'idle' },
    turns: [{
      id: NATIVE_TURN,
      status: 'completed',
      items: [
        { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: 'Implement it.' }] },
        {
          id: 'tool-before', type: 'commandExecution', command: 'rg before',
          cwd: '/workspace', status: 'completed',
        },
        { id: 'compact-inline', type: 'contextCompaction' },
        {
          id: 'tool-after', type: 'commandExecution', command: 'rg after',
          cwd: '/workspace', status: 'completed',
        },
        { id: 'assistant-1', type: 'agentMessage', phase: 'final_answer', text: 'Done.' },
      ],
    }],
  });

  const turnBlocks = snapshot.filter(({ event }) =>
    event.type === 'turn.block.completed');
  assert.deepEqual(turnBlocks.map(({ event }) =>
    event.type === 'turn.block.completed' ? event.block.payload.kind : null), [
    'tool',
    'compatibility-notice',
    'tool',
    'final-message',
  ]);
  const marker = turnBlocks[1];
  assert.equal(marker?.event.type, 'turn.block.completed');
  if (marker?.event.type === 'turn.block.completed' &&
      marker.event.block.payload.kind === 'compatibility-notice') {
    assert.equal(marker.event.block.payload.code, 'context-compaction');
  }
  assert.ok(snapshot.some(({ event }) =>
    event.type === 'context.compaction.completed'));
  assert.ok(snapshot.some(({ event }) =>
    event.type === 'turn.completed' && event.outcome === 'completed'));
});

test('Codex snapshots preserve seeded turn bindings and exclude native control turns', () => {
  const subject = mapper();
  subject.bindTurn('remux-existing-turn', NATIVE_TURN);
  const snapshot = subject.mapThreadSnapshot({
    id: ROOT_THREAD,
    status: { type: 'idle' },
    turns: [{
      id: NATIVE_TURN,
      status: 'completed',
      items: [
        { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: 'Hello.' }] },
        { id: 'assistant-1', type: 'agentMessage', phase: 'final_answer', text: 'Hi.' },
      ],
    }, {
      id: 'native-empty-control-turn',
      status: 'interrupted',
      items: [],
    }, {
      id: 'native-compact-turn',
      status: 'completed',
      items: [{ id: 'native-compact-item', type: 'contextCompaction' }],
    }],
  });

  const turnScopes = snapshot.flatMap((event) =>
    event.scope.kind === 'turn' ? [event.scope.turnId] : []);
  assert.ok(turnScopes.length > 0);
  assert.deepEqual([...new Set(turnScopes)], ['remux-existing-turn']);
  const compact = snapshot.find(({ event }) => event.type === 'context.compaction.completed');
  assert.equal(compact?.scope.kind, 'conversation');
  assert.equal(compact?.event.type, 'context.compaction.completed');
  if (compact?.event.type === 'context.compaction.completed') {
    assert.equal(compact.event.trigger, 'automatic');
  }
});

test('Codex native subagents remain native child executions under the owning turn', () => {
  const subject = mapper();
  subject.bindTurn('remux-turn-1', NATIVE_TURN);
  const childThreadId = 'codex-child-thread-1';
  const activity = subject.mapNotification({
    method: 'item/completed',
    params: {
      threadId: ROOT_THREAD,
      turnId: NATIVE_TURN,
      item: {
        id: 'collab-call-1',
        type: 'subAgentActivity',
        kind: 'started',
        agentThreadId: childThreadId,
        agentPath: '/root/reviewer',
      },
    },
  });
  assert.equal(activity[0]?.scope.kind, 'turn');
  if (activity[0]?.scope.kind === 'turn') assert.equal(activity[0].scope.turnId, 'remux-turn-1');
  assert.ok(activity[0]?.event.type === 'turn.block.started');
  if (activity[0]?.event.type !== 'turn.block.started' ||
      activity[0].event.block.payload.kind !== 'native-child') return;
  assert.equal(activity[0].event.block.payload.child.ownership, 'native');
  assert.equal(activity[0].event.block.payload.child.nativeSessionId, childThreadId);
  assert.equal(activity[0].event.block.payload.child.transcriptAvailable, true);

  const completed = subject.mapNotification({
    method: 'turn/completed',
    params: {
      threadId: childThreadId,
      turn: { id: 'child-native-turn-1', status: 'completed', items: [] },
    },
  });
  assert.equal(completed[0]?.scope.kind, 'turn');
  if (completed[0]?.scope.kind === 'turn') assert.equal(completed[0].scope.turnId, 'remux-turn-1');
  assert.ok(completed[0]?.event.type === 'turn.block.completed');
  if (completed[0]?.event.type === 'turn.block.completed' &&
      completed[0].event.block.payload.kind === 'native-child') {
    assert.equal(
      completed[0].event.block.payload.child.executionId,
      activity[0].event.block.payload.child.executionId,
    );
  }
});
