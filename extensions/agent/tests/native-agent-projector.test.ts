import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { NativeAgentJournal } from '../server/src/native-runtime/native-journal.ts';
import { NativeAgentProjector } from '../server/src/native-runtime/native-projector.ts';
import { createNativeAgentSchema } from '../server/src/native-runtime/schema.ts';
import { projectNativeRuntime } from '../viewer/src/nativeViewModel.ts';
import {
  NATIVE_AGENT_LIMITS,
  type AgentRuntimeResource,
  type NativeAgentResourceKey,
  type NativeAgentTurnFrame,
  type NativeTranscriptWindow,
} from '../shared/native-agent-protocol.ts';
import {
  PROVIDER_RUNTIME_CONTRACT_VERSION,
  type ProviderCapabilities,
  type ProviderEvent,
  type ProviderEventEnvelope,
} from '../shared/provider-runtime.ts';

test('native projector turns normalized events into provider-private-free virtualized frames', () => {
  const journal = createJournal();
  try {
    seed(journal);
    journal.appendProviderEvent(event('delta-1', 4, {
      type: 'turn.block.started',
      structure: structure('assistant-1', 0),
      block: {
        kind: 'final-message', state: 'streaming',
        payload: { kind: 'final-message', text: 'Hel' },
      },
    }, 'assistant-1'));
    journal.appendProviderEvent(event('tool-start', 5, {
      type: 'turn.block.started',
      structure: structure('tool-1', 1),
      block: {
        kind: 'tool', state: 'running',
        payload: {
          kind: 'tool',
          tool: { callId: 'tool-1', name: 'shell', category: 'shell', title: 'Run tests' },
          inputPreview: { command: 'npm test' },
        },
      },
    }, 'tool-1'));
    journal.appendProviderEvent(event('tool-output', 6, {
      type: 'turn.block.revised',
      structure: structure('tool-1', 1),
      revision: 1,
      contentHash: 'a'.repeat(64),
      block: {
        kind: 'tool', state: 'running',
        payload: {
          kind: 'tool',
          tool: { callId: 'tool-1', name: 'shell', category: 'shell', title: 'Run tests' },
          inputPreview: { command: 'npm test' },
          outputPreview: { delta: 'ok' },
        },
      },
    }, 'tool-1'));
    journal.appendProviderEvent(event('tool-complete', 7, {
      type: 'turn.block.completed',
      structure: structure('tool-1', 1),
      revision: 2,
      contentHash: 'b'.repeat(64),
      block: {
        kind: 'tool', state: 'completed',
        payload: {
          kind: 'tool',
          tool: { callId: 'tool-1', name: 'shell', category: 'shell', title: 'Run tests' },
          inputPreview: { command: 'npm test' },
          outputPreview: { delta: 'ok' },
        },
      },
    }, 'tool-1'));
    journal.appendProviderEvent(event('file-with-diff', 8, {
      type: 'turn.file-changed',
      change: { path: 'src/a.ts', kind: 'update', diffArtifactId: 'e'.repeat(64) },
      blockId: 'provider-file-block',
    }, 'file-1'));
    journal.appendProviderEvent(event('file-metadata-repeat', 9, {
      type: 'turn.file-changed',
      change: { path: 'src/a.ts', kind: 'update' },
      blockId: 'provider-file-block',
    }, 'file-1'));
    journal.appendProviderEvent(event('child-start', 8, {
      type: 'turn.block.started',
      structure: structure('child-native-item', 2),
      block: {
        kind: 'native-child', state: 'running',
        payload: {
          kind: 'native-child',
          child: {
            executionId: 'child-1',
            ownership: 'native',
            provider: 'fixture',
            providerInstanceId: 'fixture-local',
            title: 'Reviewer',
            nativeSessionId: 'private-native-child',
          },
          executionState: 'running',
        },
      },
    }, 'child-native-item'));
    journal.appendProviderEvent(event('assistant-final', 9, {
      type: 'turn.block.completed',
      structure: structure('assistant-1', 0),
      revision: 1,
      contentHash: 'c'.repeat(64),
      block: {
        kind: 'final-message', state: 'completed',
        payload: { kind: 'final-message', text: 'Hello.' },
      },
    }, 'assistant-1'));
    journal.appendProviderEvent(event('assistant-final-latest', 10, {
      type: 'turn.block.completed',
      structure: structure('assistant-2', 3),
      revision: 1,
      contentHash: 'd'.repeat(64),
      block: {
        kind: 'final-message', state: 'completed',
        payload: { kind: 'final-message', text: 'Final answer.' },
      },
    }, 'assistant-2'));
    journal.appendProviderEvent(event('turn-complete', 11, {
      type: 'turn.completed', outcome: 'completed',
    }));

    const projector = new NativeAgentProjector(journal);
    projector.setModels('fixture-local', [{
      id: 'fixture-v1',
      name: 'Fixture v1',
      provider: 'fixture',
      supportedEffort: ['high'],
      isDefault: true,
    }]);
    const activeStrandId = journal.conversationHead('conversation-1')!.strandId;
    const strandTranscriptKey = `agent/strand-transcript:${encodeURIComponent('conversation-1')}:${encodeURIComponent(activeStrandId)}:tail-24` as NativeAgentResourceKey;
    const first = projector.read({
      requests: [
        { key: 'agent/providers' },
        { key: 'agent/models:fixture-local' },
        { key: 'agent/runtime:conversation-1' },
        { key: 'agent/transcript:conversation-1:tail-24' },
        { key: strandTranscriptKey },
        { key: 'agent/execution:child-1' },
      ],
    });
    assert.ok(first.resources.every(({ status }) => status === 'ok'));
    const transcript = first.resources.find(({ key }) =>
      key === 'agent/transcript:conversation-1:tail-24');
    assert.equal(transcript?.status, 'ok');
    if (transcript?.status !== 'ok') return;
    const value = transcript.value as NativeTranscriptWindow;
    assert.equal(value.turns[0]?.assistantText, 'Final answer.');
    assert.equal(value.turns[0]?.finalBlockId, structure('assistant-2', 3).blockId);
    assert.equal(value.turns[0]?.activity.operations[0]?.state, 'completed');
    assert.equal(value.turns[0]?.activity.operations[0]?.outputPreview, undefined,
      'compatibility metadata does not duplicate ordered tool previews');
    const orderedTool = value.turns[0]?.passes.flatMap(({ blocks }) => blocks)
      .find(({ blockId }) => blockId === structure('tool-1', 1).blockId);
    assert.equal(orderedTool?.payload.kind, 'tool');
    if (orderedTool?.payload.kind === 'tool') {
      assert.equal(orderedTool.payload.outputPreview, undefined,
        'tail summaries defer tool output until the operation is expanded');
      assert.equal(orderedTool.payload.detailRef, structure('tool-1', 1).blockId);
    }
    const summaryTurn = projector.project('agent/turn:turn-1:summary') as NativeAgentTurnFrame;
    const summaryTool = summaryTurn.passes.flatMap(({ blocks }) => blocks)
      .find(({ blockId }) => blockId === structure('tool-1', 1).blockId);
    assert.equal(summaryTool?.payload.kind, 'tool');
    if (summaryTool?.payload.kind === 'tool') {
      assert.equal(summaryTool.payload.outputPreview, undefined);
      assert.equal(summaryTool.payload.detailRef, structure('tool-1', 1).blockId);
    }
    const detailedTurn = projector.project('agent/turn:turn-1') as NativeAgentTurnFrame;
    const detailedTool = detailedTurn.passes.flatMap(({ blocks }) => blocks)
      .find(({ blockId }) => blockId === structure('tool-1', 1).blockId);
    assert.equal(detailedTool?.payload.kind, 'tool');
    if (detailedTool?.payload.kind === 'tool') {
      assert.deepEqual(detailedTool.payload.outputPreview, { delta: 'ok' });
    }
    assert.deepEqual(value.turns[0]?.activity.fileChanges, [{
      path: 'src/a.ts', kind: 'update', diffArtifactId: 'e'.repeat(64),
      blockId: 'provider-file-block',
    }]);
    assert.equal(value.turns[0]?.activity.children[0]?.state, 'running');
    assert.doesNotMatch(JSON.stringify(first), /private-native-child|resumeCursor|nativeSession/iu);
    const historical = first.resources.find(({ key }) => key === strandTranscriptKey);
    assert.equal(historical?.status, 'ok');
    if (historical?.status === 'ok') {
      const historicalValue = historical.value as NativeTranscriptWindow;
      assert.equal(historicalValue.strandId, activeStrandId);
      assert.equal(historicalValue.activeTurnId, null);
      assert.equal(historicalValue.turns[0]?.assistantText, 'Final answer.');
    }

    const revisions = new Map(first.resources.flatMap((resource) =>
      resource.status === 'ok' ? [[resource.key, resource.revision] as const] : []));
    const second = projector.read({
      knownServerGeneration: first.serverGeneration,
      capabilityRevision: first.capabilityRevision,
      requests: [...revisions].map(([key, revision]) => ({ key, ifNoneMatch: revision })),
    });
    assert.ok(second.resources.every(({ status }) => status === 'notModified'));

    const afterWebViewRecreation = projector.read({
      knownServerGeneration: 'old-webview-generation',
      capabilityRevision: first.capabilityRevision,
      focusedConversationId: 'conversation-1',
      visibility: 'foreground',
      requests: [{
        key: 'agent/transcript:conversation-1:tail-24',
        ifNoneMatch: revisions.get('agent/transcript:conversation-1:tail-24'),
      }],
    });
    assert.equal(afterWebViewRecreation.resources[0]?.status, 'ok');
    assert.deepEqual(afterWebViewRecreation.changedKeys, ['agent/transcript:conversation-1:tail-24']);

    const layoutBeforeUsage = value.turns[0]!.layoutRevision;
    const renderBeforeUsage = value.turns[0]!.renderRevision;
    journal.appendProviderEvent(event('usage-after-terminal', 12, {
      type: 'turn.usage-updated',
      usage: {
        turn: null,
        cumulative: null,
        context: {
          usedTokens: 50_000, windowTokens: 100_000, percent: 50,
          measurement: 'provider', freshness: 'live', observedAt: 12, turnId: 'turn-1',
        },
        estimatedCost: null,
      },
    }));
    const afterUsage = projector.project(
      'agent/transcript:conversation-1:tail-24',
    ) as NativeTranscriptWindow;
    assert.notEqual(afterUsage.turns[0]?.renderRevision, renderBeforeUsage,
      'usage is part of the semantic turn revision');
    assert.equal(afterUsage.turns[0]?.layoutRevision, layoutBeforeUsage,
      'usage-only updates do not invalidate measured transcript geometry');
  } finally {
    journal.close();
  }
});

