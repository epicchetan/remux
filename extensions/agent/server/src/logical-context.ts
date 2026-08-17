import { createHash } from 'node:crypto';

import type { AssistantMessage, Message, Model } from '@earendil-works/pi-ai';
import { estimateTokens } from '@earendil-works/pi-coding-agent';

import { canonicalJson, canonicalJsonHash, type CanonicalJsonValue } from './storage/canonical-json.ts';

const VISIBLE_REASONING_LABEL = 'Visible reasoning summary from the prior response:\n';

export type LogicalToolCall = {
  callId: string;
  name: string;
  args: unknown;
};

export type LogicalContextMessage =
  | {
      role: 'user';
      turnId: string;
      text: string;
      images?: LogicalContextImage[];
      timestamp: number;
    }
  | {
      role: 'assistant';
      turnId: string;
      text: string;
      reasoning: string;
      toolCalls: LogicalToolCall[];
      /** Exact private Pi/provider message for active-scope continuation. */
      providerMessage?: AssistantMessage;
      state: 'completed' | 'failed' | 'interrupted';
      timestamp: number;
    }
  | {
      role: 'tool';
      turnId: string;
      callId: string;
      name: string;
      result: unknown;
      isError: boolean;
      timestamp: number;
    };

export type DurableContextSnapshot = {
  basisSequence: number;
  messages: LogicalContextMessage[];
  logicalHash: string;
  orderedMessageHashes: string[];
  estimatedBytes: number;
};

export type LogicalReplayEvent =
  | {
      type: 'user';
      sequence: number;
      turnId: string;
      timestamp: number;
      text: string;
      images?: LogicalContextImage[];
    }
  | {
      type: 'assistant-checkpoint';
      sequence: number;
      turnId: string;
      timestamp: number;
      textDelta: string;
      reasoningDelta: string;
    }
  | {
      type: 'inference-started';
      sequence: number;
      turnId: string;
      timestamp: number;
      inferenceId: string;
    }
  | {
      type: 'inference-terminal';
      sequence: number;
      turnId: string;
      timestamp: number;
      inferenceId: string;
      state: 'completed' | 'failed' | 'interrupted';
    }
  | {
      type: 'inference-superseded';
      sequence: number;
      turnId: string;
      timestamp: number;
      inferenceId: string;
    }
  | {
      type: 'tool-called';
      sequence: number;
      turnId: string;
      timestamp: number;
      callId: string;
      name: string;
      args: unknown;
    }
  | {
      type: 'tool-completed';
      sequence: number;
      turnId: string;
      timestamp: number;
      callId: string;
      result: unknown;
      isError: boolean;
    }
  | {
      type: 'turn-terminal';
      sequence: number;
      turnId: string;
      timestamp: number;
      state: 'completed' | 'failed' | 'interrupted';
    };

type PendingToolCall = LogicalToolCall & {
  result?: { value: unknown; isError: boolean; timestamp: number };
};

export type LogicalContextImage = {
  data: string;
  mimeType: string;
  sha256: string;
};

type AssistantBuilder = {
  kind: 'assistant';
  turnId: string;
  inferenceId: string | null;
  text: string;
  reasoning: string;
  toolCalls: PendingToolCall[];
  state: 'running' | 'completed' | 'failed' | 'interrupted' | 'superseded';
  timestamp: number;
};

type OrderedUnit = LogicalContextMessage & { role: 'user' } | AssistantBuilder;

/**
 * Reduce immutable History facts into the provider-neutral conversation that a
 * model may see. Incomplete tool effects remain durable/auditable but are never
 * replayed as if they had completed.
 */
