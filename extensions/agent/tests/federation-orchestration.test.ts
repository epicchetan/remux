import type { Query as ClaudeQuery, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { FakeClaudeQuery } from './fixtures/fake-claude-query.ts';
import { ClaudeNativeAdapter } from '../server/src/providers/claude/claude-adapter.ts';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { federationToolDescriptions } from '../server/src/federation/mcp-server.ts';
import type { FederationCredentialScope } from '../server/src/federation/credential-registry.ts';
import { NativeFixtureAdapter } from '../server/src/native-fixture-adapter.ts';
import { NativeAgentCoordinator } from '../server/src/native-runtime/native-coordinator.ts';
import { NativeAgentJournal, type JournalConversation } from '../server/src/native-runtime/native-journal.ts';
import { NATIVE_AGENT_SCHEMA_VERSION, createNativeAgentSchema, migrateNativeAgentSchema, validateNativeAgentSchema } from '../server/src/native-runtime/schema.ts';
import { PROVIDER_RUNTIME_CONTRACT_VERSION, type ProviderEvent, type ProviderKind } from '../shared/provider-runtime.ts';

function journalFixture(provider: ProviderKind = 'claude-code') {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys=ON');
  createNativeAgentSchema(database);
  const journal = new NativeAgentJournal(database);
  journal.upsertProviderInstance({ providerInstanceId: 'parent-provider', provider, label: 'Parent', probe: { state: 'missing' }, now: 1 });
  journal.upsertProviderInstance({ providerInstanceId: 'child-provider', provider: 'codex', label: 'Child', probe: { state: 'missing' }, now: 1 });
  journal.createConversation({ conversationId: 'chat', rootExecutionId: 'parent', provider,
    providerInstanceId: 'parent-provider', title: 'Parent', cwd: '/tmp', model: 'fixture-native-v1',
    access: 'read-only', now: 1 });
  journal.createTurn({ turnId: 'spawn-turn', conversationId: 'chat', executionId: 'parent',
    clientMessageId: 'user', commandId: 'send', content: [{ type: 'text', text: 'Delegate' }],
    model: 'fixture-native-v1', state: 'running', now: 2 });
  return journal;
}
function control(coordinator: NativeAgentCoordinator) {
  return coordinator as unknown as {
    foregroundFederationBusy(conversation: JournalConversation): boolean;
    finalizeFederatedExecution(executionId: string): void;
  };
}
function child(journal: NativeAgentJournal, scheduling: 'foreground' | 'background') {
  journal.createFederatedExecution({ executionId: 'child', conversationId: 'chat', parentExecutionId: 'parent',
    rootTurnId: 'spawn-turn', provider: 'codex', providerInstanceId: 'child-provider', model: 'fixture-native-v1',
    access: 'read-only', scheduling, depth: 1, title: 'Astra', now: 3 });
  journal.createTurn({ turnId: 'child-turn', conversationId: 'chat', executionId: 'child',
    clientMessageId: 'child-input', commandId: 'spawn', content: [{ type: 'text', text: 'Implement' }],
    model: 'fixture-native-v1', state: 'running', now: 4 });
}
async function seedProviders(journal: NativeAgentJournal, provider: ProviderKind = 'claude-code') {
  for (const [id, kind] of [['parent-provider', provider], ['child-provider', 'codex']] as const) {
    const fixture = new NativeFixtureAdapter({ provider: kind });
    journal.upsertProviderInstance({ providerInstanceId: id, provider: kind, label: id,
      probe: await fixture.probe(id), now: 1 });
  }
}
function finish(journal: NativeAgentJournal, executionId: string, turnId: string) {
  const execution = journal.execution(executionId)!;
  const event: ProviderEvent = { type: 'turn.completed', outcome: 'completed' };
  journal.appendProviderEvent({ contractVersion: PROVIDER_RUNTIME_CONTRACT_VERSION, eventId: `end-${turnId}`,
    provider: execution.provider, scope: { kind: 'turn', providerInstanceId: execution.providerInstanceId,
      conversationId: 'chat', executionId, turnId }, native: { sessionId: `native-${executionId}`, kind: 'test/completed' },
    observedAt: 30, event });
}

async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('Provider observation did not settle');
}