test('native runtime projects a durable elapsed anchor without revision churn', () => {
  const journal = createJournal();
  try {
    seed(journal);
    let now = 5_003;
    const projector = new NativeAgentProjector(journal, () => now);
    const key = 'agent/runtime:conversation-1' as const;

    const first = projector.read({ requests: [{ key }] }).resources[0];
    assert.equal(first?.status, 'ok');
    if (first?.status !== 'ok') return;
    const firstRuntime = first.value as AgentRuntimeResource;
    assert.equal(firstRuntime.activeTurnElapsedMs, 5_000);
    assert.equal(projectNativeRuntime(firstRuntime)?.activeTurnElapsedMs, 5_000);

    now = 8_003;
    const conditional = projector.read({
      knownServerGeneration: projector.serverGeneration,
      requests: [{ key, ifNoneMatch: first.revision }],
    }).resources[0];
    assert.equal(conditional?.status, 'notModified',
      'elapsed time alone does not change the semantic runtime revision');

    const refreshed = projector.read({ requests: [{ key }] }).resources[0];
    assert.equal(refreshed?.status, 'ok');
    if (refreshed?.status !== 'ok') return;
    assert.equal(refreshed.revision, first.revision);
    assert.equal((refreshed.value as AgentRuntimeResource).activeTurnElapsedMs, 8_000,
      'an unconditional refresh receives a current anchor from durable startedAt');

    now = 9_003;
    journal.appendProviderEvent(event('turn-complete-timing', now, {
      type: 'turn.completed', outcome: 'completed',
    }));
    const completed = projector.runtimeResource('conversation-1');
    assert.equal(completed?.activeTurnId, null);
    assert.equal(completed?.activeTurnElapsedMs, null);
  } finally {
    journal.close();
  }
});

