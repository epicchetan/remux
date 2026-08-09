import { randomUUID } from 'node:crypto';

import type {
  BenchmarkConversationTarget,
  BenchmarkTarget,
  VisibleBenchmarkTranscript,
} from './contracts.ts';
import { RemuxBenchmarkClient } from './remux-client.ts';

type JsonObject = Record<string, unknown>;

export function createBenchmarkTarget(
  kind: BenchmarkTarget,
  client: RemuxBenchmarkClient,
): BenchmarkConversationTarget {
  return kind === 'codex' ? new CodexBenchmarkTarget(client) : new AgentBenchmarkTarget(client);
}

class CodexBenchmarkTarget implements BenchmarkConversationTarget {
  readonly kind = 'codex' as const;
  private readonly client: RemuxBenchmarkClient;

  constructor(client: RemuxBenchmarkClient) {
    this.client = client;
  }

  async start(input: {
    cwd: string;
    modelId: string;
    reasoning: string;
    reviewMode: string;
    speed: string;
    contextMode?: import('./contracts.ts').BenchmarkContextMode;
    text: string;
  }) {
    const models = objectValue(await this.client.query(
      'remux/codex/models/read',
      { cwd: input.cwd },
      `benchmark:codex:models:${input.cwd}`,
    ));
    const available = arrayValue(models.models).map(objectValue);
    const selected = available.find((model) => stringValue(model.model) === input.modelId);
    if (!selected) {
      throw new Error(`Codex model ${input.modelId} is unavailable. Available: ${available.map((model) => stringValue(model.model)).filter(Boolean).join(', ')}`);
    }
    const supported = arrayValue(selected.supportedReasoningEfforts)
      .map(objectValue)
      .map((entry) => stringValue(entry.reasoningEffort));
    if (!supported.includes(input.reasoning)) {
      throw new Error(`Codex model ${input.modelId} does not support ${input.reasoning} reasoning.`);
    }
    const response = objectValue(await this.client.command('remux/codex/thread/message/start', {
      clientMessageId: randomUUID(),
      composerConfig: {
        intelligence: input.reasoning,
        model: input.modelId,
        reviewMode: input.reviewMode,
        speed: input.speed,
      },
      cwd: input.cwd,
      parts: [{ type: 'text', text: input.text }],
    }));
    return {
      conversationId: requiredString(response.threadId, 'Codex start response threadId'),
      turnId: requiredString(response.turnId, 'Codex start response turnId'),
      modelId: input.modelId,
    };
  }

  async send(input: { conversationId: string; text: string }) {
    const response = objectValue(await this.client.command('remux/codex/thread/message/send', {
      clientMessageId: randomUUID(),
      threadId: input.conversationId,
      parts: [{ type: 'text', text: input.text }],
    }));
    if (response.delivery !== 'sent') {
      throw new Error(`Benchmark turns must send immediately; Codex reported ${String(response.delivery)}.`);
    }
    return { turnId: requiredString(response.turnId, 'Codex send response turnId') };
  }

  async waitForTerminal(input: { conversationId: string; turnId: string; timeoutMs: number }) {
    const deadline = Date.now() + input.timeoutMs;
    while (Date.now() < deadline) {
      const response = objectValue(await this.client.query('remux/codex/thread/resources/read', {
        requests: [{ type: 'threadRuntime', threadId: input.conversationId }],
      }, `benchmark:codex:runtime:${input.conversationId}`));
      const resource = objectValue(arrayValue(response.resources)[0]);
      if (resource.status === 'ok') {
        const runtime = objectValue(resource.value);
        if (runtime.status === 'ready' && runtime.activeTurnId === null) return;
        if (runtime.status === 'failed') {
          throw new Error(`Codex turn failed: ${JSON.stringify(runtime.lastError ?? null)}`);
        }
      }
      await delay(250);
    }
    throw new Error(`Timed out after ${input.timeoutMs} ms waiting for Codex turn ${input.turnId}.`);
  }

