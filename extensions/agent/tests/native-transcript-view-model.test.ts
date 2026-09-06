import assert from 'node:assert/strict';
import test from 'node:test';

import {
  nativeExecutionId,
  nativeExecutionScopeId,
  projectNativeChildExecutionScope,
  projectNativeExecutionScope,
  projectNativeTurn,
} from '../viewer/src/nativeTranscriptViewModel.ts';
import type {
  NativeAgentTurnFrame,
  NativeTranscriptWindow,
} from '../shared/native-agent-protocol.ts';
import { AGENT_TRANSCRIPT_PROTOCOL_VERSION } from '../shared/transcript.ts';

test('native and federated children expose provider-neutral lazy execution scopes', () => {
  const turn = frame('root-turn', 'root-execution', 'completed', 'Root result.');
  turn.activity.children = [{
    executionId: 'native-child',
    ownership: 'native',
    provider: 'codex',
    state: 'idle',
    summary: 'Native summary.',
  }, {
    executionId: 'federated-child',
    ownership: 'federated',
    provider: 'claude-code',
    state: 'idle',
    summary: 'Federated summary.',
  }];

  const work = projectNativeTurn(turn).segments.find((segment) => segment.type === 'work');
  assert.ok(work && work.type === 'work');
  assert.equal(work.childExecutionCount, 2);
  const rootScope = projectNativeExecutionScope('conversation-1', turn, {
    type: 'executionScope',
    protocolVersion: AGENT_TRANSCRIPT_PROTOCOL_VERSION,
    turnId: turn.turnId,
    scopeId: 'root-execution',
  }, 13);
  const childCalls = rootScope.inferences.flatMap(({ blocks }) => blocks.flatMap((block) =>
    block.type === 'action' ? [block.call] : []));
  assert.equal(
    childCalls.find(({ callId }) => callId === 'native-child')?.childScopeId,
    nativeExecutionScopeId('native-child'),
  );
  assert.equal(
    childCalls.find(({ callId }) => callId === 'federated-child')?.childScopeId,
    nativeExecutionScopeId('federated-child'),
  );

  const scope = projectNativeChildExecutionScope('conversation-1', {
    conversationId: 'conversation-1',
    strandId: 'strand-fixture',
    executionId: 'federated-child',
    activeTurnId: null,
    turnOrder: ['child-turn-1', 'child-turn-2'],
    turns: [
      frame('child-turn-1', 'federated-child', 'completed', 'Initial result.'),
      { ...frame('child-turn-2', 'federated-child', 'completed', 'Follow-up result.'), userContent: [] },
    ],
    window: {
      startIndex: 0,
      endIndexExclusive: 2,
      hasEarlier: false,
      hasLater: false,
    },
  } satisfies NativeTranscriptWindow, {
    type: 'executionScope',
    protocolVersion: AGENT_TRANSCRIPT_PROTOCOL_VERSION,
    turnId: 'root-turn',
    scopeId: nativeExecutionScopeId('federated-child'),
  }, 14);

  assert.equal(nativeExecutionId(scope.scopeId), 'federated-child');
  assert.equal(nativeExecutionId('root-execution'), null);
  assert.equal(scope.inferences.length, 2);
  assert.deepEqual(scope.inferences[0]?.blocks.map((block) =>
    block.type === 'action' ? block.call.name : block.text), [
    'Task\n\nRequest for child-turn-1',
  ]);
  assert.deepEqual(scope.inferences[1]?.blocks.map((block) =>
    block.type === 'action' ? block.call.name : block.text), ['Task\n\nOriginal task unavailable.']);
  assert.equal(scope.result, 'Follow-up result.');
  assert.equal(scope.state, 'completed');
  assert.deepEqual(scope.window, {
    startIndex: 0,
    endIndexExclusive: 2,
    hasEarlier: false,
    hasLater: false,
  });
});

