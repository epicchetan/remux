import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';

import type { AssistantMessage } from '@earendil-works/pi-ai';

import { AgentServer } from '../server/src/agent-server.ts';
import { FixtureProvider } from '../server/src/fixture-provider.ts';
import type { ModelProvider, ModelSession } from '../server/src/model-provider.ts';
import { AgentStateStore } from '../server/src/storage/agent-state-store.ts';
import { canonicalJson } from '../server/src/storage/canonical-json.ts';
import type { DurableTurnHandle } from '../server/src/domain/state.ts';
import type { WorkUnitEnterInput } from '../server/src/domain/work.ts';
import type { TurnContextPlan } from '../shared/protocol.ts';
import { AGENT_STATE_TABLES } from '../server/src/storage/schema.ts';
import {
  AGENT_TRANSCRIPT_PROJECTION_VERSION,
  AGENT_TRANSCRIPT_PROTOCOL_VERSION,
} from '../shared/transcript.ts';

test('Agent state v6 owns one clean schema and compiles the accepted user turn', async (t) => {
  const fixture = await repositoryFixture(t);
  const [emptyHistory] = await fixture.repository.readResourceProjections(['conversation-list']);
  assert.equal(emptyHistory?.basisSequence, 0);
  assert.deepEqual(emptyHistory?.value, { conversations: [], truncated: false });
  const conversation = await fixture.repository.createConversation({
    operationId: crypto.randomUUID(),
    cwd: fixture.cwd,
    modelId: 'gpt-5.6-codex',
    reasoning: 'high',
  });
  const turn = await accept(fixture.repository, conversation.conversationId, 'Build the compiler.');
  const context = await fixture.repository.compileContext(conversation.conversationId);
  assert.deepEqual(context.messages.map(({ role }) => role), ['user']);
  assert.equal(context.messages[0]?.turnId, turn.turnId);
  assert.deepEqual(context.frame.selectedTurnIds, [turn.turnId]);
  assert.deepEqual(context.frame.requestedPlan, {
    version: 1, automaticDialogueTurns: 2, overrides: [],
  });

  const database = new DatabaseSync(fixture.repository.databasePath);
  t.after(() => database.close());
  const tables: string[] = (database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      AND (name = 'history_search_index' OR name NOT GLOB 'history_search_index_*')
    ORDER BY name
  `).all() as Array<{ name: string }>).map(({ name }) => name);
  const tableNames = new Set<string>(tables);
  assert.deepEqual(tables, [...AGENT_STATE_TABLES].sort());
  for (const removed of [
    'strands', 'context_spaces', 'project_primaries', 'epochs', 'context_compilations',
  ]) assert.equal(tableNames.has(removed), false);
  await fixture.repository.finishTurn(turn, { status: 'interrupted' });
});

test('obsolete context inspector projections are purged instead of migrated', async (t) => {
  const fixture = await repositoryFixture(t);
  const conversation = await fixture.repository.createConversation({
    operationId: crypto.randomUUID(),
    cwd: fixture.cwd,
    modelId: 'gpt-5.6-codex',
    reasoning: 'high',
  });
  const databasePath = fixture.repository.databasePath;
  await fixture.repository.close();

  const database = new DatabaseSync(databasePath);
  const basis = database.prepare(`SELECT MAX(sequence) AS sequence FROM events`).get() as {
    sequence: number;
  };
  database.prepare(`
    INSERT INTO resources (resource_key, basis_sequence, value_json, updated_at)
    VALUES (?, ?, ?, ?)
  `).run(
    `context:${conversation.conversationId}`,
    basis.sequence,
    canonicalJson({ conversationId: conversation.conversationId, version: 6 }),
    Date.now(),
  );
  database.close();

  fixture.repository = await AgentStateStore.open({ dataRoot: fixture.dataRoot });
  const [context, summary] = await fixture.repository.readResourceProjections([
    `context:${conversation.conversationId}`,
    `conversation:${conversation.conversationId}`,
  ]);
  assert.equal(context, null);
  assert.equal((summary?.value as { id?: string } | undefined)?.id, conversation.conversationId);

  const reopened = new DatabaseSync(databasePath, { readOnly: true });
  t.after(() => reopened.close());
  const stale = reopened.prepare(`
    SELECT COUNT(*) AS count FROM resources WHERE resource_key = ?
  `).get(`context:${conversation.conversationId}`) as { count: number };
  assert.equal(stale.count, 0);
});

test('provider compaction checkpoints survive restart and replay only the new epoch tail', async (t) => {
  const fixture = await repositoryFixture(t);
  const conversation = await fixture.repository.createConversation({
    operationId: crypto.randomUUID(), cwd: fixture.cwd, modelId: 'gpt-5.6-codex', reasoning: 'high',
  });
  const turn = await accept(
    fixture.repository,
    conversation.conversationId,
    'Carry this exact active turn through a provider checkpoint.',
  );
  const initial = await fixture.repository.compileContext(conversation.conversationId);
  assert.equal(initial.compaction.epoch, 0);
  assert.equal(initial.compaction.checkpoint, null);
  await fixture.repository.recordContextCompactionWarning(turn, {
    epoch: 0,
    estimatedInputTokens: 180_000,
    targetTokens: 220_400,
  });
  const warned = await fixture.repository.compileContext(conversation.conversationId);
  assert.equal(warned.compaction.warningIssued, true);
  await startInference(fixture.repository, turn, warned);
  const compactCallId = 'call:context-compact';
  await fixture.repository.finalizeInference(turn, {
    state: 'completed',
    providerMessage: assistantMessage({
      content: [{ type: 'toolCall', id: compactCallId, name: 'context_compact', arguments: {} }],
      stopReason: 'toolUse',
    }),
    calls: [{ callId: compactCallId, name: 'context_compact', args: {} }],
  });
  await fixture.repository.recordToolFinished(turn, {
    callId: compactCallId, result: { requested: true }, isError: false,
  });
  const requested = await fixture.repository.compileContext(conversation.conversationId);
  assert.equal(requested.compaction.modelRequested, true);
  const inputHash = 'd'.repeat(64);
  const install = {
    expectedBasisSequence: requested.basisSequence,
    trigger: 'model' as const,
    inputHash,
    policyInputTokens: 220_450,
    retainedInputTokens: 12,
    retainedInput: [{
      type: 'message', role: 'user', content: [{ type: 'input_text', text: 'retained user request' }],
    }],
    providerItem: { type: 'compaction', id: 'cmp-1', encrypted_content: 'opaque-provider-memory' },
    usage: { inputTokens: 220_450, outputTokens: 800, cachedInputTokens: 200_000 },
    durationMs: 125,
    context: durableFixtureContext(requested),
  };
  await fixture.repository.installContextCompaction(turn, install);
  await fixture.repository.installContextCompaction(turn, install);

  const compacted = await fixture.repository.compileContext(conversation.conversationId);
  assert.equal(compacted.compaction.epoch, 1);
  assert.equal(compacted.compaction.warningIssued, false);
  assert.equal(compacted.compaction.checkpoint?.inputHash, inputHash);
  assert.deepEqual(compacted.messages, []);
  assert.deepEqual(compacted.frame.layers.map(({ kind }) => kind), [
    'provider_checkpoint', 'active_scope',
  ]);
  const checkpointSearch = await fixture.repository.searchHistory(conversation.conversationId, {
    query: 'Context epoch 1', scope: 'conversation',
  });
  const checkpointHit = checkpointSearch.hits.find(({ kind }) => kind === 'context-compaction');
  assert.ok(checkpointHit);
  const checkpointHistory = await fixture.repository.openHistory(conversation.conversationId, {
    ref: checkpointHit.ref,
  });
  assert.match(checkpointHistory.content, /private opaque checkpoint/u);
  assert.doesNotMatch(checkpointHistory.content, /opaque-provider-memory/u);

  await startInference(fixture.repository, turn, compacted);
  await fixture.repository.appendAssistantCheckpoint(turn, {
    textDelta: 'Post-checkpoint continuation.', reasoningDelta: 'Fresh epoch reasoning.',
  });
  await fixture.repository.finishInference(turn, { state: 'completed' });
  const continued = await fixture.repository.compileContext(conversation.conversationId);
  assert.deepEqual(continued.messages.map(({ role }) => role), ['assistant']);

  await fixture.repository.close();
  fixture.repository = await AgentStateStore.open({ dataRoot: fixture.dataRoot });
  const restarted = await fixture.repository.compileContext(conversation.conversationId);
  const restartedProviderItem = restarted.compaction.checkpoint?.providerItem;
  assert.ok(
    restartedProviderItem && typeof restartedProviderItem === 'object' && !Array.isArray(restartedProviderItem),
  );
  assert.equal(restartedProviderItem.type, 'compaction');
  assert.equal(restarted.compaction.checkpoint?.epoch, 1);
  assert.deepEqual(restarted.messages.map(({ role }) => role), ['assistant']);
  await fixture.repository.finishTurn(turn, { status: 'completed' });
});

test('work units inherit the parent provider checkpoint and may advance their own branch epoch', async (t) => {
  const fixture = await repositoryFixture(t);
  const conversation = await fixture.repository.createConversation({
    operationId: crypto.randomUUID(), cwd: fixture.cwd, modelId: 'gpt-5.6-codex', reasoning: 'high',
  });
  const root = await accept(
    fixture.repository,
    conversation.conversationId,
    'This original request should remain behind the parent checkpoint.',
  );
  const initial = await fixture.repository.compileContext(conversation.conversationId);
  await fixture.repository.installContextCompaction(root, {
    expectedBasisSequence: initial.basisSequence,
    trigger: 'automatic',
    inputHash: '1'.repeat(64),
    policyInputTokens: 220_500,
    retainedInputTokens: 8,
    retainedInput: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'retained' }] }],
    providerItem: { type: 'compaction', encrypted_content: 'parent-opaque' },
    usage: { inputTokens: 220_500, outputTokens: 500, cachedInputTokens: 190_000 },
    durationMs: 100,
    context: durableFixtureContext(initial),
  });
  const entered = await enterWorkUnit(fixture.repository, root, {
    boundary: 'Verify that the inherited provider checkpoint remains the context root.',
  });
  const child = await fixture.repository.compileContext(conversation.conversationId);
  assert.equal(child.scopeId, entered.handle.scopeId);
  assert.equal(child.compaction.epoch, 1);
  assert.equal(child.compaction.checkpoint?.inputHash, '1'.repeat(64));
  assert.equal(child.frame.layers[0]?.kind, 'provider_checkpoint');
  assert.doesNotMatch(JSON.stringify(child.messages), /original request should remain/u);

  await fixture.repository.installContextCompaction(entered.handle, {
    expectedBasisSequence: child.basisSequence,
    trigger: 'automatic',
    inputHash: '2'.repeat(64),
    policyInputTokens: 220_600,
    retainedInputTokens: 7,
    retainedInput: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'child retained' }] }],
    providerItem: { type: 'compaction', encrypted_content: 'child-opaque' },
    usage: { inputTokens: 220_600, outputTokens: 450, cachedInputTokens: 200_000 },
    durationMs: 110,
    context: durableFixtureContext(child),
  });
  const advanced = await fixture.repository.compileContext(conversation.conversationId);
  assert.equal(advanced.compaction.epoch, 2);
  assert.equal(advanced.compaction.checkpoint?.inputHash, '2'.repeat(64));

  const returned = await fixture.repository.returnWorkUnit(entered.handle, {
    status: 'completed', result: 'The inherited checkpoint remained valid.', artifacts: [],
  });
  await fixture.repository.recordToolFinished(root, {
    callId: entered.parentCallId, result: workUnitCompletion(returned), isError: false,
  });
  const resumed = await fixture.repository.compileContext(conversation.conversationId);
  assert.equal(resumed.scopeId, root.scopeId);
  assert.equal(resumed.compaction.epoch, 1);
  assert.equal(resumed.compaction.checkpoint?.inputHash, '1'.repeat(64));
  await fixture.repository.finishTurn(root, { status: 'interrupted' });
});

test('actual frames, exact provider reasoning, restart recovery, and next-turn eviction work together', async (t) => {
  const fixture = await repositoryFixture(t);
  const conversation = await fixture.repository.createConversation({
    operationId: crypto.randomUUID(), cwd: fixture.cwd, modelId: 'gpt-5.6-codex', reasoning: 'high',
  });
  const turn = await accept(fixture.repository, conversation.conversationId, 'Inspect and implement.');
  const first = await fixture.repository.compileContext(conversation.conversationId);
  await startInference(fixture.repository, turn, first);
  const providerMessage = assistantMessage({
    content: [
      { type: 'thinking', thinking: 'private active reasoning', thinkingSignature: 'opaque-provider-state' },
      { type: 'toolCall', id: 'call:one', name: 'bash', arguments: { command: 'true' } },
    ],
    stopReason: 'toolUse',
  });
  const provider = await fixture.repository.recordProviderItem(turn, providerMessage);
  await fixture.repository.appendAssistantCheckpoint(turn, {
    textDelta: '', reasoningDelta: 'private active reasoning',
  });
  await fixture.repository.finishInference(turn, { state: 'completed' });
  const usageDatabase = new DatabaseSync(fixture.repository.databasePath, { readOnly: true });
  const usage = usageDatabase.prepare(`
    SELECT reported_input_tokens, reported_output_tokens, reported_cache_read_tokens
    FROM inferences WHERE turn_id = ?
  `).get(turn.turnId) as {
    reported_input_tokens: number;
    reported_output_tokens: number;
    reported_cache_read_tokens: number;
  };
  usageDatabase.close();
  assert.equal(usage.reported_input_tokens, 100);
  assert.equal(usage.reported_output_tokens, 20);
  assert.equal(usage.reported_cache_read_tokens, 80);
  await fixture.repository.recordToolStarted(turn, {
    callId: 'call:one', name: 'bash', args: { command: 'true' },
  });
  await fixture.repository.recordToolFinished(turn, {
    callId: 'call:one', result: { exitCode: 0 }, isError: false,
  });

  const providerEvent = (await fixture.repository.readEvents({ conversationId: conversation.conversationId }))
    .find(({ type }) => type === 'provider.item.recorded');
  assert.ok(providerEvent?.payload && typeof providerEvent.payload === 'object');
  const rawHash = (providerEvent.payload as Record<string, unknown>).rawArtifactHash;
  assert.equal(typeof rawHash, 'string');
  assert.equal(await fixture.repository.readArtifact(rawHash as string), null);

  await fixture.repository.close();
  fixture.repository = await AgentStateStore.open({ dataRoot: fixture.dataRoot });
  const recovery = await fixture.repository.resumeActiveTurn(conversation.conversationId);
  assert.equal(recovery?.handle.turnId, turn.turnId);
  const recovered = await fixture.repository.compileContext(conversation.conversationId);
  const recoveredAssistant = recovered.messages.find(({ role }) => role === 'assistant');
  assert.equal(recoveredAssistant?.role, 'assistant');
  if (recoveredAssistant?.role === 'assistant') {
    const thinking = recoveredAssistant.providerMessage?.content.find(({ type }) => type === 'thinking');
    assert.equal(thinking?.type, 'thinking');
    if (thinking?.type === 'thinking') assert.equal(thinking.thinkingSignature, 'opaque-provider-state');
  }
  assert.deepEqual(recovered.messages.map(({ role }) => role), ['user', 'assistant', 'tool', 'user']);

  await fixture.repository.appendAssistantCheckpoint(turn, { textDelta: 'Implemented.', reasoningDelta: '' });
  await fixture.repository.finishTurn(turn, { status: 'completed' });
  const [completedSummary] = await fixture.repository.readResourceProjections([
    `conversation:${conversation.conversationId}`,
  ]);
  assert.equal((completedSummary?.value as { preview?: string }).preview, 'Implemented.');
  const followup = await accept(fixture.repository, conversation.conversationId, 'What changed?');
  const next = await fixture.repository.compileContext(conversation.conversationId);
  const priorAssistant = next.messages.find((message) =>
    message.turnId === turn.turnId && message.role === 'assistant');
  assert.equal(priorAssistant?.role, 'assistant');
  if (priorAssistant?.role === 'assistant') {
    assert.equal(priorAssistant.reasoning, '');
    assert.equal(priorAssistant.providerMessage, undefined);
    assert.deepEqual(priorAssistant.toolCalls, []);
  }
  assert.deepEqual(next.frame.resolvedTurns, [{
    turnId: turn.turnId, resolution: 'dialogue', origin: 'automatic',
  }]);
  assert.ok(next.messages.every((message) =>
    message.turnId !== turn.turnId || message.role !== 'tool'));
  await fixture.repository.appendAssistantCheckpoint(followup, {
    textDelta: 'The implementation changed.', reasoningDelta: '',
  });
  await fixture.repository.finishTurn(followup, { status: 'completed' });

  const fullTurn = await accept(
    fixture.repository,
    conversation.conversationId,
    'Revisit the original reasoning.',
    {
      version: 1,
      automaticDialogueTurns: 0,
      overrides: [{ turnId: turn.turnId, resolution: 'full' as const }],
    },
  );
  const full = await fixture.repository.compileContext(conversation.conversationId);
  assert.deepEqual(full.frame.resolvedTurns, [{
    turnId: turn.turnId, resolution: 'full', origin: 'explicit',
  }]);
  const fullAssistant = full.messages.find((message) =>
    message.turnId === turn.turnId && message.role === 'assistant' && message.providerMessage);
  assert.equal(fullAssistant?.role, 'assistant');
  if (fullAssistant?.role === 'assistant') {
    const thinking = fullAssistant.providerMessage?.content.find(({ type }) => type === 'thinking');
    assert.equal(thinking?.type, 'thinking');
    if (thinking?.type === 'thinking') assert.equal(thinking.thinkingSignature, 'opaque-provider-state');
  }
  await fixture.repository.finishTurn(fullTurn, { status: 'interrupted' });
  assert.ok(provider.providerItemId);
});

test('restart recovery terminalizes an incomplete tool operation before compiling again', async (t) => {
  const fixture = await repositoryFixture(t);
  const conversation = await fixture.repository.createConversation({
    operationId: crypto.randomUUID(), cwd: fixture.cwd, modelId: 'gpt-5.6-codex', reasoning: 'high',
  });
  const turn = await accept(fixture.repository, conversation.conversationId, 'Inspect the interrupted tool.');
  const context = await fixture.repository.compileContext(conversation.conversationId);
  await startInference(fixture.repository, turn, context);
  await fixture.repository.finalizeInference(turn, {
    state: 'completed',
    providerMessage: assistantMessage({
      content: [{ type: 'toolCall', id: 'call:interrupted', name: 'bash', arguments: { command: 'true' } }],
      stopReason: 'toolUse',
    }),
    calls: [{ callId: 'call:interrupted', name: 'bash', args: { command: 'true' } }],
  });
  await assert.rejects(
    fixture.repository.compileContext(conversation.conversationId),
    /bash is still running/u,
  );

  await fixture.repository.close();
  fixture.repository = await AgentStateStore.open({ dataRoot: fixture.dataRoot });
  const recovered = await fixture.repository.resumeActiveTurn(conversation.conversationId);
  assert.equal(recovered?.handle.scopeId, turn.scopeId);
  const compiled = await fixture.repository.compileContext(conversation.conversationId);
  const interrupted = compiled.messages.find((message) =>
    message.role === 'tool' && message.callId === 'call:interrupted');
  assert.equal(interrupted?.role, 'tool');
  if (interrupted?.role === 'tool') {
    assert.equal(interrupted.isError, true);
    assert.match(JSON.stringify(interrupted.result), /process restart/u);
  }
  await fixture.repository.finishTurn(turn, { status: 'interrupted' });
});

test('provider commentary stays in its inference while only the final answer reaches the transcript response', async (t) => {
  const fixture = await repositoryFixture(t);
  const conversation = await fixture.repository.createConversation({
    operationId: crypto.randomUUID(), cwd: fixture.cwd, modelId: 'gpt-5.6-codex', reasoning: 'high',
  });
  const turn = await accept(fixture.repository, conversation.conversationId, 'Inspect the current state.');
  const firstContext = await fixture.repository.compileContext(conversation.conversationId);
  await startInference(fixture.repository, turn, firstContext);
  const commentary = 'I’m grounding this in the current implementation first.';
  await fixture.repository.appendAssistantCheckpoint(turn, {
    textDelta: commentary,
    reasoningDelta: 'Need one exact read.',
    textPhase: 'commentary',
  });
  const first = await fixture.repository.finalizeInference(turn, {
    state: 'completed',
    providerMessage: assistantMessage({
      content: [
        { type: 'thinking', thinking: 'Need one exact read.', thinkingSignature: 'reasoning-one' },
        {
          type: 'text', text: commentary,
          textSignature: JSON.stringify({ v: 1, id: 'commentary-one', phase: 'commentary' }),
        },
        { type: 'toolCall', id: 'call:read', name: 'workspace.read', arguments: { path: 'README.md' } },
      ],
      stopReason: 'toolUse',
    }),
    calls: [{ callId: 'call:read', name: 'workspace.read', args: { path: 'README.md' } }],
  });
  const phaseDatabase = new DatabaseSync(fixture.repository.databasePath, { readOnly: true });
  const phaseRow = phaseDatabase.prepare(`
    SELECT assistant_text_phase FROM inferences WHERE inference_id = ?
  `).get(first.inferenceId) as { assistant_text_phase: string | null };
  const checkpointRow = phaseDatabase.prepare(`
    SELECT e.payload_json, i.assistant_text_phase
    FROM events e
    LEFT JOIN inferences i
      ON i.inference_id = json_extract(e.payload_json, '$.inferenceId')
    WHERE e.scope_id = ? AND e.type = 'assistant.checkpoint'
    ORDER BY e.sequence LIMIT 1
  `).get(turn.scopeId) as { payload_json: string; assistant_text_phase: string | null };
  phaseDatabase.close();
  assert.equal(phaseRow.assistant_text_phase, 'commentary');
  assert.equal(checkpointRow.assistant_text_phase, 'commentary');
  await fixture.repository.recordToolStarted(turn, {
    callId: 'call:read', name: 'workspace.read', args: { path: 'README.md' },
    sourceInferenceId: first.inferenceId,
  });
  await fixture.repository.recordToolFinished(turn, {
    callId: 'call:read', result: { path: 'README.md' }, isError: false,
  });
  const firstTrace = await fixture.repository.readExecutionScopeTranscriptResource(
    conversation.conversationId,
    {
      type: 'executionScope',
      protocolVersion: AGENT_TRANSCRIPT_PROTOCOL_VERSION,
      turnId: turn.turnId,
      scopeId: turn.scopeId,
    },
  );
  assert.deepEqual(firstTrace?.inferences[0]?.contentOrder, [
    'reasoning',
    'commentary',
    'actions',
  ]);

  const secondContext = await fixture.repository.compileContext(conversation.conversationId);
  await startInference(fixture.repository, turn, secondContext);
  const answer = 'The current implementation is grounded and ready.';
  await fixture.repository.appendAssistantCheckpoint(turn, {
    textDelta: answer, reasoningDelta: '', textPhase: 'final_answer',
  });
  await fixture.repository.finalizeInference(turn, {
    state: 'completed',
    providerMessage: assistantMessage({
      content: [{
        type: 'text', text: answer,
        textSignature: JSON.stringify({ v: 1, id: 'final-one', phase: 'final_answer' }),
      }],
      stopReason: 'stop',
    }),
    calls: [],
  });
  await fixture.repository.finishTurn(turn, { status: 'completed' });

  const projectionDatabase = new DatabaseSync(fixture.repository.databasePath, { readOnly: true });
  const projectionRow = projectionDatabase.prepare(`
    SELECT value_json FROM transcript_items WHERE turn_id = ? AND kind = 'assistant'
  `).get(turn.turnId) as { value_json: string };
  projectionDatabase.close();
  assert.equal((JSON.parse(projectionRow.value_json) as { summaryText?: string }).summaryText, answer);

  const actions = await fixture.repository.readTranscriptActions(conversation.conversationId);
  assert.deepEqual(
    actions.flatMap((action) => action.type === 'assistant' && action.textDelta
      ? [action.textDelta]
      : []),
    [answer],
  );
  const assistantText = actions.flatMap((action) =>
    action.type === 'assistant' ? [action.textDelta] : []).join('');
  assert.equal(assistantText, answer);
  assert.doesNotMatch(assistantText, /grounding this/u);

  const scope = await fixture.repository.readExecutionScopeTranscriptResource(
    conversation.conversationId,
    {
      type: 'executionScope',
      protocolVersion: AGENT_TRANSCRIPT_PROTOCOL_VERSION,
      turnId: turn.turnId,
      scopeId: turn.scopeId,
    },
  );
  assert.equal(scope?.inferences[0]?.commentary?.text, commentary);
  assert.equal(scope?.inferences[1]?.commentary, null);
});

test('bounded work units branch behind a pending tool call and fold back only their result', async (t) => {
  const fixture = await repositoryFixture(t);
  const conversation = await fixture.repository.createConversation({
    operationId: crypto.randomUUID(), cwd: fixture.cwd, modelId: 'model', reasoning: 'high',
  });
  const root = await accept(fixture.repository, conversation.conversationId, 'Solve the parent task.');
  const rootContext = await fixture.repository.compileContext(conversation.conversationId);
  await startInference(fixture.repository, root, rootContext);
  await fixture.repository.appendAssistantCheckpoint(root, {
    textDelta: '', reasoningDelta: 'parent reasoning',
  });
  const rootFinalization = await fixture.repository.finalizeInference(root, {
    state: 'completed',
    providerMessage: assistantMessage({
    content: [
      { type: 'thinking', thinking: 'parent reasoning', thinkingSignature: 'parent-signature' },
      { type: 'toolCall', id: 'call:enter', name: 'work_unit_start', arguments: {
        boundary: 'Inspect the seam and close when its exact contract is verified.',
      } },
    ],
    stopReason: 'toolUse',
    }),
    calls: [{
      callId: 'call:enter', name: 'work_unit_start', args: {
        boundary: 'Inspect the seam and close when its exact contract is verified.',
      },
    }],
  });
  const preparedEntry = await fixture.repository.prepareWorkUnitEntry(root, {
    boundary: 'Inspect the seam and close when its exact contract is verified.',
  });
  const parentCall = rootFinalization.calls[0]!;
  const entered = await fixture.repository.commitWorkUnitEntry(root, preparedEntry, {
    parentCallId: 'call:enter',
    parentInferenceId: rootFinalization.inferenceId,
    parentOperationId: parentCall.operationId,
  });

  const childContext = await fixture.repository.compileContext(conversation.conversationId);
  assert.equal(childContext.scopeKind, 'work_unit');
  assert.equal(childContext.scopeId, entered.handle.scopeId);
  assert.equal(childContext.messages.filter(({ role }) => role === 'user').length, 1);
  assert.ok(childContext.messages.some((message) =>
    message.role === 'assistant' && message.toolCalls.some((call) =>
      call.name === 'work_unit_start' && JSON.stringify(call.args).includes('Inspect the seam'))));
  const bootstrap = childContext.messages.find((message) =>
    message.role === 'tool' && message.callId === 'call:enter');
  assert.equal(bootstrap?.role, 'tool');
  assert.match(JSON.stringify(bootstrap), /"state":"work_unit"/u);
  assert.doesNotMatch(JSON.stringify(bootstrap), /docs\/seam-contract\.md|The seam must be sound\./u);
  assert.ok(childContext.messages.some((message) =>
    message.role === 'user' && message.text.includes('Solve the parent task.')));
  assert.doesNotMatch(
    JSON.stringify(childContext.messages),
    /journal:\/\//u,
  );
  const inherited = childContext.messages.find((message) => message.role === 'assistant');
  assert.equal(inherited?.role, 'assistant');
  if (inherited?.role === 'assistant') {
    const thinking = inherited.providerMessage?.content.find(({ type }) => type === 'thinking');
    assert.equal(thinking?.type === 'thinking' ? thinking.thinkingSignature : null, 'parent-signature');
  }
  await startInference(fixture.repository, entered.handle, childContext);
  assert.notEqual(await fixture.repository.appendAssistantCheckpoint(entered.handle, {
    textDelta: '', reasoningDelta: 'CHILD_PRIVATE_REASONING',
  }), null);
  await fixture.repository.finalizeInference(entered.handle, {
    state: 'completed',
    providerMessage: assistantMessage({
    content: [
      { type: 'thinking', thinking: 'CHILD_PRIVATE_REASONING', thinkingSignature: 'child-signature' },
      { type: 'toolCall', id: 'call:child', name: 'bash', arguments: { command: 'true' } },
    ],
    stopReason: 'toolUse',
    }),
    calls: [{ callId: 'call:child', name: 'bash', args: { command: 'true' } }],
  });
  await fixture.repository.recordToolFinished(entered.handle, {
    callId: 'call:child', result: { secret: 'CHILD_TOOL_RESULT' }, isError: false,
  });
  const returnContext = await fixture.repository.compileContext(conversation.conversationId);
  await startInference(fixture.repository, entered.handle, returnContext);
  await fixture.repository.finalizeInference(entered.handle, {
    state: 'completed',
    providerMessage: assistantMessage({
      content: [{
        type: 'toolCall',
        id: 'call:return-invalid',
        name: 'work_unit_finish',
        arguments: {
          status: 'completed',
          result: 'This references a missing artifact.',
          artifacts: ['missing-artifact.txt'],
        },
      }],
      stopReason: 'toolUse',
    }),
    calls: [{
      callId: 'call:return-invalid',
      name: 'work_unit_finish',
      args: {
        status: 'completed',
        result: 'This references a missing artifact.',
        artifacts: ['missing-artifact.txt'],
      },
    }],
  });
  await assert.rejects(
    fixture.repository.prepareWorkUnitReturn(entered.handle, {
      status: 'completed',
      result: 'This invalid boundary must remain correctable.',
      artifacts: ['missing-artifact.txt'],
    }),
    /missing-artifact\.txt|ENOENT/u,
  );
  await assert.rejects(
    fixture.repository.compileContext(conversation.conversationId),
    /work_unit_finish is still running/u,
  );
  await fixture.repository.recordToolFinished(entered.handle, {
    callId: 'call:return-invalid', result: { error: 'missing-artifact.txt was not found' }, isError: true,
  });
  assert.equal(
    (await fixture.repository.compileContext(conversation.conversationId)).scopeId,
    entered.handle.scopeId,
  );
  const retryContext = await fixture.repository.compileContext(conversation.conversationId);
  await startInference(fixture.repository, entered.handle, retryContext);
  await fixture.repository.finalizeInference(entered.handle, {
    state: 'completed',
    providerMessage: assistantMessage({
      content: [{
        type: 'toolCall',
        id: 'call:return',
        name: 'work_unit_finish',
        arguments: {
          status: 'completed',
          result: 'The seam is sound.',
          artifacts: ['docs/seam-contract.md', 'src/seam.ts'],
        },
      }],
      stopReason: 'toolUse',
    }),
    calls: [{
      callId: 'call:return', name: 'work_unit_finish', args: {
        status: 'completed',
        result: 'The seam is sound.',
        artifacts: ['docs/seam-contract.md', 'src/seam.ts'],
      },
    }],
  });
  const preparedReturn = await fixture.repository.prepareWorkUnitReturn(entered.handle, {
    status: 'completed',
    result: 'The seam is sound.',
    artifacts: ['docs/seam-contract.md', 'src/seam.ts'],
  });
  const returned = await fixture.repository.commitWorkUnitFinish(
    entered.handle,
    'call:return',
    preparedReturn,
  );
  assert.equal(returned.status, 'completed');
  assert.equal(returned.parentHandle.scopeId, root.scopeId);
  assert.equal(returned.artifacts[1]?.ref, 'src/seam.ts');
  assert.equal(returned.artifacts[1]?.snapshot.source, 'file');
  assert.equal(returned.artifacts[1]?.snapshot.byteLength, 29);
  const database = new DatabaseSync(fixture.repository.databasePath, { readOnly: true });
  const finishOperation = database.prepare(`
    SELECT state, terminal_sequence FROM operations WHERE scope_id = ? AND call_id = ?
  `).get(entered.handle.scopeId, 'call:return') as { state: string; terminal_sequence: number };
  const childScope = database.prepare(`
    SELECT state, terminal_sequence FROM execution_scopes WHERE scope_id = ?
  `).get(entered.handle.scopeId) as { state: string; terminal_sequence: number };
  database.close();
  assert.equal(finishOperation.state, 'completed');
  assert.equal(childScope.state, 'completed');
  assert.ok(finishOperation.terminal_sequence < childScope.terminal_sequence);
  await fixture.repository.recordToolFinished(root, {
    callId: 'call:enter',
    result: {
      scopeId: returned.scopeId,
      status: returned.status,
      result: returned.result,
      artifacts: returned.artifacts,
      resultRef: returned.resultRef,
      historyRef: returned.historyRef,
    },
    isError: false,
  });
  const rootTrace = await fixture.repository.readExecutionScopeTranscriptResource(
    conversation.conversationId,
    {
      type: 'executionScope',
      protocolVersion: AGENT_TRANSCRIPT_PROTOCOL_VERSION,
      turnId: root.turnId,
      scopeId: root.scopeId,
    },
  );
  const linkedCall = rootTrace?.inferences[0]?.actionGroup?.calls[0];
  assert.equal(linkedCall?.childScopeId, entered.handle.scopeId);
  assert.equal(
    linkedCall?.childBoundary,
    'Inspect the seam and close when its exact contract is verified.',
  );
  assert.equal(linkedCall?.childState, 'completed');
  assert.ok((linkedCall?.childOperationCount ?? 0) >= 1);
  assert.equal(linkedCall?.childArtifactCount, 2);
  const childTrace = await fixture.repository.readExecutionScopeTranscriptResource(
    conversation.conversationId,
    {
      type: 'executionScope',
      protocolVersion: AGENT_TRANSCRIPT_PROTOCOL_VERSION,
      turnId: root.turnId,
      scopeId: entered.handle.scopeId,
    },
  );
  assert.equal(childTrace?.parentOperationId, parentCall.operationId);
  assert.equal(childTrace?.state, 'completed');
  assert.match(childTrace?.result ?? '', /The seam is sound/u);
  assert.ok(childTrace?.artifacts.some((artifact) => artifact.ref === 'src/seam.ts'));
  assert.equal(childTrace?.inferences[0]?.reasoning?.text, 'CHILD_PRIVATE_REASONING');
  assert.equal(childTrace?.inferences[0]?.actionGroup?.calls[0]?.name, 'bash');
  const projection = await fixture.repository.readTranscriptWindowProjection({
    conversationId: conversation.conversationId,
    requests: [{
      type: 'transcriptSync',
      protocolVersion: AGENT_TRANSCRIPT_PROTOCOL_VERSION,
      projectionVersion: AGENT_TRANSCRIPT_PROJECTION_VERSION,
      window: { kind: 'tail', count: 24 },
    }],
  });
  assert.ok(projection?.actions.some((action) =>
    action.type === 'work-unit-start' && action.scopeId === entered.handle.scopeId));
  assert.ok(projection?.actions.some((action) =>
    action.type === 'work-unit-finish' && action.scopeId === entered.handle.scopeId));
  const deliverableSnapshot = await fixture.repository.openHistory(
    conversation.conversationId,
    { ref: returned.artifacts[1]!.snapshot.ref },
  );
  assert.equal(deliverableSnapshot.content, 'export const seam = "sound";\n');

  const resumed = await fixture.repository.compileContext(conversation.conversationId);
  assert.equal(resumed.scopeKind, 'turn');
  assert.equal(resumed.scopeId, root.scopeId);
  const resumedText = JSON.stringify(resumed.messages);
  assert.match(resumedText, /The seam is sound/u);
  assert.match(resumedText, /docs\/seam-contract\.md|src\/seam\.ts/u);
  assert.match(resumedText, /history:\/\/scope/u);
  assert.doesNotMatch(resumedText, /The seam must be sound|export const seam/u);
  assert.doesNotMatch(resumedText, /CHILD_PRIVATE_REASONING|CHILD_TOOL_RESULT|child-signature/u);
  const resumedAssistant = resumed.messages.find((message) => message.role === 'assistant');
  assert.equal(resumedAssistant?.role, 'assistant');
  if (resumedAssistant?.role === 'assistant') {
    const thinking = resumedAssistant.providerMessage?.content.find(({ type }) => type === 'thinking');
    assert.equal(thinking?.type === 'thinking' ? thinking.thinkingSignature : null, 'parent-signature');
  }

  await writeFile(join(fixture.cwd, 'src/seam.ts'), 'export const seam = "revised";\n');
  const revisedUnit = await enterWorkUnit(fixture.repository, root, {
    boundary: 'Inspect the revised seam implementation and report the durable result.',
  });
  const revisedContext = await fixture.repository.compileContext(conversation.conversationId);
  const revisedBootstrap = revisedContext.messages.at(-1);
  assert.equal(revisedBootstrap?.role, 'tool');
  if (revisedBootstrap?.role === 'tool') {
    assert.doesNotMatch(JSON.stringify(revisedBootstrap.result), /export const seam/u);
  }
  const revisedReturn = await fixture.repository.returnWorkUnit(revisedUnit.handle, {
    status: 'completed',
    result: 'The revised snapshot was inspected.',
    artifacts: ['src/seam.ts'],
  });
  assert.notEqual(revisedReturn.artifacts[0]?.snapshot.hash, returned.artifacts[1]?.snapshot.hash);
  await fixture.repository.recordToolFinished(root, {
    callId: revisedUnit.parentCallId, result: workUnitCompletion(revisedReturn), isError: false,
  });

  await fixture.repository.appendAssistantCheckpoint(root, { textDelta: 'Parent complete.', reasoningDelta: '' });
  await fixture.repository.finishTurn(root, { status: 'completed' });
  const transcript = await fixture.repository.readTranscriptActions(conversation.conversationId);
  const transcriptText = JSON.stringify(transcript);
  assert.match(transcriptText, /work_unit_start|Parent complete/u);
  assert.doesNotMatch(transcriptText, /call:child|call:return|CHILD_PRIVATE_REASONING|CHILD_TOOL_RESULT/u);
  const durableEvents = await fixture.repository.readEvents({ conversationId: conversation.conversationId });
  assert.ok(durableEvents.some(({ type }) => type === 'work_unit.bootstrap'));
  assert.ok(durableEvents.every((event) => {
    if (event.type !== 'message.internal' || !event.payload || typeof event.payload !== 'object') return true;
    return !JSON.stringify(event.payload).includes('work_unit_');
  }));
  const returnedEvent = durableEvents.find(({ type }) => type === 'work_unit.returned');
  const returnedPayload = returnedEvent?.payload;
  if (!returnedPayload || typeof returnedPayload !== 'object' || Array.isArray(returnedPayload)) {
    assert.fail('The work-unit return event is missing its object payload.');
  }
  assert.deepEqual(
    (returnedPayload.artifacts as Array<{ ref: string }> | undefined)?.map(({ ref }) => ref),
    ['docs/seam-contract.md', 'src/seam.ts'],
  );
  const resultSearch = await fixture.repository.searchHistory(conversation.conversationId, {
    query: 'seam sound', scope: 'conversation',
  });
  const result = resultSearch.hits.find(({ kind }) => kind === 'work-unit-result');
  assert.ok(result);
  const opened = await fixture.repository.openHistory(conversation.conversationId, { ref: result!.ref });
  assert.match(opened.content, /The seam is sound/u);
  assert.doesNotMatch(opened.content, /CHILD_PRIVATE_REASONING/u);
});

test('work-unit handoffs may use the available parent context beyond the former static limit', async (t) => {
  const fixture = await repositoryFixture(t);
  const conversation = await fixture.repository.createConversation({
    operationId: crypto.randomUUID(), cwd: fixture.cwd, modelId: 'model', reasoning: 'high',
  });
  const root = await accept(fixture.repository, conversation.conversationId, 'Audit the architecture.');
  const entered = await enterWorkUnit(fixture.repository, root, {
    boundary: 'Return a repository-grounded architecture audit with a clear conclusion.',
  });
  const result = `## Audit result\n\n${'Detailed repository-grounded finding.\n'.repeat(520)}RESULT_END`;
  assert.ok(Buffer.byteLength(result, 'utf8') > 16 * 1024);

  const returned = await fixture.repository.returnWorkUnit(entered.handle, {
    status: 'partial',
    result,
    artifacts: ['docs/architecture.md'],
  });
  assert.equal(returned.result, result);
  assert.equal(returned.parentHandle.scopeId, root.scopeId);
  await fixture.repository.recordToolFinished(root, {
    callId: entered.parentCallId, result: workUnitCompletion(returned), isError: false,
  });

  const resumed = await fixture.repository.compileContext(conversation.conversationId);
  assert.equal(resumed.scopeKind, 'turn');
  const resumedText = JSON.stringify(resumed.messages);
  assert.match(resumedText, /RESULT_END/u);
  await fixture.repository.finishTurn(root, { status: 'interrupted' });
});

test('work-unit directory artifacts are correctable before the durable finish commit', async (t) => {
  const fixture = await repositoryFixture(t);
  const conversation = await fixture.repository.createConversation({
    operationId: crypto.randomUUID(), cwd: fixture.cwd, modelId: 'model', reasoning: 'high',
  });
  const root = await accept(fixture.repository, conversation.conversationId, 'Implement the seam.');

  const entered = await enterWorkUnit(fixture.repository, root, {
    boundary: 'Implement the seam file and preserve it as an artifact.',
  });
  await assert.rejects(
    fixture.repository.prepareWorkUnitReturn(entered.handle, {
      status: 'completed',
      result: 'The source tree is complete.',
      artifacts: ['src'],
    }),
    /must be a UTF-8 text file; directories are not supported/u,
  );
  const eventsBeforeRetry = await fixture.repository.readEvents({
    conversationId: conversation.conversationId,
  });
  assert.ok(eventsBeforeRetry.every(({ type }) => type !== 'work_unit.returned'));
  const returned = await fixture.repository.returnWorkUnit(entered.handle, {
    status: 'completed',
    result: 'The corrected file artifact was accepted.',
    artifacts: ['src/seam.ts'],
  });
  assert.equal(returned.artifacts[0]?.snapshot.source, 'file');
  await fixture.repository.recordToolFinished(root, {
    callId: entered.parentCallId, result: workUnitCompletion(returned), isError: false,
  });
  await fixture.repository.finishTurn(root, { status: 'completed' });
});

test('turn failure abandons an unreturned work unit with its own terminal event', async (t) => {
  const fixture = await repositoryFixture(t);
  const conversation = await fixture.repository.createConversation({
    operationId: crypto.randomUUID(), cwd: fixture.cwd, modelId: 'model', reasoning: 'high',
  });
  const root = await accept(fixture.repository, conversation.conversationId, 'Run bounded work.');
  const entered = await enterWorkUnit(fixture.repository, root, {
    boundary: 'Exercise abnormal work-unit cleanup and stop before returning.',
  });
  const childContext = await fixture.repository.compileContext(conversation.conversationId);
  await startInference(fixture.repository, entered.handle, childContext);

  await fixture.repository.finishTurn(root, {
    status: 'failed', error: 'provider stopped before work_unit_finish', errorCode: 'provider_error',
  });

  const durable = await fixture.repository.readTurn(conversation.conversationId, root.turnId);
  assert.equal(durable.state, 'failed');
  assert.equal(durable.terminal, true);
  assert.equal(durable.error, 'provider stopped before work_unit_finish');
  const events = (await fixture.repository.readEvents({ conversationId: conversation.conversationId }))
    .filter((event) => event.turnId === root.turnId);
  const abandoned = events.find(({ type }) => type === 'work_unit.abandoned');
  const terminal = events.find(({ type }) => type === 'turn.terminal');
  assert.ok(abandoned);
  assert.ok(terminal);
  assert.ok(abandoned.sequence < terminal.sequence);
  assert.notEqual(abandoned.sequence, terminal.sequence);
  assert.equal(await fixture.repository.resumeActiveTurn(conversation.conversationId), null);
});

test('History retrieval exposes exact visible outcomes but not private provider artifacts', async (t) => {
  const fixture = await repositoryFixture(t);
  const conversation = await fixture.repository.createConversation({
    operationId: crypto.randomUUID(), cwd: fixture.cwd, modelId: 'model', reasoning: 'high',
  });
  const turn = await accept(fixture.repository, conversation.conversationId, 'Remember cobalt behavior.');
  await fixture.repository.appendAssistantCheckpoint(turn, {
    textDelta: 'Cobalt behavior is retained in exact history.', reasoningDelta: '',
  });
  await fixture.repository.finishTurn(turn, { status: 'completed' });
  const search = await fixture.repository.searchHistory(conversation.conversationId, {
    query: 'cobalt', scope: 'conversation',
  });
  const outcome = search.hits.find(({ kind }) => kind === 'assistant-outcome');
  assert.ok(outcome);
  const opened = await fixture.repository.openHistory(conversation.conversationId, { ref: outcome!.ref });
  assert.match(opened.content, /Cobalt behavior/u);

  const safelyTokenized = await fixture.repository.searchHistory(conversation.conversationId, {
    query: 'cobalt (behavior):', scope: 'conversation',
  });
  assert.ok(safelyTokenized.hits.length >= 1);
  assert.deepEqual(
    safelyTokenized.hits.map(({ ref, kind }) => ({ ref, kind })),
    (await fixture.repository.searchHistory(conversation.conversationId, {
      query: 'cobalt (behavior):', scope: 'conversation',
    })).hits.map(({ ref, kind }) => ({ ref, kind })),
  );

  await fixture.repository.close();
  fixture.repository = await AgentStateStore.open({ dataRoot: fixture.dataRoot });
  const rebuilt = await fixture.repository.searchHistory(conversation.conversationId, {
    query: 'cobalt behavior', scope: 'conversation',
  });
  assert.ok(rebuilt.hits.some(({ kind }) => kind === 'assistant-outcome'));
});

test('History retrieval can exclude the active search without hiding prior operations', async (t) => {
  const fixture = await repositoryFixture(t);
  const conversation = await fixture.repository.createConversation({
    operationId: crypto.randomUUID(), cwd: fixture.cwd, modelId: 'model', reasoning: 'high',
  });
  const turn = await accept(fixture.repository, conversation.conversationId, 'Inspect prior validation.');
  await fixture.repository.recordToolStarted(turn, {
    callId: 'prior-validation',
    name: 'bash',
    args: { command: 'cargo test --workspace' },
  });
  await fixture.repository.recordToolStarted(turn, {
    callId: 'active-search',
    name: 'history_search',
    args: { query: 'cargo test --workspace', include: 'operations' },
  });

  const search = await fixture.repository.searchHistory(conversation.conversationId, {
    query: 'cargo test --workspace',
    scope: 'conversation',
    include: 'operations',
  }, {
    excludeRef: 'history://tool/active-search',
  });
  assert.ok(search.hits.some(({ ref }) => ref === 'history://tool/prior-validation'));
  assert.ok(search.hits.every(({ ref }) => ref !== 'history://tool/active-search'));
  await fixture.repository.finishTurn(turn, { status: 'interrupted' });
});

test('retryable provider attempts stay auditable but disappear from active context and transcript', async (t) => {
  const fixture = await repositoryFixture(t);
  const conversation = await fixture.repository.createConversation({
    operationId: crypto.randomUUID(), cwd: fixture.cwd, modelId: 'model', reasoning: 'high',
  });
  const turn = await accept(fixture.repository, conversation.conversationId, 'Recover this request.');
  const initialContext = await fixture.repository.compileContext(conversation.conversationId);
  const failed = await startInference(fixture.repository, turn, initialContext);
  await fixture.repository.appendAssistantCheckpoint(turn, {
    textDelta: 'Provisional output that must be replaced.',
    reasoningDelta: 'Incomplete reasoning.',
  });
  await fixture.repository.recordProviderItem(turn, assistantMessage({
    content: [{ type: 'text', text: 'Provisional output that must be replaced.' }],
    stopReason: 'error',
  }));
  await fixture.repository.finishInference(turn, { state: 'failed' });
  const superseded = await fixture.repository.supersedeInference(turn, {
    attempt: 1,
    maxAttempts: 2,
    delayMs: 500,
    error: 'WebSocket error',
  });
  assert.equal(superseded.inferenceId, failed.inferenceId);

  const retryContext = await fixture.repository.compileContext(conversation.conversationId);
  assert.deepEqual(retryContext.messages.map(({ role }) => role), ['user']);
  assert.ok(retryContext.messages.every((message) =>
    message.role !== 'assistant' || !message.text.includes('Provisional output')));
  assert.ok((await fixture.repository.readTranscriptActions(conversation.conversationId))
    .every((action) => action.type !== 'assistant' || !action.textDelta.includes('Provisional output')));

  const retry = await startInference(
    fixture.repository,
    turn,
    retryContext,
    failed.inferenceId,
  );
  await fixture.repository.appendAssistantCheckpoint(turn, {
    textDelta: 'Recovered output.',
    reasoningDelta: 'Completed reasoning.',
  });
  await fixture.repository.recordProviderItem(turn, assistantMessage({
    content: [{ type: 'text', text: 'Recovered output.' }],
    stopReason: 'stop',
  }));
  await fixture.repository.finishInference(turn, { state: 'completed' });

  const recovered = await fixture.repository.compileContext(conversation.conversationId);
  const assistant = recovered.messages.find((message) => message.role === 'assistant');
  assert.equal(assistant?.role, 'assistant');
  if (assistant?.role === 'assistant') {
    assert.equal(assistant.text, 'Recovered output.');
    assert.equal(assistant.providerMessage?.stopReason, 'stop');
  }
  const actions = await fixture.repository.readTranscriptActions(conversation.conversationId);
  assert.deepEqual(
    actions.filter((action) => action.type === 'assistant').map((action) => action.textDelta),
    ['Recovered output.'],
  );
  const events = await fixture.repository.readEvents({ conversationId: conversation.conversationId });
  const supersededEvent = events.find(({ type }) => type === 'inference.superseded');
  const retryStarted = events.find((event) =>
    event.type === 'inference.started' && event.payload && typeof event.payload === 'object' &&
    !Array.isArray(event.payload) && event.payload.inferenceId === retry.inferenceId);
  assert.ok(supersededEvent);
  assert.ok(retryStarted?.payload && typeof retryStarted.payload === 'object' && !Array.isArray(retryStarted.payload));
  if (retryStarted?.payload && typeof retryStarted.payload === 'object' && !Array.isArray(retryStarted.payload)) {
    assert.equal(retryStarted.payload.retryOfInferenceId, failed.inferenceId);
  }
  await fixture.repository.finishTurn(turn, { status: 'completed' });
});

test('a provider attempt with a durable tool effect cannot be superseded', async (t) => {
  const fixture = await repositoryFixture(t);
  const conversation = await fixture.repository.createConversation({
    operationId: crypto.randomUUID(), cwd: fixture.cwd, modelId: 'model', reasoning: 'high',
  });
  const turn = await accept(fixture.repository, conversation.conversationId, 'Do not replay effects.');
  const context = await fixture.repository.compileContext(conversation.conversationId);
  const inference = await startInference(fixture.repository, turn, context);
  await fixture.repository.recordToolStarted(turn, {
    callId: 'durable-effect',
    name: 'bash',
    args: { command: 'touch sentinel' },
    sourceInferenceId: inference.inferenceId,
  });
  await fixture.repository.finishInference(turn, { state: 'failed' });
  await assert.rejects(
    fixture.repository.supersedeInference(turn, {
      attempt: 1, maxAttempts: 2, delayMs: 500, error: 'WebSocket error',
    }),
    /durable tool effect/u,
  );
  await fixture.repository.finishTurn(turn, { status: 'failed', error: 'Transport failed.' });
});

test('the public fixture runtime commits a v6 frame and completes through normal server hooks', async (t) => {
  const fixture = await repositoryFixture(t);
  const server = new AgentServer({
    provider: new FixtureProvider(),
    store: fixture.repository,
    notify() {},
  });
  t.after(() => server.close());
  await server.initialize();
  const created = await server.handle('remux/agent/conversation/create', {
    operationId: crypto.randomUUID(),
    cwd: fixture.cwd,
    modelId: 'gpt-5.4-fixture',
    reasoning: 'high',
  }) as { conversationId: string };
  const sent = await server.handle('remux/agent/conversation/message/send', {
    operationId: crypto.randomUUID(),
    conversationId: created.conversationId,
    clientMessageId: crypto.randomUUID(),
    contextPlan: { version: 1, automaticDialogueTurns: 2, overrides: [] },
    text: 'Exercise the public path.',
  }) as { turnId: string };
  await eventually(async () => {
    const response = await server.handle('remux/agent/resources/read', {
      requests: [{ key: 'runtime' }],
    }) as { resources: Array<{ value?: { state?: string } }> };
    return response.resources[0]?.value?.state === 'idle';
  });
  const projections = await fixture.repository.readResourceProjections([
    `context:${created.conversationId}`,
  ]);
  const inspector = projections[0]?.value as { version?: number; frameId?: string; layers?: unknown[] };
  assert.equal(inspector.version, 7);
  assert.equal(typeof inspector.frameId, 'string');
  assert.equal(inspector.layers?.length, 3);
  const durableTurn = await server.handle('remux/agent/turn/read', {
    conversationId: created.conversationId,
    turnId: sent.turnId,
  }) as { state?: string; terminal?: boolean; terminalSequence?: number | null };
  assert.equal(durableTurn.state, 'completed');
  assert.equal(durableTurn.terminal, true);
  assert.equal(typeof durableTurn.terminalSequence, 'number');
  const traceDatabase = new DatabaseSync(fixture.repository.databasePath, { readOnly: true });
  const identity = traceDatabase.prepare(`
    SELECT root_scope_id FROM turns WHERE turn_id = ?
  `).get(sent.turnId) as { root_scope_id: string };
  const unlinkedCalls = traceDatabase.prepare(`
    SELECT COUNT(*) AS count FROM operations
    WHERE turn_id = ? AND kind = 'tool.call' AND source_inference_id IS NULL
  `).get(sent.turnId) as { count: number };
  traceDatabase.close();
  assert.equal(unlinkedCalls.count, 0);
  const executionScope = await fixture.repository.readExecutionScopeTranscriptResource(
    created.conversationId,
    {
      type: 'executionScope',
      protocolVersion: AGENT_TRANSCRIPT_PROTOCOL_VERSION,
      turnId: sent.turnId,
      scopeId: identity.root_scope_id,
    },
  );
  assert.equal(executionScope?.state, 'completed');
  assert.equal(executionScope?.inferences.length, 1);
  assert.deepEqual(executionScope?.inferences[0]?.contentOrder, ['reasoning', 'actions']);
  assert.equal(executionScope?.inferences[0]?.reasoning?.state, 'final');
  assert.equal(
    executionScope?.inferences[0]?.reasoning?.text,
    'Inspecting the fixture workspace.',
  );
  assert.deepEqual(
    executionScope?.inferences[0]?.actionGroup?.calls.map(({ name, status }) => ({ name, status })),
    [{ name: 'workspace.read', status: 'completed' }],
  );
  assert.deepEqual(
    executionScope?.inferences[0]?.actionGroup?.calls[0]?.presentation,
    { category: 'read', label: 'Read README.md', subject: 'README.md' },
  );
  const events = await fixture.repository.readEvents({ conversationId: created.conversationId });
  assert.ok(events.some(({ type }) => type === 'provider.item.recorded'));
  assert.ok(events.some(({ type }) => type === 'turn.terminal'));
});

test('the public runtime recovers a response-started transport drop without duplicating partial output', async (t) => {
  const fixture = await repositoryFixture(t);
  const server = new AgentServer({
    provider: new RecoveringTransportFixtureProvider(),
    store: fixture.repository,
    notify() {},
  });
  t.after(() => server.close());
  await server.initialize();
  const created = await server.handle('remux/agent/conversation/create', {
    operationId: crypto.randomUUID(),
    cwd: fixture.cwd,
    modelId: 'gpt-5.6-recovery-fixture',
    reasoning: 'high',
  }) as { conversationId: string };
  const sent = await server.handle('remux/agent/conversation/message/send', {
    operationId: crypto.randomUUID(),
    conversationId: created.conversationId,
    clientMessageId: crypto.randomUUID(),
    contextPlan: { version: 1, automaticDialogueTurns: 2, overrides: [] },
    text: 'Survive a dropped WebSocket.',
  }) as { turnId: string };
  await eventually(async () => {
    const response = await server.handle('remux/agent/resources/read', {
      requests: [{ key: 'runtime' }],
    }) as { resources: Array<{ value?: { state?: string } }> };
    return response.resources[0]?.value?.state === 'idle';
  });

  const turn = await fixture.repository.readTurn(created.conversationId, sent.turnId);
  assert.equal(turn.state, 'completed');
  const actions = await fixture.repository.readTranscriptActions(created.conversationId);
  assert.deepEqual(
    actions.filter((action) => action.type === 'assistant').map((action) => action.textDelta),
    ['Recovered through a fresh provider frame.'],
  );
  const events = await fixture.repository.readEvents({ conversationId: created.conversationId });
  assert.equal(events.filter(({ type }) => type === 'inference.failed').length, 1);
  assert.equal(events.filter(({ type }) => type === 'inference.superseded').length, 1);
  assert.equal(events.filter(({ type }) => type === 'inference.completed').length, 1);
  const transports = events.filter(({ type }) => type === 'inference.transport');
  assert.equal(transports.length, 2);
  const failedTransport = transports[0]?.payload;
  assert.ok(failedTransport && typeof failedTransport === 'object' && !Array.isArray(failedTransport));
  if (failedTransport && typeof failedTransport === 'object' && !Array.isArray(failedTransport)) {
    assert.equal(failedTransport.carrier, 'websocket');
    assert.equal(failedTransport.websocketRequests, 1);
    assert.equal(failedTransport.connectionsCreated, 1);
    assert.equal(failedTransport.websocketFailures, 1);
    assert.equal(failedTransport.dispatchToFirstEventMs, 40);
    assert.equal(failedTransport.durationMs, 65);
  }
  const recoveredTransport = transports[1]?.payload;
  assert.ok(recoveredTransport && typeof recoveredTransport === 'object' && !Array.isArray(recoveredTransport));
  if (recoveredTransport && typeof recoveredTransport === 'object' && !Array.isArray(recoveredTransport)) {
    assert.equal(recoveredTransport.carrier, 'sse');
    assert.equal(recoveredTransport.websocketRequests, 0);
    assert.equal(recoveredTransport.sseFallbacks, 1);
    assert.equal(recoveredTransport.dispatchToFirstEventMs, 30);
    assert.equal(recoveredTransport.durationMs, 55);
  }
  const starts = events.filter(({ type }) => type === 'inference.started');
  assert.equal(starts.length, 2);
  const retryPayload = starts[1]?.payload;
  assert.ok(retryPayload && typeof retryPayload === 'object' && !Array.isArray(retryPayload));
  if (retryPayload && typeof retryPayload === 'object' && !Array.isArray(retryPayload)) {
    assert.equal(retryPayload.requestMode, 'full');
    assert.equal(typeof retryPayload.retryOfInferenceId, 'string');
  }
});

async function repositoryFixture(t: TestContext) {
  const dataRoot = await mkdtemp(join(tmpdir(), 'remux-agent-thread-runtime-'));
  const cwd = join(dataRoot, 'workspace');
  await mkdir(join(cwd, 'docs'), { recursive: true });
  await mkdir(join(cwd, 'src'), { recursive: true });
  await writeFile(join(cwd, 'README.md'), '# Fixture workspace\n');
  await writeFile(join(cwd, 'docs/seam-contract.md'), '# Seam contract\n\nThe seam must be sound.\n');
  await writeFile(join(cwd, 'docs/architecture.md'), '# Architecture\n\nPreserve the boundary.\n');
  await writeFile(join(cwd, 'src/seam.ts'), 'export const seam = "sound";\n');
  const fixture = {
    dataRoot,
    cwd,
    repository: await AgentStateStore.open({ dataRoot }),
  };
  t.after(async () => {
    await fixture.repository.close();
    await rm(dataRoot, { recursive: true, force: true });
  });
  return fixture;
}

function accept(
  repository: AgentStateStore,
  conversationId: string,
  text: string,
  contextPlan: TurnContextPlan = { version: 1, automaticDialogueTurns: 2, overrides: [] },
) {
  return repository.acceptTurn({
    operationId: crypto.randomUUID(),
    conversationId,
    clientMessageId: crypto.randomUUID(),
    contextPlan,
    text,
  });
}

async function enterWorkUnit(
  repository: AgentStateStore,
  handle: DurableTurnHandle,
  input: WorkUnitEnterInput,
) {
  const context = await repository.compileContext(handle.conversationId);
  await startInference(repository, handle, context);
  const callId = `call:${crypto.randomUUID()}`;
  const finalization = await repository.finalizeInference(handle, {
    state: 'completed',
    providerMessage: assistantMessage({
      content: [{ type: 'toolCall', id: callId, name: 'work_unit_start', arguments: input }],
      stopReason: 'toolUse',
    }),
    calls: [{ callId, name: 'work_unit_start', args: input }],
  });
  const prepared = await repository.prepareWorkUnitEntry(handle, input);
  const entered = await repository.commitWorkUnitEntry(handle, prepared, {
    parentCallId: callId,
    parentInferenceId: finalization.inferenceId,
    parentOperationId: finalization.calls[0]!.operationId,
  });
  return { ...entered, parentCallId: callId };
}

function workUnitCompletion(returned: Awaited<ReturnType<AgentStateStore['returnWorkUnit']>>) {
  return {
    scopeId: returned.scopeId,
    status: returned.status,
    result: returned.result,
    artifacts: returned.artifacts,
    resultRef: returned.resultRef,
    historyRef: returned.historyRef,
  };
}

async function startInference(
  repository: AgentStateStore,
  handle: DurableTurnHandle,
  context: Awaited<ReturnType<AgentStateStore['compileContext']>>,
  retryOfInferenceId?: string,
) {
  return repository.startInference(handle, {
    modelId: 'gpt-5.6-codex',
    requestMode: 'full',
    estimatedInputTokens: 2_000,
    payload: { messages: [] },
    ...(retryOfInferenceId ? { retryOfInferenceId } : {}),
    context: {
      basisSequence: context.basisSequence,
      logicalHash: context.logicalHash,
      renderedHash: 'a'.repeat(64),
      orderedMessageHashes: context.orderedMessageHashes,
      messageCount: context.messages.length + 1,
      fixedContractsHash: 'b'.repeat(64),
      frame: context.frame,
      frameBuildDurationMs: 1,
      activeMessages: context.messages,
      compaction: context.compaction,
    },
  });
}

function assistantMessage(input: {
  content: AssistantMessage['content'];
  stopReason: AssistantMessage['stopReason'];
}): AssistantMessage {
  return {
    role: 'assistant',
    content: input.content,
    api: 'openai-responses',
    provider: 'openai-codex',
    model: 'gpt-5.6-codex',
    usage: {
      input: 100,
      output: 20,
      cacheRead: 80,
      cacheWrite: 0,
      totalTokens: 120,
      cost: { input: 0.00012, output: 0.00034, cacheRead: 0.00005, cacheWrite: 0, total: 0.00051 },
    },
    stopReason: input.stopReason,
    timestamp: Date.now(),
  };
}

async function eventually(check: () => Promise<boolean>, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`Condition was not met within ${timeoutMs} ms.`);
}