test('native projector answers clean conditional reads without rebuilding the resource', () => {
  const journal = createJournal();
  try {
    seed(journal);
    const projector = new NativeAgentProjector(journal);
    const key = 'agent/transcript:conversation-1:tail-24' as const;
    const originalEventsForTurn = journal.eventsForTurn.bind(journal);
    let projectionReads = 0;
    let usedSummaryRead = false;
    journal.eventsForTurn = (turnId, options) => {
      projectionReads += 1;
      usedSummaryRead ||= options?.includeToolOutputPreviews === false;
      return originalEventsForTurn(turnId, options);
    };

    const first = projector.read({ requests: [{ key }] }).resources[0];
    assert.equal(first?.status, 'ok');
    if (first?.status !== 'ok') return;
    assert.ok(projectionReads > 0);
    assert.equal(usedSummaryRead, true);

    projectionReads = 0;
    const clean = projector.read({
      knownServerGeneration: projector.serverGeneration,
      requests: [{ key, ifNoneMatch: first.revision }],
    }).resources[0];
    assert.equal(clean?.status, 'notModified');
    assert.equal(projectionReads, 0);

    projector.invalidate([key]);
    const invalidated = projector.read({
      knownServerGeneration: projector.serverGeneration,
      requests: [{ key, ifNoneMatch: first.revision }],
    }).resources[0];
    assert.equal(invalidated?.status, 'notModified');
    assert.ok(projectionReads > 0);
  } finally {
    journal.close();
  }
});

