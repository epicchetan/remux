import assert from 'node:assert/strict';
import test from 'node:test';

import {
  requestReasoningControls,
} from '../server/src/providers/openai-codex/openai-codex-provider.ts';

test('the OpenAI provider requests a native concise reasoning summary without disturbing the request', () => {
  const payload = {
    model: 'gpt-5.6-sol',
    input: [{ role: 'user', content: 'Inspect this.' }],
    reasoning: { effort: 'high', summary: 'auto' },
    tools: [{ type: 'function', name: 'read' }],
  };

  assert.deepEqual(requestReasoningControls(payload), {
    ...payload,
    reasoning: { effort: 'high', summary: 'concise' },
  });
  assert.deepEqual(payload.reasoning, { effort: 'high', summary: 'auto' });
});

test('the OpenAI provider leaves non-reasoning payloads unchanged', () => {
  const payload = { model: 'fixture', input: [] };
  assert.equal(requestReasoningControls(payload), payload);
});

test('the OpenAI provider removes unsupported reasoning controls from Codex Spark', () => {
  const payload = {
    model: 'gpt-5.3-codex-spark',
    input: [],
    reasoning: { effort: 'high', summary: 'auto', context: 'all_turns' },
  };
  assert.deepEqual(requestReasoningControls(payload, true), {
    ...payload,
    reasoning: { effort: 'high' },
  });
});

test('full prior-turn context asks GPT-5.6 to preserve reasoning across turns', () => {
  const payload = { model: 'gpt-5.6-sol', input: [], reasoning: { effort: 'high' } };
  assert.deepEqual(requestReasoningControls(payload, true), {
    ...payload,
    reasoning: { effort: 'high', summary: 'concise', context: 'all_turns' },
  });
});
