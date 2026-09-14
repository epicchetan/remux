import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DeliveryAttemptOwner } from '../server/src/native-runtime/delivery-attempt-owner.ts';
import { NativeAgentJournal } from '../server/src/native-runtime/native-journal.ts';
import { createNativeAgentSchema, migrateNativeAgentSchema, NATIVE_AGENT_SCHEMA_VERSION } from '../server/src/native-runtime/schema.ts';
import { NativeFixtureAdapter } from '../server/src/native-fixture-adapter.ts';
import { CodexRequestError } from '../server/src/providers/codex/codex-app-server-connection.ts';
import { CODEX_ACTIVE_COMPACT_REJECTION } from '../server/src/providers/codex/codex-delivery-rejection.ts';
import { PROVIDER_RUNTIME_CONTRACT_VERSION, type ProviderEventEnvelope } from '../shared/provider-runtime.ts';

async function fixture(now = 100, database = new DatabaseSync(':memory:'), provider: 'fixture' | 'codex' | 'claude-code' = 'fixture') {
  database.exec('PRAGMA foreign_keys=ON');
  createNativeAgentSchema(database);
  const journal = new NativeAgentJournal(database);
  const adapter = new NativeFixtureAdapter();
  journal.upsertProviderInstance({ providerInstanceId: 'fixture-local', provider,
    label: 'Fixture', probe: await adapter.probe('fixture-local'), now });
  journal.createConversation({ conversationId: 'conversation-1', rootExecutionId: 'execution-1',
    provider, providerInstanceId: 'fixture-local', title: 'Delivery', cwd: '/workspace/remux',
    model: 'fixture-native-v1', access: 'workspace-write', now });
  journal.bindNativeSession({ executionId: 'execution-1', nativeSession: { provider,
    providerInstanceId: 'fixture-local', sessionId: 'fixture-session-1' }, adapterVersion: 'fixture-1', now });
  const request = { commandId: 'command-1', conversationId: 'conversation-1' };
  journal.claimCommand('command-1', 'turn.send', request, now);
  journal.enqueueTurn({ commandId: 'command-1', conversationId: 'conversation-1', turnId: 'turn-1',
    clientMessageId: 'viewer-message-1', content: [{ type: 'text', text: 'hello' }],
    model: 'fixture-native-v1', access: 'workspace-write', now });
  journal.acceptCommand('command-1', { accepted: true, commandId: 'command-1', turnId: 'turn-1' }, now);
  journal.claimQueuedTurn('conversation-1', now);
  const owner = new DeliveryAttemptOwner(journal, () => now - 50, 'owner-1');
  const attempt = journal.transaction(() => owner.prepare({ attemptId: 'attempt-1', commandId: 'command-1',
    kind: 'root-turn', provider, providerInstanceId: 'fixture-local',
    conversationId: 'conversation-1', executionId: 'execution-1', intendedTurnId: 'turn-1',
    clientMessageId: 'viewer-message-1', nativeClientMessageId: 'turn-1',
    recoveryPayload: { turnId: 'turn-1', clientMessageId: 'viewer-message-1',
      nativeClientMessageId: 'turn-1', content: [{ type: 'text', text: 'hello' }],
      model: 'fixture-native-v1', access: 'workspace-write' }, nativeSessionId: 'fixture-session-1',
    ownerInstanceId: 'owner-1', now }));
  return { database, journal, owner, attempt };
}

function envelope(eventId: string, observedAt = 25, text = 'hello'): ProviderEventEnvelope {
  return {
    contractVersion: PROVIDER_RUNTIME_CONTRACT_VERSION,
    eventId,
    provider: 'fixture',
    scope: { kind: 'turn', providerInstanceId: 'fixture-local', conversationId: 'conversation-1',
      executionId: 'execution-1', turnId: 'turn-1' },
    native: { sessionId: 'fixture-session-1', kind: 'fixture/test' },
    observedAt,
    event: { type: 'user.message', content: [{ type: 'text', text }] },
  };
}

