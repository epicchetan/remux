import { randomUUID } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import process from 'node:process';

import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';

import { AGENT_METHODS } from '../../shared/protocol.ts';
import { AgentServer } from '../../server/src/agent-server.ts';
import { PiEngine } from '../../server/src/pi-runtime.ts';
import { AgentJournalRepository } from '../../server/src/storage/repository.ts';
import {
  readWorkspaceFile,
  type WorkspaceReadExecutor,
} from '../../server/src/workspace-read.ts';
import {
  createScriptedCodexProvider,
  SCRIPTED_CODEX_MODEL_ID,
  type ScriptedCodexStep,
} from './scripted-codex-provider.ts';

type CrashScenario = 'partial-assistant' | 'tool-called' | 'tool-completed';

type WorkerConfig = {
  scenario: CrashScenario;
  workspace: string;
  dataRoot: string;
  markerPath: string;
};

const config = decodeConfig(process.argv[2]);
let repository: AgentJournalRepository;
let startedResolve: (() => void) | undefined;
const started = new Promise<void>((resolve) => {
  startedResolve = resolve;
});
let boundarySent = false;

void main().catch((error) => {
  send({ type: 'error', message: error instanceof Error ? error.stack ?? error.message : String(error) });
  process.exitCode = 1;
});

async function main() {
  const scripted = createScriptedCodexProvider({
    steps: scriptedSteps(config.scenario),
    beforeDispatch: async ({ ordinal }) => {
      if (config.scenario === 'tool-completed' && ordinal === 1) {
        await reachBoundary('tool-completed', 'tool.completed');
      }
    },
    onStreamBoundary: async ({ ordinal, type }) => {
      if (config.scenario === 'partial-assistant' && ordinal === 0 && type === 'after-text-delta') {
        await reachBoundary('partial-assistant', 'assistant.checkpoint');
      }
    },
  });
  const modelRuntime = await ModelRuntime.create({
    allowModelNetwork: false,
    modelsPath: null,
    credentials: new InMemoryCredentialStore(),
  });
  modelRuntime.registerNativeProvider(scripted.provider);
  await modelRuntime.setRuntimeApiKey('openai-codex', 'scripted-crash-credential');
  await modelRuntime.refresh({ allowNetwork: false, providers: ['openai-codex'] });
  const workspaceRead: WorkspaceReadExecutor = async (workspaceRoot, params) => {
    await appendFile(config.markerPath, `${config.scenario}\n`);
    if (config.scenario === 'tool-called') {
      await reachBoundary('tool-called', 'tool.called');
    }
    return readWorkspaceFile(workspaceRoot, params);
  };
  const engine = await PiEngine.create({ modelRuntime, workspaceRead });
  repository = await AgentJournalRepository.open({ dataRoot: config.dataRoot });
  const server = new AgentServer({ engine, journal: repository, notify: () => {} });
  await server.initialize();
  const created = await server.handle(AGENT_METHODS.conversationCreate, {
    operationId: randomUUID(),
    cwd: config.workspace,
    modelId: SCRIPTED_CODEX_MODEL_ID,
    reasoning: 'high',
    contextMode: 'full-history',
  }) as { conversationId: string };
  const accepted = await server.handle(AGENT_METHODS.messageSend, {
    operationId: randomUUID(),
    conversationId: created.conversationId,
    clientMessageId: randomUUID(),
    text: config.scenario === 'partial-assistant'
      ? 'Begin an answer that will be interrupted.'
      : 'Inspect README.md before answering.',
  }) as { turnId: string };
  send({
    type: 'started',
    conversationId: created.conversationId,
    turnId: accepted.turnId,
  });
  startedResolve?.();
  await never();
}

async function reachBoundary(scenario: CrashScenario, eventType: string) {
  await started;
  await waitForEvent(eventType);
  if (!boundarySent) {
    boundarySent = true;
    send({ type: 'boundary', scenario, eventType });
  }
  await never();
}

async function waitForEvent(type: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const events = await repository.readEvents();
    if (events.some((event) => event.type === type)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for durable event ${type}.`);
}

function scriptedSteps(scenario: CrashScenario): ScriptedCodexStep[] {
  if (scenario === 'partial-assistant') {
    return [{
      kind: 'answer',
      text: 'Partial answer committed before the crash.',
      responseId: 'crash-response-1',
    }];
  }
  return [
    {
      kind: 'tool-call',
      callId: 'crash-read|crash-item',
      name: 'workspace_read',
      args: { path: 'README.md' },
      responseId: 'crash-response-1',
    },
    {
      kind: 'answer',
      text: 'This response must never dispatch before the crash.',
      responseId: 'crash-response-2',
    },
  ];
}

function decodeConfig(value: string | undefined): WorkerConfig {
  if (!value) throw new Error('The Pi crash worker requires an encoded configuration.');
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as WorkerConfig;
}

function send(message: Record<string, unknown>) {
  if (!process.send) throw new Error('The Pi crash worker requires an IPC channel.');
  process.send(message);
}

function never(): Promise<never> {
  return new Promise(() => {});
}
