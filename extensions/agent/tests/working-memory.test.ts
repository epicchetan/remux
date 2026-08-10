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
import { compileShadowContext } from '../server/src/context/compiler.ts';
import {
  applyWorkingMemoryPatch,
  parseWorkingMemoryPatchText,
  type WorkingMemoryCompileInput,
} from '../server/src/context/working-memory.ts';
import { PiEngine } from '../server/src/pi-runtime.ts';
import { AgentJournalRepository } from '../server/src/storage/repository.ts';
import {
  createScriptedCodexProvider,
  SCRIPTED_CODEX_MODEL_ID,
  type ScriptedCodexRequest,
} from './helpers/scripted-codex-provider.ts';

test('working-memory patches are bounded, evidence-closed, and deterministically applied', () => {
  const input: WorkingMemoryCompileInput = {
    conversationId: 'conversation',
    strandId: 'strand',
    projectId: 'project',
    baseSnapshot: null,
    coveredThroughSequence: 42,
    delta: [],
    deltaOmittedBytes: 0,
    protectedState: [],
    allowedRefs: ['journal://turn/one'],
  };
  const patch = parseWorkingMemoryPatchText(JSON.stringify({
    orientation: 'Implementing the accepted feed contract.',
    upsert: [{
      key: 'feed-contract',
      scope: 'thread',
      body: 'Restart the outer loop after a completed regression.',
      refs: ['journal://turn/one'],
    }],
    remove: [],
  }), input.allowedRefs);
  const snapshot = applyWorkingMemoryPatch(input, patch, {
    modelId: 'gpt-5.6-sol', durationMs: 12, inputTokens: 100, outputTokens: 20, cacheReadTokens: 40,
  });
  assert.equal(snapshot.coveredThroughSequence, 42);
  assert.deepEqual(snapshot.entries.map(({ key }) => key), ['feed-contract']);
  assert.throws(() => parseWorkingMemoryPatchText(JSON.stringify({
    orientation: '',
    upsert: [{ key: 'invented', scope: 'thread', body: 'bad', refs: ['journal://turn/invented'] }],
    remove: [],
  }), input.allowedRefs), /unknown reference/u);
  assert.throws(() => parseWorkingMemoryPatchText(JSON.stringify({
    orientation: '', upsert: [], remove: [], extra: true,
  }), input.allowedRefs), /exactly orientation/u);
});

test('journal snapshots commit with CAS and trim covered turns from a new frame', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'remux-working-memory-journal-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = await AgentJournalRepository.open({ dataRoot: join(root, 'data') });
  t.after(() => repository.close());
  const conversation = await repository.createConversation({
    operationId: randomUUID(), cwd: workspace, modelId: 'gpt-5.6-sol', reasoning: 'high',
    contextMode: 'working-memory',
  });
  const first = await repository.acceptTurn({
    operationId: randomUUID(), conversationId: conversation.conversationId,
    clientMessageId: randomUUID(), text: 'Remember the regression constraint.',
  });
  await repository.appendAssistantCheckpoint(first, {
    textDelta: 'The outer loop must restart after regression.', reasoningDelta: '',
  });
  await repository.finishTurn(first, { status: 'completed' });
  const firstCompile = await repository.prepareWorkingMemory(conversation.conversationId);
  assert.ok(firstCompile);
  assert.equal(firstCompile.delta.some(({ value }) => JSON.stringify(value).includes('outer loop')), true);
  const firstCommit = await repository.commitWorkingMemory({
    compile: firstCompile,
    patch: {
      orientation: 'The regression contract is established.',
      upsert: [{
        key: 'regression-contract', scope: 'thread',
        body: 'Restart the outer loop after regression.', refs: [firstCompile.allowedRefs[0]!],
      }],
      remove: [],
    },
    compiler: { modelId: 'gpt-5.6-sol', durationMs: 10, inputTokens: 80, outputTokens: 10, cacheReadTokens: 0 },
  });
  assert.equal(firstCommit.state, 'committed');
  assert.equal(await repository.prepareWorkingMemory(conversation.conversationId), null);

  const second = await repository.acceptTurn({
    operationId: randomUUID(), conversationId: conversation.conversationId,
    clientMessageId: randomUUID(), text: 'Now implement it.',
  });
  const context = await repository.compileContext(conversation.conversationId);
  assert.equal(context.shadowSource.workingMemory?.sequence, firstCommit.sequence);
  assert.deepEqual([...new Set(context.shadowSource.messages.map(({ turnId }) => turnId))], [second.turnId]);
  const candidate = compileShadowContext(context.shadowSource, {
    modelId: 'gpt-5.6-sol', contextWindow: 400_000,
    fixedContractsHash: 'working-memory-test', activeEstimatedInputTokens: 0,
  });
  assert.equal(candidate.blocks.some(({ kind }) => kind === 'working_memory'), true);
  assert.match(candidate.bootstrap, /Restart the outer loop/u);
  await repository.appendAssistantCheckpoint(second, { textDelta: 'Implemented.', reasoningDelta: '' });
  await repository.finishTurn(second, { status: 'completed' });

  const secondCompile = await repository.prepareWorkingMemory(conversation.conversationId);
  assert.ok(secondCompile);
  assert.equal(secondCompile.allowedRefs.includes(firstCompile.allowedRefs[0]!), true);
  const update = {
    compile: secondCompile,
    patch: { orientation: 'Implementation completed.', upsert: [], remove: ['regression-contract'] },
    compiler: { modelId: 'gpt-5.6-sol', durationMs: 11, inputTokens: 70, outputTokens: 8, cacheReadTokens: 0 },
  };
  assert.equal((await repository.commitWorkingMemory(update)).state, 'committed');
  assert.equal((await repository.commitWorkingMemory(update)).state, 'stale');
  const events = await repository.readEvents({ conversationId: conversation.conversationId });
  assert.equal(events.filter(({ type }) => type === 'memory.snapshot.committed').length, 2);
  assert.equal(events.filter(({ type }) => type === 'memory.compilation.stale').length, 1);
});

