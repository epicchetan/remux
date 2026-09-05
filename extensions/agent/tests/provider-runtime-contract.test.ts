import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PROVIDER_RUNTIME_CONTRACT_VERSION,
  PROVIDER_RUNTIME_LIMITS,
  ProviderContractError,
  parseDiscoverProviderSessionsInput,
  parseInterruptProviderTurnInput,
  parseNativeForkRequest,
  parseOpenProviderSessionInput,
  parseProviderCapabilities,
  parseProviderEventEnvelope,
  parseProviderSnapshot,
  parseProviderSnapshotRequest,
  parseStartProviderTurnInput,
  parseSteerProviderTurnInput,
  type OpenProviderSessionInput,
  type ProviderCapabilities,
  type ProviderEventEnvelope,
  type StartProviderTurnInput,
} from '../shared/provider-runtime.ts';
import { NativeFixtureAdapter } from '../server/src/native-fixture-adapter.ts';

const capabilities: ProviderCapabilities = {
  protocolVersion: PROVIDER_RUNTIME_CONTRACT_VERSION,
  provider: 'codex',
  providerVersion: 'codex-fixture',
  adapterVersion: 'adapter-fixture',
  auth: 'native-subscription',
  authentication: { login: 'device-code', logout: true },
  session: {
    create: true,
    resume: true,
    discoverHistory: true,
    readSnapshot: true,
    forkNative: true,
    rollbackNative: true,
  },
  turns: {
    interrupt: true,
    steer: true,
    queue: true,
    changeModelOnExistingSession: true,
    changeEffortOnExistingSession: true,
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
    childTranscript: 'full',
    childSteer: true,
    childInterrupt: true,
  },
  interaction: {
    blockingApprovals: false,
    structuredUserInput: false,
  },
  access: {
    presets: ['read-only', 'workspace-write', 'full-access'],
    defaultPreset: 'workspace-write',
  },
  usage: {
    turn: true,
    cumulative: true,
    context: 'provider',
    plan: 'read-and-push',
    estimatedCost: false,
  },
  compaction: { automaticNative: true, manualNative: true },
};

const openInput: OpenProviderSessionInput = {
  commandId: 'command-open-1',
  providerInstanceId: 'fixture-local',
  conversationId: 'conversation-1',
  executionId: 'execution-1',
  mode: 'create',
  cwd: '/workspace/remux',
  model: 'fixture-native-v1',
  effort: 'high',
  access: 'workspace-write',
  developerInstructions: ['Ask for clarification through ordinary chat.'],
  federation: {
    endpoint: 'http://127.0.0.1:9876/mcp',
    authorizationHeader: 'Bearer fixture-secret',
  },
};

const turnInput: StartProviderTurnInput = {
  commandId: 'command-turn-1',
  conversationId: 'conversation-1',
  turnId: 'turn-1',
  executionId: 'execution-1',
  content: [{ type: 'text', text: 'Inspect the workspace.' }],
};

test('provider capability parsing requires native noninteractive interaction semantics', () => {
  assert.deepEqual(parseProviderCapabilities(structuredClone(capabilities)), capabilities);

  assert.throws(
    () => parseProviderCapabilities({
      ...capabilities,
      interaction: { blockingApprovals: true, structuredUserInput: false },
    }),
    (error) => contractErrorAt(error, '$.interaction.blockingApprovals'),
  );
  assert.throws(
    () => parseProviderCapabilities({ ...capabilities, unexpected: true }),
    (error) => contractErrorAt(error, '$.unexpected'),
  );
});

