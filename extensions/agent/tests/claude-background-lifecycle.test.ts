import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { Options, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeNativeAdapter } from '../server/src/providers/claude/claude-adapter.ts';
import { AsyncEventStream } from '../server/src/provider-adapter.ts';
import { FederationCredentialRegistry } from '../server/src/federation/credential-registry.ts';
import { NativeAgentCoordinator } from '../server/src/native-runtime/native-coordinator.ts';
import { NativeAgentJournal } from '../server/src/native-runtime/native-journal.ts';
import { createNativeAgentSchema } from '../server/src/native-runtime/schema.ts';
import { NativeFixtureAdapter } from '../server/src/native-fixture-adapter.ts';
import { RemuxFederationServer } from '../server/src/federation/mcp-server.ts';
import type { NativeChildBinding, ProviderEventEnvelope } from '../shared/provider-runtime.ts';

class BackgroundQuery extends AsyncEventStream<SDKMessage> {
  prompt!: AsyncIterator<SDKUserMessage>;
  options!: Options;
  connections: unknown[] = [];
  onConnect = () => {};
  async accountInfo() { return { apiProvider: 'firstParty', apiKeySource: 'none', tokenSource: 'oauth', subscriptionType: 'max' }; }
  async setMcpServers(servers: unknown) {
    this.onConnect();
    this.connections.push(servers);
    return { added: ['remux-federation'], removed: [], errors: {} };
  }
  async mcpServerStatus() { return [{ name: 'remux-federation', status: 'connected' }]; }
  async setModel() {}
  async applyFlagSettings() {}
}

async function setup(options: { federation?: { endpoint: string; authorizationHeader: string }; bindings?: NativeChildBinding[] } = {}) {
  const query = new BackgroundQuery();
  const adapter = new ClaudeNativeAdapter({ createQuery: (input) => {
    query.options = input.options!;
    query.prompt = (input.prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();
    return query as unknown as Query;
  } });
  const session = await adapter.openSession({
    commandId: randomUUID(), providerInstanceId: 'claude-local', conversationId: 'background-conversation',
    executionId: 'background-root', cwd: '/tmp', model: 'fable[1m]', access: 'read-only', developerInstructions: [],
    ...(options.bindings ? { mode: 'resume' as const, nativeSession: { provider: 'claude-code' as const,
      providerInstanceId: 'claude-local', sessionId: options.bindings[0]!.nativeParentThreadId }, nativeChildBindings: options.bindings }
      : { mode: 'create' as const }),
    ...(options.bindings ? { nativeTurnBindings: options.bindings.map(b => ({ turnId: b.ownerTurnId, nativeTurnId: b.ownerNativeTurnId })) } : {}),
    ...(options.federation ? { federation: options.federation } : {}),
  });
  const emit = async (message: Record<string, unknown>) => {
    query.emit({ session_id: session.nativeSession.sessionId, uuid: randomUUID(), ...message } as SDKMessage);
    await setImmediate();
  };
  const events = async () => (await session.snapshot({ commandId: randomUUID() })).events;
  const start = async (turnId = 'parent-turn') => {
    const acceptance = session.startTurn({ commandId: randomUUID(), conversationId: 'background-conversation',
      executionId: 'background-root', turnId, content: [{ type: 'text', text: 'Delegate the task.' }] });
    const prompt = await query.prompt.next();
    await emit({ type: 'assistant', parent_tool_use_id: null, user_message_uuid: prompt.value!.uuid,
      message: { id: randomUUID(), role: 'assistant', content: [{ type: 'text', text: 'Starting.' }] } });
    assert.equal((await acceptance).accepted, true);
  };
  const finish = () => emit({ type: 'result', subtype: 'success', is_error: false });
  return { query, session, emit, events, start, finish };
}

function childEvents(events: readonly ProviderEventEnvelope[]) {
  return events.filter(e => 'block' in e.event && e.event.block.kind === 'native-child');
}

async function makeJournal(h: Awaited<ReturnType<typeof setup>>) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  createNativeAgentSchema(db);
  const journal = new NativeAgentJournal(db);
  const probe = await new NativeFixtureAdapter({ provider: 'claude-code' }).probe('claude-local');
  const now = Date.now() - 1000;
  journal.upsertProviderInstance({ providerInstanceId: 'claude-local', provider: 'claude-code', label: 'Claude', probe, now });
  journal.createConversation({ conversationId: 'background-conversation', rootExecutionId: 'background-root', provider: 'claude-code',
    providerInstanceId: 'claude-local', title: 'Background test', cwd: '/tmp', model: 'fable[1m]', access: 'read-only', now });
  journal.bindNativeSession({ executionId: 'background-root', nativeSession: h.session.nativeSession, adapterVersion: 'test', now });
  journal.createTurn({ turnId: 'parent-turn', conversationId: 'background-conversation', executionId: 'background-root',
    clientMessageId: 'initial-message', commandId: 'initial-command', content: [{ type: 'text', text: 'Delegate.' }],
    model: 'fable[1m]', state: 'running', now });
  return journal;
}

