import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { FederationCredentialRegistry } from '../server/src/federation/credential-registry.ts';
import { commandIdentity, RemuxFederationServer } from '../server/src/federation/mcp-server.ts';
import { NativeFixtureAdapter } from '../server/src/native-fixture-adapter.ts';
import { NativeAgentArtifacts } from '../server/src/native-runtime/native-artifacts.ts';
import { NativeAgentCoordinator } from '../server/src/native-runtime/native-coordinator.ts';
import { NativeAgentJournal } from '../server/src/native-runtime/native-journal.ts';
import { NATIVE_ASSISTANT_PREVIEW_BYTES } from '../server/src/native-runtime/native-output.ts';
import { createNativeAgentSchema } from '../server/src/native-runtime/schema.ts';
import { prepareAgentDataPaths } from '../server/src/storage/data-root.ts';
import type { NativeTranscriptWindow } from '../shared/native-agent-protocol.ts';

test('federation credentials are generation-bound, native-session-bound, and expire when abandoned', () => {
  let now = 1_000;
  const credentials = new FederationCredentialRegistry({ now: () => now });
  const credential = credentials.issue({
    generation: 'generation-1',
    conversationId: 'conversation-1',
    executionId: 'execution-1',
    provider: 'codex',
    providerInstanceId: 'codex-local',
    access: 'read-only',
    depth: 0,
    tools: ['remux_spawn_agent'],
    targetCatalog: [],
  });
  assert.throws(() => credentials.resolve(credential.token, 'generation-1'), /not bound/iu);
  credential.bindNativeSession({
    provider: 'codex',
    providerInstanceId: 'codex-local',
    sessionId: 'native-session-1',
  });
  assert.equal(credentials.resolve(credential.token, 'generation-1').nativeSessionId, 'native-session-1');
  assert.throws(() => credentials.resolve(credential.token, 'generation-2'), /invalid or expired/iu);

  const abandoned = credentials.issue({
    generation: 'generation-1',
    conversationId: 'conversation-1',
    executionId: 'execution-2',
    provider: 'claude-code',
    providerInstanceId: 'claude-local',
    access: 'read-only',
    depth: 1,
    tools: ['remux_wait_agent'],
    targetCatalog: [],
  });
  abandoned.bindNativeSession({
    provider: 'claude-code',
    providerInstanceId: 'claude-local',
    sessionId: 'native-session-2',
  });
  now += 24 * 60 * 60 * 1_000 + 1;
  assert.throws(() => credentials.resolve(abandoned.token, 'generation-1'), /invalid or expired/iu);
});