test('native projector invalidates every cached summary for a changed transcript or turn', () => {
  const journal = createJournal();
  try {
    seed(journal);
    const projector = new NativeAgentProjector(journal);
    const alternateKey = 'agent/transcript:conversation-1:tail-1' as const;
    const initial = projector.read({ requests: [{ key: alternateKey }] }).resources[0];
    const summaryKey = 'agent/turn:turn-1:summary' as const;
    const initialSummary = projector.read({ requests: [{ key: summaryKey }] }).resources[0];
    assert.equal(initial?.status, 'ok');
    assert.equal(initialSummary?.status, 'ok');
    if (initial?.status !== 'ok' || initialSummary?.status !== 'ok') return;

    let projectionReads = 0;
    const originalEventsForTurn = journal.eventsForTurn.bind(journal);
    journal.eventsForTurn = ((
      turnId: string,
      options: Parameters<typeof journal.eventsForTurn>[1],
    ) => {
      projectionReads += 1;
      return originalEventsForTurn(turnId, options);
    }) as typeof journal.eventsForTurn;

    projector.invalidate([
      'agent/transcript:conversation-1:tail-24',
      'agent/turn:turn-1',
    ]);
    const refreshed = projector.read({
      requests: [
        { key: alternateKey, ifNoneMatch: initial.revision },
        { key: summaryKey, ifNoneMatch: initialSummary.revision },
      ],
    }).resources;
    assert.ok(refreshed.every(({ status }) => status === 'notModified'));
    assert.ok(projectionReads > 0);
  } finally {
    journal.close();
  }
});