export function reduceLogicalReplay(events: LogicalReplayEvent[]): LogicalContextMessage[] {
  const units: OrderedUnit[] = [];
  const activeByTurn = new Map<string, AssistantBuilder>();
  const latestByTurn = new Map<string, AssistantBuilder>();
  const byInference = new Map<string, AssistantBuilder>();
  const calls = new Map<string, PendingToolCall>();

  const startAssistant = (
    turnId: string,
    timestamp: number,
    inferenceId: string | null,
  ) => {
    const assistant: AssistantBuilder = {
      kind: 'assistant',
      turnId,
      inferenceId,
      text: '',
      reasoning: '',
      toolCalls: [],
      state: 'running',
      timestamp,
    };
    units.push(assistant);
    activeByTurn.set(turnId, assistant);
    latestByTurn.set(turnId, assistant);
    if (inferenceId) byInference.set(inferenceId, assistant);
    return assistant;
  };

  for (const event of [...events].sort((left, right) => left.sequence - right.sequence)) {
    switch (event.type) {
      case 'user':
        units.push({
          role: 'user',
          turnId: event.turnId,
          text: event.text,
          ...(event.images && event.images.length > 0 ? { images: event.images } : {}),
          timestamp: event.timestamp,
        });
        break;
      case 'inference-started': {
        const prior = activeByTurn.get(event.turnId);
        if (prior) prior.state = 'interrupted';
        startAssistant(event.turnId, event.timestamp, event.inferenceId);
        break;
      }
      case 'assistant-checkpoint': {
        const assistant = activeByTurn.get(event.turnId) ??
          startAssistant(event.turnId, event.timestamp, null);
        assistant.text += event.textDelta;
        assistant.reasoning += event.reasoningDelta;
        break;
      }
      case 'inference-terminal': {
        const assistant = byInference.get(event.inferenceId) ?? activeByTurn.get(event.turnId);
        if (!assistant) break;
        assistant.state = event.state;
        if (activeByTurn.get(event.turnId) === assistant) activeByTurn.delete(event.turnId);
        latestByTurn.set(event.turnId, assistant);
        break;
      }
      case 'inference-superseded': {
        const assistant = byInference.get(event.inferenceId);
        if (!assistant) break;
        assistant.state = 'superseded';
        if (activeByTurn.get(event.turnId) === assistant) activeByTurn.delete(event.turnId);
        if (latestByTurn.get(event.turnId) === assistant) latestByTurn.delete(event.turnId);
        break;
      }
      case 'tool-called': {
        const assistant = latestByTurn.get(event.turnId) ??
          activeByTurn.get(event.turnId) ??
          startAssistant(event.turnId, event.timestamp, null);
        const call: PendingToolCall = {
          callId: event.callId,
          name: event.name,
          args: event.args,
        };
        assistant.toolCalls.push(call);
        calls.set(event.callId, call);
        break;
      }
      case 'tool-completed': {
        const call = calls.get(event.callId);
        if (call) {
          call.result = {
            value: event.result,
            isError: event.isError,
            timestamp: event.timestamp,
          };
        }
        break;
      }
      case 'turn-terminal': {
        const active = activeByTurn.get(event.turnId);
        if (active) {
          active.state = event.state;
          activeByTurn.delete(event.turnId);
          latestByTurn.set(event.turnId, active);
        }
        break;
      }
    }
  }

  return units.flatMap((unit): LogicalContextMessage[] => {
    if ('role' in unit) return [unit];
    if (unit.state === 'superseded') return [];
    const completedCalls = unit.toolCalls.filter(
      (call): call is PendingToolCall & { result: NonNullable<PendingToolCall['result']> } =>
        call.result !== undefined,
    );
    const state = unit.state === 'running' ? 'interrupted' : unit.state;
    const assistant: LogicalContextMessage = {
      role: 'assistant',
      turnId: unit.turnId,
      text: unit.text,
      reasoning: unit.reasoning,
      toolCalls: completedCalls.map(({ callId, name, args }) => ({ callId, name, args })),
      state,
      timestamp: unit.timestamp,
    };
    return [
      assistant,
      ...completedCalls.map((call): LogicalContextMessage => ({
        role: 'tool',
        turnId: unit.turnId,
        callId: call.callId,
        name: call.name,
        result: call.result.value,
        isError: call.result.isError,
        timestamp: call.result.timestamp,
      })),
    ];
  });
}

export function createDurableContextSnapshot(
  basisSequence: number,
  messages: LogicalContextMessage[],
): DurableContextSnapshot {
  const semantic = messages.map(logicalMessageSemanticValue);
  const encoded = canonicalJson(semantic);
  return {
    basisSequence,
    messages,
    logicalHash: createHash('sha256').update(encoded).digest('hex'),
    orderedMessageHashes: semantic.map((message) => canonicalJsonHash(message)),
    estimatedBytes: Buffer.byteLength(encoded, 'utf8'),
  };
}