test('federation MCP scopes identity, access, provider boundary, and child projection', async () => {
  const journal = createJournal();
  const credentials = new FederationCredentialRegistry();
  const rootAdapter = new NativeFixtureAdapter({ provider: 'codex', delayMs: 60_000 });
  const childAdapter = new NativeFixtureAdapter({ provider: 'claude-code', delayMs: 2 });
  const issued = new Map<string, Awaited<ReturnType<RemuxFederationServer['issueForSession']>>>();
  let coordinator!: NativeAgentCoordinator;
  const federation = new RemuxFederationServer({
    journal,
    credentials,
    coordinator: () => coordinator,
    generation: () => coordinator.projector.serverGeneration,
  });
  coordinator = new NativeAgentCoordinator({
    journal,
    providers: [{
      providerInstanceId: 'codex-local',
      provider: 'codex',
      label: 'Codex fixture',
      adapter: rootAdapter,
    }, {
      providerInstanceId: 'claude-local',
      provider: 'claude-code',
      label: 'Claude fixture',
      adapter: childAdapter,
    }],
    federationForSession: async (input) => {
      const config = federation.issueForSession(input);
      issued.set(input.executionId, config);
      return config;
    },
  });
  let client: Client | undefined;
  try {
    await federation.start();
    await coordinator.initialize();
    const created = await coordinator.createConversation({
      commandId: 'create-federation-root',
      providerInstanceId: 'codex-local',
      cwd: '/workspace/remux',
      model: 'fixture-native-v1',
      access: 'read-only',
    });
    const root = journal.conversation(created.conversationId)!;
    await coordinator.sendMessage(configuredMessage(coordinator, {
      commandId: 'start-federation-root',
      conversationId: created.conversationId,
      clientMessageId: 'root-message',
      content: [{ type: 'text', text: 'Delegate a bounded review.' }],
    }));
    assert.doesNotMatch(
      rootAdapter.opened[0]?.openedWith.developerInstructions.join('\n') ?? '',
      /federated child/iu,
    );

    const rootCredential = issued.get(root.rootExecutionId);
    assert.ok(rootCredential);
    client = new Client({ name: 'remux-federation-test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(federation.endpoint), {
      requestInit: { headers: { Authorization: rootCredential.authorizationHeader } },
    }));
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map(({ name }) => name).sort(), [
      'remux_close_agent',
      'remux_interrupt_agent',
      'remux_list_agents',
      'remux_send_message',
      'remux_spawn_agent',
      'remux_wait_agent',
    ]);
    const spawnDescription = tools.tools.find(({ name }) => name === 'remux_spawn_agent')?.description ?? '';
    assert.match(spawnDescription, /claude-local/iu);
    assert.match(spawnDescription, /fixture-native-v1/iu);
    assert.match(spawnDescription, /workspace-write requires foreground/iu);
    assert.match(
      tools.tools.find(({ name }) => name === 'remux_send_message')?.description ?? '',
      /same native provider session continues with its full context/iu,
    );

    const malformed = await client.callTool({
      name: 'remux_spawn_agent',
      arguments: {
        task: 'Review only.',
        target: { providerInstanceId: 'claude-local' },
        access: 'read-only',
        scheduling: 'background',
        cwd: '/forged/workspace',
      },
    });
    assert.equal(malformed.isError, true, 'strict MCP input rejects model-authored identity fields');

    const sameProvider = await client.callTool({
      name: 'remux_spawn_agent',
      arguments: {
        task: 'Use another Codex.',
        target: { providerInstanceId: 'codex-local' },
        access: 'read-only',
        scheduling: 'background',
      },
    });
    assert.equal(sameProvider.isError, true);
    assert.match(toolText(sameProvider), /use_native_collaboration/iu);

    const escalation = await client.callTool({
      name: 'remux_spawn_agent',
      arguments: {
        task: 'Write despite a read-only parent.',
        target: { providerInstanceId: 'claude-local' },
        access: 'workspace-write',
        scheduling: 'foreground',
      },
    });
    assert.equal(escalation.isError, true);
    assert.match(toolText(escalation), /cannot widen/iu);

    const spawnedCall = await client.callTool({
      name: 'remux_spawn_agent',
      arguments: {
        task: 'Review the runtime boundary and report one concise result.',
        target: { providerInstanceId: 'claude-local' },
        access: 'read-only',
        scheduling: 'background',
      },
    });
    assert.equal(spawnedCall.isError, undefined);
    const spawned = JSON.parse(toolText(spawnedCall)) as { executionId: string };
    assert.ok(spawned.executionId);

    const waitedCall = await client.callTool({
      name: 'remux_wait_agent',
      arguments: { executionIds: [spawned.executionId] },
    });
    assert.equal(waitedCall.isError, undefined);
    const [result] = JSON.parse(toolText(waitedCall)) as Array<{
      executionId: string;
      status: string;
      provider: string;
      summary: string;
      finalAnswer: { kind: string; text: string };
      changedFiles: unknown[];
    }>;
    assert.equal(result?.executionId, spawned.executionId);
    assert.equal(result?.status, 'completed');
    assert.equal(result?.provider, 'claude-code');
    assert.match(result?.summary ?? '', /Native fixture response/);
    assert.equal(result?.finalAnswer.kind, 'inline');
    assert.match(result?.finalAnswer.text ?? '', /Native fixture response/);
    assert.deepEqual(result?.changedFiles, []);
    const listedCall = await client.callTool({
      name: 'remux_list_agents',
      arguments: { state: 'idle', limit: 8 },
    });
    assert.equal(listedCall.isError, undefined);
    const listed = JSON.parse(toolText(listedCall)) as {
      agents: Array<{
        executionId: string;
        provider: string;
        state: string;
        canSendMessage: boolean;
        canWait: boolean;
        canClose: boolean;
      }>;
      truncated: boolean;
    };
    assert.equal(listed.truncated, false);
    assert.deepEqual(listed.agents.map(({ executionId }) => executionId), [spawned.executionId]);
    assert.equal(listed.agents[0]?.provider, 'claude-code');
    assert.equal(listed.agents[0]?.state, 'idle');
    assert.equal(listed.agents[0]?.canSendMessage, true);
    assert.equal(listed.agents[0]?.canWait, false);
    assert.equal(listed.agents[0]?.canClose, true);
    assert.deepEqual(childAdapter.opened[0]?.turnInputs[0]?.content, [{
      type: 'text',
      text: 'Review the runtime boundary and report one concise result.',
    }]);
    assert.match(
      childAdapter.opened[0]?.openedWith.developerInstructions.join('\n') ?? '',
      /federated child is read-only/iu,
    );

    const followUp = await client.callTool({
      name: 'remux_send_message',
      arguments: {
        executionId: spawned.executionId,
        message: 'Check one focused detail in the same native session.',
      },
    });
    assert.equal(followUp.isError, undefined);
    const followUpResult = JSON.parse(toolText(followUp)) as {
      status: string;
      finalAnswer: { kind: string; text: string };
    };
    assert.equal(followUpResult.status, 'completed');
    assert.equal(followUpResult.finalAnswer.kind, 'inline');
    assert.match(followUpResult.finalAnswer.text, /Check one focused detail/);
    assert.equal(childAdapter.opened.length, 1, 'follow-up resumes the existing native child session');
    const childTranscript = coordinator.projector.project(
      `agent/execution-transcript:${spawned.executionId}:tail-24`,
    ) as NativeTranscriptWindow;
    assert.equal(childTranscript.turns.length, 2);

    const child = journal.execution(spawned.executionId);
    assert.equal(child?.ownership, 'federated');
    assert.equal(child?.federationDepth, 1);
    assert.equal(child?.federationScheduling, 'background');
    assert.equal(child?.access, 'read-only');
    const transcriptRead = coordinator.projector.read({
      requests: [{ key: `agent/transcript:${created.conversationId}:tail-24` }],
    });
    const transcriptResource = transcriptRead.resources[0];
    assert.equal(transcriptResource?.status, 'ok');
    if (transcriptResource?.status === 'ok') {
      const transcript = transcriptResource.value as NativeTranscriptWindow;
      const projected = transcript.turns[0]?.activity.children.find(
        ({ executionId }) => executionId === spawned.executionId,
      );
      assert.equal(projected?.ownership, 'federated');
      assert.equal(projected?.state, 'idle');
      assert.match(projected?.summary ?? '', /Native fixture response/);
    }

    const childCredential = issued.get(spawned.executionId);
    assert.ok(childCredential);
    const closed = await client.callTool({
      name: 'remux_close_agent',
      arguments: { executionId: spawned.executionId },
    });
    assert.equal(closed.isError, undefined);
    const followUpAfterClose = await client.callTool({
      name: 'remux_send_message',
      arguments: { executionId: spawned.executionId, message: 'Do not resume this child.' },
    });
    assert.equal(followUpAfterClose.isError, true);
    assert.match(toolText(followUpAfterClose), /closed and cannot receive follow-ups/iu);
    const revokedChild = await fetch(federation.endpoint, {
      method: 'POST',
      headers: {
        Authorization: childCredential.authorizationHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    assert.equal(revokedChild.status, 401);

    const forged = await fetch(federation.endpoint, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    assert.equal(forged.status, 401);
  } finally {
    await client?.close().catch(() => undefined);
    await coordinator.close();
    await federation.close();
    journal.close();
  }
});

test('foreground federation stays alive with progress and exposes exact overflow output', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'remux-federation-result-'));
  const journal = createJournal();
  const paths = await prepareAgentDataPaths({ dataRoot });
  const artifacts = new NativeAgentArtifacts({ journal, paths });
  const rootAdapter = new NativeFixtureAdapter({ provider: 'codex', delayMs: 60_000 });
  const marker = 'REMUX_FEDERATED_FINAL_TAIL';
  const finalText = `${'Detailed implementation result. '.repeat(12_000)}\n${marker}`;
  assert.ok(Buffer.byteLength(finalText, 'utf8') > NATIVE_ASSISTANT_PREVIEW_BYTES);
  assert.ok(Buffer.byteLength(finalText, 'utf8') > 256 * 1024,
    'the exact artifact path must remain lossless beyond the former provider-event ceiling');
  const childAdapter = new NativeFixtureAdapter({
    provider: 'claude-code',
    delayMs: 80,
    finalText,
    fileChanges: [
      { path: '/workspace/progress/src/runtime.ts', kind: 'update' },
      { path: 'tests/runtime.test.ts', kind: 'add' },
      { path: '/etc/remux-outside.ts', kind: 'update' },
    ],
  });
  const credentials = new FederationCredentialRegistry();
  let coordinator!: NativeAgentCoordinator;
  const federation = new RemuxFederationServer({
    journal,
    credentials,
    coordinator: () => coordinator,
    generation: () => coordinator.projector.serverGeneration,
    progressIntervalMs: 5,
    readTextArtifact: (artifactId) => artifacts.readTextArtifact(artifactId),
  });
  coordinator = new NativeAgentCoordinator({
    journal,
    providers: fixtureProviders(rootAdapter, childAdapter),
    sealTurnOutput: ({ turnId, text }) => artifacts.sealAssistantText(turnId, text)
      .then(() => undefined),
    federationForSession: async (input) => federation.issueForSession(input),
  });
  let client: Client | undefined;
  let otherClient: Client | undefined;
  try {
    await federation.start();
    await coordinator.initialize();
    const created = await coordinator.createConversation({
      commandId: 'create-progress-root',
      providerInstanceId: 'codex-local',
      cwd: '/workspace/progress',
      model: 'fixture-native-v1',
      access: 'workspace-write',
    });
    const conversation = journal.conversation(created.conversationId)!;
    const rootTurn = await coordinator.sendMessage(configuredMessage(coordinator, {
      commandId: 'start-progress-root',
      conversationId: created.conversationId,
      clientMessageId: 'progress-root-message',
      content: [{ type: 'text', text: 'Delegate a long implementation.' }],
    }));
    const credential = federation.issueForSession({
      conversationId: created.conversationId,
      executionId: conversation.rootExecutionId,
      providerInstanceId: 'codex-local',
    });
    credential.bindNativeSession(rootAdapter.opened[0]!.nativeSession);

    client = new Client({ name: 'remux-federation-progress-test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(federation.endpoint), {
      requestInit: { headers: { Authorization: credential.authorizationHeader } },
    }));
    const backgroundWriter = await client.callTool({
      name: 'remux_spawn_agent',
      arguments: {
        task: 'This invalid writer must never start.',
        target: { providerInstanceId: 'claude-local' },
        access: 'workspace-write',
        scheduling: 'background',
      },
    });
    assert.equal(backgroundWriter.isError, true);
    assert.match(toolText(backgroundWriter), /workspace writers must use foreground/iu);
    const progress: Array<{ progress: number; message?: string }> = [];
    const result = await client.callTool({
      name: 'remux_spawn_agent',
      arguments: {
        task: '  Implement the exact bounded change and report every verification step.  ',
        target: { providerInstanceId: 'claude-local' },
        access: 'workspace-write',
        scheduling: 'foreground',
      },
    }, undefined, {
      timeout: 20,
      resetTimeoutOnProgress: true,
      maxTotalTimeout: 2_000,
      onprogress: (update) => progress.push(update),
    });
    assert.equal(result.isError, undefined);
    assert.ok(progress.length >= 3, JSON.stringify(progress));
    assert.deepEqual(progress.map(({ progress: value }) => value),
      progress.map((_, index) => index + 1));
    assert.match(progress.at(-1)?.message ?? '', /terminal boundary/iu);

    const parsed = JSON.parse(toolText(result)) as {
      executionId: string;
      turnId: string;
      status: string;
      finalAnswer: {
        kind: string;
        preview: string;
        artifact: { uri: string; byteLength: number; sha256: string };
      };
      changedFiles: Array<{ path: string; kind: string }>;
    };
    assert.equal(parsed.status, 'completed');
    assert.equal(parsed.finalAnswer.kind, 'artifact');
    assert.ok(parsed.finalAnswer.artifact.byteLength > NATIVE_ASSISTANT_PREVIEW_BYTES);
    assert.doesNotMatch(parsed.finalAnswer.preview, new RegExp(marker));
    assert.deepEqual(parsed.changedFiles, [
      { path: 'src/runtime.ts', kind: 'update' },
      { path: 'tests/runtime.test.ts', kind: 'add' },
    ]);
    assert.deepEqual(childAdapter.opened[0]?.turnInputs[0]?.content, [{
      type: 'text',
      text: 'Implement the exact bounded change and report every verification step.',
    }]);
    assert.match(
      childAdapter.opened[0]?.openedWith.developerInstructions.join('\n') ?? '',
      /workspace-write access/iu,
    );

    const resourceLink = (result.content as Array<Record<string, unknown>>)
      .find((content) => content.type === 'resource_link');
    assert.equal(resourceLink?.uri, parsed.finalAnswer.artifact.uri);
    const resource = await client.readResource({ uri: parsed.finalAnswer.artifact.uri });
    const resourceText = resource.contents[0] && 'text' in resource.contents[0]
      ? resource.contents[0].text
      : undefined;
    assert.equal(resourceText, finalText);
    assert.match(resourceText ?? '', new RegExp(`${marker}$`));

    const otherCreated = await coordinator.createConversation({
      commandId: 'create-other-resource-root',
      providerInstanceId: 'codex-local',
      cwd: '/workspace/other',
      model: 'fixture-native-v1',
      access: 'read-only',
    });
    const otherConversation = journal.conversation(otherCreated.conversationId)!;
    await coordinator.sendMessage(configuredMessage(coordinator, {
      commandId: 'start-other-resource-root',
      conversationId: otherCreated.conversationId,
      clientMessageId: 'other-resource-root-message',
      content: [{ type: 'text', text: 'Keep this unrelated root active.' }],
    }));
    const otherCredential = federation.issueForSession({
      conversationId: otherCreated.conversationId,
      executionId: otherConversation.rootExecutionId,
      providerInstanceId: 'codex-local',
    });
    otherCredential.bindNativeSession(rootAdapter.opened.at(-1)!.nativeSession);
    otherClient = new Client({ name: 'remux-federation-other-scope-test', version: '1.0.0' });
    await otherClient.connect(new StreamableHTTPClientTransport(new URL(federation.endpoint), {
      requestInit: { headers: { Authorization: otherCredential.authorizationHeader } },
    }));
    await assert.rejects(
      () => otherClient!.readResource({ uri: parsed.finalAnswer.artifact.uri }),
      /outside this credential scope/iu,
    );

    assert.equal(journal.turn(rootTurn.turnId)?.state, 'running');
  } finally {
    await otherClient?.close().catch(() => undefined);
    await client?.close().catch(() => undefined);
    await coordinator.close();
    await federation.close();
    journal.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('federation HTTP wait deadline leaves the accepted child running and discoverable', async () => {
  const journal = createJournal();
  const credentials = new FederationCredentialRegistry();
  const rootAdapter = new NativeFixtureAdapter({ provider: 'codex', delayMs: 60_000 });
  const childAdapter = new NativeFixtureAdapter({ provider: 'claude-code', delayMs: 120 });
  let coordinator!: NativeAgentCoordinator;
  const federation = new RemuxFederationServer({
    journal,
    credentials,
    coordinator: () => coordinator,
    generation: () => coordinator.projector.serverGeneration,
    progressIntervalMs: 5,
    waitTimeoutMs: 25,
  });
  coordinator = new NativeAgentCoordinator({
    journal,
    providers: fixtureProviders(rootAdapter, childAdapter),
    federationForSession: async (input) => federation.issueForSession(input),
  });
  let client: Client | undefined;
  try {
    await federation.start();
    await coordinator.initialize();
    const root = await activeRoot(coordinator, journal, 'wait-deadline', '/workspace/deadline');
    const credential = federation.issueForSession({
      conversationId: root.conversationId,
      executionId: root.executionId,
      providerInstanceId: 'codex-local',
    });
    credential.bindNativeSession(rootAdapter.opened[0]!.nativeSession);
    client = new Client({ name: 'remux-federation-deadline-test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(federation.endpoint), {
      requestInit: { headers: { Authorization: credential.authorizationHeader } },
    }));
    const timedOut = await client.callTool({
      name: 'remux_spawn_agent',
      arguments: {
        task: 'Continue after the foreground HTTP waiter reaches its deadline.',
        target: { providerInstanceId: 'claude-local' },
        access: 'read-only',
        scheduling: 'foreground',
      },
    }, undefined, {
      timeout: 1_000,
      resetTimeoutOnProgress: true,
      maxTotalTimeout: 2_000,
    });
    assert.equal(timedOut.isError, true);
    assert.match(toolText(timedOut), /accepted child continues in the background/iu);
    const child = journal.childExecutions(root.executionId)[0];
    assert.ok(child);
    assert.equal(journal.execution(child.executionId)?.state, 'running');
    const completed = await coordinator.waitForFederatedExecution(child.executionId);
    assert.equal(completed.status, 'completed');
  } finally {
    await client?.close().catch(() => undefined);
    await coordinator.close();
    await federation.close();
    journal.close();
  }
});

