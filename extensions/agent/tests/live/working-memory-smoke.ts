import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

import {
  AGENT_METHODS,
  AGENT_RESOURCE_KEYS,
  type AgentRuntimeValue,
  type ResourceReadResult,
} from '../../shared/protocol.ts';
import { AgentServer } from '../../server/src/agent-server.ts';
import { PiEngine } from '../../server/src/pi-runtime.ts';
import { AgentJournalRepository } from '../../server/src/storage/repository.ts';

const execFileAsync = promisify(execFile);
const DECISION_CODE = 'ORCHID-73';
const FIRST_MARKER = 'WM_BACKGROUND_READY';
const RESTART_MARKER = 'WM_RESTART_OK';

type Runtime = { repository: AgentJournalRepository; server: AgentServer };

const options = parseOptions(process.argv.slice(2));

void run().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

async function run() {
  const root = await mkdtemp(join(tmpdir(), 'remux-agent-working-memory-smoke-'));
  const dataRoot = join(root, 'data');
  const beforeStatus = await gitStatus(options.workspace);
  const startedAt = Date.now();
  let runtime: Runtime | null = null;
  let conversationId = '';
  try {
    runtime = await openRuntime(dataRoot);
    const readiness = await readReadiness(runtime.server);
    assert.equal(readiness.authState, 'signed-in', 'The real Agent provider must already be signed in.');
    assert.ok(readiness.models.includes(options.modelId), `${options.modelId} is not available.`);
    const created = await runtime.server.handle(AGENT_METHODS.conversationCreate, {
      operationId: randomUUID(), cwd: options.workspace, modelId: options.modelId,
      reasoning: options.reasoning, contextMode: 'working-memory', workUnits: false,
    }) as { conversationId: string };
    conversationId = created.conversationId;
    const first = await sendAndWait(runtime, conversationId, [
      'This is a read-only working-memory smoke. Do not call tools or change files.',
      `For this conversation, the opaque decision code is ${DECISION_CODE}; releases happen only after validation.`,
      `Acknowledge both facts concisely and end with ${FIRST_MARKER}.`,
    ].join(' '));
    assert.match(await assistantText(runtime.repository, first.turnId), new RegExp(`${FIRST_MARKER}\\s*$`));

    const firstSnapshot = await waitForSnapshot(runtime.repository, conversationId, 1, options.timeoutMs);
    const firstMemoryText = JSON.stringify(firstSnapshot.snapshot);
    assert.match(firstMemoryText, new RegExp(DECISION_CODE));
    assert.match(firstMemoryText, /after validation/iu);
    const firstEvents = await runtime.repository.readEvents({ conversationId });
    assert.equal(firstEvents.some(({ type }) => type === 'memory.compilation.failed'), false);

    await closeRuntime(runtime);
    runtime = await openRuntime(dataRoot);
    const followUp = await sendAndWait(runtime, conversationId, [
      'Without using journal tools or reading files, state the opaque decision code from prior work',
      `and when releases happen. End with ${RESTART_MARKER}.`,
    ].join(' '));
    const followUpText = await assistantText(runtime.repository, followUp.turnId);
    assert.match(followUpText, new RegExp(DECISION_CODE));
    assert.match(followUpText, /after validation/iu);
    assert.match(followUpText, new RegExp(`${RESTART_MARKER}\\s*$`));
    await waitForSnapshot(runtime.repository, conversationId, 2, options.timeoutMs);

    const events = await runtime.repository.readEvents({ conversationId });
    const followUpTools = events.filter(({ turnId, type }) =>
      turnId === followUp.turnId && type === 'tool.called');
    assert.equal(followUpTools.length, 0, 'The restart follow-up should use compiled memory without retrieval.');
    assert.equal(events.filter(({ type }) => type === 'memory.snapshot.committed').length, 2);
    assert.equal(events.filter(({ type }) => type === 'memory.compilation.failed').length, 0);
    assert.equal(events.some(({ type }) => type.includes('compact')), false);
    assert.ok(events.filter(({ type }) => type === 'inference.started').length >= 2);
    assert.equal(await gitStatus(options.workspace), beforeStatus, 'The read-only smoke changed the working tree.');

    console.log(JSON.stringify({
      ok: true,
      conversationId,
      dataRoot,
      elapsedMs: Date.now() - startedAt,
      modelId: options.modelId,
      memoryCommits: events.filter(({ type }) => type === 'memory.snapshot.committed').length,
      backgroundFailures: events.filter(({ type }) => type === 'memory.compilation.failed').length,
    }, null, 2));
  } finally {
    if (runtime) await closeRuntime(runtime).catch(() => undefined);
    if (options.keepData) console.error(`Retained working-memory smoke data at ${root}`);
    else await rm(root, { recursive: true, force: true });
  }
}

