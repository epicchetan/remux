import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { FederationCheckoutOwner } from '../server/src/native-runtime/federation-checkout-owner.ts';
import { NativeAgentJournal } from '../server/src/native-runtime/native-journal.ts';
import { createNativeAgentSchema } from '../server/src/native-runtime/schema.ts';
import {
  PROVIDER_RUNTIME_CONTRACT_VERSION,
  type ProviderCapabilities,
  type ProviderEvent,
  type ProviderEventEnvelope,
} from '../shared/provider-runtime.ts';

const capabilities: ProviderCapabilities = {
  protocolVersion: PROVIDER_RUNTIME_CONTRACT_VERSION,
  provider: 'fixture', providerVersion: 'fixture-1', adapterVersion: 'adapter-1', auth: 'external',
  authentication: { login: 'none', logout: false },
  session: { create: true, resume: true, discoverHistory: false, readSnapshot: true,
    forkNative: false, rollbackNative: false },
  turns: { interrupt: true, steer: false, queue: false,
    changeModelOnExistingSession: false, changeEffortOnExistingSession: false },
  content: { images: true, fileReferences: true, reasoning: true, diffs: true, webActivity: true },
  collaboration: { nativeSubagents: true, childTranscript: 'summary', childSteer: false,
    childInterrupt: true },
  interaction: { blockingApprovals: false, structuredUserInput: false },
  access: { presets: ['read-only', 'workspace-write', 'full-access'], defaultPreset: 'workspace-write' },
  usage: { turn: true, cumulative: true, context: 'derived', plan: 'push', estimatedCost: false },
  compaction: { automaticNative: true, manualNative: true },
};

test('parent terminal evidence remains fenced until its real writable native child terminal', () => {
  const fixture = ownerFixture();
  try {
    fixture.addNativeChild('native-child', 'parent', 'parent-turn', 'child-session');
    fixture.addTurn('native-child', 'child-turn', 'child-command', 'child-native-turn');

    const parentTerminal = fixture.terminal('parent', 'parent-turn', 'parent-session',
      'parent-native-turn', 'parent-terminal', 'completed', 20);
    fixture.journal.appendProviderEvent(parentTerminal);
    assert.equal(fixture.owner.terminal(parentTerminal, 'live-provider', 20), true);
    assert.deepEqual(fixture.reservation('parent'), {
      state: 'held', release_reason: null, evidence_event: 'parent-terminal',
    });

    fixture.journal.database.prepare(`UPDATE executions SET state='failed', outcome='recovery_failed'
      WHERE execution_id='native-child'`).run();
    const recoveryFailure = fixture.terminal('native-child', 'child-turn', 'child-session',
      'child-native-turn', 'recovery-failure', 'recovery_failed', 21);
    fixture.journal.appendProviderEvent(recoveryFailure);
    assert.equal(fixture.owner.terminal(recoveryFailure, 'authoritative-snapshot', 21), false);
    assert.equal(fixture.reservation('parent').state, 'held');

    const childTerminal = fixture.terminal('native-child', 'child-turn', 'child-session',
      'child-native-turn', 'child-terminal', 'completed', 22);
    fixture.journal.appendProviderEvent(childTerminal);
    assert.equal(fixture.owner.terminal(childTerminal, 'live-provider', 22), false);
    assert.deepEqual(fixture.reservation('parent'), {
      state: 'released', release_reason: 'native-terminal', evidence_event: 'parent-terminal',
    });
  } finally { fixture.journal.close(); }
});

test('a completed native-child summary releases stored parent evidence without another parent turn terminal', () => {
  const fixture = ownerFixture();
  try {
    fixture.addNativeChild('native-child', 'parent', 'parent-turn', 'child-session');
    fixture.owner.terminal(fixture.terminal('parent', 'parent-turn', 'parent-session',
      'parent-native-turn', 'only-parent-terminal', 'completed'), 'live-provider', 20);
    const summary = fixture.childSummary('parent', 'parent-turn', 'parent-session',
      'native-child', 'summary-only-child-terminal');
    const wrongNativeTurn = structuredClone(summary);
    wrongNativeTurn.eventId = 'wrong-native-owner-turn';
    wrongNativeTurn.native.turnId = 'another-native-turn';
    assert.equal(fixture.owner.terminal(wrongNativeTurn, 'live-provider', 20), false);
    assert.equal(fixture.reservation('parent').state, 'held');
    fixture.journal.appendProviderEvent(summary);
    assert.equal(fixture.owner.terminal(summary, 'live-provider', 21), false);
    assert.deepEqual(fixture.reservation('parent'), {
      state: 'released', release_reason: 'native-terminal', evidence_event: 'only-parent-terminal',
    });
  } finally { fixture.journal.close(); }
});

