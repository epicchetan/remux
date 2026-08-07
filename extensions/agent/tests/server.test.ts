import assert from 'node:assert/strict';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  AGENT_METHODS,
  conversationResourceKey,
  type ConversationValue,
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
import { AgentServer } from '../server/src/agent-server.ts';
import type { AgentEngine } from '../server/src/engine.ts';
import { FixtureEngine } from '../server/src/fixture-engine.ts';
import { handleJsonRpcLine, JsonRpcOutput } from '../server/src/json-rpc.ts';
import {
  EphemeralTranscriptProjector,
  parseTranscriptResourcesReadParams,
} from '../server/src/transcript-projector.ts';
import { readWorkspaceFile } from '../server/src/workspace-read.ts';

test('resource reads support revisions and reconnect generations', async () => {
  const server = new AgentServer(new FixtureEngine(), () => {});
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

  const restarted = new AgentServer(new FixtureEngine(), () => {});
  await restarted.initialize();
  const afterRestart = await restarted.handle(AGENT_METHODS.resourcesRead, {
    requests: [{ key: 'auth' }],
  }) as ResourceReadResult;
  assert.notEqual(afterRestart.resources[0]?.serverGeneration, resource.serverGeneration);
});

test('replacing the ephemeral conversation makes every prior resource unavailable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'remux-agent-replace-'));
  const server = new AgentServer(new FixtureEngine(), () => {});
  await server.initialize();
  const models = await server.handle(AGENT_METHODS.modelsRead, {}) as { defaultModelId: string };
  const first = await server.handle(AGENT_METHODS.conversationStart, {
    cwd: root,
    modelId: models.defaultModelId,
    reasoning: 'high',
  }) as { conversationId: string };
  const second = await server.handle(AGENT_METHODS.conversationStart, {
    cwd: root,
    modelId: models.defaultModelId,
    reasoning: 'high',
  }) as { conversationId: string };

  assert.notEqual(second.conversationId, first.conversationId);
  const priorConversation = await server.handle(AGENT_METHODS.resourcesRead, {
    requests: [{ key: conversationResourceKey(first.conversationId) }],
  }) as ResourceReadResult;
  assert.equal(priorConversation.resources[0]?.status, 'missing');
  await assert.rejects(
    () => server.handle(AGENT_METHODS.transcriptResourcesRead, {
      conversationId: first.conversationId,
      requests: [syncRequest({ kind: 'tail' })],
    }),
    /Conversation not found/u,
  );
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
  const redacted = new AgentServer(leakyEngine, () => {});
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
  const server = new AgentServer(fixture, () => {});
  await server.initialize();
  const login = await server.handle(AGENT_METHODS.authLoginStart, {}) as { operationId: string };
  await assert.rejects(
    () => server.handle(AGENT_METHODS.authLoginCancel, { operationId: 'wrong-operation' }),
    /no longer active/u,
  );
  assert.deepEqual(
    await server.handle(AGENT_METHODS.authLoginCancel, { operationId: login.operationId }),
    { accepted: true },
  );
});