function finalEnvelope(eventId: string, observedAt: number, text: string): ProviderEventEnvelope {
  return { ...envelope(eventId, observedAt), event: { type: 'turn.block.started',
    structure: { passId: 'pass-large', blockId: `block-${eventId}`, passOrdinal: 0, blockOrdinal: 0 },
    block: { kind: 'final-message', state: 'streaming', payload: { kind: 'final-message', text } } } };
}

const proof = { kind: 'fixture-correlated-acceptance' as const, sessionId: 'fixture-session-1',
  commandId: 'command-1', nativeTurnId: 'turn-1' };

test('delivery owner persists proof and stage across atomic admission rollback, then admits once', async () => {
  const { journal, owner, attempt } = await fixture();
  try {
    owner.observe(attempt.attemptId, envelope('observation-1'));
    let secondCrossError: unknown;
    await assert.rejects(owner.dispatch(attempt.attemptId, async (boundary) => {
      boundary.markPossiblySent('fixture-session-1', 'generation-1');
      try { boundary.markPossiblySent('fixture-session-1', 'generation-1'); } catch (error) { secondCrossError = error; }
      return { accepted: true, outcome: 'accepted', evidence: proof, nativeTurnId: 'turn-1' };
    }, () => {
      journal.admitQueuedTurn('turn-1', 100, 'turn-1');
      throw new Error('injected admission fault');
    }), /injected admission fault/u);
    assert.match(String(secondCrossError), /only be used once/u);
    assert.equal(journal.turn('turn-1'), undefined);
    assert.equal(owner.get(attempt.attemptId)?.state, 'dispatching');
    assert.deepEqual(owner.get(attempt.attemptId)?.acceptanceEvidence, proof);
    assert.equal(owner.staged(attempt.attemptId).length, 1);
    let admissions = 0;
    await owner.reconcile(attempt.attemptId, async () => ({ presence: 'unknown', reason: 'unused' }),
      (accepted, staged) => {
        admissions += 1;
        const admitted = journal.admitQueuedTurn(accepted.intendedTurnId!, 100, accepted.nativeTurnId);
        journal.appendProviderEvents(staged.map(({ envelope: event }) => event));
        return admitted;
      });
    await owner.reconcile(attempt.attemptId, async () => ({ presence: 'unknown', reason: 'unused' }),
      () => { admissions += 1; });
    assert.equal(admissions, 1);
    assert.equal(owner.get(attempt.attemptId)?.state, 'accepted');
    assert.equal(owner.staged(attempt.attemptId).length, 0);
    assert.ok(journal.turn('turn-1'));
    const eventCount = journal.database.prepare(
      `SELECT count(*) count FROM events WHERE event_id='observation-1'`,
    ).get() as { count: number };
    assert.equal(eventCount.count, 1);
    const row = journal.database.prepare(`SELECT created_at,updated_at,crossed_at,accepted_at
      FROM delivery_attempts WHERE attempt_id='attempt-1'`).get() as Record<string, number>;
    assert.ok(row.updated_at >= row.created_at && row.crossed_at >= row.created_at && row.accepted_at >= row.created_at);
    assert.equal(owner.staged(attempt.attemptId).find(() => true), undefined);
  } finally { journal.close(); }
});

