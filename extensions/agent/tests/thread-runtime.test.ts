import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';

import type { AssistantMessage } from '@earendil-works/pi-ai';

import { AgentServer } from '../server/src/agent-server.ts';
import { FixtureEngine } from '../server/src/fixture-engine.ts';
import { AgentJournalRepository, type DurableTurnHandle } from '../server/src/storage/repository.ts';
import { AGENT_JOURNAL_TABLES } from '../server/src/storage/schema.ts';

test('Thread Runtime v1 owns one clean schema and compiles the accepted user turn', async (t) => {
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

  const database = new DatabaseSync(fixture.repository.databasePath);
  t.after(() => database.close());
  const tables: string[] = (database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name
  `).all() as Array<{ name: string }>).map(({ name }) => name);
  const tableNames = new Set<string>(tables);
  assert.deepEqual(tables, [...AGENT_JOURNAL_TABLES].sort());
  for (const removed of [
    'context_spaces', 'project_primaries', 'epochs', 'context_compilations',
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
  fixture.repository = await AgentJournalRepository.open({ dataRoot: fixture.dataRoot });
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
  assert.deepEqual(next.frame.capsuleTurnIds, [turn.turnId]);
  assert.ok(next.messages.every((message) =>
    message.turnId !== turn.turnId || message.role !== 'tool'));
  await fixture.repository.finishTurn(followup, { status: 'interrupted' });
  assert.ok(provider.providerItemId);
});

test('thread.md updates are CAS-versioned and historical edit/fork inheritance is exact', async (t) => {
  const fixture = await repositoryFixture(t);
  const source = await fixture.repository.createConversation({
    operationId: crypto.randomUUID(), cwd: fixture.cwd, modelId: 'model', reasoning: 'high',
  });
  const turn = await accept(fixture.repository, source.conversationId, 'Choose the design.');
  const updated = await fixture.repository.updateThread(turn, {
    baseVersionId: source.threadVersionId,
    content: '# Thread\n\nDecision: use immutable capsules.\n',
  });
  await assert.rejects(
    fixture.repository.updateThread(turn, {
      baseVersionId: source.threadVersionId,
      content: '# Thread\n\nStale overwrite.\n',
    }),
    /changed from/u,
  );
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

test('bounded work units inherit the parent and fold back only their explicit result', async (t) => {
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
      { type: 'toolCall', id: 'call:enter', name: 'work_unit_enter', arguments: { objective: 'Inspect one seam.' } },
    ],
    stopReason: 'toolUse',
  }));
  await fixture.repository.appendAssistantCheckpoint(root, {
    textDelta: '', reasoningDelta: 'parent reasoning',
  });
  await fixture.repository.finishInference(root, { state: 'completed' });
  await fixture.repository.recordToolStarted(root, {
    callId: 'call:enter', name: 'work_unit_enter', args: { objective: 'Inspect one seam.' },
  });
  const entered = await fixture.repository.enterWorkUnit(root, {
    objective: 'Inspect one seam.', evidenceRefs: ['journal://turn/example'],
  });
  await fixture.repository.recordToolFinished(root, {
    callId: 'call:enter', result: { scopeId: entered.handle.scopeId }, isError: false,
  });

  const childContext = await fixture.repository.compileContext(conversation.conversationId);
  assert.equal(childContext.scopeKind, 'work_unit');
  assert.equal(childContext.scopeId, entered.handle.scopeId);
  assert.ok(childContext.messages.some((message) =>
    message.role === 'user' && message.text.includes('Inspect one seam.')));
  const inherited = childContext.messages.find((message) => message.role === 'assistant');
  assert.equal(inherited?.role, 'assistant');
  if (inherited?.role === 'assistant') {
    const thinking = inherited.providerMessage?.content.find(({ type }) => type === 'thinking');
    assert.equal(thinking?.type === 'thinking' ? thinking.thinkingSignature : null, 'parent-signature');
  }

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
    callId: 'call:return', name: 'work_unit_return', args: { result: 'The seam is sound.' },
  });
  await fixture.repository.recordToolFinished(entered.handle, {
    callId: 'call:return', result: { state: 'returning' }, isError: false,
  });
  const returned = await fixture.repository.returnWorkUnit(entered.handle, {
    result: '## Result\n\nThe seam is sound.',
  });
  assert.equal(returned.parentHandle.scopeId, root.scopeId);

  const resumed = await fixture.repository.compileContext(conversation.conversationId);
  assert.equal(resumed.scopeKind, 'turn');
  assert.equal(resumed.scopeId, root.scopeId);
  const resumedText = JSON.stringify(resumed.messages);
  assert.match(resumedText, /The seam is sound/u);
  assert.match(resumedText, /Active execution scope: parent turn/u);
  assert.doesNotMatch(resumedText, /CHILD_PRIVATE_REASONING|CHILD_TOOL_RESULT|child-signature/u);
  const resumedAssistant = resumed.messages.find((message) => message.role === 'assistant');
  assert.equal(resumedAssistant?.role, 'assistant');
  if (resumedAssistant?.role === 'assistant') {
    const thinking = resumedAssistant.providerMessage?.content.find(({ type }) => type === 'thinking');
    assert.equal(thinking?.type === 'thinking' ? thinking.thinkingSignature : null, 'parent-signature');
  }

  await fixture.repository.appendAssistantCheckpoint(root, { textDelta: 'Parent complete.', reasoningDelta: '' });
  await fixture.repository.finishTurn(root, { status: 'completed' });
  const capsuleSearch = await fixture.repository.searchJournal(conversation.conversationId, {
    query: 'seam sound', scope: 'conversation',
  });
  const capsule = capsuleSearch.hits.find(({ kind }) => kind === 'turn-capsule');
  assert.ok(capsule);
  const opened = await fixture.repository.openJournal(conversation.conversationId, { ref: capsule!.ref });
  assert.match(opened.content, /## Work units[\s\S]*The seam is sound/u);
});

test('journal retrieval exposes thread documents and capsules but not private provider artifacts', async (t) => {
  const fixture = await repositoryFixture(t);
  const conversation = await fixture.repository.createConversation({
    operationId: crypto.randomUUID(), cwd: fixture.cwd, modelId: 'model', reasoning: 'high',
  });
  const turn = await accept(fixture.repository, conversation.conversationId, 'Remember cobalt behavior.');
  await fixture.repository.appendAssistantCheckpoint(turn, {
    textDelta: 'Cobalt behavior is retained in the capsule.', reasoningDelta: '',
  });
  await fixture.repository.updateThread(turn, {
    baseVersionId: conversation.threadVersionId,
    content: '# Thread\n\nConstraint: preserve cobalt behavior.\n',
  });
  await fixture.repository.finishTurn(turn, { status: 'completed' });
  const search = await fixture.repository.searchJournal(conversation.conversationId, {
    query: 'cobalt', scope: 'conversation',
  });
  assert.ok(search.hits.some(({ kind }) => kind === 'thread-document'));
  const capsule = search.hits.find(({ kind }) => kind === 'turn-capsule');
  assert.ok(capsule);
  const opened = await fixture.repository.openJournal(conversation.conversationId, { ref: capsule!.ref });
  assert.match(opened.content, /Cobalt behavior/u);
});

test('the public fixture runtime commits a v3 frame and completes through normal server hooks', async (t) => {
  const fixture = await repositoryFixture(t);
  const server = new AgentServer({
    engine: new FixtureEngine(),
    journal: fixture.repository,
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
  await server.handle('remux/agent/conversation/message/send', {
    operationId: crypto.randomUUID(),
    conversationId: created.conversationId,
    clientMessageId: crypto.randomUUID(),
    text: 'Exercise the public path.',
  });
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
  assert.equal(inspector.version, 3);
  assert.equal(typeof inspector.frameId, 'string');
  assert.equal(inspector.layers?.length, 4);
  const events = await fixture.repository.readEvents({ conversationId: created.conversationId });
  assert.ok(events.some(({ type }) => type === 'provider.item.recorded'));
  assert.ok(events.some(({ type }) => type === 'turn.terminal'));
});

async function repositoryFixture(t: TestContext) {
  const dataRoot = await mkdtemp(join(tmpdir(), 'remux-agent-thread-runtime-'));
  const cwd = process.cwd();
  const fixture = {
    dataRoot,
    cwd,
    repository: await AgentJournalRepository.open({ dataRoot }),
  };
  t.after(async () => {
    await fixture.repository.close();
    await rm(dataRoot, { recursive: true, force: true });
  });
  return fixture;
}

function accept(repository: AgentJournalRepository, conversationId: string, text: string) {
  return repository.acceptTurn({
    operationId: crypto.randomUUID(),
    conversationId,
    clientMessageId: crypto.randomUUID(),
    text,
  });
}

async function startInference(
  repository: AgentJournalRepository,
  handle: DurableTurnHandle,
  context: Awaited<ReturnType<AgentJournalRepository['compileContext']>>,
) {
  return repository.startInference(handle, {
    modelId: 'gpt-5.6-codex',
    requestMode: 'full',
    estimatedInputTokens: 2_000,
    payload: { messages: [] },
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
