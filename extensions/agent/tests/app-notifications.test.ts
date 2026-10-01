import assert from 'node:assert/strict';
import test from 'node:test';

import { createAgentTurnNotification } from '../server/src/app-notifications.ts';

test('completed Agent turns produce a focused idempotent notification intent', () => {
  const notification = createAgentTurnNotification({
    conversationId: 'conversation-1',
    turnId: 'turn-1',
    status: 'completed',
  });

  assert.deepEqual(notification, {
    method: 'remux/notifications/request',
    params: {
      extensionId: 'agent',
      id: 'agent-turn:conversation-1:turn-1',
      target: {
        focusId: 'turn-1',
        focusKind: 'turn',
        resourceId: 'conversation-1',
        resourceKind: 'agentConversation',
      },
      title: 'Done',
      viewId: 'main',
    },
  });
});

test('failed Agent turns use a title without a body', () => {
  const notification = createAgentTurnNotification({
    conversationId: 'conversation-1',
    turnId: 'turn-2',
    status: 'failed',
  });

  assert.equal(notification?.params.title, 'Failed');
  assert.equal(Object.hasOwn(notification!.params, 'body'), false);
});

test('interrupted Agent turns do not request a notification', () => {
  assert.equal(createAgentTurnNotification({
    conversationId: 'conversation-1',
    turnId: 'turn-3',
    status: 'interrupted',
  }), null);
});

test('continuation notifications focus their exact section and retain stable identity', () => {
  const input = { conversationId: 'conversation-1', turnId: 'turn-4',
    segmentId: 'notice:child:finished', status: 'completed' as const };
  const first = createAgentTurnNotification(input)!;
  assert.equal(first.params.title, 'Done');
  assert.equal(Object.hasOwn(first.params, 'body'), false);
  assert.deepEqual(first.params.target, {
    resourceKind: 'agentConversation', resourceId: 'conversation-1',
    focusKind: 'section', focusId: JSON.stringify(['turn-4', 'notice:child:finished']),
  });
  assert.deepEqual(createAgentTurnNotification(input), first);
});