  async readTranscript(conversationId: string): Promise<VisibleBenchmarkTranscript> {
    const response = objectValue(await this.client.query('remux/codex/transcript/resources/read', {
      threadId: conversationId,
      requests: [{
        type: 'transcriptSync',
        protocolVersion: 2,
        projectionVersion: 'turn-render-v2',
        window: { kind: 'tail', count: 40 },
      }],
    }, `benchmark:codex:transcript:${conversationId}`));
    const resource = objectValue(arrayValue(response.resources)[0]);
    if (resource.status !== 'ok') {
      throw new Error(`Codex transcript read failed: ${String(resource.reason ?? resource.status)}`);
    }
    const value = objectValue(resource.value);
    const assistantTextByTurn: Record<string, string> = {};
    for (const resultValue of arrayValue(value.turns)) {
      const result = objectValue(resultValue);
      if (result.status !== 'ok') continue;
      const frame = objectValue(result.frame);
      assistantTextByTurn[requiredString(result.turnId, 'Codex transcript turnId')] = arrayValue(frame.segments)
        .map(objectValue)
        .filter((segment) => segment.type === 'assistantMessage')
        .map((segment) => stringValue(segment.text) ?? '')
        .join('');
    }
    return {
      target: this.kind,
      conversationId,
      turnIds: arrayValue(value.turnOrder).map((turnId) => requiredString(turnId, 'Codex turn order id')),
      activeTurnId: nullableString(value.activeTurnId),
      assistantTextByTurn,
      raw: response,
    };
  }

  async interrupt(input: { conversationId: string; turnId?: string }) {
    await this.client.command('remux/codex/thread/turn/interrupt', {
      threadId: input.conversationId,
      turnId: input.turnId ?? null,
    });
  }
}

class AgentBenchmarkTarget implements BenchmarkConversationTarget {
  readonly kind = 'agent' as const;
  private readonly client: RemuxBenchmarkClient;

  constructor(client: RemuxBenchmarkClient) {
    this.client = client;
  }

  async start(input: {
    cwd: string;
    modelId: string;
    reasoning: string;
    reviewMode: string;
    speed: string;
    contextMode?: import('./contracts.ts').BenchmarkContextMode;
    text: string;
  }) {
    const resources = objectValue(await this.client.query('remux/agent/resources/read', {
      requests: [{ key: 'auth' }, { key: 'models' }],
    }, 'benchmark:agent:readiness'));
    const values = new Map(arrayValue(resources.resources).map((entryValue) => {
      const entry = objectValue(entryValue);
      return [stringValue(entry.key), entry.status === 'ok' ? entry.value : null];
    }));
    if (objectValue(values.get('auth')).state !== 'signed-in') {
      throw new Error('Agent target is not signed in.');
    }
    const models = arrayValue(objectValue(values.get('models')).models).map(objectValue);
    const selected = models.find((model) => stringValue(model.id) === input.modelId);
    if (!selected) {
      throw new Error(`Agent model ${input.modelId} is unavailable. Available: ${models.map((model) => stringValue(model.id)).filter(Boolean).join(', ')}`);
    }
    if (!arrayValue(selected.supportedReasoning).includes(input.reasoning)) {
      throw new Error(`Agent model ${input.modelId} does not support ${input.reasoning} reasoning.`);
    }
    const created = objectValue(await this.client.command('remux/agent/conversation/create', {
      operationId: randomUUID(),
      cwd: input.cwd,
      modelId: input.modelId,
      reasoning: input.reasoning,
      contextMode: input.contextMode === 'full-history' ? 'full-history' : 'stateful',
      workUnits: input.contextMode === 'managed-v1.1' || input.contextMode === 'full-history'
        ? false
        : true,
    }));
    const conversationId = requiredString(created.conversationId, 'Agent create response conversationId');
    const sent = await this.send({ conversationId, text: input.text });
    return { conversationId, turnId: sent.turnId, modelId: input.modelId };
  }

