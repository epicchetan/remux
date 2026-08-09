import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  AGENT_METHODS,
  AGENT_RESOURCE_KEYS,
  conversationResourceKey,
  contextResourceKey,
  type AgentRuntimeValue,
  type ArtifactReadResult,
  type ConversationListValue,
  type ConversationSummary,
  type ConversationValue,
  type ContextInspectorValue,
  type MessageBranchResult,
  type ResourceReadResult,
} from '../shared/protocol.ts';
import {
  AGENT_TRANSCRIPT_PROJECTION_VERSION,
  AGENT_TRANSCRIPT_PROTOCOL_VERSION,
  type AgentTranscriptResourcesReadResult,
  type AgentTranscriptSyncRequest,
  type AgentTranscriptSyncResource,
  type AgentTurnRenderFrame,
  type AgentWorkEntryDetailResource,
  type AgentWorkGroupResource,
  type AgentWorkGroupTimelineEntry,
  type AgentWorkRenderSegment,
} from '../shared/transcript.ts';
import { AgentServer, RpcFault } from '../server/src/agent-server.ts';
import type { AgentConversationJournal } from '../server/src/conversation-journal.ts';
import type { AgentEngine, RuntimeDurabilityHooks } from '../server/src/engine.ts';
import { FixtureEngine } from '../server/src/fixture-engine.ts';
import {
  createDurableContextSnapshot,
  reduceLogicalReplay,
  type LogicalContextMessage,
  type LogicalReplayEvent,
} from '../server/src/logical-context.ts';
import { handleJsonRpcLine, JsonRpcOutput, serveStdio } from '../server/src/json-rpc.ts';
import { createReplayedTranscriptProjector } from '../server/src/transcript-replay.ts';
import {
  EphemeralTranscriptProjector,
  parseTranscriptResourcesReadParams,
} from '../server/src/transcript-projector.ts';
import { readWorkspaceFile } from '../server/src/workspace-read.ts';
import { AgentJournalRepository } from '../server/src/storage/repository.ts';
import { ArtifactIntegrityError } from '../server/src/storage/artifact-store.ts';
import { compileShadowContext } from '../server/src/context/compiler.ts';

test('resource reads support revisions and reconnect generations', async () => {
  const server = testServer();
  await server.initialize();
  const first = await server.handle(AGENT_METHODS.resourcesRead, {
    requests: [{ key: 'auth' }],
  }) as ResourceReadResult;
  assert.equal(first.resources[0]?.status, 'ok');
  const resource = first.resources[0];
  assert.ok(resource && resource.status === 'ok');

  const second = await server.handle(AGENT_METHODS.resourcesRead, {
    requests: [{ key: 'auth', ifNoneMatch: resource.revision }],
  }) as ResourceReadResult;
  assert.equal(second.resources[0]?.status, 'notModified');
  assert.equal(second.resources[0]?.serverGeneration, resource.serverGeneration);

  const restarted = testServer();
  await restarted.initialize();
  const afterRestart = await restarted.handle(AGENT_METHODS.resourcesRead, {
    requests: [{ key: 'auth' }],
  }) as ResourceReadResult;
  assert.notEqual(afterRestart.resources[0]?.serverGeneration, resource.serverGeneration);
});

test('protocol v2 rejects legacy methods, duplicate resources, and malformed Agent identities', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'remux-agent-protocol-v2-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const server = testServer();
  await server.initialize();
  await assert.rejects(
    () => server.handle('remux/agent/conversation/start', {
      operationId: randomUUID(),
      cwd: root,
      modelId: 'gpt-5.4-fixture',
      reasoning: 'high',
    }),
    (error) => error instanceof RpcFault && error.code === -32601,
  );
  await assert.rejects(
    () => server.handle(AGENT_METHODS.resourcesRead, {
      requests: [{ key: 'auth' }, { key: 'auth' }],
    }),
    /duplicate resource key/u,
  );
  await assert.rejects(
    () => server.handle(AGENT_METHODS.resourcesRead, {
      requests: Array.from({ length: 65 }, () => ({ key: 'auth' })),
    }),
    /64 item limit/u,
  );
  await assert.rejects(
    () => server.handle(AGENT_METHODS.conversationCreate, {
      operationId: 'not-a-uuid',
      cwd: root,
      modelId: 'gpt-5.4-fixture',
      reasoning: 'high',
    }),
    /lowercase UUID v4/u,
  );
  const createOperationId = randomUUID();
  const created = await server.handle(AGENT_METHODS.conversationCreate, {
    operationId: createOperationId,
    cwd: root,
    modelId: 'gpt-5.4-fixture',
    reasoning: 'high',
  }) as { conversationId: string };
  await assert.rejects(
    () => server.handle(AGENT_METHODS.messageSend, {
      operationId: createOperationId,
      conversationId: created.conversationId,
      clientMessageId: randomUUID(),
      text: 'operation identities are global',
    }),
    (error) => error instanceof RpcFault &&
      error.code === -32018 &&
      (error.data as { kind?: unknown }).kind === 'operation_conflict',
  );
  await assert.rejects(
    () => server.handle(AGENT_METHODS.messageSend, {
      operationId: 'not-a-uuid',
      conversationId: created.conversationId,
      clientMessageId: randomUUID(),
      text: 'reject before admission',
    }),
    /operationId must be a lowercase UUID v4/u,
  );
  await assert.rejects(
    () => server.handle(AGENT_METHODS.messageSend, {
      operationId: randomUUID(),
      conversationId: created.conversationId,
      clientMessageId: 'not-a-uuid',
      text: 'reject before admission',
    }),
    /clientMessageId must be a lowercase UUID v4/u,
  );
  await assert.rejects(
    () => server.handle(AGENT_METHODS.transcriptResourcesRead, {
      conversationId: 'not-a-uuid',
      requests: [syncRequest({ kind: 'tail' })],
    }),
    /conversationId must be a lowercase UUID v4/u,
  );
});

test('replacing the live runtime keeps prior durable resources readable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'remux-agent-replace-'));
  const server = testServer();
  await server.initialize();
  const models = await server.handle(AGENT_METHODS.modelsRead, {}) as { defaultModelId: string };
  const first = await server.handle(AGENT_METHODS.conversationCreate, {
    operationId: randomUUID(),
    cwd: root,
    modelId: models.defaultModelId,
    reasoning: 'high',
  }) as { conversationId: string };
  const second = await server.handle(AGENT_METHODS.conversationCreate, {
    operationId: randomUUID(),
    cwd: root,
    modelId: models.defaultModelId,
    reasoning: 'high',
  }) as { conversationId: string };

  assert.notEqual(second.conversationId, first.conversationId);
  const priorConversation = await server.handle(AGENT_METHODS.resourcesRead, {
    requests: [{ key: conversationResourceKey(first.conversationId) }],
  }) as ResourceReadResult;
  assert.equal(priorConversation.resources[0]?.status, 'ok');
  const priorTranscript = await server.handle(AGENT_METHODS.transcriptResourcesRead, {
    conversationId: first.conversationId,
    requests: [syncRequest({ kind: 'tail' })],
  }) as AgentTranscriptResourcesReadResult;
  assert.deepEqual(requiredSync(priorTranscript).turnOrder, []);
});

test('durable history reads do not hydrate Pi and survive sign-out', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'remux-agent-history-read-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  let recordedAt = 1;
  const repository = await AgentJournalRepository.open({
    dataRoot: join(root, 'data'),
    now: () => recordedAt,
  });
  const first = await repository.createConversation({
    operationId: randomUUID(),
    cwd: root,
    modelId: 'gpt-5.4-fixture',
    reasoning: 'high',
  });
  recordedAt = 2;
  const second = await repository.createConversation({
    operationId: randomUUID(),
    cwd: root,
    modelId: 'gpt-5.4-fixture',
    reasoning: 'medium',
  });
  class CountingFixtureEngine extends FixtureEngine {
    conversationCreations = 0;

    override async createConversation(options: Parameters<AgentEngine['createConversation']>[0]) {
      this.conversationCreations += 1;
      return super.createConversation(options);
    }
  }
  const engine = new CountingFixtureEngine();
  const journal: AgentConversationJournal = {
    createConversation: (params) => repository.createConversation(params),
    ...repositoryJournal(repository),
  };
  const server = new AgentServer({ engine, journal, notify: () => {} });
  t.after(async () => {
    await server.close();
    await repository.close();
  });
  await server.initialize();

  const read = await server.handle(AGENT_METHODS.resourcesRead, {
    requests: [
      { key: 'conversation-list' },
      { key: conversationResourceKey(first.conversationId) },
    ],
  }) as ResourceReadResult;
  const list = read.resources[0];
  const old = read.resources[1];
  assert.ok(list?.status === 'ok' && old?.status === 'ok');
  assert.deepEqual(
    (list.value as ConversationListValue).conversations.map((summary) => summary.id),
    [second.conversationId, first.conversationId],
  );
  assert.equal((old.value as ConversationSummary).id, first.conversationId);
  assert.equal(engine.conversationCreations, 0);

  const transcript = await server.handle(AGENT_METHODS.transcriptResourcesRead, {
    conversationId: first.conversationId,
    requests: [syncRequest({ kind: 'tail' })],
  }) as AgentTranscriptResourcesReadResult;
  assert.deepEqual(requiredSync(transcript).turnOrder, []);
  assert.equal(engine.conversationCreations, 0);

  const unchanged = await server.handle(AGENT_METHODS.resourcesRead, {
    requests: [{
      key: conversationResourceKey(first.conversationId),
      ifNoneMatch: old.basisSequence,
    }],
  }) as ResourceReadResult;
  assert.equal(unchanged.resources[0]?.status, 'notModified');
  await server.handle(AGENT_METHODS.authLogout, {});
  const afterLogout = await server.handle(AGENT_METHODS.resourcesRead, {
    requests: [{ key: conversationResourceKey(first.conversationId) }],
  }) as ResourceReadResult;
  assert.equal(afterLogout.resources[0]?.status, 'ok');
  assert.equal(engine.conversationCreations, 0);
});

test('artifact reads expose only bounded hash-addressed byte or line ranges', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'remux-agent-artifact-read-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const repository = await AgentJournalRepository.open({ dataRoot: join(root, 'data') });
  t.after(() => repository.close());
  const created = await repository.createConversation({
    operationId: randomUUID(),
    cwd: root,
    modelId: 'gpt-5.4-fixture',
    reasoning: 'high',
  });
  await repository.acceptTurn({
    operationId: randomUUID(),
    conversationId: created.conversationId,
    clientMessageId: randomUUID(),
    text: `line-1\nline-2\n🙂${'x'.repeat(17_000)}`,
  });
  const userEvent = (await repository.readEvents({ conversationId: created.conversationId }))
    .find(({ type }) => type === 'message.user');
  const content = (userEvent?.payload as {
    content?: { kind?: unknown; hash?: unknown };
  } | null)?.content;
  assert.equal(content?.kind, 'artifact');
  assert.equal(typeof content.hash, 'string');
  const hash = content.hash as string;

  const server = new AgentServer({ engine: new FixtureEngine(), journal: repository, notify: () => {} });
  t.after(() => server.close());
  await server.initialize();
  const bytes = await server.handle(AGENT_METHODS.artifactRead, {
    hash,
    range: { kind: 'bytes', offset: 0, byteLength: 6 },
  }) as ArtifactReadResult;
  assert.equal(bytes.encoding, 'base64');
  assert.equal(Buffer.from(bytes.content, 'base64').toString('utf8'), 'line-1');
  assert.deepEqual(bytes.range, { kind: 'bytes', offset: 0, byteLength: 6 });
  assert.deepEqual(bytes.nextRange, { kind: 'bytes', offset: 6, byteLength: 6 });

  const lines = await server.handle(AGENT_METHODS.artifactRead, {
    hash,
    range: { kind: 'lines', startLine: 2, lineCount: 1 },
  }) as ArtifactReadResult;
  assert.equal(lines.encoding, 'utf8');
  assert.equal(lines.content, 'line-2');
  assert.deepEqual(lines.range, { kind: 'lines', startLine: 2, endLine: 2 });
  assert.deepEqual(lines.nextRange, { kind: 'lines', startLine: 3, lineCount: 1 });

  const utf8 = await server.handle(AGENT_METHODS.artifactRead, {
    hash,
    range: { kind: 'utf8', offset: 14, byteLength: 1 },
  }) as ArtifactReadResult;
  assert.equal(utf8.encoding, 'utf8');
  assert.equal(utf8.content, '🙂');
  assert.deepEqual(utf8.range, { kind: 'utf8', offset: 14, byteLength: 4 });
  assert.deepEqual(utf8.nextRange, { kind: 'utf8', offset: 18, byteLength: 1 });
  await assert.rejects(
    () => server.handle(AGENT_METHODS.artifactRead, {
      hash,
      range: { kind: 'utf8', offset: 15, byteLength: 4 },
    }),
    (error) => error instanceof RpcFault && error.code === -32602,
  );

  await assert.rejects(
    () => server.handle(AGENT_METHODS.artifactRead, {
      hash,
      range: { kind: 'bytes', offset: 0, byteLength: 48 * 1024 + 1 },
    }),
    (error) => error instanceof RpcFault && error.code === -32602,
  );
  await assert.rejects(
    () => server.handle(AGENT_METHODS.artifactRead, {
      hash: hash.toUpperCase(),
      range: { kind: 'bytes', offset: 0, byteLength: 1 },
    }),
    (error) => error instanceof RpcFault && error.code === -32602,
  );
  await assert.rejects(
    () => server.handle(AGENT_METHODS.artifactRead, {
      hash: '0'.repeat(64),
      range: { kind: 'bytes', offset: 0, byteLength: 1 },
    }),
    (error) => error instanceof RpcFault && error.code === -32015,
  );
});

test('artifact integrity failures are typed and redact durable object identity', async () => {
  class CorruptArtifactJournal extends TestConversationJournal {
    override async readArtifact(): Promise<never> {
      throw new ArtifactIntegrityError('hash');
    }
  }
  const server = testServer(new FixtureEngine(), () => {}, new CorruptArtifactJournal());
  await server.initialize();
  await assert.rejects(
    () => server.handle(AGENT_METHODS.artifactRead, {
      hash: 'a'.repeat(64),
      range: { kind: 'bytes', offset: 0, byteLength: 1 },
    }),
    (error) => error instanceof RpcFault &&
      error.code === -32023 &&
      error.message === 'Durable artifact failed integrity verification.' &&
      JSON.stringify(error.data) === '{"kind":"durable_corruption"}',
  );
  await server.close();
});

