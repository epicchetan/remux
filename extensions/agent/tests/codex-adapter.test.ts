import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type {
  CodexAppServerConnection,
  CodexAppServerLaunchOptions,
} from '../server/src/providers/codex/codex-app-server-process.ts';
import { CodexNativeAdapter } from '../server/src/providers/codex/codex-adapter.ts';
import { codexStableChildExecutionId } from '../server/src/providers/codex/codex-event-mapper.ts';
import type {
  OpenProviderSessionInput,
  ProviderEventEnvelope,
  StartProviderTurnInput,
} from '../shared/provider-runtime.ts';

const openInput: OpenProviderSessionInput = {
  commandId: 'open-command-1',
  providerInstanceId: 'codex-local',
  conversationId: 'conversation-1',
  executionId: 'execution-1',
  mode: 'create',
  cwd: '/workspace/remux',
  model: 'gpt-test',
  effort: 'high',
  access: 'workspace-write',
  developerInstructions: ['Use ordinary chat for clarifications.'],
};

const turnInput: StartProviderTurnInput = {
  commandId: 'turn-command-1',
  conversationId: 'conversation-1',
  executionId: 'execution-1',
  turnId: 'remux-turn-1',
  content: [
    { type: 'text', text: 'Implement it.' },
    { type: 'file-reference', path: '/workspace/remux/README.md' },
    { type: 'image-artifact', artifactId: 'artifact-1', mimeType: 'image/png' },
  ],
};

test('Codex probe and model discovery use native subscription state and native catalog', async () => {
  const peers: FakeCodexConnection[] = [];
  const adapter = new CodexNativeAdapter({
    createConnection: async (launch) => {
      const peer = new FakeCodexConnection(launch);
      peers.push(peer);
      return peer;
    },
  });

  const probe = await adapter.probe('codex-local');
  assert.equal(probe.state, 'ready');
  assert.equal(probe.capabilities?.auth, 'native-subscription');
  assert.equal(probe.capabilities?.interaction.blockingApprovals, false);
  assert.equal(probe.capabilities?.collaboration.nativeSubagents, true);
  assert.equal(probe.capabilities?.collaboration.childTranscript, 'full');
  assert.equal(probe.capabilities?.collaboration.childInterrupt, true);
  assert.equal(probe.capabilities?.session.rollbackNative, false);

  const models = await adapter.listModels('codex-local');
  assert.deepEqual(models, [{
    id: 'gpt-test',
    name: 'GPT Test',
    provider: 'codex',
    supportedEffort: ['low', 'high'],
    serviceTiers: [{
      id: 'default',
      name: 'Standard',
      description: 'Standard speed and usage',
    }, {
      id: 'priority',
      name: 'Fast',
      description: 'Faster responses with higher usage',
    }],
    defaultServiceTier: 'default',
    isDefault: true,
  }]);
  assert.equal(peers.length, 2);
  assert.ok(peers.every((peer) => peer.closed));
});

test('Codex session launch scopes federation credentials and dispatches each turn command once', async () => {
  let peer: FakeCodexConnection | undefined;
  let launch: CodexAppServerLaunchOptions | undefined;
  const resolvedScopes: Array<{ conversationId: string; executionId: string }> = [];
  const adapter = new CodexNativeAdapter({
    environment: {
      REMUX_TEST_ENV: 'yes',
      REMUX_FEDERATION_MCP_BEARER_TOKEN: 'ambient-must-not-leak',
    },
    appServerArgs: ['-c', 'features.example=true'],
    resolveImageArtifact: async (scope, artifactId) => {
      resolvedScopes.push(scope);
      return { type: 'localImage', path: `/server-artifacts/${artifactId}.png` };
    },
    createConnection: async (options) => {
      launch = options;
      peer = new FakeCodexConnection(options, { autoCompleteTurns: true });
      return peer;
    },
  });
  const session = await adapter.openSession({
    ...openInput,
    federation: {
      endpoint: 'http://127.0.0.1:9812/mcp/session-token',
      authorizationHeader: 'Bearer one-session-secret',
    },
  });
  assert.ok(peer && launch);
  assert.equal(session.nativeSession.sessionId, 'thread-created-1');
  assert.equal((peer.requests.find(({ method }) => method === 'thread/start')?.params as {
    serviceTier?: string;
  }).serviceTier, 'default');
  assert.equal(launch.environment?.REMUX_FEDERATION_MCP_BEARER_TOKEN, undefined);
  assert.deepEqual(launch.args, ['-c', 'features.example=true'],
    'scoped federation credentials must not be exposed through process arguments');
  assert.deepEqual(
    (peer.requests.find(({ method }) => method === 'thread/start')?.params as {
      config?: unknown;
    }).config,
    {
      'mcp_servers.remux-federation.url': 'http://127.0.0.1:9812/mcp/session-token',
      'mcp_servers.remux-federation.http_headers': {
        Authorization: 'Bearer one-session-secret',
      },
      'mcp_servers.remux-federation.default_tools_approval_mode': 'approve',
      'mcp_servers.remux-federation.tool_timeout_sec': 14_400,
    },
    'the bearer is scoped to the app-server thread configuration rather than its process environment',
  );

  const seen: ProviderEventEnvelope[] = [];
  const terminal = collectUntil(session.events, seen, ({ event }) => event.type === 'turn.completed');
  const firstAcceptance = await session.startTurn(turnInput);
  assert.equal(firstAcceptance.outcome, 'accepted');
  assert.equal(firstAcceptance.nativeTurnId, 'native-turn-1');
  const replayedAcceptance = await session.startTurn(structuredClone(turnInput));
  assert.equal(replayedAcceptance.outcome, 'accepted');
  assert.equal(replayedAcceptance.nativeTurnId, 'native-turn-1');
  assert.deepEqual(resolvedScopes, [{ conversationId: 'conversation-1', executionId: 'execution-1' }]);
  await terminal;

  const starts = peer.requests.filter(({ method }) => method === 'turn/start');
  assert.equal(starts.length, 1);
  assert.equal((starts[0]?.params as { serviceTier?: string }).serviceTier, 'default');
  assert.deepEqual((starts[0]?.params as { input: unknown }).input, [
    { type: 'text', text: 'Implement it.', text_elements: [] },
    { type: 'mention', name: 'README.md', path: '/workspace/remux/README.md' },
    { type: 'localImage', path: '/server-artifacts/artifact-1.png' },
  ]);
  assert.ok(seen.some(({ event }) =>
    event.type === 'turn.block.completed' && event.block.payload.kind === 'final-message' &&
    event.block.payload.text === 'Implemented.'));
  assert.ok(seen.some(({ event }) =>
    event.type === 'turn.completed' && event.outcome === 'completed'));

  // The fake completes during the turn/start request. This proves the adapter
  // does not resurrect a stale active-turn lock after the response arrives.
  await session.startTurn({
    ...turnInput,
    commandId: 'turn-command-2',
    turnId: 'remux-turn-2',
    serviceTier: 'priority',
    content: [{ type: 'text', text: 'Follow up.' }],
  });
  assert.equal(peer.requests.filter(({ method }) => method === 'turn/start').length, 2);
  assert.equal((peer.requests.filter(({ method }) => method === 'turn/start')[1]?.params as {
    serviceTier?: string;
  }).serviceTier, 'priority');
  const compactEvents: ProviderEventEnvelope[] = [];
  const compactTerminal = collectUntil(session.events, compactEvents, ({ event }) =>
    event.type === 'context.compaction.completed');
  const compactInput = {
    commandId: 'compact-command-1',
    conversationId: openInput.conversationId,
    executionId: openInput.executionId,
  };
  assert.deepEqual(await session.compact!(compactInput), {
    accepted: true,
    nativeOperationId: 'compact-command-1',
  });
  assert.deepEqual(await session.compact!(structuredClone(compactInput)), {
    accepted: true,
    nativeOperationId: 'compact-command-1',
  });
  await compactTerminal;
  assert.equal(peer.requests.filter(({ method }) => method === 'thread/compact/start').length, 1);
  assert.equal(compactEvents.filter(({ event }) =>
    event.type === 'context.compaction.completed' && event.trigger === 'manual' &&
    event.operationId === 'compact-command-1').length, 1);
  await session.close();
});