  async send(input: { conversationId: string; text: string }) {
    const response = objectValue(await this.client.command('remux/agent/conversation/message/send', {
      operationId: randomUUID(),
      conversationId: input.conversationId,
      clientMessageId: randomUUID(),
      text: input.text,
    }));
    if (response.accepted !== true) throw new Error('Agent did not accept the benchmark message.');
    return { turnId: requiredString(response.turnId, 'Agent send response turnId') };
  }

  async waitForTerminal(input: { conversationId: string; turnId: string; timeoutMs: number }) {
    const deadline = Date.now() + input.timeoutMs;
    let observedError: string | null = null;
    while (Date.now() < deadline) {
      const response = objectValue(await this.client.query('remux/agent/resources/read', {
        requests: [{ key: 'runtime' }],
      }, 'benchmark:agent:runtime'));
      const resource = objectValue(arrayValue(response.resources)[0]);
      if (resource.status === 'ok') {
        const runtime = objectValue(resource.value);
        if (runtime.conversationId === input.conversationId && runtime.state === 'idle') return;
        if (runtime.conversationId === input.conversationId && runtime.state === 'error') {
          observedError = String(runtime.error ?? 'unknown error');
          const transcript = await this.readTranscript(input.conversationId);
          if (transcript.activeTurnId !== input.turnId) {
            throw new Error(`Agent turn failed: ${observedError}`);
          }
        }
      }
      await delay(250);
    }
    if (observedError) throw new Error(`Agent turn failed before durable settlement: ${observedError}`);
    throw new Error(`Timed out after ${input.timeoutMs} ms waiting for Agent turn ${input.turnId}.`);
  }

  async readTranscript(conversationId: string): Promise<VisibleBenchmarkTranscript> {
    const response = objectValue(await this.client.query('remux/agent/transcript/resources/read', {
      conversationId,
      requests: [{
        type: 'transcriptSync',
        protocolVersion: 2,
        projectionVersion: 'agent-turn-render-v2',
        window: { kind: 'tail', count: 40 },
      }],
    }, `benchmark:agent:transcript:${conversationId}`));
    const resource = objectValue(arrayValue(response.resources)[0]);
    if (resource.status !== 'ok') {
      throw new Error(`Agent transcript read failed: ${String(resource.reason ?? resource.status)}`);
    }
    const value = objectValue(resource.value);
    const assistantTextByTurn: Record<string, string> = {};
    for (const resultValue of arrayValue(value.turns)) {
      const result = objectValue(resultValue);
      if (result.status !== 'ok' && result.status !== 'error') continue;
      const frame = objectValue(result.frame);
      assistantTextByTurn[requiredString(result.turnId, 'Agent transcript turnId')] = arrayValue(frame.segments)
        .map(objectValue)
        .filter((segment) => segment.type === 'assistantMessage')
        .map((segment) => stringValue(segment.text) ?? '')
        .join('');
    }
    return {
      target: this.kind,
      conversationId,
      turnIds: arrayValue(value.turnOrder).map((turnId) => requiredString(turnId, 'Agent turn order id')),
      activeTurnId: nullableString(value.activeTurnId),
      assistantTextByTurn,
      raw: response,
    };
  }

  async interrupt(input: { conversationId: string; turnId?: string }) {
    await this.client.command('remux/agent/conversation/turn/interrupt', {
      operationId: randomUUID(),
      conversationId: input.conversationId,
      turnId: input.turnId ?? null,
    });
  }
}

function objectValue(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value : null;
}

function nullableString(value: unknown) {
  return value === null ? null : stringValue(value);
}

function requiredString(value: unknown, label: string) {
  const result = stringValue(value);
  if (!result) throw new Error(`${label} is missing.`);
  return result;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