test('cold oversized assistant text stays bounded and is explicitly range-addressable', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'remux-agent-oversized-assistant-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const repository = await AgentJournalRepository.open({ dataRoot: join(root, 'data') });
  const conversation = await repository.createConversation({
    operationId: randomUUID(),
    cwd: root,
    modelId: 'gpt-5.4-fixture',
    reasoning: 'high',
  });
  const turn = await repository.acceptTurn({
    operationId: randomUUID(),
    conversationId: conversation.conversationId,
    clientMessageId: randomUUID(),
    text: 'Return a deliberately oversized exact response.',
  });
  const exact = '0123456789🙂\n'.repeat(150_000);
  await repository.appendAssistantCheckpoint(turn, { textDelta: exact, reasoningDelta: '' });
  await repository.finishTurn(turn, { status: 'completed' });

  const server = new AgentServer({ engine: new FixtureEngine(), journal: repository, notify: () => {} });
  t.after(async () => {
    await server.close();
    await repository.close();
  });
  await server.initialize();
  const transcript = await readTranscriptSync(server, conversation.conversationId);
  const frame = requiredFrame(transcript.turns[0]);
  const assistant = frame.segments.find((segment) => segment.type === 'assistantMessage');
  assert.ok(assistant && assistant.type === 'assistantMessage');
  assert.ok(Buffer.byteLength(assistant.text, 'utf8') <= 48 * 1024);
  assert.equal(assistant.content?.byteLength, Buffer.byteLength(exact));
  assert.equal(assistant.content?.returnedBytes, Buffer.byteLength(assistant.text));
  assert.equal(typeof assistant.content?.artifactHash, 'string');
  assert.ok(assistant.content?.nextRange);

  const range = await server.handle(AGENT_METHODS.artifactRead, {
    hash: assistant.content.artifactHash,
    range: assistant.content.nextRange,
  }) as ArtifactReadResult;
  assert.equal(range.encoding, 'utf8');
  assert.ok(Buffer.byteLength(range.content) <= 48 * 1024);
  const source = Buffer.from(exact, 'utf8');
  assert.deepEqual(
    Buffer.from(range.content, 'utf8'),
    source.subarray(range.range.kind === 'utf8' ? range.range.offset : 0,
      range.range.kind === 'utf8' ? range.range.offset + range.range.byteLength : 0),
  );
});

test('unloaded transcript routing is cached and matches the hydrated live projection exactly', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'remux-agent-transcript-route-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  let recordedAt = 100;
  const repository = await AgentJournalRepository.open({
    dataRoot: join(root, 'data'),
    now: () => recordedAt++,
  });
  const operationId = randomUUID();
  const createParams = {
    operationId,
    cwd: root,
    modelId: 'gpt-5.4-fixture',
    reasoning: 'high' as const,
  };
  const durable = await repository.createConversation(createParams);
  const turn = await repository.acceptTurn({
    operationId: randomUUID(),
    conversationId: durable.conversationId,
    clientMessageId: randomUUID(),
    text: 'Inspect the durable transcript',
  });
  await repository.appendAssistantCheckpoint(turn, {
    reasoningDelta: 'Checking the journal. ',
    textDelta: 'The durable projection is ready.',
  });
  await repository.recordToolStarted(turn, {
    callId: 'transcript-route-tool',
    name: 'workspace_read',
    args: { path: 'README.md' },
  });
  await repository.recordToolFinished(turn, {
    callId: 'transcript-route-tool',
    result: { text: '# Remux' },
    isError: false,
  });
  await repository.finishTurn(turn, { status: 'completed' });

  class CountingFixtureEngine extends FixtureEngine {
    conversationCreations = 0;

    override async createConversation(options: Parameters<AgentEngine['createConversation']>[0]) {
      this.conversationCreations += 1;
      return super.createConversation(options);
    }
  }
  const engine = new CountingFixtureEngine();
  let projectionReads = 0;
  const journal: AgentConversationJournal = {
    createConversation: (params) => repository.createConversation(params),
    ...repositoryJournal(repository),
    async readTranscriptWindowProjection(params) {
      projectionReads += 1;
      return repository.readTranscriptWindowProjection(params);
    },
  };
  const server = new AgentServer({ engine, journal, notify: () => {} });
  t.after(async () => {
    await server.close();
    await repository.close();
  });
  await server.initialize();

  const unloaded = await readTranscriptSync(server, durable.conversationId);
  const cached = await readTranscriptSync(server, durable.conversationId);
  assert.deepEqual(cached, unloaded);
  assert.equal(projectionReads, 1);
  assert.equal(engine.conversationCreations, 0);

  const laterTurn = await repository.acceptTurn({
    operationId: randomUUID(),
    conversationId: durable.conversationId,
    clientMessageId: randomUUID(),
    text: 'Refresh the frozen projection',
  });
  await repository.appendAssistantCheckpoint(laterTurn, {
    reasoningDelta: '',
    textDelta: 'The durable basis advanced.',
  });
  await repository.finishTurn(laterTurn, { status: 'completed' });
  const updated = await readTranscriptSync(server, durable.conversationId);
  assert.equal(updated.turnOrder.length, 2);
  assert.equal(projectionReads, 2);
  assert.equal(engine.conversationCreations, 0);

  await server.handle(AGENT_METHODS.conversationCreate, createParams);
  const loaded = await readTranscriptSync(server, durable.conversationId);
  assert.deepEqual(loaded, updated);
  assert.equal(projectionReads, 2);
  assert.equal(engine.conversationCreations, 1);
});

test('committed live transcript frames are byte-identical after cold replay', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'remux-agent-transcript-fence-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  let recordedAt = 10_000;
  const repository = await AgentJournalRepository.open({
    dataRoot: join(root, 'data'),
    now: () => recordedAt++,
  });
  const notifications: Array<{ method: string; params: unknown }> = [];
  const liveServer = new AgentServer({
    engine: new FixtureEngine(),
    journal: repository,
    notify: (method, params) => notifications.push({ method, params }),
  });
  await liveServer.initialize();
  const created = await liveServer.handle(AGENT_METHODS.conversationCreate, {
    operationId: randomUUID(),
    cwd: root,
    modelId: 'gpt-5.4-fixture',
    reasoning: 'high',
  }) as { conversationId: string };
  await liveServer.handle(AGENT_METHODS.messageSend, {
    operationId: randomUUID(),
    conversationId: created.conversationId,
    clientMessageId: randomUUID(),
    text: 'Prove the transcript revision fence.',
  });
  await waitForConversation(liveServer, created.conversationId, (value) => value.status === 'idle');
  const live = await readTranscriptSync(liveServer, created.conversationId);
  const liveFrame = requiredFrame(live.turns[0]);

  const database = new DatabaseSync(repository.databasePath, { readOnly: true });
  const items = database.prepare(`
    SELECT item_id, kind FROM transcript_items
    WHERE turn_id = ? ORDER BY first_sequence
  `).all(liveFrame.id) as Array<{ item_id: string; kind: string }>;
  database.close();
  const user = liveFrame.segments.find((segment) => segment.type === 'userMessage');
  const assistant = liveFrame.segments.find((segment) => segment.type === 'assistantMessage');
  const work = requiredWork(liveFrame);
  const group = await readWorkGroup(
    liveServer,
    created.conversationId,
    liveFrame.id,
    work.id,
    requiredGroupRef(work).id,
  );
  assert.equal(user?.id, items.find((item) => item.kind === 'user')?.item_id);
  assert.equal(assistant?.id, items.find((item) => item.kind === 'assistant')?.item_id);
  assert.equal(group.rows[0]?.id, items.find((item) => item.kind === 'tool')?.item_id);
  const transcriptInvalidations = notifications.flatMap(({ params }) => {
    const value = params as { invalidations?: unknown };
    return Array.isArray(value.invalidations)
      ? value.invalidations.filter((entry): entry is { basisSequence: number; type: string } =>
          Boolean(entry && typeof entry === 'object' &&
            (entry as { type?: unknown }).type !== 'resource'))
      : [];
  });
  assert.ok(transcriptInvalidations.length > 0);
  assert.ok(transcriptInvalidations.every(({ basisSequence }) =>
    Number.isSafeInteger(basisSequence) && basisSequence > 0 && basisSequence <= live.basisSequence));

  await liveServer.close();
  const coldServer = new AgentServer({
    engine: new FixtureEngine(),
    journal: repository,
    notify: () => {},
  });
  await coldServer.initialize();
  const cold = await readTranscriptSync(coldServer, created.conversationId);
  assert.deepEqual(cold, live);
  await coldServer.close();
  await repository.close();
});

test('transcript routing rejects an unknown durable conversation', async () => {
  const server = testServer();
  await server.initialize();
  await assert.rejects(
    () => server.handle(AGENT_METHODS.transcriptResourcesRead, {
      conversationId: randomUUID(),
      requests: [syncRequest({ kind: 'tail' })],
    }),
    (error) => error instanceof RpcFault && error.code === -32015,
  );
});

test('unloaded transcript projection cache is byte-bounded rather than conversation-count bounded', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'remux-agent-transcript-lru-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const repository = await AgentJournalRepository.open({ dataRoot: join(root, 'data') });
  const conversations: string[] = [];
  for (let index = 0; index < 9; index += 1) {
    const created = await repository.createConversation({
      operationId: randomUUID(),
      cwd: root,
      modelId: 'gpt-5.4-fixture',
      reasoning: 'high',
    });
    conversations.push(created.conversationId);
  }
  let projectionReads = 0;
  const journal: AgentConversationJournal = {
    createConversation: (params) => repository.createConversation(params),
    ...repositoryJournal(repository),
    async readTranscriptWindowProjection(params) {
      projectionReads += 1;
      return repository.readTranscriptWindowProjection(params);
    },
  };
  const server = new AgentServer({ engine: new FixtureEngine(), journal, notify: () => {} });
  t.after(async () => {
    await server.close();
    await repository.close();
  });
  await server.initialize();

  for (const conversationId of conversations) await readTranscriptSync(server, conversationId);
  assert.equal(projectionReads, 9);
  await readTranscriptSync(server, conversations[0]!);
  assert.equal(projectionReads, 9);
});

test('sending lazily switches idle runtimes, rejects a busy owner, and reconciles exact retries', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'remux-agent-lazy-switch-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const repository = await AgentJournalRepository.open({ dataRoot: join(root, 'data') });
  const firstParams = {
    operationId: randomUUID(),
    cwd: root,
    modelId: 'gpt-5.4-fixture',
    reasoning: 'high' as const,
  };
  const secondParams = { ...firstParams, operationId: randomUUID() };
  const first = await repository.createConversation(firstParams);
  const second = await repository.createConversation(secondParams);
  const seeded = await repository.acceptTurn({
    operationId: randomUUID(),
    conversationId: second.conversationId,
    clientMessageId: randomUUID(),
    text: 'Seed B before hydration',
  });
  await repository.appendAssistantCheckpoint(seeded, {
    reasoningDelta: '',
    textDelta: 'Durable B seed.',
  });
  await repository.finishTurn(seeded, { status: 'completed' });

  let releaseFirstPrompt!: () => void;
  const firstPromptGate = new Promise<void>((resolve) => {
    releaseFirstPrompt = resolve;
  });
  class CountingFixtureEngine extends FixtureEngine {
    conversationCreations = 0;

    override async createConversation(options: Parameters<AgentEngine['createConversation']>[0]) {
      this.conversationCreations += 1;
      const ordinal = this.conversationCreations;
      const runtime = await super.createConversation(options);
      if (ordinal !== 1) return runtime;
      return {
        async prompt(input: Parameters<typeof runtime.prompt>[0]) {
          await firstPromptGate;
          return runtime.prompt(input);
        },
        interrupt: () => runtime.interrupt(),
        dispose: () => runtime.dispose(),
      };
    }
  }
  const engine = new CountingFixtureEngine();
  const server = new AgentServer({ engine, journal: repository, notify: () => {} });
  t.after(async () => {
    await server.close();
    await repository.close();
  });
  await server.initialize();
  await server.handle(AGENT_METHODS.conversationCreate, firstParams);
  assert.equal(engine.conversationCreations, 1);

  const frozenSecond = await readTranscriptSync(server, second.conversationId);
  assert.equal(engine.conversationCreations, 1);
  const firstMessage = {
    operationId: randomUUID(),
    conversationId: first.conversationId,
    clientMessageId: randomUUID(),
    text: 'Keep A busy while B tries to send',
  };
  const accepted = await server.handle(AGENT_METHODS.messageSend, firstMessage);
  assert.deepEqual(await server.handle(AGENT_METHODS.messageSend, firstMessage), accepted);
  assert.equal(engine.conversationCreations, 1);

  const secondEventCount = (await repository.readEvents({ conversationId: second.conversationId })).length;
  await assert.rejects(
    () => server.handle(AGENT_METHODS.messageSend, {
      operationId: randomUUID(),
      conversationId: second.conversationId,
      clientMessageId: randomUUID(),
      text: 'Do not admit this turn while A runs',
    }),
    (error) => error instanceof RpcFault &&
      error.code === -32019 &&
      (error.data as { kind?: unknown; conversationId?: unknown }).kind === 'active_runtime_busy' &&
      (error.data as { conversationId?: unknown }).conversationId === first.conversationId,
  );
  assert.equal(
    (await repository.readEvents({ conversationId: second.conversationId })).length,
    secondEventCount,
  );
  assert.deepEqual(await readTranscriptSync(server, second.conversationId), frozenSecond);

  releaseFirstPrompt();
  await waitForConversation(server, first.conversationId, (value) => value.status === 'idle');
  const loadedSecond = await server.handle(AGENT_METHODS.messageSend, {
      operationId: randomUUID(),
    conversationId: second.conversationId,
    clientMessageId: randomUUID(),
    text: 'Switch to B after A finishes',
  }) as { turnId: string };
  assert.ok(loadedSecond.turnId);
  assert.equal(engine.conversationCreations, 2);
  const secondConversation = await waitForConversation(
    server,
    second.conversationId,
    (value) => value.status === 'idle',
  );
  assert.equal(secondConversation.contextProbe.providerRequestMode, 'full');
  const hydratedSecond = await readTranscriptSync(server, second.conversationId);
  assert.equal(hydratedSecond.turnOrder.length, 2);
  assert.deepEqual(hydratedSecond.turns[0], frozenSecond.turns[0]);

  await server.handle(AGENT_METHODS.messageSend, {
      operationId: randomUUID(),
    conversationId: first.conversationId,
    clientMessageId: randomUUID(),
    text: 'Switch back to A',
  });
  assert.equal(engine.conversationCreations, 3);
  await waitForConversation(server, first.conversationId, (value) => value.status === 'idle');
  assert.equal((await readTranscriptSync(server, first.conversationId)).turnOrder.length, 2);
  assert.equal((await readRuntime(server)).conversationId, first.conversationId);
});

