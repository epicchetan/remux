import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clearPendingMessageSubmission,
  findPendingMessageSubmission,
  listPendingMessageSubmissions,
  persistPendingMessageSubmission,
  submissionMatchesTarget,
  type PendingMessageSubmission,
} from '../viewer/src/app/pendingMessageSubmission.ts';

function storage() {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
    get length() { return values.size; },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  } });
  return values;
}

function pending(id: string): PendingMessageSubmission {
  return {
    version: 1, source: 'new-chat', draftId: id, snapshotKey: 'snapshot', conversationId: null,
    create: { operationId: id, providerInstanceId: 'codex-local', cwd: '/workspace',
      nativeModelId: 'model', reasoning: 'high', serviceTier: null, access: 'full-access' },
    original: { providerInstanceId: 'codex-local', modelId: 'model', reasoning: 'high',
      serviceTier: null, access: 'full-access', configurationRevision: null,
      delivery: 'queue', displayText: 'Original', parts: [{ type: 'text', text: 'Original' }] },
    messageOperationId: `send-${id}`, clientMessageId: `message-${id}`, message: null,
  };
}

test('pending submissions retain separate draft owners across the create handoff', () => {
  storage();
  const first = { ...pending('a'), conversationId: 'accepted-a' };
  persistPendingMessageSubmission(first);
  persistPendingMessageSubmission(pending('b'));
  assert.deepEqual(findPendingMessageSubmission({ conversationId: null, draftId: 'a' }), first);
  assert.deepEqual(findPendingMessageSubmission({ conversationId: 'accepted-a', draftId: null }), first);
  assert.equal(findPendingMessageSubmission({ conversationId: null, draftId: 'c' }), null);
  clearPendingMessageSubmission('a');
  assert.deepEqual(listPendingMessageSubmissions().map((record) => record.draftId), ['b']);
});

test('message handoff stores image bytes once and restores the exact frozen request', () => {
  const values = storage();
  const record = pending('image');
  record.original.parts.push({ type: 'image', name: 'proof.png', mimeType: 'image/png',
    dataUrl: `data:image/png;base64,${'A'.repeat(1024 * 1024)}` });
  record.conversationId = 'accepted';
  record.message = { operationId: record.messageOperationId, clientMessageId: record.clientMessageId,
    conversationId: 'accepted', parts: record.original.parts, nativeModelId: 'model',
    reasoning: 'high', serviceTier: null, access: 'full-access', providerInstanceId: 'codex-local',
    configurationRevision: 'revision-1', delivery: 'queue' };
  persistPendingMessageSubmission(record);
  assert.deepEqual(listPendingMessageSubmissions(), [record]);
  assert.equal([...values.values()][0]!.split('data:image/png;base64,').length, 2);
});

test('existing-conversation messages use the send operation as their persisted owner', () => {
  storage();
  const record = pending('unused-create-stage');
  const nativeModelId = record.create!.nativeModelId;
  record.draftId = null;
  record.conversationId = 'conversation-existing';
  record.source = 'existing-conversation';
  record.create = null;
  record.message = {
    operationId: record.messageOperationId,
    clientMessageId: record.clientMessageId,
    conversationId: record.conversationId,
    parts: record.original.parts,
    nativeModelId,
    reasoning: record.original.reasoning,
    serviceTier: record.original.serviceTier,
    providerInstanceId: record.original.providerInstanceId,
    access: record.original.access,
    configurationRevision: 'existing-revision',
    delivery: 'queue',
  };
  persistPendingMessageSubmission(record);

  assert.deepEqual(findPendingMessageSubmission({
    conversationId: record.conversationId,
    draftId: null,
  }), record);
  assert.equal(listPendingMessageSubmissions()[0]!.messageOperationId, record.message.operationId);
  for (const target of [
    { conversationId: null, draftId: null },
    { conversationId: null, draftId: 'another-draft' },
    { conversationId: 'another-conversation', draftId: null },
  ]) {
    assert.equal(findPendingMessageSubmission(target), null);
    assert.equal(submissionMatchesTarget(record, target), false);
  }
});

test('malformed stored payloads and mismatched identities never become replay candidates', () => {
  const values = storage();
  const record = pending('valid');
  persistPendingMessageSubmission(record);
  const key = [...values.keys()][0]!;
  for (const mutation of [
    { original: { ...record.original, delivery: 'unsafe' } },
    { original: { ...record.original, parts: [{ type: 'image', dataUrl: 42 }] } },
    { create: { ...record.create!, access: 'invalid' } },
    { message: { operationId: 'another-operation' } },
  ]) {
    values.set(key, JSON.stringify({ ...record, ...mutation }));
    assert.deepEqual(listPendingMessageSubmissions(), []);
  }
  values.set(key, JSON.stringify({ ...record, create: { ...record.create!, operationId: 'other' } }));
  assert.deepEqual(listPendingMessageSubmissions(), []);
});

test('storage failure prevents a recoverable submission from being accepted locally', () => {
  storage();
  sessionStorage.setItem = () => { throw new Error('Storage quota exceeded'); };
  assert.throws(() => persistPendingMessageSubmission(pending('a')), /quota/);
  sessionStorage.setItem = () => undefined;
  assert.throws(() => persistPendingMessageSubmission(pending('a')), /Could not save/);
});

test('source-less shipped records retain their original new-chat owner after upgrade', () => {
  const values = storage();
  const record = pending('legacy');
  persistPendingMessageSubmission(record);
  const key = [...values.keys()][0]!;
  const legacy = JSON.parse(values.get(key)!);
  delete legacy.source;
  values.set(key, JSON.stringify(legacy));
  assert.deepEqual(findPendingMessageSubmission({ conversationId: null, draftId: 'legacy' }), record);
});