test('Codex resume, steer, interrupt, snapshot, and fork preserve native identities', async () => {
  let peer: FakeCodexConnection | undefined;
  const adapter = new CodexNativeAdapter({
    createConnection: async (options) => {
      peer = new FakeCodexConnection(options, { emitForkStarted: true });
      return peer;
    },
  });
  const session = await adapter.openSession({
    ...openInput,
    commandId: 'open-resume-1',
    mode: 'resume',
    nativeSession: {
      provider: 'codex',
      providerInstanceId: 'codex-local',
      sessionId: 'thread-resumed-1',
      resumeCursor: { threadId: 'thread-resumed-1' },
    },
  });
  assert.ok(peer);
  assert.equal(peer.requests.find(({ method }) => method === 'thread/resume')?.params
    && (peer.requests.find(({ method }) => method === 'thread/resume')!.params as { threadId: string }).threadId,
  'thread-resumed-1');

  await session.startTurn(turnInputWithText());
  peer.startChildTurn('child-thread-1', 'child-turn-1');
  await session.steer!({
    commandId: 'steer-command-1',
    turnId: 'remux-turn-1',
    content: [{ type: 'text', text: 'Actually, include tests.' }],
  });
  await session.interrupt({ commandId: 'interrupt-command-1', turnId: 'remux-turn-1' });
  peer.completeActiveTurn();
  assert.equal((peer.requests.find(({ method }) => method === 'turn/steer')?.params as {
    expectedTurnId: string;
  }).expectedTurnId, 'native-turn-1');
  const interrupts = peer.requests.filter(({ method }) => method === 'turn/interrupt');
  assert.deepEqual(interrupts[0]?.params, {
    threadId: 'thread-resumed-1',
    turnId: 'native-turn-1',
  });
  assert.equal(interrupts.length, 1, 'root interrupt leaves child cascade to the lifecycle owner');
  assert.equal((interrupts.at(-1)?.params as {
    turnId: string;
  }).turnId, 'native-turn-1');

  const snapshot = await session.snapshot({ commandId: 'snapshot-command-1' });
  assert.equal(snapshot.nativeSession.sessionId, 'thread-resumed-1');
  assert.equal(snapshot.state, 'idle');
  assert.equal(snapshot.authority, 'authoritative');
  assert.equal(snapshot.historyRevision, 'updated-at:1700000001000');
  assert.deepEqual(snapshot.coverage?.turnBlocks.completeKinds, [
    'reasoning-summary',
    'commentary',
    'final-message',
    'compatibility-notice',
  ]);
  assert.ok(snapshot.events.some(({ event }) => event.type === 'user.message'));
  assert.equal(await session.readHistoryRevision?.(), snapshot.historyRevision);
  assert.deepEqual(peer.requests.filter(({ method }) => method === 'thread/read').at(-1)?.params, {
    threadId: 'thread-resumed-1',
    includeTurns: false,
  });

  const fork = await session.fork!({
    commandId: 'fork-command-1',
    throughNativeTurnId: 'native-turn-1',
  });
  assert.equal(fork.sessionId, 'thread-forked-1');
  assert.equal((peer.requests.find(({ method }) => method === 'thread/fork')?.params as {
    lastTurnId: string;
  }).lastTurnId, 'native-turn-1');
  assert.equal((peer.requests.find(({ method }) => method === 'thread/fork')?.params as {
    deferGoalContinuation: boolean;
  }).deferGoalContinuation, true);
  const afterFork = await session.snapshot({ commandId: 'snapshot-after-fork' });
  assert.equal(afterFork.events.some(({ event }) =>
    event.type === 'turn.block.started' && event.block.payload.kind === 'native-child' &&
    event.block.payload.child.nativeSessionId === fork.sessionId), false,
  'the thread created by an explicit fork must not be projected as a native subagent');
  await session.close();
});

