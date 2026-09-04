import assert from 'node:assert/strict';
import test from 'node:test';

import {
  conversationHistorySubtitle,
  conversationHistoryTitle,
  nativeModelId,
  providerLabel,
} from '../viewer/src/conversation/historyPresentation.ts';

test('history identity replaces topology placeholders with the actual prompt', () => {
  const identity = {
    cwd: '/workspace/remux',
    preview: '  Fix the history sidebar\nwithout model-title calls  ',
    provider: 'codex' as const,
    title: 'Forked chat',
  };
  assert.equal(
    conversationHistoryTitle(identity),
    'Fix the history sidebar without model-title calls',
  );
  assert.match(conversationHistorySubtitle(identity), /remux$/u);
  assert.equal(conversationHistoryTitle({
    ...identity,
    preview: 'Continue fixing transcript hydration',
    title: 'Edited chat',
  }), 'Continue fixing transcript hydration');
});

test('history identity preserves meaningful native titles and describes image-only chats', () => {
  assert.equal(conversationHistoryTitle({
    cwd: '/workspace/remux',
    preview: 'Investigate the mobile layout',
    provider: 'codex',
    title: 'Mobile history cleanup',
  }), 'Mobile history cleanup');
  assert.equal(conversationHistorySubtitle({
    cwd: '/workspace/remux',
    preview: 'Investigate the mobile layout',
    provider: 'codex',
    title: 'Mobile history cleanup',
  }), 'Investigate the mobile layout');
  assert.equal(conversationHistoryTitle({
    cwd: '',
    preview: '[Attached image]',
    provider: 'claude-code',
    title: 'New chat',
  }), 'Image conversation');
});

test('history model labels preserve native identity without pretending an unknown model is known', () => {
  assert.equal(nativeModelId('codex-local::gpt-5.6-sol'), 'gpt-5.6-sol');
  assert.equal(providerLabel('codex'), 'Codex');
  assert.equal(providerLabel('claude-code'), 'Claude');
});