test('failed lazy hydration admits no turn and can be retried', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'remux-agent-lazy-hydration-failure-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const repository = await AgentJournalRepository.open({ dataRoot: join(root, 'data') });
  const created = await repository.createConversation({
    operationId: randomUUID(),
    cwd: root,
    modelId: 'gpt-5.4-fixture',
    reasoning: 'high',
  });
  const fixture = new FixtureEngine();
  let failHydration = true;
  let server: AgentServer;
  const engine: AgentEngine = {
    authStatus: () => fixture.authStatus(),
    login: (operationId, signal, update) => fixture.login(operationId, signal, update),
    logout: () => fixture.logout(),
    listModels: () => fixture.listModels(),
    async createConversation(options) {
      assert.equal(
        server.resources.get<AgentRuntimeValue>(AGENT_RESOURCE_KEYS.runtime)?.state,
        'loading',
      );
      if (failHydration) {
        failHydration = false;
        throw new Error('injected lazy hydration failure');
      }
      return fixture.createConversation(options);
    },
  };
  server = new AgentServer({ engine, journal: repository, notify: () => {} });
  t.after(async () => {
    await server.close();
    await repository.close();
  });
  await server.initialize();
  const before = (await repository.readEvents({ conversationId: created.conversationId })).length;
  const message = {
    operationId: randomUUID(),
    conversationId: created.conversationId,
    clientMessageId: randomUUID(),
    text: 'Admit only after hydration succeeds',
  };

  await assert.rejects(
    () => server.handle(AGENT_METHODS.messageSend, message),
    (error) => error instanceof RpcFault &&
      error.code === -32022 &&
      (error.data as { kind?: unknown }).kind === 'runtime_hydration_failed',
  );
  assert.equal((await repository.readEvents({ conversationId: created.conversationId })).length, before);
  const failedRuntime = await readRuntime(server);
  assert.equal(failedRuntime.conversationId, created.conversationId);
  assert.equal(failedRuntime.state, 'error');

  const accepted = await server.handle(AGENT_METHODS.messageSend, message) as { turnId: string };
  assert.ok(accepted.turnId);
  await waitForConversation(server, created.conversationId, (value) => value.status === 'idle');
  assert.equal((await readTranscriptSync(server, created.conversationId)).turnOrder.length, 1);
});

test('lazy hydration reports unavailable models and workspaces without journal mutation', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'remux-agent-lazy-invalid-descriptor-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const repository = await AgentJournalRepository.open({ dataRoot: join(root, 'data') });
  const missingModel = await repository.createConversation({
    operationId: randomUUID(),
    cwd: workspace,
    modelId: 'retired-model',
    reasoning: 'high',
  });
  const missingWorkspace = await repository.createConversation({
    operationId: randomUUID(),
    cwd: workspace,
    modelId: 'gpt-5.4-fixture',
    reasoning: 'high',
  });
  await rm(workspace, { recursive: true });
  const missingModelEvents = (await repository.readEvents({
    conversationId: missingModel.conversationId,
  })).length;
  const missingWorkspaceEvents = (await repository.readEvents({
    conversationId: missingWorkspace.conversationId,
  })).length;
  const server = new AgentServer({ engine: new FixtureEngine(), journal: repository, notify: () => {} });
  t.after(async () => {
    await server.close();
    await repository.close();
  });
  await server.initialize();

  await assert.rejects(
    () => server.handle(AGENT_METHODS.messageSend, {
      operationId: randomUUID(),
      conversationId: missingModel.conversationId,
      clientMessageId: randomUUID(),
      text: 'This model is unavailable',
    }),
    (error) => error instanceof RpcFault &&
      error.code === -32020 &&
      (error.data as { kind?: unknown }).kind === 'model_unavailable',
  );
  await assert.rejects(
    () => server.handle(AGENT_METHODS.messageSend, {
      operationId: randomUUID(),
      conversationId: missingWorkspace.conversationId,
      clientMessageId: randomUUID(),
      text: 'This workspace is unavailable',
    }),
    (error) => error instanceof RpcFault &&
      error.code === -32021 &&
      (error.data as { kind?: unknown }).kind === 'workspace_unavailable',
  );
  assert.equal(
    (await repository.readEvents({ conversationId: missingModel.conversationId })).length,
    missingModelEvents,
  );
  assert.equal(
    (await repository.readEvents({ conversationId: missingWorkspace.conversationId })).length,
    missingWorkspaceEvents,
  );
});

test('conversation create commits before runtime publication and retries one durable identity', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'remux-agent-durable-start-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const repository = await AgentJournalRepository.open({ dataRoot: join(root, 'data') });
  t.after(() => repository.close());
  const fixture = new FixtureEngine();
  let durableConversationId: string | null = null;
  let failRuntime = true;
  let runtimeAttempts = 0;
  let server: AgentServer;
  const journal: AgentConversationJournal = {
    ...repositoryJournal(repository),
    async createConversation(params) {
      const result = await repository.createConversation(params);
      durableConversationId = result.conversationId;
      return result;
    },
  };
  const engine: AgentEngine = {
    authStatus: () => fixture.authStatus(),
    login: (operationId, signal, update) => fixture.login(operationId, signal, update),
    logout: () => fixture.logout(),
    listModels: () => fixture.listModels(),
    async createConversation(options) {
      runtimeAttempts += 1;
      assert.equal(await repository.journalHead(), 4);
      assert.ok(durableConversationId);
      assert.equal(
        server.resources.get(conversationResourceKey(durableConversationId)),
        undefined,
      );
      if (failRuntime) throw new Error('injected runtime startup failure');
      return fixture.createConversation(options);
    },
  };
  server = new AgentServer({ engine, journal, notify: () => {} });
  await server.initialize();
  const models = await server.handle(AGENT_METHODS.modelsRead, {}) as { defaultModelId: string };
  await assert.rejects(
    () => server.handle(AGENT_METHODS.conversationCreate, {
      operationId: 'not-a-uuid',
      cwd: root,
      modelId: models.defaultModelId,
      reasoning: 'high',
    }),
    (error) => error instanceof RpcFault && error.code === -32602,
  );
  assert.equal(await repository.journalHead(), 0);
  const operationId = randomUUID();
  const params = {
    operationId,
    cwd: root,
    modelId: models.defaultModelId,
    reasoning: 'high' as const,
  };

  await assert.rejects(
    () => server.handle(AGENT_METHODS.conversationCreate, params),
    /injected runtime startup failure/u,
  );
  assert.equal((await repository.readEvents()).length, 4);
  assert.ok(durableConversationId);
  assert.equal(
    server.resources.get(conversationResourceKey(durableConversationId)),
    undefined,
  );

  failRuntime = false;
  const started = await server.handle(AGENT_METHODS.conversationCreate, params) as {
    conversationId: string;
  };
  assert.equal(started.conversationId, durableConversationId);
  assert.equal((await repository.readEvents()).length, 4);
  assert.equal(runtimeAttempts, 2);
  assert.deepEqual(
    await server.handle(AGENT_METHODS.conversationCreate, params),
    started,
  );
  assert.equal(runtimeAttempts, 2);
  assert.equal((await repository.readEvents()).length, 4);

  await assert.rejects(
    () => server.handle(AGENT_METHODS.conversationCreate, { ...params, reasoning: 'medium' }),
    (error) => error instanceof RpcFault &&
      error.code === -32018 &&
      (error.data as { kind?: unknown }).kind === 'operation_conflict',
  );
  const firstClose = server.close();
  const secondClose = server.close();
  assert.strictEqual(secondClose, firstClose);
  await Promise.all([firstClose, secondClose]);
});

test('send admission and provider/tool effects cross committed durable boundaries first', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'remux-agent-durable-turn-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const repository = await AgentJournalRepository.open({ dataRoot: join(root, 'data') });
  t.after(() => repository.close());
  const fixture = new FixtureEngine();
  let observedWorkspaceEffect = false;
  const engine: AgentEngine = {
    authStatus: () => fixture.authStatus(),
    login: (operationId, signal, update) => fixture.login(operationId, signal, update),
    logout: () => fixture.logout(),
    listModels: () => fixture.listModels(),
    async createConversation(options) {
      return {
        async prompt(input) {
          assert.equal(input.text, '  exact provider input\n');
          assert.ok((await repository.readEvents()).some(({ type }) => type === 'turn.started'));
          await options.durability.beforeProviderCall({
            payload: { messages: [{ role: 'user', content: input.text }] },
            requestMode: 'full',
            estimatedInputTokens: 6,
            context: await testInferenceContext(options.durability, 6),
          });
          assert.ok((await repository.readEvents()).some(({ type }) => type === 'inference.started'));
          options.onEvent({ type: 'assistant-start' });
          options.onEvent({ type: 'assistant-text', delta: 'Committed response.' });
          options.onEvent({ type: 'inference-end', state: 'completed' });
          await options.durability.beforeTool({
            callId: 'effect:read', name: 'workspace.read', args: { path: 'README.md' },
          });
          assert.ok((await repository.readEvents()).some(({ type }) => type === 'tool.called'));
          observedWorkspaceEffect = true;
          await options.durability.afterTool({
            callId: 'effect:read', name: 'workspace.read',
            result: { path: 'README.md' }, isError: false,
          });
          options.onEvent({ type: 'assistant-complete', interrupted: false });
        },
        async interrupt() {},
        async dispose() {},
      };
    },
  };
  const server = new AgentServer({ engine, journal: repository, notify: () => {} });
  await server.initialize();
  const models = await server.handle(AGENT_METHODS.modelsRead, {}) as { defaultModelId: string };
  const started = await server.handle(AGENT_METHODS.conversationCreate, {
    operationId: randomUUID(),
    cwd: root,
    modelId: models.defaultModelId,
    reasoning: 'high',
  }) as { conversationId: string };
  await server.handle(AGENT_METHODS.messageSend, {
      operationId: randomUUID(),
    conversationId: started.conversationId,
    clientMessageId: randomUUID(),
    text: '  exact provider input\n',
  });
  await waitForConversation(server, started.conversationId, (value) => value.status === 'idle');
  assert.equal(observedWorkspaceEffect, true);
  const eventTypes = (await repository.readEvents({ conversationId: started.conversationId }))
    .map(({ type }) => type);
  assert.ok(eventTypes.indexOf('turn.started') < eventTypes.indexOf('inference.started'));
  assert.ok(eventTypes.indexOf('inference.completed') < eventTypes.indexOf('tool.called'));
  assert.ok(eventTypes.indexOf('tool.called') < eventTypes.indexOf('tool.completed'));
  assert.ok(eventTypes.indexOf('tool.completed') < eventTypes.indexOf('turn.terminal'));
  const frame = requiredFrame((await readTranscriptSync(server, started.conversationId)).turns[0]);
  assert.equal(frame.status, 'completed');
  const user = frame.segments.find((segment) => segment.type === 'userMessage');
  assert.ok(user?.type === 'userMessage');
  assert.equal(user.text, '  exact provider input\n');
  await server.close();
});

test('a fresh runtime after restart receives the same durable logical history without duplicates', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'remux-agent-durable-restart-context-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const repository = await AgentJournalRepository.open({ dataRoot: join(root, 'data') });
  t.after(() => repository.close());
  const observedContexts: Awaited<ReturnType<AgentConversationJournal['compileContext']>>[] = [];
  const fixture = new FixtureEngine();
  const engine: AgentEngine = {
    authStatus: () => fixture.authStatus(),
    login: (operationId, signal, update) => fixture.login(operationId, signal, update),
    logout: () => fixture.logout(),
    listModels: () => fixture.listModels(),
    async createConversation(options) {
      return {
        async prompt() {
          const context = await options.durability.compileContext();
          observedContexts.push(context);
          await options.durability.beforeProviderCall({
            payload: { logicalHash: context.logicalHash },
            requestMode: 'full',
            estimatedInputTokens: Math.ceil(context.estimatedBytes / 4),
            context: {
              basisSequence: context.basisSequence,
              logicalHash: context.logicalHash,
              renderedHash: context.logicalHash,
              orderedMessageHashes: context.orderedMessageHashes,
              messageCount: context.messages.length,
              fixedContractsHash: '0'.repeat(64),
              shadow: compileShadowContext(context.shadowSource, {
                modelId: 'gpt-5.4-fixture',
                contextWindow: 400_000,
                fixedContractsHash: '0'.repeat(64),
                activeEstimatedInputTokens: Math.max(1, Math.ceil(context.estimatedBytes / 4)),
              }),
              shadowBuildDurationMs: 0,
              activeMessages: context.messages,
            },
          });
          options.onEvent({ type: 'assistant-start' });
          const answer = `answer-${observedContexts.length}`;
          options.onEvent({ type: 'assistant-text', delta: answer });
          await options.durability.beforeAssistantMessageEnd({
            inferenceState: 'completed',
            text: answer,
            // Codex websocket responses can publish the summary only in the
            // finalized assistant message, without a thinking_delta event.
            reasoning: observedContexts.length === 1 ? 'final-only summary' : '',
            calls: [],
          });
          options.onEvent({ type: 'inference-end', state: 'completed' });
          options.onEvent({ type: 'assistant-complete', interrupted: false });
        },
        async interrupt() {},
        async dispose() {},
      };
    },
  };
  const operationId = randomUUID();
  const startParams = {
    operationId,
    cwd: root,
    modelId: 'gpt-5.4-fixture',
    reasoning: 'high' as const,
  };

  const firstServer = new AgentServer({ engine, journal: repository, notify: () => {} });
  await firstServer.initialize();
  const first = await firstServer.handle(AGENT_METHODS.conversationCreate, startParams) as {
    conversationId: string;
  };
  await firstServer.handle(AGENT_METHODS.messageSend, {
      operationId: randomUUID(),
    conversationId: first.conversationId,
    clientMessageId: randomUUID(),
    text: 'before restart',
  });
  await waitForConversation(firstServer, first.conversationId, (value) => value.status === 'idle');
  await firstServer.close();

  const secondServer = new AgentServer({ engine, journal: repository, notify: () => {} });
  await secondServer.initialize();
  const reopened = await secondServer.handle(AGENT_METHODS.conversationCreate, startParams) as {
    conversationId: string;
  };
  assert.equal(reopened.conversationId, first.conversationId);
  await secondServer.handle(AGENT_METHODS.messageSend, {
      operationId: randomUUID(),
    conversationId: reopened.conversationId,
    clientMessageId: randomUUID(),
    text: 'after restart',
  });
  await waitForConversation(secondServer, reopened.conversationId, (value) => value.status === 'idle');

  assert.deepEqual(observedContexts.map((context) => context.messages.map((message) => message.role)), [
    ['user'],
    ['user', 'assistant', 'user'],
  ]);
  assert.deepEqual(observedContexts[1]?.messages.map((message) =>
    message.role === 'user' ? message.text : message.role === 'assistant' ? message.text : message.callId
  ), ['before restart', 'answer-1', 'after restart']);
  const replayedAssistant = observedContexts[1]?.messages.find((message) => message.role === 'assistant');
  assert.equal(replayedAssistant?.role === 'assistant' ? replayedAssistant.reasoning : null, 'final-only summary');

  await secondServer.close();
  await repository.close();
});