async function openRuntime(dataRoot: string): Promise<Runtime> {
  const repository = await AgentJournalRepository.open({ dataRoot });
  const server = new AgentServer({ engine: await PiEngine.create(), journal: repository, notify: () => {} });
  await server.initialize();
  return { repository, server };
}

async function closeRuntime(runtime: Runtime) {
  await runtime.server.close();
  await runtime.repository.close();
}

async function sendAndWait(runtime: Runtime, conversationId: string, text: string) {
  const sent = await runtime.server.handle(AGENT_METHODS.messageSend, {
    operationId: randomUUID(), conversationId, clientMessageId: randomUUID(), text,
  }) as { turnId: string };
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline) {
    const read = await runtime.server.handle(AGENT_METHODS.resourcesRead, {
      requests: [{ key: AGENT_RESOURCE_KEYS.runtime }],
    }) as ResourceReadResult;
    const resource = read.resources[0];
    if (resource?.status === 'ok') {
      const value = resource.value as AgentRuntimeValue;
      if (value.conversationId === conversationId && value.state === 'idle') return sent;
      if (value.conversationId === conversationId && value.state === 'error') {
        throw new Error(value.error ?? 'Agent runtime failed.');
      }
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for foreground turn ${sent.turnId}.`);
}

async function waitForSnapshot(
  repository: AgentJournalRepository,
  conversationId: string,
  ordinal: number,
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const events = await repository.readEvents({ conversationId });
    const failures = events.filter(({ type }) => type === 'memory.compilation.failed');
    if (failures.length > 0) throw new Error(`Background compiler failed: ${JSON.stringify(failures.at(-1)?.payload)}`);
    const commits = events.filter(({ type }) => type === 'memory.snapshot.committed');
    if (commits.length >= ordinal) {
      const snapshot = await repository.readLatestWorkingMemory(conversationId);
      if (snapshot) return snapshot;
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for working-memory snapshot ${ordinal}.`);
}

async function assistantText(repository: AgentJournalRepository, turnId: string) {
  return (await repository.readTranscriptActions((await repository.readEvents()).find(({ turnId: id }) => id === turnId)!.conversationId))
    .filter((action) => action.type === 'assistant' && action.turnId === turnId)
    .map((action) => action.type === 'assistant' ? action.textDelta : '')
    .join('');
}

async function readReadiness(server: AgentServer) {
  const read = await server.handle(AGENT_METHODS.resourcesRead, {
    requests: [{ key: AGENT_RESOURCE_KEYS.auth }, { key: AGENT_RESOURCE_KEYS.models }],
  }) as ResourceReadResult;
  const auth = read.resources.find(({ key }) => key === AGENT_RESOURCE_KEYS.auth);
  const models = read.resources.find(({ key }) => key === AGENT_RESOURCE_KEYS.models);
  return {
    authState: auth?.status === 'ok' ? (auth.value as { state?: string }).state : null,
    models: models?.status === 'ok'
      ? (models.value as { models?: Array<{ id: string }> }).models?.map(({ id }) => id) ?? []
      : [],
  };
}

async function gitStatus(workspace: string) {
  return (await execFileAsync('git', ['status', '--short', '--untracked-files=all'], {
    cwd: workspace, maxBuffer: 16 * 1024 * 1024,
  })).stdout;
}

function parseOptions(args: string[]) {
  const values = new Map<string, string>();
  let keepData = false;
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index]!;
    if (key === '--keep-data') { keepData = true; continue; }
    const value = args[index + 1];
    if (!key.startsWith('--') || !value || value.startsWith('--')) throw new Error(`Expected value after ${key}.`);
    values.set(key, value);
    index += 1;
  }
  return {
    keepData,
    modelId: values.get('--model') ?? 'gpt-5.6-sol',
    reasoning: values.get('--reasoning') ?? 'high',
    timeoutMs: Number(values.get('--timeout-ms') ?? 300_000),
    workspace: resolve(values.get('--cwd') ?? resolve(import.meta.dirname, '../../../..')),
  } as const;
}

function delay(ms: number) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
