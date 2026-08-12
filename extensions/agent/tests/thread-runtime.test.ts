import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';

import type { AssistantMessage } from '@earendil-works/pi-ai';

import { AgentServer } from '../server/src/agent-server.ts';
import { FixtureEngine } from '../server/src/fixture-engine.ts';
import type { AgentEngine, ConversationRuntime } from '../server/src/engine.ts';
import { AgentStateStore } from '../server/src/storage/agent-state-store.ts';
import type { DurableTurnHandle } from '../server/src/domain/state.ts';
import { AGENT_STATE_TABLES } from '../server/src/storage/schema.ts';

test('Agent state v3 owns one clean schema and compiles the accepted user turn', async (t) => {
  const fixture = await repositoryFixture(t);
  const conversation = await fixture.repository.createConversation({
    operationId: crypto.randomUUID(),
    cwd: fixture.cwd,
    modelId: 'gpt-5.6-codex',
    reasoning: 'high',
  });
  const thread = await fixture.repository.readThread(conversation.conversationId);
  assert.equal(thread.content, '# Thread\n');
  const turn = await accept(fixture.repository, conversation.conversationId, 'Build the compiler.');
  const context = await fixture.repository.compileContext(conversation.conversationId);
  assert.deepEqual(context.messages.map(({ role }) => role), ['user']);
  assert.equal(context.messages[0]?.turnId, turn.turnId);
  assert.equal(context.frame.threadVersionId, conversation.threadVersionId);
  assert.deepEqual(context.frame.selectedTurnIds, [turn.turnId]);
  assert.match(context.frame.contextEnvelope, /<thread version=/u);
  assert.match(context.frame.contextEnvelope, /<history>/u);
  assert.match(context.frame.contextEnvelope, /history_search and history_read/u);
  assert.doesNotMatch(context.frame.contextEnvelope, /thread\.md|journal|cold_history|cold history/iu);

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
  assert.deepEqual(next.frame.dialogueTurnIds, [turn.turnId]);
  assert.ok(next.messages.every((message) =>
    message.turnId !== turn.turnId || message.role !== 'tool'));
  await fixture.repository.finishTurn(followup, { status: 'interrupted' });
  assert.ok(provider.providerItemId);
});

test('thread.md patches and replacements are CAS-versioned with exact fork inheritance', async (t) => {
  const fixture = await repositoryFixture(t);
  const source = await fixture.repository.createConversation({
    operationId: crypto.randomUUID(), cwd: fixture.cwd, modelId: 'model', reasoning: 'high',
  });
  const turn = await accept(fixture.repository, source.conversationId, 'Choose the design.');
  const initialized = await fixture.repository.replaceThread(turn, {
    baseVersionId: source.threadVersionId,
    content: '# Thread\n\n## Design space\n\nCandidate: exact dialogue.\n\n## Current edge\n\nChoose the state model.\n',
  });
  const updated = await fixture.repository.patchThread(turn, {
    baseVersionId: initialized.versionId,
    edits: [
      {
        oldText: 'Candidate: exact dialogue.',
        newText: 'Accepted: exact dialogue with a living semantic canvas.',
      },
      {
        oldText: 'Choose the state model.',
        newText: 'Implement the accepted state model.',
      },
    ],
  });
  await assert.rejects(
    fixture.repository.replaceThread(turn, {
      baseVersionId: source.threadVersionId,
      content: '# Thread\n\nStale overwrite.\n',
    }),
    /changed from/u,
  );
  const history = await fixture.repository.readThreadHistory(source.conversationId);
  assert.equal(history.current.versionId, updated.versionId);
  assert.equal(history.current.content, updated.content);
  assert.equal(history.previous?.versionId, initialized.versionId);
  assert.equal(history.previous?.content, initialized.content);
  await fixture.repository.appendAssistantCheckpoint(turn, { textDelta: 'Accepted.', reasoningDelta: '' });
  await fixture.repository.finishTurn(turn, { status: 'completed' });

  const edited = await fixture.repository.createConversation({
    operationId: crypto.randomUUID(), cwd: fixture.cwd, modelId: 'model', reasoning: 'high',
    inheritThreadFrom: { conversationId: source.conversationId, turnId: turn.turnId, position: 'before' },
  });
  const forked = await fixture.repository.createConversation({
    operationId: crypto.randomUUID(), cwd: fixture.cwd, modelId: 'model', reasoning: 'high',
    inheritThreadFrom: { conversationId: source.conversationId, turnId: turn.turnId, position: 'after' },
  });
  assert.equal((await fixture.repository.readThread(edited.conversationId)).content, '# Thread\n');
  assert.equal((await fixture.repository.readThread(forked.conversationId)).content, updated.content);
});