test('Codex child controls and transcript snapshots stay on the native child thread', async () => {
  let peer: FakeCodexConnection | undefined;
  const childThreadId = 'child-thread-transcript';
  const childExecutionId = codexStableChildExecutionId(openInput.executionId, childThreadId);
  const childImportScopes: Array<{ conversationId: string; executionId: string }> = [];
  const adapter = new CodexNativeAdapter({
    importHistoricalImage: async (scope) => {
      childImportScopes.push(scope);
      return { artifactId: 'child-history-image', mimeType: 'image/png', byteLength: 4 };
    },
    createConnection: async (options) => {
      peer = new FakeCodexConnection(options, {
        childSnapshotTurns: {
          [childThreadId]: [{
            id: 'child-turn-transcript',
            status: 'completed',
            items: [
              { id: 'child-user', type: 'userMessage', content: [
                { type: 'text', text: 'Inspect it.' },
                { type: 'image', detail: 'auto', url: 'data:image/png;base64,aGVsbG8=' },
              ] },
              { id: 'child-answer', type: 'agentMessage', phase: 'final_answer', text: 'Child result.' },
            ],
          }],
        },
      });
      return peer;
    },
  });
  const session = await adapter.openSession({
    ...openInput,
    commandId: 'open-child-transcript',
    mode: 'resume',
    nativeSession: {
      provider: 'codex',
      providerInstanceId: 'codex-local',
      sessionId: 'thread-resumed-child',
      resumeCursor: { threadId: 'thread-resumed-child' },
    },
  });
  assert.ok(peer);
  await session.startTurn(turnInputWithText());
  peer.startChildTurn(childThreadId, 'child-turn-transcript');

  await session.interruptChild!({
    commandId: 'interrupt-child-command',
    childExecutionId,
    nativeSessionId: childThreadId,
  });
  assert.deepEqual(peer.requests.filter(({ method }) => method === 'turn/interrupt').at(-1)?.params, {
    threadId: childThreadId,
    turnId: 'child-turn-transcript',
  });

  peer.emitNotification('item/completed', {
    threadId: childThreadId,
    turnId: 'child-turn-transcript',
    item: { id: 'child-answer', type: 'agentMessage', phase: 'final_answer', text: 'Child result.' },
  });
  peer.emitNotification('item/completed', {
    threadId: 'thread-resumed-child',
    turnId: 'native-turn-1',
    item: { id: 'subagent-completed-child-turn-transcript', type: 'subAgentActivity',
      kind: 'completed', agentThreadId: childThreadId },
  });
  peer.emitNotification('turn/completed', {
    threadId: childThreadId,
    turn: { id: 'child-turn-transcript', status: 'completed', items: [] },
  });
  const seen: ProviderEventEnvelope[] = [];
  await collectUntil(session.events, seen, ({ scope, event }) =>
    scope.kind === 'turn' && scope.executionId === childExecutionId && event.type === 'turn.completed');
  assert.ok(seen.some(({ scope, event }) =>
    scope.kind === 'turn' && scope.executionId === openInput.executionId &&
    event.type === 'turn.block.started' && event.block.payload.kind === 'native-child' &&
    event.block.payload.child.executionId === childExecutionId &&
    event.block.payload.child.transcriptAvailable === true));
  assert.ok(seen.some(({ scope, event }) =>
    scope.kind === 'turn' && scope.executionId === childExecutionId &&
    event.type === 'turn.block.completed' && event.block.payload.kind === 'final-message' &&
    event.block.payload.text === 'Child result.'));
  assert.ok(seen.some(({ scope, event }) => scope.kind === 'turn' &&
    scope.executionId === childExecutionId && event.type === 'turn.completed'));

  const snapshot = await session.snapshotChild!({
    commandId: 'snapshot-child-command',
    childExecutionId,
    nativeSessionId: childThreadId,
  });
  assert.equal(snapshot.nativeSession.sessionId, childThreadId);
  assert.equal(snapshot.authority, 'authoritative');
  assert.ok(snapshot.events.every(({ scope }) =>
    scope.kind === 'account' || scope.executionId === childExecutionId));
  assert.ok(snapshot.events.some(({ event }) => event.type === 'user.message'));
  assert.deepEqual(childImportScopes, [{
    conversationId: openInput.conversationId, executionId: childExecutionId,
  }]);
  await session.close();
});

test('Codex resume restores durable child ownership and child turn ordinal floors', async () => {
  let peer: FakeCodexConnection | undefined;
  const childThreadId = 'child-thread-restored';
  const childExecutionId = codexStableChildExecutionId(openInput.executionId, childThreadId);
  const adapter = new CodexNativeAdapter({
    createConnection: async (options) => {
      peer = new FakeCodexConnection(options, { childSnapshotTurns: {
        [childThreadId]: [{ id: 'native-child-turn-restored', status: 'completed', items: [{
          id: 'restored-answer', type: 'agentMessage', phase: 'final_answer', text: 'Restored.',
        }] }],
      } });
      return peer;
    },
  });
  const session = await adapter.openSession({
    ...openInput,
    commandId: 'open-restored-child',
    mode: 'resume',
    nativeSession: { provider: 'codex', providerInstanceId: 'codex-local', sessionId: 'root-restored' },
    nativeTurnBindings: [{ turnId: 'remux-owner-restored', nativeTurnId: 'native-owner-restored' }],
    nativeChildBindings: [{
      nativeThreadId: childThreadId,
      executionId: childExecutionId,
      parentExecutionId: openInput.executionId,
      nativeParentThreadId: 'root-restored',
      ownerTurnId: 'remux-owner-restored',
      ownerNativeTurnId: 'native-owner-restored',
      nativeTurnBindings: [{
        turnId: 'remux-child-turn-restored',
        nativeTurnId: 'native-child-turn-restored',
        nextBlockOrdinal: 7,
      }],
      outcome: 'completed',
    }],
  });
  assert.ok(peer);
  const snapshot = await session.snapshotChild!({
    commandId: 'snapshot-restored-child', childExecutionId, nativeSessionId: childThreadId,
  });
  const answer = snapshot.events.find(({ event }) =>
    event.type === 'turn.block.completed' && event.block.payload.kind === 'final-message');
  assert.equal(answer?.scope.kind, 'turn');
  if (answer?.scope.kind === 'turn') assert.equal(answer.scope.turnId, 'remux-child-turn-restored');
  const liveEvents: ProviderEventEnvelope[] = [];
  const liveTool = collectUntil(session.events, liveEvents, ({ scope, event }) =>
    scope.kind === 'turn' && scope.executionId === childExecutionId &&
    event.type === 'turn.block.started' && event.block.payload.kind === 'tool');
  peer.emitNotification('item/started', {
    threadId: childThreadId,
    turnId: 'native-child-turn-restored',
    item: { id: 'restored-live-command', type: 'commandExecution', command: 'pwd', status: 'inProgress' },
  });
  await liveTool;
  const tool = liveEvents.find(({ event }) =>
    event.type === 'turn.block.started' && event.block.payload.kind === 'tool');
  if (tool?.event.type === 'turn.block.started') assert.equal(tool.event.structure.blockOrdinal, 7);
  await session.close();
});

