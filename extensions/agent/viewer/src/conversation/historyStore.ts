import { create } from 'zustand';

import {
  AGENT_RESOURCE_KEYS,
  conversationResourceKey,
  type ConversationListValue,
  type ConversationSummary,
} from '../../../shared/protocol.ts';
import type { AgentResourceInvalidation } from '../../../shared/transcript.ts';
import { AgentResourceReader } from '../ipc/resources.ts';

export type ConversationHistoryStatus = 'idle' | 'loading' | 'ready' | 'failed';

type ResourceInvalidation = Extract<AgentResourceInvalidation, { type: 'resource' }>;

type ConversationHistoryStore = {
  conversationsById: Record<string, ConversationSummary>;
  error: string | null;
  missingById: Record<string, true>;
  order: string[];
  status: ConversationHistoryStatus;
  ensureConversation: (conversationId: string, force?: boolean) => Promise<ConversationSummary | null>;
  invalidate: (invalidations: ResourceInvalidation[]) => Promise<void>;
  load: (options?: { preserveReady?: boolean }) => Promise<void>;
  resetReader: () => void;
};

const reader = new AgentResourceReader();
const summaryReadGeneration = new Map<string, number>();
const routeSummaryIds = new Set<string>();
let listedConversationIds = new Set<string>();
let historyReadGeneration = 0;

export const useConversationHistoryStore = create<ConversationHistoryStore>((set, get) => ({
  conversationsById: {},
  error: null,
  missingById: {},
  order: [],
  status: 'idle',
  async ensureConversation(conversationId, force = false) {
    const normalized = conversationId.trim();
    if (!normalized) return null;
    const existing = get().conversationsById[normalized] ?? null;
    if (existing && !force) {
      if (!listedConversationIds.has(normalized)) {
        routeSummaryIds.add(normalized);
        if (!get().order.includes(normalized)) {
          set((state) => ({ order: [normalized, ...state.order] }));
        }
      }
      return existing;
    }

    const generation = (summaryReadGeneration.get(normalized) ?? 0) + 1;
    summaryReadGeneration.set(normalized, generation);
    const key = conversationResourceKey(normalized);
    try {
      const update = await reader.read([key]);
      if (summaryReadGeneration.get(normalized) !== generation) {
        return get().conversationsById[normalized] ?? null;
      }
      const value = update.values.get(key);
      if (isConversationSummary(value) && value.id === normalized) {
        if (!listedConversationIds.has(normalized)) routeSummaryIds.add(normalized);
        set((state) => ({
          conversationsById: { ...state.conversationsById, [normalized]: value },
          missingById: withoutKey(state.missingById, normalized),
          order: state.order.includes(normalized) ? state.order : [normalized, ...state.order],
        }));
        return value;
      }
      if (update.missing.includes(key)) {
        routeSummaryIds.delete(normalized);
        set((state) => ({
          conversationsById: withoutKey(state.conversationsById, normalized),
          missingById: { ...state.missingById, [normalized]: true },
          order: state.order.filter((id) => id !== normalized),
        }));
        return null;
      }
      return get().conversationsById[normalized] ?? null;
    } catch {
      return get().conversationsById[normalized] ?? null;
    }
  },
  async invalidate(invalidations) {
    const refreshHistory = invalidations.some(({ key }) => key === AGENT_RESOURCE_KEYS.conversationList);
    const conversationInvalidations = invalidations.flatMap((invalidation) => {
      if (!invalidation.key.startsWith('conversation:')) return [];
      return [{
        conversationId: invalidation.key.slice('conversation:'.length),
        reason: invalidation.reason,
      }];
    });

    const tasks: Promise<unknown>[] = [];
    if (refreshHistory) tasks.push(get().load({ preserveReady: true }));
    for (const { conversationId, reason } of conversationInvalidations) {
      if (reason === 'deleted') {
        routeSummaryIds.delete(conversationId);
        set((state) => ({
          conversationsById: withoutKey(state.conversationsById, conversationId),
          missingById: { ...state.missingById, [conversationId]: true },
          order: state.order.filter((id) => id !== conversationId),
        }));
      } else {
        tasks.push(get().ensureConversation(conversationId, true));
      }
    }
    await Promise.allSettled(tasks);
  },
  async load(options = {}) {
    const generation = ++historyReadGeneration;
    set((state) => ({
      error: null,
      status: options.preserveReady && state.status === 'ready' ? 'ready' : 'loading',
    }));
    try {
      const update = await reader.read([AGENT_RESOURCE_KEYS.conversationList]);
      if (generation !== historyReadGeneration) return;
      const value = update.values.get(AGENT_RESOURCE_KEYS.conversationList);
      if (isConversationList(value)) {
        const listedIds = value.conversations.map(({ id }) => id);
        listedConversationIds = new Set(listedIds);
        for (const id of listedIds) routeSummaryIds.delete(id);
        set((state) => ({
          conversationsById: {
            ...state.conversationsById,
            ...Object.fromEntries(value.conversations.map((conversation) => [conversation.id, conversation])),
          },
          error: null,
          missingById: withoutKeys(state.missingById, listedIds),
          order: [
            ...listedIds,
            ...[...routeSummaryIds].filter((id) => Boolean(state.conversationsById[id])),
          ],
          status: 'ready',
        }));
        return;
      }
      if (update.missing.includes(AGENT_RESOURCE_KEYS.conversationList)) {
        set({ error: 'Conversation history is unavailable.', status: 'failed' });
        return;
      }
      set({ error: null, status: 'ready' });
    } catch (error) {
      if (generation !== historyReadGeneration) return;
      if (options.preserveReady && get().status === 'ready') return;
      set({ error: messageOf(error), status: 'failed' });
    }
  },
  resetReader() {
    reader.clear();
    summaryReadGeneration.clear();
    historyReadGeneration += 1;
  },
}));

function isConversationList(value: unknown): value is ConversationListValue {
  return Boolean(
    value &&
    typeof value === 'object' &&
    Array.isArray((value as ConversationListValue).conversations) &&
    (value as ConversationListValue).conversations.every(isConversationSummary) &&
    typeof (value as ConversationListValue).truncated === 'boolean',
  );
}

function isConversationSummary(value: unknown): value is ConversationSummary {
  if (!value || typeof value !== 'object') return false;
  const summary = value as Partial<ConversationSummary>;
  return typeof summary.id === 'string' &&
    typeof summary.title === 'string' &&
    typeof summary.preview === 'string' &&
    typeof summary.cwd === 'string' &&
    typeof summary.modelId === 'string' &&
    typeof summary.createdAt === 'number' &&
    typeof summary.updatedAt === 'number';
}

function withoutKey<T>(record: Record<string, T>, key: string) {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

function withoutKeys<T>(record: Record<string, T>, keys: string[]) {
  let next = record;
  for (const key of keys) next = withoutKey(next, key);
  return next;
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
