import assert from 'node:assert/strict';
import test from 'node:test';
import { composerDeliveryState, type ComposerDeliveryInput } from '../viewer/src/composer/model/deliveryChoice.ts';

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

test('eligible active parents offer both explicit routes; idle parents do not need a menu', () => {
  const state = input();
  assert.equal(composerDeliveryState(state).currentAllowed, true);
  assert.equal(composerDeliveryState(state).queueAllowed, true);
  assert.equal(composerDeliveryState(state).menu, true);
  state.runtime!.activeTurnId = null;
  assert.equal(composerDeliveryState(state).menu, false);
  state.queue = null;
  assert.equal(composerDeliveryState(state).menu, false, 'idle lazy activation remains ordinary Send');
  assert.equal(composerDeliveryState(state).currentAllowed, true);
});
for (const key of ['model', 'effort', 'serviceTier', 'access'] as const) {
  test(`a ${key} change requires a new turn`, () => {
    const state = input();
    if (key === 'access') state.access = 'read-only';
    else state[key] = 'different';
    assert.equal(composerDeliveryState(state).currentAllowed, false);
    assert.equal(composerDeliveryState(state).queueAllowed, true);
    assert.match(composerDeliveryState(state).reason!, /different settings/);
  });
}
test('compaction, pending work, unsupported input, and holds never advertise current-turn delivery', () => {
  const state = input();
  state.runtime!.capabilities.turns.activeInput = undefined;
  assert.equal(composerDeliveryState(state).currentAllowed, false);
  assert.match(composerDeliveryState(state).reason!, /provider/);
  state.runtime!.capabilities.turns.activeInput = 'stream-input';
  state.queue!.entries.push({ kind: 'compact', id: 'compact', text: 'Compact', createdAt: 1, attachmentCount: 0, mentionCount: 0 });
  assert.equal(composerDeliveryState(state).queueLabel, 'Queue after pending work');
  state.queue!.entries = [];
  state.runtime!.compaction.operation = { state: 'running', operationId: 'compact', trigger: 'manual', startedAt: 1 };
  assert.equal(composerDeliveryState(state).currentAllowed, false);
  assert.match(composerDeliveryState(state).reason!, /compaction/);
  state.runtime!.deliveryHeld = true;
  assert.equal(composerDeliveryState(state).queueAllowed, false);
  assert.match(composerDeliveryState(state).reason!, /unconfirmed/);
  state.runtime!.deliveryHeld = false;
  state.queue = null;
  assert.equal(composerDeliveryState(state).queueAllowed, false);
  assert.match(composerDeliveryState(state).reason!, /Checking/);
});