test('file-backed proof and stage survive close after admission rollback and recover exactly once', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'remux-delivery-owner-reopen-'));
  const path = join(directory, 'agent.sqlite3');
  const first = await fixture(100, new DatabaseSync(path));
  try {
    first.owner.observe(first.attempt.attemptId, envelope('durable-observation'));
    await assert.rejects(first.owner.dispatch(first.attempt.attemptId, async (boundary) => {
      boundary.markPossiblySent('fixture-session-1', 'generation-1');
      return { accepted: true, outcome: 'accepted', evidence: proof, nativeTurnId: 'turn-1' };
    }, (accepted) => {
      first.journal.admitQueuedTurn(accepted.intendedTurnId!, 100, accepted.nativeTurnId);
      throw new Error('file-backed admission fault');
    }), /file-backed admission fault/u);
  } finally { first.journal.close(); }

  const reopenedJournal = new NativeAgentJournal(new DatabaseSync(path));
  const reopenedOwner = new DeliveryAttemptOwner(reopenedJournal, () => 200, 'recovery-owner');
  let providerReads = 0;
  let admissions = 0;
  try {
    assert.equal(reopenedJournal.turn('turn-1'), undefined);
    assert.equal((reopenedJournal.database.prepare(`SELECT count(*) count FROM events
      WHERE event_id='durable-observation'`).get() as { count: number }).count, 0);
    assert.deepEqual(reopenedOwner.get('attempt-1')?.acceptanceEvidence, proof);
    assert.deepEqual(reopenedOwner.staged('attempt-1').map(({ observationId }) => observationId),
      ['durable-observation']);
    await reopenedOwner.reconcile('attempt-1', async () => {
      providerReads += 1;
      return { presence: 'unknown', reason: 'durable proof makes this unnecessary' };
    }, (accepted, staged) => {
      admissions += 1;
      reopenedJournal.admitQueuedTurn(accepted.intendedTurnId!, 200, accepted.nativeTurnId);
      reopenedJournal.appendProviderEvents(staged.map(({ envelope: event }) => event));
    });
    await reopenedOwner.reconcile('attempt-1', async () => {
      providerReads += 1;
      return { presence: 'unknown', reason: 'must not run' };
    }, () => { admissions += 1; });
    assert.equal(providerReads, 0);
    assert.equal(admissions, 1);
    assert.equal(reopenedOwner.get('attempt-1')?.state, 'accepted');
    assert.equal(reopenedOwner.staged('attempt-1').length, 0);
    assert.ok(reopenedJournal.turn('turn-1'));
    assert.equal((reopenedJournal.database.prepare(`SELECT count(*) count FROM events
      WHERE event_id='durable-observation'`).get() as { count: number }).count, 1);
  } finally {
    reopenedJournal.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('preparing attempts are owner-fenced and crossed rejection remains unknown', async () => {
  const { journal, owner, attempt } = await fixture();
  try {
    const recovered = new DeliveryAttemptOwner(journal, () => 101, 'owner-2');
    recovered.recover();
    assert.equal(recovered.get(attempt.attemptId)?.state, 'preparing');
    let foreignInvoked = false;
    await assert.rejects(recovered.dispatch(attempt.attemptId, async () => {
      foreignInvoked = true;
      return { accepted: false, outcome: 'unknown', crossing: {
        phase: 'possibly-sent', detail: 'response-lost' },
        error: { code: 'foreign', message: 'must not run' } };
    }, () => undefined), /another owner/u);
    assert.equal(foreignInvoked, false);
    assert.throws(() => recovered.prepare({ commandId: 'command-1', kind: 'root-turn', provider: 'fixture',
      providerInstanceId: 'fixture-local', conversationId: 'conversation-1', executionId: 'execution-1',
      intendedTurnId: 'turn-1', clientMessageId: 'viewer-message-1', nativeClientMessageId: 'changed',
      recoveryPayload: {}, nativeSessionId: 'fixture-session-1', ownerInstanceId: 'owner-2', now: 101 }),
    /payload identities|different immutable/u);
    const result = await owner.dispatch(attempt.attemptId, async (boundary) => {
      boundary.markPossiblySent('fixture-session-1', 'generation-1');
      return { accepted: false, outcome: 'rejected',
        crossing: { phase: 'not-sent', detail: 'preparation' },
        error: { code: 'late_rejection', message: 'invalid late rejection' } };
    }, () => undefined);
    assert.equal(result.outcome, 'unknown');
    assert.equal(owner.get(attempt.attemptId)?.state, 'unknown');
  } finally { journal.close(); }
});

test('a typed possibly-sent throw without a durable marker retains the lane and diagnostic', async () => {
  const { journal, owner, attempt } = await fixture();
  try {
    const result = await owner.dispatch(attempt.attemptId, async () => {
      throw new CodexRequestError({ phase: 'possibly-sent', method: 'turn/start', requestId: 17,
        message: 'transport response was lost' });
    }, () => assert.fail('possibly-sent delivery must not admit without positive proof'));
    assert.equal(result.outcome, 'unknown');
    assert.equal(owner.get(attempt.attemptId)?.state, 'unknown');
    assert.ok(owner.get(attempt.attemptId)?.crossedAt !== undefined);
    const row = journal.database.prepare(`SELECT recovery_json,rejection_json
      FROM delivery_attempts WHERE attempt_id=?`).get(attempt.attemptId) as {
        recovery_json: string; rejection_json: string | null;
      };
    assert.equal(row.rejection_json, null);
    assert.equal(JSON.parse(row.recovery_json).boundary_violation,
      'thrown-possibly-sent-without-marker');
  } finally { journal.close(); }
});

test('corrupt durable evidence is rejected before recovery read or admission callbacks', async () => {
  const { journal, owner, attempt } = await fixture();
  try {
    await owner.dispatch(attempt.attemptId, async (boundary) => {
      boundary.markPossiblySent('fixture-session-1', 'generation-1');
      return { accepted: false, outcome: 'unknown', crossing: {
        phase: 'possibly-sent', detail: 'response-lost' },
        error: { code: 'lost', message: 'lost' } };
    }, () => undefined);
    journal.database.prepare(`UPDATE delivery_attempts SET acceptance_evidence_json=?
      WHERE attempt_id=?`).run(JSON.stringify({ ...proof, commandId: 7, extra: true }), attempt.attemptId);
    let readCalls = 0;
    let admissionCalls = 0;
    await assert.rejects(owner.reconcile(attempt.attemptId, async () => {
      readCalls += 1;
      return { presence: 'unknown', reason: 'must not run' };
    }, () => { admissionCalls += 1; }), /missing or unsupported|bounded string/u);
    assert.equal(readCalls, 0);
    assert.equal(admissionCalls, 0);
    assert.equal(journal.database.prepare(`SELECT state FROM delivery_attempts WHERE attempt_id=?`)
      .get(attempt.attemptId)?.state, 'unknown');
  } finally { journal.close(); }
});

test('staging deduplicates identities and marks aggregate overflow without erasing proof', async () => {
  const { journal, owner, attempt } = await fixture();
  try {
    await owner.dispatch(attempt.attemptId, async (boundary) => {
      boundary.markPossiblySent('fixture-session-1', 'generation-1');
      return { accepted: false, outcome: 'unknown', crossing: { phase: 'possibly-sent', detail: 'response-lost' },
        error: { code: 'lost', message: 'lost' } };
    }, () => undefined);
    owner.recordAcceptance(attempt.attemptId, proof, 'turn-1');
    assert.deepEqual(owner.observe(attempt.attemptId, envelope('same')), { staged: true });
    assert.deepEqual(owner.observe(attempt.attemptId, envelope('same')), { staged: false, duplicate: true });
    const large = 'x'.repeat(7 * 1024 * 1024);
    for (let index = 1; index <= 9; index += 1) {
      owner.observe(attempt.attemptId, finalEnvelope(`large-${index}`, index, large));
    }
    const overflow = owner.observe(attempt.attemptId, finalEnvelope('large-10', 10, large));
    assert.deepEqual(overflow, { staged: false, overflow: true });
    assert.equal(owner.get(attempt.attemptId)?.transcriptGap, true);
    assert.deepEqual(owner.get(attempt.attemptId)?.acceptanceEvidence, proof);
    const firstObserved = journal.database.prepare(`SELECT observed_at FROM delivery_attempt_staging
      WHERE attempt_id=? ORDER BY ordinal LIMIT 1`).get(attempt.attemptId) as { observed_at: number };
    assert.equal(firstObserved.observed_at, 25);
  } finally { journal.close(); }
});

test('atomic prefix admission retains and orders observations staged during preparation', async () => {
  const { journal, owner, attempt } = await fixture();
  try {
    owner.observe(attempt.attemptId, envelope('event-a', 1, 'A'));
    let releasePreparation!: () => void;
    const preparationBarrier = new Promise<void>((resolve) => { releasePreparation = resolve; });
    let preparationStarted!: () => void;
    const started = new Promise<void>((resolve) => { preparationStarted = resolve; });
    const dispatch = owner.dispatch(attempt.attemptId, async (boundary) => {
      boundary.markPossiblySent('fixture-session-1', 'generation-1');
      return { accepted: true, outcome: 'accepted', evidence: proof, nativeTurnId: 'turn-1' };
    }, (accepted, staged) => {
      journal.admitQueuedTurn(accepted.intendedTurnId!, 100, accepted.nativeTurnId);
      journal.appendProviderEvents(staged.map(({ envelope: event }) => event));
    }, async (staged) => {
      preparationStarted();
      await preparationBarrier;
      return staged;
    });
    await started;
    owner.observe(attempt.attemptId, envelope('event-b', 2, 'B'));
    releasePreparation();
    await dispatch;
    owner.observe(attempt.attemptId, envelope('event-c', 3, 'C'));
    assert.deepEqual(owner.staged(attempt.attemptId).map(({ observationId }) => observationId),
      ['event-b', 'event-c']);
    const suffix = owner.staged(attempt.attemptId);
    owner.drainAccepted(attempt.attemptId, suffix,
      suffix.map(({ observationId }) => observationId),
      (events) => journal.appendProviderEvents(events));
    const ids = journal.database.prepare(`SELECT event_id FROM events
      WHERE event_id IN ('event-a','event-b','event-c') ORDER BY sequence`).all() as
      Array<{ event_id: string }>;
    assert.deepEqual(ids.map(({ event_id }) => event_id), ['event-a', 'event-b', 'event-c']);
  } finally { journal.close(); }
});

test('recovery keysets beyond 256 attempts and bounded faults cannot break durable classification', async () => {
  const { journal } = await fixture();
  try {
    const source = journal.database.prepare(`SELECT * FROM delivery_attempts
      WHERE attempt_id='attempt-1'`).get() as Record<string, unknown>;
    const insert = journal.database.prepare(`INSERT INTO delivery_attempts(
      attempt_id,command_id,kind,provider,provider_instance_id,conversation_id,execution_id,
      intended_turn_id,client_message_id,native_client_message_id,compact_operation_id,
      recovery_payload_hash,recovery_payload_json,native_session_id,process_generation,
      owner_instance_id,state,created_at,updated_at,crossed_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (let index = 0; index < 300; index += 1) {
      const commandId = `recovery-command-${index}`;
      journal.claimCommand(commandId, 'turn.send', { commandId }, 100 + index);
      insert.run(`recovery-attempt-${index}`, commandId, String(source.kind), String(source.provider),
        String(source.provider_instance_id), String(source.conversation_id), String(source.execution_id),
        String(source.intended_turn_id), String(source.client_message_id),
        String(source.native_client_message_id), null, String(source.recovery_payload_hash),
        String(source.recovery_payload_json), String(source.native_session_id),
        'generation', 'dead-owner', 'dispatching', 100 + index, 100 + index, 100 + index);
    }
    new DeliveryAttemptOwner(journal, () => 1, 'startup-owner').recover();
    const states = journal.database.prepare(`SELECT state,count(*) count FROM delivery_attempts
      WHERE attempt_id LIKE 'recovery-attempt-%' GROUP BY state`).all() as
      Array<{ state: string; count: number }>;
    assert.deepEqual(states.map((row) => ({ ...row })), [{ state: 'unknown', count: 300 }]);
  } finally { journal.close(); }
});

test('staging row bound and conflicting duplicate preserve the owner hold and proof', async () => {
  const { journal, owner, attempt } = await fixture();
  try {
    await owner.dispatch(attempt.attemptId, async (boundary) => {
      boundary.markPossiblySent('fixture-session-1', 'generation-1');
      return { accepted: false, outcome: 'unknown', crossing: {
        phase: 'possibly-sent', detail: 'response-lost' },
        error: { code: 'huge', message: '\\'.repeat(100_000) } };
    }, () => undefined);
    owner.recordAcceptance(attempt.attemptId, proof, 'turn-1');
    assert.deepEqual(owner.observe(attempt.attemptId, envelope('identity', 1, 'first')),
      { staged: true });
    assert.deepEqual(owner.observe(attempt.attemptId, envelope('identity', 1, 'changed')),
      { staged: false, conflict: true });
    for (let index = 1; index < 256; index += 1) {
      owner.observe(attempt.attemptId, envelope(`event-${index}`, index));
    }
    assert.deepEqual(owner.observe(attempt.attemptId, envelope('event-overflow', 300)),
      { staged: false, overflow: true });
    assert.equal(owner.get(attempt.attemptId)?.transcriptGap, true);
    assert.deepEqual(owner.get(attempt.attemptId)?.acceptanceEvidence, proof);
    const recovery = journal.database.prepare(`SELECT recovery_json FROM delivery_attempts
      WHERE attempt_id=?`).get(attempt.attemptId) as { recovery_json: string };
    assert.ok(Buffer.byteLength(recovery.recovery_json) <= 65_536);
  } finally { journal.close(); }
});

test('staging accepts one largest valid final-event envelope at the 32 MiB row limit', async () => {
  const { journal, owner, attempt } = await fixture();
  try {
    const empty = finalEnvelope('largest-valid-final', 100, '');
    const rowLimit = 32 * 1024 * 1024;
    const overhead = Buffer.byteLength(JSON.stringify(empty));
    const largest = finalEnvelope('largest-valid-final', 100, 'x'.repeat(rowLimit - overhead));
    assert.equal(Buffer.byteLength(JSON.stringify(largest)), rowLimit);
    assert.deepEqual(owner.observe(attempt.attemptId, largest), { staged: true });
    const row = journal.database.prepare(`SELECT byte_length FROM delivery_attempt_staging
      WHERE attempt_id=? AND observation_id=?`).get(attempt.attemptId, largest.eventId) as {
        byte_length: number;
      };
    assert.equal(row.byte_length, rowLimit);
    assert.equal(owner.get(attempt.attemptId)?.transcriptGap, false);
  } finally { journal.close(); }
});

test('explicit Codex active-compact rejection releases the lane without admitting or losing the queued input', async () => {
  for (const wrongThread of [false, true]) {
    const { journal, owner, attempt } = await fixture(100, undefined, 'codex');
    try {
      const result = await owner.dispatch(attempt.attemptId, async (boundary) => {
        boundary.markPossiblySent('fixture-session-1');
        return { accepted: false, outcome: 'rejected',
          crossing: { phase: 'possibly-sent', detail: 'entered-write' },
          rejectionEvidence: { kind: 'codex-active-compact-rejection',
            threadId: wrongThread ? 'another-thread' : 'fixture-session-1', nativeCode: -32603,
            source: 'rpc-response', requestId: 7 },
          error: { code: 'codex_active_compaction', message: CODEX_ACTIVE_COMPACT_REJECTION } };
      }, () => assert.fail('rejected input must not be admitted'));
      assert.equal(result.outcome, wrongThread ? 'unknown' : 'rejected');
      assert.equal(journal.hasUnresolvedRootDelivery('conversation-1'), wrongThread);
      assert.equal(journal.turn('turn-1'), undefined);
      assert.equal(journal.queuedMessages('conversation-1')[0]?.state,
        wrongThread ? 'dispatching' : 'delivery-failed');
      if (!wrongThread) {
        journal.markQueuedTurnDeliveryUnknown('turn-1');
        assert.equal(journal.removeQueuedTurn('conversation-1', 'command-1', 101), true);
        assert.equal(journal.hasUnresolvedRootDelivery('conversation-1'), false);
      }
    } finally { journal.close(); }
  }
});

test('restart repairs only recorded active-compact rejection and preserves unrelated compaction evidence', async () => {
  for (const scenario of ['known', 'compaction', 'generic', 'turn-evidence'] as const) {
    const { journal, owner, attempt } = await fixture(100, undefined, 'codex');
    try {
      if (scenario === 'turn-evidence') owner.observe(attempt.attemptId, {
        ...envelope('contradictory-input'), provider: 'codex',
      });
      if (scenario === 'compaction') {
        journal.claimCommand('compact-1', 'conversation.compact', {}, 90);
        journal.createManualCompaction({ operationId: 'compact-1', commandId: 'compact-1',
          conversationId: 'conversation-1', state: 'running', now: 90 });
        journal.database.prepare("UPDATE compaction_operations SET provider_subject_key='compact-subject' WHERE operation_id='compact-1'").run();
        owner.observe(attempt.attemptId, {
          ...envelope('compaction-completed'), provider: 'codex',
          scope: { kind: 'conversation', conversationId: 'conversation-1', executionId: 'execution-1',
            providerInstanceId: 'fixture-local' },
          native: { sessionId: 'fixture-session-1', kind: 'control/contextCompaction/completed',
            subject: { kind: 'context-compaction', key: 'compact-subject' } },
          event: { type: 'context.compaction.completed', trigger: 'manual', operationId: 'compact-1',
            beforeTokens: null, afterTokens: null },
        });
      }
      await owner.dispatch(attempt.attemptId, async (boundary) => {
        boundary.markPossiblySent('fixture-session-1');
        return { accepted: false, outcome: 'unknown',
          crossing: { phase: 'possibly-sent', detail: 'response-lost' },
          error: { code: 'codex_request_failed', message: scenario === 'generic'
            ? 'Codex App Server turn/start failed (-32603): internal error' : CODEX_ACTIVE_COMPACT_REJECTION } };
      }, () => assert.fail('unknown input must not be admitted'));
      journal.markQueuedTurnDeliveryUnknown('turn-1');
      journal.removeQueuedTurn('conversation-1', 'command-1', 101);
      const recovered = new DeliveryAttemptOwner(journal, () => 102, 'new-owner');
      recovered.recover();
      recovered.recover();
      const known = scenario === 'known' || scenario === 'compaction';
      assert.equal(recovered.get(attempt.attemptId)?.state, known ? 'rejected' : 'unknown', scenario);
      assert.equal(journal.hasUnresolvedRootDelivery('conversation-1'), !known, scenario);
      assert.equal(journal.turn('turn-1'), undefined);
      if (scenario === 'compaction') {
        assert.equal(journal.compactionOperation('compact-1')?.state, 'completed');
        assert.equal(recovered.staged(attempt.attemptId).length, 0);
      }
    } finally { journal.close(); }
  }
});


test('v16 delivery migration preserves crossed attempts and staged observations', async () => {
  const { journal, owner, attempt } = await fixture(100, undefined, 'codex');
  try {
    await owner.dispatch(attempt.attemptId, async (boundary) => {
      boundary.markPossiblySent('fixture-session-1');
      return { accepted: false, outcome: 'unknown', crossing: { phase: 'possibly-sent', detail: 'response-lost' },
        error: { code: 'codex_request_failed', message: CODEX_ACTIVE_COMPACT_REJECTION } };
    }, () => assert.fail('not admitted'));
    owner.observe(attempt.attemptId, { ...envelope('retained-stage'), provider: 'codex' });
    const db = journal.database;
    const before = db.prepare('SELECT * FROM delivery_attempts').all();
    const staged = db.prepare('SELECT * FROM delivery_attempt_staging').all();
    const oldSql = await readFile(new URL('./fixtures/native-agent-delivery-v16.sql', import.meta.url), 'utf8');
    db.exec(`CREATE TEMP TABLE saved_attempts AS SELECT * FROM delivery_attempts;
      CREATE TEMP TABLE saved_stage AS SELECT * FROM delivery_attempt_staging;
      DROP TABLE delivery_attempt_staging; DROP TABLE delivery_attempts;`);
    db.exec(oldSql);
    db.exec(`INSERT INTO delivery_attempts SELECT * FROM saved_attempts;
      INSERT INTO delivery_attempt_staging SELECT * FROM saved_stage;
      DROP TABLE saved_attempts; DROP TABLE saved_stage; PRAGMA user_version=16; BEGIN IMMEDIATE;`);
    migrateNativeAgentSchema(db, 16);
    db.exec('COMMIT');
    assert.deepEqual(db.prepare('SELECT * FROM delivery_attempts').all(), before);
    assert.deepEqual(db.prepare('SELECT * FROM delivery_attempt_staging').all(), staged);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, NATIVE_AGENT_SCHEMA_VERSION);
    assert.throws(() => db.prepare(`UPDATE delivery_attempts SET state='rejected', rejected_at=100,
      unknown_at=NULL,rejection_json='{}' WHERE attempt_id=?`).run(attempt.attemptId), /CHECK constraint/);
  } finally { journal.close(); }
});


test('Claude active input freezes queued content and accepts repeated exact replay evidence', async () => {
  const { journal, owner, attempt } = await fixture(100, new DatabaseSync(':memory:'), 'claude-code');
  try {
    await owner.dispatch(attempt.attemptId, async (boundary) => {
      boundary.markPossiblySent('fixture-session-1', 'generation-1');
      return { accepted: true, outcome: 'accepted', nativeTurnId: 'turn-1', evidence: {
        kind: 'claude-root-processing', sessionId: 'fixture-session-1',
        userMessageUuid: 'turn-1', observationUuid: 'root-observation',
      } };
    }, (accepted) => journal.admitQueuedTurn(accepted.intendedTurnId!, 100, accepted.nativeTurnId));
    journal.claimCommand('command-2', 'turn.send', { commandId: 'command-2' }, 101);
    journal.enqueueTurn({ commandId: 'command-2', conversationId: 'conversation-1', turnId: 'reserved-turn-2',
      clientMessageId: 'viewer-message-2', content: [{ type: 'text', text: 'follow up' }],
      model: 'fixture-native-v1', access: 'workspace-write', deliveryIntent: 'auto', now: 101 });
    journal.acceptCommand('command-2', { accepted: true }, 101);
    journal.claimQueuedTurn('conversation-1', 101);
    const input = {
      attemptId: 'attempt-2', commandId: 'command-2', kind: 'steer' as const, provider: 'claude-code' as const,
      providerInstanceId: 'fixture-local', conversationId: 'conversation-1', executionId: 'execution-1',
      intendedTurnId: 'turn-1', clientMessageId: 'viewer-message-2', nativeClientMessageId: 'native-message-2',
      nativeSessionId: 'fixture-session-1', ownerInstanceId: 'owner-1', now: 101,
      recoveryPayload: { turnId: 'turn-1', clientMessageId: 'viewer-message-2', nativeClientMessageId: 'native-message-2',
        content: [{ type: 'text', text: 'follow up' }], model: 'fixture-native-v1', access: 'workspace-write',
        expectedNativeTurnId: 'turn-1', afterBlockId: null },
    };
    assert.throws(() => owner.prepare({ ...input, recoveryPayload: { ...input.recoveryPayload,
      content: [{ type: 'text', text: 'different content' }] } }), /frozen input/);
    assert.throws(() => owner.prepare({ ...input, recoveryPayload: { ...input.recoveryPayload,
      model: 'different-model' } }), /frozen input/);
    const active = owner.prepare(input);
    const evidence = { kind: 'claude-input-replay' as const, sessionId: 'fixture-session-1',
      userMessageUuid: 'native-message-2', nativeTurnId: 'turn-1', processGeneration: 'generation-1' };
    await owner.dispatch(active.attemptId, async (boundary) => {
      boundary.markPossiblySent('fixture-session-1', 'generation-1');
      return { accepted: true, outcome: 'accepted', evidence, nativeTurnId: 'turn-1' };
    }, (accepted) => journal.admitActiveInput(accepted));
    owner.recordAcceptance(active.attemptId, { ...evidence }, 'turn-1');
    assert.equal(journal.additionalTurnMessages('turn-1').length, 1);
    assert.throws(() => owner.recordAcceptance(active.attemptId, {
      ...evidence, processGeneration: 'different-generation',
    }), /frozen delivery scope/);
  } finally { journal.close(); }
});
