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
  assert.equal(probe.capabilities?.collaboration.childTranscript, 'none');
  assert.equal(probe.capabilities?.collaboration.childInterrupt, true);
  assert.equal(probe.capabilities?.session.rollbackNative, false);

  const models = await adapter.listModels('codex-local');
  assert.deepEqual(models, [{
    id: 'gpt-test',
    name: 'GPT Test',
    provider: 'codex',
    supportedEffort: ['low', 'high'],
    isDefault: true,
  }]);
  assert.equal(peers.length, 2);
  assert.ok(peers.every((peer) => peer.closed));
});

test('Codex session launch scopes federation credentials and dispatches each turn command once', async () => {
  let peer: FakeCodexConnection | undefined;
  let launch: CodexAppServerLaunchOptions | undefined;
  const adapter = new CodexNativeAdapter({
    environment: {
      REMUX_TEST_ENV: 'yes',
      REMUX_FEDERATION_MCP_BEARER_TOKEN: 'ambient-must-not-leak',
    },
    appServerArgs: ['-c', 'features.example=true'],
    resolveImageArtifact: async (artifactId) => ({
      type: 'localImage',
      path: `/server-artifacts/${artifactId}.png`,
    }),
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
  assert.deepEqual(await session.startTurn(turnInput), { accepted: true });
  assert.deepEqual(await session.startTurn(structuredClone(turnInput)), { accepted: true });
  await terminal;

  const starts = peer.requests.filter(({ method }) => method === 'turn/start');
  assert.equal(starts.length, 1);
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
    content: [{ type: 'text', text: 'Follow up.' }],
  });
  assert.equal(peer.requests.filter(({ method }) => method === 'turn/start').length, 2);
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
    threadId: 'child-thread-1',
    turnId: 'child-turn-1',
  });
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
  const adapter = new CodexNativeAdapter({
    importHistoricalImage: async (value) => {
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

  const recovered = seen.find(({ event }) => event.type === 'turn.block.started' &&
    event.block.payload.kind === 'tool' && event.block.payload.tool.callId === 'projection-tool');
  assert.ok(recovered?.event.type === 'turn.block.started');
  if (recovered?.event.type === 'turn.block.started' && recovered.event.block.payload.kind === 'tool') {
    assert.equal(recovered.event.block.payload.tool.title, 'printf recovered');
  }
  assert.ok(seen.some(({ event }) => event.type === 'turn.completed' && event.outcome === 'completed'));
  assert.equal((await session.snapshot({ commandId: 'snapshot-after-projection-error' })).state, 'idle');
  await session.close();
});

type FakeOptions = {
  autoCompleteTurns?: boolean;
  emitForkStarted?: boolean;
  rolloutPath?: string;
  snapshotTurns?: unknown[];
};

class FakeCodexConnection implements CodexAppServerConnection {
  readonly requests: Array<{ method: string; params: unknown }> = [];
  readonly notifications: Array<{ method: string; params: unknown }> = [];
  closed = false;

  private readonly launch: CodexAppServerLaunchOptions;
  private readonly autoCompleteTurns: boolean;
  private readonly configuredSnapshotTurns?: unknown[];
  private readonly emitForkStarted: boolean;
  private readonly rolloutPath?: string;
  private threadId = 'thread-created-1';
  private turnCounter = 0;
  private updatedAt = 1_700_000_000;
  private activeNativeTurnId: string | undefined;

  constructor(launch: CodexAppServerLaunchOptions, options: FakeOptions = {}) {
    this.launch = launch;
    this.autoCompleteTurns = options.autoCompleteTurns ?? false;
    this.emitForkStarted = options.emitForkStarted ?? false;
    this.configuredSnapshotTurns = options.snapshotTurns;
    this.rolloutPath = options.rolloutPath;
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
      return { thread: this.thread(this.configuredSnapshotTurns ?? this.snapshotTurns()) };
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

  private thread(turns: unknown[]) {
    return {
      id: this.threadId,
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