test('background compilation coalesces immediate turns without blocking or rewriting the active frame', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'remux-working-memory-runtime-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  await writeFile(join(workspace, 'governing.md'), 'Exact governing contract.\n');
  t.after(() => rm(root, { recursive: true, force: true }));
  const scripted = createScriptedCodexProvider({
    steps: [
      {
        kind: 'tool-call',
        callId: 'memory-call-1',
        name: 'memory',
        args: {
          remember: [{ key: 'active-contract', value: { state: 'accepted' } }],
          hold: [{ resource: 'governing.md', label: 'Governing contract' }],
        },
        responseId: 'wm-response-0',
      },
      { kind: 'answer', text: 'First response.', responseId: 'wm-response-1' },
      { kind: 'answer', text: 'Second response.', responseId: 'wm-response-2' },
    ],
  });
  const modelRuntime = await ModelRuntime.create({
    allowModelNetwork: false, modelsPath: null, credentials: new InMemoryCredentialStore(),
  });
  modelRuntime.registerNativeProvider(scripted.provider);
  await modelRuntime.setRuntimeApiKey('openai-codex', 'scripted-test-credential');
  await modelRuntime.refresh({ allowNetwork: false, providers: ['openai-codex'] });

  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const compilerInputs: WorkingMemoryCompileInput[] = [];
  const engine = await PiEngine.create({
    modelRuntime,
    workingMemoryModelId: SCRIPTED_CODEX_MODEL_ID,
    async workingMemoryCompiler(input) {
      compilerInputs.push(input);
      if (compilerInputs.length === 1) await firstGate;
      return {
        compile: input,
        patch: {
          orientation: `Compiled through ${input.coveredThroughSequence}.`,
          upsert: [],
          remove: [],
        },
        compiler: {
          modelId: SCRIPTED_CODEX_MODEL_ID, durationMs: 1,
          inputTokens: 10, outputTokens: 2, cacheReadTokens: 0,
        },
      };
    },
  });
  const repository = await AgentJournalRepository.open({ dataRoot: join(root, 'data') });
  const server = new AgentServer({ engine, journal: repository, notify: () => {} });
  registerClose(t, server, repository);
  await server.initialize();
  const created = await server.handle(AGENT_METHODS.conversationCreate, {
    operationId: randomUUID(), cwd: workspace, modelId: SCRIPTED_CODEX_MODEL_ID,
    reasoning: 'high', contextMode: 'working-memory', workUnits: false,
  }) as { conversationId: string };

  await sendAndWait(server, created.conversationId, 'First turn.');
  await waitFor(() => compilerInputs.length === 1);
  await sendAndWait(server, created.conversationId, 'Immediate follow-up.');
  assert.equal(compilerInputs.length, 1);
  releaseFirst();
  await waitFor(async () => (await repository.readLatestWorkingMemory(created.conversationId))?.snapshot.orientation
    === `Compiled through ${compilerInputs.at(-1)?.coveredThroughSequence}.` && compilerInputs.length === 2);

  assert.deepEqual(scripted.requests.map(requestMode), [
    'full',
    'continuation:wm-response-0',
    'continuation:wm-response-1',
  ]);
  assert.equal(compilerInputs.length, 2);
  assert.match(JSON.stringify(compilerInputs[0]?.protectedState), /active-contract/u);
  assert.match(JSON.stringify(compilerInputs[0]?.protectedState), /governing\.md/u);
  const memoryResult = (await repository.readEvents({ conversationId: created.conversationId }))
    .find(({ type, payload }) => type === 'tool.completed' && JSON.stringify(payload).includes('memory-call-1'));
  assert.equal(memoryResult?.payload && typeof memoryResult.payload === 'object' &&
    !Array.isArray(memoryResult.payload) && memoryResult.payload.isError, false);
  const terminalSequences = (await repository.readEvents({ conversationId: created.conversationId }))
    .filter(({ type }) => type === 'turn.terminal').map(({ sequence }) => sequence);
  const latest = await repository.readLatestWorkingMemory(created.conversationId);
  assert.equal(latest?.snapshot.coveredThroughSequence, terminalSequences.at(-1));
});

function requestMode(request: ScriptedCodexRequest) {
  const payload = request.payload && typeof request.payload === 'object' && !Array.isArray(request.payload)
    ? request.payload as { previous_response_id?: unknown }
    : {};
  return typeof payload.previous_response_id === 'string'
    ? `continuation:${payload.previous_response_id}`
    : 'full';
}

async function sendAndWait(server: AgentServer, conversationId: string, text: string) {
  await server.handle(AGENT_METHODS.messageSend, {
    operationId: randomUUID(), conversationId, clientMessageId: randomUUID(), text,
  });
  await waitFor(async () => {
    const read = await server.handle(AGENT_METHODS.resourcesRead, {
      requests: [{ key: AGENT_RESOURCE_KEYS.runtime }],
    }) as ResourceReadResult;
    const resource = read.resources[0];
    if (resource?.status !== 'ok') return false;
    const runtime = resource.value as AgentRuntimeValue;
    if (runtime.conversationId !== conversationId) return false;
    if (runtime.state === 'error') throw new Error(runtime.error ?? 'Agent runtime failed.');
    return runtime.state === 'idle';
  });
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for working-memory test condition.');
}

function registerClose(t: TestContext, server: AgentServer, repository: AgentJournalRepository) {
  t.after(async () => {
    await server.close();
    await repository.close();
  });
}
