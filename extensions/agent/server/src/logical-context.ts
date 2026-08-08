import { createHash } from 'node:crypto';

import type { AssistantMessage, Message, Model, TextContent } from '@earendil-works/pi-ai';
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
      timestamp: number;
    }
  | {
      role: 'assistant';
      turnId: string;
      text: string;
      reasoning: string;
      toolCalls: LogicalToolCall[];
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
  | { type: 'user'; sequence: number; turnId: string; timestamp: number; text: string }
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

type AssistantBuilder = {
  kind: 'assistant';
  turnId: string;
  inferenceId: string | null;
  text: string;
  reasoning: string;
  toolCalls: PendingToolCall[];
  state: 'running' | 'completed' | 'failed' | 'interrupted';
  timestamp: number;
};

type OrderedUnit = LogicalContextMessage & { role: 'user' } | AssistantBuilder;

/**
 * Reduce immutable journal facts into the provider-neutral conversation that a
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
      return { role: 'user', content: message.text, timestamp: message.timestamp };
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
    const content: AssistantMessage['content'] = [];
    if (message.reasoning) {
      content.push({
        type: 'text',
        text: `${VISIBLE_REASONING_LABEL}${message.reasoning}`,
        remuxKind: 'visible-reasoning-summary',
      } as TextContent & { remuxKind: 'visible-reasoning-summary' });
    }
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

export function alignDurableContextWithPi(
  snapshot: DurableContextSnapshot,
  piMessages: unknown[],
  model: Model<string>,
): Message[] {
  const piHashes = piMessageSemanticHashes(piMessages);
  const offset = snapshot.orderedMessageHashes.length - piHashes.length;
  if (
    offset < 0 ||
    !piHashes.every((hash, index) => snapshot.orderedMessageHashes[offset + index] === hash)
  ) {
    throw new Error('Durable context does not match Pi runtime suffix.');
  }
  return [
    ...renderDurablePiPrefix(snapshot.messages.slice(0, offset), model),
    ...piMessages.map(requiredPiMessage),
  ];
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

export function assertContextBudget(estimatedInputTokens: number, contextWindow: number) {
  const hardInputLimit = Math.min(150_000, Math.max(0, contextWindow - 25_000));
  const safetyMargin = 5_000;
  if (estimatedInputTokens + safetyMargin > hardInputLimit) {
    throw new ContextRolloverRequiredError(estimatedInputTokens, hardInputLimit, safetyMargin);
  }
}

export class ContextRolloverRequiredError extends Error {
  readonly kind = 'context_rollover_not_enabled';
  readonly estimatedInputTokens: number;
  readonly hardInputLimit: number;
  readonly safetyMargin: number;
  readonly admissionLimit: number;

  constructor(estimatedInputTokens: number, hardInputLimit: number, safetyMargin: number) {
    const admissionLimit = Math.max(0, hardInputLimit - safetyMargin);
    super(
      `Context requires an estimated ${estimatedInputTokens} input tokens plus a ` +
      `${safetyMargin}-token safety margin; the effective admission limit is ` +
      `${admissionLimit} tokens (${hardInputLimit} hard), and epoch rollover is not enabled.`,
    );
    this.name = 'ContextRolloverRequiredError';
    this.estimatedInputTokens = estimatedInputTokens;
    this.hardInputLimit = hardInputLimit;
    this.safetyMargin = safetyMargin;
    this.admissionLimit = admissionLimit;
  }
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
  if (message.role === 'user') return { role: 'user', text: message.text };
  if (message.role === 'assistant') {
    return {
      role: 'assistant',
      reasoning: message.reasoning,
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
    return { role: 'user', text: textContent(message.content, 'user') };
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
    return { role: 'assistant', reasoning, text, toolCalls };
  }
  if (message.role === 'toolResult') {
    const content = textContent(message.content, 'tool result');
    const result = message.isError === true
      ? { error: content }
      : message.details === undefined
        ? parseToolResultText(content)
        : jsonValue(message.details);
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

function parseToolResultText(value: string): CanonicalJsonValue {
  try {
    return jsonValue(JSON.parse(value));
  } catch {
    return value;
  }
}

function requiredPiMessage(value: unknown): Message {
  piMessageSemanticValue(value);
  return value as Message;
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

/**
 * Provider-native messages contain finite decimal metadata such as token
 * costs. Keep that transport domain separate from the journal's deliberately
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
