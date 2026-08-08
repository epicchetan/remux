import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
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

type CrashScenario = 'partial-assistant' | 'tool-called' | 'tool-completed';

const scenarios: Array<{
  scenario: CrashScenario;
  boundaryEvent: string;
  expectedToolEvents: string[];
  expectedContextRoles: string[];
}> = [
  {
    scenario: 'partial-assistant',
    boundaryEvent: 'assistant.checkpoint',
    expectedToolEvents: [],
    expectedContextRoles: ['user', 'assistant', 'user'],
  },
  {
    scenario: 'tool-called',
    boundaryEvent: 'tool.called',
    expectedToolEvents: ['tool.called'],
    expectedContextRoles: ['user', 'assistant', 'user'],
  },
  {
    scenario: 'tool-completed',
    boundaryEvent: 'tool.completed',
    expectedToolEvents: ['tool.called', 'tool.completed'],
    expectedContextRoles: ['user', 'assistant', 'toolResult', 'user'],
  },
];

for (const fixture of scenarios) {
  test(`an abrupt ${fixture.scenario} crash recovers without replaying effects`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), `remux-agent-pi-crash-${fixture.scenario}-`));
    const workspace = join(root, 'workspace');
    const dataRoot = join(root, 'data');
    const markerPath = join(root, 'workspace-read-invocations.txt');
    await mkdir(workspace);
    await writeFile(join(workspace, 'README.md'), '# Crash fixture\nThe tool result is durable.\n');
    t.after(() => rm(root, { force: true, recursive: true }));

    const crashed = await crashAtBoundary(t, {
      scenario: fixture.scenario,
      workspace,
      dataRoot,
      markerPath,
    });
    assert.equal(crashed.boundaryEvent, fixture.boundaryEvent);
    const databasePath = join(dataRoot, 'agent.sqlite3');
    const committedPrefix = readRawEvents(databasePath, crashed.conversationId);
    assert.equal(committedPrefix.some(({ type }) => type === 'turn.terminal'), false);
    assert.equal(committedPrefix.some(({ type }) => type === fixture.boundaryEvent), true);
    assert.deepEqual(
      committedPrefix
        .filter(({ type }) => type === 'tool.called' || type === 'tool.completed')
        .map(({ type }) => type),
      fixture.expectedToolEvents,
    );
    assert.equal(await markerCount(markerPath), fixture.scenario === 'partial-assistant' ? 0 : 1);

    const repository = await AgentJournalRepository.open({ dataRoot });
    const recoveredRows = readRawEvents(databasePath, crashed.conversationId);
    assert.deepEqual(recoveredRows.slice(0, committedPrefix.length), committedPrefix);
    assert.equal(
      recoveredRows.filter(({ turn_id, type }) =>
        turn_id === crashed.turnId && type === 'turn.terminal').length,
      1,
    );
    assert.deepEqual(readRecoveryState(databasePath, crashed.turnId), {
      turn_state: 'interrupted_by_restart',
      scope_state: 'interrupted_by_restart',
      epoch_state: 'closed',
      close_reason: 'interrupted_by_restart',
      inference_states: fixture.scenario === 'partial-assistant' ? ['interrupted'] : ['completed'],
    });

    const actions = await repository.readTranscriptActions(crashed.conversationId);
    const terminal = actions.at(-1);
    assert.ok(terminal?.type === 'terminal');
    assert.equal(terminal.turnId, crashed.turnId);
    assert.equal(terminal.status, 'interrupted_by_restart');
    assert.equal(terminal.error, null);
    assert.ok((terminal.durationMs ?? -1) >= 0);
    if (fixture.scenario === 'partial-assistant') {
      assert.deepEqual(
        actions.filter(({ type }) => type === 'assistant').map((action) =>
          action.type === 'assistant' ? action.textDelta : ''),
        ['Partial answer committed before the crash.'],
      );
    }

    const recoveredContext = await repository.compileContext(crashed.conversationId);
    assertRecoveredContext(fixture.scenario, recoveredContext.messages);

    const dispatched: ScriptedCodexRequest[] = [];
    const scripted = createScriptedCodexProvider({
      steps: [{
        kind: 'answer',
        text: 'The recovered conversation continued in a fresh provider chain.',
        responseId: 'recovery-response-1',
      }],
      async onDispatch(request) {
        const events = await repository.readEvents({ conversationId: crashed.conversationId });
        assert.equal(events.at(-1)?.type, 'inference.started');
        dispatched.push(request);
      },
    });
    const modelRuntime = await ModelRuntime.create({
      allowModelNetwork: false,
      modelsPath: null,
      credentials: new InMemoryCredentialStore(),
    });
    modelRuntime.registerNativeProvider(scripted.provider);
    await modelRuntime.setRuntimeApiKey('openai-codex', 'scripted-recovery-credential');
    await modelRuntime.refresh({ allowNetwork: false, providers: ['openai-codex'] });
    const server = new AgentServer({
      engine: await PiEngine.create({ modelRuntime }),
      journal: repository,
      notify: () => {},
    });
    t.after(async () => {
      await server.close();
      await repository.close();
    });
    await server.initialize();
    await sendAndWait(server, crashed.conversationId, 'Continue safely after the crash.');

    assert.equal(dispatched.length, 1);
    assert.equal(requestMode(dispatched[0]!), 'full');
    assert.deepEqual(
      dispatched[0]?.context.messages.map((message) => message.role),
      fixture.expectedContextRoles,
    );
    const finalEvents = await repository.readEvents({ conversationId: crashed.conversationId });
    assert.deepEqual(
      finalEvents
        .filter(({ type }) => type === 'tool.called' || type === 'tool.completed')
        .map(({ type }) => type),
      fixture.expectedToolEvents,
    );
    assert.equal(await markerCount(markerPath), fixture.scenario === 'partial-assistant' ? 0 : 1);
    assert.equal(
      finalEvents.filter(({ turnId, type }) =>
        turnId === crashed.turnId && type === 'turn.terminal').length,
      1,
    );
  });
}