test('Claude defers federation MCP connection until the native credential is bound', async () => {
  const registry = new FederationCredentialRegistry();
  const credential = registry.issue({ generation: 'g', conversationId: 'background-conversation', executionId: 'background-root',
    provider: 'claude-code', providerInstanceId: 'claude-local', access: 'read-only', depth: 0, tools: [], targetCatalog: [] });
  const h = await setup({ federation: { endpoint: 'http://127.0.0.1:1/mcp', authorizationHeader: `Bearer ${credential.token}` } });
  try {
    assert.equal(Boolean(h.query.options.mcpServers?.['remux-federation']), false);
    h.query.onConnect = () => assert.equal(registry.resolve(credential.token, 'g').nativeSessionId, h.session.nativeSession.sessionId);
    credential.bindNativeSession(h.session.nativeSession);
    await h.session.connectFederation();
    assert.equal(h.query.connections.length, 1);
  } finally { credential.revoke(); await h.session.close(); }
});

test('Claude records child progress and completion after the parent result on the original turn', async () => {
  const h = await setup();
  try {
    await h.start();
    await h.emit({ type: 'system', subtype: 'task_started', task_id: 'child', task_type: 'local_agent', description: 'Implementation' });
    await h.finish();
    await h.emit({ type: 'system', subtype: 'task_progress', task_id: 'child', summary: 'Testing' });
    await h.start('new-parent-turn');
    await h.emit({ type: 'system', subtype: 'task_notification', task_id: 'child', status: 'completed', summary: 'Done' });
    const children = childEvents(await h.events());
    const last = children.at(-1)!;
    assert.equal(last.scope.kind === 'turn' && last.scope.turnId, 'parent-turn');
    assert.equal('block' in last.event && last.event.block.state, 'completed');
    assert.ok(children.some(e => 'block' in e.event && e.event.block.payload.kind === 'native-child' && e.event.block.payload.summary === 'Testing'));
  } finally { await h.session.close(); }
});

test('Claude live background membership protects an idle parent and excludes ambient tasks', async () => {
  const h = await setup();
  try {
    await h.start();
    await h.finish();
    await h.emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'shell', task_type: 'local_bash', description: 'Build' }] });
    assert.equal(h.session.hasBackgroundWork(), true);
    await h.emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'watcher', task_type: 'local_bash', ambient: true }] });
    assert.equal(h.session.hasBackgroundWork(), false);
  } finally { await h.session.close(); }
});

test('Claude represents autonomous root output as a new native turn and ignores child text', async () => {
  const h = await setup();
  const journal = await makeJournal(h);
  try {
    await h.start();
    await h.finish();
    await h.emit({ type: 'assistant', parent_tool_use_id: 'child-tool', message: { id: 'child-message', content: [{ type: 'text', text: 'Private child work' }] } });
    const before = (await h.events()).length;
    await h.emit({ type: 'assistant', parent_tool_use_id: null, user_message_uuid: 'native-follow-up',
      message: { id: 'follow-up-message', content: [{ type: 'text', text: 'The child finished; validating now.' }] } });
    await h.finish();
    const following = (await h.events()).slice(before);
    assert.ok(following.some(e => e.event.type === 'turn.started' && e.event.origin === 'native'));
    assert.ok(following.some(e => e.event.type === 'turn.completed'));
    assert.ok(following.every(e => e.scope.kind !== 'turn' || e.scope.turnId !== 'parent-turn'));
    journal.appendProviderEvents(await h.events());
    const turns = journal.turnsForExecution('background-root');
    assert.equal(turns.length, 2);
    assert.ok(turns.every(t => t.state === 'completed'));
    assert.ok(turns.every(t => t.pathEntryId));
    assert.equal(journal.conversation('background-conversation')?.state, 'idle');
    journal.appendProviderEvents(await h.events());
    assert.equal(journal.turnsForExecution('background-root').length, 2);
  } finally { await h.session.close(); journal.close(); }
});

