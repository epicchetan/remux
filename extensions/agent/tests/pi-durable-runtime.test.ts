import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

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
    contextMode: 'full-history',
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

test('stateful Pi frames keep a stable prefix while model-managed state commits durably', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'remux-agent-pi-stateful-'));
  const workspace = join(root, 'workspace');
  const dataRoot = join(root, 'data');
  await mkdir(workspace);
  t.after(() => rm(root, { force: true, recursive: true }));

  const scripted = createScriptedCodexProvider({
    steps: [
      {
        kind: 'tool-call',
        callId: 'call-context|item-context',
        name: 'context_update',
        args: {
          set: [{
            key: 'active-work',
            value: {
              objective: 'Exercise the authoritative stateful frame.',
              status: 'validated',
              next: ['answer the follow-up'],
            },
          }],
        },
        responseId: 'state-response-1',
      },
      {
        kind: 'answer',
        text: 'State committed.',
        responseId: 'state-response-2',
      },
      {
        kind: 'answer',
        text: 'Follow-up retained.',
        responseId: 'state-response-3',
      },
    ],
  });
  const modelRuntime = await ModelRuntime.create({
    allowModelNetwork: false,
    modelsPath: null,
    credentials: new InMemoryCredentialStore(),
  });
  modelRuntime.registerNativeProvider(scripted.provider);
  await modelRuntime.setRuntimeApiKey('openai-codex', 'scripted-test-credential');
  await modelRuntime.refresh({ allowNetwork: false, providers: ['openai-codex'] });
  const repository = await AgentJournalRepository.open({ dataRoot });
  const server = new AgentServer({
    engine: await PiEngine.create({ modelRuntime }),
    journal: repository,
    notify: () => {},
  });
  registerClose(t, server, repository);
  await server.initialize();

  const started = await server.handle(AGENT_METHODS.conversationCreate, {
    operationId: randomUUID(),
    cwd: workspace,
    modelId: SCRIPTED_CODEX_MODEL_ID,
    reasoning: 'high',
    contextMode: 'stateful',
  }) as { conversationId: string };
  await sendAndWait(server, started.conversationId, 'Create durable state for this work.');
  await sendAndWait(server, started.conversationId, 'Did you retain the active objective?');

  assert.deepEqual(scripted.requests.map(requestMode), [
    'full',
    'continuation:state-response-1',
    'continuation:state-response-2',
  ]);
  assert.deepEqual(scripted.requests[0]?.context.messages.map(({ role }) => role), ['user']);
  assert.deepEqual(scripted.requests[1]?.context.messages.map(({ role }) => role), [
    'user', 'assistant', 'toolResult',
  ]);
  assert.equal(
    JSON.stringify(scripted.requests[0]?.context.messages[0]),
    JSON.stringify(scripted.requests[2]?.context.messages[0]),
  );
  const frameText = scripted.requests[0]?.context.messages[0]?.role === 'user'
    ? scripted.requests[0].context.messages[0].content
    : '';
  assert.match(typeof frameText === 'string' ? frameText : JSON.stringify(frameText), /context_hud/u);
  assert.deepEqual(
    scripted.requests[0]?.context.tools?.map(({ name }) => name).sort(),
    ['bash', 'context_update', 'edit', 'journal_open', 'journal_search', 'read', 'workspace_read', 'write'].sort(),
  );

  const context = await repository.compileContext(started.conversationId);
  assert.equal(context.shadowSource.projectRevision, 1);
  assert.equal(context.shadowSource.authority.find(({ key }) => key === 'active-work')?.mode, 'inline');
  const database = new DatabaseSync(repository.databasePath, { readOnly: true });
  const modes = database.prepare(`
    SELECT mode FROM context_compilations ORDER BY created_sequence
  `).all() as Array<{ mode: string }>;
  database.close();
  assert.deepEqual(modes.map(({ mode }) => mode), ['active', 'active', 'active']);
});

