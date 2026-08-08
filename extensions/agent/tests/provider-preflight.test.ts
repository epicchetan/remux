import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import {
  fauxAssistantMessage,
  fauxProvider,
  lazyStream,
  type Provider,
} from '@earendil-works/pi-ai';
import {
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSessionEvent,
  type ExtensionFactory,
} from '@earendil-works/pi-coding-agent';

import {
  createRemuxAgentSession,
  type ProviderPreflight,
} from '../server/src/pi-session.ts';
import { assertContextBudget } from '../server/src/logical-context.ts';

test('Remux provider preflight observes the transformed payload and is awaited before dispatch', async (t) => {
  let releasePreflight!: () => void;
  let enteredPreflight!: () => void;
  const entered = new Promise<void>((resolve) => {
    enteredPreflight = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    releasePreflight = resolve;
  });
  let observedPayload: unknown;
  const fixture = await createPreflightFixture(t, async (payload) => {
    observedPayload = payload;
    enteredPreflight();
    await blocked;
  });

  const prompting = fixture.session.prompt('hello', { expandPromptTemplates: false });
  await entered;

  assert.equal(fixture.providerCalls(), 0);
  assert.deepEqual(observedPayload, {
    kind: 'fixture-provider-payload',
    messageCount: 1,
    transformedByExtension: true,
  });

  releasePreflight();
  await prompting;

  assert.equal(fixture.providerCalls(), 1);
  assert.equal(lastAssistant(fixture.events)?.stopReason, 'stop');
});

test('rejecting Remux provider preflight produces one terminal error and zero provider calls', async (t) => {
  let preflightCalls = 0;
  const fixture = await createPreflightFixture(t, async () => {
    preflightCalls += 1;
    throw new Error('injected durable preflight failure');
  });

  await fixture.session.prompt('do not dispatch', { expandPromptTemplates: false });

  assert.equal(preflightCalls, 1);
  assert.equal(fixture.providerCalls(), 0);
  const assistant = lastAssistant(fixture.events);
  assert.equal(assistant?.stopReason, 'error');
  assert.equal(assistant?.errorMessage, 'injected durable preflight failure');
  assert.equal(
    fixture.events.filter((event) => event.type === 'agent_end').length,
    1,
  );
});

test('a swallowed context-extension failure cannot cross a one-use preflight fence', async (t) => {
  let contextFence = false;
  const failingContext: ExtensionFactory = (pi) => {
    pi.on('context', () => {
      contextFence = false;
      throw new Error('injected context compiler mismatch');
    });
  };
  const fixture = await createPreflightFixture(t, async () => {
    if (!contextFence) throw new Error('missing durable context fence');
    contextFence = false;
  }, [failingContext]);

  await fixture.session.prompt('must remain local', { expandPromptTemplates: false });

  assert.equal(fixture.providerCalls(), 0);
  const assistant = lastAssistant(fixture.events);
  assert.equal(assistant?.stopReason, 'error');
  assert.equal(assistant?.errorMessage, 'missing durable context fence');
});

test('the context rollover guard rejects before provider I/O', async (t) => {
  const fixture = await createPreflightFixture(t, async () => {
    assertContextBudget(5_001, 35_000);
  });

  await fixture.session.prompt('oversized replay', { expandPromptTemplates: false });

  assert.equal(fixture.providerCalls(), 0);
  const assistant = lastAssistant(fixture.events);
  assert.equal(assistant?.stopReason, 'error');
  assert.match(assistant?.errorMessage ?? '', /epoch rollover is not enabled/u);
});

async function createPreflightFixture(
  t: TestContext,
  providerPreflight: ProviderPreflight,
  extraExtensions: ExtensionFactory[] = [],
) {
  const cwd = await mkdtemp(join(tmpdir(), 'remux-agent-preflight-'));
  t.after(() => rm(cwd, { force: true, recursive: true }));

  const modelRuntime = await ModelRuntime.create({
    allowModelNetwork: false,
    modelsPath: null,
  });
  const faux = fauxProvider({
    api: 'remux-preflight-fixture',
    provider: 'remux-preflight-fixture',
    models: [{ id: 'remux-preflight-fixture', name: 'Remux preflight fixture' }],
  });
  faux.setResponses([fauxAssistantMessage('dispatched')]);
  const provider: Provider = {
    id: faux.provider.id,
    name: faux.provider.name,
    baseUrl: faux.provider.baseUrl,
    headers: faux.provider.headers,
    auth: faux.provider.auth,
    getModels: () => faux.provider.getModels(),
    stream: (model, context, options) => faux.provider.stream(model, context, options),
    streamSimple(model, context, options) {
      return lazyStream(model, async () => {
        const payload = {
          kind: 'fixture-provider-payload',
          messageCount: context.messages.length,
        };
        await options?.onPayload?.(payload, model);
        return faux.provider.streamSimple(model, context, options);
      });
    },
  };
  modelRuntime.registerNativeProvider(provider);
  await modelRuntime.refresh({ allowNetwork: false, providers: [provider.id] });
  const model = modelRuntime.getModel(provider.id, 'remux-preflight-fixture');
  assert.ok(model);

  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: {
      enabled: false,
      maxRetries: 0,
      provider: { maxRetries: 0, maxRetryDelayMs: 0 },
    },
    enableAnalytics: false,
    enableInstallTelemetry: false,
  });
  const payloadTransform: ExtensionFactory = (pi) => {
    pi.on('before_provider_request', (event) => ({
      ...(event.payload as Record<string, unknown>),
      transformedByExtension: true,
    }));
  };
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    settingsManager,
    extensionFactories: [
      { name: 'payload-transform', factory: payloadTransform, hidden: true },
      ...extraExtensions.map((factory, index) => ({
        name: `extra-${index}`,
        factory,
        hidden: true,
      })),
    ],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: 'Provider preflight fixture.',
  });
  await resourceLoader.reload();

  const { session } = await createRemuxAgentSession({
    cwd,
    modelRuntime,
    model,
    thinkingLevel: 'off',
    noTools: 'all',
    resourceLoader,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager,
    providerPreflight,
  });
  const events: AgentSessionEvent[] = [];
  const unsubscribe = session.subscribe((event) => {
    events.push(event);
  });
  t.after(() => {
    unsubscribe();
    session.abort();
  });

  return {
    session,
    events,
    providerCalls: () => faux.state.callCount,
  };
}

function lastAssistant(events: AgentSessionEvent[]) {
  const terminal = events.findLast((event) => event.type === 'agent_end');
  return terminal?.type === 'agent_end'
    ? terminal.messages.findLast((message) => message.role === 'assistant')
    : undefined;
}
