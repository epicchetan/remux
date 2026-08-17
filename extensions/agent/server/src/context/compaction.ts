import { createHash } from 'node:crypto';

import { canonicalProviderJson } from '../logical-context.ts';
import type { CanonicalJsonValue } from '../storage/canonical-json.ts';
import type { TurnContextPlan } from '../../../shared/protocol.ts';
import type { ResolvedTurnContextSource } from './manifest.ts';

export const CONTEXT_COMPACTION_VERSION = 1 as const;
export const DEFAULT_RETAINED_MESSAGE_TOKENS = 64_000;
export const DESIRED_CONTEXT_COMPACTION_TARGET_TOKENS = 300_000;

const EFFECTIVE_CONTEXT_PERCENT = 0.95;
const MINIMUM_CONTEXT_RESERVE_TOKENS = 38_000;
const WARNING_FRACTION = 0.8;

export type ContextCompactionTrigger = 'model' | 'automatic';

export type ContextCompactionPolicy = {
  enabled: boolean;
  warningTokens: number;
  targetTokens: number;
  emergencyTokens: number;
  retainedMessageTokens: number;
};

export type ContextCompactionUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
};

export type ProviderCompactionCheckpoint = {
  version: typeof CONTEXT_COMPACTION_VERSION;
  epoch: number;
  compactedThroughSequence: number;
  installedSequence: number;
  trigger: ContextCompactionTrigger;
  inputHash: string;
  policyInputTokens: number;
  retainedInputTokens: number;
  retainedInput: CanonicalJsonValue[];
  providerItem: CanonicalJsonValue;
  usage: ContextCompactionUsage;
  durationMs: number;
  requestedPlan: TurnContextPlan;
  resolvedTurns: ResolvedTurnContextSource[];
  selectedTurnIds: string[];
};

export type ContextCompactionState = {
  checkpoint: ProviderCompactionCheckpoint | null;
  epoch: number;
  warningIssued: boolean;
  modelRequested: boolean;
  policyInputTokens: number;
};

export function resolveContextCompactionPolicy(
  contextWindow: number,
  override: Partial<ContextCompactionPolicy> = {},
): ContextCompactionPolicy {
  const safeWindow = positiveSafeInteger(contextWindow, 'model context window');
  const emergencyTokens = Math.max(1, Math.floor(safeWindow * EFFECTIVE_CONTEXT_PERCENT));
  const targetTokens = Math.min(
    DESIRED_CONTEXT_COMPACTION_TARGET_TOKENS,
    Math.max(1, emergencyTokens - MINIMUM_CONTEXT_RESERVE_TOKENS),
  );
  const warningTokens = Math.max(1, Math.floor(targetTokens * WARNING_FRACTION));
  const resolved = {
    enabled: override.enabled ?? true,
    warningTokens: override.warningTokens ?? warningTokens,
    targetTokens: override.targetTokens ?? targetTokens,
    emergencyTokens: override.emergencyTokens ?? emergencyTokens,
    retainedMessageTokens: override.retainedMessageTokens ?? DEFAULT_RETAINED_MESSAGE_TOKENS,
  };
  for (const [name, value] of [
    ['warningTokens', resolved.warningTokens],
    ['targetTokens', resolved.targetTokens],
    ['emergencyTokens', resolved.emergencyTokens],
    ['retainedMessageTokens', resolved.retainedMessageTokens],
  ] as const) {
    positiveSafeInteger(value, `context compaction ${name}`);
  }
  if (resolved.warningTokens >= resolved.targetTokens) {
    throw new TypeError('Context compaction warningTokens must be below targetTokens.');
  }
  if (resolved.targetTokens >= resolved.emergencyTokens) {
    throw new TypeError('Context compaction targetTokens must be below emergencyTokens.');
  }
  return resolved;
}

export function contextBudgetNotice(input: {
  estimatedTokens: number;
  targetTokens: number;
}) {
  return [
    '<context-budget>',
    `This active execution scope is using approximately ${input.estimatedTokens} input tokens.`,
    `Automatic compaction will occur before approximately ${input.targetTokens} tokens.`,
    'If the current piece of work has reached a stable boundary and substantial work remains, call context_compact. Otherwise continue normally.',
    'Do not stop early or answer the user solely because of this notice.',
    '</context-budget>',
  ].join('\n');
}

export function injectContextBudgetNotice(payload: unknown, notice: string, position?: number) {
  const request = providerRequest(payload);
  const input = providerInput(request);
  const insertion = position === undefined
    ? input.length
    : Math.max(0, Math.min(input.length, Math.floor(position)));
  return {
    ...request,
    input: [
      ...input.slice(0, insertion),
      {
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: notice }],
      },
      ...input.slice(insertion),
    ],
  };
}

export function injectProviderCompaction(
  payload: unknown,
  checkpoint: ProviderCompactionCheckpoint,
) {
  const request = providerRequest(payload);
  const input = providerInput(request);
  const { previous_response_id: _previousResponseId, ...fresh } = request;
  return {
    ...fresh,
    input: [
      ...checkpoint.retainedInput,
      checkpoint.providerItem,
      ...input,
    ],
  };
}

