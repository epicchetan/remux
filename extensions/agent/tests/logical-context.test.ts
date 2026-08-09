import assert from 'node:assert/strict';
import test from 'node:test';

import type { Message, Model } from '@earendil-works/pi-ai';

import {
  alignDurableContextWithPi,
  assertContextBudget,
  ContextRolloverRequiredError,
  createDurableContextSnapshot,
  estimatePiContextTokens,
  hashRenderedMessages,
  piMessageSemanticHashes,
  reduceLogicalReplay,
  type LogicalContextMessage,
  type LogicalReplayEvent,
} from '../server/src/logical-context.ts';

test('logical replay restores inference/tool order and excludes incomplete effects', () => {
  const events: LogicalReplayEvent[] = [
    { type: 'user', sequence: 1, turnId: 'turn-1', timestamp: 10, text: 'Inspect it.' },
    {
      type: 'inference-started', sequence: 2, turnId: 'turn-1', timestamp: 20,
      inferenceId: 'inference-1',
    },
    {
      type: 'assistant-checkpoint', sequence: 3, turnId: 'turn-1', timestamp: 30,
      textDelta: 'Checking.', reasoningDelta: 'Need the file.',
    },
    {
      type: 'inference-terminal', sequence: 4, turnId: 'turn-1', timestamp: 40,
      inferenceId: 'inference-1', state: 'completed',
    },
    {
      type: 'tool-called', sequence: 5, turnId: 'turn-1', timestamp: 50,
      callId: 'call-complete', name: 'workspace.read', args: { path: 'README.md' },
    },
    {
      type: 'tool-called', sequence: 6, turnId: 'turn-1', timestamp: 60,
      callId: 'call-crashed', name: 'workspace.read', args: { path: 'missing.md' },
    },
    {
      type: 'tool-completed', sequence: 7, turnId: 'turn-1', timestamp: 70,
      callId: 'call-complete', result: { text: 'hello' }, isError: false,
    },
    {
      type: 'turn-terminal', sequence: 8, turnId: 'turn-1', timestamp: 80,
      state: 'interrupted',
    },
  ];

  assert.deepEqual(reduceLogicalReplay(events), [
    { role: 'user', turnId: 'turn-1', text: 'Inspect it.', timestamp: 10 },
    {
      role: 'assistant', turnId: 'turn-1', text: 'Checking.', reasoning: 'Need the file.',
      toolCalls: [{
        callId: 'call-complete', name: 'workspace.read', args: { path: 'README.md' },
      }],
      state: 'completed', timestamp: 20,
    },
    {
      role: 'tool', turnId: 'turn-1', callId: 'call-complete', name: 'workspace.read',
      result: { text: 'hello' }, isError: false, timestamp: 70,
    },
  ]);
});

test('durable-prefix alignment preserves Pi exact suffix objects and rejects drift', () => {
  const durable: LogicalContextMessage[] = [
    { role: 'user', turnId: 'old', text: 'Earlier', timestamp: 1 },
    {
      role: 'assistant', turnId: 'old', text: 'Earlier answer', reasoning: 'Visible summary.', toolCalls: [],
      state: 'completed', timestamp: 2,
    },
    { role: 'user', turnId: 'current', text: 'Current', timestamp: 3 },
  ];
  const snapshot = createDurableContextSnapshot(42, durable);
  const exactSuffix: Message[] = [{ role: 'user', content: 'Current', timestamp: 999 }];
  const aligned = alignDurableContextWithPi(snapshot, exactSuffix, fixtureModel());

  assert.equal(aligned.length, 3);
  assert.strictEqual(aligned[2], exactSuffix[0]);
  assert.deepEqual(piMessageSemanticHashes(aligned), snapshot.orderedMessageHashes);
  assert.match(hashRenderedMessages(aligned).hash, /^[a-f0-9]{64}$/u);

  assert.throws(
    () => alignDurableContextWithPi(
      snapshot,
      [{ role: 'user', content: 'Drifted', timestamp: 999 }],
      fixtureModel(),
    ),
    /does not match Pi runtime suffix/u,
  );
});

