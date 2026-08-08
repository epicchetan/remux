import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONVERSATION_LIST_LIMIT,
  normalizeConversationText,
  renderConversationList,
  renderConversationSummary,
  type ConversationSummaryInput,
} from '../server/src/conversation-summary.ts';

test('conversation summaries normalize whitespace and truncate by Unicode code point', () => {
  const titleText = `  ${'🙂'.repeat(60)}\u00a0 tail `;
  const previewText = ` ${'界'.repeat(140)}\nignored `;
  const summary = renderConversationSummary(input({
    messages: [
      { role: 'user', text: titleText, sequence: 1, turnId: 'turn-1' },
      { role: 'assistant', text: previewText, sequence: 2, turnId: 'turn-1' },
    ],
  }));

  assert.equal([...summary.title].length, 48);
  assert.equal(summary.title, '🙂'.repeat(48));
  assert.equal([...summary.preview].length, 120);
  assert.equal(summary.preview, '界'.repeat(120));
  assert.equal(normalizeConversationText(' a\t\n\u2003b '), 'a b');
});

test('conversation summaries use visible messages only and derive durable status', () => {
  const failed = renderConversationSummary(input({
    conversationState: 'idle',
    latestTurn: { id: 'turn-2', state: 'failed' },
    messages: [
      { role: 'user', text: 'first user title', sequence: 1, turnId: 'turn-1' },
      { role: 'assistant', text: 'assistant answer', sequence: 2, turnId: 'turn-1' },
      { role: 'user', text: 'newer user request', sequence: 3, turnId: 'turn-2' },
    ],
  }));
  assert.equal(failed.title, 'first user title');
  assert.equal(failed.preview, 'assistant answer');
  assert.equal(failed.status, 'error');
  assert.equal(failed.latestTurnId, 'turn-2');
  assert.equal(JSON.stringify(failed).includes('private reasoning'), false);
  assert.equal(JSON.stringify(failed).includes('tool output'), false);

  const running = renderConversationSummary(input({
    conversationState: 'running',
    latestTurn: { id: 'turn-3', state: 'running' },
    messages: [{ role: 'user', text: 'only user', sequence: 1, turnId: 'turn-3' }],
  }));
  assert.equal(running.preview, 'only user');
  assert.equal(running.status, 'running');
});

test('conversation lists sort deterministically and keep only the newest fifty', () => {
  const summaries = Array.from({ length: CONVERSATION_LIST_LIMIT + 3 }, (_, index) =>
    renderConversationSummary(input({
      id: `conversation-${String(index).padStart(2, '0')}`,
      updatedAt: index < 3 ? 100 : index,
    })));
  const list = renderConversationList(summaries);

  assert.equal(list.conversations.length, CONVERSATION_LIST_LIMIT);
  assert.deepEqual(
    list.conversations.slice(0, 3).map((summary) => summary.id),
    ['conversation-02', 'conversation-01', 'conversation-00'],
  );
  assert.equal(new Set(list.conversations.map((summary) => summary.id)).size, 50);
  assert.equal(list.truncated, true);
});

function input(overrides: Partial<ConversationSummaryInput> = {}): ConversationSummaryInput {
  return {
    id: 'conversation-1',
    cwd: '/workspace',
    modelId: 'gpt-5.4',
    reasoning: 'high',
    conversationState: 'idle',
    latestTurn: null,
    createdAt: 10,
    updatedAt: 20,
    messages: [],
    ...overrides,
  };
}