export function buildCompactionReplacement(payload: unknown, providerItem: unknown, retainedTokenBudget: number) {
  const request = providerRequest(payload);
  const retained = retainRecentProviderMessages(
    providerInput(request),
    retainedTokenBudget,
  );
  const item = canonicalProviderCompactionItem(providerItem);
  const { previous_response_id: _previousResponseId, ...fresh } = request;
  return {
    retainedInput: retained.items,
    retainedInputTokens: retained.estimatedTokens,
    payload: {
      ...fresh,
      input: [...retained.items, item],
    },
    providerItem: item,
  };
}

export function compactionRequestPayload(payload: unknown) {
  const request = providerRequest(payload);
  const input = providerInput(request);
  const { previous_response_id: _previousResponseId, ...fresh } = request;
  return {
    ...fresh,
    stream: true,
    input: [...input, { type: 'compaction_trigger' }],
  };
}

export function hashProviderInput(payload: unknown) {
  const input = providerInput(providerRequest(payload));
  const orderedHashes = input.map((item) => providerJsonHash(item));
  const encoded = canonicalProviderJson(input);
  return {
    hash: createHash('sha256').update(encoded, 'utf8').digest('hex'),
    orderedHashes,
    itemCount: input.length,
    estimatedBytes: Buffer.byteLength(encoded, 'utf8'),
  };
}

export function estimateProviderRequestTokens(payload: unknown) {
  return Math.max(1, Math.ceil(Buffer.byteLength(
    canonicalProviderJson(providerRequest(payload)),
    'utf8',
  ) / 4));
}

export function canonicalProviderCompactionItem(value: unknown): CanonicalJsonValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Remote compaction returned no provider item.');
  }
  const item = value as Record<string, unknown>;
  if (!['compaction', 'compaction_summary'].includes(String(item.type))) {
    throw new TypeError(`Remote compaction returned unexpected item type ${String(item.type)}.`);
  }
  if (typeof item.encrypted_content !== 'string' || item.encrypted_content.length === 0) {
    throw new TypeError('Remote compaction returned empty encrypted_content.');
  }
  return JSON.parse(canonicalProviderJson(item)) as CanonicalJsonValue;
}

function retainRecentProviderMessages(input: CanonicalJsonValue[], maxTokens: number) {
  let remaining = positiveSafeInteger(maxTokens, 'retained message token budget');
  let estimatedTokens = 0;
  const retained: CanonicalJsonValue[] = [];
  for (const item of [...input].reverse()) {
    if (!isRetainableMessage(item) || remaining === 0) continue;
    const tokens = estimateMessageTextTokens(item);
    if (tokens <= remaining) {
      retained.push(item);
      remaining -= tokens;
      estimatedTokens += tokens;
    } else {
      const truncated = truncateMessage(item, remaining);
      if (truncated) {
        retained.push(truncated);
        estimatedTokens += remaining;
        remaining = 0;
      }
    }
  }
  retained.reverse();
  return { items: retained, estimatedTokens };
}

function isRetainableMessage(value: CanonicalJsonValue): value is Record<string, CanonicalJsonValue> {
  return Boolean(
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    value.type === 'message' &&
    typeof value.role === 'string' && ['user', 'developer', 'system'].includes(value.role),
  );
}

function estimateMessageTextTokens(value: Record<string, CanonicalJsonValue>) {
  return Math.max(1, Math.ceil(Buffer.byteLength(messageText(value), 'utf8') / 4));
}

function messageText(value: Record<string, CanonicalJsonValue>) {
  const content = value.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const text = item.text;
    return typeof text === 'string' ? [text] : [];
  }).join('\n');
}

function truncateMessage(
  value: Record<string, CanonicalJsonValue>,
  maxTokens: number,
): CanonicalJsonValue | null {
  if (maxTokens <= 0) return null;
  const budget = maxTokens * 4;
  const content = value.content;
  if (typeof content === 'string') {
    return { ...value, content: truncateText(content, budget) };
  }
  if (!Array.isArray(content)) return null;
  let remaining = budget;
  const truncated: CanonicalJsonValue[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
    if (typeof block.text !== 'string') {
      truncated.push(block);
      continue;
    }
    if (remaining <= 0) continue;
    const text = truncateText(block.text, remaining);
    truncated.push({ ...block, text });
    remaining -= Buffer.byteLength(text, 'utf8');
  }
  return truncated.length > 0 ? { ...value, content: truncated } : null;
}

function truncateText(value: string, maxBytes: number) {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.byteLength <= maxBytes) return value;
  if (maxBytes <= 32) return bytes.subarray(0, maxBytes).toString('utf8');
  const marker = '\n… retained message truncated …\n';
  const markerBytes = Buffer.byteLength(marker, 'utf8');
  const contentBudget = Math.max(0, maxBytes - markerBytes);
  const head = Math.ceil(contentBudget / 2);
  const tail = Math.floor(contentBudget / 2);
  return `${bytes.subarray(0, head).toString('utf8')}${marker}${bytes.subarray(bytes.length - tail).toString('utf8')}`;
}

function providerRequest(payload: unknown): Record<string, CanonicalJsonValue> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TypeError('OpenAI provider payload must be an object.');
  }
  return JSON.parse(canonicalProviderJson(payload)) as Record<string, CanonicalJsonValue>;
}

function providerInput(request: Record<string, CanonicalJsonValue>) {
  if (!Array.isArray(request.input)) throw new TypeError('OpenAI provider payload has no input array.');
  return request.input;
}

function positiveSafeInteger(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
  return value;
}

function providerJsonHash(value: unknown) {
  return createHash('sha256').update(canonicalProviderJson(value), 'utf8').digest('hex');
}