test('fixture conversation streams projected transcript and tool rows', async () => {
  const root = await mkdtemp(join(tmpdir(), 'remux-agent-test-'));
  const notifications: Array<{ method: string; params: unknown }> = [];
  const server = new AgentServer(
    new FixtureEngine(),
    (method, params) => notifications.push({ method, params }),
  );
  await server.initialize();
  const models = await server.handle(AGENT_METHODS.modelsRead, {}) as {
    defaultModelId: string;
  };
  const started = await server.handle(AGENT_METHODS.conversationStart, {
    cwd: root,
    modelId: models.defaultModelId,
    reasoning: 'high',
  }) as { conversationId: string };
  await server.handle(AGENT_METHODS.messageSend, {
    conversationId: started.conversationId,
    clientMessageId: 'client-message-1',
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
  assert.equal(user?.clientMessageId, 'client-message-1');
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
  assert.ok(notifications.some((notification) => notification.method === AGENT_METHODS.resourcesInvalidated));
  assert.ok(notifications.some((notification) =>
    JSON.stringify(notification.params).includes('"type":"transcript"')));
  assert.doesNotMatch(JSON.stringify(sync), /fixture-read/u);
});

test('interrupt is immediate and leaves the ephemeral conversation reusable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'remux-agent-interrupt-'));
  const server = new AgentServer(new FixtureEngine(), () => {});
  await server.initialize();
  const models = await server.handle(AGENT_METHODS.modelsRead, {}) as { defaultModelId: string };
  const started = await server.handle(AGENT_METHODS.conversationStart, {
    cwd: root,
    modelId: models.defaultModelId,
    reasoning: 'high',
  }) as { conversationId: string };
  const sent = await server.handle(AGENT_METHODS.messageSend, {
    conversationId: started.conversationId,
    clientMessageId: 'client-message-2',
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

test('client, conversation, turn, transcript, and item identities remain distinct', async () => {
  const root = await mkdtemp(join(tmpdir(), 'remux-agent-identities-'));
  const server = new AgentServer(new FixtureEngine(), () => {});
  await server.initialize();
  const models = await server.handle(AGENT_METHODS.modelsRead, {}) as { defaultModelId: string };
  const started = await server.handle(AGENT_METHODS.conversationStart, {
    cwd: root,
    modelId: models.defaultModelId,
    reasoning: 'high',
  }) as { conversationId: string };
  const clientMessageId = 'client-owned-message-id';
  const sent = await server.handle(AGENT_METHODS.messageSend, {
    conversationId: started.conversationId,
    clientMessageId,
    text: 'identity check',
  }) as { turnId: string };
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

  await assert.rejects(
    () => server.handle(AGENT_METHODS.messageSend, {
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
  const engine: AgentEngine = {
    authStatus: () => fixture.authStatus(),
    login: (operationId, signal, update) => fixture.login(operationId, signal, update),
    logout: () => fixture.logout(),
    listModels: () => fixture.listModels(),
    async createConversation(options) {
      return {
        async prompt() {
          options.onEvent({ type: 'assistant-start' });
          options.onEvent({ type: 'assistant-complete', interrupted: false, error: 'Fixture model failed.' });
        },
        async interrupt() {},
        async dispose() {},
      };
    },
  };
  const server = new AgentServer(engine, () => {});
  await server.initialize();
  const models = await server.handle(AGENT_METHODS.modelsRead, {}) as { defaultModelId: string };
  const started = await server.handle(AGENT_METHODS.conversationStart, {
    cwd: root,
    modelId: models.defaultModelId,
    reasoning: 'high',
  }) as { conversationId: string };
  await server.handle(AGENT_METHODS.messageSend, {
    conversationId: started.conversationId,
    clientMessageId: 'error-client-message',
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
});

test('projector windows and known revisions stay bounded and deterministic', () => {
  let clock = 1_000;
  let nextId = 0;
  const projector = new EphemeralTranscriptProjector({
    conversationId: 'conversation-window-test',
    createId: () => `projection-id-${++nextId}`,
    invalidate: () => {},
    now: () => clock,
  });

  for (let index = 0; index < 45; index += 1) {
    const turnId = `turn-${index}`;
    projector.beginTurn({ turnId, clientMessageId: `client-${index}`, text: `message ${index}` });
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
  assert.equal(tailSync.turnOrder[0], 'turn-21');
  assert.equal(tailSync.turnOrder.at(-1), 'turn-44');
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
    requests: [syncRequest({ kind: 'around', turnId: 'turn-20', before: 2, after: 3 })],
  }), 'generation-one');
  assert.deepEqual(requiredSync(around).turnOrder, [
    'turn-18', 'turn-19', 'turn-20', 'turn-21', 'turn-22', 'turn-23',
  ]);

  const range = projector.read(parseTranscriptResourcesReadParams({
    conversationId: projector.conversationId,
    requests: [syncRequest({ kind: 'range', startTurnId: 'turn-4', endTurnId: 'turn-8' })],
  }), 'generation-one');
  assert.deepEqual(requiredSync(range).turnOrder, [
    'turn-4', 'turn-5', 'turn-6', 'turn-7', 'turn-8',
  ]);

  assert.throws(
    () => projector.read(parseTranscriptResourcesReadParams({
      conversationId: projector.conversationId,
      requests: [syncRequest({ kind: 'range', startTurnId: 'turn-0', endTurnId: 'turn-44' })],
    }), 'generation-one'),
    /40 turn limit/u,
  );
  assert.throws(
    () => projector.read(parseTranscriptResourcesReadParams({
      conversationId: projector.conversationId,
      requests: [syncRequest({ kind: 'around', turnId: 'missing', before: 1, after: 1 })],
    }), 'generation-one'),
    /anchor was not found/u,
  );
});

test('projector work details redact provider identities and terminal state fences late events', () => {
  let clock = 5_000;
  let nextId = 0;
  const invalidations: unknown[] = [];
  const projector = new EphemeralTranscriptProjector({
    conversationId: 'conversation-work-test',
    createId: () => `work-id-${++nextId}`,
    invalidate: (value) => invalidations.push(...value),
    now: () => clock,
  });

  projector.beginTurn({ turnId: 'turn-work', clientMessageId: 'client-work', text: 'inspect' });
  projector.appendReasoning('turn-work', 'Checking the workspace.');
  projector.startTool('turn-work', {
    callId: 'provider-call-secret',
    name: 'workspace.read',
    args: { path: 'README.md', authorization: 'opaque-top-secret' },
  });
  clock += 25;
  projector.updateTool('turn-work', { callId: 'provider-call-secret', result: 'sk-abcdefghijk' });
  clock += 25;
  projector.endTool('turn-work', {
    callId: 'provider-call-secret',
    result: { path: 'README.md', token: 'eyJabc.def.ghi' },
    isError: false,
  });
  projector.appendAssistantText('turn-work', 'Done.');
  clock += 50;
  assert.equal(projector.finishTurn('turn-work', { status: 'completed' }), true);
  assert.equal(projector.appendAssistantText('turn-work', 'late mutation'), false);

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

test('projector durations use a monotonic clock while frame timestamps remain wall time', () => {
  let wallClock = 10_000;
  let monotonicClock = 500;
  const projector = new EphemeralTranscriptProjector({
    conversationId: 'conversation-clock-test',
    invalidate: () => {},
    now: () => wallClock,
    monotonicNow: () => monotonicClock,
  });

  projector.beginTurn({ turnId: 'turn-clock', clientMessageId: 'client-clock', text: 'time it' });
  wallClock = 9_000;
  monotonicClock = 575;
  assert.equal(projector.activeElapsedMs(), 75);
  projector.finishTurn('turn-clock', { status: 'completed' });

  const sync = requiredSync(projector.read(parseTranscriptResourcesReadParams({
    conversationId: projector.conversationId,
    requests: [syncRequest({ kind: 'tail' })],
  }), 'generation-clock'));
  const frame = requiredFrame(sync.turns[0]);
  assert.equal(frame.startedAt, 10_000);
  assert.equal(frame.completedAt, 9_000);
  assert.equal(frame.durationMs, 75);
  assert.equal(projector.activeElapsedMs(), null);
});

test('transcript parser and byte caps fail closed', () => {
  assert.throws(
    () => parseTranscriptResourcesReadParams({
      conversationId: 'conversation-limits',
      requests: [{ ...syncRequest({ kind: 'tail' }), protocolVersion: 99 }],
    }),
    /protocol version/u,
  );
  assert.throws(
    () => parseTranscriptResourcesReadParams({
      conversationId: 'conversation-limits',
      requests: [syncRequest(
        { kind: 'tail' },
        [
          { turnId: 'duplicate', renderRevision: 'one' },
          { turnId: 'duplicate', renderRevision: 'two' },
        ],
      )],
    }),
    /duplicate turnId/u,
  );

  let nextId = 0;
  const frameLimited = new EphemeralTranscriptProjector({
    conversationId: 'conversation-frame-limit',
    createId: () => `frame-id-${++nextId}`,
    invalidate: () => {},
    limits: { maxTurnFrameBytes: 200 },
  });
  frameLimited.beginTurn({ turnId: 'large-turn', clientMessageId: 'large-client', text: 'x'.repeat(400) });
  frameLimited.finishTurn('large-turn', { status: 'completed' });
  const frameResult = requiredSync(frameLimited.read(parseTranscriptResourcesReadParams({
    conversationId: frameLimited.conversationId,
    requests: [syncRequest({ kind: 'tail' })],
  }), 'generation-limits'));
  assert.equal(frameResult.turns[0]?.status, 'error');
  assert.equal(frameResult.turns[0]?.status === 'error' ? frameResult.turns[0].code : null, 'frameTooLarge');

  const responseLimited = new EphemeralTranscriptProjector({
    conversationId: 'conversation-response-limit',
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
      ],
    }) as ResourceReadResult;
    const conversationResource = read.resources[0];
    if (conversationResource?.status === 'ok') {
      const conversation = conversationResource.value as ConversationValue;
      if (predicate(conversation)) return conversation;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for fixture conversation');
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
