import type { CodexResourceInvalidation } from '../../shared/threadCommands';
import type {
  CodexPendingMessagePreview,
  CodexPendingQueueEntry,
  CodexPendingQueueResource,
} from '../../shared/operationQueue';
import type { CodexThreadResourceResult } from '../../shared/threads';
import { readThreadResources } from '../ipc/threadResources';
import { createExternalStore } from '../transcript/externalStore';

type QueueResourceStatus = 'idle' | 'loading' | 'ready' | 'failed';

type OperationQueueStoreState = {
  activeThreadId: string | null;
  queue: CodexPendingQueueResource | null;
  resourceStatus: QueueResourceStatus;
  setActiveThreadId: (threadId: string | null) => Promise<void>;
};

let readGeneration = 0;

const operationQueueStore = createExternalStore<OperationQueueStoreState>({
  activeThreadId: null,
  queue: null,
  resourceStatus: 'idle',
  setActiveThreadId: async (threadId) => {
    if (operationQueueStore.getState().activeThreadId === threadId) return;
    readGeneration += 1;
    operationQueueStore.setState({
      activeThreadId: threadId,
      queue: null,
      resourceStatus: threadId ? 'loading' : 'idle',
    });
    if (threadId) await loadQueue(threadId, readGeneration);
  },
});

export const useOperationQueueStore = operationQueueStore.useStore;

export async function refreshActiveOperationQueue() {
  const threadId = operationQueueStore.getState().activeThreadId;
  if (!threadId) return;
  readGeneration += 1;
  await loadQueue(threadId, readGeneration);
}

export async function invalidateOperationQueueResources(invalidations: CodexResourceInvalidation[]) {
  const threadId = operationQueueStore.getState().activeThreadId;
  if (!threadId || !invalidations.some((item) =>
    item.type === 'threadOperationQueue' && item.threadId === threadId)) return;
  await refreshActiveOperationQueue();
}

async function loadQueue(threadId: string, generation: number) {
  try {
    const current = operationQueueStore.getState();
    const response = await readThreadResources([{
      knownRevision: current.activeThreadId === threadId ? current.queue?.revision : undefined,
      threadId,
      type: 'threadOperationQueue',
    }]);
    if (generation !== readGeneration || operationQueueStore.getState().activeThreadId !== threadId) return;
    const result = response.resources[0];
    if (result?.status === 'notModified') {
      operationQueueStore.setState({ resourceStatus: 'ready' });
      return;
    }
    const queue = parseQueueResource(result);
    operationQueueStore.setState(queue
      ? { queue, resourceStatus: 'ready' }
      : { resourceStatus: 'failed' });
  } catch {
    if (generation === readGeneration) operationQueueStore.setState({ resourceStatus: 'failed' });
  }
}

function parseQueueResource(result: CodexThreadResourceResult | undefined): CodexPendingQueueResource | null {
  if (!result || result.status !== 'ok' || !result.value || typeof result.value !== 'object') return null;
  const value = result.value as Partial<CodexPendingQueueResource>;
  if (
    typeof value.threadId !== 'string' ||
    typeof value.revision !== 'string' ||
    !Array.isArray(value.entries)
  ) return null;
  const entries = value.entries.map(parseEntry);
  if (entries.some((entry) => !entry)) return null;
  return {
    entries: entries as CodexPendingQueueEntry[],
    revision: value.revision,
    threadId: value.threadId,
  };
}

function parseEntry(value: unknown): CodexPendingQueueEntry | null {
  if (!value || typeof value !== 'object') return null;
  const entry = value as Partial<CodexPendingQueueEntry>;
  if (typeof entry.id !== 'string' || typeof entry.createdAt !== 'number') return null;
  if (entry.kind === 'compact') {
    return { createdAt: entry.createdAt, id: entry.id, kind: 'compact' };
  }
  if (entry.kind !== 'message' || !parsePreview(entry.preview)) return null;
  return {
    createdAt: entry.createdAt,
    id: entry.id,
    kind: 'message',
    preview: entry.preview,
  };
}

function parsePreview(value: unknown): value is CodexPendingMessagePreview {
  if (!value || typeof value !== 'object') return false;
  const preview = value as Partial<CodexPendingMessagePreview>;
  return typeof preview.text === 'string' &&
    typeof preview.attachmentCount === 'number' &&
    typeof preview.mentionCount === 'number';
}
