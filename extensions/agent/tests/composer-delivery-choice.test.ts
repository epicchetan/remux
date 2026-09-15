import assert from 'node:assert/strict';
import test from 'node:test';
import { composerDeliveryNotice, composerDeliveryReason, type ComposerDeliveryInput } from '../viewer/src/composer/model/deliveryChoice.ts';

function input(): ComposerDeliveryInput {
  return {
    runtime: { conversationId: 'chat', activeTurnId: 'parent', state: 'running', deliveryHeld: false,
      capabilities: { turns: { activeInput: 'stream-input' } },
      activeConfiguration: { model: 'model', effort: 'high', serviceTier: null, access: 'workspace-write' },
      compaction: { operation: { state: 'idle' } },
    } as ComposerDeliveryInput['runtime'],
    queue: { conversationId: 'chat', entries: [] },
    model: 'model', effort: 'high', serviceTier: null, access: 'workspace-write',
  };
}

test('eligible active and idle parents need no delivery explanation', () => {
  const state = input();
  assert.equal(composerDeliveryReason(state), null);
  state.runtime!.activeTurnId = null;
  state.queue = null;
  assert.equal(composerDeliveryReason(state), null);
});
for (const key of ['model', 'effort', 'serviceTier', 'access'] as const) {
  test(`a ${key} change explains captured settings`, () => {
    const state = input();
    if (key === 'access') state.access = 'read-only';
    else state[key] = 'different';
    assert.match(composerDeliveryReason(state)!, /different settings/);
  });
}
test('footer explains provider, queue, compaction, hold and recovery barriers', () => {
  const state = input();
  state.runtime!.capabilities.turns.activeInput = undefined;
  assert.match(composerDeliveryReason(state)!, /provider/);
  state.runtime!.capabilities.turns.activeInput = 'stream-input';
  state.queue!.entries.push({ kind: 'compact', id: 'compact', text: 'Compact', createdAt: 1, attachmentCount: 0, mentionCount: 0 });
  assert.match(composerDeliveryReason(state)!, /Earlier queued work/);
  state.queue!.entries = [];
  state.runtime!.compaction.operation = { state: 'running', operationId: 'compact', trigger: 'manual', startedAt: 1 };
  assert.match(composerDeliveryReason(state)!, /compaction/);
  state.runtime!.deliveryHeld = true;
  assert.match(composerDeliveryReason(state)!, /unconfirmed/);
  state.runtime!.deliveryHeld = false;
  state.queue = null;
  assert.match(composerDeliveryReason(state)!, /Checking/);
  state.queue = { conversationId: 'chat', entries: [] };
  state.runtime!.state = 'recovering';
  assert.match(composerDeliveryReason(state)!, /Checking/);
});

test('explicit steer queue reasons have a short inline explanation', () => {
  assert.equal(composerDeliveryNotice('federation-wait'), 'Message queued because this turn is waiting on a federated child.');
  assert.equal(composerDeliveryNotice('steer-unavailable'), 'Message queued because this provider cannot steer the current turn.');
  assert.equal(composerDeliveryNotice(undefined), null);
});