test('stateful Pi frame ordinals advance across a fresh runtime', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'remux-agent-pi-frame-restart-'));
  const workspace = join(root, 'workspace');
  const dataRoot = join(root, 'data');
  await mkdir(workspace);
  t.after(() => rm(root, { force: true, recursive: true }));

  const scripted = createScriptedCodexProvider({
    steps: [
      { kind: 'answer', text: 'First frame.', responseId: 'frame-restart-1' },
      { kind: 'answer', text: 'Second frame.', responseId: 'frame-restart-2' },
    ],
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
  const firstServer = new AgentServer({ engine, journal: firstRepository, notify: () => {} });
  registerClose(t, firstServer, firstRepository);
  await firstServer.initialize();
  const started = await firstServer.handle(AGENT_METHODS.conversationCreate, {
    operationId: randomUUID(),
    cwd: workspace,
    modelId: SCRIPTED_CODEX_MODEL_ID,
    reasoning: 'high',
    contextMode: 'stateful',
  }) as { conversationId: string };
  await sendAndWait(firstServer, started.conversationId, 'Open the first frame.');
  await firstServer.close();
  await firstRepository.close();

  const secondRepository = await AgentJournalRepository.open({ dataRoot });
  const secondServer = new AgentServer({ engine, journal: secondRepository, notify: () => {} });
  registerClose(t, secondServer, secondRepository);
  await secondServer.initialize();
  await sendAndWait(secondServer, started.conversationId, 'Continue after restart.');

  assert.deepEqual(scripted.requests.map(requestMode), ['full', 'full']);
  const frames = (await secondRepository.readEvents({ conversationId: started.conversationId }))
    .filter(({ type }) => type === 'inference.started')
    .map(({ payload }) => (payload as { frameOrdinal?: unknown }).frameOrdinal);
  assert.deepEqual(frames, [0, 1]);
  assert.equal((await secondRepository.compileContext(started.conversationId)).nextFrameOrdinal, 2);
});

test('stateful Pi rolls a large frame without manual compaction', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'remux-agent-pi-rollover-'));
  const workspace = join(root, 'workspace');
  const dataRoot = join(root, 'data');
  await mkdir(workspace);
  t.after(() => rm(root, { force: true, recursive: true }));
  const scripted = createScriptedCodexProvider({
    steps: Array.from({ length: 8 }, (_, index) => ({
      kind: 'answer' as const,
      text: `phase-${index}-ok`,
      responseId: `rollover-response-${index}`,
    })),
  });
  const modelRuntime = await ModelRuntime.create({
    allowModelNetwork: false,
    modelsPath: null,
    credentials: new InMemoryCredentialStore(),
  });
  modelRuntime.registerNativeProvider(scripted.provider);
  await modelRuntime.setRuntimeApiKey('openai-codex', 'scripted-test-credential');
  await modelRuntime.refresh({ allowNetwork: false, providers: ['openai-codex'] });
  const repository = await AgentJournalRepository.open({ dataRoot });
  const server = new AgentServer({
    engine: await PiEngine.create({ modelRuntime }),
    journal: repository,
    notify: () => {},
  });
  registerClose(t, server, repository);
  await server.initialize();
  const started = await server.handle(AGENT_METHODS.conversationCreate, {
    operationId: randomUUID(),
    cwd: workspace,
    modelId: SCRIPTED_CODEX_MODEL_ID,
    reasoning: 'high',
    contextMode: 'stateful',
  }) as { conversationId: string };

  for (let index = 0; index < 8; index += 1) {
    await sendAndWait(
      server,
      started.conversationId,
      `phase ${index}\n${String.fromCharCode(65 + index).repeat(190_000)}`,
    );
  }
  const modes = scripted.requests.map(requestMode);
  const fullIndices = modes.flatMap((mode, index) => mode === 'full' ? [index] : []);
  assert.equal(fullIndices[0], 0);
  assert.equal(fullIndices.length >= 2, true, `expected rollover, saw ${modes.join(', ')}`);
  const rolloverIndex = fullIndices[1]!;
  assert.notEqual(
    JSON.stringify(scripted.requests[0]?.context.messages[0]),
    JSON.stringify(scripted.requests[rolloverIndex]?.context.messages[0]),
  );
  assert.equal(scripted.remainingResponses(), 0);
  const events = await repository.readEvents({ conversationId: started.conversationId });
  assert.equal(events.some(({ type }) => type.startsWith('compaction.')), false);
  assert.equal(events.some(({ type, payload }) =>
    type === 'inference.started' &&
    (payload as { pressureNotice?: unknown }).pressureNotice === true), true);
});