test('native provider blocks retain exact pass and block order while the terminal answer stays outside work', () => {
  const turn = frame('ordered-turn', 'root-execution', 'completed', 'Final answer.');
  turn.passes = [{
    passId: 'message-1',
    ordinal: 0,
    state: 'completed',
    blocks: [
      block('thinking-1', 0, 'reasoning-summary', { kind: 'reasoning-summary', text: 'First thought.' , truncated: false}),
      block('tool-1', 1, 'tool', {
        kind: 'tool',
        tool: { callId: 'call-1', name: 'Read', category: 'file', title: 'Read file' },
      }),
      block('thinking-2', 2, 'reasoning-summary', { kind: 'reasoning-summary', text: 'Second thought.' , truncated: false}),
      block('tool-2', 3, 'tool', {
        kind: 'tool',
        tool: { callId: 'call-2', name: 'Bash', category: 'shell', title: 'Run tests' },
      }),
      block('final-1', 4, 'final-message', { kind: 'final-message', text: 'Final answer.' }),
    ],
  }];
  turn.finalBlockId = 'final-1';

  const projected = projectNativeTurn(turn);
  const work = projected.segments.find((segment) => segment.type === 'work');
  assert.ok(work && work.type === 'work');
  assert.equal(work.inferenceCount, 1);
  assert.equal(work.operationCount, 2);
  const assistant = projected.segments.find((segment) => segment.type === 'assistantMessage');
  assert.ok(assistant && assistant.type === 'assistantMessage');
  assert.equal(assistant.text, 'Final answer.');

  const scope = projectNativeChildExecutionScope('conversation-1', {
    conversationId: 'conversation-1', strandId: 'strand-fixture', executionId: 'root-execution', activeTurnId: null,
    turnOrder: [turn.turnId], turns: [turn],
    window: { startIndex: 0, endIndexExclusive: 1, hasEarlier: false, hasLater: false },
  }, {
    type: 'executionScope', protocolVersion: AGENT_TRANSCRIPT_PROTOCOL_VERSION, turnId: turn.turnId, scopeId: 'root-execution',
  }, 1);
  assert.deepEqual(scope.inferences[0]?.blocks.map((value) =>
    value.type === 'action' ? value.call.name : value.text), [
    'Task\n\nRequest for ordered-turn',
    'First thought.',
    'Read',
    'Second thought.',
    'Bash',
  ]);
});

test('conversation compactions project before and after the surrounding turn', () => {
  const turn = frame('compaction-turn', 'root-execution', 'completed', 'Done.');
  turn.boundaryCompactions = {
    beforeUser: [{
      operationId: 'compact-before', trigger: 'manual', state: 'completed',
      beforeTokens: 80_000, afterTokens: 12_000, createdAt: 5, completedAt: 6,
    }],
    afterTurn: [{
      operationId: 'compact-after', trigger: 'automatic', state: 'started',
      beforeTokens: 95_000, afterTokens: null, createdAt: 25,
    }],
  };

  const projected = projectNativeTurn(turn);
  assert.deepEqual(projected.segments.map(({ type }) => type), [
    'compaction', 'userMessage', 'assistantMessage', 'compaction',
  ]);
  const before = projected.segments[0];
  const after = projected.segments.at(-1);
  assert.ok(before?.type === 'compaction' && after?.type === 'compaction');
  assert.equal(before.status, 'compacted');
  assert.equal(before.trigger, 'manual');
  assert.equal(before.beforeTokens, 80_000);
  assert.equal(after.status, 'compacting');
});

test('an ordered context-compaction notice remains inside the work trace', () => {
  const turn = frame('inline-compaction-turn', 'root-execution', 'completed', 'Done.');
  turn.passes = [{
    passId: 'message-1',
    ordinal: 0,
    state: 'completed',
    blocks: [
      block('reasoning-before', 0, 'reasoning-summary', {
        kind: 'reasoning-summary', text: 'Before.', truncated: false,
      }),
      block('compaction-marker', 1, 'compatibility-notice', {
        kind: 'compatibility-notice', code: 'context-compaction', message: 'Compacted',
      }),
      block('reasoning-after', 2, 'reasoning-summary', {
        kind: 'reasoning-summary', text: 'After.', truncated: false,
      }),
    ],
  }];

  const scope = projectNativeChildExecutionScope('conversation-1', {
    conversationId: 'conversation-1', strandId: 'strand-fixture',
    executionId: 'root-execution', activeTurnId: null,
    turnOrder: [turn.turnId], turns: [turn],
    window: { startIndex: 0, endIndexExclusive: 1, hasEarlier: false, hasLater: false },
  }, {
    type: 'executionScope', protocolVersion: AGENT_TRANSCRIPT_PROTOCOL_VERSION, turnId: turn.turnId, scopeId: 'root-execution',
  }, 1);
  const blocks = scope.inferences[0]?.blocks ?? [];
  assert.deepEqual(blocks.map((item) => item.type === 'action' ? item.call.name : item.text), [
    'Task\n\nRequest for inline-compaction-turn', 'Before.', 'Compacted', 'After.',
  ]);
  const marker = blocks.find((item) => item.type === 'notice');
  assert.ok(marker?.type === 'notice');
  assert.equal(marker.code, 'context-compaction');
});