test('federation result fails boundedly when a large final answer cannot be sealed', async () => {
  const journal = createJournal();
  const rootAdapter = new NativeFixtureAdapter({ provider: 'codex', delayMs: 60_000 });
  const childAdapter = new NativeFixtureAdapter({
    provider: 'claude-code',
    delayMs: 2,
    finalText: 'unsealed child output '.repeat(8_000),
  });
  const coordinator = new NativeAgentCoordinator({
    journal,
    providers: fixtureProviders(rootAdapter, childAdapter),
    sealTurnOutput: async () => { throw new Error('simulated artifact failure'); },
  });
  try {
    await coordinator.initialize();
    const root = await activeRoot(coordinator, journal, 'artifact-failure', '/workspace/artifact-failure');
    const child = await coordinator.spawnFederatedAgent({
      commandId: 'spawn-artifact-failure-child',
      parentConversationId: root.conversationId,
      parentExecutionId: root.executionId,
      rootTurnId: root.turnId,
      targetProviderInstanceId: 'claude-local',
      task: 'Return a large final answer.',
      access: 'read-only',
      scheduling: 'background',
      depth: 1,
    });
    const result = await coordinator.waitForFederatedExecution(child.executionId);
    assert.equal(result.status, 'completed');
    assert.equal(result.finalAnswer?.kind, 'unavailable');
    assert.match(result.finalAnswer?.kind === 'unavailable' ? result.finalAnswer.error : '', /could not be sealed/iu);
    assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') < 64 * 1024,
      'an artifact failure must not fall back to an unbounded inline MCP result');
  } finally {
    await coordinator.close();
    journal.close();
  }
});