async function openFederationParent() {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys=ON'); createNativeAgentSchema(database);
  const journal = new NativeAgentJournal(database);
  const query = new FakeClaudeQuery();
  let prompt: AsyncIterable<SDKUserMessage> | undefined;
  const claude = new ClaudeNativeAdapter({ acceptanceTimeoutMs: 1_000, now: () => 100,
    createQuery: input => {
      prompt = input.prompt as AsyncIterable<SDKUserMessage>;
      query.emit({ type: 'system', subtype: 'init', uuid: 'parent-init', session_id: input.options?.sessionId });
      return query as unknown as ClaudeQuery;
    } });
  const fixture = new NativeFixtureAdapter({ provider: 'claude-code' });
  const coordinator = new NativeAgentCoordinator({ journal, now: () => 100, providers: [{
    providerInstanceId: 'claude-local', provider: 'claude-code', label: 'Claude', adapter: {
      probe: async id => { const probe = await fixture.probe(id); return { ...probe,
        capabilities: { ...probe.capabilities!, turns: { ...probe.capabilities!.turns,
          steer: false, activeInput: 'stream-input' as const } } }; },
      listModels: id => fixture.listModels(id), openSession: input => claude.openSession(input),
    },
  }] });
  await coordinator.initialize();
  const { conversationId } = await coordinator.createConversation({ commandId: 'create',
    providerInstanceId: 'claude-local', cwd: '/tmp', model: 'fixture-native-v1', access: 'read-only' });
  const send = (id: string, delivery: 'auto' | 'steer' = 'auto') => {
    const runtime = coordinator.projector.runtimeResource(conversationId)!;
    return coordinator.sendMessage({ commandId: id, clientMessageId: `client-${id}`, conversationId,
      providerInstanceId: runtime.providerInstanceId, model: runtime.composer.nextTurn.model,
      effort: runtime.composer.nextTurn.effort, serviceTier: runtime.composer.nextTurn.serviceTier,
      access: runtime.composer.nextTurn.access, configurationRevision: runtime.composer.revision,
      delivery, content: [{ type: 'text', text: id }] });
  };
  const pending = send('root');
  await until(() => Boolean(prompt));
  const iterator = prompt![Symbol.asyncIterator]();
  const input = (await iterator.next()).value!;
  const executionId = journal.conversation(conversationId)!.rootExecutionId;
  const sessionId = journal.nativeSession(executionId)!.sessionId;
  const emit = (value: Record<string, unknown>) => query.emit({ session_id: sessionId, ...value });
  emit({ type: 'assistant', uuid: 'parent-tool', parent_tool_use_id: null, user_message_uuid: input.uuid,
    message: { id: 'parent-message', role: 'assistant', content: [{ type: 'tool_use', id: 'wait-call',
      name: 'mcp__remux-federation__remux_wait_agent', input: { executionId: 'child' } }] } });
  const root = await pending;
  const busy = () => control(coordinator).foregroundFederationBusy(journal.conversation(conversationId)!);
  await until(busy);
  return { coordinator, journal, query, iterator, conversationId, executionId, sessionId, root, send, emit, busy };
}

