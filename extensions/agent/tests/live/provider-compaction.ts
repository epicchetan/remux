import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentServer } from '../../server/src/agent-server.ts';
import { OpenAICodexProvider } from '../../server/src/providers/openai-codex/openai-codex-provider.ts';
import { AgentStateStore } from '../../server/src/storage/agent-state-store.ts';

const MODEL_ID = process.env.REMUX_AGENT_SMOKE_MODEL ?? 'gpt-5.6-sol';
const TIMEOUT_MS = Number(process.env.REMUX_AGENT_SMOKE_TIMEOUT_MS ?? 180_000);
const SENTINEL = 'REMUX_PROVIDER_COMPACTION_OK';
const TOOL_MARKER = 'REMUX_COMPACTION_TOOL_OK';

const dataRoot = await mkdtemp(join(tmpdir(), 'remux-agent-provider-compaction-'));
const cwd = join(dataRoot, 'workspace');
await mkdir(cwd, { recursive: true });
await writeFile(join(cwd, 'README.md'), '# Provider compaction smoke\n');

const provider = await OpenAICodexProvider.create({
  // Force the production policy path on a tiny request. The provider call,
  // durable checkpoint, fresh lane, and post-tool continuation remain real.
  compactionPolicy: {
    warningTokens: 1,
    targetTokens: 2,
    emergencyTokens: 100,
    retainedMessageTokens: 64,
  },
});
const repository = await AgentStateStore.open({ dataRoot });
const server = new AgentServer({ provider, store: repository, notify() {} });
let activeConversationId: string | null = null;

try {
  await server.initialize();
  const auth = await provider.authStatus();
  assert.equal(auth.state, 'signed-in', 'The compaction smoke requires an existing Codex sign-in.');
  const model = (await provider.listModels()).find(({ id }) => id === MODEL_ID);
  assert.ok(model, `The compaction smoke model is unavailable: ${MODEL_ID}`);

  const created = await server.handle('remux/agent/conversation/create', {
    operationId: randomUUID(), cwd, modelId: MODEL_ID, reasoning: 'high',
  }) as { conversationId: string };
  activeConversationId = created.conversationId;
  const accepted = await sendAndWait(server, created.conversationId, [
    'Exercise the real provider checkpoint and its continuation.',
    `Call bash once with command "printf ${TOOL_MARKER}".`,
    `After observing the output, reply with exactly ${SENTINEL} and nothing else.`,
  ].join(' '));
  assert.equal(await assistantText(repository, created.conversationId, accepted.turnId), SENTINEL);

  const events = await repository.readEvents({ conversationId: created.conversationId });
  const installed = events.filter(({ type }) => type === 'context.compaction.installed');
  const starts = events.filter(({ type }) => type === 'inference.started');
  const tools = events.filter(({ type }) => type === 'tool.completed');
  const toolCalls = events.filter(({ type }) => type === 'tool.called');
  assert.ok(installed.length >= 2, 'The forced policy should checkpoint both real inference cycles.');
  assert.ok(starts.length >= 2, 'The real turn must continue through a tool after the checkpoint.');
  assert.equal(installed.length, starts.length);
  assert.ok(installed[0]!.sequence < starts[0]!.sequence);
  assert.ok(toolCalls.some(({ payload }) => JSON.stringify(payload).includes('bash')));
  const payload = objectPayload(installed[0]!.payload);
  assert.equal(payload.trigger, 'automatic');
  assert.equal(payload.epoch, 1);
  assert.equal(typeof payload.inputHash, 'string');
  assert.deepEqual(
    installed.map(({ payload: value }) => objectPayload(value).epoch),
    installed.map((_event, index) => index + 1),
  );

  process.stdout.write(`${JSON.stringify({
    ok: true,
    modelId: MODEL_ID,
    conversationId: created.conversationId,
    checkpointSequences: installed.map(({ sequence }) => sequence),
    providerInferences: starts.length,
    toolCompletions: tools.length,
    sentinel: SENTINEL,
  }, null, 2)}\n`);
} catch (error) {
  if (activeConversationId) {
    const events = await repository.readEvents({ conversationId: activeConversationId });
    process.stderr.write(`${JSON.stringify({
      eventTypes: events.map(({ sequence, type }) => ({ sequence, type })),
    }, null, 2)}\n`);
  }
  throw error;
} finally {
  await server.close();
  await repository.close();
  await rm(dataRoot, { recursive: true, force: true });
}

async function sendAndWait(runtime: AgentServer, conversationId: string, text: string) {
  const accepted = await runtime.handle('remux/agent/conversation/message/send', {
    operationId: randomUUID(),
    conversationId,
    clientMessageId: randomUUID(),
    contextPlan: { version: 1, automaticDialogueTurns: 2, overrides: [] },
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
      throw new Error(state.error ?? 'The real-provider compaction smoke failed without a diagnostic.');
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for real-provider compaction turn ${accepted.turnId}.`);
}

async function assistantText(store: AgentStateStore, conversationId: string, turnId: string) {
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
