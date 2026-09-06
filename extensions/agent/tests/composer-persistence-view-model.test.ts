import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  AgentConversationResource,
  AgentModelsResource,
  AgentQueueResource,
} from '../shared/native-agent-protocol.ts';
import { createEmptyComposerSnapshot } from '../viewer/src/composer/model/composerModel.ts';
import { preferredReasoning } from '../viewer/src/composer/config/modelSelection.ts';
import { loadNewChatDraft, persistNewChatDraft } from '../viewer/src/conversation/drafts.ts';
import { canManuallyCompact } from '../viewer/src/composer/usage/compactEligibility.ts';
import {
  projectNativeConversation,
  projectNativeModels,
  projectNativeQueue,
} from '../viewer/src/nativeViewModel.ts';

test('new-chat drafts persist access and validate legacy or invalid values', () => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => values.delete(key),
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
  persistNewChatDraft({
    access: 'read-only', cwd: '/workspace', id: 'saved',
    snapshot: createEmptyComposerSnapshot(), updatedAt: 1,
  });
  assert.equal(loadNewChatDraft('saved')?.access, 'read-only');

  const key = 'remux.agent.new-chat-draft.v1:legacy';
  values.set(key, JSON.stringify({
    cwd: '/workspace', id: 'legacy', snapshot: { document: { parts: [] }, attachments: [] }, updatedAt: 1,
  }));
  assert.equal(loadNewChatDraft('legacy')?.access, 'workspace-write');
  values.set(key, values.get(key)!.replace('"updatedAt":1', '"access":"invalid","updatedAt":1'));
  assert.equal(loadNewChatDraft('legacy')?.access, 'workspace-write');
});

test('native model, conversation, and queue projections retain provider facts', () => {
  const models = projectNativeModels([{
    providerInstanceId: 'native', defaultModelId: 'model', error: null,
    models: [{
      id: 'model', name: 'Model', provider: 'fixture', contextWindow: 10,
      supportedEffort: ['unfamiliar', 'off'], serviceTiers: [],
    }],
  } satisfies AgentModelsResource]);
  assert.deepEqual(models.models[0]?.supportedReasoning, ['unfamiliar', 'off']);
  assert.equal(preferredReasoning({ ...models.models[0]!, supportedReasoning: [] }), null);

  const summary = projectNativeConversation({
    conversationId: 'conversation', provider: 'fixture', providerInstanceId: 'native',
    title: '', preview: '', cwd: '/workspace', model: 'model', effort: 'unfamiliar',
    access: 'workspace-write', state: 'idle', rootExecutionId: 'execution',
    parentConversationId: null, rootConversationId: 'conversation', forkedFromPathEntryId: null,
    activeStrandId: 'strand', headRevision: 1, versionCount: 1, childCount: 0,
    subtreeUpdatedAt: 1, archivedAt: null, metadataRevision: 1, activeTurnId: null,
    history: { state: 'ready' }, resumable: false, createdAt: 1, updatedAt: 1,
  } as AgentConversationResource);
  assert.equal(summary.reasoning, 'unfamiliar');
  assert.equal(summary.resumable, false);

  const queue = projectNativeQueue({
    conversationId: 'conversation',
    entries: [{ kind: 'compact', commandId: 'command', operationId: 'operation', createdAt: 1 }],
  } satisfies AgentQueueResource);
  assert.equal(queue?.entries[0]?.kind, 'compact');

  const conversation: any = { id: 'conversation', resumable: true };
  const runtime = {
    conversationId: 'conversation', capabilities: { compaction: { manualNative: true } },
    deliveryHeld: false,
    compaction: { operation: { state: 'idle' } },
  } as any;
  const emptyQueue: any = { conversationId: 'conversation', entries: [] };
  assert.equal(canManuallyCompact(conversation, runtime, emptyQueue), true);
  assert.equal(canManuallyCompact(conversation, runtime, null), false);
  assert.equal(canManuallyCompact(conversation, runtime, { ...emptyQueue, conversationId: 'other' }), false);
  assert.equal(canManuallyCompact({ ...conversation, resumable: false }, runtime, emptyQueue), false);
  assert.equal(canManuallyCompact(conversation, { ...runtime, conversationId: 'other' }, emptyQueue), false);
  assert.equal(canManuallyCompact(conversation, runtime, queue), false);
  assert.equal(canManuallyCompact(conversation, { ...runtime, deliveryHeld: true }, emptyQueue), false);
  assert.equal(canManuallyCompact(
    conversation,
    { ...runtime, compaction: { operation: { state: 'running' } } },
    emptyQueue,
  ), false);
});