function assertRecoveredContext(
  scenario: CrashScenario,
  messages: Awaited<ReturnType<AgentJournalRepository['compileContext']>>['messages'],
) {
  assert.deepEqual(messages.map(({ role }) => role),
    scenario === 'tool-completed' ? ['user', 'assistant', 'tool'] : ['user', 'assistant']);
  const assistant = messages.find((message) => message.role === 'assistant');
  assert.ok(assistant?.role === 'assistant');
  if (scenario === 'partial-assistant') {
    assert.equal(assistant.text, 'Partial answer committed before the crash.');
    assert.equal(assistant.state, 'interrupted');
    assert.deepEqual(assistant.toolCalls, []);
  } else if (scenario === 'tool-called') {
    assert.equal(assistant.text, '');
    assert.deepEqual(assistant.toolCalls, []);
  } else {
    assert.deepEqual(assistant.toolCalls.map(({ name }) => name), ['workspace.read']);
    const tool = messages.find((message) => message.role === 'tool');
    assert.ok(tool?.role === 'tool');
    assert.equal(tool.name, 'workspace.read');
  }
}

async function crashAtBoundary(
  t: TestContext,
  config: {
    scenario: CrashScenario;
    workspace: string;
    dataRoot: string;
    markerPath: string;
  },
) {
  const worker = fileURLToPath(new URL('./helpers/pi-crash-worker.ts', import.meta.url));
  const encoded = Buffer.from(JSON.stringify(config)).toString('base64url');
  const child = fork(worker, [encoded], {
    execArgv: ['--experimental-strip-types'],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });
  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk;
  });
  return new Promise<{
    conversationId: string;
    turnId: string;
    boundaryEvent: string;
  }>((resolve, reject) => {
    let started: { conversationId: string; turnId: string } | null = null;
    let boundaryEvent: string | null = null;
    let settled = false;
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error(`Timed out waiting for ${config.scenario} crash boundary.\n${stderr}`));
    }, 10_000);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else if (started && boundaryEvent) resolve({ ...started, boundaryEvent });
      else reject(new Error(`The ${config.scenario} worker exited without complete boundary data.\n${stderr}`));
    };
    child.on('message', (message: unknown) => {
      if (!message || typeof message !== 'object' || Array.isArray(message)) return;
      const value = message as Record<string, unknown>;
      if (value.type === 'error') {
        finish(new Error(String(value.message)));
      } else if (
        value.type === 'started' &&
        typeof value.conversationId === 'string' &&
        typeof value.turnId === 'string'
      ) {
        started = { conversationId: value.conversationId, turnId: value.turnId };
      } else if (value.type === 'boundary' && typeof value.eventType === 'string') {
        boundaryEvent = value.eventType;
        child.kill('SIGKILL');
      }
    });
    child.on('error', (error) => finish(error));
    child.on('exit', (code, signal) => {
      if (boundaryEvent && signal === 'SIGKILL') finish();
      else finish(new Error(
        `The ${config.scenario} worker exited early (code ${code}, signal ${signal}).\n${stderr}`,
      ));
    });
  });
}

type RawEventRow = {
  sequence: number;
  event_id: string;
  turn_id: string | null;
  type: string;
  payload_json: string | null;
  artifact_hash: string | null;
  created_at: number;
};

function readRawEvents(databasePath: string, conversationId: string): RawEventRow[] {
  const database = new DatabaseSync(databasePath);
  try {
    return (database.prepare(`
      SELECT sequence, event_id, turn_id, type, payload_json, artifact_hash, created_at
      FROM events WHERE conversation_id = ? ORDER BY sequence
    `).all(conversationId) as RawEventRow[]).map((row) => ({ ...row }));
  } finally {
    database.close();
  }
}

function readRecoveryState(databasePath: string, turnId: string) {
  const database = new DatabaseSync(databasePath);
  try {
    const state = database.prepare(`
      SELECT t.state AS turn_state, s.state AS scope_state,
             e.state AS epoch_state, e.close_reason
      FROM turns t
      JOIN execution_scopes s ON s.scope_id = t.root_scope_id
      JOIN epochs e ON e.scope_id = s.scope_id
      WHERE t.turn_id = ?
    `).get(turnId) as {
      turn_state: string;
      scope_state: string;
      epoch_state: string;
      close_reason: string;
    };
    const inferences = database.prepare(`
      SELECT state FROM inferences WHERE turn_id = ? ORDER BY ordinal
    `).all(turnId) as Array<{ state: string }>;
    return { ...state, inference_states: inferences.map(({ state: value }) => value) };
  } finally {
    database.close();
  }
}

async function markerCount(path: string) {
  try {
    return (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).length;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
}

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