test('federation coordinator makes spawn idempotent and serializes checkout writers', async () => {
  const journal = createJournal();
  const rootAdapter = new NativeFixtureAdapter({ provider: 'codex', delayMs: 60_000 });
  const childAdapter = new NativeFixtureAdapter({ provider: 'claude-code', delayMs: 60_000 });
  const coordinator = new NativeAgentCoordinator({
    journal,
    providers: [{
      providerInstanceId: 'codex-local',
      provider: 'codex',
      label: 'Codex fixture',
      adapter: rootAdapter,
    }, {
      providerInstanceId: 'claude-local',
      provider: 'claude-code',
      label: 'Claude fixture',
      adapter: childAdapter,
    }],
  });
  try {
    await coordinator.initialize();
    const created = await coordinator.createConversation({
      commandId: 'create-writer-root',
      providerInstanceId: 'codex-local',
      cwd: '/workspace/shared-checkout',
      model: 'fixture-native-v1',
      access: 'workspace-write',
    });
    const conversation = journal.conversation(created.conversationId)!;
    const rootTurn = await coordinator.sendMessage(configuredMessage(coordinator, {
      commandId: 'start-writer-root',
      conversationId: created.conversationId,
      clientMessageId: 'writer-root-message',
      content: [{ type: 'text', text: 'Delegate implementation.' }],
    }));
    const input = {
      commandId: 'spawn-writer-1',
      parentConversationId: created.conversationId,
      parentExecutionId: conversation.rootExecutionId,
      rootTurnId: rootTurn.turnId,
      targetProviderInstanceId: 'claude-local',
      task: 'Implement the bounded change.',
      access: 'workspace-write' as const,
      scheduling: 'foreground' as const,
      depth: 1,
    };
    const first = await coordinator.spawnFederatedAgent(input);
    const disconnected = new AbortController();
    const foregroundWait = coordinator.waitForFederatedExecution(first.executionId, disconnected.signal);
    disconnected.abort();
    await assert.rejects(foregroundWait, /cancelled/iu);
    assert.equal(journal.execution(first.executionId)?.state, 'running');
    const replay = await coordinator.spawnFederatedAgent(structuredClone(input));
    assert.deepEqual(replay, first);
    assert.equal(childAdapter.opened.length, 1);
    await assert.rejects(() => coordinator.spawnFederatedAgent({
      ...input,
      task: 'A changed retry body must conflict.',
    }), /different input/iu);
    assert.equal(childAdapter.opened.length, 1);

    await assert.rejects(() => coordinator.spawnFederatedAgent({
      ...input,
      commandId: 'spawn-writer-2',
      task: 'Attempt an overlapping write.',
    }), /workspace writer is already active/iu);

    assert.deepEqual(
      await coordinator.closeFederatedExecution('close-writer-1', first.executionId),
      { closed: true },
    );
    assert.deepEqual(
      await coordinator.closeFederatedExecution('close-writer-1', first.executionId),
      { closed: true },
    );
    await assert.rejects(() => coordinator.sendFederatedMessage({
      commandId: 'follow-up-after-close',
      executionId: first.executionId,
      message: 'This closed child must not be resumed.',
    }), /closed and cannot receive follow-ups/iu);
    const terminal = await coordinator.waitForFederatedExecution(first.executionId);
    assert.equal(terminal.status, 'interrupted');
    const replacementWriter = await coordinator.spawnFederatedAgent({
      ...input,
      commandId: 'spawn-writer-after-close',
      task: 'Take the released writer slot.',
    });
    await coordinator.interruptFederatedExecution('interrupt-replacement-writer', replacementWriter.executionId);
    assert.equal((await coordinator.waitForFederatedExecution(replacementWriter.executionId)).status, 'interrupted');
  } finally {
    await coordinator.close();
    journal.close();
  }
});

