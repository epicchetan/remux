import assert from 'node:assert/strict';
import test from 'node:test';

import {
  NATIVE_AGENT_RESOURCE_KEYS,
  agentExecutionResourceKey,
  agentExecutionTranscriptResourceKey,
  assertViewerSafeNativeResource,
  parseAgentExecutionResourceKey,
  parseAgentExecutionTranscriptResourceKey,
  parseNativeAgentResourceReadParams,
  parseNativeBranchCommand,
  parseNativeConversationCreateCommand,
  parseNativeConversationAccessSetCommand,
  parseNativeMessageSendCommand,
  parseNativeProviderAuthMutationCommand,
  parseNativeProviderLoginStartCommand,
  parseNativeTurnMutationCommand,
  type AgentRuntimeResource,
} from '../shared/native-agent-protocol.ts';
import { ProviderContractError } from '../shared/provider-runtime.ts';

test('execution resource keys preserve colon-bearing provider identities', () => {
  const executionId = 'root:conversation-1:codex-child-a';
  const executionKey = agentExecutionResourceKey(executionId);
  const transcriptKey = agentExecutionTranscriptResourceKey(executionId);
  assert.equal(executionKey, 'agent/execution:root%3Aconversation-1%3Acodex-child-a');
  assert.equal(parseAgentExecutionResourceKey(executionKey), executionId);
  assert.deepEqual(parseAgentExecutionTranscriptResourceKey(transcriptKey), {
    executionId,
    window: 'tail-24',
  });
  assert.equal(parseNativeAgentResourceReadParams({
    requests: [{ key: executionKey }, { key: transcriptKey }],
  }).requests.length, 2);
});

test('native Agent commands are chat-based, strict, and provider explicit', () => {
  assert.deepEqual(parseNativeProviderLoginStartCommand({
    commandId: 'login-1',
    providerInstanceId: 'codex-local',
    mode: 'device-code',
  }), {
    commandId: 'login-1',
    providerInstanceId: 'codex-local',
    mode: 'device-code',
  });
  assert.deepEqual(parseNativeProviderAuthMutationCommand({
    commandId: 'logout-1',
    providerInstanceId: 'codex-local',
  }), {
    commandId: 'logout-1',
    providerInstanceId: 'codex-local',
  });
  assert.deepEqual(parseNativeConversationCreateCommand({
    commandId: 'create-1',
    providerInstanceId: 'codex-local',
    cwd: '/workspace/remux',
    model: 'gpt-test',
    effort: 'high',
    access: 'workspace-write',
  }), {
    commandId: 'create-1',
    providerInstanceId: 'codex-local',
    cwd: '/workspace/remux',
    model: 'gpt-test',
    effort: 'high',
    access: 'workspace-write',
  });
  assert.deepEqual(parseNativeConversationAccessSetCommand({
    commandId: 'access-1',
    conversationId: 'conversation-1',
    expectedRevision: 'revision-1',
    access: 'read-only',
  }), {
    commandId: 'access-1',
    conversationId: 'conversation-1',
    expectedRevision: 'revision-1',
    access: 'read-only',
  });
  assert.deepEqual(parseNativeMessageSendCommand({
    commandId: 'send-1',
    conversationId: 'conversation-1',
    clientMessageId: 'message-1',
    content: [{ type: 'text', text: 'Implement it.' }],
    providerInstanceId: 'codex-local',
    model: 'gpt-test',
    effort: 'high',
    access: 'workspace-write',
    configurationRevision: 'revision-1',
    delivery: 'auto',
  }), {
    commandId: 'send-1',
    conversationId: 'conversation-1',
    clientMessageId: 'message-1',
    content: [{ type: 'text', text: 'Implement it.' }],
    providerInstanceId: 'codex-local',
    model: 'gpt-test',
    effort: 'high',
    access: 'workspace-write',
    configurationRevision: 'revision-1',
    delivery: 'auto',
  });
  assert.deepEqual(parseNativeTurnMutationCommand({
    commandId: 'interrupt-1',
    conversationId: 'conversation-1',
    turnId: 'turn-1',
  }), {
    commandId: 'interrupt-1',
    conversationId: 'conversation-1',
    turnId: 'turn-1',
  });
  assert.throws(
    () => parseNativeMessageSendCommand({
      commandId: 'send-1',
      conversationId: 'conversation-1',
      clientMessageId: 'message-1',
      content: [{ type: 'text', text: 'Implement it.' }],
      questions: [{ choices: ['yes', 'no'] }],
    }),
    (error) => error instanceof ProviderContractError && error.path === '$.questions',
  );
});

