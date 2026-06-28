import type {
  CodexThreadResourceResult,
  CodexThreadRuntimeError,
  CodexThreadRuntimeResource,
  CodexThreadRuntimeStatus,
} from '../../shared/threads';
import type { CodexResourceInvalidation } from '../../shared/threadCommands';
import { readThreadResources } from '../ipc/threadResources';
import { createExternalStore } from '../transcript/externalStore';

type ThreadRuntimeResourceStatus = 'idle' | 'loading' | 'ready' | 'failed';

type ThreadRuntimeRefreshOptions = {
  preserveReady?: boolean;
};

type ThreadRuntimeStoreState = {
  activeThreadId: string | null;
  activeTurnId: string | null;
  lastError: CodexThreadRuntimeError | null;
  resourceStatus: ThreadRuntimeResourceStatus;
  revision: string | null;
  status: CodexThreadRuntimeStatus;
  invalidateThreadRuntimeResources: (invalidations: CodexResourceInvalidation[]) => Promise<void>;
  setActiveThreadId: (threadId: string | null) => Promise<void>;
};

let runtimeReadGeneration = 0;

const actions: Pick<
  ThreadRuntimeStoreState,
  'invalidateThreadRuntimeResources' | 'setActiveThreadId'
> = {
  invalidateThreadRuntimeResources,
  async setActiveThreadId(threadId) {
    const state = runtimeStore.getState();
    if (state.activeThreadId === threadId) {
      return;
    }

    runtimeReadGeneration += 1;
    if (!threadId) {
      runtimeStore.setState(resetThreadRuntimeState());
      return;
    }

    runtimeStore.setState({
      activeThreadId: threadId,
      activeTurnId: null,
      lastError: null,
      resourceStatus: 'loading',
      revision: null,
      status: 'ready',
    });
    await loadThreadRuntime(threadId, runtimeReadGeneration);
  },
};

const runtimeStore = createExternalStore<ThreadRuntimeStoreState>({
  ...resetThreadRuntimeState(),
  ...actions,
});

export const useThreadRuntimeStore = runtimeStore.useStore;

export function getThreadRuntimeState() {
  return runtimeStore.getState();
}

export async function invalidateThreadRuntimeResources(invalidations: CodexResourceInvalidation[]) {
  const activeThreadId = runtimeStore.getState().activeThreadId;
  if (!activeThreadId) {
    return;
  }

  const shouldRefresh = invalidations.some((invalidation) =>
    invalidation.type === 'threadRuntime' && invalidation.threadId === activeThreadId);
  if (!shouldRefresh) {
    return;
  }

  runtimeReadGeneration += 1;
  await loadThreadRuntime(activeThreadId, runtimeReadGeneration);
}

export async function refreshActiveThreadRuntime(options: ThreadRuntimeRefreshOptions = {}) {
  const activeThreadId = runtimeStore.getState().activeThreadId;
  if (!activeThreadId) {
    return;
  }

  runtimeReadGeneration += 1;
  await loadThreadRuntime(activeThreadId, runtimeReadGeneration, {
    preserveReady: options.preserveReady ?? true,
  });
}

function resetThreadRuntimeState(): Omit<
  ThreadRuntimeStoreState,
  'invalidateThreadRuntimeResources' | 'setActiveThreadId'
> {
  return {
    activeThreadId: null,
    activeTurnId: null,
    lastError: null,
    resourceStatus: 'idle',
    revision: null,
    status: 'ready',
  };
}

async function loadThreadRuntime(
  threadId: string,
  generation: number,
  options: ThreadRuntimeRefreshOptions = {},
) {
  try {
    const knownRevision = runtimeStore.getState().activeThreadId === threadId
      ? runtimeStore.getState().revision ?? undefined
      : undefined;
    const response = await readThreadResources([
      {
        knownRevision,
        threadId,
        type: 'threadRuntime',
      },
    ]);
    if (isStaleLoad(threadId, generation)) {
      return;
    }

    const result = response.resources[0];
    if (result?.status === 'notModified') {
      runtimeStore.setState({ resourceStatus: 'ready' });
      return;
    }

    const resource = parseThreadRuntimeResource(result);
    if (!resource) {
      runtimeStore.setState({ resourceStatus: 'failed' });
      return;
    }

    runtimeStore.setState({
      activeThreadId: threadId,
      activeTurnId: resource.activeTurnId,
      lastError: resource.lastError,
      resourceStatus: 'ready',
      revision: resource.revision,
      status: resource.status,
    });
  } catch {
    if (!isStaleLoad(threadId, generation)) {
      markThreadRuntimeLoadFailed(threadId, options);
    }
  }
}

function markThreadRuntimeLoadFailed(threadId: string, options: ThreadRuntimeRefreshOptions) {
  const state = runtimeStore.getState();
  if (
    options.preserveReady &&
    state.activeThreadId === threadId &&
    state.resourceStatus === 'ready'
  ) {
    return;
  }

  runtimeStore.setState({ resourceStatus: 'failed' });
}

function parseThreadRuntimeResource(result: CodexThreadResourceResult | undefined): CodexThreadRuntimeResource | null {
  if (!result || result.status !== 'ok' || !result.value || typeof result.value !== 'object') {
    return null;
  }

  const value = result.value as Partial<CodexThreadRuntimeResource>;
  if (
    typeof value.threadId !== 'string' ||
    typeof value.revision !== 'string' ||
    !isRuntimeStatus(value.status)
  ) {
    return null;
  }

  return {
    activeTurnId: typeof value.activeTurnId === 'string' ? value.activeTurnId : null,
    lastError: parseRuntimeError(value.lastError),
    revision: value.revision,
    status: value.status,
    threadId: value.threadId,
  };
}

function parseRuntimeError(value: unknown): CodexThreadRuntimeError | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const error = value as Partial<CodexThreadRuntimeError>;
  if (typeof error.message !== 'string') {
    return null;
  }

  return {
    codexErrorInfo: typeof error.codexErrorInfo === 'string' ? error.codexErrorInfo : null,
    message: error.message,
    turnId: typeof error.turnId === 'string' ? error.turnId : null,
  };
}

function isRuntimeStatus(value: unknown): value is CodexThreadRuntimeStatus {
  return value === 'failed' || value === 'ready' || value === 'running' || value === 'stopping';
}

function isStaleLoad(threadId: string, generation: number) {
  return runtimeStore.getState().activeThreadId !== threadId || generation !== runtimeReadGeneration;
}