test('federation coordinator enforces depth, active, total, and checkout reader limits', async () => {
  const journal = createJournal();
  const rootAdapter = new NativeFixtureAdapter({ provider: 'codex', delayMs: 60_000 });
  const childAdapter = new NativeFixtureAdapter({ provider: 'claude-code', delayMs: 60_000 });
  const coordinator = new NativeAgentCoordinator({
    journal,
    providers: [{
      providerInstanceId: 'codex-local',
      provider: 'codex',
      label: 'Codex fixture',
      adapter: rootAdapter,
    }, {
      providerInstanceId: 'claude-local',
      provider: 'claude-code',
      label: 'Claude fixture',
      adapter: childAdapter,
    }],
  });
  try {
    await coordinator.initialize();
    const first = await activeRoot(coordinator, journal, 'limits-a', '/workspace/shared-limits');
    const spawn = (commandId: string, parent = first) => coordinator.spawnFederatedAgent({
      commandId,
      parentConversationId: parent.conversationId,
      parentExecutionId: parent.executionId,
      rootTurnId: parent.turnId,
      targetProviderInstanceId: 'claude-local',
      task: `Bounded reader ${commandId}.`,
      access: 'read-only',
      scheduling: 'background',
      depth: 1,
    });

    await assert.rejects(() => coordinator.spawnFederatedAgent({
      commandId: 'invalid-depth',
      parentConversationId: first.conversationId,
      parentExecutionId: first.executionId,
      rootTurnId: first.turnId,
      targetProviderInstanceId: 'claude-local',
      task: 'Try to skip a federation level.',
      access: 'read-only',
      scheduling: 'background',
      depth: 2,
    }), /depth limit/iu);

    const active = [];
    for (let index = 0; index < 4; index += 1) {
      active.push(await spawn(`active-reader-${index}`));
    }
    await assert.rejects(() => spawn('active-reader-overflow'), /active federated child limit/iu);

    const second = await activeRoot(coordinator, journal, 'limits-b', '/workspace/shared-limits');
    await assert.rejects(() => spawn('checkout-reader-overflow', second),
      /background federated reader limit/iu);

    for (const [index, child] of active.entries()) {
      await coordinator.interruptFederatedExecution(`interrupt-active-${index}`, child.executionId);
      const stopped = await within(
        coordinator.waitForFederatedExecution(child.executionId),
        5_000,
        `active child ${index} did not stop`,
      );
      assert.equal(stopped.status, 'interrupted', JSON.stringify({
        index,
        stopped,
        execution: journal.execution(child.executionId),
        turns: journal.turns(first.conversationId).filter((turn) =>
          turn.executionId === child.executionId),
      }));
    }

    for (let index = 4; index < 16; index += 1) {
      const child = await spawn(`total-reader-${index}`);
      await coordinator.interruptFederatedExecution(`interrupt-total-${index}`, child.executionId);
      await within(
        coordinator.waitForFederatedExecution(child.executionId),
        5_000,
        `total child ${index} did not stop`,
      );
    }
    await assert.rejects(() => spawn('total-reader-overflow'), /execution limit/iu);
  } finally {
    await coordinator.close();
    journal.close();
  }
});

