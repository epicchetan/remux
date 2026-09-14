import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { NativeFixtureAdapter } from '../server/src/native-fixture-adapter.ts';
import { DeliveryAttemptOwner } from '../server/src/native-runtime/delivery-attempt-owner.ts';
import { NativeAgentCoordinator } from '../server/src/native-runtime/native-coordinator.ts';
import { NativeAgentJournal } from '../server/src/native-runtime/native-journal.ts';
import { createNativeAgentSchema } from '../server/src/native-runtime/schema.ts';
import { PROVIDER_RUNTIME_CONTRACT_VERSION, type ProviderEventEnvelope } from '../shared/provider-runtime.ts';

async function fixture() {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys=ON');
  createNativeAgentSchema(database);
  const journal = new NativeAgentJournal(database);
  const adapter = new NativeFixtureAdapter({ provider: 'claude-code', manualCompaction: true });
  journal.upsertProviderInstance({ providerInstanceId: 'claude-local', provider: 'claude-code',
    label: 'Claude', probe: await adapter.probe('claude-local'), now: 100 });
  journal.createConversation({ conversationId: 'conversation', rootExecutionId: 'execution',
    provider: 'claude-code', providerInstanceId: 'claude-local', title: 'Compact', cwd: '/workspace/remux',
    model: 'fixture-native-v1', access: 'read-only', now: 100 });
  journal.bindNativeSession({ executionId: 'execution', nativeSession: { provider: 'claude-code',
    providerInstanceId: 'claude-local', sessionId: 'session' }, adapterVersion: 'test', now: 100 });
  journal.claimCommand('command', 'conversation.compact', { commandId: 'command', conversationId: 'conversation' }, 100);
  journal.createManualCompaction({ operationId: 'operation', commandId: 'command', conversationId: 'conversation', state: 'running', now: 100 });
  journal.markCommandDispatching('command', 100);
  const owner = new DeliveryAttemptOwner(journal, () => 200, 'old-owner');
  const attempt = owner.prepare({ commandId: 'command', kind: 'manual-compact', provider: 'claude-code',
    providerInstanceId: 'claude-local', conversationId: 'conversation', executionId: 'execution',
    compactOperationId: 'operation', nativeClientMessageId: 'input', nativeSessionId: 'session',
    recoveryPayload: { operationId: 'operation', nativeInputUuid: 'input' }, ownerInstanceId: 'old-owner', now: 100 });
  await owner.dispatch(attempt.attemptId, async (boundary) => {
    boundary.markPossiblySent('session', 'process');
    return { accepted: false, outcome: 'unknown', crossing: { phase: 'possibly-sent', detail: 'response-lost' },
      error: { code: 'claude_compact_acceptance_timeout', message: 'Timed out.' } };
  }, () => assert.fail('Unexpected admission'));
  const boundary: ProviderEventEnvelope = {
    contractVersion: PROVIDER_RUNTIME_CONTRACT_VERSION, eventId: 'late-boundary', provider: 'claude-code',
    scope: { kind: 'conversation', providerInstanceId: 'claude-local', conversationId: 'conversation', executionId: 'execution' },
    native: { sessionId: 'session', messageId: 'boundary-uuid', kind: 'system/compact_boundary',
      position: { kind: 'native-sequence', sequence: 10, subIndex: 0 } },
    observedAt: 300, event: { type: 'context.compaction.completed', trigger: 'manual', operationId: 'operation',
      beforeTokens: 211664, afterTokens: 9454 },
  };
  return { journal, adapter, owner, attempt, boundary };
}

test('restart repairs a timed-out Claude Compact from its staged boundary without opening or resending', async () => {
  const { journal, adapter, owner, attempt, boundary } = await fixture();
  const coordinator = new NativeAgentCoordinator({ journal, providers: [{ providerInstanceId: 'claude-local',
    provider: 'claude-code', label: 'Claude', adapter }] });
  try {
    owner.observe(attempt.attemptId, boundary);
    journal.appendProviderEvent(boundary); // History already projected success, as in the incident.
    assert.equal(journal.compactionOperation('operation')?.state, 'completed');
    assert.equal(journal.hasUnresolvedRootDelivery('conversation'), true);
    await coordinator.initialize();
    assert.equal(journal.hasUnresolvedRootDelivery('conversation'), false);
    assert.equal(owner.get(attempt.attemptId)?.state, 'accepted');
    assert.equal(journal.commandReceipt('command')?.state, 'accepted');
    assert.equal(journal.compactionOperation('operation')?.state, 'completed');
    assert.equal(owner.staged(attempt.attemptId).length, 0);
    assert.equal(adapter.opened.length, 0);
    assert.equal(owner.recoverCompactionEvidence(attempt.attemptId), false, 'repair is idempotent');
  } finally { await coordinator.close(); journal.close(); }
});

for (const mismatch of ['operation', 'automatic', 'old', 'missing-uuid', 'snapshot', 'gap', 'projection-only'] as const) {
  test(`Claude Compact recovery refuses ${mismatch} evidence`, async () => {
    const { journal, owner, attempt, boundary } = await fixture();
    try {
      if (boundary.event.type !== 'context.compaction.completed') assert.fail();
      if (mismatch === 'operation') boundary.event.operationId = 'other-operation';
      if (mismatch === 'automatic') boundary.event.trigger = 'automatic';
      if (mismatch === 'old') boundary.observedAt = 150;
      if (mismatch === 'missing-uuid') delete boundary.native.messageId;
      if (mismatch === 'snapshot') boundary.native.kind = 'history/compact_boundary';
      if (mismatch === 'operation') assert.throws(() => owner.observe(attempt.attemptId, boundary), /frozen operation/u);
      else if (mismatch === 'projection-only') journal.appendProviderEvent(boundary);
      else owner.observe(attempt.attemptId, boundary);
      if (mismatch === 'gap') owner.markStreamGap('execution', 'process', 'lost stream');
      assert.equal(owner.recoverCompactionEvidence(attempt.attemptId), false);
      assert.equal(owner.get(attempt.attemptId)?.acceptanceEvidence, undefined);
      assert.equal(journal.hasUnresolvedRootDelivery('conversation'), true);
    } finally { journal.close(); }
  });
}