export function renderDurablePiPrefix(
  messages: LogicalContextMessage[],
  model: Model<string>,
): Message[] {
  return messages.map((message): Message => {
    if (message.role === 'user') {
      const images = message.images ?? [];
      return {
        role: 'user',
        content: images.length === 0
          ? message.text
          : [
              { type: 'text' as const, text: message.text },
              ...images.map((image) => ({
                type: 'image' as const,
                data: image.data,
                mimeType: image.mimeType,
              })),
            ],
        timestamp: message.timestamp,
      };
    }
    if (message.role === 'tool') {
      return {
        role: 'toolResult',
        toolCallId: message.callId,
        toolName: providerToolName(message.name),
        content: [{ type: 'text', text: canonicalJson(message.result) }],
        details: message.result,
        isError: message.isError,
        timestamp: message.timestamp,
      };
    }
    if (message.providerMessage) return message.providerMessage;
    const content: AssistantMessage['content'] = [];
    if (message.text) content.push({ type: 'text', text: message.text });
    content.push(...message.toolCalls.map((call) => ({
      type: 'toolCall' as const,
      id: call.callId,
      name: providerToolName(call.name),
      arguments: requiredArguments(call.args),
    })));
    return {
      role: 'assistant',
      content,
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: emptyUsage(),
      stopReason: message.toolCalls.length > 0 ? 'toolUse' : 'stop',
      timestamp: message.timestamp,
    };
  });
}

export function piMessageSemanticHashes(messages: unknown[]): string[] {
  return messages.map((message) => canonicalJsonHash(piMessageSemanticValue(message)));
}

export function hashRenderedMessages(messages: Message[]) {
  const encoded = messages.map((message) => canonicalTransportJson(jsonRoundTrip(message)));
  return {
    hash: createHash('sha256').update(encoded.join('\n')).digest('hex'),
    orderedHashes: encoded.map((message) => createHash('sha256').update(message).digest('hex')),
    estimatedBytes: encoded.reduce((total, message) => total + Buffer.byteLength(message, 'utf8'), 0),
  };
}

export function estimatePiContextTokens(messages: Message[], fixedPrompt: string) {
  const piEstimate = messages.reduce((total, message) => total + estimateTokens(message), 0);
  const providerVisibleMessages = messages.map(providerVisiblePiMessage);
  const byteEstimate = Math.ceil(
    (Buffer.byteLength(canonicalTransportJson(jsonRoundTrip(providerVisibleMessages)), 'utf8') +
      Buffer.byteLength(fixedPrompt, 'utf8')) / 4,
  );
  // Reserve a deterministic allowance for the currently small tool contract and
  // provider framing that are not represented by AgentMessage token estimates.
  return Math.max(piEstimate + Math.ceil(fixedPrompt.length / 4) + 1_000, byteEstimate + 1_000);
}

function providerVisiblePiMessage(message: Message) {
  if (message.role === 'user') {
    return { role: message.role, content: message.content };
  }
  if (message.role === 'assistant') {
    return { role: message.role, content: message.content };
  }
  return {
    role: message.role,
    toolCallId: message.toolCallId,
    toolName: message.toolName,
    content: message.content,
    isError: message.isError,
    ...(message.addedToolNames ? { addedToolNames: message.addedToolNames } : {}),
  };
}

export function logicalMessageSemanticValue(message: LogicalContextMessage): CanonicalJsonValue {
  if (message.role === 'user') return {
    role: 'user',
    text: message.text,
    ...((message.images?.length ?? 0) > 0
      ? { images: message.images!.map((image) => ({ mimeType: image.mimeType, sha256: image.sha256 })) }
      : {}),
  };
  if (message.role === 'assistant') {
    return {
      role: 'assistant',
      reasoning: '',
      text: message.text,
      toolCalls: message.toolCalls.map((call) => ({
        args: jsonValue(call.args),
        callId: call.callId,
        name: providerToolName(call.name),
      })),
    };
  }
  return {
    role: 'tool',
    callId: message.callId,
    name: providerToolName(message.name),
    result: jsonValue(message.result),
    isError: message.isError,
  };
}