test('Pi coding tools honor absolute paths outside the conversation cwd', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'remux-agent-pi-absolute-'));
  const workspace = join(root, 'workspace');
  const sibling = join(root, 'sibling', 'outside.txt');
  const dataRoot = join(root, 'data');
  await mkdir(workspace);
  t.after(() => rm(root, { force: true, recursive: true }));
  const scripted = createScriptedCodexProvider({
    steps: [
      {
        kind: 'tool-call',
        callId: 'call-write|item-write',
        name: 'write',
        args: { path: sibling, content: 'outside cwd works\n' },
        responseId: 'absolute-response-1',
      },
      {
        kind: 'answer',
        text: 'Absolute write completed.',
        responseId: 'absolute-response-2',
      },
    ],
  });
  const modelRuntime = await ModelRuntime.create({
    allowModelNetwork: false,
    modelsPath: null,
    credentials: new InMemoryCredentialStore(),
  });
  modelRuntime.registerNativeProvider(scripted.provider);
  await modelRuntime.setRuntimeApiKey('openai-codex', 'scripted-test-credential');
  await modelRuntime.refresh({ allowNetwork: false, providers: ['openai-codex'] });
  const repository = await AgentJournalRepository.open({ dataRoot });
  const server = new AgentServer({
    engine: await PiEngine.create({ modelRuntime }),
    journal: repository,
    notify: () => {},
  });
  registerClose(t, server, repository);
  await server.initialize();
  const started = await server.handle(AGENT_METHODS.conversationCreate, {
    operationId: randomUUID(),
    cwd: workspace,
    modelId: SCRIPTED_CODEX_MODEL_ID,
    reasoning: 'high',
    contextMode: 'stateful',
  }) as { conversationId: string };
  await sendAndWait(server, started.conversationId, 'Write the requested sibling fixture.');
  assert.equal(await readFile(sibling, 'utf8'), 'outside cwd works\n');
});

test('large built-in read results replay exactly into the next inference', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'remux-agent-pi-large-read-'));
  const workspace = join(root, 'workspace');
  const dataRoot = join(root, 'data');
  const source = join(workspace, 'large.txt');
  await mkdir(workspace);
  await writeFile(source, `${'large tool result line\n'.repeat(5_000)}tail\n`);
  t.after(() => rm(root, { force: true, recursive: true }));
  const scripted = createScriptedCodexProvider({
    steps: [
      {
        kind: 'tool-call',
        callId: 'call-large-read|item-large-read',
        name: 'read',
        args: { path: source },
        responseId: 'large-read-response-1',
      },
      {
        kind: 'answer',
        text: 'Large read replayed.',
        responseId: 'large-read-response-2',
      },
    ],
  });
  const modelRuntime = await ModelRuntime.create({
    allowModelNetwork: false,
    modelsPath: null,
    credentials: new InMemoryCredentialStore(),
  });
  modelRuntime.registerNativeProvider(scripted.provider);
  await modelRuntime.setRuntimeApiKey('openai-codex', 'scripted-test-credential');
  await modelRuntime.refresh({ allowNetwork: false, providers: ['openai-codex'] });
  const repository = await AgentJournalRepository.open({ dataRoot });
  const server = new AgentServer({
    engine: await PiEngine.create({ modelRuntime }),
    journal: repository,
    notify: () => {},
  });
  registerClose(t, server, repository);
  await server.initialize();
  const started = await server.handle(AGENT_METHODS.conversationCreate, {
    operationId: randomUUID(),
    cwd: workspace,
    modelId: SCRIPTED_CODEX_MODEL_ID,
    reasoning: 'high',
    contextMode: 'stateful',
  }) as { conversationId: string };
  await sendAndWait(server, started.conversationId, 'Read the large fixture.');
  assert.equal(scripted.remainingResponses(), 0);
  assert.deepEqual(scripted.requests[1]?.context.messages.map((message) => message.role), [
    'user', 'assistant', 'toolResult',
  ]);
});

test('parallel built-in tool results replay in Pi call order', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'remux-agent-pi-parallel-'));
  const workspace = join(root, 'workspace');
  const dataRoot = join(root, 'data');
  const source = join(workspace, 'large.txt');
  await mkdir(workspace);
  await writeFile(source, `${'parallel large result\n'.repeat(5_000)}tail\n`);
  t.after(() => rm(root, { force: true, recursive: true }));
  const scripted = createScriptedCodexProvider({
    steps: [
      {
        kind: 'tool-calls',
        reasoning: '**Preparing parallel tools**',
        streamedReasoning: '**Preparing parallel tools**\n\n',
        calls: [
          { callId: 'call-parallel-read|item-read', name: 'read', args: { path: source } },
          { callId: 'call-parallel-bash-a|item-bash-a', name: 'bash', args: { command: 'printf first' } },
          { callId: 'call-parallel-bash-b|item-bash-b', name: 'bash', args: { command: 'printf second' } },
        ],
        responseId: 'parallel-response-1',
      },
      {
        kind: 'answer',
        text: 'Parallel results replayed.',
        responseId: 'parallel-response-2',
      },
    ],
  });
  const modelRuntime = await ModelRuntime.create({
    allowModelNetwork: false,
    modelsPath: null,
    credentials: new InMemoryCredentialStore(),
  });
  modelRuntime.registerNativeProvider(scripted.provider);
  await modelRuntime.setRuntimeApiKey('openai-codex', 'scripted-test-credential');
  await modelRuntime.refresh({ allowNetwork: false, providers: ['openai-codex'] });
  const repository = await AgentJournalRepository.open({ dataRoot });
  const server = new AgentServer({
    engine: await PiEngine.create({ modelRuntime }),
    journal: repository,
    notify: () => {},
  });
  registerClose(t, server, repository);
  await server.initialize();
  const started = await server.handle(AGENT_METHODS.conversationCreate, {
    operationId: randomUUID(),
    cwd: workspace,
    modelId: SCRIPTED_CODEX_MODEL_ID,
    reasoning: 'high',
    contextMode: 'stateful',
  }) as { conversationId: string };
  await sendAndWait(server, started.conversationId, 'Run the parallel fixture tools.');
  assert.equal(scripted.remainingResponses(), 0);
  assert.deepEqual(scripted.requests[1]?.context.messages.map((message) => message.role), [
    'user', 'assistant', 'toolResult', 'toolResult', 'toolResult',
  ]);
});

