import assert from 'node:assert/strict';
import test from 'node:test';

import { ClaudeNativeAdapter } from '../server/src/providers/claude/claude-adapter.ts';
import { PublishedVersionCache } from '../server/src/providers/published-version.ts';

const AUTH = JSON.stringify({
  loggedIn: true,
  authMethod: 'claude.ai',
  apiProvider: 'firstParty',
  subscriptionType: 'max',
});

function claudeCli(versions: string[]) {
  const calls: string[][] = [];
  let index = 0;
  const runCli = async (args: readonly string[]) => {
    calls.push([...args]);
    if (args[0] === '--version') {
      const version = versions[Math.min(index, versions.length - 1)]!;
      index += 1;
      return `${version} (Claude Code)`;
    }
    if (args[0] === 'update') return 'Installing latest version\nInstalled successfully';
    return AUTH;
  };
  return { calls, runCli };
}

function fixedPublished(version: string | null) {
  return new PublishedVersionCache({
    now: () => 1_000,
    fetchLatest: async () => version,
  });
}

test('the Claude runtime advertises an update seam and the release it would install', async () => {
  const { runCli } = claudeCli(['2.1.258']);
  const published = fixedPublished('2.1.283');
  await published.refresh('@anthropic-ai/claude-code');
  const adapter = new ClaudeNativeAdapter({ runCli, published });

  await adapter.probe('claude-local');
  const status = await adapter.readRuntimeStatus('claude-local');

  assert.equal(status.supportsUpdate, true);
  // A Claude session holds the binary it exec'd: a restart is how live
  // sessions move to a new install, and with none live nothing needs moving.
  assert.equal(status.supportsRestart, true);
  assert.equal(status.restartRequired, false);
  assert.equal(status.installedVersion, '2.1.258');
  assert.equal(status.availableVersion, '2.1.283');
  assert.equal(status.updateCheckedAt, 1_000);
});

test('updating installs and re-probes without stopping anything', async () => {
  const { calls, runCli } = claudeCli(['2.1.258', '2.1.283']);
  const adapter = new ClaudeNativeAdapter({ runCli, published: fixedPublished('2.1.283') });
  await adapter.probe('claude-local');

  const result = await adapter.updateRuntime('claude-local');

  assert.deepEqual(calls.map((args) => args[0]), ['--version', 'auth', 'update', '--version']);
  assert.equal(result.status.installedVersion, '2.1.283');
  assert.ok(result.log.includes('Claude Code updated from 2.1.258 to 2.1.283.'));
});

test('an update that changes nothing says so instead of claiming an upgrade', async () => {
  const { runCli } = claudeCli(['2.1.283']);
  const adapter = new ClaudeNativeAdapter({ runCli, published: fixedPublished('2.1.283') });
  await adapter.probe('claude-local');

  const result = await adapter.updateRuntime('claude-local');

  assert.ok(result.log.includes('Claude Code is current at 2.1.283.'));
});

test('the reported SDK version comes from the installed pin, not a literal', async () => {
  const { runCli } = claudeCli(['2.1.258']);
  const adapter = new ClaudeNativeAdapter({ runCli, published: fixedPublished(null) });
  const status = await adapter.readRuntimeStatus('claude-local');
  const pinned = JSON.parse(
    await (await import('node:fs/promises')).readFile(
      new URL('../package.json', import.meta.url),
      'utf8',
    ),
  ).dependencies['@anthropic-ai/claude-agent-sdk'];

  assert.equal(status.sdkVersion, pinned);
});

test('a status read never blocks on the registry and keeps the last known answer', async () => {
  let attempts = 0;
  const cache = new PublishedVersionCache({
    now: () => 5_000,
    fetchLatest: async () => {
      attempts += 1;
      if (attempts === 1) return '2.1.283';
      throw new Error('registry unreachable');
    },
  });

  // The first read answers from an empty cache and schedules the fetch.
  assert.deepEqual(cache.read('@anthropic-ai/claude-code'), { version: null, checkedAt: null });
  assert.deepEqual(await cache.refresh('@anthropic-ai/claude-code'),
    { version: '2.1.283', checkedAt: 5_000 });

  // An unreachable registry is not a runtime fault: the previous answer stands.
  assert.deepEqual(await cache.refresh('@anthropic-ai/claude-code'),
    { version: '2.1.283', checkedAt: 5_000 });
});

