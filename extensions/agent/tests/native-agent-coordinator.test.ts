import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { NativeFixtureAdapter } from '../server/src/native-fixture-adapter.ts';
import {
  AsyncEventStream,
  type ProviderAdapter,
  type ProviderLoginOperation,
  type ProviderSession,
} from '../server/src/provider-adapter.ts';
import { NativeAgentCoordinator } from '../server/src/native-runtime/native-coordinator.ts';
import { NativeAgentJournal } from '../server/src/native-runtime/native-journal.ts';
import { createNativeAgentSchema } from '../server/src/native-runtime/schema.ts';
import type { NativeTranscriptWindow } from '../shared/native-agent-protocol.ts';
import type {
  OpenProviderSessionInput,
  ProviderCapabilities,
  ProviderEvent,
  ProviderEventEnvelope,
  ProviderLoginEvent,
  ProviderLoginStartInput,
  UserContentPart,
} from '../shared/provider-runtime.ts';
import { PROVIDER_RUNTIME_CONTRACT_VERSION } from '../shared/provider-runtime.ts';
import { parseProviderEventEnvelope } from '../shared/provider-runtime.ts';

test('native coordinator creates one native session, queues FIFO, and dispatches retry IDs once', async () => {
  const journal = createJournal();
  const adapter = new NativeFixtureAdapter({ delayMs: 5, emitNativeChild: true });
  const terminals: string[] = [];
  const invalidations: string[][] = [];
  let resolveTwo: (() => void) | undefined;
  const twoTerminals = new Promise<void>((resolve) => { resolveTwo = resolve; });
  const coordinator = new NativeAgentCoordinator({
    journal,
    providers: [{
      providerInstanceId: 'fixture-local',
      provider: 'fixture',
      label: 'Fixture',
      adapter,
    }],
    onResourcesInvalidated: (keys) => invalidations.push([...keys]),
    onTerminalTurn: ({ turnId }) => {
      terminals.push(turnId);
      if (terminals.length === 2) resolveTwo?.();
    },
  });
  try {
    await coordinator.initialize();
    const created = await coordinator.createConversation({
      commandId: 'create-1',
      providerInstanceId: 'fixture-local',
      cwd: '/workspace/remux',
      model: 'fixture-native-v1',
      effort: 'high',
      access: 'workspace-write',
    });
    assert.equal(adapter.opened.length, 1);
    assert.deepEqual(await coordinator.createConversation({
      commandId: 'create-1',
      providerInstanceId: 'fixture-local',
      cwd: '/workspace/remux',
      model: 'fixture-native-v1',
      effort: 'high',
      access: 'workspace-write',
    }), created);
    assert.equal(adapter.opened.length, 1);

    const firstInput = configuredMessage(coordinator, {
      commandId: 'send-1',
      conversationId: created.conversationId,
      clientMessageId: 'message-1',
      content: [{ type: 'text' as const, text: 'First.' }],
    });
    const first = await coordinator.sendMessage(firstInput);
    const repeated = await coordinator.sendMessage(structuredClone(firstInput));
    assert.deepEqual(repeated, first);
    const second = await coordinator.sendMessage(configuredMessage(coordinator, {
      commandId: 'send-2',
      conversationId: created.conversationId,
      clientMessageId: 'message-2',
      content: [{ type: 'text', text: 'Second.' }],
    }));
    assert.equal(first.delivery, 'sent');
    assert.equal(second.delivery, 'queued');
    assert.equal(adapter.opened[0]?.providerDispatchCount, 1);
    assert.deepEqual(journal.queuedMessages(created.conversationId).map(({ turnId }) => turnId), [
      second.turnId,
    ]);

    await withTimeout(twoTerminals, 1_000, 'turns timed out');
    assert.equal(adapter.opened[0]?.providerDispatchCount, 2);
    assert.equal(journal.turn(first.turnId)?.state, 'completed');
    assert.equal(journal.turn(second.turnId)?.state, 'completed');
    assert.equal(journal.queuedMessages(created.conversationId).length, 0);
    assert.equal(journal.conversation(created.conversationId)?.state, 'idle');
    assert.ok(invalidations.some((keys) => keys.includes(`agent/turn:${first.turnId}`)));

    const resources = coordinator.projector.read({
      requests: [{ key: `agent/transcript:${created.conversationId}:tail-24` }],
    });
    const transcript = resources.resources[0];
    assert.equal(transcript?.status, 'ok');
    if (transcript?.status === 'ok') {
      const value = transcript.value as NativeTranscriptWindow;
      assert.equal(value.turns.length, 2);
      assert.ok(value.turns.every((turn) => turn.state === 'completed'));
      assert.ok(value.turns[0]?.activity.children.some((child) => child.ownership === 'native'));
    }
  } finally {
    await coordinator.close();
    journal.close();
  }
});

test('conversation Stop is durable, interrupts active work, and preserves the paused queue', async () => {
  const journal = createJournal();
  const adapter = new NativeFixtureAdapter({ delayMs: 200, emitNativeChild: true });
  const coordinator = new NativeAgentCoordinator({
    journal,
    providers: [{ providerInstanceId: 'fixture-local', provider: 'fixture', label: 'Fixture', adapter }],
  });
  try {
    await coordinator.initialize();
    const created = await coordinator.createConversation({
      commandId: 'stop-create', providerInstanceId: 'fixture-local', cwd: '/workspace/remux',
      model: 'fixture-native-v1', access: 'workspace-write',
    });
    const first = await coordinator.sendMessage(configuredMessage(coordinator, {
      commandId: 'stop-first', conversationId: created.conversationId,
      clientMessageId: 'stop-first-message', content: [{ type: 'text', text: 'Keep working.' }],
    }));
    const queued = await coordinator.sendMessage(configuredMessage(coordinator, {
      commandId: 'stop-queued', conversationId: created.conversationId,
      clientMessageId: 'stop-queued-message', content: [{ type: 'text', text: 'Queued work.' }],
    }));
    assert.equal(queued.delivery, 'queued');
    const stopped = await coordinator.interruptConversation({
      commandId: 'stop-command', conversationId: created.conversationId,
    });
    assert.equal(stopped.accepted, true);
    await waitFor(() => journal.turn(first.turnId)?.outcome === 'interrupted');
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(journal.queuedMessages(created.conversationId).map(({ turnId }) => turnId), [queued.turnId]);
    assert.equal(adapter.opened[0]?.providerDispatchCount, 1);
    const runtime = coordinator.projector.runtimeResource(created.conversationId);
    assert.equal(runtime?.lifecycle.stopRequested, false);
    assert.equal(journal.hasConversationQueuePause(created.conversationId), true);

    await coordinator.sendMessage(configuredMessage(coordinator, {
      commandId: 'stop-resume', conversationId: created.conversationId,
      clientMessageId: 'stop-resume-message', content: [{ type: 'text', text: 'Resume.' }],
    }));
    await waitFor(() => adapter.opened[0]?.providerDispatchCount === 3);
  } finally {
    await coordinator.close();
    journal.close();
  }
});

test('accepted child Stop settles from its snapshot when every live terminal is missed', async () => {
  const journal = createJournal();
  const adapter = new NativeFixtureAdapter({ delayMs: 1, emitNativeChild: true,
    nativeChildCompletionDelayMs: 10_000 });
  const coordinator = new NativeAgentCoordinator({
    journal,
    providers: [{ providerInstanceId: 'fixture-local', provider: 'fixture', label: 'Fixture', adapter }],
  });
  try {
    await coordinator.initialize();
    const created = await coordinator.createConversation({
      commandId: 'missed-child-create', providerInstanceId: 'fixture-local', cwd: '/workspace/remux',
      model: 'fixture-native-v1', access: 'workspace-write',
    });
    await coordinator.sendMessage(configuredMessage(coordinator, {
      commandId: 'missed-child-send', conversationId: created.conversationId,
      clientMessageId: 'missed-child-message', content: [{ type: 'text', text: 'Spawn child.' }],
    }));
    const rootExecutionId = journal.conversation(created.conversationId)!.rootExecutionId;
    const childExecutionId = `${rootExecutionId}:native-child-1`;
    await waitFor(() => journal.execution(childExecutionId)?.state === 'running');
    const childSessionId = `${adapter.opened[0]!.nativeSession.sessionId}:child-1`;
    const childTurnId = 'missed-child-remux-turn';
    const childNativeTurnId = 'missed-child-native-turn';
    const envelope = (terminal: boolean) => parseProviderEventEnvelope({
      contractVersion: PROVIDER_RUNTIME_CONTRACT_VERSION,
      eventId: `missed-child-${terminal ? 'terminal' : 'started'}`,
      provider: 'fixture',
      scope: { kind: 'turn', providerInstanceId: 'fixture-local',
        conversationId: created.conversationId, executionId: childExecutionId, turnId: childTurnId },
      native: { sessionId: childSessionId, turnId: childNativeTurnId,
        kind: terminal ? 'turn/completed' : 'turn/started' },
      observedAt: Date.now(),
      event: terminal
        ? { type: 'turn.completed', outcome: 'interrupted' }
        : { type: 'turn.started' },
    });
    journal.appendProviderEvent(envelope(false));
    assert.deepEqual(journal.turn(childTurnId)?.userContent, [],
      'a provider-owned child title is not evidence of its delegated task');
    // A parent snapshot can settle its child card before the child's own
    // terminal turn is observed. The unfinished assignment still requires
    // recovery from the child thread.
    journal.database.prepare(`
      UPDATE executions SET state = 'idle', outcome = 'completed', completed_at = ?, updated_at = ?
      WHERE execution_id = ?
    `).run(Date.now(), Date.now(), childExecutionId);
    assert.equal(journal.execution(childExecutionId)?.state, 'idle');
    assert.equal(journal.turn(childTurnId)?.state, 'running');
    const session = adapter.opened[0]! as typeof adapter.opened[0] & {
      snapshotChild?: (input: unknown) => Promise<unknown>;
    };
    let snapshotCalls = 0;
    session.snapshotChild = async () => {
      snapshotCalls += 1;
      if (snapshotCalls === 1) throw new Error('Authoritative child read temporarily unavailable.');
      return {
        nativeSession: { provider: 'fixture', providerInstanceId: 'fixture-local', sessionId: childSessionId },
        state: 'idle', authority: 'authoritative', events: [envelope(true)],
        coverage: { turnBlocks: { completeKinds: [] } },
      };
    };
    const internals = coordinator as unknown as {
      synchronizeNativeChildHistory(executionId: string): Promise<void>;
    };
    await assert.rejects(() => internals.synchronizeNativeChildHistory(childExecutionId),
      /temporarily unavailable/u);
    assert.equal(journal.execution(childExecutionId)?.state, 'recovering',
      'unfinished child turn overrides the completed parent-card projection');
    await coordinator.interruptExecution({
      commandId: 'missed-child-stop', conversationId: created.conversationId, executionId: childExecutionId,
    });
    const intent = journal.stopLifecycle(created.conversationId).intents[0]!;
    journal.updateStopTarget(String(intent.intent_id), childExecutionId, childTurnId, 'accepted',
      'Stop was accepted, but terminal status could not be verified.', Date.now());
    const followupTurnId = 'missed-child-followup-turn';
    journal.appendProviderEvent(parseProviderEventEnvelope({
      contractVersion: PROVIDER_RUNTIME_CONTRACT_VERSION,
      eventId: 'missed-child-followup-started', provider: 'fixture',
      scope: { kind: 'turn', providerInstanceId: 'fixture-local',
        conversationId: created.conversationId, executionId: childExecutionId, turnId: followupTurnId },
      native: { sessionId: childSessionId, turnId: 'missed-child-followup-native', kind: 'turn/started' },
      observedAt: Date.now(), event: { type: 'turn.started' },
    }));
    await coordinator.interruptExecution({
      commandId: 'missed-child-stop-retry', conversationId: created.conversationId,
      executionId: childExecutionId,
    });
    assert.deepEqual(journal.stopTargets(String(intent.intent_id)).map(({ assignment_turn_id }) =>
      assignment_turn_id), [childTurnId],
    'a repeated Stop does not enroll a newer assignment on the same agent');
    await waitFor(() => journal.turn(childTurnId)?.outcome === 'interrupted', 2_000);
    await waitFor(() => coordinator.projector.runtimeResource(created.conversationId)
      ?.lifecycle.stopRequested === false, 2_000);
    assert.equal(journal.stopLifecycle(created.conversationId).intents.length, 0);
    assert.equal(journal.turn(followupTurnId)?.outcome, undefined);
    assert.notEqual(journal.execution(childExecutionId)?.state, 'interrupted');
    assert.equal(session.childInterrupts.length, 1,
      'an accepted Stop retry reconciles without interrupting the assignment twice');
    assert.equal(snapshotCalls, 2);
  } finally {
    await coordinator.close();
    journal.close();
  }
});

test('async send and Compact commands coalesce while their receipts are received', async () => {
  const journal = createJournal();
  const adapter = new NativeFixtureAdapter({ manualCompaction: true, delayMs: 2 });
  const coordinator = new NativeAgentCoordinator({
    journal,
    providers: [{ providerInstanceId: 'fixture-local', provider: 'fixture', label: 'Fixture', adapter }],
  });
  try {
    await coordinator.initialize();
    const created = await coordinator.createConversation({
      commandId: 'coalesce-create', providerInstanceId: 'fixture-local', cwd: '/workspace/remux',
      model: 'fixture-native-v1', access: 'workspace-write',
    });
    const internals = coordinator as unknown as {
      synchronizeConversationHistory(conversationId: string, freshness: string): Promise<void>;
    };
    const originalSync = internals.synchronizeConversationHistory.bind(coordinator);
    let release!: () => void;
    let entered!: () => void;
    const enteredBarrier = new Promise<void>((resolve) => { entered = resolve; });
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    let syncCalls = 0;
    internals.synchronizeConversationHistory = async () => {
      syncCalls += 1;
      entered();
      await barrier;
    };
    const sendInput = configuredMessage(coordinator, {
      commandId: 'coalesce-send', conversationId: created.conversationId,
      clientMessageId: 'coalesce-message', content: [{ type: 'text', text: 'One dispatch.' }],
    });
    const first = coordinator.sendMessage(sendInput);
    await enteredBarrier;
    assert.equal(journal.commandReceipt(sendInput.commandId)?.state, 'received');
    const duplicate = coordinator.sendMessage(structuredClone(sendInput));
    release();
    const [left, right] = await Promise.all([first, duplicate]);
    assert.deepEqual(right, left);
    assert.equal(syncCalls, 1);
    await waitFor(() => journal.turn(left.turnId)?.state === 'completed');

    internals.synchronizeConversationHistory = originalSync;
    let releaseCompact!: () => void;
    let compactEntered!: () => void;
    const compactEnteredBarrier = new Promise<void>((resolve) => { compactEntered = resolve; });
    const compactBarrier = new Promise<void>((resolve) => { releaseCompact = resolve; });
    syncCalls = 0;
    internals.synchronizeConversationHistory = async () => {
      syncCalls += 1;
      compactEntered();
      await compactBarrier;
    };
    const compactInput = { commandId: 'coalesce-compact', conversationId: created.conversationId };
    const compactFirst = coordinator.compactConversation(compactInput);
    await compactEnteredBarrier;
    assert.equal(journal.commandReceipt(compactInput.commandId)?.state, 'received');
    const compactDuplicate = coordinator.compactConversation(structuredClone(compactInput));
    releaseCompact();
    const [compactLeft, compactRight] = await Promise.all([compactFirst, compactDuplicate]);
    assert.deepEqual(compactRight, compactLeft);
    assert.equal(syncCalls, 1);
    assert.equal(adapter.opened[0]?.providerCompactCount, 1);
  } finally {
    await coordinator.close();
    journal.close();
  }
});

