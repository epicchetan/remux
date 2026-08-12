import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  invalidateProviderLane,
  planProviderLaneRequest,
} from '../server/src/providers/openai-codex/provider-lanes.ts';

const root = resolve(import.meta.dirname, '../../..');

test('the pinned Pi seam separates prompt caching from scope-local WebSocket lanes', async () => {
  const [sdk, provider, nestedProvider, providerTypes, nestedProviderTypes] = await Promise.all([
    readFile(resolve(
      root,
      'node_modules/@earendil-works/pi-coding-agent/dist/core/sdk.js',
    ), 'utf8'),
    readFile(resolve(
      root,
      'node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js',
    ), 'utf8'),
    readFile(resolve(
      root,
      'node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js',
    ), 'utf8'),
    readFile(resolve(
      root,
      'node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.d.ts',
    ), 'utf8'),
    readFile(resolve(
      root,
      'node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.d.ts',
    ), 'utf8'),
  ]);

  assert.match(sdk, /websocketSessionId: providerSessionId\?\.\(\) \?\? options\?\.sessionId/u);
  assert.match(sdk, /debugWebSocketDropAfterEvents: providerWebSocketFaultAfterEvents\?\.\(\)/u);
  assert.match(sdk, /registerProviderTransportControls/u);
  for (const source of [provider, nestedProvider]) {
    assert.match(source, /options\?\.websocketSessionId \?\? options\?\.sessionId/u);
    assert.match(source, /websocketSessionId: options\?\.websocketSessionId/u);
    assert.match(source, /debugWebSocketDropAfterEvents: options\?\.debugWebSocketDropAfterEvents/u);
    assert.match(source, /clampOpenAIPromptCacheKey\(options\?\.sessionId\)/u);
    assert.match(source, /SESSION_WEBSOCKET_CACHE_TTL_MS = 45 \* 60 \* 1000/u);
  }
  for (const source of [providerTypes, nestedProviderTypes]) {
    assert.match(source, /websocketSessionId\?: string/u);
    assert.match(source, /debugWebSocketDropAfterEvents\?: number/u);
  }
});

test('the Agent runtime owns bounded durable retries and selects one provider lane per scope', async () => {
  const runtime = await readFile(resolve(root, 'extensions/agent/server/src/providers/openai-codex/openai-codex-provider.ts'), 'utf8');
  assert.match(runtime, /enabled: true,\s+maxRetries: 2,\s+baseDelayMs: 500/u);
  assert.match(runtime, /supersedeProviderAttempt/u);
  assert.match(runtime, /providerSessionId: \(\) => activeProviderSessionId/u);
  assert.match(runtime, /snapshot\.scopeKind === 'work_unit'\s+\? snapshot\.scopeId\s+: parentProviderSessionId/u);
  assert.match(runtime, /provider-retry@1/u);
  assert.match(runtime, /provider-lanes@1/u);
  assert.match(
    runtime,
    /if \(finalAssistant\) await ensureAssistantDurable\(finalAssistant\);/u,
    'agent_end must seal the exact final provider message instead of trusting cycle-global state',
  );
});

test('parent and work-unit provider lanes continue independently', () => {
  const rootFirst = planProviderLaneRequest(undefined, ['root-user']);
  assert.equal(rootFirst.requestMode, 'full');
  const rootSecond = planProviderLaneRequest(rootFirst.next, ['root-user', 'root-assistant']);
  assert.equal(rootSecond.requestMode, 'continuation');

  const childFirst = planProviderLaneRequest(undefined, ['child-orientation']);
  assert.equal(childFirst.requestMode, 'full');
  const childSecond = planProviderLaneRequest(childFirst.next, [
    'child-orientation',
    'child-assistant',
  ]);
  assert.equal(childSecond.requestMode, 'continuation');

  const resumedRoot = planProviderLaneRequest(rootSecond.next, [
    'root-user',
    'root-assistant',
    'work-unit-result',
  ]);
  assert.equal(resumedRoot.requestMode, 'continuation');

  const invalidatedRoot = planProviderLaneRequest(
    invalidateProviderLane(resumedRoot.next),
    ['root-user', 'root-assistant', 'work-unit-result', 'retry'],
  );
  assert.equal(invalidatedRoot.requestMode, 'full');
});