test('provider-visible tool JSON with an unsafe integer remains durable exact text', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'remux-agent-pi-unsafe-tool-json-'));
  const workspace = join(root, 'workspace');
  const dataRoot = join(root, 'data');
  await mkdir(workspace);
  t.after(() => rm(root, { force: true, recursive: true }));
  const visible = '{"created_at_ns":9007199254740992}';
  const scripted = createScriptedCodexProvider({
    steps: [
      {
        kind: 'tool-call',
        callId: 'call-unsafe-json|item-unsafe-json',
        name: 'bash',
        args: { command: `printf '%s' '${visible}'` },
        responseId: 'unsafe-json-response-1',
      },
      {
        kind: 'answer',
        text: 'Unsafe integer output replayed.',
        responseId: 'unsafe-json-response-2',
      },
    ],
  });
  const modelRuntime = await ModelRuntime.create({
    allowModelNetwork: false,
    modelsPath: null,
    credentials: new InMemoryCredentialStore(),
  });
  modelRuntime.registerNativeProvider(scripted.provider);
  await modelRuntime.setRuntimeApiKey('openai-codex', 'scripted-test-credential');
  await modelRuntime.refresh({ allowNetwork: false, providers: ['openai-codex'] });
  const repository = await AgentJournalRepository.open({ dataRoot });
  const server = new AgentServer({
    engine: await PiEngine.create({ modelRuntime }),
    journal: repository,
    notify: () => {},
  });
  registerClose(t, server, repository);
  await server.initialize();
  const started = await server.handle(AGENT_METHODS.conversationCreate, {
    operationId: randomUUID(),
    cwd: workspace,
    modelId: SCRIPTED_CODEX_MODEL_ID,
    reasoning: 'high',
    contextMode: 'full-history',
  }) as { conversationId: string };

  await sendAndWait(server, started.conversationId, 'Print the unsafe JSON fixture.');

  assert.equal(scripted.remainingResponses(), 0);
  assert.deepEqual(scripted.requests[1]?.context.messages.map((message) => message.role), [
    'user', 'assistant', 'toolResult',
  ]);
  const compiled = await repository.compileContext(started.conversationId);
  const tool = compiled.messages.find((message) => message.role === 'tool');
  assert.equal(tool?.role === 'tool' ? tool.result : null, visible);
});