test('standalone compaction moves from the transcript tail to before the next user turn', () => {
  const journal = createJournal();
  try {
    seed(journal);
    journal.appendProviderEvent(event('turn-1-complete', 10, {
      type: 'turn.completed', outcome: 'completed',
    }));
    journal.appendProviderEvent(controlEvent('compact-started', 12, {
      type: 'context.compaction.started', trigger: 'manual',
      operationId: 'compact-between', beforeTokens: 80_000,
    }));
    journal.appendProviderEvent(controlEvent('compact-completed', 13, {
      type: 'context.compaction.completed', trigger: 'manual',
      operationId: 'compact-between', beforeTokens: 80_000, afterTokens: 9_000,
    }));

    const projector = new NativeAgentProjector(journal);
    const trailing = projector.project(
      'agent/transcript:conversation-1:tail-24',
    ) as NativeTranscriptWindow;
    assert.equal(trailing.turns[0]?.boundaryCompactions?.afterTurn[0]?.operationId,
      'compact-between');
    assert.equal(trailing.turns[0]?.boundaryCompactions?.afterTurn[0]?.state, 'completed');

    journal.claimCommand('send-2', 'turn.send', { content: 'Continue.' }, 19);
    journal.createTurn({
      turnId: 'turn-2', conversationId: 'conversation-1', executionId: 'execution-1',
      clientMessageId: 'message-2', commandId: 'send-2',
      content: [{ type: 'text', text: 'Continue.' }], model: 'fixture-native-v1',
      state: 'running', now: 20,
    });
    const withNextTurn = projector.project(
      'agent/transcript:conversation-1:tail-24',
    ) as NativeTranscriptWindow;
    assert.equal(withNextTurn.turns[0]?.boundaryCompactions, undefined);
    assert.equal(withNextTurn.turns[1]?.boundaryCompactions?.beforeUser[0]?.operationId,
      'compact-between');
    assert.equal(withNextTurn.turns[1]?.boundaryCompactions?.beforeUser[0]?.createdAt, 12,
      'placement uses the operation start rather than its terminal notification');
  } finally {
    journal.close();
  }
});

test('native projector bounds terminal UTF-8 text and exposes its exact viewer artifact', () => {
  const journal = createJournal();
  try {
    seed(journal);
    const assistantText = `${'a'.repeat((48 * 1024) - 1)}🙂${'z'.repeat(8 * 1024)}`;
    const bytes = Buffer.from(assistantText, 'utf8');
    const sha256 = 'a'.repeat(64);
    journal.appendProviderEvent(event('assistant-large', 4, {
      type: 'turn.block.completed',
      structure: structure('assistant-large', 0),
      revision: 1,
      contentHash: 'd'.repeat(64),
      block: {
        kind: 'final-message', state: 'completed',
        payload: { kind: 'final-message', text: assistantText },
      },
    }, 'assistant-large'));
    journal.appendProviderEvent(event('turn-complete-large', 5, {
      type: 'turn.completed', outcome: 'completed',
    }));
    journal.registerArtifact({
      artifactId: sha256,
      sha256,
      byteLength: bytes.byteLength,
      mediaType: 'text/plain; charset=utf-8',
      visibility: 'viewer',
      storagePath: `sha256/${sha256.slice(0, 2)}/${sha256}`,
      createdAt: 5,
    });
    journal.setTurnAssistantArtifact('turn-1', sha256, 5);

    const projected = new NativeAgentProjector(journal).project(
      'agent/transcript:conversation-1:tail-24',
    ) as NativeTranscriptWindow;
    const turn = projected.turns[0]!;
    assert.ok(Buffer.byteLength(turn.assistantText, 'utf8') <= 48 * 1024);
    assert.doesNotMatch(turn.assistantText, /�/u);
    assert.equal(turn.assistantContent?.artifactId, sha256);
    assert.equal(turn.assistantContent?.byteLength, bytes.byteLength);
    assert.equal(turn.assistantContent?.returnedBytes, Buffer.byteLength(turn.assistantText, 'utf8'));
    assert.equal(turn.assistantContent?.nextOffset, turn.assistantContent?.returnedBytes);
  } finally {
    journal.close();
  }
});