test('quiescence blocks on work in flight, not on open sessions', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { NativeAgentServer } = await import('../server/src/native-agent-server.ts');
  const { NativeFixtureAdapter } = await import('../server/src/native-fixture-adapter.ts');
  const { NativeAgentJournal } = await import('../server/src/native-runtime/native-journal.ts');
  const { createNativeAgentSchema } = await import('../server/src/native-runtime/schema.ts');
  const { NATIVE_AGENT_METHODS } = await import('../shared/native-agent-protocol.ts');

  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON');
  createNativeAgentSchema(database);
  const journal = new NativeAgentJournal(database);
  const server = new NativeAgentServer({
    journal,
    providers: [{
      provider: 'fixture',
      providerInstanceId: 'fixture-local',
      label: 'Fixture',
      adapter: new NativeFixtureAdapter(),
    }],
    notify: () => {},
  });

  type Quiescence = Awaited<ReturnType<typeof server.coordinator.readQuiescence>>;
  const read = () => server.handle(NATIVE_AGENT_METHODS.quiescenceRead, undefined) as Promise<Quiescence>;

  try {
    await server.initialize();
    const idle = await read();
    assert.equal(idle.quiescent, true);
    assert.deepEqual(idle.blockers, []);

    // Stub only the journal reads the predicate consults, so the rest of the
    // coordinator keeps working.
    const stubbed = journal as unknown as {
      conversations: () => unknown[];
      queuedEntries: (conversationId: string) => unknown[];
      turn: (turnId: string) => unknown;
      pendingCompactionOperation: (conversationId: string) => unknown;
    };
    let turnState = 'running';
    let queued = 0;
    let compactionState: string | null = null;
    stubbed.conversations = () => [{
      conversationId: 'conversation-1',
      activeTurnId: 'turn-1',
      lastActivityAt: 4_200,
    }];
    stubbed.queuedEntries = () => Array.from({ length: queued }, (_, index) => ({ index }));
    stubbed.turn = () => ({ turnId: 'turn-1', state: turnState });
    stubbed.pendingCompactionOperation = () => compactionState ? { state: compactionState } : undefined;

    const running = await read();
    assert.equal(running.quiescent, false);
    assert.equal(running.activeTurns, 1);
    assert.equal(running.lastActivityAt, 4_200);
    assert.ok(running.blockers.some((entry) => entry.includes('turn in flight')));

    // A recovering turn is unfinished work too: restarting would strand it.
    turnState = 'recovering';
    const recovering = await read();
    assert.equal(recovering.quiescent, false);
    assert.equal(recovering.activeTurns, 0);
    assert.equal(recovering.recovering, 1);

    turnState = 'completed';
    queued = 2;
    const queuedRead = await read();
    assert.equal(queuedRead.quiescent, false);
    assert.equal(queuedRead.queuedMessages, 2);

    queued = 0;
    compactionState = 'running';
    const compacting = await read();
    assert.equal(compacting.quiescent, false);
    assert.equal(compacting.compacting, 1);

    // Nothing in flight: an idle-but-live turn record no longer blocks.
    compactionState = null;
    stubbed.conversations = () => [{
      conversationId: 'conversation-1',
      activeTurnId: null,
      lastActivityAt: 9_000,
    }];
    const calm = await read();
    assert.equal(calm.quiescent, true);
    assert.equal(calm.lastActivityAt, 9_000);
  } finally {
    await server.coordinator.close?.();
    database.close();
  }
});

test('a failed install surfaces as an error instead of a silent no-op', async () => {
  const adapter = new ClaudeNativeAdapter({
    published: fixedPublished('2.1.283'),
    runCli: async (args, options) => {
      if (args[0] === '--version') return '2.1.258 (Claude Code)';
      if (args[0] === 'update') {
        // The real CLI prints progress and then exits non-zero on failure; the
        // adapter must not accept that stdout as success.
        assert.equal(options?.strict, true);
        throw Object.assign(new Error('install failed'), { stdout: 'Downloading...' });
      }
      return AUTH;
    },
  });
  await adapter.probe('claude-local');

  await assert.rejects(adapter.updateRuntime('claude-local'), /install failed/u);
  // The recorded version is untouched, so the card keeps telling the truth.
  assert.equal((await adapter.readRuntimeStatus('claude-local')).installedVersion, '2.1.258');
});