test('Pi switches through an explicit bounded work unit and restores the parent frame', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'remux-agent-pi-work-unit-'));
  const workspace = join(root, 'workspace');
  const dataRoot = join(root, 'data');
  await mkdir(workspace);
  t.after(() => rm(root, { force: true, recursive: true }));
  const scripted = createScriptedCodexProvider({
    steps: [
      {
        kind: 'tool-call',
        callId: 'call-unit-enter|item-unit-enter',
        name: 'work_unit',
        args: { action: 'enter', objective: 'Inspect one bounded implementation concern.' },
        responseId: 'unit-enter-response',
      },
      {
        kind: 'tool-call',
        callId: 'call-unit-return|item-unit-return',
        name: 'work_unit',
        args: {
          action: 'return',
          status: 'completed',
          findings: [{ text: 'The bounded concern is validated.', evidence: [] }],
          validationRefs: [],
        },
        responseId: 'unit-return-response',
      },
      { kind: 'answer', text: 'Parent integrated the bounded result.', responseId: 'unit-parent-response' },
    ],
  });
  const modelRuntime = await ModelRuntime.create({
    allowModelNetwork: false, modelsPath: null, credentials: new InMemoryCredentialStore(),
  });
  modelRuntime.registerNativeProvider(scripted.provider);
  await modelRuntime.setRuntimeApiKey('openai-codex', 'scripted-test-credential');
  await modelRuntime.refresh({ allowNetwork: false, providers: ['openai-codex'] });
  const repository = await AgentJournalRepository.open({ dataRoot });
  const server = new AgentServer({
    engine: await PiEngine.create({ modelRuntime }), journal: repository, notify: () => {},
  });
  registerClose(t, server, repository);
  await server.initialize();
  const started = await server.handle(AGENT_METHODS.conversationCreate, {
    operationId: randomUUID(), cwd: workspace, modelId: SCRIPTED_CODEX_MODEL_ID,
    reasoning: 'high', contextMode: 'stateful', workUnits: true,
  }) as { conversationId: string };
  await sendAndWait(server, started.conversationId, 'Use one bounded work unit, then integrate it.');
  assert.deepEqual(scripted.requests.map(requestMode), ['full', 'full', 'full']);
  assert.match(
    JSON.stringify(scripted.requests[2]?.context.messages),
    /Integrate the completed child result/u,
  );
  assert.match(
    JSON.stringify(scripted.requests[2]?.context.messages),
    /journal:\/\/artifact\/[0-9a-f]{64}/u,
  );
  const database = new DatabaseSync(repository.databasePath, { readOnly: true });
  const scope = database.prepare(`
    SELECT state, result_artifact_hash FROM execution_scopes WHERE kind = 'work_unit'
  `).get() as { state: string; result_artifact_hash: string | null };
  database.close();
  assert.equal(scope.state, 'completed');
  assert.match(scope.result_artifact_hash ?? '', /^[0-9a-f]{64}$/u);
  const transcript = await repository.readTranscriptActions(started.conversationId);
  assert.match(JSON.stringify(transcript), /Parent integrated the bounded result/u);
});

test('terminal child text becomes an implicit result and only the parent answer is visible', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'remux-agent-pi-work-unit-implicit-'));
  const workspace = join(root, 'workspace');
  const dataRoot = join(root, 'data');
  await mkdir(workspace);
  t.after(() => rm(root, { force: true, recursive: true }));
  const scripted = createScriptedCodexProvider({
    steps: [
      {
        kind: 'tool-call',
        callId: 'call-implicit-enter|item-implicit-enter',
        name: 'work_unit',
        args: { action: 'enter', objective: 'Produce a provisional child finding.' },
        responseId: 'implicit-enter-response',
      },
      { kind: 'answer', text: 'CHILD_PROVISIONAL_ONLY', responseId: 'implicit-child-response' },
      { kind: 'answer', text: 'PARENT_TERMINAL_ONLY', responseId: 'implicit-parent-response' },
    ],
  });
  const modelRuntime = await ModelRuntime.create({
    allowModelNetwork: false, modelsPath: null, credentials: new InMemoryCredentialStore(),
  });
  modelRuntime.registerNativeProvider(scripted.provider);
  await modelRuntime.setRuntimeApiKey('openai-codex', 'scripted-test-credential');
  await modelRuntime.refresh({ allowNetwork: false, providers: ['openai-codex'] });
  const repository = await AgentJournalRepository.open({ dataRoot });
  const server = new AgentServer({
    engine: await PiEngine.create({ modelRuntime }), journal: repository, notify: () => {},
  });
  registerClose(t, server, repository);
  await server.initialize();
  const started = await server.handle(AGENT_METHODS.conversationCreate, {
    operationId: randomUUID(), cwd: workspace, modelId: SCRIPTED_CODEX_MODEL_ID,
    reasoning: 'high', contextMode: 'stateful', workUnits: true,
  }) as { conversationId: string };
  await sendAndWait(server, started.conversationId, 'Allow safe implicit child return.');
  assert.deepEqual(scripted.requests.map(requestMode), ['full', 'full', 'full']);
  const transcript = JSON.stringify(await repository.readTranscriptActions(started.conversationId));
  assert.doesNotMatch(transcript, /CHILD_PROVISIONAL_ONLY/u);
  assert.match(transcript, /PARENT_TERMINAL_ONLY/u);
  const events = await repository.readEvents({ conversationId: started.conversationId });
  assert.equal(events.some(({ type }) => type === 'work_unit.returned'), true);
  assert.equal(events.some(({ type }) => type === 'message.internal'), true);
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