test('native Agent edit and fork commands carry content without synthetic context controls', () => {
  assert.deepEqual(parseNativeBranchCommand({
    commandId: 'branch-1',
    clientMessageId: 'message-branch-1',
    sourceConversationId: 'conversation-1',
    sourceStrandId: 'strand-1',
    sourcePathEntryId: 'path-2',
    expectedHeadRevision: 3,
    content: [{ type: 'text', text: 'Use the other approach.' }],
    mode: 'edit',
    providerInstanceId: 'codex-local',
    model: 'gpt-test',
    effort: 'high',
    access: 'workspace-write',
    configurationRevision: 'revision-1',
  }), {
    commandId: 'branch-1',
    clientMessageId: 'message-branch-1',
    sourceConversationId: 'conversation-1',
    sourceStrandId: 'strand-1',
    sourcePathEntryId: 'path-2',
    expectedHeadRevision: 3,
    content: [{ type: 'text', text: 'Use the other approach.' }],
    mode: 'edit',
    providerInstanceId: 'codex-local',
    model: 'gpt-test',
    effort: 'high',
    access: 'workspace-write',
    configurationRevision: 'revision-1',
  });
});

test('resource resume input carries lifecycle focus and rejects duplicate or unknown keys', () => {
  assert.deepEqual(parseNativeAgentResourceReadParams({
    knownServerGeneration: 'generation-1',
    capabilityRevision: 'capability-1',
    focusedConversationId: 'conversation-1',
    focusedExecutionId: 'execution-1',
    historySync: 'force',
    visibility: 'foreground',
    requests: [
      { key: NATIVE_AGENT_RESOURCE_KEYS.providers, ifNoneMatch: 3 },
      { key: 'agent/runtime:conversation-1' },
      { key: 'agent/transcript:conversation-1:tail-24' },
      { key: 'agent/strand-transcript:conversation-1:strand%3Alegacy:tail-24' },
    ],
  }), {
    knownServerGeneration: 'generation-1',
    capabilityRevision: 'capability-1',
    focusedConversationId: 'conversation-1',
    focusedExecutionId: 'execution-1',
    historySync: 'force',
    visibility: 'foreground',
    requests: [
      { key: NATIVE_AGENT_RESOURCE_KEYS.providers, ifNoneMatch: 3 },
      { key: 'agent/runtime:conversation-1' },
      { key: 'agent/transcript:conversation-1:tail-24' },
      { key: 'agent/strand-transcript:conversation-1:strand%3Alegacy:tail-24' },
    ],
  });
  assert.throws(
    () => parseNativeAgentResourceReadParams({
      requests: [{ key: 'agent/providers' }, { key: 'agent/providers' }],
    }),
    (error) => error instanceof ProviderContractError && error.path === '$.requests[1].key',
  );
  assert.throws(
    () => parseNativeAgentResourceReadParams({ requests: [{ key: 'provider-wire:raw' }] }),
    (error) => error instanceof ProviderContractError && error.path === '$.requests[0].key',
  );
  assert.throws(
    () => parseNativeAgentResourceReadParams({
      historySync: 'always',
      requests: [{ key: 'agent/providers' }],
    }),
    (error) => error instanceof ProviderContractError && error.path === '$.historySync',
  );
});

test('viewer-safe resources reject provider cursors, native envelopes, and credentials', () => {
  const runtime: AgentRuntimeResource = {
    conversationId: 'conversation-1',
    executionId: 'execution-1',
    state: 'running',
    activeTurnId: 'turn-1',
    activeTurnElapsedMs: 1_500,
    lifecycle: {
      state: 'idle', runningCount: 0, checkingCount: 0, stoppingCount: 0,
      stopErrorCount: 0, stopRequested: false,
    },
    history: { state: 'ready' },
    provider: 'codex',
    providerInstanceId: 'codex-local',
    activeConfiguration: {
      model: 'gpt-test',
      effort: 'high',
      serviceTier: null,
      access: 'workspace-write',
    },
    capabilities: {
      provider: 'codex',
      providerVersion: '0.144.0',
      adapterVersion: 'v1',
      authentication: { login: 'device-code', logout: true },
      session: {
        create: true,
        resume: true,
        discoverHistory: true,
        readSnapshot: true,
        forkNative: true,
        rollbackNative: false,
      },
      turns: {
        interrupt: true,
        steer: true,
        queue: false,
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
        childTranscript: 'none',
        childSteer: false,
        childInterrupt: true,
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
    },
    composer: {
      revision: 'revision-1',
      providerInstanceId: 'codex-local',
      nextTurn: {
        model: 'gpt-test',
        effort: 'high',
        serviceTier: null,
        access: 'workspace-write',
        origin: 'conversation-explicit',
      },
      lastUsed: null,
      editable: { model: true, effort: true, serviceTier: false, access: true },
    },
    usage: { turn: null, cumulative: null, context: null, estimatedCost: null },
    compaction: { policy: 'native-auto', operation: { state: 'idle', lastResult: null } },
  };
  assert.doesNotThrow(() => assertViewerSafeNativeResource(runtime));
  assert.throws(
    () => assertViewerSafeNativeResource({ ...runtime, resumeCursor: { threadId: 'secret' } }),
    /server-private/u,
  );
  assert.throws(
    () => assertViewerSafeNativeResource({ ...runtime, native: { sessionId: 'secret' } }),
    /server-private/u,
  );
  assert.throws(
    () => assertViewerSafeNativeResource({ ...runtime, bearerToken: 'secret' }),
    /server-private/u,
  );
});