test('a failed inference journal gate makes zero provider calls and one durable failed turn', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'remux-agent-preflight-failure-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const repository = await AgentJournalRepository.open({ dataRoot: join(root, 'data') });
  t.after(() => repository.close());
  const fixture = new FixtureEngine();
  let providerCalls = 0;
  const journal: AgentConversationJournal = {
    createConversation: (params) => repository.createConversation(params),
    ...repositoryJournal(repository),
    async startInference() {
      throw new Error('injected inference journal failure');
    },
  };
  const engine: AgentEngine = {
    authStatus: () => fixture.authStatus(),
    login: (operationId, signal, update) => fixture.login(operationId, signal, update),
    logout: () => fixture.logout(),
    listModels: () => fixture.listModels(),
    async createConversation(options) {
      return {
        async prompt(input) {
          try {
            await options.durability.beforeProviderCall({
              payload: { messages: [{ role: 'user', content: input.text }] },
              requestMode: 'full',
              estimatedInputTokens: 3,
              context: await testInferenceContext(options.durability, 3),
            });
            providerCalls += 1;
          } catch (error) {
            options.onEvent({
              type: 'assistant-complete',
              interrupted: false,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        },
        async interrupt() {},
        async dispose() {},
      };
    },
  };
  const server = new AgentServer({ engine, journal, notify: () => {} });
  await server.initialize();
  const models = await server.handle(AGENT_METHODS.modelsRead, {}) as { defaultModelId: string };
  const started = await server.handle(AGENT_METHODS.conversationCreate, {
    operationId: randomUUID(),
    cwd: root,
    modelId: models.defaultModelId,
    reasoning: 'high',
  }) as { conversationId: string };
  await server.handle(AGENT_METHODS.messageSend, {
      operationId: randomUUID(),
    conversationId: started.conversationId,
    clientMessageId: randomUUID(),
    text: 'Do not dispatch.',
  });
  const conversation = await waitForConversation(
    server,
    started.conversationId,
    (value) => value.status === 'error' && value.activeTurnId === null,
  );
  assert.equal(providerCalls, 0);
  assert.match(conversation.error ?? '', /journal failure/u);
  const terminalEvents = (await repository.readEvents({ conversationId: started.conversationId }))
    .filter(({ type }) => type === 'turn.terminal');
  assert.equal(terminalEvents.length, 1);
  const terminalPayload = terminalEvents[0]?.payload as {
    durationMs?: unknown;
    errorCode?: unknown;
    status?: unknown;
  };
  assert.equal(terminalPayload.status, 'failed');
  assert.equal(terminalPayload.errorCode, 'storage_error');
  assert.equal(typeof terminalPayload.durationMs, 'number');
  const failedFrame = requiredFrame(
    (await readTranscriptSync(server, started.conversationId)).turns[0],
  );
  assert.equal(failedFrame.error?.code, 'storage_error');
  assert.equal(failedFrame.durationMs, terminalPayload.durationMs);
  await server.close();
});

test('JSON-RPC framing is parse-safe and stdout writes stay serialized', async () => {
  const writes: string[] = [];
  const output = new JsonRpcOutput(async (line) => {
    await new Promise((resolve) => setTimeout(resolve, line.includes('first') ? 10 : 0));
    writes.push(line);
  });
  output.send({ first: true });
  output.send({ second: true });
  await output.flush();
  assert.deepEqual(writes.map((line) => JSON.parse(line)), [{ first: true }, { second: true }]);

  await handleJsonRpcLine('{not-json', async () => null, output);
  await handleJsonRpcLine(
    JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'fixture/echo', params: { ok: true } }),
    async (_method, params) => params,
    output,
  );
  await output.flush();
  assert.deepEqual(JSON.parse(writes[2]!), {
    jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' },
  });
  assert.deepEqual(JSON.parse(writes[3]!), {
    jsonrpc: '2.0', id: 7, result: { ok: true },
  });
});