test('native projector keeps dense ordered tool transcripts below the viewer resource limit', () => {
  const journal = createJournal();
  try {
    seed(journal);
    const output = 'x'.repeat(30 * 1024);
    for (let index = 0; index < 150; index += 1) {
      const blockId = `dense-tool-${index}`;
      journal.appendProviderEvent(event(`dense-event-${index}`, 4 + index, {
        type: 'turn.block.completed',
        structure: structure(blockId, index),
        revision: 1,
        contentHash: `${index}`.padStart(64, '0'),
        block: {
          kind: 'tool', state: 'completed',
          payload: {
            kind: 'tool',
            tool: {
              callId: blockId,
              name: 'shell',
              category: 'shell',
              title: `Command ${index}`,
            },
            inputPreview: { command: `command-${index}` },
            outputPreview: { delta: output },
          },
        },
      }, blockId));
    }

    const resource = new NativeAgentProjector(journal).read({
      requests: [{ key: 'agent/transcript:conversation-1:tail-24' }],
    }).resources[0];
    assert.equal(resource?.status, 'ok');
    if (resource?.status !== 'ok') return;
    const value = resource.value as NativeTranscriptWindow;
    assert.ok(Buffer.byteLength(JSON.stringify(value), 'utf8') < NATIVE_AGENT_LIMITS.resourceBytes);
    assert.equal(value.turns[0]?.passes[0]?.blocks.length, 150);
    assert.equal(value.turns[0]?.activity.operations.length, 150);
    assert.equal(value.turns[0]?.activity.operations[0]?.outputPreview, undefined);
  } finally {
    journal.close();
  }
});

test('native projector paginates a dense transcript before it can overflow the RPC frame', () => {
  const journal = createJournal();
  try {
    seed(journal);
    appendDenseTools(journal, 'turn-1', 0, 200, true);
    journal.appendProviderEvent(event('dense-turn-1-complete', 200, {
      type: 'turn.completed', outcome: 'completed',
    }));
    journal.claimCommand('send-2-dense', 'turn.send', { content: 'Continue.' }, 201);
    journal.createTurn({
      turnId: 'turn-2-dense',
      conversationId: 'conversation-1',
      executionId: 'execution-1',
      clientMessageId: 'message-2-dense',
      commandId: 'send-2-dense',
      content: [{ type: 'text', text: 'Continue.' }],
      model: 'fixture-native-v1',
      state: 'running',
      now: 202,
    });
    appendDenseTools(journal, 'turn-2-dense', 250, 200, true);

    const resource = new NativeAgentProjector(journal).read({
      requests: [{ key: 'agent/transcript:conversation-1:tail-24' }],
    }).resources[0];
    assert.equal(resource?.status, 'ok');
    if (resource?.status !== 'ok') return;
    const value = resource.value as NativeTranscriptWindow;
    assert.ok(Buffer.byteLength(JSON.stringify(value), 'utf8') < NATIVE_AGENT_LIMITS.resourceBytes);
    assert.deepEqual(value.turns.map(({ turnId }) => turnId), ['turn-2-dense']);
    assert.equal(value.window.startIndex, 1);
    assert.equal(value.window.hasEarlier, true);
    assert.equal(value.window.hasLater, false);
  } finally {
    journal.close();
  }
});

