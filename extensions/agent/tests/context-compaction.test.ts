import assert from 'node:assert/strict';
import test from 'node:test';

import type { Model } from '@earendil-works/pi-ai';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';

import {
  buildCompactionReplacement,
  compactionRequestPayload,
  contextBudgetNotice,
  hashProviderInput,
  injectContextBudgetNotice,
  injectProviderCompaction,
  resolveContextCompactionPolicy,
  type ProviderCompactionCheckpoint,
} from '../server/src/context/compaction.ts';
import { OpenAICodexRemoteCompactionClient } from '../server/src/providers/openai-codex/remote-compaction.ts';

test('compaction thresholds preserve the desired 300k ceiling with safe smaller-window fallback', () => {
  assert.deepEqual(resolveContextCompactionPolicy(272_000), {
    enabled: true,
    warningTokens: 176_320,
    targetTokens: 220_400,
    emergencyTokens: 258_400,
    retainedMessageTokens: 64_000,
  });
  assert.deepEqual(resolveContextCompactionPolicy(1_000_000), {
    enabled: true,
    warningTokens: 240_000,
    targetTokens: 300_000,
    emergencyTokens: 950_000,
    retainedMessageTokens: 64_000,
  });
  assert.match(contextBudgetNotice({ estimatedTokens: 240_100, targetTokens: 300_000 }), /context_compact/u);
});

test('the budget notice can stay at a stable input position as provider history grows', () => {
  const user = message('user', 'work');
  const notice = '<context-budget>stable</context-budget>';
  const first = injectContextBudgetNotice({ input: [user] }, notice, 1);
  const second = injectContextBudgetNotice({
    input: [
      user,
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'continued' }] },
    ],
  }, notice, 1);
  assert.deepEqual(second.input.slice(0, 2), first.input);
  assert.deepEqual(
    hashProviderInput(second).orderedHashes.slice(0, 2),
    hashProviderInput(first).orderedHashes,
  );
});

test('replacement retains the newest user/developer/system messages and appends one opaque checkpoint', () => {
  const system = message('system', 'sys!');
  const oldUser = message('user', 'old!');
  const developer = message('developer', 'dev!');
  const newestUser = message('user', 'new!');
  const payload = {
    model: 'gpt-5.6-codex',
    previous_response_id: 'response-to-drop',
    input: [
      system,
      oldUser,
      { type: 'function_call', name: 'bash', arguments: '{}' },
      developer,
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ignore me' }] },
      newestUser,
    ],
  };
  const opaque = { type: 'compaction', id: 'compact-1', encrypted_content: 'encrypted-state' };
  const replacement = buildCompactionReplacement(payload, opaque, 2);
  assert.deepEqual(replacement.retainedInput, [developer, newestUser]);
  assert.equal(replacement.retainedInputTokens, 2);
  assert.equal('previous_response_id' in replacement.payload, false);
  assert.deepEqual(replacement.payload.input, [developer, newestUser, opaque]);
  assert.deepEqual(compactionRequestPayload(payload).input.at(-1), { type: 'compaction_trigger' });
});

test('a durable checkpoint is prepended to only the post-checkpoint provider input', () => {
  const checkpoint: ProviderCompactionCheckpoint = {
    version: 1,
    epoch: 1,
    compactedThroughSequence: 10,
    installedSequence: 11,
    trigger: 'automatic',
    inputHash: 'a'.repeat(64),
    policyInputTokens: 220_400,
    retainedInputTokens: 1,
    retainedInput: [message('user', 'kept')],
    providerItem: { type: 'compaction', encrypted_content: 'opaque' },
    usage: { inputTokens: 220_000, outputTokens: 500, cachedInputTokens: 190_000 },
    durationMs: 120,
    requestedPlan: { version: 1, automaticDialogueTurns: 2, overrides: [] },
    resolvedTurns: [],
    selectedTurnIds: ['turn-1'],
  };
  const post = message('user', 'after');
  const payload = injectProviderCompaction({ previous_response_id: 'drop', input: [post] }, checkpoint);
  assert.equal('previous_response_id' in payload, false);
  assert.deepEqual(payload.input, [...checkpoint.retainedInput, checkpoint.providerItem, post]);
  assert.equal(hashProviderInput(payload).itemCount, 3);
});

test('the subscription compaction client sends a full trigger request and accepts the opaque SSE item', async () => {
  const token = jwt({
    'https://api.openai.com/auth': { chatgpt_account_id: 'account-123' },
  });
  const runtime = {
    async getAuth() {
      return { auth: { apiKey: token, baseUrl: 'https://chatgpt.com/backend-api' } };
    },
  } as unknown as ModelRuntime;
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher: typeof fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    const stream = [
      'data: {"type":"response.output_item.done","item":{"type":"compaction","id":"cmp","encrypted_content":"opaque"}}\n\n',
      'data: {"type":"response.completed","response":{"output":[],"usage":{"input_tokens":100,"output_tokens":2,"input_tokens_details":{"cached_tokens":80}}}}\n\n',
    ].join('');
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const client = new OpenAICodexRemoteCompactionClient(runtime, fetcher);
  const model = {
    id: 'gpt-5.6-codex',
    provider: 'openai-codex',
    api: 'openai-codex-responses',
    baseUrl: 'https://chatgpt.com/backend-api',
  } as Model<string>;
  const result = await client.compact({
    model,
    payload: { input: [message('user', 'compact this')], stream: true },
  });
  const request = requests[0]!;
  assert.equal(request.url, 'https://chatgpt.com/backend-api/codex/responses');
  const headers = new Headers(request.init?.headers);
  assert.equal(headers.get('chatgpt-account-id'), 'account-123');
  assert.equal(headers.get('authorization'), `Bearer ${token}`);
  const body = JSON.parse(String(request.init?.body)) as { input: unknown[] };
  assert.deepEqual(body.input.at(-1), { type: 'compaction_trigger' });
  assert.deepEqual(result.providerItem, {
    encrypted_content: 'opaque', id: 'cmp', type: 'compaction',
  });
  assert.deepEqual(result.usage, { inputTokens: 100, outputTokens: 2, cachedInputTokens: 80 });
});

function message(role: 'user' | 'developer' | 'system', text: string) {
  return { type: 'message', role, content: [{ type: 'input_text', text }] };
}

function jwt(payload: unknown) {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'none' })}.${part(payload)}.`;
}