test('logical tool errors align with Pi immediate validation failures', () => {
  const durable: LogicalContextMessage[] = [
    { role: 'user', turnId: 'turn', text: 'Read it.', timestamp: 1 },
    {
      role: 'assistant', turnId: 'turn', text: '', reasoning: '', state: 'completed', timestamp: 2,
      toolCalls: [{ callId: 'call-invalid', name: 'workspace.read', args: { path: 42 } }],
    },
    {
      role: 'tool', turnId: 'turn', callId: 'call-invalid', name: 'workspace.read',
      result: { error: 'path: expected string' }, isError: true, timestamp: 3,
    },
  ];
  const piMessages: Message[] = [
    { role: 'user', content: 'Read it.', timestamp: 100 },
    {
      role: 'assistant',
      content: [{
        type: 'toolCall', id: 'call-invalid', name: 'workspace_read', arguments: { path: 42 },
      }],
      api: 'openai-codex-responses', provider: 'openai-codex', model: 'gpt-fixture',
      usage: {
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'toolUse', timestamp: 101,
    },
    {
      role: 'toolResult', toolCallId: 'call-invalid', toolName: 'workspace_read',
      content: [{ type: 'text', text: 'path: expected string' }], details: {},
      isError: true, timestamp: 102,
    },
  ];
  const snapshot = createDurableContextSnapshot(10, durable);

  assert.deepEqual(piMessageSemanticHashes(piMessages), snapshot.orderedMessageHashes);
  assert.deepEqual(alignDurableContextWithPi(snapshot, piMessages, fixtureModel()), piMessages);
});

test('rendered context hashing accepts finite provider cost metadata', () => {
  const message: Message = {
    role: 'assistant',
    content: [{ type: 'text', text: 'Prior response' }],
    api: 'openai-codex-responses',
    provider: 'openai-codex',
    model: 'gpt-fixture',
    usage: {
      input: 17,
      output: 4,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 21,
      cost: {
        input: 0.00002125,
        output: 0.00004,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0.00006125,
      },
    },
    stopReason: 'stop',
    timestamp: 123,
  };

  const first = hashRenderedMessages([message]);
  const second = hashRenderedMessages([{ ...message, usage: { ...message.usage } }]);
  assert.match(first.hash, /^[a-f0-9]{64}$/u);
  assert.deepEqual(second, first);
  assert.ok(estimatePiContextTokens([message], 'fixture prompt') > 0);
});

test('context estimation excludes tool details that providers never receive', () => {
  const visible = 'provider-visible output '.repeat(512);
  const base: Message = {
    role: 'toolResult',
    toolCallId: 'call-large-details',
    toolName: 'workspace_read',
    content: [{ type: 'text', text: visible }],
    details: { text: visible },
    isError: false,
    timestamp: 123,
  };
  const inflatedInternalDetails: Message = {
    ...base,
    details: { duplicate: visible.repeat(64) },
  };

  assert.equal(
    estimatePiContextTokens([inflatedInternalDetails], 'fixture prompt'),
    estimatePiContextTokens([base], 'fixture prompt'),
  );
  assert.deepEqual(
    piMessageSemanticHashes([inflatedInternalDetails]),
    piMessageSemanticHashes([base]),
  );
});

test('tool-result semantics preserve provider-visible unsafe JSON as exact text', () => {
  const visible = '{"created_at_ns":9007199254740992}';
  const piMessage: Message = {
    role: 'toolResult',
    toolCallId: 'call-unsafe-number',
    toolName: 'bash',
    content: [{ type: 'text', text: visible }],
    details: { created_at_ns: 9_007_199_254_740_992 },
    isError: false,
    timestamp: 123,
  };
  const durable: LogicalContextMessage = {
    role: 'tool',
    turnId: 'turn',
    callId: 'call-unsafe-number',
    name: 'bash',
    result: visible,
    isError: false,
    timestamp: 123,
  };

  assert.deepEqual(
    piMessageSemanticHashes([piMessage]),
    createDurableContextSnapshot(1, [durable]).orderedMessageHashes,
  );
});

test('context budget fails with an explicit rollover-required error', () => {
  assert.doesNotThrow(() => assertContextBudget(4_999, 35_000));
  assert.throws(
    () => assertContextBudget(5_001, 35_000),
    (error) => error instanceof ContextRolloverRequiredError &&
      error.kind === 'context_rollover_not_enabled' &&
      error.hardInputLimit === 10_000 &&
      error.safetyMargin === 5_000 &&
      error.admissionLimit === 5_000,
  );
});

function fixtureModel(): Model<string> {
  return {
    id: 'gpt-fixture',
    name: 'GPT fixture',
    api: 'openai-codex-responses',
    provider: 'openai-codex',
    baseUrl: 'https://example.test',
    reasoning: true,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 400_000,
    maxTokens: 128_000,
  } as Model<string>;
}