test('restarting a provider closes only idle sessions so they resume on the installed binary', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { NativeAgentServer } = await import('../server/src/native-agent-server.ts');
  const { NativeFixtureAdapter } = await import('../server/src/native-fixture-adapter.ts');
  const { NativeAgentJournal } = await import('../server/src/native-runtime/native-journal.ts');
  const { createNativeAgentSchema } = await import('../server/src/native-runtime/schema.ts');
  const { NATIVE_AGENT_METHODS } = await import('../shared/native-agent-protocol.ts');

  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON');
  createNativeAgentSchema(database);
  const journal = new NativeAgentJournal(database);
  const server = new NativeAgentServer({
    journal,
    providers: [{
      provider: 'fixture',
      providerInstanceId: 'fixture-local',
      label: 'Fixture',
      adapter: new NativeFixtureAdapter(),
    }],
    notify: () => {},
  });
  const internals = server.coordinator as unknown as { sessions: Map<string, unknown> };
  type Restart = Awaited<ReturnType<typeof server.coordinator.restartRuntime>>;
  const restart = () => server.handle(NATIVE_AGENT_METHODS.runtimeRestart,
    { providerInstanceId: 'fixture-local' }) as Promise<Restart>;

  try {
    await server.initialize();
    const created = await server.handle(NATIVE_AGENT_METHODS.conversationCreate, {
      commandId: 'create-1',
      providerInstanceId: 'fixture-local',
      cwd: '/workspace/remux',
      model: 'fixture-native-v1',
      access: 'workspace-write',
    }) as { conversationId: string };
    const runtimeRead = await server.handle(NATIVE_AGENT_METHODS.resourcesRead, {
      requests: [{ key: `agent/runtime:${created.conversationId}` }],
    }) as { resources: Array<{ value?: {
      composer: { revision: string; nextTurn: { model: string; effort: string | null } };
    } }> };
    const runtime = runtimeRead.resources[0]!.value!;
    await server.handle(NATIVE_AGENT_METHODS.messageSend, {
      commandId: 'send-1',
      conversationId: created.conversationId,
      clientMessageId: 'message-1',
      content: [{ type: 'text', text: 'Implement.' }],
      providerInstanceId: 'fixture-local',
      model: runtime.composer.nextTurn.model,
      effort: runtime.composer.nextTurn.effort,
      access: 'workspace-write',
      configurationRevision: runtime.composer.revision,
      delivery: 'auto',
    });
    // The fixture completes its turn synchronously-ish; wait for the journal.
    for (let attempt = 0; attempt < 100 && journal.conversation(created.conversationId)?.activeTurnId; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(internals.sessions.size, 1);

    // A turn in flight keeps its process: restart is never the thing that
    // strands work.
    const conversation = journal.conversation.bind(journal);
    (journal as unknown as { conversation: typeof conversation }).conversation = (id: string) => {
      const record = conversation(id);
      return record ? { ...record, activeTurnId: 'turn-in-flight' } : record;
    };
    const busy = await restart();
    assert.equal(internals.sessions.size, 1);
    assert.deepEqual(busy.log, [
      'Restarted 0 sessions; they resume on native-fixture-1 at their next message.',
      'Left 1 session running with work in flight.',
    ]);

    (journal as unknown as { conversation: typeof conversation }).conversation = conversation;
    const idle = await restart();
    assert.equal(internals.sessions.size, 0);
    assert.deepEqual(idle.log, ['Restarted 1 session; they resume on native-fixture-1 at their next message.']);
    assert.equal(idle.runtime.providerInstanceId, 'fixture-local');
    // The conversation is intact and simply reopens on its next message.
    assert.ok(journal.conversation(created.conversationId));
  } finally {
    await server.coordinator.close?.();
    database.close();
  }
});

test('updating re-probes the provider so the catalog comes from the new binary', async () => {
  const { runCli } = claudeCli(['2.1.258', '2.1.283']);
  let catalogReads = 0;
  const adapter = new ClaudeNativeAdapter({
    runCli,
    published: fixedPublished('2.1.283'),
    createQuery: () => ({
      supportedModels: async () => {
        catalogReads += 1;
        return [{ value: 'claude-opus-5-5', displayName: 'Opus 5.5', description: '' }];
      },
      close: () => {},
    }) as never,
  });
  const { DatabaseSync } = await import('node:sqlite');
  const { NativeAgentServer } = await import('../server/src/native-agent-server.ts');
  const { NativeAgentJournal } = await import('../server/src/native-runtime/native-journal.ts');
  const { createNativeAgentSchema } = await import('../server/src/native-runtime/schema.ts');
  const { NATIVE_AGENT_METHODS } = await import('../shared/native-agent-protocol.ts');
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON');
  createNativeAgentSchema(database);
  const journal = new NativeAgentJournal(database);
  const server = new NativeAgentServer({
    journal,
    providers: [{ provider: 'claude-code', providerInstanceId: 'claude-local', label: 'Claude', adapter }],
    notify: () => {},
  });
  try {
    await server.initialize();
    const before = catalogReads;
    const result = await server.handle(NATIVE_AGENT_METHODS.runtimeUpdate,
      { providerInstanceId: 'claude-local' }) as { runtime: { installedVersion: string } };
    assert.equal(result.runtime.installedVersion, '2.1.283');
    assert.equal(catalogReads, before + 1);
    const models = await server.handle(NATIVE_AGENT_METHODS.resourcesRead, {
      requests: [{ key: 'agent/models:claude-local' }],
    }) as { resources: Array<{ value?: { models: Array<{ id: string }> } }> };
    assert.ok(models.resources[0]!.value!.models.some(({ id }) => id === 'claude-opus-5-5'));
  } finally {
    await server.coordinator.close?.();
    database.close();
  }
});