test('stdio shutdown drains in-flight commands before returning', async () => {
  const writes: string[] = [];
  const output = new JsonRpcOutput(async (line) => {
    writes.push(line);
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const input = Readable.from([
    `${JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'fixture/wait' })}\n`,
  ]);
  let returned = false;
  const serving = serveStdio(async () => {
    await gate;
    return { completed: true };
  }, output, input).then(() => {
    returned = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(returned, false);
  release();
  await serving;
  await output.flush();
  assert.deepEqual(writes.map((line) => JSON.parse(line)), [{
    jsonrpc: '2.0', id: 9, result: { completed: true },
  }]);
});

test('auth resources redact credential-shaped diagnostics and cancel only the matching operation', async () => {
  const leakyEngine: AgentEngine = {
    async authStatus() {
      return {
        state: 'signed-in', operationId: null, displayLabel: 'Bearer top-secret sk-abcdefghijk',
        verificationUri: null, userCode: null, expiresAt: null, progress: null, error: null,
      };
    },
    async login() {},
    async logout() {},
    async listModels() { return []; },
    async createConversation() { throw new Error('not used'); },
  };
  const redacted = testServer(leakyEngine);
  await redacted.initialize();
  const read = await redacted.handle(AGENT_METHODS.resourcesRead, {
    requests: [{ key: 'auth' }],
  }) as ResourceReadResult;
  const serialized = JSON.stringify(read);
  assert.doesNotMatch(serialized, /top-secret|sk-abcdefghijk/u);
  assert.match(serialized, /redacted/u);

  process.env.REMUX_AGENT_FIXTURE_SIGNED_OUT = '1';
  const fixture = new FixtureEngine();
  delete process.env.REMUX_AGENT_FIXTURE_SIGNED_OUT;
  const server = testServer(fixture);
  await server.initialize();
  const login = await server.handle(AGENT_METHODS.authLoginStart, {}) as { operationId: string };
  await assert.rejects(
    () => server.handle(AGENT_METHODS.authLoginCancel, { operationId: randomUUID() }),
    /no longer active/u,
  );
  assert.deepEqual(
    await server.handle(AGENT_METHODS.authLoginCancel, { operationId: login.operationId }),
    { accepted: true },
  );
});

test('fixture conversation streams projected transcript, tool rows, and shadow context', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'remux-agent-test-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const notifications: Array<{ method: string; params: unknown }> = [];
  const repository = await AgentJournalRepository.open({ dataRoot: join(root, 'data') });
  t.after(() => repository.close());
  const server = testServer(
    new FixtureEngine(),
    (method, params) => notifications.push({ method, params }),
    repository,
  );
  await server.initialize();
  const models = await server.handle(AGENT_METHODS.modelsRead, {}) as {
    defaultModelId: string;
  };
  const started = await server.handle(AGENT_METHODS.conversationCreate, {
    operationId: randomUUID(),
    cwd: root,
    modelId: models.defaultModelId,
    reasoning: 'high',
  }) as { conversationId: string };
  const clientMessageId = randomUUID();
  await server.handle(AGENT_METHODS.messageSend, {
    operationId: randomUUID(),
    conversationId: started.conversationId,
    clientMessageId,
    text: 'inspect the readme',
  });

  const conversation = await waitForConversation(
    server,
    started.conversationId,
    (value) => value.status === 'idle',
  );
  const sync = await readTranscriptSync(server, started.conversationId);
  const frame = requiredFrame(sync.turns[0]);
  assert.deepEqual(frame.segments.map((segment) => segment.type), [
    'userMessage',
    'work',
    'assistantMessage',
  ]);
  const user = frame.segments.find((segment) => segment.type === 'userMessage');
  const assistant = frame.segments.find((segment) => segment.type === 'assistantMessage');
  const work = requiredWork(frame);
  const groupRef = requiredGroupRef(work);
  assert.equal(user?.clientMessageId, clientMessageId);
  assert.match(assistant?.text ?? '', /Fixture response/u);
  assert.equal(groupRef.groupType, 'activity');

  const group = await readWorkGroup(server, started.conversationId, frame.id, work.id, groupRef.id);
  assert.equal(group.rows.length, 1);
  const row = group.rows[0];
  assert.ok(row && row.type === 'activity');
  assert.equal(row.kind, 'read');
  assert.equal(row.status, 'completed');
  const detail = await readWorkDetail(
    server,
    started.conversationId,
    frame.id,
    work.id,
    group.groupId,
    row.id,
  );
  assert.equal(detail.detail.type, 'activity');
  assert.match(detail.detail.type === 'activity' ? detail.detail.output ?? '' : '', /README\.md/u);
  assert.equal(conversation.contextProbe.providerRequestMode, 'full');
  const contextRead = await server.handle(AGENT_METHODS.resourcesRead, {
    requests: [{ key: contextResourceKey(started.conversationId) }],
  }) as ResourceReadResult;
  const contextResource = contextRead.resources[0];
  assert.ok(contextResource?.status === 'ok');
  const contextInspector = contextResource.value as ContextInspectorValue;
  assert.equal(contextInspector.version, 2);
  assert.equal(contextInspector.conversationId, started.conversationId);
  assert.equal(contextInspector.decision.kind, 'append');
  assert.equal(contextInspector.blocks.length, 8);
  assert.equal(contextInspector.actual?.transportMode, 'full');
  assert.equal(contextInspector.actual?.turnCount, 1);
  assert.equal(contextInspector.actual?.groups[0]?.roles.user, 1);
  assert.match(contextInspector.semanticHash, /^[0-9a-f]{64}$/u);
  assert.ok(notifications.some((notification) => notification.method === AGENT_METHODS.resourcesInvalidated));
  assert.ok(notifications.some((notification) =>
    JSON.stringify(notification.params).includes(contextResourceKey(started.conversationId))));
  assert.ok(notifications.some((notification) =>
    JSON.stringify(notification.params).includes('"type":"transcript"')));
  assert.doesNotMatch(JSON.stringify(sync), /fixture-read/u);
  await server.close();
});

test('interrupt is immediate and leaves the durable conversation runtime reusable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'remux-agent-interrupt-'));
  const server = testServer();
  await server.initialize();
  const models = await server.handle(AGENT_METHODS.modelsRead, {}) as { defaultModelId: string };
  const started = await server.handle(AGENT_METHODS.conversationCreate, {
    operationId: randomUUID(),
    cwd: root,
    modelId: models.defaultModelId,
    reasoning: 'high',
  }) as { conversationId: string };
  const sent = await server.handle(AGENT_METHODS.messageSend, {
      operationId: randomUUID(),
    conversationId: started.conversationId,
    clientMessageId: randomUUID(),
    text: 'a long request',
  }) as { turnId: string };
  const interrupted = await server.handle(AGENT_METHODS.turnInterrupt, {
    conversationId: started.conversationId,
    turnId: sent.turnId,
  });
  assert.deepEqual(interrupted, { accepted: true });

  const conversation = await waitForConversation(
    server,
    started.conversationId,
    (value) => value.status === 'idle',
  );
  assert.equal(conversation.activeTurnId, null);
  assert.equal(conversation.activeTurnElapsedMs, null);
  const frame = requiredFrame((await readTranscriptSync(server, started.conversationId)).turns[0]);
  assert.equal(frame.status, 'interrupted');
});

test('the command lane reconciles concurrent sends, idempotent interrupt, and send versus logout', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'remux-agent-command-races-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const repository = await AgentJournalRepository.open({ dataRoot: join(root, 'data') });
  class CountingFixtureEngine extends FixtureEngine {
    promptCount = 0;
    interruptCount = 0;
    disposeCount = 0;

    override async createConversation(options: Parameters<AgentEngine['createConversation']>[0]) {
      const runtime = await super.createConversation(options);
      return {
        prompt: async (input: Parameters<typeof runtime.prompt>[0]) => {
          this.promptCount += 1;
          await runtime.prompt(input);
        },
        interrupt: async () => {
          this.interruptCount += 1;
          await runtime.interrupt();
        },
        dispose: async () => {
          this.disposeCount += 1;
          await runtime.dispose();
        },
      };
    }
  }
  const engine = new CountingFixtureEngine();
  const server = new AgentServer({ engine, journal: repository, notify: () => {} });
  t.after(async () => {
    await server.close();
    await repository.close();
  });
  await server.initialize();
  const created = await server.handle(AGENT_METHODS.conversationCreate, {
    operationId: randomUUID(),
    cwd: root,
    modelId: 'gpt-5.4-fixture',
    reasoning: 'high',
  }) as { conversationId: string };

  const duplicate = {
    operationId: randomUUID(),
    conversationId: created.conversationId,
    clientMessageId: randomUUID(),
    text: 'Admit this concurrent request once.',
  };
  const duplicateResults = await Promise.all([
    server.handle(AGENT_METHODS.messageSend, duplicate),
    server.handle(AGENT_METHODS.messageSend, duplicate),
  ]);
  assert.deepEqual(duplicateResults[0], duplicateResults[1]);
  await waitForConversation(server, created.conversationId, (value) => value.status === 'idle');
  assert.equal(engine.promptCount, 1);

  const conflictOperationId = randomUUID();
  const acceptedConflict = server.handle(AGENT_METHODS.messageSend, {
    operationId: conflictOperationId,
    conversationId: created.conversationId,
    clientMessageId: randomUUID(),
    text: 'The first command owns the operation.',
  });
  const rejectedConflict = server.handle(AGENT_METHODS.messageSend, {
    operationId: conflictOperationId,
    conversationId: created.conversationId,
    clientMessageId: randomUUID(),
    text: 'A conflicting command must not be admitted.',
  });
  assert.ok((await acceptedConflict as { turnId: string }).turnId);
  await assert.rejects(
    () => rejectedConflict,
    (error) => error instanceof RpcFault && error.code === -32018,
  );
  await waitForConversation(server, created.conversationId, (value) => value.status === 'idle');
  assert.equal(engine.promptCount, 2);

  const interruptible = await server.handle(AGENT_METHODS.messageSend, {
    operationId: randomUUID(),
    conversationId: created.conversationId,
    clientMessageId: randomUUID(),
    text: 'Interrupt this once even if the command is repeated.',
  }) as { turnId: string };
  const interrupt = {
    conversationId: created.conversationId,
    turnId: interruptible.turnId,
  };
  assert.deepEqual(await Promise.all([
    server.handle(AGENT_METHODS.turnInterrupt, interrupt),
    server.handle(AGENT_METHODS.turnInterrupt, interrupt),
  ]), [{ accepted: true }, { accepted: true }]);
  await waitForConversation(server, created.conversationId, (value) => value.status === 'idle');
  assert.equal(engine.interruptCount, 1);

  const sendBeforeLogout = server.handle(AGENT_METHODS.messageSend, {
    operationId: randomUUID(),
    conversationId: created.conversationId,
    clientMessageId: randomUUID(),
    text: 'Logout must serialize after this admission.',
  });
  const logout = server.handle(AGENT_METHODS.authLogout, {});
  const logoutTurn = await sendBeforeLogout as { turnId: string };
  assert.ok(logoutTurn.turnId);
  assert.deepEqual(await logout, { ok: true });
  const auth = await server.handle(AGENT_METHODS.resourcesRead, {
    requests: [{ key: AGENT_RESOURCE_KEYS.auth }],
  }) as ResourceReadResult;
  assert.equal(auth.resources[0]?.status, 'ok');
  assert.equal(auth.resources[0]?.status === 'ok' &&
    (auth.resources[0].value as { state?: unknown }).state, 'signed-out');

  const terminalEvents = (await repository.readEvents({ conversationId: created.conversationId }))
    .filter(({ type }) => type === 'turn.terminal');
  assert.equal(terminalEvents.length, 4);
  assert.equal(terminalEvents.filter(({ turnId }) => turnId === logoutTurn.turnId).length, 1);
  assert.equal(engine.promptCount, 4);
  assert.equal(engine.interruptCount, 2);
  assert.equal(engine.disposeCount, 1);
});

test('server close waits for runtime hydration and disposes the admitted runtime', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'remux-agent-close-hydration-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const repository = await AgentJournalRepository.open({ dataRoot: join(root, 'data') });
  const fixture = new FixtureEngine();
  let enterHydration!: () => void;
  const hydrationEntered = new Promise<void>((resolve) => {
    enterHydration = resolve;
  });
  let releaseHydration!: () => void;
  const hydrationGate = new Promise<void>((resolve) => {
    releaseHydration = resolve;
  });
  let disposeCount = 0;
  const engine: AgentEngine = {
    authStatus: () => fixture.authStatus(),
    login: (operationId, signal, update) => fixture.login(operationId, signal, update),
    logout: () => fixture.logout(),
    listModels: () => fixture.listModels(),
    async createConversation(options) {
      enterHydration();
      await hydrationGate;
      const runtime = await fixture.createConversation(options);
      return {
        prompt: (input) => runtime.prompt(input),
        interrupt: () => runtime.interrupt(),
        async dispose() {
          disposeCount += 1;
          await runtime.dispose();
        },
      };
    },
  };
  const server = new AgentServer({ engine, journal: repository, notify: () => {} });
  await server.initialize();
  const creation = server.handle(AGENT_METHODS.conversationCreate, {
    operationId: randomUUID(),
    cwd: root,
    modelId: 'gpt-5.4-fixture',
    reasoning: 'high',
  });
  await hydrationEntered;
  let closeResolved = false;
  const closing = server.close().then(() => {
    closeResolved = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closeResolved, false);
  releaseHydration();
  assert.ok((await creation as { conversationId: string }).conversationId);
  await closing;
  assert.equal(disposeCount, 1);
  await repository.close();
});

test('client, conversation, turn, transcript, and item identities remain distinct', async () => {
  const root = await mkdtemp(join(tmpdir(), 'remux-agent-identities-'));
  const server = testServer();
  await server.initialize();
  const models = await server.handle(AGENT_METHODS.modelsRead, {}) as { defaultModelId: string };
  const started = await server.handle(AGENT_METHODS.conversationCreate, {
    operationId: randomUUID(),
    cwd: root,
    modelId: models.defaultModelId,
    reasoning: 'high',
  }) as { conversationId: string };
  const clientMessageId = randomUUID();
  const operationId = randomUUID();
  const message = {
    operationId,
    conversationId: started.conversationId,
    clientMessageId,
    text: 'identity check',
  };
  const sent = await server.handle(AGENT_METHODS.messageSend, message) as {
    operationId: string;
    turnId: string;
  };
  await waitForConversation(
    server,
    started.conversationId,
    (conversation) => conversation.status === 'idle',
  );
  const frame = requiredFrame((await readTranscriptSync(server, started.conversationId)).turns[0]);
  const user = frame.segments.find((segment) => segment.type === 'userMessage');
  assert.ok(user && user.type === 'userMessage');
  assert.equal(user.clientMessageId, clientMessageId);
  assert.notEqual(user.id, clientMessageId);
  assert.notEqual(user.id, started.conversationId);
  assert.notEqual(sent.turnId, started.conversationId);
  assert.notEqual(sent.turnId, user.id);
  assert.equal(sent.operationId, operationId);
  assert.deepEqual(await server.handle(AGENT_METHODS.messageSend, message), sent);

  await assert.rejects(
    () => server.handle(AGENT_METHODS.messageSend, { ...message, text: 'conflicting operation' }),
    (error) => error instanceof RpcFault &&
      error.code === -32018 &&
      (error.data as { kind?: unknown }).kind === 'operation_conflict',
  );

  await assert.rejects(
    () => server.handle(AGENT_METHODS.messageSend, {
      operationId: randomUUID(),
      conversationId: started.conversationId,
      clientMessageId,
      text: 'duplicate identity',
    }),
    /already used/u,
  );
});

test('provider failure reaches one terminal error state even when prompt resolves after agent_end', async () => {
  const root = await mkdtemp(join(tmpdir(), 'remux-agent-error-'));
  const fixture = new FixtureEngine();
  let conversationCreations = 0;
  let disposals = 0;
  const engine: AgentEngine = {
    authStatus: () => fixture.authStatus(),
    login: (operationId, signal, update) => fixture.login(operationId, signal, update),
    logout: () => fixture.logout(),
    listModels: () => fixture.listModels(),
    async createConversation(options) {
      const creation = ++conversationCreations;
      return {
        async prompt() {
          options.onEvent({ type: 'assistant-start' });
          if (creation === 1) {
            options.onEvent({ type: 'assistant-complete', interrupted: false, error: 'Fixture model failed.' });
          } else {
            options.onEvent({ type: 'assistant-text', delta: 'Recovered with a fresh runtime.' });
            options.onEvent({ type: 'assistant-complete', interrupted: false });
          }
        },
        async interrupt() {},
        async dispose() { disposals += 1; },
      };
    },
  };
  const server = testServer(engine);
  await server.initialize();
  const models = await server.handle(AGENT_METHODS.modelsRead, {}) as { defaultModelId: string };
  const started = await server.handle(AGENT_METHODS.conversationCreate, {
    operationId: randomUUID(),
    cwd: root,
    modelId: models.defaultModelId,
    reasoning: 'high',
  }) as { conversationId: string };
  await server.handle(AGENT_METHODS.messageSend, {
      operationId: randomUUID(),
    conversationId: started.conversationId,
    clientMessageId: randomUUID(),
    text: 'fail once',
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const conversation = await waitForConversation(
    server,
    started.conversationId,
    (value) => value.status === 'error',
  );
  assert.equal(conversation.error, 'Fixture model failed.');
  const sync = await readTranscriptSync(server, started.conversationId);
  assert.equal(sync.turns.length, 1);
  const frame = requiredFrame(sync.turns[0]);
  assert.equal(frame.status, 'failed');
  assert.deepEqual(frame.error, { code: 'provider_error', message: 'Fixture model failed.' });

  await server.handle(AGENT_METHODS.messageSend, {
    operationId: randomUUID(),
    conversationId: started.conversationId,
    clientMessageId: randomUUID(),
    text: 'retry from durable history',
  });
  await waitForConversation(server, started.conversationId, (value) => value.status === 'idle');
  assert.equal(conversationCreations, 2);
  assert.equal(disposals, 1);
  const recovered = await readTranscriptSync(server, started.conversationId);
  assert.equal(recovered.turns.length, 2);
  assert.match(JSON.stringify(recovered.turns[1]), /Recovered with a fresh runtime/u);
});

test('projector windows and known revisions stay bounded and deterministic', () => {
  let clock = 1_000;
  const conversationId = randomUUID();
  const turnIds = Array.from({ length: 45 }, () => randomUUID());
  const projector = new EphemeralTranscriptProjector({
    conversationId,
    createId: randomUUID,
    invalidate: () => {},
    now: () => clock,
  });

  for (let index = 0; index < 45; index += 1) {
    const turnId = turnIds[index]!;
    projector.beginTurn({ turnId, clientMessageId: randomUUID(), text: `message ${index}` });
    projector.appendAssistantText(turnId, `answer ${index}`);
    clock += 10;
    projector.finishTurn(turnId, { status: 'completed' });
    clock += 10;
  }

  const tail = projector.read(parseTranscriptResourcesReadParams({
    conversationId: projector.conversationId,
    requests: [syncRequest({ kind: 'tail' })],
  }), 'generation-one');
  const tailSync = requiredSync(tail);
  assert.equal(tailSync.turns.length, 24);
  assert.equal(tailSync.turnOrder[0], turnIds[21]);
  assert.equal(tailSync.turnOrder.at(-1), turnIds[44]);
  assert.equal(tailSync.window.hasEarlier, true);
  assert.equal(tailSync.window.hasLater, false);

  const firstTailTurn = requiredFrame(tailSync.turns[0]);
  const known = projector.read(parseTranscriptResourcesReadParams({
    conversationId: projector.conversationId,
    requests: [syncRequest(
      { kind: 'tail' },
      [{ turnId: firstTailTurn.id, renderRevision: firstTailTurn.renderRevision }],
    )],
  }), 'generation-one');
  assert.equal(requiredSync(known).turns[0]?.status, 'notModified');

  const around = projector.read(parseTranscriptResourcesReadParams({
    conversationId: projector.conversationId,
    requests: [syncRequest({ kind: 'around', turnId: turnIds[20]!, before: 2, after: 3 })],
  }), 'generation-one');
  assert.deepEqual(requiredSync(around).turnOrder, [
    turnIds[18], turnIds[19], turnIds[20], turnIds[21], turnIds[22], turnIds[23],
  ]);

  const range = projector.read(parseTranscriptResourcesReadParams({
    conversationId: projector.conversationId,
    requests: [syncRequest({ kind: 'range', startTurnId: turnIds[4]!, endTurnId: turnIds[8]! })],
  }), 'generation-one');
  assert.deepEqual(requiredSync(range).turnOrder, [
    turnIds[4], turnIds[5], turnIds[6], turnIds[7], turnIds[8],
  ]);

  assert.throws(
    () => projector.read(parseTranscriptResourcesReadParams({
      conversationId: projector.conversationId,
      requests: [syncRequest({ kind: 'range', startTurnId: turnIds[0]!, endTurnId: turnIds[44]! })],
    }), 'generation-one'),
    /40 turn limit/u,
  );
  assert.throws(
    () => projector.read(parseTranscriptResourcesReadParams({
      conversationId: projector.conversationId,
      requests: [syncRequest({ kind: 'around', turnId: randomUUID(), before: 1, after: 1 })],
    }), 'generation-one'),
    /anchor was not found/u,
  );
});

test('projector work details redact provider identities and terminal state fences late events', () => {
  let clock = 5_000;
  const invalidations: unknown[] = [];
  const turnId = randomUUID();
  const projector = new EphemeralTranscriptProjector({
    conversationId: randomUUID(),
    createId: randomUUID,
    invalidate: (value) => invalidations.push(...value),
    now: () => clock,
  });

  projector.beginTurn({ turnId, clientMessageId: randomUUID(), text: 'inspect' });
  projector.appendReasoning(turnId, 'Checking the workspace.');
  projector.startTool(turnId, {
    callId: 'provider-call-secret',
    name: 'workspace.read',
    args: { path: 'README.md', authorization: 'opaque-top-secret' },
  });
  clock += 25;
  projector.updateTool(turnId, { callId: 'provider-call-secret', result: 'sk-abcdefghijk' });
  clock += 25;
  projector.endTool(turnId, {
    callId: 'provider-call-secret',
    result: { path: 'README.md', token: 'eyJabc.def.ghi' },
    isError: false,
  });
  projector.appendAssistantText(turnId, 'Done.');
  clock += 50;
  assert.equal(projector.finishTurn(turnId, { status: 'completed' }), true);
  assert.equal(projector.appendAssistantText(turnId, 'late mutation'), false);

  const syncResult = projector.read(parseTranscriptResourcesReadParams({
    conversationId: projector.conversationId,
    requests: [syncRequest({ kind: 'tail' })],
  }), 'generation-work');
  const sync = requiredSync(syncResult);
  const frame = requiredFrame(sync.turns[0]);
  const work = requiredWork(frame);
  const groupRef = requiredGroupRef(work);
  const groupResult = projector.read(parseTranscriptResourcesReadParams({
    conversationId: projector.conversationId,
    requests: [{
      type: 'workGroup',
      protocolVersion: AGENT_TRANSCRIPT_PROTOCOL_VERSION,
      turnId: frame.id,
      segmentId: work.id,
      groupId: groupRef.id,
      limit: 50,
    }],
  }), 'generation-work');
  const group = requiredResourceValue<AgentWorkGroupResource>(groupResult);
  const row = group.rows[0];
  assert.ok(row);
  const detailResult = projector.read(parseTranscriptResourcesReadParams({
    conversationId: projector.conversationId,
    requests: [{
      type: 'workEntryDetail',
      protocolVersion: AGENT_TRANSCRIPT_PROTOCOL_VERSION,
      turnId: frame.id,
      segmentId: work.id,
      groupId: group.groupId,
      rowId: row.id,
    }],
  }), 'generation-work');
  const detail = requiredResourceValue<AgentWorkEntryDetailResource>(detailResult);

  const serialized = JSON.stringify({ syncResult, groupResult, detailResult, invalidations });
  assert.doesNotMatch(serialized, /provider-call-secret|opaque-top-secret|sk-abcdefghijk|eyJabc/u);
  assert.match(serialized, /redacted/u);
  assert.equal(frame.status, 'completed');
  assert.equal(frame.durationMs, 100);
  assert.equal(work.state, 'completed');
  assert.equal(detail.truncation.truncated, false);

  const notModified = projector.read(parseTranscriptResourcesReadParams({
    conversationId: projector.conversationId,
    requests: [{
      type: 'workEntryDetail',
      protocolVersion: AGENT_TRANSCRIPT_PROTOCOL_VERSION,
      turnId: frame.id,
      segmentId: work.id,
      groupId: group.groupId,
      rowId: row.id,
      knownRevision: detail.revision,
    }],
  }), 'generation-work');
  assert.equal(notModified.resources[0]?.status, 'notModified');
  assert.ok(invalidations.some((value) =>
    value && typeof value === 'object' && (value as { type?: unknown }).type === 'workEntryDetail'));
});

test('work pagination cursors are opaque, revision-scoped, and stale-safe', () => {
  const projector = new EphemeralTranscriptProjector({
    conversationId: randomUUID(),
    createId: randomUUID,
    invalidate: () => {},
  });
  const turnId = randomUUID();
  projector.beginTurn({ turnId, clientMessageId: randomUUID(), text: 'page the work' });
  for (let index = 0; index < 51; index += 1) {
    const callId = `paged-call-${index}`;
    projector.startTool(turnId, {
      callId,
      name: 'workspace.read',
      args: { path: `file-${index}.md` },
    });
    projector.endTool(turnId, {
      callId,
      result: { path: `file-${index}.md`, text: `result ${index}` },
      isError: false,
    });
  }
  const sync = requiredSync(projector.read(parseTranscriptResourcesReadParams({
    conversationId: projector.conversationId,
    requests: [syncRequest({ kind: 'tail' })],
  }), 'generation-cursor'));
  const frame = requiredFrame(sync.turns[0]);
  const work = requiredWork(frame);
  const group = requiredGroupRef(work);
  const request = (cursor?: string, knownRevision?: string) => ({
    type: 'workGroup' as const,
    protocolVersion: AGENT_TRANSCRIPT_PROTOCOL_VERSION,
    turnId,
    segmentId: work.id,
    groupId: group.id,
    limit: 50 as const,
    ...(cursor ? { cursor } : {}),
    ...(knownRevision ? { knownRevision } : {}),
  });
  const first = requiredResourceValue<AgentWorkGroupResource>(projector.read(
    parseTranscriptResourcesReadParams({
      conversationId: projector.conversationId,
      requests: [request()],
    }),
    'generation-cursor',
  ));
  assert.equal(first.rows.length, 50);
  const cursor = first.nextCursor;
  assert.ok(cursor);
  assert.doesNotMatch(cursor, /^\d+$/u);
  const second = requiredResourceValue<AgentWorkGroupResource>(projector.read(
    parseTranscriptResourcesReadParams({
      conversationId: projector.conversationId,
      requests: [request(cursor)],
    }),
    'generation-cursor',
  ));
  assert.equal(second.rows.length, 1);
  assert.equal(second.nextCursor, null);

  projector.startTool(turnId, {
    callId: 'paged-call-new',
    name: 'workspace.read',
    args: { path: 'new.md' },
  });
  const stale = projector.read(parseTranscriptResourcesReadParams({
    conversationId: projector.conversationId,
    requests: [request(cursor)],
  }), 'generation-cursor');
  assert.equal(stale.resources[0]?.status, 'error');
  assert.equal(stale.resources[0]?.code, 'staleCursor');
  assert.throws(
    () => parseTranscriptResourcesReadParams({
      conversationId: projector.conversationId,
      requests: [request(cursor, first.revision)],
    }),
    /cannot be combined/u,
  );
});

test('projector durations use a monotonic clock while frame timestamps remain wall time', () => {
  let wallClock = 10_000;
  let monotonicClock = 500;
  const projector = new EphemeralTranscriptProjector({
    conversationId: randomUUID(),
    invalidate: () => {},
    now: () => wallClock,
    monotonicNow: () => monotonicClock,
  });

  const turnId = randomUUID();
  projector.beginTurn({ turnId, clientMessageId: randomUUID(), text: 'time it' });
  projector.startTool(turnId, {
    callId: 'clocked-tool',
    name: 'workspace.read',
    args: { path: 'README.md' },
    createdAt: 10_000,
  });
  monotonicClock = 550;
  projector.endTool(turnId, {
    callId: 'clocked-tool',
    result: { ok: true },
    isError: false,
    createdAt: 11_000,
  });
  wallClock = 9_000;
  monotonicClock = 575;
  assert.equal(projector.activeElapsedMs(), 75);
  projector.finishTurn(turnId, { status: 'completed' });

  const sync = requiredSync(projector.read(parseTranscriptResourcesReadParams({
    conversationId: projector.conversationId,
    requests: [syncRequest({ kind: 'tail' })],
  }), 'generation-clock'));
  const frame = requiredFrame(sync.turns[0]);
  const work = requiredWork(frame);
  const groupRef = requiredGroupRef(work);
  const group = requiredResourceValue<AgentWorkGroupResource>(projector.read(
    parseTranscriptResourcesReadParams({
      conversationId: projector.conversationId,
      requests: [{
        type: 'workGroup',
        protocolVersion: AGENT_TRANSCRIPT_PROTOCOL_VERSION,
        turnId,
        segmentId: work.id,
        groupId: groupRef.id,
      }],
    }),
    'generation-clock',
  ));
  assert.equal(frame.startedAt, 10_000);
  assert.equal(frame.completedAt, 9_000);
  assert.equal(frame.durationMs, 75);
  const toolRow = group.rows[0];
  assert.equal(toolRow?.type, 'activity');
  assert.equal(toolRow.type === 'activity' ? toolRow.durationMs : null, 50);
  assert.equal(projector.activeElapsedMs(), null);
});

test('restart interruption and durable duration remain distinct in the render frame', () => {
  const conversationId = randomUUID();
  const turnId = randomUUID();
  const projector = createReplayedTranscriptProjector({
    conversationId,
    live: false,
    actions: [
      {
        type: 'turn',
        turnId,
        clientMessageId: randomUUID(),
        text: 'Recover this turn.',
      },
      {
        type: 'terminal',
        turnId,
        status: 'interrupted_by_restart',
        error: null,
        durationMs: 321,
      },
    ],
  });
  const sync = requiredSync(projector.read(parseTranscriptResourcesReadParams({
    conversationId,
    requests: [syncRequest({ kind: 'tail' })],
  }), 'restart-generation'));
  const frame = requiredFrame(sync.turns[0]);
  assert.equal(frame.status, 'interrupted');
  assert.equal(frame.interruptionReason, 'restart');
  assert.equal(frame.durationMs, 321);
});

test('transcript parser and byte caps fail closed', () => {
  const limitsConversationId = randomUUID();
  const duplicateTurnId = randomUUID();
  assert.throws(
    () => parseTranscriptResourcesReadParams({
      conversationId: limitsConversationId,
      requests: [{ ...syncRequest({ kind: 'tail' }), protocolVersion: 99 }],
    }),
    /protocol version/u,
  );
  assert.throws(
    () => parseTranscriptResourcesReadParams({
      conversationId: limitsConversationId,
      requests: [syncRequest(
        { kind: 'tail' },
        [
          { turnId: duplicateTurnId, renderRevision: 'one' },
          { turnId: duplicateTurnId, renderRevision: 'two' },
        ],
      )],
    }),
    /duplicate turnId/u,
  );
  assert.throws(
    () => parseTranscriptResourcesReadParams({
      conversationId: limitsConversationId,
      requests: [syncRequest({ kind: 'tail' }), syncRequest({ kind: 'tail' })],
    }),
    /one transcriptSync/u,
  );

  const largeTurnId = randomUUID();
  const frameLimited = new EphemeralTranscriptProjector({
    conversationId: randomUUID(),
    createId: randomUUID,
    invalidate: () => {},
    limits: { maxTurnFrameBytes: 200 },
  });
  frameLimited.beginTurn({ turnId: largeTurnId, clientMessageId: randomUUID(), text: 'x'.repeat(400) });
  frameLimited.finishTurn(largeTurnId, { status: 'completed' });
  const frameResult = requiredSync(frameLimited.read(parseTranscriptResourcesReadParams({
    conversationId: frameLimited.conversationId,
    requests: [syncRequest({ kind: 'tail' })],
  }), 'generation-limits'));
  assert.equal(frameResult.turns[0]?.status, 'error');
  assert.equal(frameResult.turns[0]?.status === 'error' ? frameResult.turns[0].code : null, 'frameTooLarge');

  const responseLimited = new EphemeralTranscriptProjector({
    conversationId: randomUUID(),
    invalidate: () => {},
    limits: { maxResponseBytes: 100 },
  });
  assert.throws(
    () => responseLimited.read(parseTranscriptResourcesReadParams({
      conversationId: responseLimited.conversationId,
      requests: [syncRequest({ kind: 'tail' })],
    }), 'generation-limits'),
    /response exceeds/u,
  );
});

test('workspace_read bounds output and rejects lexical and symlink escapes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'remux-agent-workspace-'));
  const outside = await mkdtemp(join(tmpdir(), 'remux-agent-outside-'));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'sample.txt'), ['zero', 'one', 'two', 'three'].join('\n'));
  await writeFile(join(root, 'src', 'large.txt'), '🙂'.repeat(10_000));
  await writeFile(join(outside, 'secret.txt'), 'not visible');
  await symlink(join(outside, 'secret.txt'), join(root, 'secret-link'));

  const result = await readWorkspaceFile(root, { path: 'src/sample.txt', startLine: 2, lineCount: 2 });
  assert.equal(result.text, 'one\ntwo');
  assert.equal(result.startLine, 2);
  assert.equal(result.endLine, 3);
  assert.match(result.contentHash, /^[a-f0-9]{64}$/u);

  const bounded = await readWorkspaceFile(root, { path: 'src/large.txt', lineCount: 1 });
  assert.equal(bounded.truncated, true);
  assert.ok(Buffer.byteLength(bounded.text) <= 32 * 1024);
  assert.match(bounded.contentHash, /^[a-f0-9]{64}$/u);

  await assert.rejects(() => readWorkspaceFile(root, { path: '../secret.txt' }), /escapes the workspace/u);
  await assert.rejects(() => readWorkspaceFile(root, { path: 'secret-link' }), /outside the workspace/u);
});