test('reasoning projection preserves native parts and recovers bold boundaries for legacy journals', () => {
  const turn = frame('reasoning-turn', 'root-execution', 'completed', 'Done.');
  turn.passes = [{
    passId: 'message-1',
    ordinal: 0,
    state: 'completed',
    blocks: [
      block('native-thinking', 0, 'reasoning-summary', {
        kind: 'reasoning-summary',
        text: '**Inspecting**\nExplaining the finding.',
        parts: ['**Inspecting**', 'Explaining the finding.'],
        truncated: false,
      }),
      block('legacy-thinking', 1, 'reasoning-summary', {
        kind: 'reasoning-summary',
        text: '**Testing**\nA paragraph about the test.\n**Reviewing results**',
        truncated: false,
      }),
    ],
  }];
  const scope = projectNativeChildExecutionScope('conversation-1', {
    conversationId: 'conversation-1', strandId: 'strand-fixture', executionId: 'root-execution', activeTurnId: null,
    turnOrder: [turn.turnId], turns: [turn],
    window: { startIndex: 0, endIndexExclusive: 1, hasEarlier: false, hasLater: false },
  }, {
    type: 'executionScope', protocolVersion: AGENT_TRANSCRIPT_PROTOCOL_VERSION, turnId: turn.turnId, scopeId: 'root-execution',
  }, 1);
  const reasoning = scope.inferences[0]?.blocks.filter((value) => value.type === 'reasoning') ?? [];
  assert.deepEqual(reasoning.map((value) => value.type === 'reasoning' ? value.parts : null), [
    ['**Inspecting**', 'Explaining the finding.'],
    ['**Testing**\nA paragraph about the test.', '**Reviewing results**'],
  ]);
});

test('file changes expose a disclosure only when an exact diff artifact exists', () => {
  const turn = frame('diff-turn', 'root-execution', 'completed', 'Done.');
  turn.activity.fileChanges = [{
    path: 'src/with-diff.ts',
    kind: 'update',
    diffArtifactId: 'a'.repeat(64),
  }, {
    path: 'src/metadata-only.ts',
    kind: 'update',
  }];
  const scope = projectNativeChildExecutionScope('conversation-1', {
    conversationId: 'conversation-1', strandId: 'strand-fixture', executionId: 'root-execution', activeTurnId: null,
    turnOrder: [turn.turnId], turns: [turn],
    window: { startIndex: 0, endIndexExclusive: 1, hasEarlier: false, hasLater: false },
  }, {
    type: 'executionScope', protocolVersion: AGENT_TRANSCRIPT_PROTOCOL_VERSION, turnId: turn.turnId, scopeId: 'root-execution',
  }, 1);
  const calls = scope.inferences.flatMap(({ blocks }) => blocks.flatMap((value) =>
    value.type === 'action' && value.call.name === 'file_change' ? [value.call] : []));
  assert.equal(calls[0]?.hasDetail, true);
  assert.equal(calls[0]?.diffArtifactId, 'a'.repeat(64));
  assert.equal(calls[1]?.hasDetail, false);
  assert.equal(calls[1]?.diffArtifactId, undefined);
});

