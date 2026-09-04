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
import { createNativeAgentSchema } from '../server/src/native-runtime/schema.ts';
import { prepareAgentDataPaths } from '../server/src/storage/data-root.ts';
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
          },
          executionState: 'running',
        },
      },
    }));
    journal.appendProviderEvent(event('child-completed', 5, {
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
    assert.doesNotMatch(JSON.stringify(child), /private-child-thread/u);
  } finally {
    journal.close();
  }
});

test('native journal queue is durable FIFO and ambiguous dispatch is never retried', () => {
  const journal = createJournal();
  try {
    seedConversation(journal);
    for (let index = 1; index <= 2; index += 1) {
      const commandId = `send-${index}`;
      const turnId = `turn-${index}`;
      journal.claimCommand(commandId, 'turn.send', { index }, index + 1);
      journal.createTurn({
        turnId,
        conversationId: 'conversation-1',
        executionId: 'execution-1',
        clientMessageId: `message-${index}`,
        commandId,
        content: [{ type: 'text', text: `Message ${index}` }],
        model: 'fixture-native-v1',
        state: 'queued',
        now: index + 2,
      });
      journal.enqueueTurn({
        commandId,
        conversationId: 'conversation-1',
        turnId,
        clientMessageId: `message-${index}`,
        content: [{ type: 'text', text: `Message ${index}` }],
        model: 'fixture-native-v1',
        now: index + 2,
      });
    }
    assert.deepEqual(journal.queuedMessages('conversation-1').map(({ turnId }) => turnId), [
      'turn-1',
      'turn-2',
    ]);
    assert.equal(journal.dequeueTurn('conversation-1', 10)?.turnId, 'turn-1');
    journal.markCommandDispatching('send-1', 11);
    assert.equal(journal.markAmbiguousCommandsForRecovery(12), 1);
    assert.equal(journal.commandReceipt('send-1')?.state, 'recovery_failed');
    assert.equal(journal.dequeueTurn('conversation-1', 13)?.turnId, 'turn-2');
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
        payload: { kind: 'reasoning-summary', text: 'Pre-compaction detail.' },
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
        payload: { kind: 'reasoning-summary', text: 'Compacted summary.' },
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
        payload: { kind: 'reasoning-summary', text: 'Inspecting the file.' },
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