function testServer(
  engine: AgentEngine = new FixtureEngine(),
  notify: (method: string, params: unknown) => void = () => {},
  journal: AgentConversationJournal = new TestConversationJournal(),
) {
  return new AgentServer({ engine, journal, notify });
}

async function testInferenceContext(
  durability: RuntimeDurabilityHooks,
  activeEstimatedInputTokens: number,
) {
  const context = await durability.compileContext();
  const fixedContractsHash = '0'.repeat(64);
  return {
    basisSequence: context.basisSequence,
    logicalHash: context.logicalHash,
    renderedHash: context.logicalHash,
    orderedMessageHashes: context.orderedMessageHashes,
    messageCount: context.messages.length,
    fixedContractsHash,
    shadow: compileShadowContext(context.shadowSource, {
      modelId: 'gpt-5.4-fixture',
      contextWindow: 400_000,
      fixedContractsHash,
      activeEstimatedInputTokens,
    }),
    shadowBuildDurationMs: 0,
    activeMessages: context.messages,
  };
}

test('structured image input is artifact-backed and survives cold transcript replay', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'remux-agent-image-input-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const dataRoot = join(root, 'data');
  const repository = await AgentJournalRepository.open({ dataRoot });
  const server = new AgentServer({ engine: new FixtureEngine(), journal: repository, notify: () => {} });
  await server.initialize();
  const model = await server.handle(AGENT_METHODS.modelsRead, {}) as { defaultModelId: string };
  const created = await server.handle(AGENT_METHODS.conversationCreate, {
    operationId: randomUUID(), cwd: root, modelId: model.defaultModelId, reasoning: 'high',
  }) as { conversationId: string };
  await server.handle(AGENT_METHODS.messageSend, {
    operationId: randomUUID(), conversationId: created.conversationId, clientMessageId: randomUUID(),
    parts: [
      { text: 'Inspect this ', type: 'text' },
      { kind: 'file', name: 'README.md', path: 'README.md', type: 'mention' },
      {
        dataUrl: `data:image/png;base64,${Buffer.from('durable-image').toString('base64')}`,
        mimeType: 'image/png', name: 'sample.png', type: 'image',
      },
    ],
    text: 'ignored browser display text',
  });
  await waitForConversation(server, created.conversationId, (value) => value.status === 'idle');
  const live = requiredFrame((await readTranscriptSync(server, created.conversationId)).turns[0]);
  const user = live.segments.find((segment) => segment.type === 'userMessage');
  assert.ok(user?.type === 'userMessage');
  assert.equal(user.text, 'Inspect this @README.md');
  assert.deepEqual(user.parts?.map((part) => part.type), ['text', 'mention', 'image']);
  const image = user.parts?.find((part) => part.type === 'image');
  assert.ok(image?.type === 'image');
  assert.equal((await repository.readArtifact(image.artifactHash))?.bytes.toString(), 'durable-image');
  await server.close();
  await repository.close();

  const reopened = await AgentJournalRepository.open({ dataRoot });
  t.after(() => reopened.close());
  const replayedUser = (await reopened.readTranscriptProjection(created.conversationId))?.actions
    .find((action) => action.type === 'turn');
  assert.equal(replayedUser?.type === 'turn' ? replayedUser.parts?.[2]?.type : null, 'image');
  const logicalUser = (await reopened.compileContext(created.conversationId)).messages
    .find((message) => message.role === 'user');
  assert.equal(logicalUser?.role === 'user' ? logicalUser.images?.[0]?.sha256 : null, image.artifactHash);
});

test('large structured text stays outside the bounded event payload and replays exactly', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'remux-agent-large-structured-input-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const repository = await AgentJournalRepository.open({ dataRoot: join(root, 'data') });
  const server = new AgentServer({ engine: new FixtureEngine(), journal: repository, notify: () => {} });
  t.after(async () => {
    await server.close();
    await repository.close();
  });
  await server.initialize();
  const model = await server.handle(AGENT_METHODS.modelsRead, {}) as { defaultModelId: string };
  const created = await server.handle(AGENT_METHODS.conversationCreate, {
    operationId: randomUUID(), cwd: root, modelId: model.defaultModelId, reasoning: 'high',
  }) as { conversationId: string };
  const text = `large structured input\n${'0123456789abcdef'.repeat(3_000)}`;
  await server.handle(AGENT_METHODS.messageSend, {
    operationId: randomUUID(), conversationId: created.conversationId, clientMessageId: randomUUID(),
    parts: [{ text, type: 'text' }], text,
  });
  await waitForConversation(server, created.conversationId, (value) => value.status === 'idle');
  const action = (await repository.readTranscriptProjection(created.conversationId))?.actions
    .find((candidate) => candidate.type === 'turn');
  assert.equal(action?.type === 'turn' ? action.text : null, text);
  assert.equal(action?.type === 'turn' ? action.parts?.[0]?.type : null, 'text');
  const logical = (await repository.compileContext(created.conversationId)).messages
    .find((message) => message.role === 'user');
  assert.equal(logical?.role === 'user' ? logical.text : null, text);
});