test('linked file changes render at their provider block instead of a trailing compatibility group', () => {
  const turn = frame('chronological-turn', 'root-execution', 'completed', 'Done.');
  turn.passes = [{
    passId: 'message-1',
    ordinal: 0,
    state: 'completed',
    blocks: [
      block('thinking-before', 0, 'reasoning-summary', {
        kind: 'reasoning-summary', text: 'Planning the edit.', truncated: false,
      }),
      block('file-block', 1, 'tool', {
        kind: 'tool',
        tool: { callId: 'file-call', name: 'file_change', category: 'file', title: 'Edited files' },
      }),
      block('commentary-after', 2, 'commentary', {
        kind: 'commentary', text: 'Checking the result.',
      }),
      block('command-after', 3, 'tool', {
        kind: 'tool',
        tool: { callId: 'command-call', name: 'shell', category: 'shell', title: 'npm test' },
        inputPreview: { command: 'npm test', cwd: '/workspace/remux', commandActions: [] },
      }),
    ],
  }];
  turn.activity.fileChanges = [{
    path: 'src/a.ts', kind: 'update', blockId: 'file-block', diffArtifactId: 'a'.repeat(64),
  }];

  const scope = projectNativeChildExecutionScope('conversation-1', {
    conversationId: 'conversation-1', strandId: 'strand-fixture', executionId: 'root-execution', activeTurnId: null,
    turnOrder: [turn.turnId], turns: [turn],
    window: { startIndex: 0, endIndexExclusive: 1, hasEarlier: false, hasLater: false },
  }, {
    type: 'executionScope', protocolVersion: AGENT_TRANSCRIPT_PROTOCOL_VERSION, turnId: turn.turnId, scopeId: 'root-execution',
  }, 1);

  assert.equal(scope.inferences.length, 1);
  assert.deepEqual(scope.inferences[0]?.blocks.map((value) =>
    value.type === 'action' ? value.call.presentation.label : value.text), [
    'Task\n\nRequest for chronological-turn',
    'Planning the edit.',
    'Edited a.ts',
    'Checking the result.',
    'Ran npm test',
  ]);
});

test('Codex command actions become friendly file activity and hide the shell wrapper', () => {
  const turn = frame('command-actions-turn', 'root-execution', 'completed', 'Done.');
  turn.passes = [{
    passId: 'message-1',
    ordinal: 0,
    state: 'completed',
    blocks: [block('read-block', 0, 'tool', {
      kind: 'tool',
      tool: {
        callId: 'read-call',
        name: 'shell',
        category: 'shell',
        title: "/bin/bash -lc 'nl -ba src/a.ts'",
      },
      inputPreview: {
        command: "/bin/bash -lc 'nl -ba src/a.ts'",
        cwd: '/workspace/remux',
        commandActions: [{
          type: 'read', command: 'nl -ba src/a.ts', name: 'a.ts', path: 'src/a.ts',
        }],
      },
    })],
  }];

  const scope = projectNativeChildExecutionScope('conversation-1', {
    conversationId: 'conversation-1', strandId: 'strand-fixture', executionId: 'root-execution', activeTurnId: null,
    turnOrder: [turn.turnId], turns: [turn],
    window: { startIndex: 0, endIndexExclusive: 1, hasEarlier: false, hasLater: false },
  }, {
    type: 'executionScope', protocolVersion: AGENT_TRANSCRIPT_PROTOCOL_VERSION, turnId: turn.turnId, scopeId: 'root-execution',
  }, 1);
  const action = scope.inferences[0]?.blocks.find((value) => value.type === 'action');
  assert.ok(action?.type === 'action');
  if (action?.type !== 'action') return;
  assert.equal(action.call.presentation.category, 'read');
  assert.equal(action.call.presentation.label, 'Read a.ts');
  assert.equal(action.call.presentation.subject, 'src/a.ts');
});

function block(
  blockId: string,
  ordinal: number,
  kind: NativeAgentTurnFrame['passes'][number]['blocks'][number]['kind'],
  payload: NativeAgentTurnFrame['passes'][number]['blocks'][number]['payload'],
): NativeAgentTurnFrame['passes'][number]['blocks'][number] {
  return {
    blockId, passId: 'message-1', ordinal, kind, state: 'completed', revision: 1,
    payload, startedAt: 10 + ordinal, completedAt: 11 + ordinal,
  };
}

function frame(
  turnId: string,
  executionId: string,
  state: NativeAgentTurnFrame['state'],
  assistantText: string,
): NativeAgentTurnFrame {
  return {
    turnId,
    pathEntryId: `path-${turnId}`,
    strandId: 'strand-fixture',
    ordinal: 0,
    clientMessageId: `message-${turnId}`,
    executionId,
    state,
    ...(state === 'completed' ? { outcome: 'completed' as const } : {}),
    userContent: [{ type: 'text', text: `Request for ${turnId}` }],
    ordering: 'legacy-grouped',
    passes: [],
    finalBlockId: null,
    activity: {
      reasoning: '',
      commentary: '',
      operations: [],
      fileChanges: [],
      web: [],
      children: [],
      notices: [],
      compacted: false,
    },
    assistantText,
    startedAt: 10,
    completedAt: state === 'running' ? undefined : 20,
    renderRevision: `${turnId}:render`,
    layoutRevision: `${turnId}:layout`,
  };
}