test('thread.md patches reject missing, ambiguous, empty, and partially applicable edits atomically', async (t) => {
  const fixture = await repositoryFixture(t);
  const conversation = await fixture.repository.createConversation({
    operationId: crypto.randomUUID(), cwd: fixture.cwd, modelId: 'model', reasoning: 'high',
  });
  const turn = await accept(fixture.repository, conversation.conversationId, 'Maintain the canvas.');
  const initialized = await fixture.repository.replaceThread(turn, {
    baseVersionId: conversation.threadVersionId,
    content: '# Canvas\n\nCandidate\n\nCandidate\n\n## Edge\n\nExplore.\n',
  });
  await assert.rejects(
    fixture.repository.patchThread(turn, {
      baseVersionId: initialized.versionId,
      edits: [{ oldText: 'Candidate', newText: 'Accepted' }],
    }),
    /ambiguous/u,
  );
  await assert.rejects(
    fixture.repository.patchThread(turn, {
      baseVersionId: initialized.versionId,
      edits: [{ oldText: 'Missing', newText: 'Accepted' }],
    }),
    /did not match/u,
  );
  await assert.rejects(
    fixture.repository.patchThread(turn, {
      baseVersionId: initialized.versionId,
      edits: [{ oldText: '', newText: 'Accepted' }],
    }),
    /non-empty/u,
  );
  await assert.rejects(
    fixture.repository.patchThread(turn, {
      baseVersionId: initialized.versionId,
      edits: [
        { oldText: 'Explore.', newText: 'Implement.' },
        { oldText: 'Missing after first edit', newText: 'No partial write.' },
      ],
    }),
    /did not match/u,
  );
  assert.equal((await fixture.repository.readThread(conversation.conversationId)).content, initialized.content);
  await fixture.repository.finishTurn(turn, { status: 'interrupted' });
});