test('Codex resume restores the exact active root turn for immediate steer and interrupt', async () => {
  let peer: FakeCodexConnection | undefined;
  const adapter = new CodexNativeAdapter({ createConnection: async (options) => {
    peer = new FakeCodexConnection(options); return peer;
  } });
  const session = await adapter.openSession({
    ...openInput,
    commandId: 'open-active-root',
    mode: 'resume',
    nativeSession: { provider: 'codex', providerInstanceId: 'codex-local', sessionId: 'root-active' },
    nativeTurnBindings: [{ turnId: 'remux-active', nativeTurnId: 'native-active' }],
    activeTurnBinding: { turnId: 'remux-active', nativeTurnId: 'native-active' },
  });
  assert.ok(peer);
  await session.steer({
    commandId: 'steer-active-root', turnId: 'remux-active',
    content: [{ type: 'text', text: 'Continue.' }],
  });
  await session.interrupt({ commandId: 'interrupt-active-root', turnId: 'remux-active' });
  assert.deepEqual(peer.requests.filter(({ method }) => method === 'turn/steer').at(-1)?.params, {
    threadId: 'root-active', expectedTurnId: 'native-active',
    input: [{ type: 'text', text: 'Continue.', text_elements: [] }],
  });
  assert.deepEqual(peer.requests.filter(({ method }) => method === 'turn/interrupt').at(-1)?.params, {
    threadId: 'root-active', turnId: 'native-active',
  });
  await session.close();
});

test('Codex resume interrupts the restored exact child assignment', async () => {
  let peer: FakeCodexConnection | undefined;
  const adapter = new CodexNativeAdapter({ createConnection: async (options) => {
    peer = new FakeCodexConnection(options); return peer;
  } });
  const childThreadId = 'restored-active-child';
  const childExecutionId = codexStableChildExecutionId(openInput.executionId, childThreadId);
  const session = await adapter.openSession({
    ...openInput, commandId: 'open-active-child', mode: 'resume',
    nativeSession: { provider: 'codex', providerInstanceId: 'codex-local', sessionId: 'root-active-child' },
    nativeTurnBindings: [{ turnId: 'owner-remux', nativeTurnId: 'owner-native' }],
    nativeChildBindings: [{
      nativeThreadId: childThreadId, executionId: childExecutionId,
      parentExecutionId: openInput.executionId, nativeParentThreadId: 'root-active-child',
      ownerTurnId: 'owner-remux', ownerNativeTurnId: 'owner-native',
      activeNativeTurnId: 'child-native-active',
      nativeTurnBindings: [{ turnId: 'child-remux-active', nativeTurnId: 'child-native-active' }],
    }],
  });
  assert.ok(peer);
  await session.interruptChild!({
    commandId: 'interrupt-restored-child', childExecutionId, nativeSessionId: childThreadId,
    expectedNativeTurnId: 'child-native-active',
  });
  assert.deepEqual(peer.requests.filter(({ method }) => method === 'turn/interrupt').at(-1)?.params, {
    threadId: childThreadId, turnId: 'child-native-active',
  });
  await assert.rejects(() => session.interruptChild!({
    commandId: 'interrupt-old-child', childExecutionId, nativeSessionId: childThreadId,
    expectedNativeTurnId: 'child-native-old',
  }), /no longer matches/u);
  await session.close();
});

test('Codex buffers thread-first children under their spawn turn and routes nested terminals once', async () => {
  let peer: FakeCodexConnection | undefined;
  const adapter = new CodexNativeAdapter({ createConnection: async (options) => {
    peer = new FakeCodexConnection(options); return peer;
  } });
  const session = await adapter.openSession(openInput);
  assert.ok(peer);
  await session.startTurn(turnInputWithText());
  const ownerNativeTurn = 'native-turn-1';
  peer.completeActiveTurn();
  await session.startTurn({ ...turnInputWithText(), commandId: 'turn-command-later', turnId: 'remux-turn-later' });
  peer.emitNotification('turn/started', {
    threadId: 'thread-first-child', turn: { id: 'thread-first-attempt', status: 'inProgress' },
  });
  peer.emitNotification('item/completed', { threadId: 'thread-created-1', turnId: ownerNativeTurn,
    item: { id: 'spawn-thread-first', type: 'subAgentActivity', kind: 'started',
      agentThreadId: 'thread-first-child' } });
  peer.emitNotification('turn/completed', {
    threadId: 'thread-first-child', turn: { id: 'thread-first-attempt', status: 'completed' },
  });
  peer.emitNotification('turn/started', {
    threadId: 'thread-first-child', turn: { id: 'thread-first-followup', status: 'inProgress' },
  });
  peer.emitNotification('turn/started', {
    threadId: 'thread-first-child', turn: { id: 'thread-first-attempt', status: 'inProgress' },
  });
  peer.emitNotification('item/completed', { threadId: 'thread-first-child', turnId: 'thread-first-followup',
    item: { id: 'spawn-grandchild', type: 'subAgentActivity', kind: 'started',
      agentThreadId: 'nested-grandchild' } });
  peer.emitNotification('turn/started', {
    threadId: 'nested-grandchild', turn: { id: 'grandchild-attempt', status: 'inProgress' },
  });
  peer.emitNotification('turn/completed', {
    threadId: 'nested-grandchild', turn: { id: 'grandchild-attempt', status: 'completed' },
  });
  const seen: ProviderEventEnvelope[] = [];
  await collectUntil(session.events, seen, ({ event }) => event.type === 'turn.block.completed' &&
    event.block.payload.kind === 'native-child' &&
    event.block.payload.child.nativeSessionId === 'nested-grandchild');
  const direct = seen.find(({ event }) =>
    (event.type === 'turn.block.started' || event.type === 'turn.block.revised' ||
      event.type === 'turn.block.completed') &&
    event.block.payload.kind === 'native-child' &&
    event.block.payload.child.nativeSessionId === 'thread-first-child');
  assert.equal(direct?.scope.kind, 'turn');
  if (direct?.scope.kind === 'turn') assert.equal(direct.scope.turnId, 'remux-turn-1');
  const nestedTerminal = seen.filter(({ event }) => event.type === 'turn.block.completed' &&
    event.block.payload.kind === 'native-child' &&
    event.block.payload.child.nativeSessionId === 'nested-grandchild');
  assert.equal(nestedTerminal.length, 1);
  assert.equal(nestedTerminal[0]?.scope.kind, 'turn');
  if (nestedTerminal[0]?.scope.kind === 'turn') {
    assert.equal(nestedTerminal[0].scope.executionId,
      codexStableChildExecutionId(openInput.executionId, 'thread-first-child'));
  }
  await session.interruptChild!({ commandId: 'interrupt-followup-child',
    childExecutionId: codexStableChildExecutionId(openInput.executionId, 'thread-first-child'),
    nativeSessionId: 'thread-first-child' });
  assert.deepEqual(peer.requests.filter(({ method }) => method === 'turn/interrupt').at(-1)?.params, {
    threadId: 'thread-first-child', turnId: 'thread-first-followup',
  });
  await session.close();
});

