import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  NativeAgentJournal,
  openNativeAgentJournal,
} from '../server/src/native-runtime/native-journal.ts';
import { FederationCheckoutOwner } from '../server/src/native-runtime/federation-checkout-owner.ts';
import {
  createNativeAgentSchema,
  migrateNativeAgentSchema,
} from '../server/src/native-runtime/schema.ts';
import { prepareAgentDataPaths } from '../server/src/storage/data-root.ts';
import { CodexEventMapper, codexStableChildExecutionId, codexStableNativeTurnId } from '../server/src/providers/codex/codex-event-mapper.ts';
import { CodexChildRegistry } from '../server/src/providers/codex/codex-child-registry.ts';
import {
  PROVIDER_RUNTIME_CONTRACT_VERSION,
  type ProviderCapabilities,
  type ProviderEvent,
  type ProviderEventEnvelope,
} from '../shared/provider-runtime.ts';

const capabilities: ProviderCapabilities = {
  protocolVersion: PROVIDER_RUNTIME_CONTRACT_VERSION,
  provider: 'fixture',
  providerVersion: 'fixture-1',
  adapterVersion: 'adapter-1',
  auth: 'external',
  authentication: { login: 'none', logout: false },
  session: {
    create: true,
    resume: true,
    discoverHistory: false,
    readSnapshot: true,
    forkNative: false,
    rollbackNative: false,
  },
  turns: {
    interrupt: true,
    steer: false,
    queue: false,
    changeModelOnExistingSession: false,
    changeEffortOnExistingSession: false,
  },
  content: {
    images: true,
    fileReferences: true,
    reasoning: true,
    diffs: true,
    webActivity: true,
  },
  collaboration: {
    nativeSubagents: true,
    childTranscript: 'summary',
    childSteer: false,
    childInterrupt: true,
  },
  interaction: { blockingApprovals: false, structuredUserInput: false },
  access: {
    presets: ['read-only', 'workspace-write', 'full-access'],
    defaultPreset: 'workspace-write',
  },
  usage: { turn: true, cumulative: true, context: 'derived', plan: 'push', estimatedCost: false },
  compaction: { automaticNative: true, manualNative: true },
};