test('running sends queue durably and dispatch in order after the active turn', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'remux-agent-queue-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const repository = await AgentJournalRepository.open({ dataRoot: join(root, 'data') });
  const server = new AgentServer({ engine: new FixtureEngine(), journal: repository, notify: () => {} });
  t.after(async () => server.close());
  await server.initialize();
  const model = await server.handle(AGENT_METHODS.modelsRead, {}) as { defaultModelId: string };
  const created = await server.handle(AGENT_METHODS.conversationCreate, {
    operationId: randomUUID(), cwd: root, modelId: model.defaultModelId, reasoning: 'high',
  }) as { conversationId: string };
  await server.handle(AGENT_METHODS.messageSend, {
    operationId: randomUUID(), conversationId: created.conversationId,
    clientMessageId: randomUUID(), text: 'first',
  });
  const queued = await server.handle(AGENT_METHODS.messageSend, {
    operationId: randomUUID(), conversationId: created.conversationId,
    clientMessageId: randomUUID(), text: 'second',
  }) as { delivery: string; turnId: string | null };
  assert.deepEqual({ delivery: queued.delivery, turnId: queued.turnId }, { delivery: 'queued', turnId: null });
  const [during] = await repository.readResourceProjections([`queue:${created.conversationId}`]);
  assert.equal(during?.value && 'entries' in during.value ? during.value.entries.length : 0, 1);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const actions = await repository.readTranscriptActions(created.conversationId);
    if (actions.filter((action) => action.type === 'terminal').length === 2) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const actions = await repository.readTranscriptActions(created.conversationId);
  assert.deepEqual(actions.filter((action) => action.type === 'turn').map((action) =>
    action.type === 'turn' ? action.text : ''), ['first', 'second']);
  const [after] = await repository.readResourceProjections([`queue:${created.conversationId}`]);
  assert.equal(after?.value && 'entries' in after.value ? after.value.entries.length : -1, 0);
});

test('the oldest durable queued follow-up resumes after a server restart', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'remux-agent-queue-restart-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const dataRoot = join(root, 'data');
  const firstRepository = await AgentJournalRepository.open({ dataRoot });
  const firstServer = new AgentServer({
    engine: new FixtureEngine(), journal: firstRepository, notify: () => {},
  });
  await firstServer.initialize();
  const model = await firstServer.handle(AGENT_METHODS.modelsRead, {}) as { defaultModelId: string };
  const created = await firstServer.handle(AGENT_METHODS.conversationCreate, {
    operationId: randomUUID(), cwd: root, modelId: model.defaultModelId, reasoning: 'high',
  }) as { conversationId: string };
  await firstServer.handle(AGENT_METHODS.messageSend, {
    operationId: randomUUID(), conversationId: created.conversationId,
    clientMessageId: randomUUID(), text: 'before restart',
  });
  const queued = await firstServer.handle(AGENT_METHODS.messageSend, {
    operationId: randomUUID(), conversationId: created.conversationId,
    clientMessageId: randomUUID(), text: 'resume after restart',
  }) as { delivery: string };
  assert.equal(queued.delivery, 'queued');
  await firstServer.close();
  await firstRepository.close();

  const reopened = await AgentJournalRepository.open({ dataRoot });
  const restarted = new AgentServer({ engine: new FixtureEngine(), journal: reopened, notify: () => {} });
  t.after(async () => {
    await restarted.close();
    await reopened.close();
  });
  await restarted.initialize();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const actions = await reopened.readTranscriptActions(created.conversationId);
    if (actions.some((action) => action.type === 'turn' && action.text === 'resume after restart') &&
        actions.filter((action) => action.type === 'terminal').length >= 2) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const actions = await reopened.readTranscriptActions(created.conversationId);
  assert.deepEqual(actions.filter((action) => action.type === 'turn').map((action) =>
    action.type === 'turn' ? action.text : ''), ['before restart', 'resume after restart']);
  const [queue] = await reopened.readResourceProjections([`queue:${created.conversationId}`]);
  assert.equal(queue?.value && 'entries' in queue.value ? queue.value.entries.length : -1, 0);
});

test('edit and fork create immutable replayed-prefix conversations', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'remux-agent-branches-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const repository = await AgentJournalRepository.open({ dataRoot: join(root, 'data') });
  const server = new AgentServer({ engine: new FixtureEngine(), journal: repository, notify: () => {} });
  t.after(async () => server.close());
  await server.initialize();
  const model = await server.handle(AGENT_METHODS.modelsRead, {}) as { defaultModelId: string };
  const source = await server.handle(AGENT_METHODS.conversationCreate, {
    operationId: randomUUID(), cwd: root, modelId: model.defaultModelId, reasoning: 'high',
  }) as { conversationId: string };
  await server.handle(AGENT_METHODS.messageSend, {
    operationId: randomUUID(), conversationId: source.conversationId,
    clientMessageId: randomUUID(), text: 'source prompt',
  });
  await waitForConversation(server, source.conversationId, (value) => value.status === 'idle');
  const sourceFrame = requiredFrame((await readTranscriptSync(server, source.conversationId)).turns[0]);
  const sourceUser = sourceFrame.segments.find((segment) => segment.type === 'userMessage');
  const sourceAssistant = sourceFrame.segments.find((segment) => segment.type === 'assistantMessage');
  assert.ok(sourceUser?.type === 'userMessage' && sourceAssistant?.type === 'assistantMessage');

  const fork = await server.handle(AGENT_METHODS.messageFork, {
    operationId: randomUUID(), clientMessageId: randomUUID(),
    sourceConversationId: source.conversationId, sourceTurnId: sourceFrame.id,
    sourceMessageId: sourceAssistant.id,
    parts: [{ text: 'fork follow-up', type: 'text' }], text: 'fork follow-up',
  }) as MessageBranchResult;
  await waitForConversation(server, fork.conversationId, (value) => value.status === 'idle');
  assert.deepEqual((await repository.readTranscriptActions(fork.conversationId))
    .filter((action) => action.type === 'turn')
    .map((action) => action.type === 'turn' ? action.text : ''), ['source prompt', 'fork follow-up']);

  const edit = await server.handle(AGENT_METHODS.messageEdit, {
    operationId: randomUUID(), clientMessageId: randomUUID(),
    sourceConversationId: source.conversationId, sourceTurnId: sourceFrame.id,
    sourceMessageId: sourceUser.id,
    parts: [{ text: 'replacement prompt', type: 'text' }], text: 'replacement prompt',
  }) as MessageBranchResult;
  await waitForConversation(server, edit.conversationId, (value) => value.status === 'idle');
  assert.deepEqual((await repository.readTranscriptActions(edit.conversationId))
    .filter((action) => action.type === 'turn')
    .map((action) => action.type === 'turn' ? action.text : ''), ['replacement prompt']);
  assert.deepEqual((await repository.readTranscriptActions(source.conversationId))
    .filter((action) => action.type === 'turn')
    .map((action) => action.type === 'turn' ? action.text : ''), ['source prompt']);
});

class TestConversationJournal implements AgentConversationJournal {
  private readonly operations = new Map<string, {
    arguments: string;
    result: Awaited<ReturnType<AgentConversationJournal['createConversation']>>;
  }>();
  private readonly conversations = new Map<string, {
    projectId: string;
    strandId: string;
    contextSpaceId: string;
    cwd: string;
    modelId: string;
    reasoning: Parameters<AgentConversationJournal['createConversation']>[0]['reasoning'];
    createdAt: number;
  }>();
  private readonly turns = new Map<string, {
    operationId: string;
    arguments: string;
    text: string;
    result: Awaited<ReturnType<AgentConversationJournal['acceptTurn']>>;
  }>();
  private readonly turnOperations = new Map<string, {
    arguments: string;
    result: Awaited<ReturnType<AgentConversationJournal['acceptTurn']>>;
  }>();
  private readonly assistantItems = new Map<string, string>();
  private readonly toolItems = new Map<string, string>();
  private readonly actions = new Map<string, Awaited<ReturnType<AgentConversationJournal['readTranscriptActions']>>>();

  async createConversation(
    params: Parameters<AgentConversationJournal['createConversation']>[0],
  ) {
    const argumentsKey = JSON.stringify(params);
    const existing = this.operations.get(params.operationId);
    if (existing) {
      if (existing.arguments !== argumentsKey) {
        const conflict = new Error('Operation conflict') as Error & { operationId: string };
        conflict.name = 'OperationConflictError';
        conflict.operationId = params.operationId;
        throw conflict;
      }
      return { ...existing.result, replayed: true };
    }
    const result = {
      accepted: true as const,
      operationId: params.operationId,
      projectId: randomUUID(),
      rootSpaceId: randomUUID(),
      conversationId: randomUUID(),
      rootStrandId: randomUUID(),
      contextSpaceId: randomUUID(),
      basisSequence: 4,
      replayed: false,
    };
    this.operations.set(params.operationId, { arguments: argumentsKey, result });
    this.conversations.set(result.conversationId, {
      projectId: result.projectId,
      strandId: result.rootStrandId,
      contextSpaceId: result.contextSpaceId,
      cwd: params.cwd,
      modelId: params.modelId,
      reasoning: params.reasoning,
      createdAt: Date.now(),
    });
    return result;
  }

  async acceptTurn(params: Parameters<AgentConversationJournal['acceptTurn']>[0]) {
    const argumentsKey = JSON.stringify(params);
    if (this.operations.has(params.operationId)) {
      const conflict = new Error('Operation conflict') as Error & { operationId: string };
      conflict.name = 'OperationConflictError';
      conflict.operationId = params.operationId;
      throw conflict;
    }
    const operation = this.turnOperations.get(params.operationId);
    if (operation) {
      if (operation.arguments !== argumentsKey) {
        const conflict = new Error('Operation conflict') as Error & { operationId: string };
        conflict.name = 'OperationConflictError';
        conflict.operationId = params.operationId;
        throw conflict;
      }
      return { ...operation.result, replayed: true };
    }
    const key = `${params.conversationId}\0${params.clientMessageId}`;
    const existing = this.turns.get(key);
    if (existing) {
      const conflict = new Error('Client message conflict');
      conflict.name = 'ClientMessageConflictError';
      throw conflict;
    }
    const conversation = this.conversations.get(params.conversationId);
    if (!conversation) throw new Error('Conversation not found.');
    const result = {
      accepted: true as const,
      operationId: params.operationId,
      projectId: conversation.projectId,
      conversationId: params.conversationId,
      strandId: conversation.strandId,
      turnId: randomUUID(),
      scopeId: randomUUID(),
      epochId: randomUUID(),
      clientMessageId: params.clientMessageId,
      basisSequence: this.nextConversationSequence(params.conversationId),
      transcriptSequence: this.nextConversationSequence(params.conversationId),
      transcriptCreatedAt: Date.now(),
      userItemId: randomUUID(),
      replayed: false,
    };
    this.conversationActions(params.conversationId).push({
      type: 'turn',
      turnId: result.turnId,
      clientMessageId: params.clientMessageId,
      text: params.text,
    });
    result.basisSequence = this.currentConversationSequence(params.conversationId);
    result.transcriptSequence = result.basisSequence;
    this.turns.set(key, {
      operationId: params.operationId,
      arguments: argumentsKey,
      text: params.text,
      result,
    });
    this.turnOperations.set(params.operationId, { arguments: argumentsKey, result });
    return result;
  }

  async reconcileTurn(params: Parameters<AgentConversationJournal['reconcileTurn']>[0]) {
    const argumentsKey = JSON.stringify(params);
    if (this.operations.has(params.operationId)) {
      const conflict = new Error('Operation conflict') as Error & { operationId: string };
      conflict.name = 'OperationConflictError';
      conflict.operationId = params.operationId;
      throw conflict;
    }
    const operation = this.turnOperations.get(params.operationId);
    if (operation) {
      if (operation.arguments !== argumentsKey) {
        const conflict = new Error('Operation conflict') as Error & { operationId: string };
        conflict.name = 'OperationConflictError';
        conflict.operationId = params.operationId;
        throw conflict;
      }
      return { ...operation.result, replayed: true };
    }
    const existing = this.turns.get(`${params.conversationId}\0${params.clientMessageId}`);
    if (existing) {
      const conflict = new Error('Client message conflict');
      conflict.name = 'ClientMessageConflictError';
      throw conflict;
    }
    return null;
  }

  async reconcileQueuedTurn() {
    return null;
  }

  async enqueueTurn(params: Parameters<AgentConversationJournal['enqueueTurn']>[0]) {
    return {
      accepted: true as const,
      delivery: 'queued' as const,
      operationId: params.operationId,
      replayed: false,
      turnId: null,
    };
  }

  async readQueuedTurn() {
    return null;
  }

  async finishQueuedTurn() {
    return false;
  }

  async removeQueuedTurn() {
    return false;
  }

  async appendAssistantCheckpoint(
    handle: Parameters<AgentConversationJournal['appendAssistantCheckpoint']>[0],
    checkpoint: Parameters<AgentConversationJournal['appendAssistantCheckpoint']>[1],
  ) {
    this.conversationActions(handle.conversationId).push({
      type: 'assistant', turnId: handle.turnId, ...checkpoint,
    });
    const itemId = this.assistantItems.get(handle.turnId) ?? randomUUID();
    this.assistantItems.set(handle.turnId, itemId);
    return {
      basisSequence: this.currentConversationSequence(handle.conversationId),
      createdAt: Date.now(),
      itemId,
    };
  }

  async recordToolStarted(
    handle: Parameters<AgentConversationJournal['recordToolStarted']>[0],
    input: Parameters<AgentConversationJournal['recordToolStarted']>[1],
  ) {
    this.conversationActions(handle.conversationId).push({
      type: 'tool-start', turnId: handle.turnId, ...input,
    });
    const itemId = randomUUID();
    this.toolItems.set(`${handle.turnId}\0${input.callId}`, itemId);
    return {
      basisSequence: this.currentConversationSequence(handle.conversationId),
      createdAt: Date.now(),
      itemId,
    };
  }

  async recordToolFinished(
    handle: Parameters<AgentConversationJournal['recordToolFinished']>[0],
    input: Parameters<AgentConversationJournal['recordToolFinished']>[1],
  ) {
    this.conversationActions(handle.conversationId).push({
      type: 'tool-end', turnId: handle.turnId, callId: input.callId,
      result: input.result, isError: input.isError,
    });
    return {
      basisSequence: this.currentConversationSequence(handle.conversationId),
      createdAt: Date.now(),
      itemId: this.toolItems.get(`${handle.turnId}\0${input.callId}`) ?? null,
    };
  }

  async startInference() {
    return { inferenceId: randomUUID(), ordinal: 0, sequence: 1 };
  }

  async finishInference() {
    return true;
  }

  async finishTurn(
    handle: Parameters<AgentConversationJournal['finishTurn']>[0],
    input: Parameters<AgentConversationJournal['finishTurn']>[1],
  ) {
    this.conversationActions(handle.conversationId).push({
      type: 'terminal', turnId: handle.turnId, status: input.status, error: input.error ?? null,
      errorCode: input.errorCode ?? null,
      durationMs: input.durationMs ?? 0,
    });
    return {
      basisSequence: this.currentConversationSequence(handle.conversationId),
      createdAt: Date.now(),
      itemId: null,
    };
  }