function piMessageSemanticValue(value: unknown): CanonicalJsonValue {
  const message = requiredObject(value, 'Pi message');
  if (message.role === 'user') {
    return userContentSemanticValue(message.content);
  }
  if (message.role === 'assistant') {
    if (!Array.isArray(message.content)) throw new Error('Pi assistant content is invalid.');
    let text = '';
    let reasoning = '';
    const toolCalls: CanonicalJsonValue[] = [];
    for (const entry of message.content) {
      const block = requiredObject(entry, 'Pi assistant content block');
      if (block.type === 'text' && block.remuxKind === 'visible-reasoning-summary') {
        const summary = requiredString(block.text, 'Pi assistant reasoning summary');
        if (!summary.startsWith(VISIBLE_REASONING_LABEL)) {
          throw new Error('Pi assistant reasoning summary is malformed.');
        }
        reasoning += summary.slice(VISIBLE_REASONING_LABEL.length);
      } else if (block.type === 'text') text += requiredString(block.text, 'Pi assistant text');
      else if (block.type === 'thinking') reasoning += requiredString(block.thinking, 'Pi assistant reasoning');
      else if (block.type === 'toolCall') {
        toolCalls.push({
          args: jsonValue(block.arguments),
          callId: requiredString(block.id, 'Pi tool call id'),
          name: providerToolName(requiredString(block.name, 'Pi tool name')),
        });
      }
    }
    return { role: 'assistant', reasoning: '', text, toolCalls };
  }
  if (message.role === 'toolResult') {
    const content = textContent(message.content, 'tool result');
    const result = message.isError === true
      ? { error: content }
      : parseProviderToolResultText(content);
    return {
      role: 'tool',
      callId: requiredString(message.toolCallId, 'Pi tool result call id'),
      name: providerToolName(requiredString(message.toolName, 'Pi tool result name')),
      result,
      isError: message.isError === true,
    };
  }
  throw new Error('Pi context contains a non-provider message.');
}

function textContent(value: unknown, label: string) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) throw new Error(`Pi ${label} content is invalid.`);
  let text = '';
  for (const entry of value) {
    const block = requiredObject(entry, `Pi ${label} content block`);
    if (block.type === 'text') text += requiredString(block.text, `Pi ${label} text`);
    else if (block.type === 'image') throw new Error(`Pi ${label} image replay is not enabled.`);
  }
  return text;
}

function userContentSemanticValue(value: unknown): CanonicalJsonValue {
  if (typeof value === 'string') return { role: 'user', text: value };
  if (!Array.isArray(value)) throw new Error('Pi user content is invalid.');
  let text = '';
  const images: CanonicalJsonValue[] = [];
  for (const entry of value) {
    const block = requiredObject(entry, 'Pi user content block');
    if (block.type === 'text') {
      text += requiredString(block.text, 'Pi user text');
      continue;
    }
    if (block.type === 'image') {
      const data = requiredString(block.data, 'Pi user image data');
      images.push({
        mimeType: requiredString(block.mimeType, 'Pi user image mime type'),
        sha256: createHash('sha256').update(Buffer.from(data, 'base64')).digest('hex'),
      });
      continue;
    }
    throw new Error('Pi user content contains an unsupported block.');
  }
  return { role: 'user', text, ...(images.length > 0 ? { images } : {}) };
}

export function parseProviderToolResultText(value: string): CanonicalJsonValue {
  try {
    return jsonValue(JSON.parse(value));
  } catch {
    return value;
  }
}

function providerToolName(name: string) {
  return name === 'workspace.read' ? 'workspace_read' : name;
}

function requiredArguments(value: unknown): Record<string, unknown> {
  const args = requiredObject(value, 'Logical tool arguments');
  return Object.fromEntries(Object.entries(args).map(([key, entry]) => [key, jsonValue(entry)]));
}

function requiredObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string) {
  if (typeof value !== 'string') throw new Error(`${label} must be a string.`);
  return value;
}

function jsonValue(value: unknown): CanonicalJsonValue {
  return JSON.parse(canonicalJson(value)) as CanonicalJsonValue;
}

function jsonRoundTrip(value: unknown): CanonicalJsonValue {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('Provider context is not JSON serializable.');
  return JSON.parse(encoded) as CanonicalJsonValue;
}

export function canonicalProviderJson(value: unknown) {
  return canonicalTransportJson(jsonRoundTrip(value));
}

/**
 * Provider-native messages contain finite decimal metadata such as token
 * costs. Keep that transport domain separate from the state store's deliberately
 * stricter integer-only canonical JSON contract.
 */
function canonicalTransportJson(value: CanonicalJsonValue): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Provider JSON requires finite numbers.');
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalTransportJson).join(',')}]`;
  }
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalTransportJson(value[key]!)}`
  ).join(',')}}`;
}

function emptyUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}