test('Claude restores child identity and reconciles unfinished children when their process restarts', async () => {
  const first = await setup();
  const journal = await makeJournal(first);
  let binding: NativeChildBinding;
  try {
    await first.start();
    await first.emit({ type: 'system', subtype: 'task_started', task_id: 'child', task_type: 'local_agent', description: 'Implementation' });
    const event = childEvents(await first.events()).at(-1)!;
    assert.ok(event.scope.kind === 'turn' && 'block' in event.event && event.event.block.payload.kind === 'native-child');
    binding = { nativeThreadId: 'child', executionId: event.event.block.payload.child.executionId, parentExecutionId: 'background-root',
      nativeParentThreadId: first.session.nativeSession.sessionId, ownerTurnId: event.scope.turnId, ownerNativeTurnId: event.native.turnId!,
      canonicalBlock: { structure: event.event.structure, revision: 0, block: event.event.block } };
    await first.finish();
    journal.appendProviderEvents(await first.events());
  } finally { await first.session.close(); }
  const resumed = await setup({ bindings: [binding!] });
  try {
    const last = childEvents(await resumed.events()).at(-1)!;
    assert.ok(last && 'block' in last.event && last.event.block.payload.kind === 'native-child');
    assert.equal(last.event.block.payload.outcome, 'interrupted');
    assert.equal(last.event.structure.blockId, binding!.canonicalBlock!.structure.blockId);
    journal.appendProviderEvents(await resumed.events());
    assert.equal(journal.execution(binding!.executionId)?.outcome, 'interrupted');
    await resumed.emit({ type: 'system', subtype: 'task_started', task_id: 'child', task_type: 'local_agent', description: 'Resumed implementation' });
    journal.appendProviderEvents(await resumed.events());
    assert.equal(journal.execution(binding!.executionId)?.state, 'running');
    assert.equal(journal.execution(binding!.executionId)?.outcome, undefined);
    await resumed.emit({ type: 'system', subtype: 'task_notification', task_id: 'child', status: 'completed', summary: 'Finished' });
    const completed = childEvents(await resumed.events()).at(-1)!;
    assert.ok('block' in completed.event && completed.event.block.payload.kind === 'native-child');
    assert.equal(completed.event.block.payload.outcome, 'completed');
    journal.appendProviderEvents(await resumed.events());
    assert.equal(journal.execution(binding!.executionId)?.outcome, 'completed');
  } finally { await resumed.session.close(); journal.close(); }
});

test('Claude process loss settles running child cards while the parent is idle', async () => {
  const h = await setup();
  try {
    await h.start();
    await h.emit({ type: 'system', subtype: 'task_started', task_id: 'child', task_type: 'local_agent' });
    await h.finish();
    h.query.close();
    await setImmediate();
    const last = childEvents(await h.events()).at(-1)!;
    assert.ok('block' in last.event && last.event.block.payload.kind === 'native-child');
    assert.equal(last.event.block.payload.outcome, 'interrupted');
    assert.equal(h.session.hasBackgroundWork(), false);
  } finally { await h.session.close(); }
});

test('coordinator binds both journal and credential before the Claude MCP handshake', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  createNativeAgentSchema(db);
  const journal = new NativeAgentJournal(db);
  const credentials = new FederationCredentialRegistry();
  const fixture = new NativeFixtureAdapter({ provider: 'claude-code' });
  const responses: number[] = [];
  const query = new BackgroundQuery();
  const adapter = new ClaudeNativeAdapter({ createQuery: input => {
    assert.equal(Boolean(input.options?.mcpServers?.['remux-federation']), false);
    query.options = input.options!;
    query.prompt = (input.prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();
    return query as unknown as Query;
  } });
  query.setMcpServers = async (servers: unknown) => {
    const config = (servers as Record<string, { url: string; headers: Record<string, string> }>)['remux-federation']!;
    const response = await fetch(config.url, { method: 'POST', headers: { ...config.headers,
      'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {},
        clientInfo: { name: 'test', version: '1' } } }) });
    responses.push(response.status);
    await response.text();
    return { added: ['remux-federation'], removed: [], errors: {} };
  };
  let coordinator!: NativeAgentCoordinator;
  const federation = new RemuxFederationServer({ journal, credentials, coordinator: () => coordinator,
    generation: () => coordinator.projector.serverGeneration });
  coordinator = new NativeAgentCoordinator({ journal, providers: [{ providerInstanceId: 'claude-local', provider: 'claude-code',
    label: 'Claude', adapter: { probe: fixture.probe.bind(fixture), listModels: fixture.listModels.bind(fixture),
      openSession: adapter.openSession.bind(adapter) } }], federationForSession: async input => federation.issueForSession(input) });
  try {
    await federation.start();
    await coordinator.initialize();
    await coordinator.createConversation({ commandId: 'create-auth-test', providerInstanceId: 'claude-local', cwd: '/tmp',
      model: 'fixture-native-v1', access: 'read-only' });
    assert.deepEqual(responses, [200]);
  } finally { await coordinator.close(); await federation.close(); journal.close(); }
});

test('idle eviction and passive history release preserve provider background work', async () => {
  let closed = false;
  let busy = true;
  const session = { close: async () => { closed = true; }, hasBackgroundWork: () => busy };
  const conversation = { conversationId: 'conversation', rootExecutionId: 'parent', activeTurnId: null };
  const coordinator = Object.assign(Object.create(NativeAgentCoordinator.prototype), {
    closed: false, sessions: new Map([['parent', session]]), now: () => 700001,
    sessionLastUsedAt: new Map([['parent', 100000]]), hydrationJobs: new Map(), openingSessions: new Map(), federationBindings: new Map(),
    journal: { execution: () => ({ executionId: 'parent', conversationId: 'conversation', state: 'idle' }),
      conversation: () => conversation, queuedEntries: () => [],
      latestCompactionOperation: () => undefined, pendingCompactionOperation: () => undefined,
      childExecutions: () => [] }, publishDiagnostic: () => {},
  });
  await coordinator.evictIdleSessions();
  assert.equal(closed, false);
  await coordinator.releasePassiveHistorySession(conversation, session);
  assert.equal(closed, false);
  busy = false;
  await coordinator.evictIdleSessions();
  assert.equal(closed, true);
});
