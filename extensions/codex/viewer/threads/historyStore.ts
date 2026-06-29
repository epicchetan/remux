import { useEffect, useRef, useState } from 'react';

import type {
  CodexThreadHistoryResource,
  CodexThreadResourceResult,
  CodexThreadSummary,
  CodexThreadSummaryResource,
} from '../../shared/threads';
import type { CodexResourceInvalidation } from '../../shared/threadCommands';
import { readThreadResources } from '../ipc/threadResources';

export type ThreadHistoryStatus = 'idle' | 'loading' | 'ready' | 'failed';

type ThreadHistoryStoreState = {
  backwardsCursor: string | null;
  error: string | null;
  historyRevision: string | null;
  nextCursor: string | null;
  status: ThreadHistoryStatus;
  summaryRevisionsById: Record<string, string>;
  threadOrder: string[];
  threadsById: Record<string, CodexThreadSummary>;
  ensureThreadSummary: (threadId: string) => Promise<void>;
  invalidateThreadResources: (invalidations: CodexResourceInvalidation[]) => Promise<void>;
  loadThreadHistory: (options?: { preserveReady?: boolean }) => Promise<void>;
};

type UseThreadHistoryStore = {
  <T>(selector: (state: ThreadHistoryStoreState) => T, isEqual?: (left: T, right: T) => boolean): T;
};

const listeners = new Set<() => void>();
const summaryRequests = new Map<string, Promise<void>>();
let historyReadGeneration = 0;

let state: ThreadHistoryStoreState = {
  backwardsCursor: null,
  error: null,
  historyRevision: null,
  nextCursor: null,
  status: 'idle',
  summaryRevisionsById: {},
  threadOrder: [],
  threadsById: {},
  ensureThreadSummary,
  invalidateThreadResources,
  loadThreadHistory,
};

export const useThreadHistoryStore: UseThreadHistoryStore = (selector, isEqual = Object.is) => {
  const selectedRef = useRef<{ value: ReturnType<typeof selector> } | null>(null);
  const [, setRevision] = useState(0);
  const selectorRef = useRef(selector);
  const isEqualRef = useRef(isEqual);

  selectorRef.current = selector;
  isEqualRef.current = isEqual;

  const selected = selector(state);
  if (selectedRef.current === null || !isEqualRef.current(selectedRef.current.value, selected)) {
    selectedRef.current = { value: selected };
  }

  useEffect(() => {
    const listener = () => {
      const next = selectorRef.current(state);
      if (selectedRef.current !== null && isEqualRef.current(selectedRef.current.value, next)) {
        return;
      }
      selectedRef.current = { value: next };
      setRevision((revision) => revision + 1);
    };

    listeners.add(listener);
    listener();
    return () => {
      listeners.delete(listener);
    };
  }, []);

  return selectedRef.current.value;
};

async function loadThreadHistory(options: { preserveReady?: boolean } = {}) {
  const generation = historyReadGeneration + 1;
  historyReadGeneration = generation;
  setThreadHistoryState({
    error: null,
    status: options.preserveReady && state.status === 'ready' ? state.status : 'loading',
  });

  try {
    const response = await readThreadResources([
      {
        archived: false,
        knownRevision: state.historyRevision ?? undefined,
        limit: 50,
        sortDirection: 'desc',
        sortKey: 'updated_at',
        type: 'threadHistory',
      },
    ]);

    if (generation !== historyReadGeneration) {
      return;
    }

    const result = response.resources[0];
    if (!result) {
      setThreadHistoryState({ error: 'Missing thread history response.', status: 'failed' });
      return;
    }

    if (result.status === 'notModified') {
      setThreadHistoryState({ error: null, status: 'ready' });
      return;
    }

    const resource = parseThreadHistoryResource(result);
    if (!resource) {
      setThreadHistoryState({
        error: result.reason ?? 'Could not load thread history.',
        status: 'failed',
      });
      return;
    }

    const threadsById = Object.fromEntries(resource.threads.map((thread) => [thread.id, thread]));
    setThreadHistoryState({
      backwardsCursor: resource.backwardsCursor,
      error: null,
      historyRevision: resource.revision,
      nextCursor: resource.nextCursor,
      status: 'ready',
      threadOrder: resource.threads.map((thread) => thread.id),
      threadsById,
    });
  } catch (error) {
    if (generation !== historyReadGeneration) {
      return;
    }
    if (options.preserveReady && state.status === 'ready') {
      return;
    }
    setThreadHistoryState({
      error: errorMessage(error),
      status: 'failed',
    });
  }
}