test('Codex pending child admission is aggregate-bounded and triggers authoritative recovery', async () => {
  let peer: FakeCodexConnection | undefined;
  const adapter = new CodexNativeAdapter({ createConnection: async (options) => {
    peer = new FakeCodexConnection(options); return peer;
  } });
  const session = await adapter.openSession(openInput);
  assert.ok(peer);
  for (let index = 0; index <= 256; index += 1) {
    peer.emitNotification('turn/started', {
      threadId: `unknown-child-${index}`, turn: { id: `unknown-turn-${index}` },
    });
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(peer.requests.some(({ method, params }) => method === 'thread/read' &&
    (params as { threadId?: string }).threadId === 'thread-created-1'));
  await session.close();
});

test('Codex authoritative snapshots exclude turns inherited by a fork strand', async () => {
  const adapter = new CodexNativeAdapter({
    createConnection: async (options) => new FakeCodexConnection(options, {
      snapshotTurns: [
        {
          id: 'native-inherited-1',
          status: 'completed',
          items: [
            { id: 'user-inherited', type: 'userMessage', content: [{ type: 'text', text: 'Old.' }] },
            { id: 'assistant-inherited', type: 'agentMessage', phase: 'final_answer', text: 'Old answer.' },
          ],
        },
        {
          id: 'native-local-1',
          status: 'completed',
          items: [
            { id: 'user-local', type: 'userMessage', content: [{ type: 'text', text: 'Edited.' }] },
            { id: 'assistant-local', type: 'agentMessage', phase: 'final_answer', text: 'New answer.' },
          ],
        },
      ],
    }),
  });
  const session = await adapter.openSession({
    ...openInput,
    commandId: 'open-fork-snapshot',
    mode: 'resume',
    nativeSession: {
      provider: 'codex',
      providerInstanceId: 'codex-local',
      sessionId: 'thread-resumed-1',
      resumeCursor: { threadId: 'thread-resumed-1' },
    },
    nativeTurnBindings: [{ turnId: 'remux-local-1', nativeTurnId: 'native-local-1' }],
    inheritedNativeTurnIds: ['native-inherited-1'],
  });
  const snapshot = await session.snapshot({ commandId: 'snapshot-fork-prefix' });
  assert.equal(snapshot.events.some(({ native }) => native.turnId === 'native-inherited-1'), false);
  assert.ok(snapshot.events.some(({ scope, native }) =>
    scope.kind === 'turn' && scope.turnId === 'remux-local-1' && native.turnId === 'native-local-1'));
  await session.close();
});

test('Codex resume restores context usage from the bounded native rollout tail', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'remux-codex-usage-'));
  const rolloutPath = join(directory, 'rollout.jsonl');
  await writeFile(rolloutPath, `${JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: { input_tokens: 800, output_tokens: 100, total_tokens: 900 },
        last_token_usage: { input_tokens: 80, output_tokens: 10, total_tokens: 90 },
        model_context_window: 200,
      },
    },
  })}\n`);
  try {
    const adapter = new CodexNativeAdapter({
      createConnection: async (options) => new FakeCodexConnection(options, {
        rolloutPath,
        snapshotTurns: [{
          id: 'native-turn-1',
          status: 'completed',
          items: [{ id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: 'Review.' }] }],
        }],
      }),
    });
    const session = await adapter.openSession({
      ...openInput,
      commandId: 'open-restored-usage',
      mode: 'resume',
      nativeSession: {
        provider: 'codex',
        providerInstanceId: 'codex-local',
        sessionId: 'thread-restored-usage',
        resumeCursor: { threadId: 'thread-restored-usage' },
      },
      nativeTurnBindings: [{ turnId: 'remux-turn-1', nativeTurnId: 'native-turn-1' }],
    });
    const snapshot = await session.snapshot({ commandId: 'snapshot-restored-usage' });
    const usage = snapshot.events.find(({ event }) => event.type === 'turn.usage-updated');
    assert.equal(usage?.scope.kind, 'turn');
    if (usage?.scope.kind === 'turn') assert.equal(usage.scope.turnId, 'remux-turn-1');
    assert.equal(
      usage?.event.type === 'turn.usage-updated' ? usage.event.usage.context?.percent : null,
      45,
    );
    assert.equal(
      usage?.event.type === 'turn.usage-updated' ? usage.event.usage.context?.freshness : null,
      'cached',
    );
    await session.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Codex snapshots materialize embedded historical images as bounded Remux artifacts', async () => {
  const dataUrl = `data:image/png;base64,${'a'.repeat(400_000)}`;
  let peer: FakeCodexConnection | undefined;
  const imported: string[] = [];
  const importedScopes: Array<{ conversationId: string; executionId: string }> = [];
  const adapter = new CodexNativeAdapter({
    importHistoricalImage: async (scope, value) => {
      importedScopes.push(scope);
      imported.push(value);
      return { artifactId: 'historical-image-1', mimeType: 'image/png', byteLength: 300_000 };
    },
    createConnection: async (options) => {
      peer = new FakeCodexConnection(options, {
        snapshotTurns: [{
          id: 'native-history-turn-1',
          status: 'completed',
          items: [{
            id: 'user-history-1',
            type: 'userMessage',
            content: [
              { type: 'text', text: 'Review this screenshot.' },
              { type: 'image', detail: 'auto', url: dataUrl },
            ],
          }],
        }],
      });
      return peer;
    },
  });
  const session = await adapter.openSession({
    ...openInput,
    commandId: 'open-image-history',
    mode: 'resume',
    nativeSession: {
      provider: 'codex',
      providerInstanceId: 'codex-local',
      sessionId: 'thread-image-history',
    },
  });
  const snapshot = await session.snapshot({ commandId: 'snapshot-image-history' });
  const message = snapshot.events.find(({ event }) => event.type === 'user.message');
  assert.deepEqual(imported, [dataUrl]);
  assert.deepEqual(importedScopes, [{ conversationId: 'conversation-1', executionId: 'execution-1' }]);
  assert.ok(message?.event.type === 'user.message');
  if (message?.event.type === 'user.message') {
    assert.deepEqual(message.event.content, [
      { type: 'text', text: 'Review this screenshot.' },
      {
        type: 'image-artifact',
        artifactId: 'historical-image-1',
        mimeType: 'image/png',
        byteLength: 300_000,
      },
    ]);
  }
  assert.ok(Buffer.byteLength(JSON.stringify(message)) < 256 * 1024);
  await session.close();
});