class RecoveringTransportFixtureProvider implements ModelProvider {
  async authStatus() {
    return {
      state: 'signed-in' as const,
      operationId: null,
      displayLabel: 'Recovery fixture',
      verificationUri: null,
      userCode: null,
      expiresAt: null,
      progress: null,
      error: null,
    };
  }

  async login() {}
  async logout() {}

  async listModels() {
    return [{
      id: 'gpt-5.6-recovery-fixture',
      name: 'GPT-5.6 Recovery Fixture',
      provider: 'openai-codex' as const,
      contextWindow: 400_000,
      supportedReasoning: ['high' as const],
    }];
  }

  async createSession(
    options: Parameters<ModelProvider['createSession']>[0],
  ): Promise<ModelSession> {
    let interrupted = false;
    return {
      async prompt() {
        const firstContext = await options.durability.compileContext();
        await options.durability.beforeProviderCall({
          payload: { input: 'first-attempt' },
          requestMode: 'full',
          estimatedInputTokens: firstContext.frame.estimatedInputTokens,
          context: durableFixtureContext(firstContext),
        });
        options.onEvent({ type: 'assistant-start' });
        options.onEvent({
          type: 'assistant-text', delta: 'Partial transport output.', phase: 'commentary',
        });
        await options.durability.afterProviderCall?.({
          plannedRequestMode: 'full',
          actualRequestMode: 'full',
          carrier: 'websocket',
          websocketRequests: 1,
          connectionsCreated: 1,
          connectionsReused: 0,
          websocketFailures: 1,
          sseFallbacks: 0,
          dispatchToFirstEventMs: 40,
          durationMs: 65,
        });
        await options.durability.beforeAssistantMessageEnd({
          inferenceState: 'failed',
          text: 'Partial transport output.',
          textPhase: 'commentary',
          reasoning: '',
          calls: [],
          providerMessage: fixtureProviderMessage('Partial transport output.', 'error'),
        });
        const superseded = await options.durability.supersedeProviderAttempt({
          attempt: 1,
          maxAttempts: 2,
          delayMs: 0,
          error: 'WebSocket error',
        });
        const retryContext = await options.durability.compileContext();
        await options.durability.beforeProviderCall({
          payload: { input: 'fresh-full-retry' },
          requestMode: 'full',
          estimatedInputTokens: retryContext.frame.estimatedInputTokens,
          retryOfInferenceId: superseded.inferenceId,
          context: durableFixtureContext(retryContext),
        });
        const recovered = 'Recovered through a fresh provider frame.';
        options.onEvent({ type: 'assistant-start' });
        options.onEvent({ type: 'assistant-text', delta: recovered, phase: 'final_answer' });
        await options.durability.afterProviderCall?.({
          plannedRequestMode: 'full',
          actualRequestMode: 'full',
          carrier: 'sse',
          websocketRequests: 0,
          connectionsCreated: 0,
          connectionsReused: 0,
          websocketFailures: 0,
          sseFallbacks: 1,
          dispatchToFirstEventMs: 30,
          durationMs: 55,
        });
        await options.durability.beforeAssistantMessageEnd({
          inferenceState: 'completed',
          text: recovered,
          textPhase: 'final_answer',
          reasoning: '',
          calls: [],
          providerMessage: fixtureProviderMessage(recovered, 'stop'),
        });
        options.onEvent({ type: 'assistant-complete', interrupted });
      },
      async interrupt() {
        interrupted = true;
      },
      async dispose() {
        interrupted = true;
      },
    };
  }
}

function durableFixtureContext(
  context: Awaited<ReturnType<AgentStateStore['compileContext']>>,
) {
  return {
    basisSequence: context.basisSequence,
    logicalHash: context.logicalHash,
    renderedHash: context.logicalHash,
    orderedMessageHashes: context.orderedMessageHashes,
    messageCount: context.messages.length,
    fixedContractsHash: 'c'.repeat(64),
    frame: context.frame,
    frameBuildDurationMs: 0,
    activeMessages: context.messages,
    compaction: context.compaction,
  };
}

function fixtureProviderMessage(
  text: string,
  stopReason: AssistantMessage['stopReason'],
): AssistantMessage {
  return {
    ...assistantMessage({ content: [{ type: 'text', text }], stopReason }),
    model: 'gpt-5.6-recovery-fixture',
    ...(stopReason === 'error' ? { errorMessage: 'WebSocket error' } : {}),
  };
}