test('open-session parsing binds an explicit provider instance and native resume identity', () => {
  assert.deepEqual(parseOpenProviderSessionInput(structuredClone(openInput)), openInput);
  const resumed: OpenProviderSessionInput = {
    ...openInput,
    mode: 'resume',
    nativeSession: {
      provider: 'fixture',
      providerInstanceId: 'fixture-local',
      sessionId: 'fixture-session',
    },
    nativeTurnBindings: [{ turnId: 'turn-1', nativeTurnId: 'native-turn-1' }],
    inheritedNativeTurnIds: ['native-turn-inherited-1'],
    activeTurnBinding: { turnId: 'turn-1', nativeTurnId: 'native-turn-1' },
    nativeChildBindings: [{
      nativeThreadId: 'native-child-1', executionId: 'execution-child-1',
      parentExecutionId: 'execution-1', nativeParentThreadId: 'fixture-session',
      ownerTurnId: 'turn-1', ownerNativeTurnId: 'native-turn-1', outcome: 'completed',
    }],
  };
  assert.deepEqual(parseOpenProviderSessionInput(structuredClone(resumed)), resumed);
  assert.throws(
    () => parseOpenProviderSessionInput({
      ...resumed,
      nativeTurnBindings: [
        { turnId: 'turn-1', nativeTurnId: 'native-turn-1' },
        { turnId: 'turn-1', nativeTurnId: 'native-turn-2' },
      ],
    }),
    (error) => contractErrorAt(error, '$.nativeTurnBindings[1]'),
  );
  assert.throws(
    () => parseOpenProviderSessionInput({
      ...resumed,
      activeTurnBinding: { turnId: 'turn-2', nativeTurnId: 'native-turn-2' },
    }),
    (error) => contractErrorAt(error, '$.activeTurnBinding'),
  );
  assert.throws(
    () => parseOpenProviderSessionInput({
      ...resumed,
      inheritedNativeTurnIds: ['native-turn-1'],
    }),
    (error) => contractErrorAt(error, '$.inheritedNativeTurnIds'),
  );
  assert.throws(
    () => parseOpenProviderSessionInput({ ...openInput, mode: 'resume' }),
    (error) => contractErrorAt(error, '$.nativeSession'),
  );
  assert.throws(
    () => parseOpenProviderSessionInput({
      ...openInput,
      mode: 'resume',
      nativeSession: {
        provider: 'fixture',
        providerInstanceId: 'another-instance',
        sessionId: 'fixture-session',
      },
    }),
    (error) => contractErrorAt(error, '$.nativeSession.providerInstanceId'),
  );
});

test('turn parsing rejects ambiguous content and unbounded messages', () => {
  assert.deepEqual(parseStartProviderTurnInput(structuredClone(turnInput)), turnInput);
  assert.throws(
    () => parseStartProviderTurnInput({ ...turnInput, content: [] }),
    (error) => contractErrorAt(error, '$.content'),
  );
  assert.throws(
    () => parseStartProviderTurnInput({
      ...turnInput,
      content: [{ type: 'text', text: 'x', path: '/not-allowed' }],
    }),
    (error) => contractErrorAt(error, '$.content[0].path'),
  );
});

test('all provider commands are strict and fork boundaries are unambiguous', () => {
  assert.deepEqual(parseSteerProviderTurnInput({
    commandId: 'steer-1',
    turnId: 'turn-1',
    content: [{ type: 'text', text: 'Include tests.' }],
  }), {
    commandId: 'steer-1',
    turnId: 'turn-1',
    content: [{ type: 'text', text: 'Include tests.' }],
  });
  assert.deepEqual(
    parseInterruptProviderTurnInput({ commandId: 'interrupt-1', turnId: 'turn-1' }),
    { commandId: 'interrupt-1', turnId: 'turn-1' },
  );
  assert.deepEqual(
    parseProviderSnapshotRequest({ commandId: 'snapshot-1', afterNativeSequence: 4 }),
    { commandId: 'snapshot-1', afterNativeSequence: 4 },
  );
  assert.deepEqual(
    parseNativeForkRequest({ commandId: 'fork-1', beforeNativeTurnId: 'native-turn-3' }),
    { commandId: 'fork-1', beforeNativeTurnId: 'native-turn-3' },
  );
  assert.throws(
    () => parseNativeForkRequest({
      commandId: 'fork-1',
      beforeNativeTurnId: 'native-turn-3',
      throughNativeTurnId: 'native-turn-2',
    }),
    (error) => contractErrorAt(error, '$'),
  );
  assert.deepEqual(parseDiscoverProviderSessionsInput({
    providerInstanceId: 'codex-local',
    cwd: '/workspace/remux',
    limit: 50,
  }), {
    providerInstanceId: 'codex-local',
    cwd: '/workspace/remux',
    limit: 50,
  });
  assert.throws(
    () => parseDiscoverProviderSessionsInput({ providerInstanceId: 'codex-local', limit: 201 }),
    (error) => contractErrorAt(error, '$.limit'),
  );
});

test('snapshot coverage declares which block kinds are complete', () => {
  const snapshot = {
    contractVersion: PROVIDER_RUNTIME_CONTRACT_VERSION,
    nativeSession: {
      provider: 'fixture' as const,
      providerInstanceId: 'fixture-local',
      sessionId: 'fixture-session',
    },
    state: 'idle' as const,
    authority: 'authoritative' as const,
    coverage: {
      turnBlocks: {
        completeKinds: ['reasoning-summary', 'final-message'] as const,
      },
    },
    events: [],
  };
  assert.deepEqual(parseProviderSnapshot(snapshot), snapshot);
  assert.throws(
    () => parseProviderSnapshot({
      ...snapshot,
      coverage: { turnBlocks: { completeKinds: ['tool', 'tool'] } },
    }),
    (error) => contractErrorAt(error, '$.coverage.turnBlocks.completeKinds'),
  );
  assert.throws(
    () => parseProviderSnapshot({
      ...snapshot,
      coverage: { turnBlocks: { completeKinds: ['unknown'] } },
    }),
    (error) => contractErrorAt(error, '$.coverage.turnBlocks.completeKinds[0]'),
  );
});