test('Codex structured input and approvals are resolved without blocking Remux chat', async () => {
  let peer: FakeCodexConnection | undefined;
  const adapter = new CodexNativeAdapter({
    createConnection: async (options) => {
      peer = new FakeCodexConnection(options);
      return peer;
    },
  });
  const session = await adapter.openSession(openInput);
  assert.ok(peer);
  assert.deepEqual(await peer.askServer('item/tool/requestUserInput'), { answers: {} });
  assert.deepEqual(await peer.askServer('item/commandExecution/requestApproval'), {
    decision: 'decline',
  });
  assert.deepEqual(await peer.askServer('item/permissions/requestApproval'), {
    permissions: {},
    scope: 'turn',
    strictAutoReview: true,
  });
  const events = await readCount(session.events, 6);
  assert.equal(events.filter(({ event }) => event.type === 'compatibility.notice').length, 3);
  await session.close();
});

test('Codex native device login preserves subscription auth without exposing tokens', async () => {
  const peers: FakeCodexConnection[] = [];
  const adapter = new CodexNativeAdapter({
    createConnection: async (options) => {
      const peer = new FakeCodexConnection(options);
      peers.push(peer);
      return peer;
    },
  });
  const login = await adapter.startLogin({
    commandId: 'login-command-1',
    providerInstanceId: 'codex-local',
    mode: 'device-code',
  });
  const iterator = login.events[Symbol.asyncIterator]();
  assert.deepEqual((await iterator.next()).value, {
    type: 'prompt',
    loginId: 'login-1',
    verificationUri: 'https://example.test/device',
    userCode: 'ABCD-EFGH',
  });
  peers[0]?.completeLogin(true);
  assert.deepEqual((await iterator.next()).value, { type: 'completed', success: true });
  assert.equal((await iterator.next()).done, true);
  assert.doesNotMatch(JSON.stringify(peers[0]?.requests), /accessToken|refreshToken|bearer/iu);

  assert.deepEqual(await adapter.logout({
    commandId: 'logout-command-1',
    providerInstanceId: 'codex-local',
  }), { accepted: true });
  assert.ok(peers[1]?.requests.some(({ method }) => method === 'account/logout'));
});

test('Codex process loss reports recovery and never invents turn completion', async () => {
  let peer: FakeCodexConnection | undefined;
  const adapter = new CodexNativeAdapter({
    createConnection: async (options) => {
      peer = new FakeCodexConnection(options);
      return peer;
    },
  });
  const session = await adapter.openSession(openInput);
  assert.ok(peer);
  await session.startTurn(turnInputWithText());
  peer.crash(new Error('transport gone'));
  const snapshot = await session.snapshot({ commandId: 'snapshot-after-loss' });
  assert.equal(snapshot.state, 'lost');
  assert.equal(snapshot.authority, 'session-local');
  assert.ok(snapshot.events.some(({ event }) =>
    event.type === 'session.health' && event.state === 'recovering'));
  assert.ok(!snapshot.events.some(({ event }) => event.type === 'turn.completed'));
  await session.close();
});

