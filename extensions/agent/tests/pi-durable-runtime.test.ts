import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';

import {
  AGENT_METHODS,
  AGENT_RESOURCE_KEYS,
  type AgentRuntimeValue,
  type ResourceReadResult,
} from '../shared/protocol.ts';
import { AgentServer } from '../server/src/agent-server.ts';
import { PiEngine } from '../server/src/pi-runtime.ts';
import { AgentJournalRepository } from '../server/src/storage/repository.ts';
import {
  createScriptedCodexProvider,
  SCRIPTED_CODEX_MODEL_ID,
  type ScriptedCodexRequest,
} from './helpers/scripted-codex-provider.ts';

test('real Pi runtime preserves durable context across tool inference and fresh hydration', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'remux-agent-pi-durable-'));
  const workspace = join(root, 'workspace');
  const dataRoot = join(root, 'data');
  await mkdir(workspace);
  await writeFile(join(workspace, 'README.md'), '# Fixture workspace\nDurable replay works.\n');
  t.after(() => rm(root, { force: true, recursive: true }));

  let activeRepository: AgentJournalRepository;
  const dispatchHeads: Array<{ ordinal: number; type: string | undefined }> = [];
  const scripted = createScriptedCodexProvider({
    steps: [
      {
        kind: 'answer',
        reasoning: 'A final-only visible reasoning summary.',
        text: 'Hello from scripted Codex.',
        responseId: 'response-1',
      },
      {
        kind: 'tool-call',
        callId: 'call-readme|item-readme',
        name: 'workspace_read',
        args: { path: 'README.md' },
        responseId: 'response-2',
      },
      {
        kind: 'answer',
        text: 'The README says durable replay works.',
        responseId: 'response-3',
      },
      {
        kind: 'answer',
        text: 'Restart replay succeeded.',
        responseId: 'response-4',
      },
    ],
    async onDispatch(request) {
      const events = await activeRepository.readEvents();
      dispatchHeads.push({ ordinal: request.ordinal, type: events.at(-1)?.type });
    },
  });
  const modelRuntime = await ModelRuntime.create({
    allowModelNetwork: false,
    modelsPath: null,
    credentials: new InMemoryCredentialStore(),
  });
  modelRuntime.registerNativeProvider(scripted.provider);
  await modelRuntime.setRuntimeApiKey('openai-codex', 'scripted-test-credential');
  await modelRuntime.refresh({ allowNetwork: false, providers: ['openai-codex'] });
  const engine = await PiEngine.create({ modelRuntime });

  const firstRepository = await AgentJournalRepository.open({ dataRoot });
  activeRepository = firstRepository;
  const firstServer = new AgentServer({ engine, journal: firstRepository, notify: () => {} });
  registerClose(t, firstServer, firstRepository);
  await firstServer.initialize();

  const started = await firstServer.handle(AGENT_METHODS.conversationCreate, {
    operationId: randomUUID(),
    cwd: workspace,
    modelId: SCRIPTED_CODEX_MODEL_ID,
    reasoning: 'high',
  }) as { conversationId: string };
  await sendAndWait(firstServer, started.conversationId, 'Remember this response.');
  await sendAndWait(firstServer, started.conversationId, 'Inspect README.md.');

  assert.equal(scripted.requests.length, 3);
  assert.equal(scripted.remainingResponses(), 1);
  assert.deepEqual(scripted.requests.map(requestMode), [
    'full',
    'continuation:response-1',
    'continuation:response-2',
  ]);
  assert.deepEqual(dispatchHeads, [
    { ordinal: 0, type: 'inference.started' },
    { ordinal: 1, type: 'inference.started' },
    { ordinal: 2, type: 'inference.started' },
  ]);
  assert.deepEqual(scripted.requests[2]?.context.messages.map((message) => message.role), [
    'user', 'assistant', 'user', 'assistant', 'toolResult',
  ]);

  const beforeRestart = await firstRepository.compileContext(started.conversationId);
  assert.deepEqual(beforeRestart.messages.map((message) => message.role), [
    'user', 'assistant', 'user', 'assistant', 'tool', 'assistant',
  ]);
  const firstAssistant = beforeRestart.messages.find((message) => message.role === 'assistant');
  assert.equal(
    firstAssistant?.role === 'assistant' ? firstAssistant.reasoning : null,
    'A final-only visible reasoning summary.',
  );
  assert.deepEqual(
    (await firstRepository.readEvents({ conversationId: started.conversationId }))
      .filter(({ type }) => type === 'tool.called' || type === 'tool.completed')
      .map(({ type }) => type),
    ['tool.called', 'tool.completed'],
  );

  await firstServer.close();
  await firstRepository.close();

  const secondRepository = await AgentJournalRepository.open({ dataRoot });
  activeRepository = secondRepository;
  const secondServer = new AgentServer({ engine, journal: secondRepository, notify: () => {} });
  registerClose(t, secondServer, secondRepository);
  await secondServer.initialize();
  await sendAndWait(secondServer, started.conversationId, 'Continue after restart.');

  assert.equal(scripted.requests.length, 4);
  assert.equal(scripted.remainingResponses(), 0);
  assert.equal(requestMode(scripted.requests[3]!), 'full');
  assert.deepEqual(scripted.requests[3]?.context.messages.map((message) => message.role), [
    'user', 'assistant', 'user', 'assistant', 'toolResult', 'assistant', 'user',
  ]);
  assert.deepEqual(dispatchHeads.at(-1), { ordinal: 3, type: 'inference.started' });

  const finalContext = await secondRepository.compileContext(started.conversationId);
  assert.deepEqual(finalContext.messages.map((message) => message.role), [
    'user', 'assistant', 'user', 'assistant', 'tool', 'assistant', 'user', 'assistant',
  ]);
  assert.deepEqual(
    finalContext.messages.filter((message) => message.role === 'user').map((message) => message.text),
    ['Remember this response.', 'Inspect README.md.', 'Continue after restart.'],
  );
  const events = await secondRepository.readEvents({ conversationId: started.conversationId });
  assert.deepEqual(
    events.filter(({ type }) => type === 'inference.started').map((event) => {
      const payload = event.payload as { requestMode?: unknown };
      return payload.requestMode;
    }),
    ['full', 'continuation', 'continuation', 'full'],
  );
});

function requestMode(request: ScriptedCodexRequest) {
  if (!request.payload || typeof request.payload !== 'object' || Array.isArray(request.payload)) {
    throw new Error('The scripted provider payload is invalid.');
  }
  const previous = (request.payload as { previous_response_id?: unknown }).previous_response_id;
  return typeof previous === 'string' ? `continuation:${previous}` : 'full';
}

async function sendAndWait(server: AgentServer, conversationId: string, text: string) {
  await server.handle(AGENT_METHODS.messageSend, {
    operationId: randomUUID(),
    conversationId,
    clientMessageId: randomUUID(),
    text,
  });
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const read = await server.handle(AGENT_METHODS.resourcesRead, {
      requests: [{ key: AGENT_RESOURCE_KEYS.runtime }],
    }) as ResourceReadResult;
    const resource = read.resources[0];
    if (resource?.status === 'ok') {
      const runtime = resource.value as AgentRuntimeValue;
      if (runtime.conversationId === conversationId && runtime.state === 'idle') return;
      if (runtime.conversationId === conversationId && runtime.state === 'error') {
        throw new Error(runtime.error ?? 'The Agent runtime failed without an error message.');
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for conversation ${conversationId}.`);
}

function registerClose(
  t: TestContext,
  server: AgentServer,
  repository: AgentJournalRepository,
) {
  t.after(async () => {
    await server.close();
    await repository.close();
  });
}