for (const transition of ['backgrounded', 'completed'] as const) {
  test(`federation guard releases and dispatches active input on observed ${transition} without clock advance`, async () => {
    const parent = await openFederationParent();
    const { coordinator, journal, query, iterator, conversationId, send, emit, busy, root } = parent;
    try {
      assert.equal(busy(), true);
      assert.equal((await send('followup')).delivery, 'queued');
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(journal.database.prepare("SELECT 1 FROM delivery_attempts WHERE command_id='followup'").get(), undefined);
      if (transition === 'backgrounded') emit({ type: 'system', subtype: 'task_started', uuid: 'background-observation',
        task_id: 'mcp-task', tool_use_id: 'wait-call', task_type: 'mcp_task' });
      else emit({ type: 'user', uuid: 'result-observation', parent_tool_use_id: null,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'wait-call',
          content: JSON.stringify({ executionId: 'child', status: 'completed' }) }] } });
      await until(() => !busy());
      await until(() => Boolean(journal.database.prepare("SELECT 1 FROM delivery_attempts WHERE command_id='followup'").get()));
      const followup = (await iterator.next()).value!;
      emit({ type: 'user', uuid: followup.uuid, parent_tool_use_id: null, isReplay: true, isSynthetic: false,
        message: { role: 'user', content: 'followup' } });
      await until(() => journal.queuedMessages(conversationId).length === 0);
      assert.equal(journal.additionalTurnMessages(root.turnId)[0]?.clientMessageId, 'client-followup');
      assert.equal(journal.conversation(conversationId)?.activeTurnId, root.turnId);
      assert.deepEqual(query.backgroundedTools, [], 'MCP calls must be backgrounded only by Claude Code');
    } finally { await coordinator.close(); journal.close(); }
  });
}

for (const reason of ['federation-wait', 'steer-unavailable'] as const) {
  test(`explicit steer reports ${reason} when queued and preserves it on receipt replay`, async () => {
    const { coordinator, journal, conversationId, send, emit, busy } = await openFederationParent();
    try {
      if (reason === 'steer-unavailable') {
        emit({ type: 'user', uuid: 'wait-complete', parent_tool_use_id: null,
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'wait-call', content: '{}' }] } });
        await until(() => !busy());
      }
      const result = await send('explicit-steer', 'steer');
      assert.equal(result.delivery, 'queued');
      assert.equal(result.reason, reason);
      assert.equal(journal.queuedMessages(conversationId)[0]?.deliveryIntent, 'queue');
      const receipt = coordinator.readCommand({ commandId: 'explicit-steer', kind: 'turn.send' });
      assert.ok(receipt.state === 'accepted' && receipt.kind === 'turn.send');
      assert.equal(receipt.result.reason, reason);
    } finally { await coordinator.close(); journal.close(); }
  });
}

test('federation guard is false for missing sessions, absent observations and non-Claude providers', async () => {
  for (const provider of ['claude-code', 'codex'] as const) {
    const journal = journalFixture(provider);
    const coordinator = new NativeAgentCoordinator({ journal, providers: [] });
    try {
      const sessions = (coordinator as unknown as { sessions: Map<string, unknown> }).sessions;
      const busy = () => control(coordinator).foregroundFederationBusy(journal.conversation('chat')!);
      assert.equal(busy(), false);
      sessions.set('parent', { close: async () => undefined });
      assert.equal(busy(), false);
      sessions.set('parent', { blockedOnForegroundFederation: () => true, close: async () => undefined });
      assert.equal(busy(), provider === 'claude-code');
    } finally { await coordinator.close(); journal.close(); }
  }
});

test('Claude federation descriptions explain automatic backgrounding; Codex descriptions retain blocking wording', () => {
  const scope = { provider: 'claude-code', targetCatalog: [] } as unknown as FederationCredentialScope;
  const claude = federationToolDescriptions(scope);
  const codex = federationToolDescriptions({ ...scope, provider: 'codex' });
  for (const name of ['spawn', 'send', 'wait'] as const) {
    assert.match(claude[name], /about 10 seconds/);
    assert.match(claude[name], /do not poll/);
    assert.doesNotMatch(codex[name], /Claude Code|about 10 seconds|do not poll/);
  }
  assert.match(codex.spawn, /foreground waits until the child is idle/);
});