test('composer selection follows conversation, last-used, provider, default precedence and repairs removal', () => {
  const journal = createJournal();
  try {
    const providerCapabilities = capabilities();
    providerCapabilities.turns.changeModelOnExistingSession = true;
    providerCapabilities.turns.changeEffortOnExistingSession = true;
    journal.upsertProviderInstance({
      providerInstanceId: 'fixture-local',
      provider: 'fixture',
      label: 'Fixture',
      probe: { state: 'ready', capabilities: providerCapabilities },
      now: 1,
    });
    journal.createConversation({
      conversationId: 'conversation-precedence',
      rootExecutionId: 'execution-precedence',
      provider: 'fixture',
      providerInstanceId: 'fixture-local',
      title: 'Precedence',
      cwd: '/workspace/remux',
      model: 'model-a',
      effort: 'low',
      access: 'workspace-write',
      now: 1,
    });
    const projector = new NativeAgentProjector(journal);
    projector.setModels('fixture-local', [
      {
        id: 'model-a', name: 'Model A', provider: 'fixture',
        supportedEffort: ['low', 'high'], isDefault: true,
      },
      {
        id: 'model-b', name: 'Model B', provider: 'fixture',
        supportedEffort: ['medium', 'xhigh'],
      },
    ]);
    assert.deepEqual(projector.runtimeResource('conversation-precedence')?.composer.nextTurn, {
      model: 'model-a', effort: 'high', access: 'workspace-write', origin: 'provider-default',
    });

    journal.setComposerPreference({
      scope: 'provider', scopeId: 'fixture-local', providerInstanceId: 'fixture-local',
      model: 'model-b', effort: 'xhigh', now: 2,
    });
    assert.equal(
      projector.runtimeResource('conversation-precedence')?.composer.nextTurn.origin,
      'provider-sticky',
    );

    journal.createTurn({
      turnId: 'turn-precedence',
      conversationId: 'conversation-precedence',
      executionId: 'execution-precedence',
      clientMessageId: 'message-precedence',
      commandId: 'command-precedence',
      content: [{ type: 'text', text: 'Use A.' }],
      model: 'model-a',
      effort: 'low',
      state: 'running',
      now: 3,
    });
    assert.deepEqual(projector.runtimeResource('conversation-precedence')?.composer.nextTurn, {
      model: 'model-a', effort: 'low', access: 'workspace-write', origin: 'last-used',
    });

    journal.setComposerPreference({
      scope: 'conversation', scopeId: 'conversation-precedence', providerInstanceId: 'fixture-local',
      model: 'model-b', effort: 'medium', now: 4,
    });
    assert.deepEqual(projector.runtimeResource('conversation-precedence')?.composer.nextTurn, {
      model: 'model-b', effort: 'medium', access: 'workspace-write', origin: 'conversation-explicit',
    });

    const revisionBeforeRemoval = journal.composerPreference(
      'conversation',
      'conversation-precedence',
    )!.revision;
    projector.setModels('fixture-local', [{
      id: 'model-a', name: 'Model A', provider: 'fixture', supportedEffort: ['low', 'high'], isDefault: true,
    }]);
    assert.deepEqual(projector.runtimeResource('conversation-precedence')?.composer.nextTurn, {
      model: 'model-a', effort: 'high', access: 'workspace-write', origin: 'conversation-explicit',
    });
    const repaired = journal.composerPreference('conversation', 'conversation-precedence');
    assert.equal(repaired?.model, 'model-a');
    assert.equal(repaired?.effort, 'high');
    assert.equal(repaired?.revision, revisionBeforeRemoval + 1);
  } finally {
    journal.close();
  }
});

function createJournal() {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON');
  createNativeAgentSchema(database);
  return new NativeAgentJournal(database);
}

function seed(journal: NativeAgentJournal) {
  journal.upsertProviderInstance({
    providerInstanceId: 'fixture-local',
    provider: 'fixture',
    label: 'Fixture',
    probe: { state: 'ready', capabilities: capabilities() },
    now: 1,
  });
  journal.createConversation({
    conversationId: 'conversation-1',
    rootExecutionId: 'execution-1',
    provider: 'fixture',
    providerInstanceId: 'fixture-local',
    title: 'New chat',
    cwd: '/workspace/remux',
    model: 'fixture-v1',
    effort: 'high',
    access: 'workspace-write',
    now: 1,
  });
  journal.bindNativeSession({
    executionId: 'execution-1',
    nativeSession: {
      provider: 'fixture',
      providerInstanceId: 'fixture-local',
      sessionId: 'private-root-session',
      resumeCursor: { sequence: 1 },
    },
    adapterVersion: 'adapter-v1',
    now: 2,
  });
  journal.claimCommand('send-1', 'turn.send', { content: 'Implement.' }, 3);
  journal.createTurn({
    turnId: 'turn-1',
    conversationId: 'conversation-1',
    executionId: 'execution-1',
    clientMessageId: 'message-1',
    commandId: 'send-1',
    content: [{ type: 'text', text: 'Implement.' }],
    model: 'fixture-native-v1',
    state: 'running',
    now: 3,
  });
}