test('reactivated owners and independent or invalid descendants remain fenced', () => {
  const fixture = ownerFixture();
  try {
    fixture.journal.releaseFederatedCheckout({ executionId: 'parent', commandId: 'parent-command',
      expectedTurnId: 'parent-turn', reason: 'native-terminal', now: 10 });
    fixture.journal.claimCommand('command-b', 'federation.followup', { id: 'b' }, 11);
    fixture.journal.reserveFederatedCheckout({ executionId: 'parent', checkoutKey: 'test:key',
      commandId: 'command-b', expectedTurnId: 'turn-b', access: 'workspace-write',
      scheduling: 'foreground', now: 11 });
    fixture.addTurn('parent', 'turn-b', 'command-b', 'native-turn-b');

    const stale = fixture.terminal('parent', 'parent-turn', 'parent-session', 'parent-native-turn',
      'stale-a', 'completed');
    assert.equal(fixture.owner.terminal(stale, 'live-provider', 12), false);
    assert.deepEqual(fixture.reservation('parent'), { state: 'held', release_reason: null,
      evidence_event: null });
    for (const bad of [
      fixture.terminal('parent', 'turn-b', 'wrong-session', 'native-turn-b', 'wrong-session', 'completed'),
      fixture.terminal('parent', 'turn-b', 'parent-session', 'wrong-turn', 'wrong-turn', 'completed'),
      fixture.terminal('parent', 'turn-b', 'parent-session', 'native-turn-b', 'recovery', 'recovery_failed'),
    ]) assert.equal(fixture.owner.terminal(bad, 'live-provider', 13), false);

    fixture.addFederatedChild('federated-child', 'parent', 'turn-b');
    fixture.journal.claimCommand('federated-child-command', 'federation.spawn', { id: 'independent' }, 13);
    fixture.journal.reserveFederatedCheckout({ executionId: 'federated-child', checkoutKey: 'test:other',
      commandId: 'federated-child-command', expectedTurnId: 'federated-child-turn',
      access: 'workspace-write', scheduling: 'foreground', now: 13 });
    assert.equal(fixture.owner.terminal(fixture.terminal('parent', 'turn-b', 'parent-session',
      'native-turn-b', 'valid-b', 'completed'), 'live-provider', 14), true,
    'a federated descendant owns its reservation independently');
    assert.equal(fixture.reservation('federated-child').state, 'held');

    const invalid = ownerFixture('invalid-parent');
    try {
      invalid.addNativeChild('cross-child', 'invalid-parent', 'parent-turn', 'cross-session');
      invalid.journal.database.prepare(`UPDATE executions SET conversation_id='other-conversation'
        WHERE execution_id='cross-child'`).run();
      assert.equal(invalid.owner.terminal(invalid.terminal('invalid-parent', 'parent-turn', 'parent-session',
        'parent-native-turn', 'cross-conversation', 'completed'), 'live-provider', 20), true);
      assert.equal(invalid.reservation('invalid-parent').state, 'held');
    } finally { invalid.journal.close(); }
  } finally { fixture.journal.close(); }
});

