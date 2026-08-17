import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentServer } from '../../server/src/agent-server.ts';
import { OpenAICodexProvider } from '../../server/src/providers/openai-codex/openai-codex-provider.ts';
import { AgentStateStore } from '../../server/src/storage/agent-state-store.ts';
import {
  AGENT_TRANSCRIPT_PROJECTION_VERSION,
  AGENT_TRANSCRIPT_PROTOCOL_VERSION,
  type AgentExecutionScopeResource,
  type AgentOperationDetailResource,
  type AgentTurnRenderFrame,
  type AgentWorkRenderSegment,
} from '../../shared/transcript.ts';

const FIRST_SENTINEL = 'REMUX_REAL_PROVIDER_RECOVERY_OK';
const SECOND_SENTINEL = 'REMUX_REAL_PROVIDER_REUSE_OK';
const CHILD_MARKER = 'REMUX_REAL_PROVIDER_CHILD_OK';
const THIRD_SENTINEL = 'REMUX_REAL_PROVIDER_PARENT_RESUME_OK';
const MODEL_ID = process.env.REMUX_AGENT_SMOKE_MODEL ?? 'gpt-5.6-sol';
const TIMEOUT_MS = Number(process.env.REMUX_AGENT_SMOKE_TIMEOUT_MS ?? 180_000);

const dataRoot = await mkdtemp(join(tmpdir(), 'remux-agent-provider-recovery-'));
const cwd = join(dataRoot, 'workspace');
await mkdir(cwd, { recursive: true });
await writeFile(join(cwd, 'README.md'), '# Real provider recovery smoke\n');

let injectedDrops = 0;
const provider = await OpenAICodexProvider.create({
  providerWebSocketFaultAfterEvents() {
    if (injectedDrops > 0) return undefined;
    injectedDrops += 1;
    return 1;
  },
});
const repository = await AgentStateStore.open({ dataRoot });
const server = new AgentServer({ provider, store: repository, notify() {} });