test('federated stream loss immediately reconciles and never reruns an accepted child turn', async () => {
  const journal = createJournal();
  const rootAdapter = new NativeFixtureAdapter({ provider: 'codex', delayMs: 60_000 });
  const childAdapter = new NativeFixtureAdapter({ provider: 'claude-code', delayMs: 60_000 });
  const first = new NativeAgentCoordinator({
    journal,
    providers: fixtureProviders(rootAdapter, childAdapter),
  });
  await first.initialize();
  const root = await activeRoot(first, journal, 'restart', '/workspace/restart');
  const child = await first.spawnFederatedAgent({
    commandId: 'spawn-restart-child',
    parentConversationId: root.conversationId,
    parentExecutionId: root.executionId,
    rootTurnId: root.turnId,
    targetProviderInstanceId: 'claude-local',
    task: 'Perform accepted work exactly once.',
    access: 'read-only',
    scheduling: 'background',
    depth: 1,
  });
  assert.equal(childAdapter.opened[0]?.providerDispatchCount, 1);
  childAdapter.opened[0]?.simulateTransportFailure(new Error('child process disappeared'));
  await waitUntil(() => journal.execution(child.executionId)?.outcome === 'recovery_failed').catch((error) => {
    throw new Error(`${error instanceof Error ? error.message : String(error)}: ${JSON.stringify({
      execution: journal.execution(child.executionId),
      turns: journal.turns(root.conversationId).filter(({ executionId }) => executionId === child.executionId),
      opened: childAdapter.opened.length,
    })}`);
  });
  assert.equal(childAdapter.opened.length, 2);
  assert.equal(childAdapter.opened[1]?.providerDispatchCount, 0);
  assert.equal(journal.activeFederatedExecutionsForCwd('/workspace/restart').length, 0);
  await first.close();

  const replacementRoot = new NativeFixtureAdapter({ provider: 'codex' });
  const replacementChild = new NativeFixtureAdapter({ provider: 'claude-code' });
  const replacement = new NativeAgentCoordinator({
    journal,
    providers: fixtureProviders(replacementRoot, replacementChild),
  });
  try {
    await replacement.initialize();
    assert.equal(replacementChild.opened.length, 0);
    assert.equal(
      journal.execution(child.executionId)?.outcome,
      'recovery_failed',
      JSON.stringify({
        execution: journal.execution(child.executionId),
        turns: journal.turns(root.conversationId).filter(({ executionId }) => executionId === child.executionId),
      }),
    );
  } finally {
    await replacement.close();
    journal.close();
  }
});

