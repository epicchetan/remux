import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentServer } from '../../server/src/agent-server.ts';
import { PiEngine } from '../../server/src/pi-runtime.ts';
import { AgentStateStore } from '../../server/src/storage/agent-state-store.ts';

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
const engine = await PiEngine.create({
  providerWebSocketFaultAfterEvents() {
    if (injectedDrops > 0) return undefined;
    injectedDrops += 1;
    return 1;
  },
});
const repository = await AgentStateStore.open({ dataRoot });
const server = new AgentServer({ engine, store: repository, notify() {} });

try {
  await server.initialize();
  const auth = await engine.authStatus();
  assert.equal(auth.state, 'signed-in', 'The real-provider smoke requires an existing Codex sign-in.');
  const models = await engine.listModels();
  const model = models.find(({ id }) => id === MODEL_ID);
  assert.ok(model, `The real-provider smoke model is unavailable: ${MODEL_ID}`);
  assert.ok(model.supportedReasoning.includes('high'));

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
    'Verify that the recovered provider lane remains reusable.',
    'Do not call tools.',
    `Reply with exactly ${SECOND_SENTINEL} and nothing else.`,
  ].join(' '));
  assert.equal(await assistantText(repository, created.conversationId, second.turnId), SECOND_SENTINEL);

  const finalEvents = await repository.readEvents({ conversationId: created.conversationId });
  const finalTransports = finalEvents.filter(({ type }) => type === 'inference.transport');
  assert.equal(finalTransports.length, 3);
  const continuedTransport = objectPayload(finalTransports[2]?.payload);
  assert.equal(continuedTransport.actualRequestMode, 'full');
  assert.equal(continuedTransport.carrier, 'websocket');
  assert.equal(continuedTransport.connectionsReused, 1);
  assert.equal(continuedTransport.connectionsCreated, 0);
  assert.equal(continuedTransport.websocketFailures, 0);
  assert.equal(continuedTransport.sseFallbacks, 0);

  const third = await sendAndWait(server, created.conversationId, [
    'Exercise one focused work unit for the provider-lane smoke.',
    'Call work_unit_start with objective "Verify child provider isolation."',
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
    sentinels: [FIRST_SENTINEL, SECOND_SENTINEL, THIRD_SENTINEL],
  }, null, 2)}\n`);
} finally {
  await server.close();
  await repository.close();
  await rm(dataRoot, { recursive: true, force: true });
}

async function sendAndWait(
  runtime: AgentServer,
  conversationId: string,
  text: string,
) {
  const accepted = await runtime.handle('remux/agent/conversation/message/send', {
    operationId: randomUUID(),
    conversationId,
    clientMessageId: randomUUID(),
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
