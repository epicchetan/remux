import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, writeFile, appendFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { query } from '../../node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs';
import { ClaudeNativeAdapter } from '../../server/src/providers/claude/claude-adapter.ts';
import { CodexNativeAdapter } from '../../server/src/providers/codex/codex-adapter.ts';
import { NativeAgentCoordinator } from '../../server/src/native-runtime/native-coordinator.ts';
import { NativeAgentJournal } from '../../server/src/native-runtime/native-journal.ts';
import { createNativeAgentSchema } from '../../server/src/native-runtime/schema.ts';
import { FederationCredentialRegistry } from '../../server/src/federation/credential-registry.ts';
import { RemuxFederationServer } from '../../server/src/federation/mcp-server.ts';
const directory = await mkdtemp('/tmp/remux-claude-live-');
console.log('Smoke directory:', directory);
await writeFile(`${directory}/CLAUDE.md`, 'This directory is an isolated integration smoke test. Follow the test prompt exactly. Do not inspect other projects, use skills, or modify any files.\n');
const database = new DatabaseSync(`${directory}/journal.sqlite3`);
database.exec('PRAGMA foreign_keys = ON'); createNativeAgentSchema(database);
const journal = new NativeAgentJournal(database);
let offset = 0;
const now = () => Date.now() + offset;
const claude = new ClaudeNativeAdapter({ now, createQuery: input => {
  const q = query(input);
  return new Proxy(q, { get(target, key) {
    if (key === Symbol.asyncIterator) return async function* () {
      for await (const message of target) {
        const { type, subtype, task_id, task_type, state, status, user_message_uuid, parent_tool_use_id, uuid } = message;
        if (type !== 'stream_event' || message.event?.type === 'message_start') {
          await appendFile(`${directory}/native-events.jsonl`, JSON.stringify({ at: new Date().toISOString(), type, subtype, task_id, task_type, state, status,
            user_message_uuid, parent_tool_use_id, uuid, result: type === 'result' ? message.result : undefined }) + '\n');
        }
        yield message;
      }
    };
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
} });
const codex = new CodexNativeAdapter();
const provider = (adapter, id, kind) => ({ providerInstanceId: id, provider: kind, label: kind,
  adapter: { probe: adapter.probe.bind(adapter), listModels: adapter.listModels.bind(adapter), openSession: adapter.openSession.bind(adapter) } });
const credentials = new FederationCredentialRegistry();
let coordinator;
const federation = new RemuxFederationServer({ journal, credentials, coordinator: () => coordinator,
  generation: () => coordinator.projector.serverGeneration });
coordinator = new NativeAgentCoordinator({ journal, now, providers: [provider(claude, 'claude-local', 'claude-code'), provider(codex, 'codex-local', 'codex')],
  federationForSession: async input => federation.issueForSession(input),
  onDiagnostic: event => { if (event.status === 'failed') console.log('DIAGNOSTIC', JSON.stringify(event)); } });
const waitUntil = async (predicate, timeout = 120000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 250)); }
  throw new Error('Live smoke condition timed out');
};
const send = async (id, text) => {
  const runtime = coordinator.projector.runtimeResource(id);
  return coordinator.sendMessage({ commandId: randomUUID(), conversationId: id, clientMessageId: randomUUID(), content: [{ type: 'text', text }],
    providerInstanceId: runtime.providerInstanceId, model: runtime.composer.nextTurn.model, effort: runtime.composer.nextTurn.effort,
    access: runtime.composer.nextTurn.access, configurationRevision: runtime.composer.revision, delivery: 'auto' });
};
try {
  await federation.start(); await coordinator.initialize();
  console.log('Initialized providers');
  const targets = coordinator.federationTargetCatalog('claude-code');
  const target = targets.find(t => t.provider === 'codex');
  assert.ok(target);
  const model = target.models.find(m => /astra/i.test(m.id + m.name)) ?? target.models.find(m => m.isDefault) ?? target.models[0];
  console.log('GPT smoke target:', model.id);
  const created = await coordinator.createConversation({ commandId: randomUUID(), providerInstanceId: 'claude-local', cwd: directory,
    model: 'fable[1m]', effort: 'low', access: 'full-access' });
  const id = created.conversationId;
  const root = journal.conversation(id).rootExecutionId;
  console.log('Created isolated Claude conversation:', id);
  const first = await send(id, `Run an integration smoke test. Use remux federation to spawn exactly one read-only foreground agent on provider codex-local, model ${model.id}, effort low, with this task: "Reply exactly GPT_FEDERATION_OK. Do not use tools, read files, or create subagents." When it returns, reply with its answer. Do not do any other work.`);
  await waitUntil(() => Boolean(journal.turn(first.turnId)?.outcome));
  const children = journal.childExecutions(root).filter(c => c.ownership === 'federated');
  assert.equal(children.length, 1, 'Claude must actually spawn GPT');
  assert.equal(children[0].outcome, 'completed');
  console.log('PASS: Claude -> GPT federation completed');
  const second = await send(id, 'Run a native background-agent lifecycle smoke test. Use the native Agent tool to launch exactly one general-purpose background subagent (run_in_background true), model haiku. Its only task: run Bash command `sleep 20`, then reply exactly NATIVE_CHILD_OK; do not read or write files or use any other tools. Immediately after launching it, finish your own reply with exactly CHILD_LAUNCHED; do not wait or poll. When its completion notification later arrives, reply exactly BACKGROUND_FOLLOWUP_OK. Do not launch more agents.');
  await waitUntil(() => Boolean(journal.turn(second.turnId)?.outcome));
  const native = journal.childExecutions(root).find(c => c.ownership === 'native');
  assert.ok(native, 'Native background child must be visible');
  assert.equal(native.state, 'running', 'Child must still be running after parent finishes');
  const parentSession = coordinator.sessions.get(root);
  offset += 11 * 60 * 1000;
  await coordinator.evictIdleSessions();
  assert.equal(coordinator.sessions.get(root), parentSession, 'Parent must survive expired idle TTL');
  console.log('PASS: running native child protects parent past idle TTL (advanced clock)');
  await waitUntil(() => journal.execution(native.executionId)?.outcome === 'completed');
  await waitUntil(() => journal.turnsForExecution(root).some(t => t.commandId.startsWith('native-followup') && t.outcome === 'completed'));
  console.log('PASS: native child completion and autonomous parent follow-up persisted');
  console.log('Turns:', JSON.stringify(journal.turnsForExecution(root).map(t => ({ id: t.turnId, state: t.state, commandId: t.commandId }))));
} finally {
  await coordinator.close(); await federation.close(); journal.close();
}