function ownerFixture(parentId = 'parent') {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON');
  createNativeAgentSchema(database);
  const journal = new NativeAgentJournal(database);
  journal.upsertProviderInstance({ providerInstanceId: 'fixture-local', provider: 'fixture', label: 'Fixture',
    probe: { state: 'ready', displayLabel: 'Fixture', capabilities }, now: 1 });
  journal.createConversation({ conversationId: 'conversation', rootExecutionId: 'root', provider: 'fixture',
    providerInstanceId: 'fixture-local', title: 'Root', cwd: '/workspace/remux',
    model: 'fixture-native-v1', access: 'workspace-write', now: 1 });
  journal.createConversation({ conversationId: 'other-conversation', rootExecutionId: 'other-root',
    provider: 'fixture', providerInstanceId: 'fixture-local', title: 'Other', cwd: '/workspace/other',
    model: 'fixture-native-v1', access: 'workspace-write', now: 1 });
  journal.claimCommand('parent-command', 'federation.spawn', { id: 'parent' }, 2);
  journal.createFederatedExecution({ executionId: parentId, conversationId: 'conversation',
    parentExecutionId: 'root', rootTurnId: 'root-turn', provider: 'fixture',
    providerInstanceId: 'fixture-local', model: 'fixture-native-v1', checkoutKey: 'test:key',
    access: 'workspace-write', scheduling: 'foreground', depth: 1, title: 'Parent', now: 2 });
  journal.reserveFederatedCheckout({ executionId: parentId, checkoutKey: 'test:key',
    commandId: 'parent-command', expectedTurnId: 'parent-turn', access: 'workspace-write',
    scheduling: 'foreground', now: 3 });
  journal.bindNativeSession({ executionId: parentId, nativeSession: { provider: 'fixture',
    providerInstanceId: 'fixture-local', sessionId: 'parent-session' }, adapterVersion: 'adapter-1', now: 3 });
  addTurn(parentId, 'parent-turn', 'parent-command', 'parent-native-turn');
  const owner = new FederationCheckoutOwner(journal, async () => ({ state: 'resolved',
    value: { checkoutKey: 'test:key', launchCwd: '/workspace/remux' } }));

  function addTurn(executionId: string, turnId: string, commandId: string, nativeTurnId: string) {
    if (!journal.commandReceipt(commandId)) journal.claimCommand(commandId, 'turn.send', { commandId }, 3);
    journal.createTurn({ turnId, conversationId: 'conversation', executionId,
      clientMessageId: `message-${turnId}`, commandId, content: [{ type: 'text', text: turnId }],
      model: 'fixture-native-v1', state: 'running', now: 4 });
    journal.database.prepare(`UPDATE turns SET native_turn_id=? WHERE turn_id=?`).run(nativeTurnId, turnId);
  }
  function addNativeChild(id: string, parent: string, rootTurn: string, session: string) {
    journal.database.prepare(`INSERT INTO executions(execution_id,conversation_id,parent_execution_id,
      root_turn_id,ownership,provider,provider_instance_id,model,access,federation_depth,title,state,
      transcript_available,created_at,updated_at) VALUES (?, 'conversation', ?, ?, 'native','fixture',
      'fixture-local','fixture-native-v1','workspace-write',2,?,'running',1,5,5)`).run(id, parent, rootTurn, id);
    journal.database.prepare(`INSERT INTO native_child_handles(execution_id,native_session_id,
      private_ref_json,updated_at) VALUES (?,?,?,5)`).run(id, session, JSON.stringify({ nativeSessionId: session }));
  }
  function addFederatedChild(id: string, parent: string, rootTurn: string) {
    journal.createFederatedExecution({ executionId: id, conversationId: 'conversation', parentExecutionId: parent,
      rootTurnId: rootTurn, provider: 'fixture', providerInstanceId: 'fixture-local',
      model: 'fixture-native-v1', checkoutKey: 'test:other', access: 'workspace-write',
      scheduling: 'foreground', depth: 2, title: id, now: 5 });
  }
  function terminal(executionId: string, turnId: string, sessionId: string, nativeTurnId: string,
    eventId: string, outcome: 'completed' | 'failed' | 'interrupted' | 'recovery_failed',
    observedAt = 10): ProviderEventEnvelope {
    return envelope(executionId, turnId, sessionId, nativeTurnId, eventId,
      { type: 'turn.completed', outcome }, observedAt);
  }
  function childSummary(executionId: string, turnId: string, sessionId: string, childId: string,
    eventId: string): ProviderEventEnvelope {
    return envelope(executionId, turnId, sessionId, 'parent-native-turn', eventId, {
      type: 'turn.block.completed', revision: 1, contentHash: 'a'.repeat(64),
      structure: { passId: 'pass', passOrdinal: 0, blockId: 'child-block', blockOrdinal: 0 },
      block: { kind: 'native-child', state: 'completed', payload: { kind: 'native-child',
        child: { executionId: childId, ownership: 'native', provider: 'fixture',
          providerInstanceId: 'fixture-local', nativeSessionId: 'child-session' },
        executionState: 'idle', outcome: 'completed', summary: 'Child finished.' } },
    }, 10);
  }
  function reservation(executionId: string) {
    const row = journal.database.prepare(`SELECT state,release_reason,terminal_evidence_json
      FROM federation_checkout_reservations WHERE execution_id=?`).get(executionId) as {
      state: string; release_reason: string | null; terminal_evidence_json: string | null };
    return { state: row.state, release_reason: row.release_reason,
      evidence_event: row.terminal_evidence_json
        ? (JSON.parse(row.terminal_evidence_json) as { eventId: string }).eventId : null };
  }
  return { journal, owner, addTurn, addNativeChild, addFederatedChild, terminal, childSummary, reservation };
}

function envelope(executionId: string, turnId: string, sessionId: string, nativeTurnId: string,
  eventId: string, event: ProviderEvent, observedAt: number): ProviderEventEnvelope {
  return { contractVersion: PROVIDER_RUNTIME_CONTRACT_VERSION, eventId, provider: 'fixture',
    scope: { kind: 'turn', providerInstanceId: 'fixture-local', conversationId: 'conversation',
      executionId, turnId },
    native: { sessionId, turnId: nativeTurnId,
      position: { kind: 'native-sequence', sequence: observedAt, subIndex: 0 }, kind: event.type },
    observedAt, event };
}