test('provider event parsing accepts semantic events and refuses raw or ambiguous payloads', () => {
  const envelope = eventEnvelope({
    type: 'turn.block.started',
    structure: structure(),
    block: { kind: 'final-message', state: 'streaming', payload: { kind: 'final-message', text: 'Complete.' } },
  });
  assert.deepEqual(parseProviderEventEnvelope(envelope), envelope);
  assert.equal(parseProviderEventEnvelope({ ...envelope, contractVersion: 2 }).contractVersion,
    PROVIDER_RUNTIME_CONTRACT_VERSION,
    'version 2 journal envelopes remain readable after the additive contract upgrade');
  const reasoning = eventEnvelope({
    type: 'turn.block.completed',
    structure: structure(),
    revision: 1,
    contentHash: 'b'.repeat(64),
    block: {
      kind: 'reasoning-summary',
      state: 'completed',
      payload: {
        kind: 'reasoning-summary',
        text: '**Inspecting**\nExplaining.',
        parts: ['**Inspecting**', 'Explaining.'],
        truncated: false,
      },
    },
  });
  assert.deepEqual(parseProviderEventEnvelope(reasoning), reasoning);
  for (const contractVersion of [2, 3, 4, 5]) {
    const legacyReasoning = structuredClone(reasoning) as unknown as Record<string, unknown>;
    legacyReasoning.contractVersion = contractVersion;
    const legacyEvent = legacyReasoning.event as Record<string, unknown>;
    const legacyBlock = legacyEvent.block as Record<string, unknown>;
    delete (legacyBlock.payload as Record<string, unknown>).truncated;
    const normalizedLegacy = parseProviderEventEnvelope(legacyReasoning);
    assert.equal(normalizedLegacy.contractVersion, PROVIDER_RUNTIME_CONTRACT_VERSION);
    assert.equal(normalizedLegacy.event.type, 'turn.block.completed');
    if (normalizedLegacy.event.type === 'turn.block.completed' &&
        normalizedLegacy.event.block.payload.kind === 'reasoning-summary') {
      assert.equal(normalizedLegacy.event.block.payload.truncated, false);
      assert.equal(normalizedLegacy.event.contentHash, 'b'.repeat(64));
      assert.equal(normalizedLegacy.event.structure.blockId, 'block-1');
    }
  }
  const missingCurrentFlag = structuredClone(reasoning) as unknown as Record<string, unknown>;
  const currentEvent = missingCurrentFlag.event as Record<string, unknown>;
  const currentBlock = currentEvent.block as Record<string, unknown>;
  delete (currentBlock.payload as Record<string, unknown>).truncated;
  assert.throws(() => parseProviderEventEnvelope(missingCurrentFlag), /truncated.*is required/u);
  const invalidReasoning = structuredClone(reasoning) as unknown as {
    event: { block: { payload: { parts: string[] } } };
  };
  invalidReasoning.event.block.payload.parts = ['**Inspecting**', 'Different.'];
  assert.throws(
    () => parseProviderEventEnvelope(invalidReasoning),
    (error) => contractErrorAt(error, '$.event.block.payload.parts'),
  );
  const artifactSizedFinal = eventEnvelope({
    type: 'turn.block.started',
    structure: structure(),
    block: {
      kind: 'final-message',
      state: 'streaming',
      payload: { kind: 'final-message', text: 'x'.repeat(PROVIDER_RUNTIME_LIMITS.eventBytes + 1) },
    },
  });
  assert.deepEqual(parseProviderEventEnvelope(artifactSizedFinal), artifactSizedFinal,
    'terminal answers may exceed the ordinary event ceiling so they can be sealed as artifacts');
  assert.throws(
    () => parseProviderEventEnvelope(eventEnvelope({
      type: 'turn.block.started',
      structure: structure(),
      block: {
        kind: 'commentary',
        state: 'streaming',
        payload: { kind: 'commentary', text: 'x'.repeat(PROVIDER_RUNTIME_LIMITS.eventBytes + 1) },
      },
    })),
    (error) => contractErrorAt(error, '$'),
  );
  assert.throws(
    () => parseProviderEventEnvelope({
      ...envelope,
      event: { ...envelope.event, delta: 'b' },
    }),
    (error) => contractErrorAt(error, '$.event.delta'),
  );
  assert.throws(
    () => parseProviderEventEnvelope({
      ...envelope,
      event: { type: 'provider.raw', payload: { secret: true } },
    }),
    (error) => contractErrorAt(error, '$.event.type'),
  );
});