test('file-backed native journal avoids a WAL shared-memory sidecar', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'remux-native-journal-'));
  let journal: NativeAgentJournal | undefined;
  try {
    journal = await openNativeAgentJournal({ dataRoot });
    const mode = journal.database.prepare('PRAGMA journal_mode').get() as {
      journal_mode: string;
    };
    const synchronous = journal.database.prepare('PRAGMA synchronous').get() as {
      synchronous: number;
    };
    assert.equal(mode.journal_mode, 'delete');
    assert.equal(synchronous.synchronous, 2);
    await assert.rejects(
      stat(join(dataRoot, 'agent.sqlite3-shm')),
      (error: NodeJS.ErrnoException) => error.code === 'ENOENT',
    );
  } finally {
    journal?.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('agent data preparation repairs database and DELETE-journal sidecar modes', async (context) => {
  if (process.platform === 'win32') {
    context.skip('POSIX file modes are not available on Windows.');
    return;
  }
  const dataRoot = await mkdtemp(join(tmpdir(), 'remux-native-modes-'));
  const database = join(dataRoot, 'agent.sqlite3');
  const sidecars = [`${database}-journal`, `${database}-wal`, `${database}-shm`];
  try {
    await writeFile(database, '');
    await Promise.all(sidecars.map((path) => writeFile(path, '')));
    await Promise.all([database, ...sidecars].map((path) => chmod(path, 0o644)));
    await prepareAgentDataPaths({ dataRoot });
    for (const path of [database, ...sidecars]) {
      assert.equal((await stat(path)).mode & 0o777, 0o600, path);
    }
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('native journal separates command acceptance from native terminal outcome', () => {
  const journal = createJournal();
  try {
    seedConversation(journal);
    journal.claimCommand('send-1', 'turn.send', { b: 2, a: 1 }, 2);
    const repeated = journal.claimCommand('send-1', 'turn.send', { a: 1, b: 2 }, 3);
    assert.equal(repeated.created, false);
    journal.createTurn({
      turnId: 'turn-1',
      conversationId: 'conversation-1',
      executionId: 'execution-1',
      clientMessageId: 'message-1',
      commandId: 'send-1',
      content: [{ type: 'text', text: 'Implement it.' }],
      model: 'fixture-native-v1',
      state: 'running',
      now: 4,
    });
    journal.markCommandDispatching('send-1', 5);
    journal.acceptCommand('send-1', { accepted: true, turnId: 'turn-1' }, 6);
    assert.equal(journal.commandReceipt('send-1')?.state, 'accepted');
    assert.equal(journal.turn('turn-1')?.state, 'running');
    assert.equal(journal.turn('turn-1')?.ordering, 'native-exact');
    assert.equal(journal.execution('execution-1')?.state, 'running');

    assert.equal(journal.appendProviderEvent(event('turn-started', 7, { type: 'turn.started' })), true);
    assert.equal(journal.appendProviderEvent(event('turn-started', 7, { type: 'turn.started' })), false);
    assert.equal(journal.appendProviderEvent(event('turn-completed', 8, {
      type: 'turn.completed',
      outcome: 'failed',
      error: { code: 'fixture_failed', message: 'The native turn failed.' },
    })), true);
    assert.equal(journal.commandReceipt('send-1')?.state, 'accepted');
    assert.equal(journal.turn('turn-1')?.state, 'failed');
    assert.equal(journal.turn('turn-1')?.outcome, 'failed');
    assert.equal(journal.conversation('conversation-1')?.state, 'idle');
    assert.equal(journal.eventsForConversation('conversation-1').length, 2);
  } finally {
    journal.close();
  }
});

test('history discovery refreshes native metadata without overwriting a running execution', () => {
  const journal = createJournal();
  try {
    seedConversation(journal);
    journal.claimCommand('send-running', 'turn.send', { message: 'running' }, 2);
    journal.createTurn({
      turnId: 'turn-running',
      conversationId: 'conversation-1',
      executionId: 'execution-1',
      clientMessageId: 'message-running',
      commandId: 'send-running',
      content: [{ type: 'text', text: 'Keep working.' }],
      model: 'fixture-native-v1',
      state: 'running',
      now: 2,
    });

    journal.importDiscoveredConversation({
      conversationId: 'unused-discovered-id',
      rootExecutionId: 'unused-discovered-execution',
      nativeSession: {
        provider: 'fixture',
        providerInstanceId: 'fixture-local',
        sessionId: 'fixture-session-1',
        resumeCursor: { sequence: 9 },
      },
      adapterVersion: 'adapter-2',
      title: 'Native title',
      preview: 'Native preview',
      cwd: '/workspace/remux',
      model: 'fixture-native-v1',
      access: 'workspace-write',
      historyRevision: 'history-r9',
      createdAt: 1,
      observedAt: 10,
      updatedAt: 9,
    });

    const conversation = journal.conversation('conversation-1');
    assert.equal(conversation?.state, 'running');
    assert.equal(conversation?.activeTurnId, 'turn-running');
    assert.equal(conversation?.history.state, 'indexed');
    assert.equal(conversation?.history.nativeRevision, 'history-r9');
    assert.equal(conversation?.lastActivityAt, 9);
    assert.equal(journal.execution('execution-1')?.state, 'running');
    assert.deepEqual(journal.nativeSession('execution-1')?.resumeCursor, {
      sequence: 9,
    });

    // Old builds could overwrite the provider's timestamp with the time a
    // transcript was opened. The next authoritative discovery repairs it.
    journal.database.prepare(`
      UPDATE conversations SET native_history_updated_at = 99
      WHERE conversation_id = 'conversation-1'
    `).run();
    assert.equal(journal.conversation('conversation-1')?.lastActivityAt, 99);
    journal.importDiscoveredConversation({
      conversationId: 'unused-discovered-id',
      rootExecutionId: 'unused-discovered-execution',
      nativeSession: {
        provider: 'fixture',
        providerInstanceId: 'fixture-local',
        sessionId: 'fixture-session-1',
        resumeCursor: { sequence: 9 },
      },
      adapterVersion: 'adapter-2',
      title: 'Native title',
      preview: 'Native preview',
      cwd: '/workspace/remux',
      model: 'fixture-native-v1',
      access: 'workspace-write',
      historyRevision: 'history-r9',
      createdAt: 1,
      observedAt: 100,
      updatedAt: 9,
    });
    assert.equal(journal.conversation('conversation-1')?.lastActivityAt, 9);
    journal.markConversationHistorySynced('conversation-1', 200, 'history-r9');
    assert.equal(journal.conversation('conversation-1')?.lastActivityAt, 9);
  } finally {
    journal.close();
  }
});

test('native journal recovers an active turn even when a session bind left its conversation idle', () => {
  const journal = createJournal();
  try {
    seedConversation(journal);
    journal.createTurn({
      turnId: 'turn-1',
      conversationId: 'conversation-1',
      executionId: 'execution-1',
      clientMessageId: 'message-1',
      commandId: 'send-1',
      content: [{ type: 'text', text: 'Keep working.' }],
      model: 'fixture-native-v1',
      state: 'running',
      now: 2,
    });
    journal.database.exec(`
      UPDATE conversations SET state = 'idle' WHERE conversation_id = 'conversation-1';
      UPDATE turns SET state = 'recovering' WHERE turn_id = 'turn-1';
    `);

    assert.deepEqual(
      journal.conversationsNeedingRecovery().map(({ conversationId }) => conversationId),
      ['conversation-1'],
    );
  } finally {
    journal.close();
  }
});

test('binding a native session does not reset an active turn to idle', () => {
  const journal = createJournal();
  try {
    seedConversation(journal);
    journal.createTurn({
      turnId: 'turn-1',
      conversationId: 'conversation-1',
      executionId: 'execution-1',
      clientMessageId: 'message-1',
      commandId: 'send-1',
      content: [{ type: 'text', text: 'Keep the lifecycle authoritative.' }],
      model: 'fixture-native-v1',
      state: 'running',
      now: 2,
    });

    journal.bindNativeSession({
      executionId: 'execution-1',
      nativeSession: {
        provider: 'fixture',
        providerInstanceId: 'fixture-local',
        sessionId: 'fixture-session-1',
        resumeCursor: { sequence: 1 },
      },
      adapterVersion: 'adapter-2',
      now: 3,
    });

    assert.equal(journal.turn('turn-1')?.state, 'running');
    assert.equal(journal.execution('execution-1')?.state, 'running');
    assert.equal(journal.conversation('conversation-1')?.state, 'running');
    assert.equal(journal.conversation('conversation-1')?.activeTurnId, 'turn-1');
    assert.equal(journal.conversation('conversation-1')?.resumable, true);
  } finally {
    journal.close();
  }
});

test('an authoritative running snapshot reasserts lifecycle state after recovery', () => {
  const journal = createJournal();
  try {
    seedConversation(journal);
    journal.createTurn({
      turnId: 'turn-1',
      conversationId: 'conversation-1',
      executionId: 'execution-1',
      clientMessageId: 'message-1',
      commandId: 'send-1',
      content: [{ type: 'text', text: 'Recover this accepted turn.' }],
      model: 'fixture-native-v1',
      state: 'running',
      now: 2,
    });
    journal.markConversationRecovering('conversation-1', 'Reconnecting', 3);

    assert.equal(journal.confirmExecutionRunning('execution-1', 4), 'turn-1');
    assert.equal(journal.turn('turn-1')?.state, 'running');
    assert.equal(journal.execution('execution-1')?.state, 'running');
    assert.equal(journal.conversation('conversation-1')?.state, 'running');
    assert.equal(journal.conversation('conversation-1')?.activeTurnId, 'turn-1');
    assert.equal(journal.conversation('conversation-1')?.healthMessage, undefined);
  } finally {
    journal.close();
  }
});

test('later native terminal evidence repairs a false recovery failure from an older journal', () => {
  const journal = createJournal();
  try {
    seedConversation(journal);
    journal.createTurn({
      turnId: 'turn-1',
      conversationId: 'conversation-1',
      executionId: 'execution-1',
      clientMessageId: 'message-1',
      commandId: 'send-1',
      content: [{ type: 'text', text: 'Finish authoritatively.' }],
      model: 'fixture-native-v1',
      state: 'running',
      now: 2,
    });
    journal.appendProviderEvent(event('native-terminal-after-race', 10, {
      type: 'turn.completed',
      outcome: 'completed',
    }));
    journal.database.exec(`
      UPDATE turns SET state = 'failed', outcome = 'recovery_failed',
        error_json = '{"code":"recovery_failed","message":"stale recovery"}',
        completed_at = 5, updated_at = 5 WHERE turn_id = 'turn-1';
      UPDATE executions SET state = 'failed', outcome = 'recovery_failed',
        completed_at = 5, updated_at = 5 WHERE execution_id = 'execution-1';
      UPDATE conversations SET state = 'failed', active_turn_id = NULL,
        health_message = 'stale recovery', resumable = 0, updated_at = 5
        WHERE conversation_id = 'conversation-1';
    `);

    assert.deepEqual(journal.repairRecoveryFailuresWithLaterNativeTerminalEvents(), ['turn-1']);
    assert.equal(journal.turn('turn-1')?.state, 'completed');
    assert.equal(journal.turn('turn-1')?.outcome, 'completed');
    assert.equal(journal.turn('turn-1')?.error, undefined);
    assert.equal(journal.execution('execution-1')?.state, 'idle');
    assert.equal(journal.conversation('conversation-1')?.state, 'idle');
    assert.equal(journal.conversation('conversation-1')?.healthMessage, undefined);
    assert.equal(journal.conversation('conversation-1')?.resumable, true);
  } finally {
    journal.close();
  }
});

test('duplicate native imports are removed from strand paths without deleting their audit rows', () => {
  const journal = createJournal();
  try {
    seedConversation(journal);
    journal.createTurn({
      turnId: 'canonical-turn',
      conversationId: 'conversation-1',
      executionId: 'execution-1',
      clientMessageId: 'canonical-message',
      commandId: 'send-canonical',
      content: [{ type: 'text', text: 'Canonical.' }],
      model: 'fixture-native-v1',
      state: 'running',
      now: 2,
    });
    journal.createTurn({
      turnId: 'codex-turn-imported',
      conversationId: 'conversation-1',
      executionId: 'execution-1',
      clientMessageId: 'native-import-message:codex-turn-imported',
      commandId: 'native-import-command:codex-turn-imported',
      content: [{ type: 'text', text: 'Canonical.' }],
      model: 'fixture-native-v1',
      state: 'running',
      now: 3,
    });
    journal.database.exec(`
      UPDATE turns SET native_turn_id = 'same-native-turn', state = 'completed',
        outcome = 'completed', completed_at = 4, updated_at = 4
      WHERE turn_id IN ('canonical-turn', 'codex-turn-imported');
      UPDATE conversations SET state = 'idle', active_turn_id = NULL WHERE conversation_id = 'conversation-1';
    `);
    const strandId = journal.conversationHead('conversation-1')!.strandId;
    assert.deepEqual(journal.strandPath(strandId).map(({ turnId }) => turnId), [
      'canonical-turn',
      'codex-turn-imported',
    ]);

    assert.equal(journal.repairDuplicatedNativeImportsInStrands(), 1);
    assert.deepEqual(journal.strandPath(strandId).map(({ turnId, ordinal }) => [turnId, ordinal]), [
      ['canonical-turn', 0],
    ]);
    assert.ok(journal.turn('codex-turn-imported'), 'the imported audit row remains available');
  } finally {
    journal.close();
  }
});

test('native journal keeps provider health timestamps monotonic across bind races', () => {
  const journal = createJournal();
  try {
    seedConversation(journal);
    journal.database.prepare(`
      UPDATE native_sessions
      SET first_observed_at = 100, last_observed_at = 100
      WHERE execution_id = 'execution-1'
    `).run();
    assert.equal(journal.appendProviderEvent(event('health-before-bind', 99, {
      type: 'session.health',
      state: 'ready',
    })), true);
    const row = journal.database.prepare(`
      SELECT first_observed_at, last_observed_at
      FROM native_sessions WHERE execution_id = 'execution-1'
    `).get() as { first_observed_at: number; last_observed_at: number };
    assert.equal(row.first_observed_at, 100);
    assert.equal(row.last_observed_at, 100);
  } finally {
    journal.close();
  }
});

test('native journal appends and deduplicates a provider event batch atomically', () => {
  const journal = createJournal();
  try {
    seedConversation(journal);
    journal.createTurn({
      turnId: 'turn-1',
      conversationId: 'conversation-1',
      executionId: 'execution-1',
      clientMessageId: 'message-1',
      commandId: 'send-1',
      content: [{ type: 'text', text: 'Batch this.' }],
      model: 'fixture-native-v1',
      state: 'running',
      now: 2,
    });
    const batch = [
      event('batch-text', 3, {
        type: 'turn.block.started',
        structure: blockStructure('assistant-final', 0),
        block: {
          kind: 'final-message',
          state: 'streaming',
          payload: { kind: 'final-message', text: 'Done.' },
        },
      }),
      event('batch-terminal', 4, { type: 'turn.completed', outcome: 'completed' }),
    ];
    assert.deepEqual(journal.appendProviderEvents(batch).map(({ eventId }) => eventId), [
      'batch-text',
      'batch-terminal',
    ]);
    assert.equal(journal.appendProviderEvents(batch).length, 0);
    assert.equal(journal.turn('turn-1')?.outcome, 'completed');
    assert.deepEqual(
      journal.eventsForConversation('conversation-1').map(({ eventId }) => eventId),
      ['batch-text', 'batch-terminal'],
    );
  } finally {
    journal.close();
  }
});

test('native journal appends a new live block when its proposed ordinal is occupied', () => {
  const journal = createJournal();
  try {
    seedConversation(journal);
    journal.createTurn({
      turnId: 'turn-1',
      conversationId: 'conversation-1',
      executionId: 'execution-1',
      clientMessageId: 'message-1',
      commandId: 'send-1',
      content: [{ type: 'text', text: 'Keep the recovered stream ordered.' }],
      model: 'fixture-native-v1',
      state: 'running',
      now: 2,
    });
    assert.equal(journal.appendProviderEvent(event('first-block', 3, {
      type: 'turn.block.completed',
      structure: blockStructure('first-block', 0),
      revision: 1,
      contentHash: 'a'.repeat(64),
      block: {
        kind: 'reasoning-summary',
        state: 'completed',
        payload: { kind: 'reasoning-summary', text: 'Already projected.' , truncated: false},
      },
    })), true);
    assert.equal(journal.appendProviderEvent(event('racing-block-started', 4, {
      type: 'turn.block.started',
      structure: blockStructure('racing-block', 0),
      block: {
        kind: 'commentary',
        state: 'streaming',
        payload: { kind: 'commentary', text: 'Recovered' },
      },
    })), true);
    assert.equal(journal.appendProviderEvent(event('racing-block-completed', 5, {
      type: 'turn.block.completed',
      structure: blockStructure('racing-block', 0),
      revision: 1,
      contentHash: 'b'.repeat(64),
      block: {
        kind: 'commentary',
        state: 'completed',
        payload: { kind: 'commentary', text: 'Recovered safely.' },
      },
    })), true);

    const blocks = journal.orderedPasses('turn-1').flatMap((pass) => pass.blocks);
    assert.deepEqual(blocks.map(({ blockId, ordinal }) => [blockId, ordinal]), [
      ['first-block', 0],
      ['racing-block', 1],
    ]);
    assert.equal(blocks[1]?.payload.kind, 'commentary');
    assert.equal(blocks[1]?.payload.kind === 'commentary' ? blocks[1].payload.text : '',
      'Recovered safely.');
    assert.equal(journal.eventsForTurn('turn-1').length, 3,
      'the append-only event log retains both lifecycle events');
  } finally {
    journal.close();
  }
});

test('native journal gives interleaved native and federated passes stable canonical ordinals', () => {
  const journal = createJournal();
  try {
    seedConversation(journal);
    journal.createTurn({
      turnId: 'turn-1',
      conversationId: 'conversation-1',
      executionId: 'execution-1',
      clientMessageId: 'message-1',
      commandId: 'send-1',
      content: [{ type: 'text', text: 'Interleave native output and reviewers.' }],
      model: 'fixture-native-v1',
      state: 'running',
      now: 2,
    });
    const completedBlock = (
      eventId: string,
      observedAt: number,
      passId: string,
      blockId: string,
      passOrdinal: number,
      text: string,
      revision = 1,
    ) => event(eventId, observedAt, {
      type: 'turn.block.completed',
      structure: { passId, blockId, passOrdinal, blockOrdinal: 0 },
      revision,
      contentHash: 'a'.repeat(64),
      block: {
        kind: 'reasoning-summary',
        state: 'completed',
        payload: { kind: 'reasoning-summary', text, truncated: false },
      },
    });

    const federatedPasses = Array.from({ length: 10 }, (_, index) => completedBlock(
      `federated-pass-${index + 1}`,
      index + 4,
      `federated-pass-${index + 1}`,
      `federated-block-${index + 1}`,
      index + 1,
      `Reviewer ${index + 1}.`,
    ));
    assert.equal(journal.appendProviderEvents([
      completedBlock('native-pass-zero', 3, 'native-pass-0', 'native-block-0', 0, 'First.'),
      ...federatedPasses,
      completedBlock('native-pass-one', 14, 'native-pass-1', 'native-block-1', 1, 'Continued.'),
      completedBlock('native-pass-one-revised', 15, 'native-pass-1', 'native-block-1', 1,
        'Continued safely.', 2),
    ]).length, 13);
    assert.equal(journal.appendProviderEvent(event('turn-terminal', 16, {
      type: 'turn.completed', outcome: 'completed',
    })), true);
    assert.equal(journal.appendProviderEvent(completedBlock(
      'late-native-pass', 17, 'native-pass-2', 'native-block-2', 2, 'Recovered after completion.',
    )), true);

    assert.deepEqual(journal.orderedPasses('turn-1').map(({ passId, ordinal }) => [passId, ordinal]), [
      ['native-pass-0', 0],
      ...Array.from({ length: 10 }, (_, index) =>
        [`federated-pass-${index + 1}`, index + 1]),
      ['native-pass-1', 11],
      ['native-pass-2', 12],
    ]);
    assert.equal(journal.orderedPasses('turn-1').at(-1)?.state, 'completed');
    assert.deepEqual(journal.eventsForTurn('turn-1').flatMap(({ event: stored }) =>
      stored.type === 'turn.block.started' || stored.type === 'turn.block.revised' ||
      stored.type === 'turn.block.completed'
        ? [[stored.structure.passId, stored.structure.passOrdinal]]
        : []), [
      ['native-pass-0', 0],
      ...Array.from({ length: 10 }, (_, index) =>
        [`federated-pass-${index + 1}`, index + 1]),
      ['native-pass-1', 11],
      ['native-pass-1', 11],
      ['native-pass-2', 12],
    ]);
  } finally {
    journal.close();
  }
});

test('native journal projects native child identity without exposing a resume cursor', () => {
  const journal = createJournal();
  try {
    seedConversation(journal);
    journal.claimCommand('send-1', 'turn.send', { text: 'delegate' }, 2);
    journal.createTurn({
      turnId: 'turn-1',
      conversationId: 'conversation-1',
      executionId: 'execution-1',
      clientMessageId: 'message-1',
      commandId: 'send-1',
      content: [{ type: 'text', text: 'Delegate.' }],
      model: 'fixture-native-v1',
      state: 'running',
      now: 3,
    });
    journal.appendProviderEvent(event('child-started', 4, {
      type: 'turn.block.started',
      structure: blockStructure('native-child-1', 0),
      block: {
        kind: 'native-child',
        state: 'running',
        payload: {
          kind: 'native-child',
          child: {
            executionId: 'execution-child-1',
            ownership: 'native',
            provider: 'fixture',
            providerInstanceId: 'fixture-local',
            title: 'Native reviewer',
            nativeSessionId: 'private-child-thread',
            transcriptAvailable: true,
          },
          executionState: 'running',
        },
      },
    }));
    assert.equal(journal.execution('execution-child-1')?.transcriptAvailable, true);
    assert.deepEqual(journal.nativeChildBindings('execution-1', 'native-root-thread'), [{
      nativeThreadId: 'private-child-thread',
      executionId: 'execution-child-1',
      parentExecutionId: 'execution-1',
      nativeParentThreadId: 'native-root-thread',
      ownerTurnId: 'turn-1',
      ownerNativeTurnId: 'fixture-native-turn-1',
      nativeTurnBindings: [],
      terminalNativeTurnIds: [],
      canonicalBlock: {
        structure: blockStructure('native-child-1', 0),
        revision: 0,
        block: { kind: 'native-child', state: 'running', payload: {
          kind: 'native-child',
          child: { executionId: 'execution-child-1', ownership: 'native', provider: 'fixture',
            providerInstanceId: 'fixture-local', title: 'Native reviewer',
            nativeSessionId: 'private-child-thread', transcriptAvailable: true },
          executionState: 'running',
        } },
      },
    }]);
    assert.deepEqual(journal.nativeChildHandle('execution-child-1'), {
      nativeSessionId: 'private-child-thread',
    });
    journal.appendProviderEvents([
      childEvent('child-turn-started', 5, { type: 'turn.started' }),
      childEvent('child-user', 6, {
        type: 'user.message',
        content: [{ type: 'text', text: 'Inspect the native child.' }],
      }),
      childEvent('child-final', 7, {
        type: 'turn.block.completed',
        structure: {
          passId: 'child-pass-1',
          blockId: 'child-final-block',
          passOrdinal: 0,
          blockOrdinal: 0,
        },
        revision: 1,
        contentHash: 'c'.repeat(64),
        block: {
          kind: 'final-message',
          state: 'completed',
          payload: { kind: 'final-message', text: 'Native child result.' },
        },
      }),
      childEvent('child-turn-completed', 8, { type: 'turn.completed', outcome: 'completed' }),
    ]);
    journal.appendProviderEvent(event('child-completed', 9, {
      type: 'turn.block.completed',
      structure: blockStructure('native-child-1', 0),
      revision: 1,
      contentHash: 'a'.repeat(64),
      block: {
        kind: 'native-child',
        state: 'completed',
        payload: {
          kind: 'native-child',
          child: {
            executionId: 'execution-child-1',
            ownership: 'native',
            provider: 'fixture',
            providerInstanceId: 'fixture-local',
            title: 'Native reviewer',
            nativeSessionId: 'private-child-thread',
          },
          executionState: 'idle',
          outcome: 'completed',
        },
      },
    }));
    journal.appendProviderEvent({ ...event('later-observed-child-started', 10, {
      type: 'execution.started', child: { executionId: 'execution-child-1', ownership: 'native',
        provider: 'fixture', providerInstanceId: 'fixture-local', title: 'Native reviewer',
        nativeSessionId: 'private-child-thread', transcriptAvailable: true },
    }), scope: { kind: 'execution', providerInstanceId: 'fixture-local',
      conversationId: 'conversation-1', executionId: 'execution-1', rootTurnId: 'turn-1' } });
    journal.appendProviderEvent(childEvent('grandchild-started', 11, {
      type: 'turn.block.started', structure: {
        passId: 'child-pass-1', blockId: 'grandchild-block', passOrdinal: 0, blockOrdinal: 1,
      }, block: { kind: 'native-child', state: 'running', payload: {
        kind: 'native-child', child: { executionId: 'execution-grandchild-1', ownership: 'native',
          provider: 'fixture', providerInstanceId: 'fixture-local', title: 'Nested reviewer',
          nativeSessionId: 'private-grandchild-thread', transcriptAvailable: true },
        executionState: 'running',
      } },
    }));
    journal.appendProviderEvent(event('late-child-started', 3, {
      type: 'turn.block.started',
      structure: blockStructure('native-child-1', 0),
      block: {
        kind: 'native-child',
        state: 'running',
        payload: {
          kind: 'native-child',
          child: {
            executionId: 'execution-child-1',
            ownership: 'native',
            provider: 'fixture',
            providerInstanceId: 'fixture-local',
            title: 'Native reviewer',
            nativeSessionId: 'private-child-thread',
          },
          executionState: 'running',
        },
      },
    }));
    const child = journal.execution('execution-child-1');
    assert.equal(child?.ownership, 'native');
    assert.equal(child?.state, 'idle');
    assert.equal(child?.outcome, 'completed');
    assert.equal(child?.transcriptAvailable, true);
    assert.equal(journal.turn('turn-child-1')?.executionId, 'execution-child-1');
    assert.deepEqual(journal.turn('turn-child-1')?.userContent, [
      { type: 'text', text: 'Inspect the native child.' },
    ]);
    assert.doesNotMatch(JSON.stringify(child), /private-child-thread/u);
    const restoredTree = journal.nativeChildBindings('execution-1', 'native-root-thread');
    assert.deepEqual(restoredTree.map(({ executionId, parentExecutionId, nativeParentThreadId }) =>
      [executionId, parentExecutionId, nativeParentThreadId]), [
      ['execution-child-1', 'execution-1', 'native-root-thread'],
      ['execution-grandchild-1', 'execution-child-1', 'private-child-thread'],
    ]);
  } finally {
    journal.close();
  }
});

test('native journal queue is durable FIFO and retains a claim until provider acceptance', () => {
  const journal = createJournal();
  try {
    seedConversation(journal);
    for (let index = 1; index <= 2; index += 1) {
      const commandId = `send-${index}`;
      const turnId = `turn-${index}`;
      journal.claimCommand(commandId, 'turn.send', { index }, index + 1);
      journal.enqueueTurn({
        commandId,
        conversationId: 'conversation-1',
        turnId,
        clientMessageId: `message-${index}`,
        content: [{ type: 'text', text: `Message ${index}` }],
        model: 'fixture-native-v1',
        serviceTier: index === 1 ? 'priority' : 'default',
        access: 'workspace-write',
        now: index + 2,
      });
    }
    assert.deepEqual(journal.queuedMessages('conversation-1').map(({ turnId }) => turnId), [
      'turn-1',
      'turn-2',
    ]);
    assert.equal(journal.turn('turn-1'), undefined, 'queued intent is not transcript history');
    assert.equal(journal.claimQueuedTurn('conversation-1', 10)?.turnId, 'turn-1');
    assert.deepEqual(
      journal.queuedMessages('conversation-1').map(({ turnId, state }) => [turnId, state]),
      [['turn-1', 'dispatching'], ['turn-2', 'queued']],
      'the composer owns the proposal until provider acceptance',
    );
    assert.equal(journal.claimQueuedTurn('conversation-1', 11), undefined,
      'a dispatching head blocks later FIFO entries');
    assert.equal(journal.queuedMessages('conversation-1')[0]?.serviceTier, 'priority');
    assert.equal(journal.admitQueuedTurn('turn-1', 11, 'fixture-native-turn-1')?.turnId, 'turn-1');
    assert.equal(journal.turn('turn-1')?.state, 'running');
    assert.equal(journal.turn('turn-1')?.serviceTier, 'priority',
      'queue admission snapshots the inference tier into transcript history');
    assert.equal(journal.conversation('conversation-1')?.serviceTier, 'priority');
    assert.equal(journal.turn('turn-1')?.nativeTurnId, 'fixture-native-turn-1',
      'provider acceptance binds native identity in the transcript-admission transaction');
    assert.equal(journal.claimQueuedTurn('conversation-1', 12)?.turnId, 'turn-2');
    assert.equal(journal.markQueuedTurnDeliveryUnknown('turn-2'), true);
    assert.equal(journal.queuedMessages('conversation-1')[0]?.state, 'delivery-unknown');
    assert.equal(journal.claimQueuedTurn('conversation-1', 13), undefined,
      'an ambiguous provider delivery is never retried');
    assert.equal(journal.removeQueuedTurnById('conversation-1', 'turn-2', 14), true);
    assert.equal(journal.turn('turn-2'), undefined, 'deleting queued intent creates no history');
  } finally {
    journal.close();
  }
});

test('native journal keeps terminal state monotonic when lifecycle events replay out of order', () => {
  const journal = createJournal();
  try {
    seedConversation(journal);
    journal.createTurn({
      turnId: 'turn-1',
      conversationId: 'conversation-1',
      executionId: 'execution-1',
      clientMessageId: 'message-1',
      commandId: 'send-1',
      content: [{ type: 'text', text: 'Run once.' }],
      model: 'fixture-native-v1',
      state: 'running',
      now: 2,
    });
    journal.appendProviderEvent(event('terminal-first', 4, {
      type: 'turn.completed',
      outcome: 'failed',
      error: { code: 'fixture_failed', message: 'Failed once.' },
    }));
    journal.appendProviderEvent(event('late-start', 3, { type: 'turn.started' }));
    journal.appendProviderEvent(event('late-status', 3, { type: 'turn.status', state: 'running' }));
    journal.appendProviderEvent(event('conflicting-terminal', 5, {
      type: 'turn.completed',
      outcome: 'completed',
    }));
    assert.equal(journal.turn('turn-1')?.state, 'failed');
    assert.equal(journal.conversation('conversation-1')?.state, 'idle');
    assert.equal(journal.execution('execution-1')?.state, 'failed');
    assert.equal(journal.execution('execution-1')?.outcome, 'failed');
  } finally {
    journal.close();
  }
});

test('snapshot replacement and nested journal mutations roll back as one transaction', () => {
  const journal = createJournal();
  try {
    seedConversation(journal);
    journal.database.exec(`
      CREATE TRIGGER reject_snapshot_event
      BEFORE INSERT ON events
      WHEN NEW.event_id = 'snapshot-rejected'
      BEGIN
        SELECT RAISE(ABORT, 'snapshot rejected');
      END
    `);
    assert.throws(() => journal.replaceSnapshot([
      event('snapshot-user', 2, {
        type: 'user.message',
        content: [{ type: 'text', text: 'Imported turn.' }],
      }),
      event('snapshot-rejected', 3, { type: 'turn.started' }),
    ]), /snapshot rejected/iu);
    assert.equal(journal.turn('turn-1'), undefined);
    assert.equal(journal.eventsForConversation('conversation-1').length, 0);
    assert.equal(journal.database.isTransaction, false);
  } finally {
    journal.close();
  }
});

test('authoritative snapshots replace stale live block ordinals after native compaction', () => {
  const journal = createJournal();
  try {
    seedConversation(journal);
    journal.createTurn({
      turnId: 'turn-1', conversationId: 'conversation-1', executionId: 'execution-1',
      clientMessageId: 'message-1', commandId: 'send-1',
      content: [{ type: 'text', text: 'Run through compaction.' }],
      model: 'fixture-native-v1', state: 'running', now: 2,
    });
    const staleLive = event('stale-live-block', 3, {
      type: 'turn.block.completed',
      structure: blockStructure('stale-block', 4),
      revision: 1,
      contentHash: 'a'.repeat(64),
      block: {
        kind: 'reasoning-summary', state: 'completed',
        payload: { kind: 'reasoning-summary', text: 'Pre-compaction detail.' , truncated: false},
      },
    });
    journal.appendProviderEvent(staleLive);
    const retainedLiveCommand = event('retained-live-command', 4, {
      type: 'turn.block.completed',
      structure: blockStructure('retained-command-block', 5),
      revision: 1,
      contentHash: 'd'.repeat(64),
      block: {
        kind: 'tool', state: 'completed',
        payload: {
          kind: 'tool',
          tool: { callId: 'command-1', name: 'shell', category: 'shell', title: 'rg compaction' },
          inputPreview: { command: 'rg compaction' },
        },
      },
    });
    journal.appendProviderEvent(retainedLiveCommand);
    const retainedAfterCompaction = event('retained-after-compaction', 8, {
      type: 'turn.block.completed',
      structure: blockStructure('retained-after-block', 6),
      revision: 1,
      contentHash: 'e'.repeat(64),
      block: {
        kind: 'tool', state: 'completed',
        payload: {
          kind: 'tool',
          tool: { callId: 'command-2', name: 'shell', category: 'shell', title: 'npm test' },
          inputPreview: { command: 'npm test' },
        },
      },
    });
    journal.appendProviderEvent(retainedAfterCompaction);
    const liveSnapshotEdit = event('live-snapshot-edit', 9, {
      type: 'turn.block.completed',
      structure: blockStructure('snapshot-edit-block', 7),
      revision: 1,
      contentHash: 'f'.repeat(64),
      block: {
        kind: 'tool', state: 'completed',
        payload: {
          kind: 'tool',
          tool: { callId: 'edit-1', name: 'file_change', category: 'file', title: 'Edited file.ts' },
          inputPreview: { paths: ['file.ts'] },
        },
      },
    });
    journal.appendProviderEvent(liveSnapshotEdit);

    const summary = event('snapshot-summary', 5, {
      type: 'turn.block.completed',
      structure: blockStructure('snapshot-summary-block', 1),
      revision: 1,
      contentHash: 'b'.repeat(64),
      block: {
        kind: 'reasoning-summary', state: 'completed',
        payload: { kind: 'reasoning-summary', text: 'Compacted summary.' , truncated: false},
      },
    });
    summary.native.position = { kind: 'snapshot-index', itemIndex: 1, subIndex: 0 };
    const marker = event('snapshot-compaction-marker', 6, {
      type: 'turn.block.completed',
      structure: blockStructure('snapshot-compaction-block', 4),
      revision: 1,
      contentHash: 'c'.repeat(64),
      block: {
        kind: 'compatibility-notice', state: 'completed',
        payload: {
          kind: 'compatibility-notice', code: 'context-compaction', message: 'Compacted',
        },
      },
    });
    marker.native.position = { kind: 'snapshot-index', itemIndex: 4, subIndex: 0 };
    const snapshotEdit = event('snapshot-edit', 9, {
      type: 'turn.block.completed',
      structure: blockStructure('snapshot-edit-rewritten-block', 5),
      revision: 1,
      contentHash: 'f'.repeat(64),
      block: {
        kind: 'tool', state: 'completed',
        payload: {
          kind: 'tool',
          tool: {
            callId: 'item-5', name: 'file_change', category: 'file', title: 'Edited file.ts',
          },
          inputPreview: { paths: ['file.ts'] },
        },
      },
    });
    snapshotEdit.native.position = { kind: 'snapshot-index', itemIndex: 5, subIndex: 0 };
    const snapshotFinal = event('snapshot-final', 10, {
      type: 'turn.block.completed',
      structure: blockStructure('snapshot-final-block', 6),
      revision: 1,
      contentHash: '1'.repeat(64),
      block: {
        kind: 'final-message', state: 'completed',
        payload: { kind: 'final-message', text: 'Done.' },
      },
    });
    snapshotFinal.native.position = { kind: 'snapshot-index', itemIndex: 6, subIndex: 0 };
    journal.replaceSnapshot([
      staleLive,
      summary,
      marker,
      snapshotEdit,
      snapshotFinal,
      event('snapshot-terminal', 11, { type: 'turn.completed', outcome: 'completed' }),
    ]);

    let blocks = journal.orderedPasses('turn-1').flatMap((pass) => pass.blocks);
    assert.deepEqual(blocks.map(({ blockId, ordinal }) => [blockId, ordinal]), [
      ['snapshot-summary-block', 0],
      ['retained-command-block', 1],
      ['snapshot-compaction-block', 2],
      ['snapshot-edit-rewritten-block', 3],
      ['retained-after-block', 4],
      ['snapshot-final-block', 5],
    ]);
    assert.equal(blocks.some(({ blockId }) => blockId === 'stale-block'), false,
      'superseded live reasoning must not be retained');
    assert.equal(journal.turn('turn-1')?.state, 'completed');
    assert.equal(journal.orderedPasses('turn-1')[0]?.state, 'completed');
    assert.ok(journal.eventsForTurn('turn-1').some(({ eventId }) =>
      eventId === 'stale-live-block'), 'raw event history remains append-only');

    journal.replaceSnapshot([
      summary,
      marker,
      snapshotEdit,
      snapshotFinal,
      event('snapshot-terminal', 11, { type: 'turn.completed', outcome: 'completed' }),
    ]);
    blocks = journal.orderedPasses('turn-1').flatMap((pass) => pass.blocks);
    assert.deepEqual(blocks.map(({ blockId, ordinal }) => [blockId, ordinal]), [
      ['snapshot-summary-block', 0],
      ['retained-command-block', 1],
      ['snapshot-compaction-block', 2],
      ['snapshot-edit-rewritten-block', 3],
      ['retained-after-block', 4],
      ['snapshot-final-block', 5],
    ], 'repeated hydration must not duplicate retained live actions');
    assert.equal(journal.orderedPasses('turn-1')[0]?.state, 'completed');
  } finally {
    journal.close();
  }
});

test('authoritative snapshot replay canonicalizes duplicate block ordinals within a pass', () => {
  const journal = createJournal();
  try {
    seedConversation(journal);
    journal.createTurn({
      turnId: 'turn-1', conversationId: 'conversation-1', executionId: 'execution-1',
      clientMessageId: 'message-1', commandId: 'send-1', content: [{ type: 'text', text: 'Recover.' }],
      model: 'fixture-native-v1', state: 'running', now: 2,
    });
    const snapshotBlock = (id: string, itemIndex: number, text: string) => {
      const envelope = event(id, 3 + itemIndex, {
        type: 'turn.block.completed', structure: blockStructure(`block-${id}`, 0),
        revision: 1, contentHash: id.repeat(64).slice(0, 64),
        block: { kind: 'reasoning-summary', state: 'completed',
          payload: { kind: 'reasoning-summary', text, truncated: false } },
      });
      envelope.native.position = { kind: 'snapshot-index', itemIndex, subIndex: 0 };
      return envelope;
    };
    journal.replaceSnapshot([
      snapshotBlock('a', 0, 'First snapshot block.'),
      snapshotBlock('b', 1, 'Second snapshot block with the same proposed ordinal.'),
    ]);
    assert.deepEqual(journal.orderedPasses('turn-1')[0]?.blocks.map(({ blockId, ordinal }) =>
      [blockId, ordinal]), [['block-a', 0], ['block-b', 1]]);
  } finally {
    journal.close();
  }
});

test('snapshot coverage preserves journal-only tool blocks until the provider claims completeness', () => {
  const journal = createJournal();
  try {
    seedConversation(journal);
    journal.createTurn({
      turnId: 'turn-1', conversationId: 'conversation-1', executionId: 'execution-1',
      clientMessageId: 'message-1', commandId: 'send-1',
      content: [{ type: 'text', text: 'Inspect and edit the file.' }],
      model: 'fixture-native-v1', state: 'running', now: 2,
    });
    const liveTool = event('live-tool', 4, {
      type: 'turn.block.completed',
      structure: blockStructure('live-tool-block', 1),
      revision: 1,
      contentHash: 'a'.repeat(64),
      block: {
        kind: 'tool', state: 'completed',
        payload: {
          kind: 'tool',
          tool: { callId: 'read-1', name: 'read_file', category: 'file', title: 'Read file.ts' },
          inputPreview: { paths: ['file.ts'] },
        },
      },
    });
    journal.appendProviderEvent(liveTool);

    const reasoning = event('snapshot-reasoning', 3, {
      type: 'turn.block.completed',
      structure: blockStructure('snapshot-reasoning-block', 0),
      revision: 1,
      contentHash: 'b'.repeat(64),
      block: {
        kind: 'reasoning-summary', state: 'completed',
        payload: { kind: 'reasoning-summary', text: 'Inspecting the file.' , truncated: false},
      },
    });
    reasoning.native.position = { kind: 'snapshot-index', itemIndex: 0, subIndex: 0 };
    const commentary = event('snapshot-commentary', 5, {
      type: 'turn.block.completed',
      structure: blockStructure('snapshot-commentary-block', 2),
      revision: 1,
      contentHash: 'c'.repeat(64),
      block: {
        kind: 'commentary', state: 'completed',
        payload: { kind: 'commentary', text: 'The file needs one change.' },
      },
    });
    commentary.native.position = { kind: 'snapshot-index', itemIndex: 2, subIndex: 0 };
    const final = event('snapshot-final-without-tool', 6, {
      type: 'turn.block.completed',
      structure: blockStructure('snapshot-final-block', 3),
      revision: 1,
      contentHash: 'd'.repeat(64),
      block: {
        kind: 'final-message', state: 'completed',
        payload: { kind: 'final-message', text: 'Done.' },
      },
    });
    final.native.position = { kind: 'snapshot-index', itemIndex: 3, subIndex: 0 };
    const terminal = event('snapshot-terminal-without-tool', 7, {
      type: 'turn.completed', outcome: 'completed',
    });
    const partialCoverage = {
      turnBlocks: {
        completeKinds: [
          'reasoning-summary', 'commentary', 'final-message', 'compatibility-notice',
        ] as const,
      },
    };

    journal.replaceSnapshot([reasoning, commentary, final, terminal], partialCoverage);
    let blockIds = journal.orderedPasses('turn-1').flatMap((pass) => pass.blocks)
      .map(({ blockId }) => blockId);
    assert.deepEqual(blockIds, [
      'snapshot-reasoning-block',
      'live-tool-block',
      'snapshot-commentary-block',
      'snapshot-final-block',
    ]);

    journal.replaceSnapshot([reasoning, commentary, final, terminal], partialCoverage);
    blockIds = journal.orderedPasses('turn-1').flatMap((pass) => pass.blocks)
      .map(({ blockId }) => blockId);
    assert.equal(blockIds.filter((blockId) => blockId === 'live-tool-block').length, 1,
      'repeated partial hydration must not duplicate retained journal activity');

    journal.replaceSnapshot([reasoning, commentary, final, terminal], {
      turnBlocks: { completeKinds: ['tool'] },
    });
    blockIds = journal.orderedPasses('turn-1').flatMap((pass) => pass.blocks)
      .map(({ blockId }) => blockId);
    assert.deepEqual(blockIds, [
      'snapshot-reasoning-block',
      'snapshot-commentary-block',
      'snapshot-final-block',
    ], 'complete tool coverage makes omission authoritative');
  } finally {
    journal.close();
  }
});

test('closing without a native terminal event records recovery_failed instead of inferred interruption', () => {
  const journal = createJournal();
  try {
    seedConversation(journal);
    journal.createFederatedExecution({
      executionId: 'execution-child-close',
      conversationId: 'conversation-1',
      parentExecutionId: 'execution-1',
      rootTurnId: 'turn-root',
      provider: 'fixture',
      providerInstanceId: 'fixture-local',
      model: 'fixture-native-v1',
      access: 'read-only',
      scheduling: 'background',
      depth: 1,
      title: 'Close without terminal',
      now: 2,
    });
    journal.bindNativeSession({
      executionId: 'execution-child-close',
      nativeSession: {
        provider: 'fixture',
        providerInstanceId: 'fixture-local',
        sessionId: 'fixture-child-close',
      },
      adapterVersion: 'adapter-1',
      now: 3,
    });
    journal.createTurn({
      turnId: 'turn-child-close',
      conversationId: 'conversation-1',
      executionId: 'execution-child-close',
      clientMessageId: 'message-child-close',
      commandId: 'send-child-close',
      content: [{ type: 'text', text: 'Remain ambiguous.' }],
      model: 'fixture-native-v1',
      state: 'running',
      now: 4,
    });
    journal.closeFederatedExecution('execution-child-close', 5);
    assert.equal(journal.turn('turn-child-close')?.outcome, 'recovery_failed');
    assert.equal(journal.execution('execution-child-close')?.outcome, 'recovery_failed');
    const nativeSession = journal.database.prepare(`
      SELECT state FROM native_sessions WHERE execution_id = 'execution-child-close'
    `).get() as { state: string };
    assert.equal(nativeSession.state, 'closed');
  } finally {
    journal.close();
  }
});

test('account usage replaces provider reads and merges sparse provider pushes durably', () => {
  const journal = createJournal();
  try {
    seedConversation(journal);
    assert.equal(journal.appendProviderEvent(accountUsageEvent('usage-read-1', 10, 'provider-read', [
      ['five-hour', 20],
      ['weekly', 40],
    ])), true);
    assert.equal(journal.appendProviderEvent(accountUsageEvent('usage-push-1', 11, 'provider-push', [
      ['five-hour', 25],
    ])), true);
    assert.deepEqual(journal.providerAccountUsage('fixture-local')?.windows.map(({ id, usedPercent }) => [
      id,
      usedPercent,
    ]), [
      ['five-hour', 25],
      ['weekly', 40],
    ]);

    assert.equal(journal.appendProviderEvent(accountUsageEvent('usage-read-2', 12, 'provider-read', [
      ['five-hour', 30],
    ])), true);
    assert.deepEqual(journal.providerAccountUsage('fixture-local')?.windows.map(({ id, usedPercent }) => [
      id,
      usedPercent,
    ]), [['five-hour', 30]]);

    assert.equal(journal.appendProviderEvent(accountUsageEvent('stale-usage-push', 9, 'provider-push', [
      ['weekly', 99],
    ])), true);
    assert.deepEqual(journal.providerAccountUsage('fixture-local')?.windows.map(({ id, usedPercent }) => [
      id,
      usedPercent,
    ]), [['five-hour', 30]], 'an older sparse push cannot replace the current snapshot');

    journal.markPersistedUsageCached();
    assert.equal(journal.providerAccountUsage('fixture-local')?.freshness, 'cached');
  } finally {
    journal.close();
  }
});

test('preparing branch destinations stay hidden and restart recovery fails them closed', () => {
  const journal = createJournal();
  try {
    seedConversation(journal);
    journal.createTurn({
      turnId: 'turn-1',
      conversationId: 'conversation-1',
      executionId: 'execution-1',
      clientMessageId: 'message-1',
      commandId: 'send-1',
      content: [{ type: 'text', text: 'Keep this boundary.' }],
      model: 'fixture-native-v1',
      state: 'queued',
      now: 2,
    });
    journal.upsertNativeTurnBinding({
      providerInstanceId: 'fixture-local',
      executionId: 'execution-1',
      turnId: 'turn-1',
      nativeTurnId: 'native-turn-1',
      state: 'authoritative',
      now: 3,
    });
    const sourcePath = journal.activePathEntryForTurn('conversation-1', 'turn-1');
    assert.ok(sourcePath);
    journal.claimCommand('branch-1', 'conversation.fork', { source: sourcePath.pathEntryId }, 4);
    journal.createConversation({
      conversationId: 'conversation-child',
      rootExecutionId: 'execution-child',
      strandId: 'strand-child',
      provider: 'fixture',
      providerInstanceId: 'fixture-local',
      title: 'Child',
      cwd: '/workspace/remux',
      model: 'fixture-native-v1',
      access: 'workspace-write',
      parentConversationId: 'conversation-1',
      rootConversationId: 'conversation-1',
      forkedFromPathEntryId: sourcePath.pathEntryId,
      strandState: 'preparing',
      now: 5,
    });
    journal.createBranchOperation({
      operationId: 'operation-1',
      commandId: 'branch-1',
      mode: 'fork',
      sourceConversationId: 'conversation-1',
      sourceStrandId: sourcePath.strandId,
      sourcePathEntryId: sourcePath.pathEntryId,
      expectedHeadRevision: 1,
      destinationConversationId: 'conversation-child',
      destinationStrandId: 'strand-child',
      destinationExecutionId: 'execution-child',
      now: 5,
    });

    assert.deepEqual(journal.conversations().map(({ conversationId }) => conversationId), [
      'conversation-1',
    ]);
    assert.equal(journal.conversation('conversation-1')?.childCount, 0);
    assert.equal(journal.failInterruptedBranchOperations(6), 1);
    assert.equal(journal.strand('strand-child')?.state, 'failed');
    const operation = journal.database.prepare(`
      SELECT state FROM branch_operations WHERE operation_id = 'operation-1'
    `).get() as { state: string };
    assert.equal(operation.state, 'failed');
    assert.deepEqual(journal.conversations().map(({ conversationId }) => conversationId), [
      'conversation-1',
    ]);
  } finally {
    journal.close();
  }
});

test('conversation history reports the last sent message without treating reads or configuration as activity', () => {
  const journal = createJournal();
  try {
    seedConversation(journal);
    assert.equal(journal.conversation('conversation-1')?.lastUsedModel, null);
    assert.equal(journal.conversation('conversation-1')?.lastActivityAt, 1);

    journal.claimCommand('send-1', 'turn.send', { message: 'first' }, 2);
    journal.createTurn({
      turnId: 'turn-1',
      conversationId: 'conversation-1',
      executionId: 'execution-1',
      clientMessageId: 'message-1',
      commandId: 'send-1',
      content: [{ type: 'text', text: 'Use the first model.' }],
      model: 'fixture-model-used',
      state: 'running',
      now: 3,
    });
    journal.updateConversationConfiguration('conversation-1', 'fixture-model-next', undefined, 10);

    const afterConfiguration = journal.conversation('conversation-1');
    assert.equal(afterConfiguration?.model, 'fixture-model-next');
    assert.equal(afterConfiguration?.lastUsedModel, 'fixture-model-used');
    assert.equal(afterConfiguration?.lastActivityAt, 3);

    journal.claimCommand(
      'native-import-command:turn-2',
      'native.history.import',
      { turnId: 'turn-2' },
      11,
    );
    journal.createTurn({
      turnId: 'turn-2',
      conversationId: 'conversation-1',
      executionId: 'execution-1',
      clientMessageId: 'native-import-message:turn-2',
      commandId: 'native-import-command:turn-2',
      content: [{ type: 'text', text: 'Imported provider history.' }],
      model: 'unproven-provider-default',
      state: 'running',
      now: 12,
    });

    const afterImport = journal.conversations()[0];
    assert.equal(afterImport?.lastUsedModel, 'fixture-model-used');
    assert.equal(afterImport?.lastActivityAt, 3);

    journal.observeConversationHistoryRevision('conversation-1', 'history-r2');
    journal.markConversationHistorySynced('conversation-1', 20, 'history-r2');
    assert.equal(journal.conversation('conversation-1')?.lastActivityAt, 3);
  } finally {
    journal.close();
  }
});

test('compaction controls resolve to their native turn without changing event scope', () => {
  const journal = createJournal();
  try {
    seedConversation(journal);
    journal.createTurn({
      turnId: 'turn-1', conversationId: 'conversation-1', executionId: 'execution-1',
      clientMessageId: 'message-1', commandId: 'send-1',
      content: [{ type: 'text', text: 'Continue through compaction.' }],
      model: 'fixture-native-v1', state: 'running', now: 2,
    });
    journal.appendProviderEvent(event('compact-before-binding', 3, {
      type: 'context.compaction.completed', trigger: 'automatic',
      operationId: 'compact-inline', beforeTokens: 90_000, afterTokens: 10_000,
    }));
    assert.equal(journal.compactionControlEvents('conversation-1')[0]?.boundary.kind,
      'native-unresolved');

    journal.upsertNativeTurnBinding({
      providerInstanceId: 'fixture-local', executionId: 'execution-1', turnId: 'turn-1',
      nativeTurnId: 'fixture-native-turn-1', state: 'authoritative', now: 4,
    });
    const [control] = journal.compactionControlEvents('conversation-1');
    assert.deepEqual(control?.boundary, {
      kind: 'within-turn', turnId: 'turn-1', nativeTurnId: 'fixture-native-turn-1',
    });
    const persisted = journal.eventsForConversation('conversation-1')
      .find(({ eventId }) => eventId === 'compact-before-binding');
    assert.equal(persisted?.scope.kind, 'conversation');
  } finally {
    journal.close();
  }
});

test('dedicated native compaction controls remain between turns', () => {
  const journal = createJournal();
  try {
    seedConversation(journal);
    const compact = event('compact-control', 3, {
      type: 'context.compaction.completed', trigger: 'manual',
      operationId: 'compact-manual', beforeTokens: 50_000, afterTokens: 8_000,
    });
    compact.native.kind = 'control/contextCompaction/completed';
    journal.appendProviderEvent(compact);
    assert.deepEqual(journal.compactionControlEvents('conversation-1')[0]?.boundary, {
      kind: 'between-turns', nativeTurnId: 'fixture-native-turn-1',
    });
  } finally {
    journal.close();
  }
});

test('compaction replay resolves one canonical subject and one structural strand path', () => {
  const journal = createJournal();
  try {
    seedConversation(journal);
    journal.createTurn({
      turnId: 'turn-before', conversationId: 'conversation-1', executionId: 'execution-1',
      clientMessageId: 'message-before', commandId: 'send-before',
      content: [{ type: 'text', text: 'Before.' }], model: 'fixture-native-v1',
      state: 'running', now: 2,
    });
    journal.upsertNativeTurnBinding({
      providerInstanceId: 'fixture-local', executionId: 'execution-1', turnId: 'turn-before',
      nativeTurnId: 'native-before', now: 2,
    });
    journal.createTurn({
      turnId: 'turn-after', conversationId: 'conversation-1', executionId: 'execution-1',
      clientMessageId: 'message-after', commandId: 'send-after',
      content: [{ type: 'text', text: 'After.' }], model: 'fixture-native-v1',
      state: 'running', now: 4,
    });
    journal.upsertNativeTurnBinding({
      providerInstanceId: 'fixture-local', executionId: 'execution-1', turnId: 'turn-after',
      nativeTurnId: 'native-after', now: 4,
    });
    journal.claimCommand('manual-compact-command', 'conversation.compact', {}, 3);
    journal.createManualCompaction({
      operationId: 'manual-compact-operation', commandId: 'manual-compact-command',
      conversationId: 'conversation-1', state: 'running', now: 3,
    });
    const original = event('manual-compact-event', 3, {
      type: 'context.compaction.completed', trigger: 'manual',
      operationId: 'manual-compact-operation', beforeTokens: 80_000, afterTokens: 10_000,
    });
    original.native.kind = 'control/contextCompaction/completed';
    original.native.turnId = 'native-control';
    original.native.subject = {
      kind: 'context-compaction', key: 'fixture:context-compaction:native-control:0',
    };
    original.native.timeline = { previousTurnId: 'native-before', nextTurnId: 'native-after' };
    assert.equal(journal.appendProviderEvent(original), true);

    const replay = structuredClone(original);
    replay.eventId = 'snapshot-replay-event';
    replay.native.sessionId = 'fixture-session-resumed';
    replay.native.itemId = 'rewritten-item-99';
    replay.event = {
      type: 'context.compaction.completed', trigger: 'automatic',
      operationId: 'synthetic-replay-operation', beforeTokens: null, afterTokens: null,
    };
    assert.equal(journal.appendProviderEvent(replay), false);
    const controls = journal.compactionControlEvents('conversation-1');
    assert.equal(controls.length, 1);
    assert.equal(controls[0]?.operationId, 'manual-compact-operation');
    assert.equal(controls[0]?.trigger, 'manual');
    assert.equal(controls[0]?.previousTurnId, 'turn-before');
    assert.equal(controls[0]?.nextTurnId, 'turn-after');
    assert.equal(journal.compactionOperation('synthetic-replay-operation'), undefined);
  } finally {
    journal.close();
  }
});

test('three inherited compaction replays retain their canonical positions instead of moving to the tail', () => {
  const journal = createJournal();
  try {
    seedConversation(journal);
    for (let index = 0; index < 4; index += 1) {
      const turnId = `turn-${index}`;
      journal.createTurn({
        turnId, conversationId: 'conversation-1', executionId: 'execution-1',
        clientMessageId: `message-${index}`, commandId: `send-${index}`,
        content: [{ type: 'text', text: `Turn ${index}.` }], model: 'fixture-native-v1',
        state: 'running', now: 10 + index * 10,
      });
      journal.upsertNativeTurnBinding({
        providerInstanceId: 'fixture-local', executionId: 'execution-1', turnId,
        nativeTurnId: `native-turn-${index}`, now: 10 + index * 10,
      });
    }

    for (let index = 0; index < 3; index += 1) {
      const commandId = `manual-compact-command-${index}`;
      const operationId = `manual-compact-operation-${index}`;
      const subjectKey = `fixture:context-compaction:native-control-${index}:0`;
      journal.claimCommand(commandId, 'conversation.compact', {}, 15 + index * 10);
      journal.createManualCompaction({
        operationId, commandId, conversationId: 'conversation-1',
        state: 'running', now: 15 + index * 10,
      });
      const original = event(`manual-compact-event-${index}`, 15 + index * 10, {
        type: 'context.compaction.completed', trigger: 'manual', operationId,
        beforeTokens: 80_000, afterTokens: 10_000,
      });
      original.native.kind = 'control/contextCompaction/completed';
      original.native.turnId = `native-control-${index}`;
      original.native.subject = { kind: 'context-compaction', key: subjectKey };
      original.native.timeline = {
        previousTurnId: `native-turn-${index}`,
        nextTurnId: `native-turn-${index + 1}`,
      };
      assert.equal(journal.appendProviderEvent(original), true);

      const replay = structuredClone(original);
      replay.eventId = `snapshot-replay-event-${index}`;
      replay.native.sessionId = 'fixture-session-resumed';
      replay.native.itemId = `rewritten-item-${index}`;
      replay.event = {
        type: 'context.compaction.completed', trigger: 'automatic',
        operationId: `synthetic-replay-operation-${index}`,
        beforeTokens: null, afterTokens: null,
      };
      assert.equal(journal.appendProviderEvent(replay), false);
    }

    const controls = journal.compactionControlEvents('conversation-1');
    assert.equal(controls.length, 3);
    assert.deepEqual(controls.map((control) => ({
      operationId: control.operationId,
      trigger: control.trigger,
      previousTurnId: control.previousTurnId,
      nextTurnId: control.nextTurnId,
    })), [0, 1, 2].map((index) => ({
      operationId: `manual-compact-operation-${index}`,
      trigger: 'manual',
      previousTurnId: `turn-${index}`,
      nextTurnId: `turn-${index + 1}`,
    })));
    for (let index = 0; index < 3; index += 1) {
      assert.equal(journal.compactionOperation(`synthetic-replay-operation-${index}`), undefined);
    }
  } finally {
    journal.close();
  }
});

test('schema v11 repairs only a proven command-backed compaction replay and records its audit', () => {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON');
  createNativeAgentSchema(database);
  const journal = new NativeAgentJournal(database);
  try {
    seedConversation(journal);
    journal.claimCommand('manual-command', 'conversation.compact', {}, 3);
    journal.createManualCompaction({
      operationId: 'manual-operation', commandId: 'manual-command',
      conversationId: 'conversation-1', state: 'running', now: 3,
    });
    const manual = event('manual-control', 4, {
      type: 'context.compaction.completed', trigger: 'manual',
      operationId: 'manual-operation', beforeTokens: 80_000, afterTokens: 9_000,
    });
    manual.native.kind = 'control/contextCompaction/completed';
    manual.native.turnId = 'native-control-turn';
    journal.appendProviderEvent(manual);

    const replay = event('snapshot-replay-control', 50, {
      type: 'context.compaction.completed', trigger: 'automatic',
      operationId: 'synthetic-operation', beforeTokens: null, afterTokens: null,
    });
    replay.native.kind = 'control/contextCompaction/completed';
    replay.native.turnId = 'native-control-turn';
    journal.appendProviderEvent(replay);
    assert.equal(journal.compactionControlEvents('conversation-1').length, 2);

    database.prepare(`
      UPDATE provider_instances SET provider = 'codex'
      WHERE provider_instance_id = 'fixture-local'
    `).run();
    database.exec(`
      DROP INDEX conversation_control_subject_state;
      DROP INDEX compaction_operation_subject;
      DROP TABLE strand_control_path;
      PRAGMA user_version = 10;
    `);
    migrateNativeAgentSchema(database, 10, {
      backupPath: '/audit/before-schema-v11.sqlite3', migratedAt: 100,
    });

    const controls = journal.compactionControlEvents('conversation-1');
    assert.equal(controls.length, 1);
    assert.equal(controls[0]?.operationId, 'manual-operation');
    assert.equal(controls[0]?.trigger, 'manual');
    assert.equal(controls[0]?.providerSubjectKey,
      'codex:context-compaction:native-control-turn:0');
    assert.equal(journal.compactionOperation('synthetic-operation'), undefined);
    const auditRow = database.prepare(`
      SELECT value_json FROM meta WHERE key = 'schema_v11_repair'
    `).get() as { value_json: string };
    const audit = JSON.parse(auditRow.value_json) as {
      backupPath: string;
      compaction: { candidateSubjects: number; repairedSubjects: number };
    };
    assert.equal(audit.backupPath, '/audit/before-schema-v11.sqlite3');
    assert.deepEqual(audit.compaction, {
      candidateSubjects: 1,
      repairedSubjects: 1,
      repairs: [{
        conversationId: 'conversation-1',
        providerSubject: 'codex:context-compaction:native-control-turn:0',
        canonicalOperationId: 'manual-operation',
        removedOperationIds: ['synthetic-operation'],
      }],
      ambiguousSubjects: 0,
      ambiguous: [],
    });
  } finally {
    journal.close();
  }
});

test('context usage is scoped to the active root while child reads remain available', () => {
  const journal = createJournal();
  try {
    seedConversation(journal);
    journal.createFederatedExecution({
      executionId: 'execution-child-1', conversationId: 'conversation-1',
      parentExecutionId: 'execution-1', rootTurnId: 'turn-1', provider: 'fixture',
      providerInstanceId: 'fixture-local', model: 'fixture-native-v1', access: 'read-only',
      scheduling: 'background', depth: 1, title: 'Child', now: 2,
    });
    for (const [turnId, executionId] of [['turn-1', 'execution-1'], ['turn-child-1', 'execution-child-1']]) {
      journal.createTurn({
        turnId, conversationId: 'conversation-1', executionId,
        clientMessageId: `message-${turnId}`, commandId: `send-${turnId}`,
        content: [{ type: 'text', text: 'Work.' }], model: 'fixture-native-v1', state: 'running', now: 3,
      });
    }
    journal.appendProviderEvent(event('root-usage', 4, contextUsageEvent(210934, 4)));
    journal.appendProviderEvent(childEvent('child-usage', 5, contextUsageEvent(900000, 5)));
    assert.equal(journal.latestUsage('conversation-1')?.context?.usedTokens, 210934);
    assert.equal(journal.latestUsage('conversation-1', 'turn-child-1')?.context?.usedTokens, 900000);
    journal.appendProviderEvent({
      ...childEvent('child-compact', 6, { type: 'context.compaction.completed', trigger: 'automatic',
        operationId: 'child-compact', beforeTokens: 900000, afterTokens: null }),
      scope: { kind: 'conversation', providerInstanceId: 'fixture-local', conversationId: 'conversation-1', executionId: 'execution-child-1' },
    });
    assert.equal(journal.latestUsage('conversation-1')?.context?.usedTokens, 210934);
    assert.equal(journal.latestUsage('conversation-1', 'turn-child-1')?.context, null);
    journal.appendProviderEvent(event('root-compact', 7, {
      type: 'context.compaction.completed', trigger: 'manual', operationId: 'root-compact',
      beforeTokens: 210934, afterTokens: null,
    }));
    assert.equal(journal.latestUsage('conversation-1')?.context, null);
    journal.appendProviderEvent(event('root-after-compact', 7, contextUsageEvent(40000, 7)));
    assert.equal(journal.latestUsage('conversation-1')?.context?.usedTokens, 40000);
    // A different active strand must never reuse the preceding root's meter.
    journal.database.prepare('UPDATE conversations SET root_execution_id = ? WHERE conversation_id = ?')
      .run('execution-child-1', 'conversation-1');
    assert.equal(journal.latestUsage('conversation-1')?.context, null);
  } finally { journal.close(); }
});

test('legacy Claude context is invalidated on read without rewriting historical usage or cost', () => {
  const journal = createJournal();
  try {
    seedConversation(journal);
    journal.createTurn({
      turnId: 'turn-1', conversationId: 'conversation-1', executionId: 'execution-1',
      clientMessageId: 'message-1', commandId: 'send-1', content: [{ type: 'text', text: 'Work.' }],
      model: 'fixture-native-v1', state: 'running', now: 2,
    });
    const original = event('legacy-claude-usage', 3, contextUsageEvent(1000000, 3));
    original.native.kind = 'result/usage';
    journal.appendProviderEvent(original);
    journal.database.prepare("UPDATE executions SET provider = 'claude-code' WHERE execution_id = 'execution-1'").run();
    assert.equal(journal.latestUsage('conversation-1')?.context, null);
    assert.equal(journal.latestUsage('conversation-1', 'turn-1')?.context, null);
    assert.equal(journal.latestUsage('conversation-1')?.estimatedCost?.usd, 6.22);
    const stored = journal.database.prepare('SELECT usage_json FROM usage_snapshots WHERE event_id = ?')
      .get(original.eventId) as { usage_json: string };
    assert.equal(JSON.parse(stored.usage_json).context.usedTokens, 1000000);
    const fixed = event('fixed-claude-usage', 4, contextUsageEvent(210934, 4));
    fixed.native.kind = 'result/usage-v2';
    journal.appendProviderEvent(fixed);
    assert.equal(journal.latestUsage('conversation-1')?.context?.usedTokens, 210934);
  } finally { journal.close(); }
});

function contextUsageEvent(usedTokens: number, observedAt: number): ProviderEvent {
  return { type: 'turn.usage-updated', usage: {
    turn: null, cumulative: null,
    context: { usedTokens, windowTokens: 1000000, percent: usedTokens / 1000000 * 100,
      measurement: 'derived', freshness: 'live', observedAt, turnId: 'turn-1' },
    estimatedCost: { usd: 6.22, scope: 'runtime-epoch', epochId: 'epoch' },
  } };
}

test('Codex child followup lifecycle survives journal event dedup on one canonical card', () => {
  const journal = createJournal();
  try {
    seedConversation(journal);
    journal.createTurn({ turnId: 'turn-1', conversationId: 'conversation-1', executionId: 'execution-1',
      clientMessageId: 'message-1', commandId: 'send-1', content: [], model: 'fixture-native-v1',
      state: 'running', now: 1 });
    const registry = new CodexChildRegistry();
    const mapper = new CodexEventMapper({ providerInstanceId: 'fixture-local',
      conversationId: 'conversation-1', executionId: 'execution-1', nativeSessionId: 'root-thread',
      childRegistry: registry,
      observedAt: (() => { let now = 2; return () => now++; })() });
    mapper.bindTurn('turn-1', 'native-owner');
    const map = (method: string, params: Record<string, unknown>) =>
      mapper.mapNotification({ method, params });
    journal.appendProviderEvents(map('item/completed', { threadId: 'root-thread', turnId: 'native-owner',
      item: { id: 'spawn-child', type: 'subAgentActivity', kind: 'started', agentThreadId: 'child-thread' } }));
    const childMapper = new CodexEventMapper({ providerInstanceId: 'fixture-local',
      conversationId: 'conversation-1',
      executionId: codexStableChildExecutionId('execution-1', 'child-thread'),
      nativeSessionId: 'child-thread', childRegistry: registry,
      observedAt: (() => { let now = 20; return () => now++; })() });
    childMapper.expectTurn(codexStableNativeTurnId('attempt-a'));
    const startA = map('turn/started', { threadId: 'child-thread', turn: { id: 'attempt-a' } });
    journal.appendProviderEvents(startA);
    journal.appendProviderEvents(childMapper.mapNotification({ method: 'turn/started',
      params: { threadId: 'child-thread', turn: { id: 'attempt-a' } } }));
    journal.appendProviderEvents(map('item/completed', { threadId: 'root-thread', turnId: 'native-owner',
      item: { id: 'subagent-completed-attempt-a', type: 'subAgentActivity', kind: 'completed',
        agentThreadId: 'child-thread' } }));
    assert.deepEqual(map('turn/completed', { threadId: 'child-thread',
      turn: { id: 'attempt-a', status: 'completed' } }), []);
    journal.appendProviderEvents(childMapper.mapNotification({ method: 'turn/completed',
      params: { threadId: 'child-thread', turn: { id: 'attempt-a', status: 'completed' } } }));
    assert.equal(journal.turn(codexStableNativeTurnId('attempt-a'))?.outcome, 'completed');
    const startB = map('turn/started', { threadId: 'child-thread', turn: { id: 'attempt-b' } });
    assert.notEqual(startA[0]?.eventId, startB[0]?.eventId);
    journal.appendProviderEvents(startB);
    const running = journal.orderedPasses('turn-1').flatMap(({ blocks }) => blocks)
      .find(({ kind }) => kind === 'native-child');
    assert.equal(running?.state, 'running');
    assert.deepEqual(map('turn/started', { threadId: 'child-thread', turn: { id: 'attempt-a' } }), []);
    journal.appendProviderEvents(map('turn/completed', { threadId: 'child-thread',
      turn: { id: 'attempt-b', status: 'completed' } }));
    const completed = journal.orderedPasses('turn-1').flatMap(({ blocks }) => blocks)
      .find(({ kind }) => kind === 'native-child');
    assert.equal(completed?.state, 'completed');
    assert.equal(journal.childExecutions('execution-1').length, 1);
  } finally { journal.close(); }
});

test('I3 repair directives suppress proven phantom blocks during partial snapshot replay', () => {
  const journal = createJournal();
  try {
    seedConversation(journal);
    journal.createTurn({ turnId: 'turn-1', conversationId: 'conversation-1', executionId: 'execution-1',
      clientMessageId: 'message-1', commandId: 'send-1', content: [], model: 'fixture-native-v1',
      state: 'running', now: 1 });
    const phantom = event('historical-phantom', 2, { type: 'turn.block.started',
      structure: blockStructure('phantom-block', 0), block: { kind: 'native-child', state: 'running',
        payload: { kind: 'native-child', child: { executionId: 'phantom-execution', ownership: 'native',
          provider: 'fixture' }, executionState: 'running' } } });
    journal.appendProviderEvent(phantom);
    const canonical = event('historical-canonical-running', 2, { type: 'turn.block.started',
      structure: { passId: 'canonical-pass', blockId: 'canonical-child', passOrdinal: 1, blockOrdinal: 0 },
      block: { kind: 'native-child', state: 'running', payload: { kind: 'native-child',
        child: { executionId: 'canonical-execution', ownership: 'native', provider: 'fixture' },
        executionState: 'running' } } });
    journal.appendProviderEvent(canonical);
    journal.database.prepare('DELETE FROM turn_blocks WHERE block_id = ?').run('phantom-block');
    journal.database.prepare('DELETE FROM turn_passes WHERE pass_id = ?').run('pass-1');
    journal.database.prepare('DELETE FROM executions WHERE execution_id = ?').run('phantom-execution');
    const canonicalOverride = structuredClone(canonical);
    canonicalOverride.eventId = 'repair-canonical-terminal';
    if (canonicalOverride.event.type === 'turn.block.started') {
      assert.equal(canonicalOverride.event.block.payload.kind, 'native-child');
      if (canonicalOverride.event.block.payload.kind !== 'native-child') throw new Error('fixture mismatch');
      canonicalOverride.event = { type: 'turn.block.completed', structure: canonicalOverride.event.structure,
        revision: 1, contentHash: 'b'.repeat(64), block: { kind: 'native-child', state: 'completed',
          payload: { ...canonicalOverride.event.block.payload, executionState: 'idle', outcome: 'completed' } } };
    }
    journal.database.prepare('INSERT INTO meta(key,value_json) VALUES (?,?)').run(
      'repair_i3_native_child_identity_v1', JSON.stringify({ directives: {
        suppressedBlockIds: ['phantom-block'],
        terminalSequence: 2,
        canonicalEnvelope: canonicalOverride,
      } }),
    );
    const assistant = event('snapshot-assistant', 3, { type: 'turn.block.completed',
      structure: { passId: 'canonical-pass', blockId: 'assistant-block', passOrdinal: 0, blockOrdinal: 1 },
      revision: 1, contentHash: 'a'.repeat(64),
      block: { kind: 'final-message', state: 'completed', payload: {
        kind: 'final-message', text: 'Still here.',
      } } });
    assistant.native.position = { kind: 'snapshot-index', itemIndex: 0, subIndex: 0 };
    const replayedPhantom = structuredClone(phantom);
    replayedPhantom.native.position = { kind: 'snapshot-index', itemIndex: 1, subIndex: 0 };
    journal.replaceSnapshot([assistant, replayedPhantom], { turnBlocks: { completeKinds: ['final-message'] } });
    assert.equal(journal.execution('phantom-execution'), undefined);
    assert.equal(journal.orderedPasses('turn-1').flatMap(({ blocks }) => blocks)
      .some(({ blockId }) => blockId === 'phantom-block'), false);
    assert.ok(journal.eventsForTurn('turn-1').some(({ eventId }) => eventId === 'historical-phantom'));
    assert.equal(journal.orderedPasses('turn-1').flatMap(({ blocks }) => blocks)
      .find(({ blockId }) => blockId === 'canonical-child')?.state, 'completed');
    const followup = event('genuine-followup', 10, { type: 'turn.block.revised',
      structure: { passId: 'canonical-pass', blockId: 'canonical-child', passOrdinal: 0, blockOrdinal: 0 },
      revision: 2, contentHash: 'c'.repeat(64), block: { kind: 'native-child', state: 'running',
        payload: { kind: 'native-child', child: { executionId: 'canonical-execution',
          ownership: 'native', provider: 'fixture' }, executionState: 'running' } } });
    journal.appendProviderEvent(followup);
    journal.replaceSnapshot([assistant], { turnBlocks: { completeKinds: ['final-message'] } });
    assert.equal(journal.orderedPasses('turn-1').flatMap(({ blocks }) => blocks)
      .find(({ blockId }) => blockId === 'canonical-child')?.state, 'running');
  } finally { journal.close(); }
});

test('events before durable admission survive live ingestion and replay after completion', () => {
  for (const replayOnly of [false, true]) {
    const journal = createJournal();
    try {
      seedConversation(journal);
      journal.createTurn({
        turnId: 'turn-1', conversationId: 'conversation-1', executionId: 'execution-1',
        clientMessageId: 'message-1', commandId: 'send-1',
        content: [{ type: 'text', text: 'Continue.' }], model: 'fixture-native-v1',
        state: 'running', now: 100,
      });
      const early = [
        event('early-user', 99, { type: 'user.message', content: [{ type: 'text', text: 'Continue.' }] }),
        event('early-start', 99, { type: 'turn.started' }),
        event('early-status', 99, { type: 'turn.status', state: 'running' }),
      ];
      if (!replayOnly) {
        assert.equal(journal.appendProviderEvents(early).length, 3);
        assert.equal(journal.turn('turn-1')?.updatedAt, 100);
      }
      const completed = event('completed', 200, { type: 'turn.completed', outcome: 'completed' });
      journal.appendProviderEvent(completed);
      // Also models repair of the original incident: the initial observations
      // were rejected live, but remain in the provider's session-local snapshot.
      assert.equal(journal.appendProviderEvents([...early, completed]).length, replayOnly ? 3 : 0);
      assert.equal(journal.appendProviderEvents([...early, completed]).length, 0);
      assert.equal(journal.turn('turn-1')?.state, 'completed');
      assert.equal(journal.turn('turn-1')?.updatedAt, 200);
      assert.equal(journal.execution('execution-1')?.state, 'idle');
      assert.equal(journal.execution('execution-1')?.updatedAt, 200);
      assert.equal(journal.conversation('conversation-1')?.activeTurnId, null);
      assert.equal(journal.conversation('conversation-1')?.updatedAt, 200);
      assert.equal(journal.eventsForTurn('turn-1').find(({ eventId }) => eventId === 'early-user')?.observedAt, 99);
    } finally {
      journal.close();
    }
  }
});

test('stale running status cannot overwrite a newer recovering turn', () => {
  const journal = createJournal();
  try {
    seedConversation(journal);
    journal.createTurn({
      turnId: 'turn-1', conversationId: 'conversation-1', executionId: 'execution-1',
      clientMessageId: 'message-1', commandId: 'send-1', content: [],
      model: 'fixture-native-v1', state: 'running', now: 100,
    });
    journal.appendProviderEvent(event('recovering', 200, { type: 'turn.status', state: 'recovering' }));
    journal.appendProviderEvent(event('stale-running', 150, { type: 'turn.status', state: 'running' }));
    assert.equal(journal.turn('turn-1')?.state, 'recovering');
    assert.equal(journal.turn('turn-1')?.updatedAt, 200);
    assert.equal(journal.execution('execution-1')?.state, 'recovering');
    assert.equal(journal.conversation('conversation-1')?.state, 'recovering');
  } finally {
    journal.close();
  }
});

test('completion and compaction observations can precede durable admission', () => {
  const journal = createJournal();
  try {
    seedConversation(journal);
    journal.createTurn({
      turnId: 'turn-1', conversationId: 'conversation-1', executionId: 'execution-1',
      clientMessageId: 'message-1', commandId: 'send-1', content: [],
      model: 'fixture-native-v1', state: 'running', now: 100,
    });
    journal.appendProviderEvent(event('early-completed', 99, { type: 'turn.completed', outcome: 'completed' }));
    assert.equal(journal.turn('turn-1')?.state, 'completed');
    assert.equal(journal.turn('turn-1')?.completedAt, 99);
    assert.equal(journal.turn('turn-1')?.updatedAt, 100);
    assert.equal(journal.execution('execution-1')?.updatedAt, 100);
    assert.equal(journal.conversation('conversation-1')?.updatedAt, 100);

    journal.claimCommand('compact-command', 'conversation.compact', {}, 100);
    journal.createManualCompaction({
      operationId: 'compact-1', commandId: 'compact-command',
      conversationId: 'conversation-1', state: 'running', now: 100,
    });
    journal.appendProviderEvent(event('compact-started', 98, {
      type: 'context.compaction.started', operationId: 'compact-1', trigger: 'manual', beforeTokens: 90_000,
    }));
    journal.appendProviderEvent(event('compact-completed', 99, {
      type: 'context.compaction.completed', operationId: 'compact-1', trigger: 'manual',
      beforeTokens: 90_000, afterTokens: 10_000,
    }));
    assert.equal(journal.compactionOperation('compact-1')?.state, 'completed');
    assert.equal(journal.compactionOperation('compact-1')?.updatedAt, 100);
  } finally {
    journal.close();
  }
});

test('historical imports can predate the conversation and execution records', () => {
  const journal = createJournal();
  try {
    seedConversation(journal);
    const history = [
      event('historical-user', 0, { type: 'user.message', content: [{ type: 'text', text: 'Original prompt.' }] }),
      event('historical-start', 0, { type: 'turn.started' }),
      event('historical-completed', 0, { type: 'turn.completed', outcome: 'completed' }),
    ];
    journal.replaceSnapshot(history);
    journal.replaceSnapshot(history);
    assert.equal(journal.turn('turn-1')?.createdAt, 0);
    assert.equal(journal.turn('turn-1')?.state, 'completed');
    assert.equal(journal.conversation('conversation-1')?.updatedAt, 1);
    assert.equal(journal.execution('execution-1')?.updatedAt, 1);
    journal.appendProviderEvent(event('historical-health', 0, { type: 'session.health', state: 'ready' }));
    assert.equal(journal.conversation('conversation-1')?.state, 'idle');
    assert.equal(journal.execution('execution-1')?.state, 'idle');
    assert.equal(journal.conversation('conversation-1')?.updatedAt, 1);
    assert.equal(journal.execution('execution-1')?.updatedAt, 1);
  } finally {
    journal.close();
  }
});

function createJournal() {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON');
  createNativeAgentSchema(database);
  return new NativeAgentJournal(database);
}

function seedConversation(journal: NativeAgentJournal) {
  journal.upsertProviderInstance({
    providerInstanceId: 'fixture-local',
    provider: 'fixture',
    label: 'Fixture',
    probe: { state: 'ready', displayLabel: 'Fixture', capabilities },
    now: 1,
  });
  journal.createConversation({
    conversationId: 'conversation-1',
    rootExecutionId: 'execution-1',
    provider: 'fixture',
    providerInstanceId: 'fixture-local',
    title: 'New chat',
    cwd: '/workspace/remux',
    model: 'fixture-native-v1',
    access: 'workspace-write',
    now: 1,
  });
  journal.bindNativeSession({
    executionId: 'execution-1',
    nativeSession: {
      provider: 'fixture',
      providerInstanceId: 'fixture-local',
      sessionId: 'fixture-session-1',
      resumeCursor: { sequence: 0 },
    },
    adapterVersion: 'adapter-1',
    now: 1,
  });
}

function event(eventId: string, observedAt: number, providerEvent: ProviderEvent): ProviderEventEnvelope {
  const scope = providerEvent.type.startsWith('session.') || providerEvent.type.startsWith('context.compaction.')
    ? {
        kind: 'conversation' as const,
        providerInstanceId: 'fixture-local',
        conversationId: 'conversation-1',
        executionId: 'execution-1',
      }
    : {
        kind: 'turn' as const,
        providerInstanceId: 'fixture-local',
        conversationId: 'conversation-1',
        executionId: 'execution-1',
        turnId: 'turn-1',
      };
  return {
    contractVersion: PROVIDER_RUNTIME_CONTRACT_VERSION,
    eventId,
    provider: 'fixture',
    scope,
    native: {
      sessionId: 'fixture-session-1',
      turnId: 'fixture-native-turn-1',
      position: { kind: 'native-sequence', sequence: observedAt, subIndex: 0 },
      kind: providerEvent.type,
    },
    observedAt,
    event: providerEvent,
  };
}

function childEvent(
  eventId: string,
  observedAt: number,
  providerEvent: ProviderEvent,
): ProviderEventEnvelope {
  return {
    contractVersion: PROVIDER_RUNTIME_CONTRACT_VERSION,
    eventId,
    provider: 'fixture',
    scope: {
      kind: 'turn',
      providerInstanceId: 'fixture-local',
      conversationId: 'conversation-1',
      executionId: 'execution-child-1',
      turnId: 'turn-child-1',
    },
    native: {
      sessionId: 'private-child-thread',
      turnId: 'private-child-turn',
      position: { kind: 'native-sequence', sequence: observedAt, subIndex: 0 },
      kind: providerEvent.type,
    },
    observedAt,
    event: providerEvent,
  };
}

function accountUsageEvent(
  eventId: string,
  observedAt: number,
  source: 'provider-read' | 'provider-push',
  windows: readonly (readonly [id: string, usedPercent: number])[],
): ProviderEventEnvelope {
  return {
    contractVersion: PROVIDER_RUNTIME_CONTRACT_VERSION,
    eventId,
    provider: 'fixture',
    scope: { kind: 'account', providerInstanceId: 'fixture-local' },
    native: { kind: 'account/usage' },
    observedAt,
    event: {
      type: 'account.usage-updated',
      usage: {
        availability: 'available',
        windows: windows.map(([id, usedPercent]) => ({
          id,
          label: id === 'weekly' ? 'Weekly' : '5 hour',
          kind: id === 'weekly' ? 'weekly' : 'rolling',
          model: null,
          usedPercent,
          resetsAt: null,
        })),
        source,
        freshness: 'live',
        observedAt,
      },
    },
  };
}

function blockStructure(blockId: string, blockOrdinal: number) {
  return { passId: 'pass-1', blockId, passOrdinal: 0, blockOrdinal };
}

test('journal in-flight owner joins received and dispatching commands and cleans up', async () => {
  const journal = createJournal();
  let releaseReceived!: () => void;
  let releaseDispatching!: () => void;
  const receivedBarrier = new Promise<void>((resolve) => { releaseReceived = resolve; });
  const dispatchingBarrier = new Promise<void>((resolve) => { releaseDispatching = resolve; });
  let owners = 0;
  const request = { commandId: 'async-owner', value: 1 };
  const run = () => journal.runAsyncCommand(request.commandId, 'test.async', request, async () => {
    owners += 1;
    const claim = journal.claimCommand(request.commandId, 'test.async', request, 1);
    if (claim.receipt.state === 'accepted') return claim.receipt.result as { accepted: true; owner: number };
    await receivedBarrier;
    journal.markCommandDispatching(request.commandId, 2);
    await dispatchingBarrier;
    const result = { accepted: true as const, owner: owners };
    journal.acceptCommand(request.commandId, result, 3);
    return result;
  });
  try {
    const first = run();
    assert.equal(journal.commandReceipt(request.commandId)?.state, 'received');
    const duringReceived = run();
    await assert.rejects(() => journal.runAsyncCommand(
      request.commandId, 'test.async', { ...request, value: 2 }, async () => 'wrong'),
    /reused with different input/u);
    await assert.rejects(() => journal.runAsyncCommand(
      request.commandId, 'test.other', request, async () => 'wrong'),
    /reused with different input/u);
    releaseReceived();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(journal.commandReceipt(request.commandId)?.state, 'dispatching');
    const duringDispatching = run();
    releaseDispatching();
    const values = await Promise.all([first, duringReceived, duringDispatching]);
    assert.deepEqual(values, [values[0], values[0], values[0]]);
    assert.equal(owners, 1);

    assert.deepEqual(await run(), values[0]);
    await assert.rejects(() => journal.runAsyncCommand(
      'sync-failure', 'test.async', { commandId: 'sync-failure' }, () => {
        throw new Error('synchronous owner failure');
      }), /synchronous owner failure/u);
    const recovered = await journal.runAsyncCommand(
      'sync-failure', 'test.async', { commandId: 'sync-failure' }, async () => 'clean');
    assert.equal(recovered, 'clean');
    const [one, two] = await Promise.all([
      journal.runAsyncCommand('independent-1', 'test.async', { id: 1 }, async () => 1),
      journal.runAsyncCommand('independent-2', 'test.async', { id: 2 }, async () => 2),
    ]);
    assert.deepEqual([one, two], [1, 2]);
    let rejectOwner!: () => void;
    const rejectBarrier = new Promise<void>((resolve) => { rejectOwner = resolve; });
    const failureRequest = { commandId: 'async-failure' };
    const failingBody = async () => {
      const claim = journal.claimCommand(
        failureRequest.commandId, 'test.async', failureRequest, 4);
      if (claim.receipt.state === 'rejected') {
        throw new Error(claim.receipt.errorMessage ?? 'missing durable failure');
      }
      await rejectBarrier;
      journal.rejectCommand(failureRequest.commandId, 'shared asynchronous failure', 5);
      throw new Error('shared asynchronous failure');
    };
    const failureOne = journal.runAsyncCommand(
      failureRequest.commandId, 'test.async', failureRequest, failingBody);
    const failureTwo = journal.runAsyncCommand(
      failureRequest.commandId, 'test.async', failureRequest, failingBody);
    rejectOwner();
    await Promise.all([
      assert.rejects(failureOne, /shared asynchronous failure/u),
      assert.rejects(failureTwo, /shared asynchronous failure/u),
    ]);
    await assert.rejects(() => journal.runAsyncCommand(
      failureRequest.commandId, 'test.async', failureRequest, failingBody),
    /shared asynchronous failure/u);
  } finally {
    journal.close();
  }
});

test('a synchronous claim cannot collide with an async owner before its receipt exists', async () => {
  const journal = createJournal();
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const request = { commandId: 'future-claim', value: 'owned' };
  try {
    const owner = journal.runAsyncCommand(request.commandId, 'future.async', request, async () => {
      await barrier;
      journal.claimCommand(request.commandId, 'future.async', request, 2);
      const result = { accepted: true as const };
      journal.acceptCommand(request.commandId, result, 3);
      return result;
    });
    assert.equal(journal.commandReceipt(request.commandId), undefined);
    assert.throws(() => journal.claimCommand(
      request.commandId,
      'queue.remove',
      { commandId: request.commandId, value: 'sync-collision' },
      1,
    ), /reused with different input/u);
    assert.equal(journal.commandReceipt(request.commandId), undefined);
    release();
    assert.deepEqual(await owner, { accepted: true });
    assert.equal(journal.commandReceipt(request.commandId)?.state, 'accepted');
  } finally {
    journal.close();
  }
});

test('checkout reservations preserve writer conflicts and scope null-key unknown fencing', () => {
  const journal = createJournal();
  seedConversation(journal);
  const create = (executionId: string, commandId: string, access: 'read-only' | 'workspace-write' | 'full-access',
    scheduling: 'background' | 'foreground') => {
    journal.claimCommand(commandId, 'federation.spawn', { commandId }, 2);
    journal.createFederatedExecution({ executionId, conversationId: 'conversation-1',
      parentExecutionId: 'execution-1', rootTurnId: 'root-turn', provider: 'fixture',
      providerInstanceId: 'fixture-local', model: 'fixture-native-v1', checkoutKey: 'test:one',
      access: access === 'full-access' ? 'workspace-write' : access,
      scheduling, depth: 1, title: executionId, now: 2 });
    if (access === 'full-access') journal.database.prepare(
      `UPDATE executions SET access='full-access' WHERE execution_id=?`).run(executionId);
  };
  try {
    create('writer-1', 'reserve-1', 'full-access', 'foreground');
    journal.reserveFederatedCheckout({ executionId: 'writer-1', checkoutKey: 'test:one',
      commandId: 'reserve-1', expectedTurnId: 'future-1', access: 'full-access',
      scheduling: 'foreground', now: 3 });
    create('writer-2', 'reserve-2', 'workspace-write', 'foreground');
    assert.throws(() => journal.reserveFederatedCheckout({ executionId: 'writer-2',
      checkoutKey: 'test:one', commandId: 'reserve-2', expectedTurnId: 'future-2',
      access: 'workspace-write', scheduling: 'foreground', now: 3 }), /writer is already active/u);
    journal.createFederatedExecution({ executionId: 'legacy', conversationId: 'conversation-1',
      parentExecutionId: 'execution-1', rootTurnId: 'root-turn', provider: 'fixture',
      providerInstanceId: 'fixture-local', model: 'fixture-native-v1', access: 'read-only',
      scheduling: 'background', depth: 1, title: 'legacy', now: 4 });
    journal.database.prepare(`INSERT INTO federation_checkout_reservations(
      execution_id,checkout_key,command_id,expected_turn_id,access,scheduling,state,created_at,updated_at
    ) VALUES ('legacy',NULL,NULL,NULL,'read-only','background','unknown',4,4)`).run();
    create('foreground-reader', 'reserve-3', 'read-only', 'foreground');
    journal.reserveFederatedCheckout({ executionId: 'foreground-reader', checkoutKey: 'test:two',
      commandId: 'reserve-3', expectedTurnId: 'future-3', access: 'read-only',
      scheduling: 'foreground', now: 5 });
    create('background-reader', 'reserve-4', 'read-only', 'background');
    assert.throws(() => journal.reserveFederatedCheckout({ executionId: 'background-reader',
      checkoutKey: 'test:two', commandId: 'reserve-4', expectedTurnId: 'future-4',
      access: 'read-only', scheduling: 'background', now: 5 }), /reader limit exceeded/u);
  } finally {
    journal.close();
  }
});

test('startup checkout capture reactivates a released failed owner with a known writable native descendant', () => {
  const journal = createJournal();
  seedConversation(journal);
  try {
    journal.claimCommand('parent-command', 'federation.spawn', { id: 'parent' }, 2);
    journal.createFederatedExecution({ executionId: 'federated-parent', conversationId: 'conversation-1',
      parentExecutionId: 'execution-1', rootTurnId: 'root-turn', provider: 'fixture',
      providerInstanceId: 'fixture-local', model: 'fixture-native-v1', checkoutKey: 'test:stable',
      access: 'workspace-write', scheduling: 'foreground', depth: 1, title: 'parent', now: 2 });
    journal.reserveFederatedCheckout({ executionId: 'federated-parent', checkoutKey: 'test:stable',
      commandId: 'parent-command', expectedTurnId: 'parent-turn', access: 'workspace-write',
      scheduling: 'foreground', now: 3 });
    assert.equal(journal.releaseFederatedCheckout({ executionId: 'federated-parent',
      commandId: 'parent-command', expectedTurnId: 'parent-turn', reason: 'native-terminal', now: 4 }), true);
    journal.database.prepare(`UPDATE executions SET state='failed' WHERE execution_id='federated-parent'`).run();
    journal.claimCommand('child-command', 'federation.spawn', { id: 'child' }, 4);
    journal.createFederatedExecution({ executionId: 'native-child', conversationId: 'conversation-1',
      parentExecutionId: 'federated-parent', rootTurnId: 'parent-turn', provider: 'fixture',
      providerInstanceId: 'fixture-local', model: 'fixture-native-v1', checkoutKey: 'test:stable',
      access: 'workspace-write', scheduling: 'foreground', depth: 2, title: 'child', now: 4 });
    journal.database.prepare(`UPDATE executions SET ownership='native', federation_scheduling=NULL,
      state='running' WHERE execution_id='native-child'`).run();
    const owner = new FederationCheckoutOwner(journal, async () => ({
      state: 'resolved', value: { checkoutKey: 'test:stable', launchCwd: '/workspace/remux' },
    }));
    const captured = owner.captureStartupOwners(5);
    assert.ok(captured.some(({ executionId }) => executionId === 'federated-parent'));
    assert.deepEqual({ ...journal.database.prepare(`SELECT state,checkout_key,command_id,expected_turn_id,
        release_reason,released_at FROM federation_checkout_reservations
      WHERE execution_id='federated-parent'`).get() }, {
      state: 'unknown', checkout_key: 'test:stable', command_id: 'parent-command',
      expected_turn_id: 'parent-turn', release_reason: null, released_at: null,
    });
    journal.database.prepare(`UPDATE executions SET state='failed', outcome='recovery_failed'
      WHERE execution_id='native-child'`).run();
    assert.ok(owner.captureStartupOwners(6).some(({ executionId }) => executionId === 'federated-parent'),
      'a session-local recovery failure must retain the ancestor fence');
    journal.createFederatedExecution({ executionId: 'unscoped-legacy', conversationId: 'conversation-1',
      parentExecutionId: 'execution-1', rootTurnId: 'root-turn', provider: 'fixture',
      providerInstanceId: 'fixture-local', model: 'fixture-native-v1', access: 'read-only',
      scheduling: 'foreground', depth: 1, title: 'unscoped', now: 7 });
    const unscoped = owner.captureStartupOwners(7).find(({ executionId }) => executionId === 'unscoped-legacy')!;
    journal.database.prepare(`UPDATE federation_checkout_reservations SET state='released',
      release_reason='native-terminal',released_at=8,updated_at=8 WHERE execution_id='unscoped-legacy'`).run();
    assert.equal(owner.scopeCapturedStartupOwner(unscoped, 'test:retargeted', 9), false);
    assert.equal(journal.execution('unscoped-legacy')?.checkoutKey, undefined,
      'a lost reservation CAS must not re-key the execution');
  } finally {
    journal.close();
  }
});

test('two journal owners preserve the winning receipt across checkout resolution and stale failure callbacks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'remux-federation-owner-'));
  const path = join(directory, 'agent.sqlite3');
  const seed = new DatabaseSync(path);
  seed.exec('PRAGMA foreign_keys=ON');
  createNativeAgentSchema(seed);
  seed.close();
  const first = new NativeAgentJournal(new DatabaseSync(path, { timeout: 5_000 }));
  const second = new NativeAgentJournal(new DatabaseSync(path, { timeout: 5_000 }));
  seedConversation(first);
  const resolver = async () => ({ state: 'resolved' as const,
    value: { checkoutKey: 'test:shared', launchCwd: '/workspace/remux' } });
  const firstOwner = new FederationCheckoutOwner(first, resolver);
  const secondOwner = new FederationCheckoutOwner(second, resolver);
  const request = { commandId: 'shared-command' };
  try {
    const [firstCheckout, secondCheckout] = await Promise.all([
      firstOwner.resolveNew('shared-command', 'federation.spawn', request, '/workspace/remux', 2),
      secondOwner.resolveNew('shared-command', 'federation.spawn', request, '/workspace/remux', 2),
    ]);
    const create = () => first.createFederatedExecution({ executionId: 'shared-execution',
      conversationId: 'conversation-1', parentExecutionId: 'execution-1', rootTurnId: 'root-turn',
      provider: 'fixture', providerInstanceId: 'fixture-local', model: 'fixture-native-v1',
      checkoutKey: 'test:shared', access: 'workspace-write', scheduling: 'foreground', depth: 1,
      title: 'shared', now: 2 });
    assert.ok('value' in firstOwner.claimAndReserve({ commandId: 'shared-command', kind: 'federation.spawn',
      request, executionId: 'shared-execution', expectedTurnId: 'turn-a', checkout: firstCheckout,
      access: 'workspace-write', scheduling: 'foreground', now: 2, validateAndCreate: create }));
    const losing = secondOwner.claimAndReserve({ commandId: 'shared-command', kind: 'federation.spawn',
      request, executionId: 'shared-execution', expectedTurnId: 'turn-a', checkout: secondCheckout,
      access: 'workspace-write', scheduling: 'foreground', now: 3,
      validateAndCreate: () => { throw new Error('loser callback must not run'); } });
    assert.ok('receipt' in losing && losing.receipt.state === 'received');
    first.markCommandDispatching('shared-command', 3);
    assert.equal(secondOwner.beforeDispatchFailure('shared-execution', 'shared-command', 'stale-turn',
      'stale failure', 4), false);
    assert.equal(second.commandReceipt('shared-command')?.state, 'dispatching');
    const conflictingRequest = { commandId: 'conflicting-writer' };
    const conflictingCheckout = await secondOwner.resolveNew('conflicting-writer', 'federation.spawn',
      conflictingRequest, '/workspace/remux', 4);
    assert.throws(() => secondOwner.claimAndReserve({ commandId: 'conflicting-writer',
      kind: 'federation.spawn', request: conflictingRequest, executionId: 'rolled-back-child',
      expectedTurnId: 'rolled-back-turn', checkout: conflictingCheckout, access: 'workspace-write',
      scheduling: 'foreground', now: 4, validateAndCreate: () => second.createFederatedExecution({
        executionId: 'rolled-back-child', conversationId: 'conversation-1',
        parentExecutionId: 'execution-1', rootTurnId: 'root-turn', provider: 'fixture',
        providerInstanceId: 'fixture-local', model: 'fixture-native-v1', checkoutKey: 'test:shared',
        access: 'workspace-write', scheduling: 'foreground', depth: 1, title: 'loser', now: 4,
      }) }), /writer is already active/u);
    assert.equal(second.execution('rolled-back-child'), undefined);
    assert.equal(second.commandReceipt('conflicting-writer')?.state, 'rejected');
    first.acceptCommand('shared-command', { accepted: true, executionId: 'shared-execution' }, 5);
    const failingOwner = new FederationCheckoutOwner(second, async () => ({
      state: 'indeterminate', reason: 'cwd disappeared',
    }));
    await assert.rejects(
      failingOwner.resolveNew('shared-command', 'federation.spawn', request, '/deleted', 6),
      (error: unknown) => error instanceof Error &&
        'receipt' in error && (error as { receipt: { state: string } }).receipt.state === 'accepted');
  } finally {
    first.close();
    second.close();
    await rm(directory, { recursive: true, force: true });
  }
});