test('trusted image admission grants direct, queued, and steer inputs before provider use', async () => {
  const journal = createJournal();
  const providerBoundaries: string[] = [];
  const baseAdapter = new NativeFixtureAdapter({ delayMs: 60_000, afterTurnAccepted: (input) => {
    const artifactId = imageArtifactId(input.content);
    if (!artifactId) return;
    assert.equal(journal.turn(input.turnId), undefined, 'grant exists before canonical turn admission');
    assert.equal(journal.artifactGrantedTo({ conversationId: input.conversationId,
      executionId: input.executionId }, artifactId), true);
    providerBoundaries.push(`turn:${artifactId}`);
  } });
  const adapter: ProviderAdapter = {
    probe: async (providerInstanceId) => {
      const probe = await baseAdapter.probe(providerInstanceId);
      assert.ok(probe.capabilities);
      return { ...probe, capabilities: { ...probe.capabilities,
        turns: { ...probe.capabilities.turns, steer: true } } };
    },
    listModels: (providerInstanceId) => baseAdapter.listModels(providerInstanceId),
    openSession: async (input) => {
      const session = await baseAdapter.openSession(input);
      const providerSession: ProviderSession = session;
      providerSession.steer = async (steerInput, context) => {
        const artifactId = imageArtifactId(steerInput.content);
        assert.ok(artifactId);
        assert.equal(journal.artifactGrantedTo({ conversationId: input.conversationId,
          executionId: input.executionId }, artifactId), true);
        providerBoundaries.push(`steer:${artifactId}`);
        assert.ok(context);
        context.boundary.markPossiblySent(session.nativeSession.sessionId);
        return { accepted: true, outcome: 'accepted', evidence: {
          kind: 'fixture-correlated-acceptance', sessionId: session.nativeSession.sessionId,
          commandId: steerInput.commandId,
        } };
      };
      return providerSession;
    },
  };
  const coordinator = new NativeAgentCoordinator({ journal, providers: [{
    providerInstanceId: 'fixture-local', provider: 'fixture', label: 'Fixture', adapter,
  }] });
  try {
    await coordinator.initialize();
    const created = await coordinator.createConversation({ commandId: 'create-images',
      providerInstanceId: 'fixture-local', cwd: '/workspace/remux', model: 'fixture-native-v1',
      access: 'workspace-write' });
    for (const [artifactId, nibble] of [['direct-image', 'd'], ['queued-image', 'e'],
      ['steer-image', 'f']] as const) journal.registerArtifact({ artifactId,
        sha256: nibble.repeat(64), byteLength: 4, mediaType: 'image/png', visibility: 'viewer',
        storagePath: `${nibble}/${artifactId}`, createdAt: 2 });
    const image = (artifactId: string, mimeType = 'image/png') =>
      ({ type: 'image-artifact' as const, artifactId, mimeType });
    const direct = await coordinator.sendMessage(configuredMessage(coordinator, {
      commandId: 'send-direct-image', conversationId: created.conversationId,
      clientMessageId: 'message-direct-image', content: [image('direct-image')] as UserContentPart[],
    }));
    assert.equal(direct.delivery, 'sent');
    assert.equal(journal.artifactGrantedTo({ conversationId: created.conversationId,
      executionId: journal.conversation(created.conversationId)!.rootExecutionId }, 'direct-image'), true);
    const queued = await coordinator.sendMessage(configuredMessage(coordinator, {
      commandId: 'send-queued-image', conversationId: created.conversationId,
      clientMessageId: 'message-queued-image', content: [image('queued-image')] as UserContentPart[],
    }));
    assert.equal(queued.delivery, 'queued');
    assert.equal(journal.turn(queued.turnId), undefined, 'grant precedes queued turn admission');
    assert.equal(journal.artifactGrantedTo({ conversationId: created.conversationId,
      executionId: journal.conversation(created.conversationId)!.rootExecutionId }, 'queued-image'), true);
    const steered = await coordinator.sendMessage({ ...configuredMessage(coordinator, {
      commandId: 'steer-image', conversationId: created.conversationId,
      clientMessageId: 'message-steer-image', content: [image('steer-image')] as UserContentPart[],
    }), delivery: 'steer' });
    assert.equal(steered.delivery, 'steered');
    assert.equal(journal.artifactGrantedTo({ conversationId: created.conversationId,
      executionId: journal.conversation(created.conversationId)!.rootExecutionId }, 'steer-image'), true);
    await assert.rejects(() => coordinator.sendMessage(configuredMessage(coordinator, {
      commandId: 'send-invalid-image', conversationId: created.conversationId,
      clientMessageId: 'message-invalid-image',
      content: [image('direct-image', 'image/jpeg')] as UserContentPart[],
    })), /does not match its attachment metadata/u);
    assert.equal(journal.commandReceipt('send-invalid-image')?.state, 'rejected');
    assert.equal(journal.queuedMessages(created.conversationId)
      .some(({ commandId }) => commandId === 'send-invalid-image'), false);
    await coordinator.interruptTurn({ commandId: 'interrupt-direct-image',
      conversationId: created.conversationId, turnId: direct.turnId });
    await coordinator.sendMessage(configuredMessage(coordinator, {
      commandId: 'resume-after-image-stop', conversationId: created.conversationId,
      clientMessageId: 'resume-after-image-stop-message',
      content: [{ type: 'text', text: 'Resume the preserved queue.' }],
    }));
    await waitFor(() => providerBoundaries.includes('turn:queued-image'), 1_000);
    assert.deepEqual(providerBoundaries, ['turn:direct-image', 'steer:steer-image', 'turn:queued-image']);
  } finally {
    await coordinator.close();
    journal.close();
  }
});

test('native coordinator seals provider patches before journaling and projects only the artifact reference', async () => {
  const journal = createJournal();
  const diff = '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n';
  const diffArtifactId = 'd'.repeat(64);
  const adapter = new NativeFixtureAdapter({
    fileChanges: [{ path: '/workspace/remux/src/a.ts', kind: 'update', diff }],
  });
  let resolveTerminal: (() => void) | undefined;
  const terminal = new Promise<void>((resolve) => { resolveTerminal = resolve; });
  const sealed: string[] = [];
  const coordinator = new NativeAgentCoordinator({
    journal,
    providers: [{
      providerInstanceId: 'fixture-local',
      provider: 'fixture',
      label: 'Fixture',
      adapter,
    }],
    sealFileDiff: async ({ diff: value }) => {
      sealed.push(value);
      return { artifactId: diffArtifactId };
    },
    onTerminalTurn: () => resolveTerminal?.(),
  });
  try {
    await coordinator.initialize();
    const created = await coordinator.createConversation({
      commandId: 'create-diff',
      providerInstanceId: 'fixture-local',
      cwd: '/workspace/remux',
      model: 'fixture-native-v1',
      access: 'workspace-write',
    });
    const sent = await coordinator.sendMessage(configuredMessage(coordinator, {
      commandId: 'send-diff',
      conversationId: created.conversationId,
      clientMessageId: 'message-diff',
      content: [{ type: 'text', text: 'Edit a.ts.' }],
    }));
    await withTimeout(terminal, 1_000, 'diff turn timed out');
    assert.deepEqual(sealed, [diff]);
    const events = journal.eventsForTurn(sent.turnId);
    const fileEvent = events.find(({ event }) => event.type === 'turn.file-changed');
    assert.ok(fileEvent?.event.type === 'turn.file-changed');
    if (fileEvent?.event.type !== 'turn.file-changed') return;
    assert.deepEqual(fileEvent.event.change, {
      path: 'src/a.ts',
      kind: 'update',
      diffArtifactId,
    });
    assert.doesNotMatch(JSON.stringify(fileEvent), /"diff":/u);
    const transcript = coordinator.projector.project(
      `agent/transcript:${created.conversationId}:tail-24`,
    ) as NativeTranscriptWindow;
    assert.equal(transcript.turns[0]?.activity.fileChanges[0]?.diffArtifactId, diffArtifactId);
  } finally {
    await coordinator.close();
    journal.close();
  }
});

test('existing idle conversations reopen their native session when access changes', async () => {
  const journal = createJournal();
  const adapter = new NativeFixtureAdapter();
  const coordinator = new NativeAgentCoordinator({
    journal,
    providers: [{
      providerInstanceId: 'fixture-local',
      provider: 'fixture',
      label: 'Fixture',
      adapter,
    }],
  });
  try {
    await coordinator.initialize();
    const created = await coordinator.createConversation({
      commandId: 'create-access-change',
      providerInstanceId: 'fixture-local',
      cwd: '/workspace/remux',
      model: 'fixture-native-v1',
      access: 'workspace-write',
    });
    const before = coordinator.projector.runtimeResource(created.conversationId)!;
    assert.equal(before.composer.editable.access, true);

    const changed = await coordinator.setConversationAccess({
      commandId: 'set-access-read-only',
      conversationId: created.conversationId,
      expectedRevision: before.composer.revision,
      access: 'read-only',
    });
    assert.notEqual(changed.revision, before.composer.revision);
    assert.equal(adapter.opened[0]?.isClosed, true);
    assert.equal(journal.conversation(created.conversationId)?.access, 'read-only');
    assert.equal(journal.execution(before.executionId)?.access, 'read-only');

    const sent = await coordinator.sendMessage(configuredMessage(coordinator, {
      commandId: 'send-after-access-change',
      conversationId: created.conversationId,
      clientMessageId: 'message-after-access-change',
      content: [{ type: 'text', text: 'Continue read-only.' }],
    }));
    assert.equal(sent.delivery, 'sent');
    assert.equal(adapter.opened.length, 2);
    assert.equal(adapter.opened[1]?.openedWith.access, 'read-only');
  } finally {
    await coordinator.close();
    journal.close();
  }
});

test('native coordinator durably commits an already-buffered provider burst as one batch', async () => {
  const journal = createJournal();
  const adapter = new NativeFixtureAdapter();
  const coordinator = new NativeAgentCoordinator({
    journal,
    providers: [{
      providerInstanceId: 'fixture-local',
      provider: 'fixture',
      label: 'Fixture',
      adapter,
    }],
  });
  try {
    await coordinator.initialize();
    const created = await coordinator.createConversation({
      commandId: 'create-batched-events',
      providerInstanceId: 'fixture-local',
      cwd: '/workspace/remux',
      model: 'fixture-native-v1',
      access: 'workspace-write',
    });
    await waitFor(() => journal.eventsForConversation(created.conversationId).length === 3);
    const executionId = journal.conversation(created.conversationId)!.rootExecutionId;
    const session = adapter.opened[0]!;
    let transactionCount = 0;
    const transaction = journal.transaction;
    journal.transaction = function<T>(work: () => T) {
      transactionCount += 1;
      return transaction.call(this, work) as T;
    };

    const events: ProviderEventEnvelope[] = Array.from({ length: 64 }, (_, index) => ({
      contractVersion: PROVIDER_RUNTIME_CONTRACT_VERSION,
      eventId: `buffered-delta-${index}`,
      provider: 'fixture',
      scope: {
        kind: 'conversation',
        providerInstanceId: 'fixture-local',
        conversationId: created.conversationId,
        executionId,
      },
      native: {
        sessionId: session.nativeSession.sessionId,
        position: { kind: 'native-sequence', sequence: 100 + index, subIndex: 0 },
        kind: 'item/reasoning/delta',
      },
      observedAt: 100 + index,
      event: {
        type: 'compatibility.notice',
        code: `fixture-delta-${index}`,
        message: `delta-${index}`,
      },
    }));
    for (const event of events) session.events.emit(event);

    await waitFor(() => journal.eventsForConversation(created.conversationId).length === 67);
    assert.equal(transactionCount, 1,
      'one ready event plus the drained backlog share one FULL-sync commit');
    assert.deepEqual(
      journal.eventsForConversation(created.conversationId).slice(-64).map(({ eventId }) => eventId),
      events.map(({ eventId }) => eventId),
      'batching preserves every durable event in provider order',
    );
  } finally {
    await coordinator.close();
    journal.close();
  }
});

