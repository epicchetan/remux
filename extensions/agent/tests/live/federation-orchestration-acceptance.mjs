// Opt-in integration acceptance: one real Claude subscription session and a gated
// fake Codex child, through the production coordinator and HTTP federation bridge.
// Run from the repository root with the Remux workload wrapper.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeNativeAdapter } from '../../server/src/providers/claude/claude-adapter.ts';
import { NativeFixtureAdapter } from '../../server/src/native-fixture-adapter.ts';
import { ProviderEventStream } from '../../server/src/provider-adapter.ts';
import { NativeAgentCoordinator } from '../../server/src/native-runtime/native-coordinator.ts';
import { NativeAgentJournal } from '../../server/src/native-runtime/native-journal.ts';
import { createNativeAgentSchema } from '../../server/src/native-runtime/schema.ts';
import { RemuxFederationServer } from '../../server/src/federation/mcp-server.ts';
import { FederationCredentialRegistry } from '../../server/src/federation/credential-registry.ts';
import { CLAUDE_MCP_AUTO_BACKGROUND_MS } from '../../server/src/federation/constants.ts';
import { PROVIDER_RUNTIME_CONTRACT_VERSION } from '../../shared/provider-runtime.ts';

const cwd = await mkdtemp('/tmp/remux-federation-acceptance-');
const model = process.env.REMUX_FEDERATION_ACCEPTANCE_MODEL ?? 'sonnet';
const log = (stage, detail = {}) => console.log(JSON.stringify({ stage, ...detail }));
let release;
const gate = new Promise(resolve => { release = resolve; });
let childStarted = false;
let notificationCount = 0;
let backgroundTaskCount = 0;
const native = new ClaudeNativeAdapter({ acceptanceTimeoutMs: 45_000,
  createQuery: ({ prompt, options }) => {
    assert.equal(options.env.CLAUDE_AUTO_BACKGROUND_TASKS, '1');
    assert.equal(options.env.CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS, String(CLAUDE_MCP_AUTO_BACKGROUND_MS));
    const nativeQuery = query({ prompt, options: { ...options,
      pathToClaudeCodeExecutable: '/home/ubuntu/.local/bin/claude', persistSession: false,
      settingSources: [], strictMcpConfig: true,
      settings: { disableAllHooks: true, autoCompactEnabled: false, precomputeCompactionEnabled: false }, hooks: {},
      systemPrompt: { type: 'preset', preset: 'claude_code', append:
        'Isolated federation acceptance. Use only the supplied Remux federation tools. Do not read or write files, use skills, shell, or network. Spawn exactly one child when asked. If its MCP call backgrounds, reply WAITING and end your turn. Never poll. Reply USER_ACK to the intervening user. When the child completion arrives, reply CONTINUED ASTRA_DONE and end.' },
    } });
    return new Proxy(nativeQuery, { get(target, key) {
      if (key === Symbol.asyncIterator) return async function* () {
        for await (const message of target) {
          if (message.type === 'system' && message.subtype === 'task_started' && message.task_type === 'mcp_task') {
            backgroundTaskCount++;
            log('mcp-backgrounded', { taskId: message.task_id, toolUseId: message.tool_use_id });
          }
          if (message.type === 'system' && message.subtype === 'task_notification') {
            notificationCount++;
            log('native-task-notification', { taskId: message.task_id, toolUseId: message.tool_use_id, status: message.status });
          }
          yield message;
        }
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  },
});
const fixture = new NativeFixtureAdapter({ provider: 'codex' });
const fakeChild = {
  probe: id => fixture.probe(id), listModels: id => fixture.listModels(id),
  async openSession(opened) {
    const events = new ProviderEventStream();
    const nativeSession = { provider: 'codex', providerInstanceId: opened.providerInstanceId, sessionId: randomUUID() };
    const history = [];
    let state = 'idle';
    let closed = false;
    let sequence = 0;
    const emit = (event, turnId) => {
      const envelope = { contractVersion: PROVIDER_RUNTIME_CONTRACT_VERSION, eventId: randomUUID(), provider: 'codex',
        scope: { kind: turnId ? 'turn' : 'execution', providerInstanceId: opened.providerInstanceId,
          conversationId: opened.conversationId, executionId: opened.executionId, ...(turnId ? { turnId } : {}) },
        native: { sessionId: nativeSession.sessionId, ...(turnId ? { turnId } : {}), kind: `acceptance/${event.type}`,
          position: { kind: 'native-sequence', sequence: ++sequence, subIndex: 0 } }, observedAt: Date.now(), event };
      history.push(envelope); events.emit(envelope);
    };
    emit({ type: 'session.bound', resumed: false });
    emit({ type: 'session.materialized' });
    return { nativeSession, events,
      async startTurn(input, boundary) {
        assert.equal(childStarted, false, 'Only one gated child may start');
        boundary?.markPossiblySent(nativeSession.sessionId, 'acceptance-child');
        childStarted = true; state = 'running';
        emit({ type: 'turn.started' }, input.turnId);
        void gate.then(() => {
          if (closed) return;
          const block = { kind: 'final-message', state: 'completed', payload: { kind: 'final-message', text: 'ASTRA_DONE' } };
          emit({ type: 'turn.block.completed', structure: { passId: 'child-pass', blockId: 'child-answer', passOrdinal: 0, blockOrdinal: 0 },
            revision: 1, contentHash: createHash('sha256').update(JSON.stringify(block)).digest('hex'), block }, input.turnId);
          state = 'idle'; emit({ type: 'turn.completed', outcome: 'completed' }, input.turnId);
        });
        return { accepted: true, outcome: 'accepted', nativeTurnId: input.turnId,
          evidence: { kind: 'codex-turn-start-response', threadId: nativeSession.sessionId,
            turnId: input.turnId, nativeClientMessageId: input.turnId } };
      },
      async interrupt(input) { state = 'idle'; emit({ type: 'turn.completed', outcome: 'interrupted' }, input.turnId); return { accepted: true }; },
      async snapshot() { return { contractVersion: PROVIDER_RUNTIME_CONTRACT_VERSION, nativeSession,
        state, authority: 'session-local', events: structuredClone(history), nextNativeSequence: sequence + 1 }; },
      async close() { closed = true; events.close(); },
    };
  },
};
const database = new DatabaseSync(':memory:');
database.exec('PRAGMA foreign_keys=ON'); createNativeAgentSchema(database);
const journal = new NativeAgentJournal(database);
let coordinator;
const federation = new RemuxFederationServer({ journal, credentials: new FederationCredentialRegistry(),
  coordinator: () => coordinator, generation: () => coordinator.projector.serverGeneration });
coordinator = new NativeAgentCoordinator({ journal,
  checkoutResolver: async path => ({ state: 'resolved', value: { checkoutKey: `acceptance:${path}`, launchCwd: path } }),
  federationForSession: input => federation.issueForSession(input),
  providers: [{ providerInstanceId: 'claude-local', provider: 'claude-code', label: 'Claude', adapter: {
    probe: id => native.probe(id),
    listModels: async () => [{ id: model, name: model, provider: 'claude-code', supportedEffort: ['low'], isDefault: true }],
    openSession: input => native.openSession(input),
  } }, { providerInstanceId: 'codex-gated', provider: 'codex', label: 'Astra', adapter: fakeChild }],
});
let conversationId;
let expired = false;
const deadline = setTimeout(() => { expired = true; release(); void coordinator.close(); }, 180_000);
const until = async (predicate, label, timeout = 90_000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end && !expired) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${label}`);
};
const send = (id, text) => {
  const runtime = coordinator.projector.runtimeResource(conversationId);
  return coordinator.sendMessage({ commandId: id, clientMessageId: `client-${id}`, conversationId,
    providerInstanceId: runtime.providerInstanceId, model: runtime.composer.nextTurn.model,
    effort: runtime.composer.nextTurn.effort, serviceTier: runtime.composer.nextTurn.serviceTier,
    access: runtime.composer.nextTurn.access, configurationRevision: runtime.composer.revision,
    delivery: 'auto', content: [{ type: 'text', text }] });
};
try {
  await federation.start(); await coordinator.initialize();
  ({ conversationId } = await coordinator.createConversation({ commandId: 'create-federation-acceptance',
    providerInstanceId: 'claude-local', cwd, model, effort: 'low', access: 'read-only' }));
  const first = await send('spawn-live', 'Call remux_spawn_agent exactly once: target providerInstanceId codex-gated, task "Astra", access read-only, scheduling foreground. The host gates this child. If the call backgrounds reply WAITING and finish. Do not call remux_wait_agent or poll.');
  await until(() => childStarted, 'gated child start');
  await until(() => !journal.conversation(conversationId).activeTurnId, 'parent idle while child runs');
  const child = journal.executionsForConversation(conversationId).find(execution => execution.ownership === 'federated');
  assert.ok(child); assert.equal(child.state, 'running'); assert.equal(backgroundTaskCount, 1);
  log('parent-idle-child-running', { parentTurnId: first.turnId, childExecutionId: child.executionId });
  const user = await send('user-during-wait', 'Reply USER_ACK now and finish. Leave the existing child running. Do not call tools.');
  await until(() => journal.turn(user.turnId)?.state === 'completed' && !journal.conversation(conversationId).activeTurnId,
    'intervening user turn completed');
  assert.equal(journal.execution(child.executionId).state, 'running');
  assert.match(coordinator.projector.project(`agent/turn:${user.turnId}`).assistantText, /USER_ACK/);
  log('user-turn-completed-child-running', { userTurnId: user.turnId });
  release();
  await until(() => journal.turns(conversationId).some(turn => turn.origin === 'federation-notification' && turn.state === 'completed'),
    'autonomous federation continuation');
  const continuations = journal.turns(conversationId).filter(turn => turn.origin === 'federation-notification');
  assert.equal(continuations.length, 1); assert.equal(notificationCount, 1);
  assert.equal(continuations[0].trigger?.kind, 'federation');
  assert.deepEqual(continuations[0].userContent, []);
  const projected = coordinator.projector.project(`agent/turn:${continuations[0].turnId}`);
  assert.equal(projected.inputItems[0].type, 'notice');
  assert.match(projected.assistantText, /ASTRA_DONE/);
  const completed = journal.orderedPasses(first.turnId).flatMap(pass => pass.blocks)
    .find(block => block.kind === 'federated-child' && block.payload.child.executionId === child.executionId);
  assert.equal(completed?.state, 'completed');
  assert.equal(journal.queuedMessages(conversationId).length, 0);
  log('PASS', { continuationTurnId: continuations[0].turnId, origin: continuations[0].origin,
    trigger: continuations[0].trigger, continuationCount: continuations.length,
    spawningTurnId: first.turnId, childRowState: completed.state, backgroundTaskCount, notificationCount });
} catch (error) {
  log('FAIL', { error: error instanceof Error ? error.stack : String(error),
    ...(conversationId ? { turns: journal.turns(conversationId).map(turn => ({ turnId: turn.turnId, state: turn.state, origin: turn.origin })) } : {}) });
  process.exitCode = 1;
} finally {
  clearTimeout(deadline); release();
  await coordinator.close(); await federation.close(); journal.close();
  await rm(cwd, { recursive: true, force: true });
}
