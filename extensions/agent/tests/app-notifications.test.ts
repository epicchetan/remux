import assert from 'node:assert/strict';
import test from 'node:test';

import { createAgentTurnNotification } from '../server/src/app-notifications.ts';

test('completed Agent turns produce a focused idempotent notification intent', () => {
  const notification = createAgentTurnNotification({
    conversationId: 'conversation-1',
    turnId: 'turn-1',
    terminalSequence: 42,
    status: 'completed',
    error: null,
  });

  assert.deepEqual(notification, {
    method: 'remux/notifications/request',
    params: {
      body: 'Turn completed.',
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

test('failed Agent turns use a short fixed body', () => {
  const notification = createAgentTurnNotification({
    conversationId: 'conversation-1',
    turnId: 'turn-2',
    terminalSequence: 84,
    status: 'failed',
    error: `# Provider failure\n\n${'request timed out '.repeat(20)}\n\n\`\`\`text\nprivate output\n\`\`\``,
  });

  assert.equal(notification?.params.title, 'Agent turn failed');
  assert.equal(notification?.params.body, 'Turn failed.');
});

test('interrupted Agent turns do not request a notification', () => {
  assert.equal(createAgentTurnNotification({
    conversationId: 'conversation-1',
    turnId: 'turn-3',
    terminalSequence: 126,
    status: 'interrupted',
    error: null,
  }), null);
});