test('Codex projection failures are isolated from the native turn and later events', async () => {
  let peer: FakeCodexConnection | undefined;
  const adapter = new CodexNativeAdapter({
    createConnection: async (options) => {
      peer = new FakeCodexConnection(options);
      return peer;
    },
  });
  const session = await adapter.openSession(openInput);
  assert.ok(peer);
  const seen: ProviderEventEnvelope[] = [];
  const terminal = collectUntil(session.events, seen, ({ event }) => event.type === 'turn.completed');
  await session.startTurn(turnInputWithText());

  peer.emitNotification('item/started', {
    threadId: 'thread-created-1',
    turnId: 'native-turn-1',
    item: {
      id: 'projection-tool',
      type: 'commandExecution',
      command: 'x'.repeat(9_000),
      cwd: '/workspace/remux',
      status: 'inProgress',
    },
  });
  peer.emitNotification('item/started', {
    threadId: 'thread-created-1',
    turnId: 'native-turn-1',
    item: {
      id: 'projection-tool',
      type: 'commandExecution',
      command: 'printf recovered',
      cwd: '/workspace/remux',
      status: 'inProgress',
    },
  });
  peer.completeActiveTurn();
  await terminal;

  const fitted = seen.find(({ event }) => event.type === 'turn.block.started' &&
    event.block.payload.kind === 'tool' && event.block.payload.tool.callId === 'projection-tool');
  assert.ok(fitted?.event.type === 'turn.block.started');
  if (fitted?.event.type === 'turn.block.started' && fitted.event.block.payload.kind === 'tool') {
    assert.match(fitted.event.block.payload.tool.title ?? '', /truncated/u);
  }
  const recovered = seen.find(({ event }) => event.type === 'turn.block.revised' &&
    event.block.payload.kind === 'tool' && event.block.payload.tool.callId === 'projection-tool');
  assert.ok(recovered?.event.type === 'turn.block.revised');
  if (recovered?.event.type === 'turn.block.revised' && recovered.event.block.payload.kind === 'tool') {
    assert.equal(recovered.event.block.payload.tool.title, 'printf recovered');
  }
  assert.ok(seen.some(({ event }) => event.type === 'turn.completed' && event.outcome === 'completed'));
  assert.equal((await session.snapshot({ commandId: 'snapshot-after-projection-error' })).state, 'idle');
  await session.close();
});

type FakeOptions = {
  autoCompleteTurns?: boolean;
  childSnapshotTurns?: Record<string, unknown[]>;
  emitForkStarted?: boolean;
  rolloutPath?: string;
  snapshotTurns?: unknown[];
  threadReadResponse?: unknown;
};

class FakeCodexConnection implements CodexAppServerConnection {
  readonly requests: Array<{ method: string; params: unknown }> = [];
  readonly notifications: Array<{ method: string; params: unknown }> = [];
  closed = false;

  private readonly launch: CodexAppServerLaunchOptions;
  private readonly autoCompleteTurns: boolean;
  private readonly configuredSnapshotTurns?: unknown[];
  private readonly childSnapshotTurns?: Record<string, unknown[]>;
  private readonly emitForkStarted: boolean;
  private readonly rolloutPath?: string;
  private readonly threadReadResponse?: unknown;
  private threadId = 'thread-created-1';
  private turnCounter = 0;
  private updatedAt = 1_700_000_000;
  private activeNativeTurnId: string | undefined;

  constructor(launch: CodexAppServerLaunchOptions, options: FakeOptions = {}) {
    this.launch = launch;
    this.autoCompleteTurns = options.autoCompleteTurns ?? false;
    this.emitForkStarted = options.emitForkStarted ?? false;
    this.configuredSnapshotTurns = options.snapshotTurns;
    this.childSnapshotTurns = options.childSnapshotTurns;
    this.rolloutPath = options.rolloutPath;
    this.threadReadResponse = options.threadReadResponse;
  }

  async request(method: string, params: unknown): Promise<unknown> {
    this.requests.push({ method, params: structuredClone(params) });
    if (method === 'initialize') return { userAgent: 'codex-cli/0.144.0 test' };
    if (method === 'account/read') return { account: { type: 'chatgpt' }, requiresOpenaiAuth: true };
    if (method === 'account/login/start') {
      return {
        type: 'chatgptDeviceCode',
        loginId: 'login-1',
        verificationUrl: 'https://example.test/device',
        userCode: 'ABCD-EFGH',
      };
    }
    if (method === 'account/login/cancel' || method === 'account/logout') return {};
    if (method === 'model/list') {
      return {
        data: [{
          id: 'catalog-id',
          model: 'gpt-test',
          displayName: 'GPT Test',
          hidden: false,
          isDefault: true,
          serviceTiers: [
            { id: 'default', name: 'Default' },
            { id: 'priority', name: 'Priority', description: 'Faster responses with higher usage' },
          ],
          additionalSpeedTiers: ['fast'],
          supportedReasoningEfforts: [
            { reasoningEffort: 'low' },
            { reasoningEffort: 'high' },
          ],
        }],
        nextCursor: null,
      };
    }
    if (method === 'thread/start') {
      this.threadId = 'thread-created-1';
      return { thread: this.thread([]), cwd: '/workspace/remux', model: 'gpt-test' };
    }
    if (method === 'thread/resume') {
      this.threadId = (params as { threadId: string }).threadId;
      return { thread: this.thread([]), cwd: '/workspace/remux', model: 'gpt-test' };
    }
    if (method === 'turn/start') {
      this.turnCounter += 1;
      this.activeNativeTurnId = `native-turn-${this.turnCounter}`;
      const turn = { id: this.activeNativeTurnId, status: 'inProgress', items: [] };
      this.emit('turn/started', { threadId: this.threadId, turn });
      if (this.autoCompleteTurns) this.completeActiveTurn();
      return { turn };
    }
    if (method === 'turn/steer' || method === 'turn/interrupt') return {};
    if (method === 'thread/compact/start') {
      this.emit('thread/compacted', { threadId: this.threadId, id: 'native-compact-1' });
      return {};
    }
    if (method === 'thread/read') {
      if (this.threadReadResponse !== undefined) return structuredClone(this.threadReadResponse);
      const requestedThreadId = (params as { threadId: string }).threadId;
      const turns = this.childSnapshotTurns?.[requestedThreadId]
        ?? this.configuredSnapshotTurns
        ?? this.snapshotTurns();
      return { thread: this.thread(turns, requestedThreadId) };
    }
    if (method === 'thread/fork') {
      if (this.emitForkStarted) {
        this.emit('thread/started', { thread: { ...this.thread([]), id: 'thread-forked-1' } });
      }
      return { thread: { ...this.thread([]), id: 'thread-forked-1' } };
    }
    if (method === 'thread/list') return { data: [], nextCursor: null };
    throw new Error(`Unexpected fake Codex request ${method}.`);
  }

  notify(method: string, params: unknown) {
    this.notifications.push({ method, params });
  }

  async close() {
    this.closed = true;
  }

  async askServer(method: string) {
    return this.launch.handlers.onServerRequest({ id: 1, method, params: {} });
  }