test('federation command identity scopes request retries to the active caller turn', async () => {
  const journal = createJournal();
  const rootAdapter = new NativeFixtureAdapter({ provider: 'codex', delayMs: 60_000 });
  const childAdapter = new NativeFixtureAdapter({ provider: 'claude-code', delayMs: 60_000 });
  const coordinator = new NativeAgentCoordinator({
    journal,
    providers: fixtureProviders(rootAdapter, childAdapter),
  });
  try {
    await coordinator.initialize();
    const root = await activeRoot(coordinator, journal, 'request-id', '/workspace/request-id');
    const token = 'A'.repeat(43);
    const request = {
      task: 'Original request body.',
      target: { providerInstanceId: 'claude-local' },
      access: 'read-only' as const,
      scheduling: 'background' as const,
    };
    const commandId = commandIdentity(token, root.turnId, 'spawn', 17);
    const input = {
      commandId,
      parentConversationId: root.conversationId,
      parentExecutionId: root.executionId,
      rootTurnId: root.turnId,
      targetProviderInstanceId: 'claude-local',
      task: 'Original request body.',
      access: 'read-only' as const,
      scheduling: 'background' as const,
      depth: 1,
    };
    const first = await coordinator.spawnFederatedAgent(input);
    assert.equal(commandIdentity(token, root.turnId, 'spawn', 17), commandId);
    assert.deepEqual(await coordinator.spawnFederatedAgent(structuredClone(input)), first);
    assert.equal(childAdapter.opened.length, 1, 'an exact retry replays the first child');
    assert.notEqual(commandIdentity(token, root.turnId, 'spawn', '17'), commandId,
      'numeric and string JSON-RPC request IDs remain distinct');
    assert.notEqual(commandIdentity(token, 'later-caller-turn', 'spawn', 17), commandId,
      'a fresh provider MCP client may restart request IDs on a later turn');
    const changedRequest = { ...request, task: 'Changed body for the same JSON-RPC request ID.' };
    await assert.rejects(() => coordinator.spawnFederatedAgent({
      ...input,
      task: changedRequest.task,
    }), /reused with different input/iu);
    assert.equal(childAdapter.opened.length, 1,
      'changed input under the same caller-turn request ID cannot dispatch twice');
    await coordinator.interruptFederatedExecution('interrupt-request-id-child', first.executionId);
  } finally {
    await coordinator.close();
    journal.close();
  }
});