test('bounded work units inherit typed resources and fold back only their continuation bundle', async (t) => {
  const fixture = await repositoryFixture(t);
  const conversation = await fixture.repository.createConversation({
    operationId: crypto.randomUUID(), cwd: fixture.cwd, modelId: 'model', reasoning: 'high',
  });
  const root = await accept(fixture.repository, conversation.conversationId, 'Solve the parent task.');
  const rootContext = await fixture.repository.compileContext(conversation.conversationId);
  await startInference(fixture.repository, root, rootContext);
  await fixture.repository.recordProviderItem(root, assistantMessage({
    content: [
      { type: 'thinking', thinking: 'parent reasoning', thinkingSignature: 'parent-signature' },
      { type: 'toolCall', id: 'call:enter', name: 'work_unit_start', arguments: { objective: 'Inspect one seam.' } },
    ],
    stopReason: 'toolUse',
  }));
  await fixture.repository.appendAssistantCheckpoint(root, {
    textDelta: '', reasoningDelta: 'parent reasoning',
  });
  await fixture.repository.finishInference(root, { state: 'completed' });
  await fixture.repository.recordToolStarted(root, {
    callId: 'call:enter', name: 'work_unit_start', args: { objective: 'Inspect one seam.' },
  });
  const entered = await fixture.repository.enterWorkUnit(root, {
    objective: 'Inspect one seam.',
    doneWhen: ['The seam is verified against its exact contract.'],
    resources: [
      { ref: 'docs/seam-contract.md', role: 'authority', description: 'Exact seam contract.' },
      { ref: `history://turn/${root.turnId}`, role: 'evidence', description: 'Current request.' },
    ],
  });
  await fixture.repository.recordToolFinished(root, {
    callId: 'call:enter', result: { scopeId: entered.handle.scopeId }, isError: false,
  });

  const childContext = await fixture.repository.compileContext(conversation.conversationId);
  assert.equal(childContext.scopeKind, 'work_unit');
  assert.equal(childContext.scopeId, entered.handle.scopeId);
  assert.ok(childContext.messages.some((message) =>
    message.role === 'user' && message.text.includes('Inspect one seam.')));
  assert.ok(childContext.messages.some((message) =>
    message.role === 'user' && message.text.includes(`history://turn/${root.turnId}`)));
  assert.ok(childContext.messages.some((message) =>
    message.role === 'user' && message.text.includes('docs/seam-contract.md')));
  assert.ok(childContext.messages.some((message) =>
    message.role === 'user' && message.text.includes('The seam must be sound.')));
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
  await assert.rejects(
    fixture.repository.patchThread(entered.handle, {
      baseVersionId: conversation.threadVersionId,
      edits: [{ oldText: '# Thread', newText: '# Child mutation' }],
    }),
    /parent-owned/u,
  );
  await assert.rejects(
    fixture.repository.replaceThread(entered.handle, {
      baseVersionId: conversation.threadVersionId,
      content: '# Child mutation\n',
    }),
    /parent-owned/u,
  );

  await startInference(fixture.repository, entered.handle, childContext);
  await fixture.repository.recordProviderItem(entered.handle, assistantMessage({
    content: [
      { type: 'thinking', thinking: 'CHILD_PRIVATE_REASONING', thinkingSignature: 'child-signature' },
      { type: 'toolCall', id: 'call:child', name: 'bash', arguments: { command: 'true' } },
    ],
    stopReason: 'toolUse',
  }));
  assert.equal(await fixture.repository.appendAssistantCheckpoint(entered.handle, {
    textDelta: '', reasoningDelta: 'CHILD_PRIVATE_REASONING',
  }), null);
  await fixture.repository.finishInference(entered.handle, { state: 'completed' });
  await fixture.repository.recordToolStarted(entered.handle, {
    callId: 'call:child', name: 'bash', args: { command: 'true' },
  });
  await fixture.repository.recordToolFinished(entered.handle, {
    callId: 'call:child', result: { secret: 'CHILD_TOOL_RESULT' }, isError: false,
  });
  await fixture.repository.recordToolStarted(entered.handle, {
    callId: 'call:return', name: 'work_unit_finish', args: { result: 'The seam is sound.' },
  });
  await fixture.repository.recordToolFinished(entered.handle, {
    callId: 'call:return', result: { state: 'returning' }, isError: false,
  });
  await assert.rejects(
    fixture.repository.prepareWorkUnitReturn(entered.handle, {
      status: 'completed',
      result: 'This invalid boundary must remain correctable.',
      resources: [{ ref: 'missing-resource.txt', role: 'evidence' }],
    }),
    /missing-resource\.txt|ENOENT/u,
  );
  assert.equal(
    (await fixture.repository.compileContext(conversation.conversationId)).scopeId,
    entered.handle.scopeId,
  );
  const returned = await fixture.repository.returnWorkUnit(entered.handle, {
    status: 'completed',
    result: '## Result\n\nThe seam is sound.',
    threadUpdate: 'Record that the seam contract was verified.',
    resources: [
      { ref: 'docs/seam-contract.md', role: 'authority', description: 'Exact seam contract.' },
      { ref: 'src/seam.ts', role: 'deliverable', description: 'Verified implementation.' },
    ],
  });
  assert.equal(returned.status, 'completed');
  assert.equal(returned.parentHandle.scopeId, root.scopeId);
  assert.equal(returned.threadUpdate, 'Record that the seam contract was verified.');
  assert.equal(returned.resources[1]?.ref, 'src/seam.ts');
  assert.equal(returned.resources[1]?.inclusion, 'materialized');
  const deliverableSnapshot = await fixture.repository.openHistory(
    conversation.conversationId,
    { ref: returned.resources[1]!.snapshot.ref },
  );
  assert.equal(deliverableSnapshot.content, 'export const seam = "sound";\n');

  const resumed = await fixture.repository.compileContext(conversation.conversationId);
  assert.equal(resumed.scopeKind, 'turn');
  assert.equal(resumed.scopeId, root.scopeId);
  const resumedText = JSON.stringify(resumed.messages);
  assert.match(resumedText, /The seam is sound/u);
  assert.match(resumedText, /Proposed Thread update/u);
  assert.match(resumedText, /Record that the seam contract was verified/u);
  assert.match(resumedText, /docs\/seam-contract\.md|src\/seam\.ts/u);
  assert.match(resumedText, /Current work: parent conversation/u);
  assert.match(resumedText, /history:\/\/scope/u);
  assert.doesNotMatch(resumedText, /CHILD_PRIVATE_REASONING|CHILD_TOOL_RESULT|child-signature/u);
  const resumedAssistant = resumed.messages.find((message) => message.role === 'assistant');
  assert.equal(resumedAssistant?.role, 'assistant');
  if (resumedAssistant?.role === 'assistant') {
    const thinking = resumedAssistant.providerMessage?.content.find(({ type }) => type === 'thinking');
    assert.equal(thinking?.type === 'thinking' ? thinking.thinkingSignature : null, 'parent-signature');
  }

  const inheritedUnit = await fixture.repository.enterWorkUnit(root, {
    objective: 'Use the already-returned seam implementation.',
    resources: [{ ref: 'src/seam.ts', role: 'authority' }],
  });
  assert.equal(inheritedUnit.resources[0]?.inclusion, 'inherited');
  const inheritedContext = await fixture.repository.compileContext(conversation.conversationId);
  const inheritedOrientation = inheritedContext.messages.at(-1);
  assert.equal(inheritedOrientation?.role, 'user');
  if (inheritedOrientation?.role === 'user') {
    assert.match(inheritedOrientation.text, /already materialized earlier in the active parent context/u);
    assert.doesNotMatch(inheritedOrientation.text, /export const seam = "sound"/u);
  }
  await fixture.repository.returnWorkUnit(inheritedUnit.handle, {
    status: 'completed',
    result: 'The inherited snapshot was sufficient.',
  });

  await writeFile(join(fixture.cwd, 'src/seam.ts'), 'export const seam = "revised";\n');
  const revisedUnit = await fixture.repository.enterWorkUnit(root, {
    objective: 'Inspect the revised seam implementation.',
    resources: [{ ref: 'src/seam.ts', role: 'deliverable' }],
  });
  assert.equal(revisedUnit.resources[0]?.inclusion, 'materialized');
  assert.notEqual(revisedUnit.resources[0]?.snapshot.hash, returned.resources[1]?.snapshot.hash);
  const revisedContext = await fixture.repository.compileContext(conversation.conversationId);
  const revisedOrientation = revisedContext.messages.at(-1);
  assert.equal(revisedOrientation?.role, 'user');
  if (revisedOrientation?.role === 'user') {
    assert.match(revisedOrientation.text, /export const seam = "revised"/u);
  }
  await fixture.repository.returnWorkUnit(revisedUnit.handle, {
    status: 'completed',
    result: 'The revised snapshot was inspected.',
  });

  await fixture.repository.appendAssistantCheckpoint(root, { textDelta: 'Parent complete.', reasoningDelta: '' });
  await fixture.repository.finishTurn(root, { status: 'completed' });
  const transcript = await fixture.repository.readTranscriptActions(conversation.conversationId);
  const transcriptText = JSON.stringify(transcript);
  assert.match(transcriptText, /work_unit_start|Parent complete/u);
  assert.doesNotMatch(transcriptText, /call:child|call:return|CHILD_PRIVATE_REASONING|CHILD_TOOL_RESULT/u);
  const durableEvents = await fixture.repository.readEvents({ conversationId: conversation.conversationId });
  const returnedEvent = durableEvents.find(({ type }) => type === 'work_unit.returned');
  const returnedPayload = returnedEvent?.payload;
  if (!returnedPayload || typeof returnedPayload !== 'object' || Array.isArray(returnedPayload)) {
    assert.fail('The work-unit return event is missing its object payload.');
  }
  assert.deepEqual(
    (returnedPayload.resources as Array<{ ref: string; role: string }> | undefined)
      ?.map(({ ref, role }) => ({ ref, role })),
    [
      { ref: 'docs/seam-contract.md', role: 'authority' },
      { ref: 'src/seam.ts', role: 'deliverable' },
    ],
  );
  const resultSearch = await fixture.repository.searchHistory(conversation.conversationId, {
    query: 'seam sound', scope: 'conversation',
  });
  const result = resultSearch.hits.find(({ kind }) => kind === 'work-unit-result');
  assert.ok(result);
  const opened = await fixture.repository.openHistory(conversation.conversationId, { ref: result!.ref });
  assert.match(opened.content, /The seam is sound/u);
  assert.match(opened.content, /Proposed Thread update/u);
  assert.match(opened.content, /### authority: `docs\/seam-contract\.md`/u);
  assert.equal((await fixture.repository.readThread(conversation.conversationId)).content, '# Thread\n');
});

test('work-unit handoffs may use the available parent context beyond the former static limit', async (t) => {
  const fixture = await repositoryFixture(t);
  const conversation = await fixture.repository.createConversation({
    operationId: crypto.randomUUID(), cwd: fixture.cwd, modelId: 'model', reasoning: 'high',
  });
  const root = await accept(fixture.repository, conversation.conversationId, 'Audit the architecture.');
  const entered = await fixture.repository.enterWorkUnit(root, {
    objective: 'Return a repository-grounded architecture audit.',
    resources: [{ ref: 'docs/architecture.md', role: 'authority' }],
  });
  const result = `## Audit result\n\n${'Detailed repository-grounded finding.\n'.repeat(520)}RESULT_END`;
  const threadUpdate = `# Proposed Thread\n\n${'Durable architectural detail.\n'.repeat(650)}THREAD_END`;
  assert.ok(Buffer.byteLength(result, 'utf8') > 16 * 1024);
  assert.ok(Buffer.byteLength(threadUpdate, 'utf8') > 16 * 1024);

  const returned = await fixture.repository.returnWorkUnit(entered.handle, {
    status: 'partial',
    result,
    threadUpdate,
    resources: [{ ref: 'docs/architecture.md', role: 'authority' }],
  });
  assert.equal(returned.result, result);
  assert.equal(returned.threadUpdate, threadUpdate);
  assert.equal(returned.parentHandle.scopeId, root.scopeId);

  const resumed = await fixture.repository.compileContext(conversation.conversationId);
  assert.equal(resumed.scopeKind, 'turn');
  const resumedText = JSON.stringify(resumed.messages);
  assert.match(resumedText, /RESULT_END/u);
  assert.match(resumedText, /THREAD_END/u);
  await fixture.repository.finishTurn(root, { status: 'interrupted' });
});

test('work-unit directory resources are correctable before the durable entry commit', async (t) => {
  const fixture = await repositoryFixture(t);
  const conversation = await fixture.repository.createConversation({
    operationId: crypto.randomUUID(), cwd: fixture.cwd, modelId: 'model', reasoning: 'high',
  });
  const root = await accept(fixture.repository, conversation.conversationId, 'Implement the seam.');

  await assert.rejects(
    fixture.repository.prepareWorkUnitEntry(root, {
      objective: 'Implement the source tree.',
      resources: [{ ref: 'src', role: 'deliverable' }],
    }),
    /must be a UTF-8 text file; directories are not supported/u,
  );
  const eventsBeforeRetry = await fixture.repository.readEvents({
    conversationId: conversation.conversationId,
  });
  assert.ok(eventsBeforeRetry.every(({ type }) => type !== 'work_unit.entered'));

  const entered = await fixture.repository.enterWorkUnit(root, {
    objective: 'Implement the seam file.',
    resources: [{ ref: 'src/seam.ts', role: 'deliverable' }],
  });
  assert.equal(entered.resources[0]?.snapshot.source, 'file');
  await fixture.repository.returnWorkUnit(entered.handle, {
    status: 'completed',
    result: 'The corrected file resource was accepted.',
  });
  await fixture.repository.finishTurn(root, { status: 'completed' });
});

test('turn failure abandons an unreturned work unit with its own terminal event', async (t) => {
  const fixture = await repositoryFixture(t);
  const conversation = await fixture.repository.createConversation({
    operationId: crypto.randomUUID(), cwd: fixture.cwd, modelId: 'model', reasoning: 'high',
  });
  const root = await accept(fixture.repository, conversation.conversationId, 'Run bounded work.');
  const entered = await fixture.repository.enterWorkUnit(root, {
    objective: 'Exercise abnormal child cleanup.', resources: [],
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

test('History retrieval exposes Thread documents and exact visible outcomes but not private provider artifacts', async (t) => {
  const fixture = await repositoryFixture(t);
  const conversation = await fixture.repository.createConversation({
    operationId: crypto.randomUUID(), cwd: fixture.cwd, modelId: 'model', reasoning: 'high',
  });
  const turn = await accept(fixture.repository, conversation.conversationId, 'Remember cobalt behavior.');
  await fixture.repository.appendAssistantCheckpoint(turn, {
    textDelta: 'Cobalt behavior is retained in exact history.', reasoningDelta: '',
  });
  await fixture.repository.replaceThread(turn, {
    baseVersionId: conversation.threadVersionId,
    content: '# Thread\n\nConstraint: preserve cobalt behavior.\n',
  });
  await fixture.repository.finishTurn(turn, { status: 'completed' });
  const search = await fixture.repository.searchHistory(conversation.conversationId, {
    query: 'cobalt', scope: 'conversation',
  });
  assert.ok(search.hits.some(({ kind }) => kind === 'thread-document'));
  const outcome = search.hits.find(({ kind }) => kind === 'assistant-outcome');
  assert.ok(outcome);
  const opened = await fixture.repository.openHistory(conversation.conversationId, { ref: outcome!.ref });
  assert.match(opened.content, /Cobalt behavior/u);

  const safelyTokenized = await fixture.repository.searchHistory(conversation.conversationId, {
    query: 'cobalt (behavior):', scope: 'conversation',
  });
  assert.ok(safelyTokenized.hits.length >= 2);
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
  assert.ok(rebuilt.hits.some(({ kind }) => kind === 'thread-document'));
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

test('context pressure is durable, scope-specific, and emitted at most once across restart', async (t) => {
  const fixture = await repositoryFixture(t);
  const conversation = await fixture.repository.createConversation({
    operationId: crypto.randomUUID(), cwd: fixture.cwd, modelId: 'model', reasoning: 'high',
  });
  const turn = await accept(
    fixture.repository,
    conversation.conversationId,
    `Perform a coherent task with enough active text to cross a test boundary. ${'pressure '.repeat(80)}`,
  );
  const before = await fixture.repository.compileContext(conversation.conversationId, 120);
  assert.equal(before.frame.pressureNoticed, false);
  assert.ok(before.frame.estimatedInputTokens >= before.frame.softContextLimit);
  assert.equal(await fixture.repository.recordContextPressure(turn, {
    estimatedInputTokens: before.frame.estimatedInputTokens,
    softContextLimit: before.frame.softContextLimit,
    hardContextLimit: before.frame.hardContextLimit,
  }), true);
  assert.equal(await fixture.repository.recordContextPressure(turn, {
    estimatedInputTokens: before.frame.estimatedInputTokens + 1,
    softContextLimit: before.frame.softContextLimit,
    hardContextLimit: before.frame.hardContextLimit,
  }), false);
  const noticed = await fixture.repository.compileContext(conversation.conversationId, 120);
  assert.equal(noticed.frame.pressureNoticed, true);
  assert.ok(noticed.messages.some((message) =>
    message.role === 'user' && message.text.includes('Context pressure notice')));

  await fixture.repository.close();
  fixture.repository = await AgentStateStore.open({ dataRoot: fixture.dataRoot });
  const recovery = await fixture.repository.resumeActiveTurn(conversation.conversationId);
  assert.equal(recovery?.handle.turnId, turn.turnId);
  assert.equal(await fixture.repository.recordContextPressure(turn, {
    estimatedInputTokens: noticed.frame.estimatedInputTokens,
    softContextLimit: noticed.frame.softContextLimit,
    hardContextLimit: noticed.frame.hardContextLimit,
  }), false);
  const events = await fixture.repository.readEvents({ conversationId: conversation.conversationId });
  assert.equal(events.filter(({ type }) => type === 'context.pressure').length, 1);
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
  await startInference(fixture.repository, turn, context);
  await fixture.repository.finishInference(turn, { state: 'failed' });
  await fixture.repository.recordToolStarted(turn, {
    callId: 'durable-effect', name: 'bash', args: { command: 'touch sentinel' },
  });
  await assert.rejects(
    fixture.repository.supersedeInference(turn, {
      attempt: 1, maxAttempts: 2, delayMs: 500, error: 'WebSocket error',
    }),
    /durable tool effect/u,
  );
  await fixture.repository.finishTurn(turn, { status: 'failed', error: 'Transport failed.' });
});

test('the public fixture runtime commits a v5 frame and completes through normal server hooks', async (t) => {
  const fixture = await repositoryFixture(t);
  const server = new AgentServer({
    engine: new FixtureEngine(),
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
  assert.equal(inspector.version, 5);
  assert.equal(typeof inspector.frameId, 'string');
  assert.equal(inspector.layers?.length, 3);
  const thread = await server.handle('remux/agent/thread/read', {
    conversationId: created.conversationId,
  }) as { current?: { content?: string; ordinal?: number }; previous?: unknown };
  assert.equal(thread.current?.content, '# Thread\n');
  assert.equal(thread.current?.ordinal, 0);
  assert.equal(thread.previous, null);
  const durableTurn = await server.handle('remux/agent/turn/read', {
    conversationId: created.conversationId,
    turnId: sent.turnId,
  }) as { state?: string; terminal?: boolean; terminalSequence?: number | null };
  assert.equal(durableTurn.state, 'completed');
  assert.equal(durableTurn.terminal, true);
  assert.equal(typeof durableTurn.terminalSequence, 'number');
  const events = await fixture.repository.readEvents({ conversationId: created.conversationId });
  assert.ok(events.some(({ type }) => type === 'provider.item.recorded'));
  assert.ok(events.some(({ type }) => type === 'turn.terminal'));
});

test('the public runtime recovers a response-started transport drop without duplicating partial output', async (t) => {
  const fixture = await repositoryFixture(t);
  const server = new AgentServer({
    engine: new RecoveringTransportFixtureEngine(),
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

function accept(repository: AgentStateStore, conversationId: string, text: string) {
  return repository.acceptTurn({
    operationId: crypto.randomUUID(),
    conversationId,
    clientMessageId: crypto.randomUUID(),
    text,
  });
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

class RecoveringTransportFixtureEngine implements AgentEngine {
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

  async createConversation(
    options: Parameters<AgentEngine['createConversation']>[0],
  ): Promise<ConversationRuntime> {
    let interrupted = false;
    return {
      async prompt() {
        const firstContext = await options.durability.compileContext(400_000);
        await options.durability.beforeProviderCall({
          payload: { input: 'first-attempt' },
          requestMode: 'full',
          estimatedInputTokens: firstContext.frame.estimatedInputTokens,
          context: durableFixtureContext(firstContext),
        });
        options.onEvent({ type: 'assistant-start' });
        options.onEvent({ type: 'assistant-text', delta: 'Partial transport output.' });
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
        const retryContext = await options.durability.compileContext(400_000);
        await options.durability.beforeProviderCall({
          payload: { input: 'fresh-full-retry' },
          requestMode: 'full',
          estimatedInputTokens: retryContext.frame.estimatedInputTokens,
          retryOfInferenceId: superseded.inferenceId,
          context: durableFixtureContext(retryContext),
        });
        const recovered = 'Recovered through a fresh provider frame.';
        options.onEvent({ type: 'assistant-start' });
        options.onEvent({ type: 'assistant-text', delta: recovered });
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