  completeActiveTurn() {
    const turnId = this.activeNativeTurnId;
    if (!turnId) throw new Error('Fake has no active turn.');
    this.emit('item/completed', {
      threadId: this.threadId,
      turnId,
      item: { id: `assistant-${turnId}`, type: 'agentMessage', phase: 'final_answer', text: 'Implemented.' },
    });
    this.emit('turn/completed', {
      threadId: this.threadId,
      turn: { id: turnId, status: 'completed', error: null, items: [] },
    });
    this.updatedAt += 1;
    this.activeNativeTurnId = undefined;
  }

  startChildTurn(threadId: string, turnId: string) {
    const parentTurnId = this.activeNativeTurnId;
    if (!parentTurnId) throw new Error('Fake has no active parent turn.');
    this.emit('item/completed', {
      threadId: this.threadId,
      turnId: parentTurnId,
      item: {
        id: `spawn-${threadId}`,
        type: 'subAgentActivity',
        kind: 'started',
        agentThreadId: threadId,
        agentPath: `/root/${threadId}`,
      },
    });
    this.emit('turn/started', {
      threadId,
      turn: { id: turnId, status: 'inProgress', items: [] },
    });
  }

  emitNotification(method: string, params: unknown) {
    this.emit(method, params);
  }

  crash(error: Error) {
    this.launch.handlers.onExit(error);
  }

  completeLogin(success: boolean) {
    this.emit('account/login/completed', {
      loginId: 'login-1',
      success,
      error: success ? null : 'Login failed.',
    });
  }

  private emit(method: string, params: unknown) {
    this.launch.handlers.onNotification({ method, params });
  }

  private thread(turns: unknown[], threadId = this.threadId) {
    return {
      id: threadId,
      path: this.rolloutPath ?? null,
      status: { type: this.activeNativeTurnId ? 'active' : 'idle' },
      updatedAt: this.updatedAt,
      turns,
    };
  }

  private snapshotTurns() {
    return Array.from({ length: this.turnCounter }, (_, index) => {
      const id = `native-turn-${index + 1}`;
      return {
        id,
        status: id === this.activeNativeTurnId ? 'inProgress' : 'completed',
        items: [
          { id: `user-${id}`, type: 'userMessage', content: [{ type: 'text', text: 'Implement it.' }] },
          { id: `assistant-${id}`, type: 'agentMessage', phase: 'final_answer', text: 'Implemented.' },
        ],
      };
    });
  }
}

function turnInputWithText(): StartProviderTurnInput {
  return { ...turnInput, content: [{ type: 'text', text: 'Implement it.' }] };
}

async function collectUntil(
  events: AsyncIterable<ProviderEventEnvelope>,
  target: ProviderEventEnvelope[],
  done: (event: ProviderEventEnvelope) => boolean,
) {
  for await (const event of events) {
    target.push(event);
    if (done(event)) return;
  }
  throw new Error('Provider stream closed before the target event.');
}

async function readCount(events: AsyncIterable<ProviderEventEnvelope>, count: number) {
  const result: ProviderEventEnvelope[] = [];
  for await (const event of events) {
    result.push(event);
    if (result.length === count) return result;
  }
  throw new Error('Provider stream closed before enough events were emitted.');
}

test('Codex ownership-free delivery read requires exact frozen thread and client identity', async () => {
  let peer!: FakeCodexConnection;
  const adapter = new CodexNativeAdapter({ createConnection: async (options) => {
    peer = new FakeCodexConnection(options, { snapshotTurns: [{ id: 'native-turn-proof',
      status: 'completed', items: [{ id: 'user-proof', type: 'userMessage',
        clientId: 'native-client-proof', content: [{ type: 'text', text: 'hello' }] }] }] });
    return peer;
  } });
  const present = await adapter.readTurnPresence!({ providerInstanceId: 'codex-local',
    cwd: '/workspace/remux', nativeSessionId: 'thread-proof',
    nativeClientMessageId: 'native-client-proof' });
  assert.equal(present.presence, 'present');
  if (present.presence === 'present') {
    assert.equal(present.evidence.kind, 'codex-history-client-id');
    assert.equal(present.evidence.nativeTurnId, 'native-turn-proof');
  }
  assert.deepEqual(peer.requests.map(({ method }) => method), ['initialize', 'thread/read']);
  assert.equal(peer.closed, true);

  const absent = await adapter.readTurnPresence!({ providerInstanceId: 'codex-local',
    cwd: '/workspace/remux', nativeSessionId: 'thread-proof',
    nativeClientMessageId: 'wrong-client' });
  assert.equal(absent.presence, 'unknown');
  assert.deepEqual(peer.requests.map(({ method }) => method), ['initialize', 'thread/read']);
  assert.equal(peer.closed, true);

  const cases: Array<{ name: string; response: unknown }> = [
    { name: 'wrong thread', response: { thread: { id: 'another-thread', turns: [{
      id: 'native-turn-proof', items: [{ type: 'userMessage', clientId: 'native-client-proof' }],
    }] } } },
    { name: 'missing turns', response: { thread: { id: 'thread-proof' } } },
    { name: 'partial turns', response: { thread: { id: 'thread-proof', turns: 'partial' } } },
    { name: 'empty history', response: { thread: { id: 'thread-proof', turns: [] } } },
    { name: 'missing native turn ID', response: { thread: { id: 'thread-proof', turns: [{
      items: [{ type: 'userMessage', clientId: 'native-client-proof' }],
    }] } } },
  ];
  for (const item of cases) {
    let readPeer!: FakeCodexConnection;
    const readAdapter = new CodexNativeAdapter({ createConnection: async (options) => {
      readPeer = new FakeCodexConnection(options, { threadReadResponse: item.response });
      return readPeer;
    } });
    const result = await readAdapter.readTurnPresence!({ providerInstanceId: 'codex-local',
      cwd: '/workspace/remux', nativeSessionId: 'thread-proof',
      nativeClientMessageId: 'native-client-proof' });
    assert.equal(result.presence, 'unknown', item.name);
    assert.deepEqual(readPeer.requests.map(({ method }) => method), ['initialize', 'thread/read'], item.name);
    assert.equal(readPeer.requests.some(({ method }) =>
      method === 'thread/start' || method === 'thread/resume'), false, item.name);
    assert.equal(readPeer.closed, true, item.name);
  }
});
