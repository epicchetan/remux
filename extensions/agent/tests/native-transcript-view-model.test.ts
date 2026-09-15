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

test('recovering turns retain work but suppress running scope and unconfirmed tool activity', () => {
  const turn = frame('recovering-turn', 'root-execution', 'recovering', '');
  turn.activity.operations = [{ eventId: 'pending-tool', tool: { callId: 'pending-tool', name: 'shell', category: 'shell' },
    state: 'running', startedAt: 1 }];
  const work = projectNativeTurn(turn).segments.find((segment) => segment.type === 'work');
  assert.ok(work && work.type === 'work');
  assert.equal(work.state, 'recovering');
  const scope = projectNativeExecutionScope('conversation-1', turn, { type: 'executionScope',
    protocolVersion: AGENT_TRANSCRIPT_PROTOCOL_VERSION, turnId: turn.turnId, scopeId: 'root-execution' }, 1);
  assert.equal(scope.state, 'recovering');
  const action = scope.inferences.flatMap(({ blocks }) => blocks).find((block) => block.type === 'action');
  assert.ok(action && action.type === 'action');
  assert.equal(action.call.status, 'recovering');
  assert.equal(turn.activity.operations[0]?.state, 'running', 'projection preserves original provider evidence');
});

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

test('unclaimed watched file changes collapse into one summary row instead of one call per file', () => {
  const turn = frame('watched-turn', 'root-execution', 'completed', 'Done.');
  turn.passes = [{
    passId: 'message-1', ordinal: 0, state: 'completed',
    blocks: [block('build', 0, 'tool', {
      kind: 'tool',
      tool: { callId: 'build-call', name: 'shell', category: 'shell', title: 'npm run build' },
      inputPreview: { command: 'npm run build', cwd: '/workspace/remux', commandActions: [] },
    })],
  }];
  turn.activity.fileChanges = [
    ...Array.from({ length: 40 }, (_, index) => ({ path: `dist/chunk-${index}.js`, kind: 'add' as const })),
    { path: 'src/edited.ts', kind: 'update' as const, diffArtifactId: 'b'.repeat(64) },
  ];
  const scope = projectNativeChildExecutionScope('conversation-1', {
    conversationId: 'conversation-1', strandId: 'strand-fixture', executionId: 'root-execution', activeTurnId: null,
    turnOrder: [turn.turnId], turns: [turn],
    window: { startIndex: 0, endIndexExclusive: 1, hasEarlier: false, hasLater: false },
  }, {
    type: 'executionScope', protocolVersion: AGENT_TRANSCRIPT_PROTOCOL_VERSION, turnId: turn.turnId, scopeId: 'root-execution',
  }, 1);
  const calls = scope.inferences.flatMap(({ blocks }) => blocks.flatMap((value) => value.type === 'action' ? [value.call] : []));
  assert.deepEqual(calls.map((call) => call.presentation.label), ['Ran npm run build', 'Edited edited.ts', 'Added 40 files']);
  assert.equal(calls[2]?.detailPreview?.split('\n').length, 13);
  assert.equal(calls[2]?.hasDetail, false);
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

test('shell descriptions survive projection while command fallbacks stay compact and exact arguments remain accessible', () => {
  const turn = frame('shell-descriptions', 'root-execution', 'completed', 'Done.');
  const longCommand = `rg ${'snapshot '.repeat(40)}delivery.rs`;
  turn.passes = [{ passId: 'pass', ordinal: 0, state: 'completed', blocks: [
    block('claude', 0, 'tool', {
      kind: 'tool', tool: { callId: 'claude', name: 'Bash', category: 'shell', title: 'Inspect snapshot delivery' },
      inputPreview: { command: 'rg snapshot delivery.rs', description: 'Inspect snapshot delivery' },
    }),
    block('codex', 1, 'tool', {
      kind: 'tool', tool: { callId: 'codex', name: 'shell', category: 'shell', title: longCommand },
      inputPreview: { command: longCommand },
    }),
  ] }];
  const scope = projectNativeExecutionScope('conversation-1', turn, {
    type: 'executionScope', protocolVersion: AGENT_TRANSCRIPT_PROTOCOL_VERSION,
    turnId: turn.turnId, scopeId: 'root-execution',
  }, 1);
  const calls = scope.inferences.flatMap(p => p.blocks.flatMap(b => b.type === 'action' ? [b.call] : []));
  assert.equal(calls[0]?.presentation.label, 'Inspect snapshot delivery');
  assert.equal(calls[1]?.presentation.label, `Ran ${longCommand.slice(0, 160)}…`);
  assert.equal(JSON.parse(calls[1]!.detailPreview!).command, longCommand);
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


test('additional input divides display work without changing turn or native block identity', () => {
  const turn = frame('input-turn', 'root-execution', 'completed', 'Done');
  turn.passes = [{ passId: 'native-message', ordinal: 0, state: 'completed', blocks: [
    block('before', 0, 'commentary', { kind: 'commentary', text: 'Earlier work' }),
    block('after', 1, 'commentary', { kind: 'commentary', text: 'Work after input' }),
    block('final', 2, 'final-message', { kind: 'final-message', text: 'Done' }),
  ] }];
  turn.finalBlockId = 'final';
  turn.additionalMessages = [{ clientMessageId: 'followup', afterBlockId: 'before',
    content: [{ type: 'text', text: 'Focus on auth' }] }];
  const result = projectNativeTurn(turn);
  assert.equal(result.id, 'input-turn');
  assert.deepEqual(result.segments.map(s=>s.type), ['userMessage', 'work', 'userMessage', 'work', 'assistantMessage']);
  const work = result.segments.filter(s=>s.type==='work');
  assert.deepEqual(work.map(s=>s.scopeId), ['root-execution', 'input:followup']);
  const scopes = work.map(s=>projectNativeExecutionScope('conversation',turn,{
    type:'executionScope',protocolVersion:AGENT_TRANSCRIPT_PROTOCOL_VERSION,turnId:turn.turnId,scopeId:s.scopeId,
  },1));
  assert.deepEqual(scopes.map(s=>s.inferences.flatMap(i=>i.blocks.map(b=>b.id))), [['before'],['after']]);
  assert.equal(result.segments.at(-1)?.id, 'assistant:input-turn');
  const again = projectNativeTurn({...turn,renderRevision:'updated'});
  assert.deepEqual(again.segments.map(s=>s.id), result.segments.map(s=>s.id));
});

for (const origin of ['native-followup', 'federation-notification'] as const) {
  test(`${origin} uses a notice segment without a user message`, () => {
    const turn = frame('continued', 'root', 'completed', 'Child result reviewed.');
    turn.origin = origin;
    turn.trigger = { kind: origin === 'native-followup' ? 'native-child' : 'federation', childExecutionId: 'astra' };
    turn.inputItems = [{ type: 'notice', clientMessageId: turn.clientMessageId, afterBlockId: null,
      origin, trigger: turn.trigger, text: 'Continued after Astra finished', elapsedMs: 20_000 }];
    const projected = projectNativeTurn(turn);
    assert.deepEqual(projected.segments.filter(segment => segment.type === 'userMessage'), []);
    const notice = projected.segments[0]!;
    assert.equal(notice.type, 'notice');
    assert.ok(notice.type === 'notice');
    assert.equal(notice.text, 'Continued after Astra finished');
    assert.equal(notice.elapsedMs, 20_000);
    assert.ok(projected.segments.some(segment => segment.type === 'assistantMessage'));
  });
}

test('fallback notifications delivered during a user turn render as inline notices', () => {
  const turn = frame('user-turn', 'root', 'completed', 'Child result reviewed.');
  turn.inputItems = [{ type: 'notice', clientMessageId: 'notification', afterBlockId: null,
    origin: 'federation-notification', trigger: { kind: 'federation', childExecutionId: 'astra' },
    text: 'Continued after Astra finished' }];
  const projected = projectNativeTurn(turn);
  assert.equal(projected.segments.filter(segment => segment.type === 'userMessage').length, 1);
  assert.equal(projected.segments.filter(segment => segment.type === 'notice').length, 1);
});

test('a backgrounded federation tool row says waiting in background until completion', () => {
  const turn = frame('spawn-turn', 'root', 'completed', 'Waiting.');
  turn.passes = [{ passId: 'spawn-pass', ordinal: 0, state: 'completed', blocks: [{
    blockId: 'spawn-tool', passId: 'spawn-pass', ordinal: 0, kind: 'tool', state: 'running', revision: 1,
    startedAt: 1, completedAt: null, payload: { kind: 'tool', backgrounded: true,
      tool: { callId: 'spawn-call', name: 'mcp__remux-federation__remux_spawn_agent', category: 'collaboration' } },
  }] }];
  const scope = projectNativeExecutionScope('conversation-1', turn, { type: 'executionScope',
    protocolVersion: AGENT_TRANSCRIPT_PROTOCOL_VERSION, turnId: turn.turnId, scopeId: 'root' }, 1);
  const action = scope.inferences.flatMap(pass => pass.blocks).find(block => block.type === 'action');
  assert.ok(action?.type === 'action');
  assert.equal(action.call.presentation.subject, 'Waiting in background');
});

test('a positioned compaction notice splits the work and replaces the trailing compaction notice', () => {
  const turn = frame('compacted-turn', 'root', 'completed', 'Done');
  turn.passes = [{ passId: 'native-message', ordinal: 0, state: 'completed', blocks: [
    block('before', 0, 'tool', { kind: 'tool', tool: { callId: 'before', name: 'shell', category: 'shell' } }),
    block('after', 1, 'tool', { kind: 'tool', tool: { callId: 'after', name: 'shell', category: 'shell' } }),
    block('final', 2, 'final-message', { kind: 'final-message', text: 'Done' }),
  ] }];
  turn.finalBlockId = 'final';
  turn.activity.compacted = true;
  turn.inputItems = [{ type: 'notice', clientMessageId: 'compaction:op-1', afterBlockId: 'before',
    origin: 'compaction', text: 'Compacted 269k → 8k tokens', createdAt: 11 }];
  const projected = projectNativeTurn(turn);
  assert.deepEqual(projected.segments.map((segment) => segment.type),
    ['userMessage', 'work', 'notice', 'work', 'assistantMessage']);
  const notices = projected.segments.filter((segment) => segment.type === 'notice');
  assert.equal(notices.length, 1);
  assert.ok(notices[0]?.type === 'notice');
  assert.equal(notices[0].text, 'Compacted 269k → 8k tokens');
  const work = projected.segments.filter((segment) => segment.type === 'work');
  assert.ok(work[0]?.type === 'work' && work[1]?.type === 'work');
  assert.equal(work[0].durationMs, 1, 'each section reports its own span');
  assert.equal(work[1].durationMs, 2);
  for (const section of work) {
    const scope = projectNativeExecutionScope('conversation', turn, { type: 'executionScope',
      protocolVersion: AGENT_TRANSCRIPT_PROTOCOL_VERSION, turnId: turn.turnId, scopeId: section.scopeId }, 1);
    assert.equal(scope.inferences.some((pass) => pass.id.startsWith('compaction:')), false,
      'the positioned notice replaces the trailing compatibility notice');
  }
});