  async compileContext(conversationId: string) {
    const replay: LogicalReplayEvent[] = [];
    let sequence = 0;
    for (const action of this.conversationActions(conversationId)) {
      sequence += 1;
      if (action.type === 'turn') {
        replay.push({
          type: 'user', sequence, turnId: action.turnId, timestamp: sequence, text: action.text,
        });
      } else if (action.type === 'assistant') {
        replay.push({
          type: 'assistant-checkpoint', sequence, turnId: action.turnId, timestamp: sequence,
          textDelta: action.textDelta, reasoningDelta: action.reasoningDelta,
        });
      } else if (action.type === 'tool-start') {
        replay.push({
          type: 'tool-called', sequence, turnId: action.turnId, timestamp: sequence,
          callId: action.callId, name: action.name, args: action.args,
        });
      } else if (action.type === 'tool-end') {
        replay.push({
          type: 'tool-completed', sequence, turnId: action.turnId, timestamp: sequence,
          callId: action.callId, result: action.result, isError: action.isError,
        });
      } else {
        replay.push({
          type: 'turn-terminal', sequence, turnId: action.turnId, timestamp: sequence,
          state: action.status === 'completed' ? 'completed' : action.status === 'failed' ? 'failed' : 'interrupted',
        });
      }
    }
    const snapshot = createDurableContextSnapshot(sequence, reduceLogicalReplay(replay));
    const conversation = this.conversations.get(conversationId);
    const activeTurn = [...this.turns.values()]
      .map(({ result }) => result)
      .filter((turn) => turn.conversationId === conversationId)
      .at(-1);
    if (!conversation || !activeTurn) throw new Error('Conversation has no active shadow context source.');
    const currentUser = [...snapshot.messages].reverse().find((message): message is Extract<LogicalContextMessage, { role: 'user' }> =>
      message.role === 'user' && message.turnId === activeTurn.turnId);
    if (!currentUser) throw new Error('Conversation has no current user message.');
    return {
      ...snapshot,
      shadowSource: {
        basisSequence: snapshot.basisSequence,
        projectId: conversation.projectId,
        projectRevision: 0,
        conversationId,
        strandId: conversation.strandId,
        turnId: activeTurn.turnId,
        scopeId: activeTurn.scopeId,
        epochId: activeTurn.epochId,
        targetContextSpaceId: conversation.contextSpaceId,
        workspaceRoot: conversation.cwd,
        reasoning: conversation.reasoning,
        messages: snapshot.messages,
        authority: [],
        turnAnchor: {
          currentUser: { ref: `journal://turn/${encodeURIComponent(activeTurn.turnId)}#user`, body: currentUser.text },
          precedingAssistantRef: null,
          acceptedProposalRef: null,
          steeringRefs: [],
        },
        observedRuntime: { cwd: conversation.cwd },
        executionScope: { kind: 'turn' as const, parentScopeId: null, objective: {}, capsuleRef: null },
      },
    };
  }

  async readTranscriptActions(conversationId: string) {
    return [...(this.actions.get(conversationId) ?? [])];
  }

  async readTranscriptBasis(conversationId: string) {
    if (!this.conversations.has(conversationId)) return null;
    return 4 + (this.actions.get(conversationId)?.length ?? 0);
  }

  async readTranscriptProjection(conversationId: string) {
    const basisSequence = await this.readTranscriptBasis(conversationId);
    if (basisSequence === null) return null;
    return {
      basisSequence,
      actions: (this.actions.get(conversationId) ?? []).map((action, index) => ({
        ...action,
        sequence: index + 5,
        createdAt: index + 5,
        itemId: action.type === 'turn'
          ? [...this.turns.values()].find(({ result }) => result.turnId === action.turnId)?.result.userItemId ?? null
          : action.type === 'assistant'
            ? this.assistantItems.get(action.turnId) ?? null
            : action.type === 'tool-start' || action.type === 'tool-end'
              ? this.toolItems.get(`${action.turnId}\0${action.callId}`) ?? null
              : null,
      })),
    };
  }

  async readTranscriptWindowProjection(
    params: Parameters<AgentConversationJournal['readTranscriptWindowProjection']>[0],
  ) {
    const projection = await this.readTranscriptProjection(params.conversationId);
    if (!projection) return null;
    const allTurnIds = projection.actions.flatMap((action) =>
      action.type === 'turn' ? [action.turnId] : []);
    const selected = new Set<string>();
    const windows = params.requests.flatMap((request, requestIndex) => {
      if (request.type !== 'transcriptSync') {
        selected.add(request.turnId);
        return [];
      }
      let startIndex: number;
      let endIndexExclusive: number;
      if (request.window.kind === 'tail') {
        startIndex = Math.max(0, allTurnIds.length - (request.window.count ?? 24));
        endIndexExclusive = allTurnIds.length;
      } else if (request.window.kind === 'around') {
        const anchor = allTurnIds.indexOf(request.window.turnId);
        if (anchor < 0) throw new Error('Transcript window anchor was not found.');
        startIndex = Math.max(0, anchor - request.window.before);
        endIndexExclusive = Math.min(allTurnIds.length, anchor + request.window.after + 1);
      } else {
        startIndex = allTurnIds.indexOf(request.window.startTurnId);
        const end = allTurnIds.indexOf(request.window.endTurnId);
        if (startIndex < 0 || end < startIndex) throw new Error('Transcript range anchors are invalid.');
        endIndexExclusive = end + 1;
      }
      const turnIds = allTurnIds.slice(startIndex, endIndexExclusive);
      for (const turnId of turnIds) selected.add(turnId);
      return [{
        requestIndex,
        startIndex,
        endIndexExclusive,
        hasEarlier: startIndex > 0,
        hasLater: endIndexExclusive < allTurnIds.length,
        turnIds,
      }];
    });
    const actions = projection.actions.filter((action) => selected.has(action.turnId));
    return {
      ...projection,
      actions,
      estimatedBytes: Buffer.byteLength(JSON.stringify(actions)),
      selectedTurnIds: allTurnIds.filter((turnId) => selected.has(turnId)),
      windows,
    };
  }

  async readResourceProjections(keys: readonly import('../shared/protocol.ts').AgentResourceKey[]) {
    const summaries = [...this.conversations].map(([id, conversation]) => {
      const actions = this.actions.get(id) ?? [];
      const user = actions.find((action) => action.type === 'turn');
      const latestTurn = [...actions].reverse().find((action) => action.type === 'turn');
      const latestAssistant = [...actions].reverse().find((action) => action.type === 'assistant');
      const terminal = [...actions].reverse().find((action) => action.type === 'terminal');
      const status = actions.length > 0 && terminal?.type !== 'terminal'
        ? 'running'
        : terminal?.type === 'terminal' && terminal.status === 'failed' ? 'error' : 'idle';
      return {
        id,
        title: user?.type === 'turn' ? user.text.slice(0, 80) : 'New conversation',
        preview: latestAssistant?.type === 'assistant'
          ? (latestAssistant.textDelta || latestAssistant.reasoningDelta).slice(0, 160)
          : latestTurn?.type === 'turn' ? latestTurn.text.slice(0, 160) : '',
        cwd: conversation.cwd,
        modelId: conversation.modelId,
        reasoning: conversation.reasoning,
        status,
        latestTurnId: latestTurn?.type === 'turn' ? latestTurn.turnId : null,
        createdAt: conversation.createdAt,
        updatedAt: conversation.createdAt + actions.length,
      } satisfies ConversationSummary;
    });
    return keys.map((key) => {
      if (key === AGENT_RESOURCE_KEYS.conversationList) {
        const basisSequence = Math.max(0, ...summaries.map((summary) => 4 + (this.actions.get(summary.id)?.length ?? 0)));
        return {
          key: AGENT_RESOURCE_KEYS.conversationList,
          basisSequence,
          value: { conversations: summaries, truncated: false },
        };
      }
      if (key.startsWith('conversation:')) {
        const id = key.slice('conversation:'.length);
        const value = summaries.find((summary) => summary.id === id);
        return value ? {
          key: conversationResourceKey(id),
          basisSequence: 4 + (this.actions.get(id)?.length ?? 0),
          value,
        } : null;
      }
      return null;
    });
  }

  async readArtifact() {
    return null;
  }

  private conversationActions(conversationId: string) {
    let actions = this.actions.get(conversationId);
    if (!actions) {
      actions = [];
      this.actions.set(conversationId, actions);
    }
    return actions;
  }

  private currentConversationSequence(conversationId: string) {
    return 4 + this.conversationActions(conversationId).length;
  }

  private nextConversationSequence(conversationId: string) {
    return this.currentConversationSequence(conversationId) + 1;
  }
}

function repositoryJournal(repository: AgentJournalRepository): Omit<AgentConversationJournal, 'createConversation'> {
  return {
    reconcileTurn: (params) => repository.reconcileTurn(params),
    acceptTurn: (params) => repository.acceptTurn(params),
    reconcileQueuedTurn: (params) => repository.reconcileQueuedTurn(params),
    enqueueTurn: (params) => repository.enqueueTurn(params),
    readQueuedTurn: (conversationId, operationId) => repository.readQueuedTurn(conversationId, operationId),
    finishQueuedTurn: (operationId, turnId) => repository.finishQueuedTurn(operationId, turnId),
    removeQueuedTurn: (conversationId, operationId) => repository.removeQueuedTurn(conversationId, operationId),
    appendAssistantCheckpoint: (handle, checkpoint) =>
      repository.appendAssistantCheckpoint(handle, checkpoint),
    recordToolStarted: (handle, input) => repository.recordToolStarted(handle, input),
    recordToolFinished: (handle, input) => repository.recordToolFinished(handle, input),
    startInference: (handle, input) => repository.startInference(handle, input),
    finishInference: (handle, input) => repository.finishInference(handle, input),
    finishTurn: (handle, input) => repository.finishTurn(handle, input),
    compileContext: (conversationId) => repository.compileContext(conversationId),
    readTranscriptActions: (conversationId) => repository.readTranscriptActions(conversationId),
    readTranscriptBasis: (conversationId) => repository.readTranscriptBasis(conversationId),
    readTranscriptProjection: (conversationId) => repository.readTranscriptProjection(conversationId),
    readTranscriptWindowProjection: (params) => repository.readTranscriptWindowProjection(params),
    readResourceProjections: (keys) => repository.readResourceProjections(keys),
    readArtifact: (hash, range) => repository.readArtifact(hash, range),
  };
}

async function waitForConversation(
  server: AgentServer,
  conversationId: string,
  predicate: (conversation: ConversationValue) => boolean,
) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const read = await server.handle(AGENT_METHODS.resourcesRead, {
      requests: [
        { key: conversationResourceKey(conversationId) },
        { key: AGENT_RESOURCE_KEYS.runtime },
      ],
    }) as ResourceReadResult;
    const conversationResource = read.resources[0];
    const runtimeResource = read.resources[1];
    if (conversationResource?.status === 'ok' && runtimeResource?.status === 'ok') {
      const summary = conversationResource.value as ConversationSummary;
      const runtime = runtimeResource.value as AgentRuntimeValue;
      const loaded = runtime.conversationId === conversationId;
      const conversation: ConversationValue = {
        ...summary,
        status: loaded && runtime.state !== 'unloaded' ? runtime.state : summary.status,
        activeTurnId: loaded ? runtime.activeTurnId : null,
        activeTurnElapsedMs: loaded ? runtime.activeTurnElapsedMs : null,
        contextProbe: loaded && runtime.contextProbe ? runtime.contextProbe : {
          hookVersion: 'agent-durable-v1', modelCallCount: 0, messageCount: 0,
          messageHash: null, orderedMessageHashes: [], estimatedBytes: 0,
          provider: 'openai-codex', modelId: summary.modelId, providerRequestMode: 'none',
        },
        error: loaded ? runtime.error : null,
      };
      if (predicate(conversation)) return conversation;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for fixture conversation');
}

async function readRuntime(server: AgentServer) {
  const read = await server.handle(AGENT_METHODS.resourcesRead, {
    requests: [{ key: AGENT_RESOURCE_KEYS.runtime }],
  }) as ResourceReadResult;
  const resource = read.resources[0];
  assert.ok(resource?.status === 'ok');
  return resource.value as AgentRuntimeValue;
}

async function readTranscriptSync(server: AgentServer, conversationId: string) {
  const result = await server.handle(AGENT_METHODS.transcriptResourcesRead, {
    conversationId,
    requests: [syncRequest({ kind: 'tail' })],
  }) as AgentTranscriptResourcesReadResult;
  return requiredSync(result);
}

async function readWorkGroup(
  server: AgentServer,
  conversationId: string,
  turnId: string,
  segmentId: string,
  groupId: string,
) {
  const result = await server.handle(AGENT_METHODS.transcriptResourcesRead, {
    conversationId,
    requests: [{
      type: 'workGroup',
      protocolVersion: AGENT_TRANSCRIPT_PROTOCOL_VERSION,
      turnId,
      segmentId,
      groupId,
      limit: 50,
    }],
  }) as AgentTranscriptResourcesReadResult;
  return requiredResourceValue<AgentWorkGroupResource>(result);
}

async function readWorkDetail(
  server: AgentServer,
  conversationId: string,
  turnId: string,
  segmentId: string,
  groupId: string,
  rowId: string,
) {
  const result = await server.handle(AGENT_METHODS.transcriptResourcesRead, {
    conversationId,
    requests: [{
      type: 'workEntryDetail',
      protocolVersion: AGENT_TRANSCRIPT_PROTOCOL_VERSION,
      turnId,
      segmentId,
      groupId,
      rowId,
    }],
  }) as AgentTranscriptResourcesReadResult;
  return requiredResourceValue<AgentWorkEntryDetailResource>(result);
}

function syncRequest(
  window: AgentTranscriptSyncRequest['window'],
  knownTurns?: Array<{ turnId: string; renderRevision: string }>,
) {
  return {
    type: 'transcriptSync' as const,
    protocolVersion: AGENT_TRANSCRIPT_PROTOCOL_VERSION,
    projectionVersion: AGENT_TRANSCRIPT_PROJECTION_VERSION,
    window,
    ...(knownTurns ? { knownTurns } : {}),
  };
}

function requiredSync(result: AgentTranscriptResourcesReadResult) {
  return requiredResourceValue<AgentTranscriptSyncResource>(result);
}

function requiredResourceValue<T>(result: AgentTranscriptResourcesReadResult) {
  const resource = result.resources[0];
  assert.ok(resource && resource.status === 'ok' && resource.value);
  return resource.value as T;
}

function requiredFrame(result: AgentTranscriptSyncResource['turns'][number] | undefined) {
  assert.ok(result && result.status === 'ok');
  return result.frame as AgentTurnRenderFrame;
}

function requiredWork(frame: AgentTurnRenderFrame) {
  const work = frame.segments.find((segment) => segment.type === 'work');
  assert.ok(work && work.type === 'work');
  return work as AgentWorkRenderSegment;
}

function requiredGroupRef(work: AgentWorkRenderSegment) {
  const group = work.timeline.find((entry) => entry.type === 'group');
  assert.ok(group && group.type === 'group');
  return group as AgentWorkGroupTimelineEntry;
}