test('native coordinator journals cumulative text bursts as one display checkpoint', async () => {
  const journal = createJournal();
  const adapter = new NativeFixtureAdapter({ delayMs: 60_000 });
  const coordinator = new NativeAgentCoordinator({
    journal,
    providers: [{
      providerInstanceId: 'fixture-local', provider: 'fixture',
      label: 'Fixture', adapter,
    }],
  });
  try {
    await coordinator.initialize();
    const created = await coordinator.createConversation({
      commandId: 'create-checkpoint-batch',
      providerInstanceId: 'fixture-local',
      cwd: '/workspace/remux',
      model: 'fixture-native-v1',
      access: 'workspace-write',
    });
    await waitFor(() => journal.eventsForConversation(created.conversationId).length === 3);
    const executionId = journal.conversation(created.conversationId)!.rootExecutionId;
    const sent = await coordinator.sendMessage(configuredMessage(coordinator, {
      commandId: 'command-checkpoint-batch',
      conversationId: created.conversationId,
      clientMessageId: 'message-checkpoint-batch',
      content: [{ type: 'text', text: 'Stream.' }],
    }));
    const turnId = sent.turnId;
    const startedAt = Date.now();
    await waitFor(() => journal.eventsForTurn(turnId).length >= 2);
    const session = adapter.opened[0]!;
    const envelope = (eventId: string, sequence: number, event: ProviderEventEnvelope['event']): ProviderEventEnvelope => ({
      contractVersion: PROVIDER_RUNTIME_CONTRACT_VERSION,
      eventId,
      provider: 'fixture',
      scope: {
        kind: 'turn', providerInstanceId: 'fixture-local',
        conversationId: created.conversationId, executionId, turnId,
      },
      native: {
        sessionId: session.nativeSession.sessionId,
        messageId: 'message-native-checkpoint', itemId: 'text-native-checkpoint',
        position: { kind: 'native-sequence', sequence, subIndex: 0 },
        kind: 'item/assistant/text',
      },
      observedAt: startedAt + sequence,
      event,
    });
    const structure = {
      passId: 'pass-checkpoint', blockId: 'block-checkpoint',
      passOrdinal: 0, blockOrdinal: 0,
    };
    session.events.emit(envelope('checkpoint-start', 100, {
      type: 'turn.block.started', structure,
      block: {
        kind: 'final-message', state: 'streaming',
        payload: { kind: 'final-message', text: 'x' },
      },
    }));
    for (let revision = 2; revision <= 20; revision += 1) {
      const block = {
        kind: 'final-message' as const,
        state: 'streaming' as const,
        payload: { kind: 'final-message' as const, text: 'x'.repeat(revision) },
      };
      session.events.emit(envelope(`checkpoint-${revision}`, 100 + revision, {
        type: 'turn.block.revised', structure, revision,
        contentHash: String(revision).padStart(64, '0'), block,
      }));
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
    const checkpointEventIds = journal.eventsForTurn(turnId)
      .filter(({ eventId }) => eventId.startsWith('checkpoint-'))
      .map(({ eventId }) => eventId);
    assert.deepEqual(checkpointEventIds, [
      'checkpoint-start', 'checkpoint-20',
    ]);
    const persistedBlock = journal.orderedPasses(turnId)[0]?.blocks[0];
    assert.equal(persistedBlock?.payload.kind, 'final-message');
    assert.equal(
      persistedBlock?.payload.kind === 'final-message'
        ? persistedBlock.payload.text
        : null,
      'x'.repeat(20),
    );
  } finally {
    await coordinator.close();
    journal.close();
  }
});

test('native coordinator immediately reconciles a lost stream without rerunning the accepted turn', async () => {
  const journal = createJournal();
  const firstAdapter = new NativeFixtureAdapter({ provider: 'claude-code', delayMs: 60_000 });
  const first = new NativeAgentCoordinator({
    journal,
    providers: [{
      providerInstanceId: 'claude-local',
      provider: 'claude-code',
      label: 'Claude fixture',
      adapter: firstAdapter,
    }],
  });
  await first.initialize();
  const created = await first.createConversation({
    commandId: 'create-recovery',
    providerInstanceId: 'claude-local',
    cwd: '/workspace/remux',
    model: 'fixture-native-v1',
    access: 'workspace-write',
  });
  const sent = await first.sendMessage(configuredMessage(first, {
    commandId: 'send-recovery',
    conversationId: created.conversationId,
    clientMessageId: 'message-recovery',
    content: [{ type: 'text', text: 'Long work.' }],
  }));
  await waitFor(() => Boolean(journal.turn(sent.turnId)));
  firstAdapter.opened[0]?.simulateTransportFailure(new Error('fixture process disappeared'));
  await waitFor(() => journal.turn(sent.turnId)?.outcome === 'recovery_failed');
  assert.equal(firstAdapter.opened.length, 2, 'stream loss immediately reopens the native session');
  assert.equal(
    firstAdapter.opened[1]?.nativeSession.sessionId,
    firstAdapter.opened[0]?.nativeSession.sessionId,
    'a materialized Claude session resumes with its exact native identity',
  );
  assert.equal(firstAdapter.opened[1]?.providerDispatchCount, 0, 'reconciliation never resends the turn');
  assert.deepEqual(firstAdapter.opened[1]?.openedWith.activeTurnBinding, {
    turnId: sent.turnId,
    nativeTurnId: journal.turn(sent.turnId)?.nativeTurnId,
  });
  assert.equal(journal.conversation(created.conversationId)?.resumable, false);
  await first.close();

  const replacementAdapter = new NativeFixtureAdapter({ provider: 'claude-code' });
  const replacement = new NativeAgentCoordinator({
    journal,
    providers: [{
      providerInstanceId: 'claude-local',
      provider: 'claude-code',
      label: 'Claude fixture',
      adapter: replacementAdapter,
    }],
  });
  try {
    await replacement.initialize();
    assert.equal(replacementAdapter.opened.length, 0, 'recovery failure remains terminal across restart');
    assert.equal(journal.turn(sent.turnId)?.outcome, 'recovery_failed');
    assert.equal(journal.conversation(created.conversationId)?.resumable, false);
  } finally {
    await replacement.close();
    journal.close();
  }
});

test('session-local recovery snapshots preserve an accepted turn until the adapter has native evidence', async () => {
  const journal = createJournal();
  const adapter = new NativeFixtureAdapter({
    provider: 'claude-code',
    delayMs: 60_000,
    snapshotAuthority: 'session-local',
  });
  const coordinator = new NativeAgentCoordinator({
    journal,
    providers: [{
      providerInstanceId: 'claude-local',
      provider: 'claude-code',
      label: 'Claude fixture',
      adapter,
    }],
  });
  try {
    await coordinator.initialize();
    const created = await coordinator.createConversation({
      commandId: 'create-session-local-recovery',
      providerInstanceId: 'claude-local',
      cwd: '/workspace/remux',
      model: 'fixture-native-v1',
      access: 'workspace-write',
    });
    const sent = await coordinator.sendMessage(configuredMessage(coordinator, {
      commandId: 'send-session-local-recovery',
      conversationId: created.conversationId,
      clientMessageId: 'message-session-local-recovery',
      content: [{ type: 'text', text: 'Long work.' }],
    }));
    await waitFor(() => Boolean(journal.turn(sent.turnId)));
    adapter.opened[0]?.simulateTransportFailure(new Error('fixture process disappeared'));
    await waitFor(() => adapter.opened.length === 2);
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(journal.turn(sent.turnId)?.outcome, undefined);
    assert.equal(journal.conversation(created.conversationId)?.activeTurnId, sent.turnId);
    assert.deepEqual(adapter.opened[1]?.openedWith.activeTurnBinding, {
      turnId: sent.turnId,
      nativeTurnId: journal.turn(sent.turnId)?.nativeTurnId,
    });
    assert.equal(adapter.opened[1]?.providerDispatchCount, 0,
      'session-local recovery never reruns the accepted prompt');
  } finally {
    await coordinator.close();
    journal.close();
  }
});

test('native coordinator bounds repeated automatic stream-loss recovery', async () => {
  const journal = createJournal();
  const adapter = new NativeFixtureAdapter();
  const coordinator = new NativeAgentCoordinator({
    journal,
    providers: [{
      providerInstanceId: 'fixture-local',
      provider: 'fixture',
      label: 'Fixture',
      adapter,
    }],
  });
  await coordinator.initialize();
  const created = await coordinator.createConversation({
    commandId: 'create-recovery-loop',
    providerInstanceId: 'fixture-local',
    cwd: '/workspace/remux',
    model: 'fixture-native-v1',
    access: 'workspace-write',
  });
  const rootExecutionId = journal.conversation(created.conversationId)!.rootExecutionId;

  for (let index = 0; index < 4; index += 1) {
    adapter.opened[index]!.simulateTransportFailure(new Error(`fixture transport loss ${index + 1}`));
    if (index < 3) await waitFor(() => adapter.opened.length === index + 2);
  }
  await waitFor(() => journal.execution(rootExecutionId)?.outcome === 'recovery_failed');
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(adapter.opened.length, 4, 'three automatic recovery attempts bound native process opens');
  assert.ok(adapter.opened.every(({ providerDispatchCount }) => providerDispatchCount === 0),
    'recovery never dispatches a provider turn');
  assert.equal(journal.conversation(created.conversationId)?.state, 'failed');
  assert.equal(journal.conversation(created.conversationId)?.resumable, false);
  assert.equal(journal.execution(rootExecutionId)?.outcome, 'recovery_failed');
  await coordinator.close();

  const replacementAdapter = new NativeFixtureAdapter();
  const replacement = new NativeAgentCoordinator({
    journal,
    providers: [{
      providerInstanceId: 'fixture-local',
      provider: 'fixture',
      label: 'Fixture',
      adapter: replacementAdapter,
    }],
  });
  try {
    await replacement.initialize();
    assert.equal(replacementAdapter.opened.length, 0,
      'a terminal recovery failure is not reopened after coordinator restart');
  } finally {
    await replacement.close();
    journal.close();
  }
});

test('a colliding provider pass is appended without turning projection failure into stream loss', async () => {
  const journal = createJournal();
  const adapter = new NativeFixtureAdapter({ delayMs: 5, emitPassCollision: true });
  const diagnostics: Array<{ stage: string; status: string }> = [];
  const coordinator = new NativeAgentCoordinator({
    journal,
    providers: [{
      providerInstanceId: 'fixture-local',
      provider: 'fixture',
      label: 'Fixture',
      adapter,
    }],
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  try {
    await coordinator.initialize();
    const created = await coordinator.createConversation({
      commandId: 'create-pass-collision',
      providerInstanceId: 'fixture-local',
      cwd: '/workspace/remux',
      model: 'fixture-native-v1',
      effort: 'high',
      access: 'workspace-write',
    });
    const sent = await coordinator.sendMessage(configuredMessage(coordinator, {
      commandId: 'send-pass-collision',
      conversationId: created.conversationId,
      clientMessageId: 'message-pass-collision',
      content: [{ type: 'text', text: 'Keep streaming after a pass collision.' }],
    }));

    await waitFor(() => journal.turn(sent.turnId)?.state === 'completed');
    assert.equal(adapter.opened.length, 1, 'pass canonicalization must not reopen the provider session');
    assert.equal(journal.conversation(created.conversationId)?.state, 'idle');
    assert.equal(journal.conversation(created.conversationId)?.resumable, true);
    assert.equal(diagnostics.some(({ stage, status }) =>
      stage === 'session.event-ingest' && status === 'failed'), false);
    const passes = journal.orderedPasses(sent.turnId);
    assert.deepEqual(passes.map(({ passId, ordinal }) => [passId, ordinal]), [
      [`fixture-pass-${sent.turnId}`, 0],
      [`fixture-colliding-pass-${sent.turnId}`, 1],
    ]);
    assert.equal(passes[1]?.blocks[0]?.payload.kind, 'reasoning-summary');
    assert.equal(diagnostics.some(({ stage }) => stage === 'session.events'), false,
      'only iterator failure is provider stream loss');
  } finally {
    await coordinator.close();
    journal.close();
  }
});

test('an old authoritative reconcile cannot fail a newly activated edit strand', async () => {
  const journal = createJournal();
  const adapter = new NativeFixtureAdapter({
    nativeFork: true,
    delayMs: 80,
    snapshotDelayMs: 30,
    finalText: 'Done.',
  });
  const coordinator = new NativeAgentCoordinator({
    journal,
    providers: [{
      providerInstanceId: 'fixture-local',
      provider: 'fixture',
      label: 'Fixture',
      adapter,
    }],
  });
  try {
    await coordinator.initialize();
    const created = await coordinator.createConversation({
      commandId: 'create-stale-reconcile-edit',
      providerInstanceId: 'fixture-local',
      cwd: '/workspace/remux',
      model: 'fixture-native-v1',
      effort: 'high',
      access: 'workspace-write',
    });
    const first = await coordinator.sendMessage(configuredMessage(coordinator, {
      commandId: 'send-stale-reconcile-prefix',
      conversationId: created.conversationId,
      clientMessageId: 'message-stale-reconcile-prefix',
      content: [{ type: 'text', text: 'Prefix.' }],
    }));
    await waitFor(() => journal.turn(first.turnId)?.state === 'completed');
    const second = await coordinator.sendMessage(configuredMessage(coordinator, {
      commandId: 'send-stale-reconcile-source',
      conversationId: created.conversationId,
      clientMessageId: 'message-stale-reconcile-source',
      content: [{ type: 'text', text: 'Original.' }],
    }));
    await waitFor(() => journal.turn(second.turnId)?.state === 'completed');
    const head = journal.conversationHead(created.conversationId)!;
    const sourceTurn = journal.turn(second.turnId)!;
    const runtime = coordinator.projector.runtimeResource(created.conversationId)!;

    const staleReconcile = coordinator.reconcile(created.conversationId);
    await waitFor(() => adapter.opened[0]!.providerSnapshotCount === 1);
    const edited = await coordinator.branchConversation({
      commandId: 'edit-during-stale-reconcile',
      clientMessageId: 'message-during-stale-reconcile',
      sourceConversationId: created.conversationId,
      sourceStrandId: head.strandId,
      sourcePathEntryId: sourceTurn.pathEntryId!,
      expectedHeadRevision: head.revision,
      content: [{ type: 'text', text: 'Edited.' }],
      mode: 'edit',
      providerInstanceId: runtime.providerInstanceId,
      model: runtime.composer.nextTurn.model,
      effort: runtime.composer.nextTurn.effort,
      access: runtime.composer.nextTurn.access,
      configurationRevision: runtime.composer.revision,
    });
    await staleReconcile;

    const editedTurn = journal.turn(edited.turnId)!;
    assert.equal(journal.conversation(created.conversationId)?.rootExecutionId, editedTurn.executionId);
    assert.equal(journal.conversation(created.conversationId)?.activeTurnId, edited.turnId);
    assert.equal(editedTurn.state, 'running');
    assert.deepEqual(adapter.opened[1]?.openedWith.inheritedNativeTurnIds, [
      journal.turn(first.turnId)?.nativeTurnId,
    ]);
    await waitFor(() => journal.turn(edited.turnId)?.state === 'completed');
    assert.equal(journal.conversation(created.conversationId)?.state, 'idle');
    assert.equal(journal.conversation(created.conversationId)?.healthMessage, undefined);
  } finally {
    await coordinator.close();
    journal.close();
  }
});

test('native coordinator rejects a send while recovery owns the native session', async () => {
  const journal = createJournal();
  const adapter = new NativeFixtureAdapter();
  const coordinator = new NativeAgentCoordinator({
    journal,
    providers: [{
      providerInstanceId: 'fixture-local',
      provider: 'fixture',
      label: 'Fixture',
      adapter,
    }],
  });
  try {
    await coordinator.initialize();
    const created = await coordinator.createConversation({
      commandId: 'create-recovering-send',
      providerInstanceId: 'fixture-local',
      cwd: '/workspace/remux',
      model: 'fixture-native-v1',
      access: 'workspace-write',
    });
    journal.markConversationRecovering(created.conversationId, 'Reattaching.', Date.now());
    await assert.rejects(() => coordinator.sendMessage(configuredMessage(coordinator, {
      commandId: 'send-during-recovery',
      conversationId: created.conversationId,
      clientMessageId: 'message-during-recovery',
      content: [{ type: 'text', text: 'Do not create another session.' }],
    })), /recovering its native provider session/iu);
    assert.equal(adapter.opened.length, 1);
    assert.equal(journal.turns(created.conversationId).length, 0);
    assert.equal(journal.commandReceipt('send-during-recovery')?.state, 'rejected');
  } finally {
    await coordinator.close();
    journal.close();
  }
});

test('queued-message removal records its original result atomically for retries', async () => {
  const journal = createJournal();
  const adapter = new NativeFixtureAdapter({ delayMs: 60_000 });
  const coordinator = new NativeAgentCoordinator({
    journal,
    providers: [{
      providerInstanceId: 'fixture-local',
      provider: 'fixture',
      label: 'Fixture',
      adapter,
    }],
  });
  try {
    await coordinator.initialize();
    const created = await coordinator.createConversation({
      commandId: 'create-queue-removal',
      providerInstanceId: 'fixture-local',
      cwd: '/workspace/remux',
      model: 'fixture-native-v1',
      access: 'workspace-write',
    });
    await coordinator.sendMessage(configuredMessage(coordinator, {
      commandId: 'send-queue-active',
      conversationId: created.conversationId,
      clientMessageId: 'message-queue-active',
      content: [{ type: 'text', text: 'Stay active.' }],
    }));
    const queued = await coordinator.sendMessage(configuredMessage(coordinator, {
      commandId: 'send-queue-remove',
      conversationId: created.conversationId,
      clientMessageId: 'message-queue-remove',
      content: [{ type: 'text', text: 'Remove me.' }],
    }));
    assert.equal(journal.turn(queued.turnId), undefined,
      'pending queue intent is absent from canonical transcript');
    const command = {
      commandId: 'remove-queued-once',
      conversationId: created.conversationId,
      turnId: queued.turnId,
    };
    const removed = coordinator.removeQueuedMessage(command);
    assert.deepEqual(removed, { accepted: true, removed: true });
    assert.deepEqual(coordinator.removeQueuedMessage(structuredClone(command)), removed);
    assert.equal(journal.queuedMessages(created.conversationId).length, 0);
    assert.equal(journal.turn(queued.turnId), undefined,
      'queue deletion cannot leave a transcript ghost');
  } finally {
    await coordinator.close();
    journal.close();
  }
});

test('native Compact is idempotent, invisible to turns, and projects its terminal token boundary', async () => {
  const journal = createJournal();
  const adapter = new NativeFixtureAdapter({ manualCompaction: true });
  const coordinator = new NativeAgentCoordinator({
    journal,
    providers: [{
      providerInstanceId: 'fixture-local',
      provider: 'fixture',
      label: 'Fixture',
      adapter,
    }],
  });
  try {
    await coordinator.initialize();
    const created = await coordinator.createConversation({
      commandId: 'create-compact-idle',
      providerInstanceId: 'fixture-local',
      cwd: '/workspace/remux',
      model: 'fixture-native-v1',
      access: 'workspace-write',
    });
    const command = {
      commandId: 'compact-idle-once',
      conversationId: created.conversationId,
    };
    const first = await coordinator.compactConversation(command);
    assert.equal(first.delivery, 'sent');
    assert.deepEqual(await coordinator.compactConversation(structuredClone(command)), first);
    await waitFor(() => journal.compactionOperation(first.operationId)?.state === 'completed');
    assert.equal(adapter.opened[0]?.providerCompactCount, 1);
    assert.equal(journal.turns(created.conversationId).length, 0,
      'Compact is a conversation control and never a synthetic user turn');
    assert.deepEqual(journal.eventsForConversation(created.conversationId)
      .filter(({ event }) => event.type.startsWith('context.compaction.'))
      .map(({ event }) => event.type), [
      'context.compaction.completed',
    ]);
    const runtime = coordinator.projector.runtimeResource(created.conversationId);
    assert.equal(runtime?.compaction.policy, 'manual');
    assert.equal(runtime?.compaction.operation.state, 'idle');
    assert.equal(runtime?.compaction.operation.lastResult?.beforeTokens, 90_000);
    assert.equal(runtime?.compaction.operation.lastResult?.afterTokens, 12_000);
  } finally {
    await coordinator.close();
    journal.close();
  }
});

test('native Compact provider failure settles durably and dispatches the queued next turn', async () => {
  const journal = createJournal();
  const fixture = new NativeFixtureAdapter({
    manualCompaction: true,
    omitCompactionCompletion: true,
  });
  let failCompaction: (() => void) | undefined;
  const adapter: ProviderAdapter = {
    probe: (providerInstanceId) => fixture.probe(providerInstanceId),
    listModels: (providerInstanceId) => fixture.listModels(providerInstanceId),
    openSession: async (input) => {
      const native = await fixture.openSession(input);
      const events = new AsyncEventStream<ProviderEventEnvelope>();
      void (async () => {
        try {
          for await (const event of native.events) events.emit(event);
          events.close();
        } catch (error) {
          events.fail(error);
        }
      })();
      const session: ProviderSession = {
        nativeSession: native.nativeSession,
        events,
        startTurn: (request, boundary) => native.startTurn(request, boundary),
        interrupt: (request) => native.interrupt(request),
        snapshot: (request) => native.snapshot(request),
        compact: async (request, context) => {
          const acceptance = await native.compact!(request, context);
          failCompaction = () => events.emit({
            contractVersion: PROVIDER_RUNTIME_CONTRACT_VERSION,
            eventId: `fixture:compact-failed:${request.commandId}`,
            provider: 'fixture',
            scope: {
              kind: 'conversation',
              providerInstanceId: input.providerInstanceId,
              conversationId: input.conversationId,
              executionId: input.executionId,
            },
            native: {
              sessionId: native.nativeSession.sessionId,
              position: { kind: 'native-sequence', sequence: 1_000_000, subIndex: 0 },
              kind: 'context/compact/failed',
            },
            observedAt: Date.now(),
            event: {
              type: 'context.compaction.failed',
              trigger: 'manual',
              operationId: request.commandId,
              error: {
                code: 'fixture_compaction_failed',
                message: 'Fixture provider rejected Compact.',
                retryable: true,
              },
            },
          });
          return acceptance;
        },
        close: () => native.close(),
      };
      return session;
    },
  };
  const coordinator = new NativeAgentCoordinator({
    journal,
    providers: [{
      providerInstanceId: 'fixture-local',
      provider: 'fixture',
      label: 'Fixture',
      adapter,
    }],
  });
  try {
    await coordinator.initialize();
    const created = await coordinator.createConversation({
      commandId: 'create-compact-provider-failure',
      providerInstanceId: 'fixture-local',
      cwd: '/workspace/remux',
      model: 'fixture-native-v1',
      access: 'workspace-write',
    });
    const compact = await coordinator.compactConversation({
      commandId: 'compact-provider-failure',
      conversationId: created.conversationId,
    });
    assert.equal(journal.compactionOperation(compact.operationId)?.state, 'running');
    const next = await coordinator.sendMessage(configuredMessage(coordinator, {
      commandId: 'send-after-compact-provider-failure',
      conversationId: created.conversationId,
      clientMessageId: 'message-after-compact-provider-failure',
      content: [{ type: 'text', text: 'Continue after Compact fails.' }],
    }));
    assert.equal(next.delivery, 'queued');
    assert.ok(failCompaction);
    failCompaction();

    await waitFor(() => journal.compactionOperation(compact.operationId)?.state === 'failed');
    const failed = journal.compactionOperation(compact.operationId);
    assert.equal(failed?.error?.code, 'fixture_compaction_failed');
    assert.equal(failed?.error?.message, 'Fixture provider rejected Compact.');
    await waitFor(() => journal.turn(next.turnId)?.state === 'completed');
    assert.deepEqual(fixture.opened[0]?.dispatchLog, [
      `compact:${compact.operationId}`,
      `turn:${next.turnId}`,
    ]);
  } finally {
    await coordinator.close();
    journal.close();
  }
});

test('native Compact shares the durable root FIFO and an automatic boundary satisfies a queued request', async () => {
  const journal = createJournal();
  const adapter = new NativeFixtureAdapter({
    manualCompaction: true,
    delayMs: 20,
    compactDelayMs: 5,
  });
  const coordinator = new NativeAgentCoordinator({
    journal,
    providers: [{
      providerInstanceId: 'fixture-local',
      provider: 'fixture',
      label: 'Fixture',
      adapter,
    }],
  });
  try {
    await coordinator.initialize();
    const created = await coordinator.createConversation({
      commandId: 'create-compact-queue',
      providerInstanceId: 'fixture-local',
      cwd: '/workspace/remux',
      model: 'fixture-native-v1',
      access: 'workspace-write',
    });
    const active = await coordinator.sendMessage(configuredMessage(coordinator, {
      commandId: 'compact-queue-active',
      conversationId: created.conversationId,
      clientMessageId: 'compact-queue-active-message',
      content: [{ type: 'text', text: 'Keep the root turn active.' }],
    }));
    const queuedCompact = await coordinator.compactConversation({
      commandId: 'compact-after-active',
      conversationId: created.conversationId,
    });
    assert.equal(queuedCompact.delivery, 'queued');
    const followUp = await coordinator.sendMessage(configuredMessage(coordinator, {
      commandId: 'message-after-compact',
      conversationId: created.conversationId,
      clientMessageId: 'message-after-compact-client',
      content: [{ type: 'text', text: 'Run only after Compact.' }],
    }));
    assert.equal(followUp.delivery, 'queued');
    await assert.rejects(() => coordinator.compactConversation({
      commandId: 'compact-while-pending',
      conversationId: created.conversationId,
    }), (error: unknown) => error instanceof Error &&
      'errorCode' in error && error.errorCode === 'operation_in_progress');
    await waitFor(() => journal.turn(followUp.turnId)?.state === 'completed', 2_000);
    assert.deepEqual(adapter.opened[0]?.dispatchLog, [
      `turn:${active.turnId}`,
      `compact:${queuedCompact.operationId}`,
      `turn:${followUp.turnId}`,
    ]);

    const secondActive = await coordinator.sendMessage(configuredMessage(coordinator, {
      commandId: 'compact-auto-active',
      conversationId: created.conversationId,
      clientMessageId: 'compact-auto-active-message',
      content: [{ type: 'text', text: 'Automatic Compact will arrive during this turn.' }],
    }));
    const satisfied = await coordinator.compactConversation({
      commandId: 'compact-satisfied-by-auto',
      conversationId: created.conversationId,
    });
    assert.equal(satisfied.delivery, 'queued');
    adapter.opened[0]!.emitAutomaticCompaction('fixture-auto-boundary');
    await waitFor(() => journal.compactionOperation(satisfied.operationId)?.state === 'completed');
    assert.equal(journal.compactionOperation(satisfied.operationId)?.disposition, 'satisfied-by-native-auto');
    assert.equal(adapter.opened[0]?.providerCompactCount, 1,
      'the automatic boundary removes the queued native dispatch');
    await waitFor(() => journal.turn(secondActive.turnId)?.state === 'completed');

    const thirdActive = await coordinator.sendMessage(configuredMessage(coordinator, {
      commandId: 'compact-cancel-active',
      conversationId: created.conversationId,
      clientMessageId: 'compact-cancel-active-message',
      content: [{ type: 'text', text: 'Keep the lane occupied while Compact is cancelled.' }],
    }));
    const cancelled = await coordinator.compactConversation({
      commandId: 'compact-cancel-before-dispatch',
      conversationId: created.conversationId,
    });
    assert.equal(cancelled.delivery, 'queued');
    const removeCommand = {
      commandId: 'remove-queued-compact',
      conversationId: created.conversationId,
      turnId: cancelled.operationId,
    };
    assert.deepEqual(coordinator.removeQueuedMessage(removeCommand), { accepted: true, removed: true });
    assert.deepEqual(coordinator.removeQueuedMessage(structuredClone(removeCommand)), {
      accepted: true,
      removed: true,
    });
    assert.equal(journal.compactionOperation(cancelled.operationId)?.state, 'cancelled');
    await waitFor(() => journal.turn(thirdActive.turnId)?.state === 'completed');
    assert.equal(adapter.opened[0]?.providerCompactCount, 1,
      'a cancelled queued Compact is never sent to the provider');
  } finally {
    await coordinator.close();
    journal.close();
  }
});

test('stream loss during native Compact becomes delivery_unknown and is never redispatched', async () => {
  const journal = createJournal();
  const adapter = new NativeFixtureAdapter({
    manualCompaction: true,
    omitCompactionCompletion: true,
  });
  const coordinator = new NativeAgentCoordinator({
    journal,
    providers: [{
      providerInstanceId: 'fixture-local',
      provider: 'fixture',
      label: 'Fixture',
      adapter,
    }],
  });
  try {
    await coordinator.initialize();
    const created = await coordinator.createConversation({
      commandId: 'create-compact-ambiguous',
      providerInstanceId: 'fixture-local',
      cwd: '/workspace/remux',
      model: 'fixture-native-v1',
      access: 'workspace-write',
    });
    const compact = await coordinator.compactConversation({
      commandId: 'compact-ambiguous',
      conversationId: created.conversationId,
    });
    assert.equal(journal.compactionOperation(compact.operationId)?.state, 'running');
    adapter.opened[0]!.simulateTransportFailure(new Error('lost after native Compact acceptance'));

    await waitFor(() => journal.compactionOperation(compact.operationId)?.state === 'delivery_unknown');
    assert.equal(adapter.opened.length, 2, 'recovery resumes the native session once');
    assert.equal(adapter.opened[0]?.providerCompactCount, 1);
    assert.equal(adapter.opened[1]?.providerCompactCount, 0,
      'an ambiguous native control is never redispatched');
    const runtime = coordinator.projector.runtimeResource(created.conversationId);
    assert.equal(runtime?.compaction.operation.state, 'failed');
    if (runtime?.compaction.operation.state === 'failed') {
      assert.equal(runtime.compaction.operation.error.code, 'compaction_delivery_unknown');
    }

    const sent = await coordinator.sendMessage(configuredMessage(coordinator, {
      commandId: 'send-after-ambiguous-compact',
      conversationId: created.conversationId,
      clientMessageId: 'message-after-ambiguous-compact',
      content: [{ type: 'text', text: 'Continue after the ambiguous control.' }],
    }));
    await waitFor(() => journal.turn(sent.turnId)?.state === 'completed');
    assert.equal(adapter.opened[1]?.providerDispatchCount, 1,
      'delivery_unknown terminates the control and releases later work');
  } finally {
    await coordinator.close();
    journal.close();
  }
});

test('restart admits durable positive Compact proof without reopening or resending', async () => {
  const journal = createJournal();
  const fixture = new NativeFixtureAdapter({ manualCompaction: true });
  let compactWrites = 0;
  const adapter: ProviderAdapter = {
    probe: (id) => fixture.probe(id),
    listModels: (id) => fixture.listModels(id),
    openSession: async (input) => {
      const session = await fixture.openSession(input);
      session.compact = async (_request, context) => {
        context.boundary.markPossiblySent(session.nativeSession.sessionId);
        compactWrites += 1;
        return { accepted: false, outcome: 'unknown', crossing: {
          phase: 'possibly-sent', detail: 'response-lost' },
          error: { code: 'fixture_lost', message: 'Controlled response loss.' } };
      };
      return session;
    },
  };
  const first = new NativeAgentCoordinator({ journal, providers: [{
    providerInstanceId: 'fixture-local', provider: 'fixture', label: 'Fixture', adapter,
  }] });
  let restarted: NativeAgentCoordinator | undefined;
  try {
    await first.initialize();
    const created = await first.createConversation({ commandId: 'create-compact-restart-proof',
      providerInstanceId: 'fixture-local', cwd: '/workspace/remux', model: 'fixture-native-v1',
      access: 'workspace-write' });
    await assert.rejects(first.compactConversation({
      commandId: 'compact-restart-proof', conversationId: created.conversationId,
    }), /delivery unknown/u);
    await first.sendMessage(configuredMessage(first, {
      commandId: 'queued-after-compact-proof', conversationId: created.conversationId,
      clientMessageId: 'queued-client-after-compact-proof',
      content: [{ type: 'text', text: 'Wait for native Compact completion.' }],
    }));
    const attempt = journal.database.prepare(`SELECT attempt_id AS attemptId,
      native_session_id AS sessionId,compact_operation_id AS operationId
      FROM delivery_attempts WHERE command_id='compact-restart-proof'`).get() as {
        attemptId: string; sessionId: string; operationId: string;
      };
    journal.database.prepare(`UPDATE delivery_attempts SET acceptance_evidence_json=?
      WHERE attempt_id=?`).run(JSON.stringify({ kind: 'fixture-correlated-acceptance',
      sessionId: attempt.sessionId, commandId: attempt.operationId }), attempt.attemptId);
    await first.close();

    const restartAdapter = new NativeFixtureAdapter({ manualCompaction: true });
    restarted = new NativeAgentCoordinator({ journal, providers: [{
      providerInstanceId: 'fixture-local', provider: 'fixture', label: 'Fixture',
      adapter: restartAdapter,
    }] });
    await restarted.initialize();
    assert.equal(compactWrites, 1);
    assert.equal(restartAdapter.opened.length, 0, 'durable proof admission needs no provider writer');
    assert.equal(journal.commandReceipt('compact-restart-proof')?.state, 'accepted');
    assert.equal(journal.compactionOperation(attempt.operationId)?.state, 'running');
    assert.equal((journal.database.prepare(`SELECT state FROM delivery_attempts
      WHERE attempt_id=?`).get(attempt.attemptId) as { state: string }).state, 'accepted');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(restartAdapter.opened.reduce((sum, session) =>
      sum + session.providerDispatchCount, 0), 0,
    'accepted Compact delivery remains running until its exact terminal event');
    assert.equal((journal.database.prepare(`SELECT state FROM queued_messages
      WHERE command_id='queued-after-compact-proof'`).get() as { state: string }).state, 'queued');
  } finally {
    await restarted?.close();
    await first.close();
    journal.close();
  }
});

test('restart admits durable positive steer proof without steering twice', async () => {
  const journal = createJournal();
  const fixture = new NativeFixtureAdapter({ delayMs: 60_000 });
  let steerWrites = 0;
  const adapter: ProviderAdapter = {
    probe: async (id) => {
      const probe = await fixture.probe(id);
      return { ...probe, capabilities: probe.capabilities && { ...probe.capabilities,
        turns: { ...probe.capabilities.turns, steer: true } } };
    },
    listModels: (id) => fixture.listModels(id),
    openSession: async (input) => {
      const session = await fixture.openSession(input);
      const providerSession: ProviderSession = session;
      providerSession.steer = async (_request, context) => {
        context.boundary.markPossiblySent(session.nativeSession.sessionId);
        steerWrites += 1;
        return { accepted: false, outcome: 'unknown', crossing: {
          phase: 'possibly-sent', detail: 'response-lost' },
          error: { code: 'fixture_lost', message: 'Controlled steer response loss.' } };
      };
      return providerSession;
    },
  };
  const first = new NativeAgentCoordinator({ journal, providers: [{
    providerInstanceId: 'fixture-local', provider: 'fixture', label: 'Fixture', adapter,
  }] });
  let restarted: NativeAgentCoordinator | undefined;
  try {
    await first.initialize();
    const created = await first.createConversation({ commandId: 'create-steer-restart-proof',
      providerInstanceId: 'fixture-local', cwd: '/workspace/remux', model: 'fixture-native-v1',
      access: 'workspace-write' });
    await first.sendMessage(configuredMessage(first, { commandId: 'root-for-steer-proof',
      conversationId: created.conversationId, clientMessageId: 'root-client-for-steer-proof',
      content: [{ type: 'text', text: 'Remain active.' }] }));
    await assert.rejects(first.sendMessage({ ...configuredMessage(first, {
      commandId: 'steer-restart-proof', conversationId: created.conversationId,
      clientMessageId: 'steer-client-restart-proof',
      content: [{ type: 'text', text: 'Steer.' }],
    }), delivery: 'steer' }), /delivery unknown/u);
    const attempt = journal.database.prepare(`SELECT attempt_id AS attemptId,
      native_session_id AS sessionId FROM delivery_attempts
      WHERE command_id='steer-restart-proof'`).get() as { attemptId: string; sessionId: string };
    journal.database.prepare(`UPDATE delivery_attempts SET acceptance_evidence_json=?
      WHERE attempt_id=?`).run(JSON.stringify({ kind: 'fixture-correlated-acceptance',
      sessionId: attempt.sessionId, commandId: 'steer-restart-proof' }), attempt.attemptId);
    await first.close();

    const restartFixture = new NativeFixtureAdapter({ delayMs: 60_000 });
    restarted = new NativeAgentCoordinator({ journal, providers: [{
      providerInstanceId: 'fixture-local', provider: 'fixture', label: 'Fixture',
      adapter: restartFixture,
    }] });
    await restarted.initialize();
    assert.equal(steerWrites, 1);
    assert.equal(journal.commandReceipt('steer-restart-proof')?.state, 'accepted');
    assert.equal((journal.database.prepare(`SELECT state FROM delivery_attempts
      WHERE attempt_id=?`).get(attempt.attemptId) as { state: string }).state, 'accepted');
  } finally {
    await restarted?.close();
    await first.close();
    journal.close();
  }
});

test('coordinator fails closed across the composer capability matrix', async () => {
  const journal = createJournal();
  const adapter = new NativeFixtureAdapter({ delayMs: 20 });
  const coordinator = new NativeAgentCoordinator({
    journal,
    providers: [{
      providerInstanceId: 'fixture-local',
      provider: 'fixture',
      label: 'Fixture',
      adapter,
    }],
  });
  try {
    await coordinator.initialize();
    const created = await coordinator.createConversation({
      commandId: 'create-capability-matrix',
      providerInstanceId: 'fixture-local',
      cwd: '/workspace/remux',
      model: 'fixture-native-v1',
      access: 'workspace-write',
    });
    const registration = journal.providerInstance('fixture-local')!;
    const capabilities = structuredClone(registration.probe.capabilities!);
    capabilities.access.presets = ['workspace-write'];
    capabilities.turns.interrupt = false;
    // Native steering support must not change ordinary send into an implicit
    // mutation of the active turn.
    capabilities.turns.steer = true;
    capabilities.turns.queue = false;
    capabilities.content.images = false;
    capabilities.content.fileReferences = false;
    capabilities.session.forkNative = false;
    capabilities.compaction.manualNative = false;
    journal.upsertProviderInstance({
      providerInstanceId: 'fixture-local',
      provider: 'fixture',
      label: 'Fixture',
      probe: { ...registration.probe, capabilities },
      now: Date.now(),
    });

    await assert.rejects(() => coordinator.createConversation({
      commandId: 'create-unsupported-access',
      providerInstanceId: 'fixture-local',
      cwd: '/workspace/remux',
      model: 'fixture-native-v1',
      access: 'full-access',
    }), isCoordinatorError('capability_unavailable'));

    const active = await coordinator.sendMessage(configuredMessage(coordinator, {
      commandId: 'send-capability-active',
      conversationId: created.conversationId,
      clientMessageId: 'message-capability-active',
      content: [{ type: 'text', text: 'Hold the native lane briefly.' }],
    }));
    const imageInput = configuredMessage(coordinator, {
      commandId: 'send-unsupported-image',
      conversationId: created.conversationId,
      clientMessageId: 'message-unsupported-image',
      content: [{ type: 'text', text: 'image placeholder' }],
    });
    await assert.rejects(() => coordinator.sendMessage({
      ...imageInput,
      content: [{ type: 'image-artifact', artifactId: 'artifact-image', mimeType: 'image/png' }],
    }), isCoordinatorError('capability_unavailable'));
    const fileInput = configuredMessage(coordinator, {
      commandId: 'send-unsupported-file',
      conversationId: created.conversationId,
      clientMessageId: 'message-unsupported-file',
      content: [{ type: 'text', text: 'file placeholder' }],
    });
    await assert.rejects(() => coordinator.sendMessage({
      ...fileInput,
      content: [{ type: 'file-reference', path: 'README.md' }],
    }), isCoordinatorError('capability_unavailable'));
    const runtimeQueued = await coordinator.sendMessage(configuredMessage(coordinator, {
      commandId: 'send-unsupported-queue',
      conversationId: created.conversationId,
      clientMessageId: 'message-unsupported-queue',
      content: [{ type: 'text', text: 'The Agent runtime owns this queue.' }],
    }));
    assert.equal(runtimeQueued.delivery, 'queued');
    await assert.rejects(() => coordinator.interruptTurn({
      commandId: 'interrupt-unsupported',
      conversationId: created.conversationId,
      turnId: active.turnId,
    }), isCoordinatorError('capability_unavailable'));
    await assert.rejects(() => coordinator.compactConversation({
      commandId: 'compact-unsupported',
      conversationId: created.conversationId,
    }), isCoordinatorError('capability_unavailable'));

    await waitFor(() => journal.turn(runtimeQueued.turnId)?.state === 'completed');
    const runtime = coordinator.projector.runtimeResource(created.conversationId)!;
    assert.equal(runtime.capabilities.turns.queue, true,
      'the viewer sees the Agent lane even when the provider has no native queue');
    const source = journal.turn(active.turnId)!;
    await assert.rejects(() => coordinator.branchConversation({
      commandId: 'fork-unsupported',
      clientMessageId: 'message-fork-unsupported',
      sourceConversationId: created.conversationId,
      sourceStrandId: source.strandId!,
      sourcePathEntryId: source.pathEntryId!,
      expectedHeadRevision: journal.conversationHead(created.conversationId)!.revision,
      content: [{ type: 'text', text: 'Fork this.' }],
      mode: 'fork',
      providerInstanceId: runtime.providerInstanceId,
      model: runtime.composer.nextTurn.model,
      effort: runtime.composer.nextTurn.effort,
      access: runtime.composer.nextTurn.access,
      configurationRevision: runtime.composer.revision,
    }), isCoordinatorError('capability_unavailable'));
  } finally {
    await coordinator.close();
    journal.close();
  }
});

test('native session opening is shared by concurrent hydration and message dispatch', async () => {
  const journal = createJournal();
  const original = new NativeAgentCoordinator({
    journal,
    providers: [{
      providerInstanceId: 'fixture-local',
      provider: 'fixture',
      label: 'Fixture',
      adapter: new NativeFixtureAdapter(),
    }],
  });
  await original.initialize();
  const created = await original.createConversation({
    commandId: 'create-open-race',
    providerInstanceId: 'fixture-local',
    cwd: '/workspace/remux',
    model: 'fixture-native-v1',
    access: 'workspace-write',
  });
  await original.close();

  const adapter = new NativeFixtureAdapter();
  const replacement = new NativeAgentCoordinator({
    journal,
    providers: [{
      providerInstanceId: 'fixture-local',
      provider: 'fixture',
      label: 'Fixture',
      adapter,
    }],
  });
  try {
    await replacement.initialize();
    const hydration = replacement.prepareTranscriptRead({
      focusedConversationId: created.conversationId,
      requests: [{ key: `agent/transcript:${created.conversationId}:tail-24` }],
    });
    const send = replacement.sendMessage(configuredMessage(replacement, {
      commandId: 'send-open-race',
      conversationId: created.conversationId,
      clientMessageId: 'message-open-race',
      content: [{ type: 'text', text: 'Use the session already being hydrated.' }],
    }));
    await Promise.all([hydration, send]);
    await waitFor(() => (adapter.opened[0]?.providerDispatchCount ?? 0) === 1);
    assert.equal(adapter.opened.length, 1);
    assert.equal(adapter.opened[0]?.providerDispatchCount, 1);
  } finally {
    await replacement.close();
    journal.close();
  }
});

test('initialization wakes a durable idle queue without a connected viewer', async () => {
  const journal = createJournal();
  const original = new NativeAgentCoordinator({
    journal,
    providers: [{
      providerInstanceId: 'fixture-local',
      provider: 'fixture',
      label: 'Fixture',
      adapter: new NativeFixtureAdapter(),
    }],
  });
  await original.initialize();
  const created = await original.createConversation({
    commandId: 'create-startup-queue',
    providerInstanceId: 'fixture-local',
    cwd: '/workspace/remux',
    model: 'fixture-native-v1',
    access: 'workspace-write',
  });
  await original.close();

  const commandId = 'send-committed-before-restart';
  const turnId = 'turn-committed-before-restart';
  const content = [{ type: 'text' as const, text: 'Run after the Agent server restarts.' }];
  journal.claimCommand(commandId, 'turn.send', { commandId }, Date.now());
  journal.transaction(() => {
    journal.enqueueTurn({
      commandId,
      conversationId: created.conversationId,
      turnId,
      clientMessageId: 'message-committed-before-restart',
      content,
      model: 'fixture-native-v1',
      access: 'workspace-write',
      now: Date.now(),
    });
    journal.acceptCommand(commandId, {
      accepted: true,
      commandId,
      turnId,
      delivery: 'queued',
    }, Date.now());
  });

  const resumedAdapter = new NativeFixtureAdapter();
  const resumed = new NativeAgentCoordinator({
    journal,
    providers: [{
      providerInstanceId: 'fixture-local',
      provider: 'fixture',
      label: 'Fixture',
      adapter: resumedAdapter,
    }],
  });
  try {
    await resumed.initialize();
    await waitFor(() => journal.turn(turnId)?.state === 'completed');
    assert.equal(resumedAdapter.opened[0]?.providerDispatchCount, 1);
    assert.equal(journal.queuedMessages(created.conversationId).length, 0);
  } finally {
    await resumed.close();
    journal.close();
  }
});

test('native session resume receives durable Remux-to-provider turn bindings', async () => {
  const journal = createJournal();
  const originalAdapter = new NativeFixtureAdapter();
  const original = new NativeAgentCoordinator({
    journal,
    providers: [{
      providerInstanceId: 'fixture-local',
      provider: 'fixture',
      label: 'Fixture',
      adapter: originalAdapter,
    }],
  });
  await original.initialize();
  const created = await original.createConversation({
    commandId: 'create-resume-bindings',
    providerInstanceId: 'fixture-local',
    cwd: '/workspace/remux',
    model: 'fixture-native-v1',
    access: 'workspace-write',
  });
  const first = await original.sendMessage(configuredMessage(original, {
    commandId: 'send-before-resume-bindings',
    conversationId: created.conversationId,
    clientMessageId: 'message-before-resume-bindings',
    content: [{ type: 'text', text: 'Persist the native turn identity.' }],
  }));
  await waitFor(() => journal.turn(first.turnId)?.state === 'completed');
  const nativeTurnId = journal.turn(first.turnId)?.nativeTurnId;
  assert.ok(nativeTurnId);
  await original.close();

  const resumedAdapter = new NativeFixtureAdapter();
  const resumed = new NativeAgentCoordinator({
    journal,
    providers: [{
      providerInstanceId: 'fixture-local',
      provider: 'fixture',
      label: 'Fixture',
      adapter: resumedAdapter,
    }],
  });
  try {
    await resumed.initialize();
    const second = await resumed.sendMessage(configuredMessage(resumed, {
      commandId: 'send-after-resume-bindings',
      conversationId: created.conversationId,
      clientMessageId: 'message-after-resume-bindings',
      content: [{ type: 'text', text: 'Resume without cloning the previous turn.' }],
    }));
    assert.equal(journal.turn(second.turnId)?.state, 'running');
    assert.deepEqual(resumedAdapter.opened[0]?.openedWith.nativeTurnBindings, [{
      turnId: first.turnId,
      nativeTurnId,
      nextBlockOrdinal: journal.nextTurnBlockOrdinal(first.turnId),
      branchCursor: { version: 1, nativeTurnId },
    }]);
    assert.equal(journal.turns(created.conversationId).length, 2);
  } finally {
    await resumed.close();
    journal.close();
  }
});

test('native coordinator recreates only an unmaterialized Claude session after restart', async () => {
  const journal = createJournal();
  const originalAdapter = new NativeFixtureAdapter({ provider: 'claude-code' });
  const original = new NativeAgentCoordinator({
    journal,
    providers: [{
      providerInstanceId: 'claude-local',
      provider: 'claude-code',
      label: 'Claude',
      adapter: originalAdapter,
    }],
  });
  await original.initialize();
  const created = await original.createConversation({
    commandId: 'create-unmaterialized-claude',
    providerInstanceId: 'claude-local',
    cwd: '/workspace/remux',
    model: 'fixture-native-v1',
    access: 'workspace-write',
  });
  const firstNativeId = originalAdapter.opened[0]!.nativeSession.sessionId;
  // Model the real Claude lifecycle: the requested UUID is bound before the
  // CLI has accepted a first prompt or emitted its authoritative init event.
  const rootExecutionId = journal.conversation(created.conversationId)!.rootExecutionId;
  await waitFor(() => journal.nativeSessionMaterialized(rootExecutionId));
  journal.database.prepare(`
    DELETE FROM events WHERE execution_id = (
      SELECT root_execution_id FROM conversations WHERE conversation_id = ?
    )
  `).run(created.conversationId);
  await original.close();
  journal.markConversationRecovering(created.conversationId, undefined, Date.now());

  const replacementAdapter = new NativeFixtureAdapter({ provider: 'claude-code' });
  const replacement = new NativeAgentCoordinator({
    journal,
    providers: [{
      providerInstanceId: 'claude-local',
      provider: 'claude-code',
      label: 'Claude',
      adapter: replacementAdapter,
    }],
  });
  try {
    await replacement.initialize();
    assert.equal(replacementAdapter.opened.length, 1);
    assert.equal(replacementAdapter.opened[0]?.nativeSession.sessionId === firstNativeId, false);
    const rebound = journal.nativeSession(rootExecutionId);
    assert.equal(rebound?.sessionId, replacementAdapter.opened[0]?.nativeSession.sessionId);
    assert.equal(journal.conversation(created.conversationId)?.state, 'idle');
  } finally {
    await replacement.close();
    journal.close();
  }
});

test('native coordinator projects device login across viewer reloads and reprobes after completion', async () => {
  const journal = createJournal();
  const adapter = new AuthenticationFixtureAdapter();
  const coordinator = new NativeAgentCoordinator({
    journal,
    providers: [{
      providerInstanceId: 'fixture-local',
      provider: 'fixture',
      label: 'Fixture',
      adapter,
    }],
  });
  try {
    await coordinator.initialize();
    const result = await coordinator.startProviderLogin({
      commandId: 'login-1',
      providerInstanceId: 'fixture-local',
      mode: 'device-code',
    });
    await waitFor(() => providerEntry(coordinator)?.loginOperation?.state === 'waiting');
    const waiting = providerEntry(coordinator);
    assert.equal(waiting?.state, 'signed-out');
    assert.deepEqual(waiting?.loginOperation, {
      operationId: result.operationId,
      mode: 'device-code',
      state: 'waiting',
      verificationUri: 'https://example.test/device',
      userCode: 'ABCD-EFGH',
      startedAt: waiting?.loginOperation?.startedAt,
    });
    assert.doesNotMatch(JSON.stringify(waiting), /login-native-1|accessToken|refreshToken/iu);

    adapter.completeLogin();
    await waitFor(() => providerEntry(coordinator)?.state === 'ready');
    assert.equal(providerEntry(coordinator)?.loginOperation?.state, 'completed');
    assert.deepEqual(await coordinator.startProviderLogin({
      commandId: 'login-1',
      providerInstanceId: 'fixture-local',
      mode: 'device-code',
    }), result);
    assert.equal(adapter.loginStarts, 1);

    assert.deepEqual(await coordinator.logoutProvider({
      commandId: 'logout-1',
      providerInstanceId: 'fixture-local',
    }), { accepted: true });
    assert.equal(providerEntry(coordinator)?.state, 'signed-out');
    assert.equal(providerEntry(coordinator)?.loginOperation, undefined);
    assert.equal(adapter.logouts, 1);
  } finally {
    await coordinator.close();
    journal.close();
  }
});

test('resource reload reprobes a provider authenticated outside Remux', async () => {
  const journal = createJournal();
  const adapter = new AuthenticationFixtureAdapter();
  let now = 1_000;
  const coordinator = new NativeAgentCoordinator({
    journal,
    providers: [{
      providerInstanceId: 'fixture-local',
      provider: 'fixture',
      label: 'Fixture',
      adapter,
    }],
    now: () => now,
  });
  try {
    await coordinator.initialize();
    assert.equal(providerEntry(coordinator)?.state, 'signed-out');
    adapter.signInExternally();
    now += 6_000;
    coordinator.prepareResourceRead({ requests: [{ key: 'agent/providers' }] });
    await waitFor(() => providerEntry(coordinator)?.state === 'ready');
  } finally {
    await coordinator.close();
    journal.close();
  }
});

test('provider resource reads refresh account usage without opening a conversation session', async () => {
  const journal = createJournal();
  const native = new NativeFixtureAdapter();
  let usageReads = 0;
  const invalidations: string[][] = [];
  const adapter: ProviderAdapter = {
    probe: (providerInstanceId) => native.probe(providerInstanceId),
    listModels: (providerInstanceId) => native.listModels(providerInstanceId),
    openSession: (input) => native.openSession(input),
    readAccountUsage: async () => {
      usageReads += 1;
      return {
        availability: 'available',
        windows: [{
          id: 'fixture:weekly',
          label: 'Weekly',
          kind: 'weekly',
          model: null,
          usedPercent: 43,
          resetsAt: 1_800_000_000_000,
        }],
        source: 'provider-read',
        freshness: 'live',
        observedAt: 1_700_000_000_000,
      };
    },
  };
  const coordinator = new NativeAgentCoordinator({
    journal,
    providers: [{
      providerInstanceId: 'fixture-local',
      provider: 'fixture',
      label: 'Fixture',
      adapter,
    }],
    onResourcesInvalidated: (keys) => invalidations.push([...keys]),
  });
  try {
    await coordinator.initialize();
    coordinator.prepareResourceRead({
      visibility: 'foreground',
      requests: [{ key: 'agent/providers' }],
    });
    await waitFor(() => providerEntry(coordinator)?.accountUsage.windows.length === 1);
    assert.equal(usageReads, 1);
    assert.equal(native.opened.length, 0);
    assert.equal(providerEntry(coordinator)?.accountUsage.windows[0]?.usedPercent, 43);
    assert.ok(invalidations.some((keys) => keys.includes('agent/providers')));

    coordinator.prepareResourceRead({
      visibility: 'foreground',
      requests: [{ key: 'agent/providers' }],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(usageReads, 1, 'provider reads are throttled across frequent resource refreshes');
  } finally {
    await coordinator.close();
    journal.close();
  }
});

test('native coordinator maps provider history without eagerly opening every native session', async () => {
  const journal = createJournal();
  const native = new NativeFixtureAdapter();
  const adapter: ProviderAdapter = {
    probe: async (providerInstanceId) => {
      const probe = await native.probe(providerInstanceId);
      return {
        ...probe,
        ...(probe.capabilities ? {
          capabilities: {
            ...probe.capabilities,
            session: { ...probe.capabilities.session, discoverHistory: true },
          },
        } : {}),
      };
    },
    listModels: (providerInstanceId) => native.listModels(providerInstanceId),
    discoverSessions: async (input) => [{
      nativeSession: {
        provider: 'fixture',
        providerInstanceId: input.providerInstanceId,
        sessionId: 'native-history-1',
        resumeCursor: { privateCursor: 'server-only' },
      },
      title: 'Historical native chat',
      preview: 'Continue the native thread.',
      cwd: '/workspace/history',
      createdAt: 1_000,
      updatedAt: 2_000,
    }],
    openSession: (input) => native.openSession(input),
  };
  const coordinator = new NativeAgentCoordinator({
    journal,
    providers: [{
      providerInstanceId: 'fixture-local',
      provider: 'fixture',
      label: 'Fixture',
      adapter,
    }],
  });
  try {
    await coordinator.initialize();
    const conversation = journal.conversations()[0]!;
    assert.equal(conversation.title, 'Historical native chat');
    assert.equal(conversation.preview, 'Continue the native thread.');
    assert.equal(conversation.cwd, '/workspace/history');
    assert.equal(native.opened.length, 0);
    assert.doesNotMatch(JSON.stringify(coordinator.projector.project('agent/conversations')), /privateCursor/u);

    coordinator.prepareResourceRead({
      focusedConversationId: conversation.conversationId,
      requests: [{ key: `agent/runtime:${conversation.conversationId}` }],
    });
    assert.equal(native.opened.length, 0,
      'control-plane reads never resume or snapshot provider history');
    assert.equal(conversation.history.state, 'indexed');

    await coordinator.prepareTranscriptRead({
      focusedConversationId: conversation.conversationId,
      requests: [{ key: `agent/transcript:${conversation.conversationId}:tail-24` }],
    });
    assert.equal(native.opened.length, 1);
    assert.equal(native.opened[0]?.nativeSession.sessionId, 'native-history-1');
    assert.equal(native.opened[0]?.isClosed, true,
      'a history-only native provider process is closed after its snapshot');
    assert.equal(journal.conversation(conversation.conversationId)?.history.state, 'ready');
  } finally {
    await coordinator.close();
    journal.close();
  }
});

test('cached native history revalidates in the background and mutations wait for provider truth', async () => {
  const journal = createJournal();
  let now = 10_000;
  let historyRevision = 'history-r1';
  let historyTurnCount = 1;
  const native = new NativeFixtureAdapter({
    snapshotAuthority: 'authoritative',
    historyRevision: () => historyRevision,
    snapshotEvents: (input) => fixtureHistoryEvents(input, historyTurnCount),
  });
  const adapter: ProviderAdapter = {
    probe: async (providerInstanceId) => {
      const probe = await native.probe(providerInstanceId);
      return {
        ...probe,
        capabilities: probe.capabilities ? {
          ...probe.capabilities,
          session: { ...probe.capabilities.session, discoverHistory: true },
        } : undefined,
      };
    },
    listModels: (providerInstanceId) => native.listModels(providerInstanceId),
    discoverSessions: async (input) => [{
      nativeSession: {
        provider: 'fixture',
        providerInstanceId: input.providerInstanceId,
        sessionId: 'native-changing-history',
      },
      title: 'Changing native history',
      historyRevision,
      createdAt: 1_000,
      updatedAt: now,
    }],
    openSession: (input) => native.openSession(input),
  };
  const coordinator = new NativeAgentCoordinator({
    journal,
    providers: [{
      providerInstanceId: 'fixture-local',
      provider: 'fixture',
      label: 'Fixture',
      adapter,
    }],
    now: () => now,
  });
  try {
    await coordinator.initialize();
    const conversation = journal.conversations()[0]!;
    await coordinator.prepareTranscriptRead({
      focusedConversationId: conversation.conversationId,
      requests: [{ key: `agent/transcript:${conversation.conversationId}:tail-24` }],
    });
    assert.equal(journal.turns(conversation.conversationId).length, 1);
    assert.deepEqual(journal.conversation(conversation.conversationId)?.history, {
      state: 'ready',
      lastSyncedAt: now,
      nativeRevision: 'history-r1',
      syncedRevision: 'history-r1',
    });
    assert.equal(native.opened.length, 1);
    assert.equal(native.opened[0]?.isClosed, true);

    now += 31_000;
    historyRevision = 'history-r2';
    historyTurnCount = 2;
    await coordinator.prepareTranscriptRead({
      focusedConversationId: conversation.conversationId,
      requests: [{ key: `agent/transcript:${conversation.conversationId}:tail-24` }],
    });
    await waitFor(() => journal.turns(conversation.conversationId).length === 2);
    assert.equal(journal.conversation(conversation.conversationId)?.history.syncedRevision,
      'history-r2');
    assert.equal(native.opened.length, 2);
    assert.equal(native.opened[1]?.providerSnapshotCount, 1);
    assert.equal(native.opened[1]?.isClosed, true);

    historyRevision = 'history-r3';
    historyTurnCount = 3;
    const sent = await coordinator.sendMessage(configuredMessage(coordinator, {
      commandId: 'send-after-native-history-change',
      conversationId: conversation.conversationId,
      clientMessageId: 'message-after-native-history-change',
      content: [{ type: 'text', text: 'Continue after the native update.' }],
    }));
    assert.equal(sent.delivery, 'sent');
    assert.equal(journal.turns(conversation.conversationId).length, 4,
      'the local turn is appended only after all three native turns are synchronized');
    assert.equal(native.opened.length, 3,
      'the required-fresh session is reused for the outgoing turn');
    assert.equal(native.opened[2]?.providerSnapshotCount, 1);
    assert.equal(native.opened[2]?.providerDispatchCount, 1);
  } finally {
    await coordinator.close();
    journal.close();
  }
});

test('events emitted before admission remain durable through a forced history refresh', async () => {
  const journal = createJournal();
  const native = new NativeFixtureAdapter({ delayMs: 20, snapshotAuthority: 'session-local' });
  let clockFloor = Date.now();
  let initialEvents: readonly ProviderEventEnvelope[] = [];
  const adapter: ProviderAdapter = {
    probe: (id) => native.probe(id),
    listModels: (id) => native.listModels(id),
    openSession: async (input) => {
      const session = await native.openSession(input);
      const start = session.startTurn.bind(session);
      session.startTurn = async (request, boundary) => {
        const accepted = await start(request, boundary);
        initialEvents = (await session.snapshot({ commandId: 'inspect-before-admission' })).events;
        clockFloor = Math.max(...initialEvents.map(({ observedAt }) => observedAt)) + 1;
        return accepted;
      };
      return session;
    },
  };
  const coordinator = new NativeAgentCoordinator({
    journal,
    providers: [{ providerInstanceId: 'fixture-local', provider: 'fixture', label: 'Fixture', adapter }],
    now: () => Math.max(clockFloor, Date.now()),
  });
  try {
    await coordinator.initialize();
    const conversation = await coordinator.createConversation({
      commandId: 'create-early-events', providerInstanceId: 'fixture-local',
      cwd: '/workspace/remux', model: 'fixture-native-v1', access: 'workspace-write',
    });
    const sent = await coordinator.sendMessage(configuredMessage(coordinator, {
      commandId: 'send-early-events', conversationId: conversation.conversationId,
      clientMessageId: 'early-message', content: [{ type: 'text', text: 'Complete this turn.' }],
    }));
    await waitFor(() => journal.turn(sent.turnId)?.state === 'completed');
    const initialTurnEvents = initialEvents.filter(({ scope }) => scope.kind === 'turn');
    assert.ok(initialTurnEvents.some(({ event }) => event.type === 'turn.started'));
    const turn = journal.turn(sent.turnId)!;
    const savedIds = new Set(journal.eventsForTurn(sent.turnId).map(({ eventId }) => eventId));
    for (const early of initialTurnEvents) {
      assert.ok(early.observedAt < turn.createdAt);
      assert.ok(savedIds.has(early.eventId), `early ${early.event.type} must be durable`);
    }
    await coordinator.prepareTranscriptRead({
      focusedConversationId: conversation.conversationId,
      requests: [{ key: `agent/transcript:${conversation.conversationId}:tail-24` }],
      historySync: 'force',
    });
    assert.equal(journal.conversation(conversation.conversationId)?.history.state, 'ready');
    assert.equal(journal.turn(sent.turnId)?.state, 'completed');
    assert.equal(journal.turn(sent.turnId)?.updatedAt, turn.updatedAt);
    assert.equal(native.opened[0]?.providerDispatchCount, 1);
  } finally {
    await coordinator.close();
    journal.close();
  }
});

test('a failed required history sync blocks send until an explicit transcript retry succeeds', async () => {
  const journal = createJournal();
  let historyRevision = 'history-r1';
  let historyTurnCount = 1;
  let failHistoryRead = false;
  const native = new NativeFixtureAdapter({
    snapshotAuthority: 'authoritative',
    historyRevision: () => historyRevision,
    snapshotEvents: (input) => {
      if (failHistoryRead) throw new Error('Fixture history read failed.');
      return fixtureHistoryEvents(input, historyTurnCount);
    },
  });
  const adapter: ProviderAdapter = {
    probe: async (providerInstanceId) => {
      const probe = await native.probe(providerInstanceId);
      return {
        ...probe,
        capabilities: probe.capabilities ? {
          ...probe.capabilities,
          session: { ...probe.capabilities.session, discoverHistory: true },
        } : undefined,
      };
    },
    listModels: (providerInstanceId) => native.listModels(providerInstanceId),
    discoverSessions: async (input) => [{
      nativeSession: {
        provider: 'fixture',
        providerInstanceId: input.providerInstanceId,
        sessionId: 'native-failing-history',
      },
      title: 'Failing native history',
      historyRevision,
      createdAt: 1_000,
      updatedAt: 2_000,
    }],
    openSession: (input) => native.openSession(input),
  };
  const coordinator = new NativeAgentCoordinator({
    journal,
    providers: [{
      providerInstanceId: 'fixture-local',
      provider: 'fixture',
      label: 'Fixture',
      adapter,
    }],
  });
  try {
    await coordinator.initialize();
    const conversation = journal.conversations()[0]!;
    const transcriptRequest = {
      focusedConversationId: conversation.conversationId,
      requests: [{ key: `agent/transcript:${conversation.conversationId}:tail-24` }],
    } as const;
    await coordinator.prepareTranscriptRead(transcriptRequest);

    historyRevision = 'history-r2';
    historyTurnCount = 2;
    failHistoryRead = true;
    await assert.rejects(coordinator.sendMessage(configuredMessage(coordinator, {
      commandId: 'send-with-failed-history',
      conversationId: conversation.conversationId,
      clientMessageId: 'message-with-failed-history',
      content: [{ type: 'text', text: 'Do not dispatch this yet.' }],
    })), /Fixture history read failed/u);
    assert.equal(journal.commandReceipt('send-with-failed-history')?.state, 'rejected');
    assert.equal(journal.turns(conversation.conversationId).length, 1);
    assert.equal(journal.conversation(conversation.conversationId)?.history.state, 'failed');
    assert.equal(native.opened.at(-1)?.providerDispatchCount, 0);

    failHistoryRead = false;
    await coordinator.prepareTranscriptRead({ ...transcriptRequest, historySync: 'force' });
    assert.equal(journal.turns(conversation.conversationId).length, 2);
    assert.equal(journal.conversation(conversation.conversationId)?.history.state, 'ready');
    assert.equal(journal.conversation(conversation.conversationId)?.history.syncedRevision,
      'history-r2');
  } finally {
    await coordinator.close();
    journal.close();
  }
});

test('native history hydration cancels when its last transcript reader leaves', async () => {
  const journal = createJournal();
  const native = new NativeFixtureAdapter({ snapshotDelayMs: 60_000 });
  const adapter: ProviderAdapter = {
    probe: async (providerInstanceId) => {
      const probe = await native.probe(providerInstanceId);
      return {
        ...probe,
        capabilities: probe.capabilities ? {
          ...probe.capabilities,
          session: { ...probe.capabilities.session, discoverHistory: true },
        } : undefined,
      };
    },
    listModels: (providerInstanceId) => native.listModels(providerInstanceId),
    discoverSessions: async (input) => [{
      nativeSession: {
        provider: 'fixture',
        providerInstanceId: input.providerInstanceId,
        sessionId: 'native-slow-history',
      },
      title: 'Slow history',
    }],
    openSession: (input) => native.openSession(input),
  };
  const coordinator = new NativeAgentCoordinator({
    journal,
    providers: [{
      providerInstanceId: 'fixture-local',
      provider: 'fixture',
      label: 'Fixture',
      adapter,
    }],
  });
  try {
    await coordinator.initialize();
    const conversation = journal.conversations()[0]!;
    const controller = new AbortController();
    const hydration = coordinator.prepareTranscriptRead({
      focusedConversationId: conversation.conversationId,
      requests: [{ key: `agent/transcript:${conversation.conversationId}:tail-24` }],
    }, controller.signal);
    await waitFor(() => journal.conversation(conversation.conversationId)?.history.state === 'loading');
    controller.abort(new Error('viewer backgrounded'));
    await assert.rejects(hydration, (error) =>
      error instanceof Error && error.name === 'AbortError');
    await waitFor(() => journal.conversation(conversation.conversationId)?.history.state === 'indexed');
    assert.equal(native.opened.length, 1);
  } finally {
    await coordinator.close();
    journal.close();
  }
});

test('edit creates a new strand in place while fork creates a child conversation', async () => {
  const journal = createJournal();
  const branchImageBoundaries: string[] = [];
  const adapter = new NativeFixtureAdapter({ nativeFork: true, finalText: 'Done.',
    afterTurnAccepted: (input) => {
      const artifactId = imageArtifactId(input.content);
      if (!artifactId) return;
      assert.equal(journal.artifactGrantedTo({ conversationId: input.conversationId,
        executionId: input.executionId }, artifactId), true);
      branchImageBoundaries.push(artifactId);
    } });
  const coordinator = new NativeAgentCoordinator({
    journal,
    providers: [{
      providerInstanceId: 'fixture-local',
      provider: 'fixture',
      label: 'Fixture',
      adapter,
    }],
  });
  try {
    await coordinator.initialize();
    const created = await coordinator.createConversation({
      commandId: 'create-lineage',
      providerInstanceId: 'fixture-local',
      cwd: '/workspace/remux',
      model: 'fixture-native-v1',
      effort: 'high',
      access: 'workspace-write',
    });
    const original = await coordinator.sendMessage(configuredMessage(coordinator, {
      commandId: 'send-lineage-original',
      conversationId: created.conversationId,
      clientMessageId: 'message-lineage-original',
      content: [{ type: 'text', text: 'Original prompt.' }],
    }));
    await waitFor(() => journal.turn(original.turnId)?.state === 'completed');
    const originalTurn = journal.turn(original.turnId)!;
    const originalHead = journal.conversationHead(created.conversationId)!;
    const runtime = coordinator.projector.runtimeResource(created.conversationId)!;
    journal.registerArtifact({ artifactId: 'edit-image', sha256: '1'.repeat(64), byteLength: 4,
      mediaType: 'image/png', visibility: 'viewer', storagePath: '1/edit-image', createdAt: 2 });
    journal.registerArtifact({ artifactId: 'fork-image', sha256: '2'.repeat(64), byteLength: 4,
      mediaType: 'image/png', visibility: 'viewer', storagePath: '2/fork-image', createdAt: 2 });
    const edited = await coordinator.branchConversation({
      commandId: 'edit-lineage',
      clientMessageId: 'message-lineage-edited',
      sourceConversationId: created.conversationId,
      sourceStrandId: originalHead.strandId,
      sourcePathEntryId: originalTurn.pathEntryId!,
      expectedHeadRevision: originalHead.revision,
      content: [{ type: 'text', text: 'Edited prompt.' },
        { type: 'image-artifact', artifactId: 'edit-image', mimeType: 'image/png' }],
      mode: 'edit',
      providerInstanceId: runtime.providerInstanceId,
      model: runtime.composer.nextTurn.model,
      effort: runtime.composer.nextTurn.effort,
      access: runtime.composer.nextTurn.access,
      configurationRevision: runtime.composer.revision,
    });
    assert.equal(edited.conversationId, created.conversationId);
    assert.equal(journal.conversationHead(created.conversationId)?.revision, 2);
    assert.equal(journal.conversationVersions(created.conversationId).length, 2);
    assert.equal(journal.artifactGrantedTo({ conversationId: created.conversationId,
      executionId: journal.turn(edited.turnId)!.executionId }, 'edit-image'), true);
    assert.deepEqual(
      journal.turns(created.conversationId).map(({ userContent }) => userContent[0]),
      [{ type: 'text', text: 'Edited prompt.' }],
    );

    await waitFor(() => journal.turn(edited.turnId)?.state === 'completed');
    const editedTurn = journal.turn(edited.turnId)!;
    const editedHead = journal.conversationHead(created.conversationId)!;
    const editedRuntime = coordinator.projector.runtimeResource(created.conversationId)!;
    const forked = await coordinator.branchConversation({
      commandId: 'fork-lineage',
      clientMessageId: 'message-lineage-forked',
      sourceConversationId: created.conversationId,
      sourceStrandId: editedHead.strandId,
      sourcePathEntryId: editedTurn.pathEntryId!,
      expectedHeadRevision: editedHead.revision,
      content: [{ type: 'text', text: 'Continue on the fork.' },
        { type: 'image-artifact', artifactId: 'fork-image', mimeType: 'image/png' }],
      mode: 'fork',
      providerInstanceId: editedRuntime.providerInstanceId,
      model: editedRuntime.composer.nextTurn.model,
      effort: editedRuntime.composer.nextTurn.effort,
      access: editedRuntime.composer.nextTurn.access,
      configurationRevision: editedRuntime.composer.revision,
    });
    assert.notEqual(forked.conversationId, created.conversationId);
    assert.equal(journal.artifactGrantedTo({ conversationId: forked.conversationId,
      executionId: journal.turn(forked.turnId)!.executionId }, 'fork-image'), true);
    assert.deepEqual(branchImageBoundaries, ['edit-image', 'fork-image']);
    assert.equal(journal.conversation(forked.conversationId)?.parentConversationId, created.conversationId);
    assert.deepEqual(
      journal.turns(forked.conversationId).map(({ userContent }) => userContent[0]),
      [
        { type: 'text', text: 'Edited prompt.' },
        { type: 'text', text: 'Continue on the fork.' },
      ],
    );

    await waitFor(() => journal.turn(forked.turnId)?.state === 'completed');
    const restored = await coordinator.activateConversationStrand({
      commandId: 'restore-lineage-original',
      conversationId: created.conversationId,
      strandId: originalHead.strandId,
      expectedHeadRevision: editedHead.revision,
    });
    assert.equal(restored.headRevision, 3);
    assert.deepEqual(
      journal.turns(created.conversationId).map(({ userContent }) => userContent[0]),
      [{ type: 'text', text: 'Original prompt.' }],
    );
    const restoreOperation = journal.database.prepare(`
      SELECT mode, state FROM branch_operations WHERE command_id = 'restore-lineage-original'
    `).get() as { mode: string; state: string };
    assert.equal(restoreOperation.mode, 'restore');
    assert.equal(restoreOperation.state, 'activated');
  } finally {
    await coordinator.close();
    journal.close();
  }
});

test('provider-accepted edit fails closed when the conversation head changes before activation', async () => {
  const journal = createJournal();
  const adapter = new NativeFixtureAdapter({
    nativeFork: true,
    finalText: 'Done.',
    afterTurnAccepted: (input) => {
      if (input.commandId !== 'edit-head-race:turn') return;
      journal.database.prepare(`
        UPDATE conversation_heads SET revision = revision + 1 WHERE conversation_id = ?
      `).run(input.conversationId);
    },
  });
  const coordinator = new NativeAgentCoordinator({
    journal,
    providers: [{
      providerInstanceId: 'fixture-local',
      provider: 'fixture',
      label: 'Fixture',
      adapter,
    }],
  });
  try {
    await coordinator.initialize();
    const created = await coordinator.createConversation({
      commandId: 'create-head-race',
      providerInstanceId: 'fixture-local',
      cwd: '/workspace/remux',
      model: 'fixture-native-v1',
      effort: 'high',
      access: 'workspace-write',
    });
    const original = await coordinator.sendMessage(configuredMessage(coordinator, {
      commandId: 'send-head-race',
      conversationId: created.conversationId,
      clientMessageId: 'message-head-race',
      content: [{ type: 'text', text: 'Original prompt.' }],
    }));
    await waitFor(() => journal.turn(original.turnId)?.state === 'completed');
    const head = journal.conversationHead(created.conversationId)!;
    const originalTurn = journal.turn(original.turnId)!;
    const runtime = coordinator.projector.runtimeResource(created.conversationId)!;

    await assert.rejects(() => coordinator.branchConversation({
      commandId: 'edit-head-race',
      clientMessageId: 'message-head-race-edited',
      sourceConversationId: created.conversationId,
      sourceStrandId: head.strandId,
      sourcePathEntryId: originalTurn.pathEntryId!,
      expectedHeadRevision: head.revision,
      content: [{ type: 'text', text: 'Edited prompt.' }],
      mode: 'edit',
      providerInstanceId: runtime.providerInstanceId,
      model: runtime.composer.nextTurn.model,
      effort: runtime.composer.nextTurn.effort,
      access: runtime.composer.nextTurn.access,
      configurationRevision: runtime.composer.revision,
    }), /changed while the branch was being prepared/);

    assert.equal(journal.commandReceipt('edit-head-race')?.state, 'recovery_failed');
    const operation = journal.database.prepare(`
      SELECT state, destination_strand_id AS destinationStrandId
      FROM branch_operations WHERE command_id = 'edit-head-race'
    `).get() as { state: string; destinationStrandId: string };
    assert.equal(operation.state, 'delivery-unknown');
    assert.equal(journal.strand(operation.destinationStrandId)?.state, 'failed');
    assert.equal(journal.conversationHead(created.conversationId)?.strandId, head.strandId);
    assert.equal(journal.conversationVersions(created.conversationId).length, 1);
  } finally {
    await coordinator.close();
    journal.close();
  }
});

test('an unknown durable root delivery fences later work after its queue card is removed', async () => {
  const journal = createJournal();
  const fixture = new NativeFixtureAdapter();
  let providerWrites = 0;
  const adapter: ProviderAdapter = {
    probe: (id) => fixture.probe(id),
    listModels: (id) => fixture.listModels(id),
    openSession: async (input) => {
      const session = await fixture.openSession(input);
      session.startTurn = async (_request, boundary) => {
        boundary?.markPossiblySent(session.nativeSession.sessionId, 'unknown-fixture-generation');
        providerWrites += 1;
        return { accepted: false, outcome: 'unknown',
          crossing: { phase: 'possibly-sent', detail: 'response-lost' },
          error: { code: 'fixture_response_lost', message: 'Controlled response loss.' } };
      };
      return session;
    },
  };
  const coordinator = new NativeAgentCoordinator({ journal, providers: [{
    providerInstanceId: 'fixture-local', provider: 'fixture', label: 'Fixture', adapter,
  }] });
  try {
    await coordinator.initialize();
    const created = await coordinator.createConversation({ commandId: 'create-unknown-owner',
      providerInstanceId: 'fixture-local', cwd: '/workspace/remux', model: 'fixture-native-v1',
      access: 'workspace-write' });
    const first = await coordinator.sendMessage(configuredMessage(coordinator, {
      commandId: 'unknown-root-1', conversationId: created.conversationId,
      clientMessageId: 'unknown-client-1', content: [{ type: 'text', text: 'First.' }],
    }));
    await waitFor(() => (journal.database.prepare(`SELECT state FROM delivery_attempts
      WHERE command_id='unknown-root-1'`).get() as { state: string } | undefined)?.state === 'unknown');
    assert.equal(journal.commandReceipt('unknown-root-1')?.state, 'accepted');
    journal.removeQueuedTurnById(created.conversationId, first.turnId, Date.now());
    const heldRuntime = coordinator.projector.runtimeResource(created.conversationId)!;
    assert.equal(heldRuntime.composer.editable.access, false);
    await assert.rejects(() => coordinator.setConversationAccess({
      commandId: 'unknown-access-change', conversationId: created.conversationId,
      expectedRevision: heldRuntime.composer.revision, access: 'read-only',
    }), /delivery is unresolved/u);
    await assert.rejects(() => coordinator.compactConversation({
      commandId: 'unknown-compact', conversationId: created.conversationId,
    }), /delivery is unresolved/u);
    await coordinator.sendMessage(configuredMessage(coordinator, {
      commandId: 'unknown-root-2', conversationId: created.conversationId,
      clientMessageId: 'unknown-client-2', content: [{ type: 'text', text: 'Second.' }],
    }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(providerWrites, 1);
    assert.equal((journal.database.prepare(`SELECT state FROM queued_messages
      WHERE command_id='unknown-root-2'`).get() as { state: string }).state, 'queued');

    journal.database.prepare(`UPDATE delivery_attempts SET acceptance_evidence_json=?
      WHERE command_id='unknown-root-1'`).run(JSON.stringify({
      kind: 'fixture-correlated-acceptance',
      sessionId: 'fixture-session-corrupt',
      commandId: 7,
      extra: true,
    }));

    await coordinator.close();
    const restartedAdapter = new NativeFixtureAdapter();
    const restarted = new NativeAgentCoordinator({ journal, providers: [{
      providerInstanceId: 'fixture-local', provider: 'fixture', label: 'Fixture',
      adapter: restartedAdapter,
    }] });
    try {
      await restarted.initialize();
      assert.equal((journal.database.prepare(`SELECT state FROM delivery_attempts
        WHERE command_id='unknown-root-1'`).get() as { state: string }).state, 'unknown',
      'malformed stored proof must leave the durable lane fenced');
      assert.equal(restartedAdapter.opened.length, 0,
        'startup delivery reconciliation must use no writer session');
      const internals = restarted as unknown as {
        openAttachedSession(conversationId: string, executionId: string,
          open: () => Promise<ProviderSession>): Promise<ProviderSession>;
      };
      let attemptedWriterOpens = 0;
      await assert.rejects(
        internals.openAttachedSession(created.conversationId, journal.conversation(
          created.conversationId)!.rootExecutionId, async () => {
          attemptedWriterOpens += 1;
          throw new Error('writer opener must not run');
        }),
        /fenced by unresolved root delivery/u,
      );
      assert.equal(attemptedWriterOpens, 0);
      assert.equal(restartedAdapter.opened.length, 0,
        'passive history hydration must not reopen the unresolved root writer');
      assert.equal((journal.database.prepare(`SELECT state FROM queued_messages
        WHERE command_id='unknown-root-2'`).get() as { state: string }).state, 'queued');
    } finally {
      await restarted.close();
    }
  } finally {
    await coordinator.close();
    journal.close();
  }
});

test('native child terminal events from the root stream never settle the root lifecycle', async () => {
  const journal = createJournal();
  const adapter = new NativeFixtureAdapter({ emitNativeChild: true });
  const terminalTurns: string[] = [];
  const coordinator = new NativeAgentCoordinator({ journal, onTerminalTurn: ({ turnId }) => {
    terminalTurns.push(turnId);
  }, providers: [{
    providerInstanceId: 'fixture-local', provider: 'fixture', label: 'Fixture', adapter,
  }] });
  try {
    await coordinator.initialize();
    const created = await coordinator.createConversation({ commandId: 'create-child-terminal-scope',
      providerInstanceId: 'fixture-local', cwd: '/workspace/remux', model: 'fixture-native-v1',
      access: 'workspace-write' });
    const root = await coordinator.sendMessage(configuredMessage(coordinator, {
      commandId: 'send-child-terminal-scope', conversationId: created.conversationId,
      clientMessageId: 'message-child-terminal-scope', content: [{ type: 'text', text: 'Spawn.' }],
    }));
    await waitFor(() => journal.turn(root.turnId)?.state === 'completed');
    const rootExecutionId = journal.conversation(created.conversationId)!.rootExecutionId;
    const childExecutionId = `${rootExecutionId}:native-child-1`;
    await waitFor(() => journal.execution(childExecutionId) !== undefined);
    await new Promise<void>((resolve) => setImmediate(resolve));
    journal.claimCommand('queued-after-child-terminal', 'turn.send', {
      commandId: 'queued-after-child-terminal', conversationId: created.conversationId,
    }, Date.now());
    journal.enqueueTurn({ commandId: 'queued-after-child-terminal',
      conversationId: created.conversationId, turnId: 'queued-after-child-terminal-turn',
      clientMessageId: 'queued-after-child-terminal-message',
      content: [{ type: 'text', text: 'Remain queued.' }], model: 'fixture-native-v1',
      access: 'workspace-write', now: Date.now() });
    journal.acceptCommand('queued-after-child-terminal', {
      accepted: true, commandId: 'queued-after-child-terminal',
      turnId: 'queued-after-child-terminal-turn', delivery: 'queued',
    }, Date.now());
    const childTurnId = 'scoped-native-child-turn';
    const childSessionId = `${adapter.opened[0]!.nativeSession.sessionId}:child-1`;
    const make = (eventId: string, event: { type: 'turn.started' } | {
      type: 'turn.completed'; outcome: 'completed';
    }) => parseProviderEventEnvelope({
      contractVersion: PROVIDER_RUNTIME_CONTRACT_VERSION,
      eventId, provider: 'fixture',
      scope: { kind: 'turn', providerInstanceId: 'fixture-local',
        conversationId: created.conversationId, executionId: childExecutionId, turnId: childTurnId },
      native: { sessionId: childSessionId, turnId: 'native-child-turn', kind: eventId },
      observedAt: Date.now(), event,
    });
    const internals = coordinator as unknown as { consumeEventBatch(
      conversationId: string, executionId: string, events: readonly ProviderEventEnvelope[]): Promise<void> };
    await internals.consumeEventBatch(created.conversationId, rootExecutionId, [
      make('child-turn-started-scoped', { type: 'turn.started' }),
      make('child-turn-completed-scoped', { type: 'turn.completed', outcome: 'completed' }),
    ]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(terminalTurns, [root.turnId]);
    assert.equal(journal.turn(childTurnId)?.outcome, 'completed');
    assert.equal(adapter.opened[0]?.providerDispatchCount, 1);
    assert.equal((journal.database.prepare(`SELECT state FROM queued_messages
      WHERE command_id='queued-after-child-terminal'`).get() as { state: string }).state, 'queued');
  } finally {
    await coordinator.close();
    journal.close();
  }
});

function createJournal() {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON');
  createNativeAgentSchema(database);
  return new NativeAgentJournal(database);
}

function imageArtifactId(content: readonly UserContentPart[]) {
  for (const part of content) if (part.type === 'image-artifact') return part.artifactId;
  return undefined;
}

function fixtureHistoryEvents(
  input: OpenProviderSessionInput,
  turnCount: number,
): ProviderEventEnvelope[] {
  const events: ProviderEventEnvelope[] = [];
  let sequence = 0;
  for (let index = 0; index < turnCount; index += 1) {
    const turnId = `native-history-turn-${index + 1}`;
    for (const event of [{
      type: 'user.message' as const,
      content: [{ type: 'text' as const, text: `Historical prompt ${index + 1}` }],
    }, {
      type: 'turn.started' as const,
    }, {
      type: 'turn.completed' as const,
      outcome: 'completed' as const,
    }] satisfies ProviderEvent[]) {
      sequence += 1;
      events.push({
        contractVersion: PROVIDER_RUNTIME_CONTRACT_VERSION,
        eventId: `native-changing-history:${turnId}:${event.type}`,
        provider: 'fixture',
        scope: {
          kind: 'turn',
          providerInstanceId: input.providerInstanceId,
          conversationId: input.conversationId,
          executionId: input.executionId,
          turnId,
        },
        native: {
          sessionId: input.nativeSession?.sessionId ?? 'native-changing-history',
          turnId,
          position: { kind: 'native-sequence', sequence, subIndex: 0 },
          kind: event.type,
        },
        observedAt: 1_000 + sequence,
        event,
      });
    }
  }
  return events;
}

function configuredMessage(
  coordinator: NativeAgentCoordinator,
  input: {
    commandId: string;
    conversationId: string;
    clientMessageId: string;
    content: readonly UserContentPart[];
  },
) {
  const runtime = coordinator.projector.runtimeResource(input.conversationId);
  if (!runtime) throw new Error('Conversation runtime is unavailable.');
  return {
    ...input,
    providerInstanceId: runtime.providerInstanceId,
    model: runtime.composer.nextTurn.model,
    effort: runtime.composer.nextTurn.effort,
    access: runtime.composer.nextTurn.access,
    configurationRevision: runtime.composer.revision,
    delivery: 'auto' as const,
  };
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error(message)), milliseconds);
    }),
  ]).finally(() => clearTimeout(timeout));
}

function providerEntry(coordinator: NativeAgentCoordinator) {
  const resource = coordinator.projector.read({ requests: [{ key: 'agent/providers' }] });
  const projected = resource.resources[0];
  if (projected?.status !== 'ok' || !('providers' in projected.value)) return undefined;
  return projected.value.providers[0];
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('Condition timed out.');
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function isCoordinatorError(code: string) {
  return (error: unknown) => error instanceof Error &&
    'errorCode' in error && error.errorCode === code;
}

class AuthenticationFixtureAdapter implements ProviderAdapter {
  readonly native = new NativeFixtureAdapter();
  loginStarts = 0;
  logouts = 0;
  private signedIn = false;
  private loginEvents?: AsyncEventStream<ProviderLoginEvent>;

  async probe(providerInstanceId: string) {
    const nativeProbe = await this.native.probe(providerInstanceId);
    const capabilities: ProviderCapabilities = {
      ...nativeProbe.capabilities!,
      authentication: { login: 'device-code', logout: true },
    };
    return this.signedIn
      ? { ...nativeProbe, capabilities }
      : {
          state: 'signed-out' as const,
          displayLabel: 'Fixture',
          message: 'Sign in required.',
          capabilities,
        };
  }

  listModels(providerInstanceId: string) {
    return this.native.listModels(providerInstanceId);
  }

  openSession(input: Parameters<NativeFixtureAdapter['openSession']>[0]) {
    return this.native.openSession(input);
  }

  async startLogin(_input: ProviderLoginStartInput): Promise<ProviderLoginOperation> {
    this.loginStarts += 1;
    const events = new AsyncEventStream<ProviderLoginEvent>();
    this.loginEvents = events;
    events.emit({
      type: 'prompt',
      loginId: 'login-native-1',
      verificationUri: 'https://example.test/device',
      userCode: 'ABCD-EFGH',
    });
    return {
      loginId: 'login-native-1',
      events,
      cancel: async () => {
        events.emit({ type: 'completed', success: false, error: 'Canceled.' });
        events.close();
      },
      close: async () => events.close(),
    };
  }

  completeLogin() {
    this.signInExternally();
    this.loginEvents?.emit({ type: 'completed', success: true });
    this.loginEvents?.close();
  }

  signInExternally() {
    this.signedIn = true;
  }

  async logout() {
    this.logouts += 1;
    this.signedIn = false;
    return { accepted: true as const };
  }
}
