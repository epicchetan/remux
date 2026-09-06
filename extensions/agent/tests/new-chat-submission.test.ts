import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clearPendingNewChatSubmission,
  findPendingNewChatSubmission,
  listPendingNewChatSubmissions,
  persistPendingNewChatSubmission,
  type PendingNewChatSubmission,
} from '../viewer/src/app/newChatSubmission.ts';

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

function pending(id: string): PendingNewChatSubmission {
  return {
    version: 1, draftId: id, snapshotKey: 'snapshot', conversationId: null,
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
  persistPendingNewChatSubmission(first);
  persistPendingNewChatSubmission(pending('b'));
  assert.deepEqual(findPendingNewChatSubmission({ conversationId: null, draftId: 'a' }), first);
  assert.deepEqual(findPendingNewChatSubmission({ conversationId: 'accepted-a', draftId: null }), first);
  assert.equal(findPendingNewChatSubmission({ conversationId: null, draftId: 'c' }), null);
  clearPendingNewChatSubmission('a');
  assert.deepEqual(listPendingNewChatSubmissions().map((record) => record.draftId), ['b']);
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
  persistPendingNewChatSubmission(record);
  assert.deepEqual(listPendingNewChatSubmissions(), [record]);
  assert.equal([...values.values()][0]!.split('data:image/png;base64,').length, 2);
});

test('malformed stored payloads and mismatched identities never become replay candidates', () => {
  const values = storage();
  const record = pending('valid');
  persistPendingNewChatSubmission(record);
  const key = [...values.keys()][0]!;
  for (const mutation of [
    { original: { ...record.original, delivery: 'unsafe' } },
    { original: { ...record.original, parts: [{ type: 'image', dataUrl: 42 }] } },
    { create: { ...record.create, access: 'invalid' } },
    { message: { operationId: 'another-operation' } },
  ]) {
    values.set(key, JSON.stringify({ ...record, ...mutation }));
    assert.deepEqual(listPendingNewChatSubmissions(), []);
  }
  values.set(key, JSON.stringify({ ...record, create: { ...record.create, operationId: 'other' } }));
  assert.deepEqual(listPendingNewChatSubmissions(), []);
});

test('storage failure prevents a recoverable submission from being accepted locally', () => {
  storage();
  sessionStorage.setItem = () => { throw new Error('Storage quota exceeded'); };
  assert.throws(() => persistPendingNewChatSubmission(pending('a')), /quota/);
  sessionStorage.setItem = () => undefined;
  assert.throws(() => persistPendingNewChatSubmission(pending('a')), /Could not save/);
});