try {
  await server.initialize();
  const auth = await provider.authStatus();
  assert.equal(auth.state, 'signed-in', 'The real-provider smoke requires an existing Codex sign-in.');
  const models = await provider.listModels();
  const model = models.find(({ id }) => id === MODEL_ID);
  assert.ok(model, `The real-provider smoke model is unavailable: ${MODEL_ID}`);
  assert.ok(model.supportedReasoning.includes('high'));
  assert.ok(model.supportedReasoning.includes('medium'));

  const created = await server.handle('remux/agent/conversation/create', {
    operationId: randomUUID(),
    cwd,
    modelId: MODEL_ID,
    reasoning: 'high',
  }) as { conversationId: string };

  const first = await sendAndWait(server, created.conversationId, [
    'This is a deterministic transport recovery smoke test.',
    'Do not call tools.',
    `Reply with exactly ${FIRST_SENTINEL} and nothing else.`,
  ].join(' '));
  assert.equal(await assistantText(repository, created.conversationId, first.turnId), FIRST_SENTINEL);

  const firstEvents = await repository.readEvents({ conversationId: created.conversationId });
  const firstStarts = firstEvents.filter(({ type }) => type === 'inference.started');
  const firstTransports = firstEvents.filter(({ type }) => type === 'inference.transport');
  assert.equal(injectedDrops, 1);
  assert.equal(firstStarts.length, 2, 'The injected response-started failure should produce one durable retry.');
  assert.equal(firstEvents.filter(({ type }) => type === 'inference.failed').length, 1);
  assert.equal(firstEvents.filter(({ type }) => type === 'inference.superseded').length, 1);
  assert.equal(firstEvents.filter(({ type }) => type === 'inference.completed').length, 1);
  assert.equal(firstTransports.length, 2);
  const failedTransport = objectPayload(firstTransports[0]?.payload);
  assert.equal(failedTransport.carrier, 'websocket');
  assert.equal(failedTransport.websocketFailures, 1);
  assert.equal(failedTransport.connectionsCreated, 1);
  const retryStart = objectPayload(firstStarts[1]?.payload);
  assert.equal(retryStart.requestMode, 'full');
  assert.equal(typeof retryStart.retryOfInferenceId, 'string');
  const retryTransport = objectPayload(firstTransports[1]?.payload);
  assert.equal(retryTransport.carrier, 'websocket');
  assert.equal(retryTransport.connectionsCreated, 1);
  assert.equal(retryTransport.websocketFailures, 0);

  const second = await sendAndWait(server, created.conversationId, [
    'Verify that a fresh turn remains usable after provider recovery.',
    'Do not call tools.',
    `Reply with exactly ${SECOND_SENTINEL} and nothing else.`,
  ].join(' '), 'medium');
  assert.equal(await assistantText(repository, created.conversationId, second.turnId), SECOND_SENTINEL);
  assert.equal((await repository.readTurn(created.conversationId, second.turnId)).reasoning, 'medium');

  const finalEvents = await repository.readEvents({ conversationId: created.conversationId });
  const finalTransports = finalEvents.filter(({ type }) => type === 'inference.transport');
  assert.equal(finalTransports.length, 3);
  const continuedTransport = objectPayload(finalTransports[2]?.payload);
  assert.equal(continuedTransport.actualRequestMode, 'full');
  assert.equal(continuedTransport.carrier, 'websocket');
  assert.equal(continuedTransport.connectionsReused, 0);
  assert.equal(continuedTransport.connectionsCreated, 1);
  assert.equal(continuedTransport.websocketFailures, 0);
  assert.equal(continuedTransport.sseFallbacks, 0);

  const third = await sendAndWait(server, created.conversationId, [
    'Exercise one focused work unit for the provider-lane smoke.',
    'Call work_unit_start with boundary "Verify provider isolation and close after the marker is observed."',
    `Inside the work unit call bash with command "printf ${CHILD_MARKER}".`,
    `Then call work_unit_finish with status completed and a concise result containing ${CHILD_MARKER}.`,
    `After the parent resumes, reply with exactly ${THIRD_SENTINEL} and nothing else.`,
  ].join(' '));
  assert.equal(await assistantText(repository, created.conversationId, third.turnId), THIRD_SENTINEL);

  const workUnitEvents = await repository.readEvents({ conversationId: created.conversationId });
  const entered = workUnitEvents.find(({ type, turnId }) =>
    type === 'work_unit.entered' && turnId === third.turnId);
  assert.ok(entered);
  const returned = workUnitEvents.find(({ type, scopeId }) =>
    type === 'work_unit.returned' && scopeId === entered.scopeId);
  assert.ok(returned);
  const childTransports = workUnitEvents.filter(({ type, scopeId }) =>
    type === 'inference.transport' && scopeId === entered.scopeId);
  assert.ok(childTransports.length >= 2);
  const childFirst = objectPayload(childTransports[0]?.payload);
  assert.equal(childFirst.actualRequestMode, 'full');
  assert.equal(childFirst.carrier, 'websocket');
  assert.equal(childFirst.connectionsCreated, 1);
  assert.ok(childTransports.slice(1).some(({ payload }) =>
    objectPayload(payload).connectionsReused === 1));
  const resumedParent = workUnitEvents.find(({ type, turnId, sequence }) =>
    type === 'inference.transport' && turnId === third.turnId && sequence > returned.sequence);
  assert.ok(resumedParent);
  const resumedParentTransport = objectPayload(resumedParent.payload);
  assert.equal(resumedParentTransport.carrier, 'websocket');
  assert.equal(resumedParentTransport.connectionsReused, 1);
  assert.equal(resumedParentTransport.connectionsCreated, 0);

  const trace = await readSemanticTrace(server, created.conversationId, third.turnId);
  const workUnitStart = trace.root.inferences
    .flatMap((inference) => inference.actionGroup?.calls ?? [])
    .find(({ name }) => name === 'work_unit_start');
  assert.ok(workUnitStart, 'The parent semantic trace is missing work_unit_start.');
  assert.equal(workUnitStart.childScopeId, entered.scopeId);
  assert.ok(
    [...trace.root.inferences, ...trace.child.inferences]
      .some((inference) => Boolean(inference.reasoning?.text.trim())),
    'The real provider returned no visible reasoning summary in the semantic trace.',
  );
  const childCalls = trace.child.inferences
    .flatMap((inference) => inference.actionGroup?.calls ?? [])
    .map(({ name }) => name);
  assert.ok(childCalls.includes('bash'));
  assert.ok(childCalls.includes('work_unit_finish'));
  const workUnitStartDetail = await readOperationDetail(
    server,
    created.conversationId,
    third.turnId,
    trace.root.scopeId,
    workUnitStart.id,
  );
  assert.match(workUnitStartDetail.detail ?? '', /Verify provider isolation/u);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    modelId: MODEL_ID,
    conversationId: created.conversationId,
    injectedDrops,
    inferenceStates: {
      failed: workUnitEvents.filter(({ type }) => type === 'inference.failed').length,
      superseded: workUnitEvents.filter(({ type }) => type === 'inference.superseded').length,
      completed: workUnitEvents.filter(({ type }) => type === 'inference.completed').length,
    },
    transports: workUnitEvents
      .filter(({ type }) => type === 'inference.transport')
      .map(({ scopeId, payload }) => ({
        scopeId,
        ...objectPayload(payload),
      })),
    workUnit: {
      scopeId: entered.scopeId,
      providerCalls: childTransports.length,
      parentResumedAfterSequence: returned.sequence,
    },
    semanticTrace: {
      childCalls,
      childInferences: trace.child.inferences.length,
      reasoningSummaries: [...trace.root.inferences, ...trace.child.inferences]
        .filter((inference) => Boolean(inference.reasoning?.text.trim())).length,
      commentaryUpdates: [...trace.root.inferences, ...trace.child.inferences]
        .filter((inference) => Boolean(inference.commentary?.text.trim())).length,
      rootInferences: trace.root.inferences.length,
    },
    sentinels: [FIRST_SENTINEL, SECOND_SENTINEL, THIRD_SENTINEL],
  }, null, 2)}\n`);
} finally {
  await server.close();
  await repository.close();
  await rm(dataRoot, { recursive: true, force: true });
}

async function readSemanticTrace(
  runtime: AgentServer,
  conversationId: string,
  turnId: string,
) {
  const sync = await runtime.handle('remux/agent/transcript/resources/read', {
    conversationId,
    requests: [{
      type: 'transcriptSync',
      protocolVersion: AGENT_TRANSCRIPT_PROTOCOL_VERSION,
      projectionVersion: AGENT_TRANSCRIPT_PROJECTION_VERSION,
      window: { kind: 'around', turnId, before: 0, after: 0 },
    }],
  }) as { resources: Array<{ status: string; value?: { turns: unknown[] } }> };
  const syncEntry = sync.resources[0];
  assert.equal(syncEntry?.status, 'ok');
  const turn = syncEntry?.value?.turns[0] as {
    status: string;
    frame?: AgentTurnRenderFrame;
  } | undefined;
  assert.equal(turn?.status, 'ok');
  const work = turn?.frame?.segments.find((segment): segment is AgentWorkRenderSegment =>
    segment.type === 'work');
  assert.ok(work, 'The live turn is missing its root Work segment.');
  const root = await readExecutionScope(runtime, conversationId, turnId, work.scopeId);
  const childCall = root.inferences
    .flatMap((inference) => inference.actionGroup?.calls ?? [])
    .find(({ childScopeId }) => childScopeId !== null);
  assert.ok(childCall?.childScopeId, 'The parent trace is missing its linked child scope.');
  const child = await readExecutionScope(runtime, conversationId, turnId, childCall.childScopeId);
  return { child, root };
}

async function readExecutionScope(
  runtime: AgentServer,
  conversationId: string,
  turnId: string,
  scopeId: string,
) {
  const response = await runtime.handle('remux/agent/transcript/resources/read', {
    conversationId,
    requests: [{
      type: 'executionScope',
      protocolVersion: AGENT_TRANSCRIPT_PROTOCOL_VERSION,
      turnId,
      scopeId,
    }],
  }) as { resources: Array<{ status: string; value?: AgentExecutionScopeResource }> };
  assert.equal(response.resources[0]?.status, 'ok');
  assert.ok(response.resources[0]?.value);
  return response.resources[0].value;
}

async function readOperationDetail(
  runtime: AgentServer,
  conversationId: string,
  turnId: string,
  scopeId: string,
  operationId: string,
) {
  const response = await runtime.handle('remux/agent/transcript/resources/read', {
    conversationId,
    requests: [{
      type: 'operationDetail',
      protocolVersion: AGENT_TRANSCRIPT_PROTOCOL_VERSION,
      turnId,
      scopeId,
      operationId,
    }],
  }) as { resources: Array<{ status: string; value?: AgentOperationDetailResource }> };
  assert.equal(response.resources[0]?.status, 'ok');
  assert.ok(response.resources[0]?.value);
  return response.resources[0].value;
}

async function sendAndWait(
  runtime: AgentServer,
  conversationId: string,
  text: string,
  reasoning: 'high' | 'medium' = 'high',
) {
  const accepted = await runtime.handle('remux/agent/conversation/message/send', {
    operationId: randomUUID(),
    conversationId,
    clientMessageId: randomUUID(),
    modelId: MODEL_ID,
    contextPlan: {
      version: 1,
      automaticDialogueTurns: 2,
      overrides: [],
    },
    reasoning,
    text,
  }) as { turnId: string };
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const response = await runtime.handle('remux/agent/resources/read', {
      requests: [{ key: 'runtime' }],
    }) as { resources: Array<{ value?: { conversationId?: string; state?: string; error?: string | null } }> };
    const state = response.resources[0]?.value;
    if (state?.conversationId === conversationId && state.state === 'idle') return accepted;
    if (state?.conversationId === conversationId && state.state === 'error') {
      throw new Error(state.error ?? 'The real-provider smoke failed without a diagnostic.');
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for real-provider turn ${accepted.turnId}.`);
}

async function assistantText(
  store: AgentStateStore,
  conversationId: string,
  turnId: string,
) {
  const actions = await store.readTranscriptActions(conversationId);
  return actions
    .flatMap((action) =>
      action.type === 'assistant' && action.turnId === turnId ? [action.textDelta] : [])
    .join('')
    .trim();
}

function objectPayload(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}