for (const mode of ['lost', 'live', 'background-unwatched', 'background-waited', 'codex'] as const) {
  test(`terminal federation ${mode} notification preserves the spawning row and enqueues at most once`, async () => {
    const provider = mode === 'codex' ? 'codex' : 'claude-code';
    const journal = journalFixture(provider);
    await seedProviders(journal, provider);
    child(journal, mode.startsWith('background') ? 'background' : 'foreground');
    const coordinator = new NativeAgentCoordinator({ journal, providers: [], now: () => 40 });
    try {
      let live: ReturnType<NativeAgentCoordinator['waitForFederatedExecution']> | undefined;
      if (mode === 'live') live = coordinator.waitForFederatedExecution('child');
      if (mode === 'background-waited') {
        const controller = new AbortController();
        const cancelled = coordinator.waitForFederatedExecution('child', controller.signal);
        controller.abort();
        await assert.rejects(cancelled, /cancelled/);
      }
      finish(journal, 'child', 'child-turn');
      control(coordinator).finalizeFederatedExecution('child');
      if (live) assert.equal((await live).status, 'completed');
      control(coordinator).finalizeFederatedExecution('child');
      const queued = journal.queuedMessages('chat');
      assert.equal(queued.length, mode === 'lost' || mode === 'background-waited' ? 1 : 0);
      if (queued.length) {
        assert.equal(queued[0]!.origin, 'federation-notification');
        assert.equal(queued[0]!.deliveryIntent, 'auto');
        assert.equal(queued[0]!.trigger?.childExecutionId, 'child');
        assert.match(JSON.stringify(queued[0]!.content), /Federated child child \(child-provider\) completed:/);
        assert.equal(queued[0]!.model, 'fixture-native-v1');
      }
      assert.equal(journal.orderedPasses('spawn-turn').flatMap(pass => pass.blocks)
        .find(block => block.kind === 'federated-child')?.state, 'completed');
      assert.equal((await coordinator.waitForFederatedExecution('child')).status, 'completed');
    } finally { await coordinator.close(); journal.close(); }
  });
}

test('restart after watcher loss retains exactly one origin-tagged continuation', async () => {
  const journal = journalFixture();
  await seedProviders(journal);
  child(journal, 'foreground');
  const before = new NativeAgentCoordinator({ journal, providers: [] });
  const controller = new AbortController();
  const wait = before.waitForFederatedExecution('child', controller.signal);
  controller.abort();
  await assert.rejects(wait, /cancelled/);
  await before.close();
  const after = new NativeAgentCoordinator({ journal, providers: [], now: () => 40 });
  try {
    finish(journal, 'parent', 'spawn-turn');
    finish(journal, 'child', 'child-turn');
    control(after).finalizeFederatedExecution('child');
    const queued = journal.claimQueuedTurn('chat', 41)!;
    journal.admitQueuedTurn(queued.turnId, 42);
    assert.equal(journal.turn(queued.turnId)?.origin, 'federation-notification');
    assert.deepEqual(journal.turn(queued.turnId)?.trigger, { kind: 'federation', childExecutionId: 'child', summary: '' });
    control(after).finalizeFederatedExecution('child');
    assert.equal(journal.queuedMessages('chat').length, 0);
    assert.equal(journal.turns('chat').filter(turn => turn.origin === 'federation-notification').length, 1);
  } finally { await after.close(); journal.close(); }
});

test('schema 19 migrates to the current version while ordinary existing turns default to user', () => {
  const journal = journalFixture();
  try {
    for (const table of ['turns', 'queued_messages', 'turn_inputs']) {
      journal.database.exec(`ALTER TABLE ${table} DROP COLUMN origin; ALTER TABLE ${table} DROP COLUMN trigger_json;`);
    }
    journal.database.exec('ALTER TABLE executions DROP COLUMN federation_waited; ALTER TABLE executions DROP COLUMN federation_notified_turn_id; PRAGMA user_version=19;');
    migrateNativeAgentSchema(journal.database, 19);
    validateNativeAgentSchema(journal.database);
    assert.equal(journal.database.prepare('PRAGMA user_version').get()?.user_version, NATIVE_AGENT_SCHEMA_VERSION);
    assert.equal(journal.turn('spawn-turn')?.origin, 'user');
    assert.equal(journal.turn('spawn-turn')?.trigger, undefined);
    assert.equal(journal.turn('spawn-turn')?.userContent[0]?.type, 'text');
  } finally { journal.close(); }
});