test('restart fails federated spawns interrupted before or after native-session binding', async () => {
  const journal = createJournal();
  const originalRoot = new NativeFixtureAdapter({ provider: 'codex', delayMs: 60_000 });
  const originalChild = new NativeFixtureAdapter({ provider: 'claude-code' });
  const original = new NativeAgentCoordinator({
    journal,
    providers: fixtureProviders(originalRoot, originalChild),
  });
  await original.initialize();
  const root = await activeRoot(original, journal, 'orphan', '/workspace/orphan');
  const commandId = 'spawn-without-native-handle';
  const executionId = 'orphan-federated-execution';
  const unboundExecutionId = 'unbound-federated-execution';
  journal.claimCommand(commandId, 'federation.spawn', { task: 'Accepted before crash.' }, Date.now());
  journal.transaction(() => {
    journal.createFederatedExecution({
      executionId,
      conversationId: root.conversationId,
      parentExecutionId: root.executionId,
      rootTurnId: root.turnId,
      provider: 'claude-code',
      providerInstanceId: 'claude-local',
      model: 'fixture-native-v1',
      access: 'read-only',
      scheduling: 'background',
      depth: 1,
      title: 'Interrupted spawn',
      now: Date.now(),
    });
    journal.bindNativeSession({
      executionId,
      nativeSession: {
        provider: 'claude-code',
        providerInstanceId: 'claude-local',
        sessionId: 'orphan-native-session',
        resumeCursor: { sessionId: 'orphan-native-session' },
      },
      adapterVersion: 'provider-runtime-v1',
      now: Date.now(),
    });
    journal.markCommandDispatching(commandId, Date.now());
    journal.createFederatedExecution({
      executionId: unboundExecutionId,
      conversationId: root.conversationId,
      parentExecutionId: root.executionId,
      rootTurnId: root.turnId,
      provider: 'claude-code',
      providerInstanceId: 'claude-local',
      model: 'fixture-native-v1',
      access: 'read-only',
      scheduling: 'background',
      depth: 1,
      title: 'Interrupted unbound spawn',
      now: Date.now(),
    });
  });
  await original.close();

  const replacementChild = new NativeFixtureAdapter({ provider: 'claude-code' });
  const replacement = new NativeAgentCoordinator({
    journal,
    providers: fixtureProviders(new NativeFixtureAdapter({ provider: 'codex' }), replacementChild),
  });
  try {
    await replacement.initialize();
    assert.equal(replacementChild.opened.length, 0);
    assert.equal(journal.execution(executionId)?.outcome, 'recovery_failed');
    assert.equal(journal.execution(unboundExecutionId)?.outcome, 'recovery_failed');
    assert.equal(journal.commandReceipt(commandId)?.state, 'recovery_failed');
    assert.equal(journal.activeFederatedExecutionsForCwd('/workspace/orphan').length, 0);
  } finally {
    await replacement.close();
    journal.close();
  }
});

function createJournal() {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON');
  createNativeAgentSchema(database);
  return new NativeAgentJournal(database);
}

async function activeRoot(
  coordinator: NativeAgentCoordinator,
  journal: NativeAgentJournal,
  suffix: string,
  cwd: string,
) {
  const created = await coordinator.createConversation({
    commandId: `create-root-${suffix}`,
    providerInstanceId: 'codex-local',
    cwd,
    model: 'fixture-native-v1',
    access: 'read-only',
  });
  const conversation = journal.conversation(created.conversationId)!;
  const turn = await coordinator.sendMessage(configuredMessage(coordinator, {
    commandId: `send-root-${suffix}`,
    conversationId: created.conversationId,
    clientMessageId: `message-root-${suffix}`,
    content: [{ type: 'text', text: 'Delegate bounded readers.' }],
  }));
  return {
    conversationId: created.conversationId,
    executionId: conversation.rootExecutionId,
    turnId: turn.turnId,
  };
}

function fixtureProviders(root: NativeFixtureAdapter, child: NativeFixtureAdapter) {
  return [{
    providerInstanceId: 'codex-local',
    provider: 'codex' as const,
    label: 'Codex fixture',
    adapter: root,
  }, {
    providerInstanceId: 'claude-local',
    provider: 'claude-code' as const,
    label: 'Claude fixture',
    adapter: child,
  }];
}

function configuredMessage(
  coordinator: NativeAgentCoordinator,
  input: {
    commandId: string;
    conversationId: string;
    clientMessageId: string;
    content: readonly ({ type: 'text'; text: string })[];
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

function toolText(result: Awaited<ReturnType<Client['callTool']>>) {
  const content = Array.isArray(result.content) ? result.content : [];
  const first = content[0] as { type?: unknown; text?: unknown } | undefined;
  return first?.type === 'text' && typeof first.text === 'string' ? first.text : '';
}

function within<T>(promise: Promise<T>, timeoutMs: number, message: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('Condition timed out.');
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