test('native fixture sessions dispatch a command once and expose replayable native-child events', async () => {
  const adapter = new NativeFixtureAdapter({ emitNativeChild: true });
  const session = await adapter.openSession(openInput);
  const collected: ProviderEventEnvelope[] = [];
  const collecting = collectUntil(session.events, collected, (event) =>
    event.event.type === 'turn.completed');

  const accepted = await session.startTurn(turnInput);
  assert.equal(accepted.outcome, 'accepted');
  assert.equal(accepted.nativeTurnId, 'turn-1');
  const replayed = await session.startTurn(structuredClone(turnInput));
  assert.equal(replayed.outcome, 'accepted');
  assert.equal(replayed.nativeTurnId, 'turn-1');
  await collecting;

  assert.equal(session.providerDispatchCount, 1);
  assert.equal(collected.filter(({ event }) => event.type === 'turn.started').length, 1);
  assert.equal(collected.filter(({ event }) => event.type === 'turn.block.started' &&
    event.block.kind === 'native-child').length, 1);
  assert.equal(collected.filter(({ event }) => event.type === 'turn.block.completed' &&
    event.block.kind === 'native-child').length, 1);
  const snapshot = parseProviderSnapshot(await session.snapshot({ commandId: 'snapshot-1' }));
  assert.equal(snapshot.state, 'idle');
  assert.ok(snapshot.events.length >= collected.length);
  assert.equal(new Set(snapshot.events.map(({ eventId }) => eventId)).size, snapshot.events.length);
  await session.close();
});

test('native fixture resume keeps the exact native session reference', async () => {
  const adapter = new NativeFixtureAdapter();
  const created = await adapter.openSession(openInput);
  const nativeSession = structuredClone(created.nativeSession);
  await created.close();

  const resumed = await adapter.openSession({
    ...openInput,
    commandId: 'command-open-resume',
    mode: 'resume',
    nativeSession,
  });
  assert.deepEqual(resumed.nativeSession, nativeSession);
  const first = await readOne(resumed.events);
  assert.deepEqual(first.event, { type: 'session.bound', resumed: true });
  await resumed.close();
});

test('native fixture interruption reaches an authoritative terminal event', async () => {
  const adapter = new NativeFixtureAdapter({ delayMs: 1_000 });
  const session = await adapter.openSession(openInput);
  const collected: ProviderEventEnvelope[] = [];
  const collecting = collectUntil(session.events, collected, (event) =>
    event.event.type === 'turn.completed');
  await session.startTurn(turnInput);
  await session.interrupt({ commandId: 'command-interrupt-1', turnId: 'turn-1' });
  await collecting;
  assert.ok(collected.some(({ event }) =>
    event.type === 'turn.completed' && event.outcome === 'interrupted'));
  await session.close();
});

function eventEnvelope(event: ProviderEventEnvelope['event']): ProviderEventEnvelope {
  return {
    contractVersion: PROVIDER_RUNTIME_CONTRACT_VERSION,
    eventId: 'event-1',
    provider: 'codex',
    scope: {
      kind: 'turn',
      providerInstanceId: 'codex-local',
      conversationId: 'conversation-1',
      executionId: 'execution-1',
      turnId: 'turn-1',
    },
    native: {
      sessionId: 'session-1',
      turnId: 'native-turn-1',
      itemId: 'native-item-1',
      position: { kind: 'native-sequence', sequence: 1, subIndex: 0 },
      kind: 'item/assistant',
    },
    observedAt: 1,
    event,
  };
}

function structure() {
  return { passId: 'pass-1', blockId: 'block-1', passOrdinal: 0, blockOrdinal: 0 };
}

function contractErrorAt(error: unknown, path: string) {
  return error instanceof ProviderContractError && error.path === path;
}

async function readOne(events: AsyncIterable<ProviderEventEnvelope>) {
  for await (const event of events) return event;
  throw new Error('Provider stream closed before an event was emitted.');
}

async function collectUntil(
  events: AsyncIterable<ProviderEventEnvelope>,
  target: ProviderEventEnvelope[],
  done: (event: ProviderEventEnvelope) => boolean,
) {
  for await (const event of events) {
    target.push(event);
    if (done(event)) return;
  }
  throw new Error('Provider stream closed before the target event.');
}
