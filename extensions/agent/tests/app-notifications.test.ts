import assert from 'node:assert/strict';
import test from 'node:test';

import { createAgentTurnNotification } from '../server/src/app-notifications.ts';
import type { ConversationSummary } from '../shared/protocol.ts';

test('completed Agent turns produce a focused idempotent notification intent', () => {
  const notification = createAgentTurnNotification({
    conversationId: 'conversation-1',
    turnId: 'turn-1',
    terminalSequence: 42,
    status: 'completed',
    error: null,
  }, summary({
    preview: 'The durable implementation is complete.',
  }));

  assert.deepEqual(notification, {
    method: 'remux/notifications/request',
    params: {
      body: 'The durable implementation is complete.',
      extensionId: 'agent',
      id: 'agent-turn:conversation-1:turn-1:42',
      target: {
        focusId: 'turn-1',
        focusKind: 'turn',
        resourceId: 'conversation-1',
        resourceKind: 'agentConversation',
      },
      title: 'Agent finished',
      viewId: 'main',
    },
  });
});

test('failed Agent turns prefer a bounded readable error body', () => {
  const notification = createAgentTurnNotification({
    conversationId: 'conversation-1',
    turnId: 'turn-2',
    terminalSequence: 84,
    status: 'failed',
    error: `# Provider failure\n\n${'request timed out '.repeat(20)}\n\n\`\`\`text\nprivate output\n\`\`\``,
  }, summary({ preview: 'Stale assistant preview.' }));

  assert.equal(notification?.params.title, 'Agent turn failed');
  assert.ok(notification?.params.body.startsWith('Provider failure request timed out'));
  assert.ok(notification?.params.body.endsWith('...'));
  assert.ok([...notification!.params.body].length <= 153);
  assert.equal(notification?.params.body.includes('private output'), false);
});

test('interrupted Agent turns do not request a notification', () => {
  assert.equal(createAgentTurnNotification({
    conversationId: 'conversation-1',
    turnId: 'turn-3',
    terminalSequence: 126,
    status: 'interrupted',
    error: null,
  }, summary()), null);
});

function summary(overrides: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id: 'conversation-1',
    title: 'Agent notification test',
    preview: '',
    cwd: '/workspace',
    modelId: 'gpt-5.6-sol',
    reasoning: 'high',
    status: 'idle',
    latestTurnId: 'turn-1',
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}