async function ensureThreadSummary(threadId: string) {
  if (!threadId || state.threadsById[threadId]) {
    return;
  }

  const existing = summaryRequests.get(threadId);
  if (existing) {
    return existing;
  }

  const request = readThreadSummary(threadId);
  summaryRequests.set(threadId, request);
  try {
    await request;
  } finally {
    summaryRequests.delete(threadId);
  }
}

export async function invalidateThreadResources(invalidations: CodexResourceInvalidation[]) {
  const shouldRefreshHistory = invalidations.some((invalidation) => invalidation.type === 'threadHistory');
  const summaryThreadIds = new Set<string>();
  for (const invalidation of invalidations) {
    if (invalidation.type === 'threadSummary') {
      summaryThreadIds.add(invalidation.threadId);
    }
  }
  const tasks: Promise<unknown>[] = [];

  if (shouldRefreshHistory) {
    tasks.push(loadThreadHistory({ preserveReady: true }));
  }

  for (const threadId of summaryThreadIds) {
    tasks.push(readThreadSummary(threadId));
  }

  await Promise.allSettled(tasks);
}

async function readThreadSummary(threadId: string) {
  const response = await readThreadResources([
    {
      knownRevision: state.summaryRevisionsById[threadId],
      threadId,
      type: 'threadSummary',
    },
  ]);
  const result = response.resources[0];
  if (result?.status === 'notModified') {
    return;
  }

  const resource = parseThreadSummaryResource(result);
  if (!resource) {
    return;
  }

  setThreadHistoryState({
    threadsById: {
      ...state.threadsById,
      [resource.thread.id]: resource.thread,
    },
    threadOrder: state.threadOrder.includes(resource.thread.id)
      ? state.threadOrder
      : [resource.thread.id, ...state.threadOrder],
    summaryRevisionsById: {
      ...state.summaryRevisionsById,
      [resource.thread.id]: resource.revision,
    },
  });
}

function parseThreadHistoryResource(result: CodexThreadResourceResult): CodexThreadHistoryResource | null {
  if (result.status !== 'ok' || !result.value || typeof result.value !== 'object') {
    return null;
  }
  const value = result.value as Partial<CodexThreadHistoryResource>;
  if (!Array.isArray(value.threads) || typeof value.revision !== 'string') {
    return null;
  }
  return {
    backwardsCursor: typeof value.backwardsCursor === 'string' ? value.backwardsCursor : null,
    nextCursor: typeof value.nextCursor === 'string' ? value.nextCursor : null,
    revision: value.revision,
    threads: value.threads.filter(isThreadSummary),
  };
}

function parseThreadSummaryResource(result: CodexThreadResourceResult | undefined): CodexThreadSummaryResource | null {
  if (!result || result.status !== 'ok' || !result.value || typeof result.value !== 'object') {
    return null;
  }
  const value = result.value as Partial<CodexThreadSummaryResource>;
  if (typeof value.revision !== 'string' || !isThreadSummary(value.thread)) {
    return null;
  }
  return {
    revision: value.revision,
    thread: value.thread,
  };
}

function isThreadSummary(value: unknown): value is CodexThreadSummary {
  return Boolean(
    value &&
      typeof value === 'object' &&
      typeof (value as CodexThreadSummary).id === 'string' &&
      typeof (value as CodexThreadSummary).title === 'string' &&
      typeof (value as CodexThreadSummary).preview === 'string' &&
      typeof (value as CodexThreadSummary).createdAt === 'number' &&
      typeof (value as CodexThreadSummary).updatedAt === 'number',
  );
}

function setThreadHistoryState(partial: Partial<ThreadHistoryStoreState>) {
  state = {
    ...state,
    ...partial,
  };
  for (const listener of listeners) {
    listener();
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