function event(
  eventId: string,
  observedAt: number,
  providerEvent: ProviderEvent,
  itemId?: string,
): ProviderEventEnvelope {
  return {
    contractVersion: PROVIDER_RUNTIME_CONTRACT_VERSION,
    eventId,
    provider: 'fixture',
    scope: {
      kind: 'turn',
      providerInstanceId: 'fixture-local',
      conversationId: 'conversation-1',
      executionId: 'execution-1',
      turnId: 'turn-1',
    },
    native: {
      sessionId: 'private-root-session',
      turnId: 'native-turn-1',
      ...(itemId ? { itemId } : {}),
      position: { kind: 'native-sequence', sequence: observedAt, subIndex: 0 },
      kind: providerEvent.type,
    },
    observedAt,
    event: providerEvent,
  };
}

function appendDenseTools(
  journal: NativeAgentJournal,
  turnId: string,
  indexOffset: number,
  count: number,
  includeLargeInput = false,
) {
  const output = 'x'.repeat(30 * 1024);
  for (let offset = 0; offset < count; offset += 1) {
    const index = indexOffset + offset;
    const blockId = `window-tool-${index}`;
    const envelope = event(`window-event-${index}`, 4 + index, {
      type: 'turn.block.completed',
      structure: {
        passId: `pass-${turnId}`,
        blockId,
        passOrdinal: 0,
        blockOrdinal: offset,
      },
      revision: 1,
      contentHash: `${index}`.padStart(64, '0'),
      block: {
        kind: 'tool', state: 'completed',
        payload: {
          kind: 'tool',
          tool: {
            callId: blockId,
            name: 'shell',
            category: 'shell',
            title: `Command ${index}`,
          },
          inputPreview: {
            command: includeLargeInput ? `${`command-${index} `.repeat(2_500)}` : `command-${index}`,
          },
          outputPreview: { delta: output },
        },
      },
    }, blockId);
    journal.appendProviderEvent(turnId === 'turn-1' ? envelope : {
      ...envelope,
      scope: {
        kind: 'turn',
        providerInstanceId: 'fixture-local',
        conversationId: 'conversation-1',
        executionId: 'execution-1',
        turnId,
      },
      native: { ...envelope.native, turnId: `native-${turnId}` },
    });
  }
}

function controlEvent(
  eventId: string,
  observedAt: number,
  providerEvent: ProviderEvent,
): ProviderEventEnvelope {
  const envelope = event(eventId, observedAt, providerEvent);
  return {
    ...envelope,
    scope: {
      kind: 'conversation',
      providerInstanceId: 'fixture-local',
      conversationId: 'conversation-1',
      executionId: 'execution-1',
    },
    native: {
      ...envelope.native,
      turnId: undefined,
      kind: `control/${providerEvent.type}`,
    },
  };
}

function structure(blockId: string, blockOrdinal: number) {
  return { passId: 'pass-1', blockId, passOrdinal: 0, blockOrdinal };
}

function capabilities(): ProviderCapabilities {
  return {
    protocolVersion: PROVIDER_RUNTIME_CONTRACT_VERSION,
    provider: 'fixture',
    providerVersion: 'fixture-1',
    adapterVersion: 'adapter-v1',
    auth: 'external',
    authentication: { login: 'none', logout: false },
    session: {
      create: true,
      resume: true,
      discoverHistory: false,
      readSnapshot: true,
      forkNative: false,
      rollbackNative: false,
    },
    turns: {
      interrupt: true,
      steer: false,
      queue: false,
      changeModelOnExistingSession: false,
      changeEffortOnExistingSession: false,
    },
    content: {
      images: true,
      fileReferences: true,
      reasoning: true,
      diffs: true,
      webActivity: true,
    },
    collaboration: {
      nativeSubagents: true,
      childTranscript: 'summary',
      childSteer: false,
      childInterrupt: true,
    },
    interaction: { blockingApprovals: false, structuredUserInput: false },
    access: {
      presets: ['read-only', 'workspace-write', 'full-access'],
      defaultPreset: 'workspace-write',
    },
    usage: { turn: true, cumulative: true, context: 'derived', plan: 'push', estimatedCost: false },
    compaction: { automaticNative: false, manualNative: false },
  };
}
