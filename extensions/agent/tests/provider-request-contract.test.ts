import assert from 'node:assert/strict';
import test from 'node:test';

import {
  requestConciseReasoningSummary,
} from '../server/src/providers/openai-codex/openai-codex-provider.ts';

test('the OpenAI provider requests a native concise reasoning summary without disturbing the request', () => {
  const payload = {
    model: 'gpt-5.6-sol',
    input: [{ role: 'user', content: 'Inspect this.' }],
    reasoning: { effort: 'high', summary: 'auto' },
    tools: [{ type: 'function', name: 'read' }],
  };

  assert.deepEqual(requestConciseReasoningSummary(payload), {
    ...payload,
    reasoning: { effort: 'high', summary: 'concise' },
  });
  assert.deepEqual(payload.reasoning, { effort: 'high', summary: 'auto' });
});

test('the OpenAI provider leaves non-reasoning payloads unchanged', () => {
  const payload = { model: 'fixture', input: [] };
  assert.equal(requestConciseReasoningSummary(payload), payload);
});
