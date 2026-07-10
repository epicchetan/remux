import type {
  CodexThreadTranscriptResource,
  CodexTranscriptResourceRequest,
  CodexTranscriptResourceResult,
  CodexTranscriptResourcesReadResponse,
  CodexTranscriptTurn,
  CodexTurnResource,
  CodexWorkDetails,
  CodexWorkDetailsResource,
  CodexWorkItem,
  CodexWorkItemResource,
} from '../../shared/transcript';
import type { CodexResourceInvalidation } from '../../shared/threadCommands';
import { readTranscriptResources } from '../ipc/transcript';
import { createExternalStore } from './externalStore';
import {
  configureTranscriptLayoutResourceAdapter,
  getTranscriptLayoutState,
  reconcileTranscriptLayoutFromResources,
  resetTranscriptLayoutForThread,
  type TranscriptLayoutResourceSnapshot,
} from './layoutStore';
import {
  logTranscriptDebug,
  summarizeInvalidations,
  summarizeTranscriptTurns,
  summarizeWorkDetails,
  summarizeWorkItem,
  transcriptDebugEnabled,
} from './debug';
import { StreamingRefreshScheduler } from './streamingRefreshScheduler';
import { partitionStreamingTranscriptInvalidations } from './streamingRefreshPolicy';

export type TranscriptStatus = 'idle' | 'loading' | 'ready' | 'failed';

export type TranscriptTurnResourceEntry = {
  layoutRevision: string;
  revision: string;
  status: 'ready';
  turn: CodexTranscriptTurn;
};

type TranscriptWorkDetailsEntry =
  | {
      details: CodexWorkDetails;
      revision: string;
      status: 'ready';
    }
  | {
      details: null;
      revision: string | null;
      status: 'error' | 'loading' | 'missing';
    };

type TranscriptWorkItemEntry =
  | {
      item: CodexWorkItem;
      revision: string;
      status: 'ready';
    }
  | {
      item: null;
      revision: string | null;
      status: 'error' | 'loading' | 'missing';
    };

type WorkItemReadOutcomeStatus = 'error' | 'missing' | 'notModified' | 'ready' | 'stale';

type WorkItemReadOutcome = {
  revision: string | null;
  status: WorkItemReadOutcomeStatus;
};

type WorkItemRequestResult = {
  completedAtMs: number;
  revision: string | null;
  status: Exclude<WorkItemReadOutcomeStatus, 'stale'>;
};

type PendingTranscriptRefresh = {
  forceFullMeasure: boolean;
  generation: number;
  preserveReady: boolean;
  promise: Promise<void>;
  reject: (reason: unknown) => void;
  resolve: () => void;
  threadId: string;
  timer: ReturnType<typeof setTimeout> | null;
};

type TranscriptResourceStoreState = {
  activeThreadId: string | null;
  isWorking: boolean;
  status: TranscriptStatus;
  threadRevision: string | null;
  turnOrder: string[];
  turnResourcesById: Record<string, TranscriptTurnResourceEntry>;
  workDetailsByKey: Record<string, TranscriptWorkDetailsEntry>;
  workItemsByKey: Record<string, TranscriptWorkItemEntry>;
  workingTurnId: string | null;
  ensureWorkDetails: (input: { segmentId: string; turnId: string }) => Promise<void>;
  invalidateTranscriptResources: (invalidations: CodexResourceInvalidation[]) => Promise<void>;
  refreshActiveTranscriptResources: (options?: TranscriptRefreshOptions) => Promise<void>;
  setActiveThreadId: (activeThreadId: string | null) => Promise<void>;
};

export type TranscriptRefreshOptions = {
  forceFullMeasure?: boolean;
  preserveReady?: boolean;
};

const workDetailsRequests = new Map<string, Promise<void>>();
const workItemRequests = new Map<string, Promise<WorkItemReadOutcome>>();
const dirtyWorkItemRequestKeys = new Set<string>();
const workItemRequestResults = new Map<string, WorkItemRequestResult>();

let transcriptReadGeneration = 0;
let pendingTranscriptRefresh: PendingTranscriptRefresh | null = null;
let invalidatedTranscriptRefreshInFlight = false;
const transcriptInvalidationCoalesceMs = 32;
const streamingTurnRefreshCadenceMs = 125;
const workItemMissingRetryDelayMs = 1000;

const actions: Pick<
  TranscriptResourceStoreState,
  'ensureWorkDetails' | 'invalidateTranscriptResources' | 'refreshActiveTranscriptResources' | 'setActiveThreadId'
> = {
  ensureWorkDetails,
  invalidateTranscriptResources,
  refreshActiveTranscriptResources,
  async setActiveThreadId(activeThreadId) {
    const state = resourceStore.getState();
    if (state.activeThreadId === activeThreadId) {
      return;
    }

    cancelPendingTranscriptRefresh();
    streamingRefreshScheduler.cancelPending();
    transcriptReadGeneration += 1;
    workDetailsRequests.clear();
    workItemRequests.clear();
    dirtyWorkItemRequestKeys.clear();
    workItemRequestResults.clear();
    resetTranscriptLayoutForThread(activeThreadId);

    if (!activeThreadId) {
      resourceStore.setState(resetTranscriptResourceState());
      return;
    }

    resourceStore.setState({
      activeThreadId,
      isWorking: false,
      status: getTranscriptLayoutState().width === null ? 'idle' : 'loading',
      threadRevision: null,
      turnOrder: [],
      turnResourcesById: {},
      workDetailsByKey: {},
      workItemsByKey: {},
      workingTurnId: null,
    });

    if (getTranscriptLayoutState().width !== null) {
      await loadTranscript(activeThreadId, transcriptReadGeneration, {
        forceFullMeasure: true,
        preserveReady: false,
      });
    }
  },
};

const resourceStore = createExternalStore<TranscriptResourceStoreState>({
  ...resetTranscriptResourceState(),
  ...actions,
});

const streamingRefreshScheduler = new StreamingRefreshScheduler<CodexResourceInvalidation>({
  cadenceMs: streamingTurnRefreshCadenceMs,
  key: (invalidation) => invalidation.key,
  run: refreshStreamingTranscriptInvalidations,
});

configureTranscriptLayoutResourceAdapter({
  ensureWorkDetails,
  getSnapshot: transcriptLayoutResourceSnapshot,
  loadActiveTranscript,
});

export const useTranscriptResourceStore = resourceStore.useStore;

export function workDetailsResourceKey(threadId: string, turnId: string, segmentId: string) {
  return `workDetails:${threadId}:${turnId}:${segmentId}`;
}

export function workItemResourceKey(threadId: string, turnId: string, itemId: string) {
  return `workItem:${threadId}:${turnId}:${itemId}`;
}

export async function invalidateTranscriptResources(invalidations: CodexResourceInvalidation[]) {
  const activeThreadId = resourceStore.getState().activeThreadId;
  if (!activeThreadId) {
    return;
  }

  const shouldRefreshTranscript = invalidations.some((invalidation) =>
    invalidation.type === 'threadTranscript' && invalidation.threadId === activeThreadId);
  if (transcriptDebugEnabled()) {
    const invalidationSummary = summarizeInvalidations(invalidations);
    logTranscriptDebug(
      'invalidateTranscriptResources',
      {
        activeThreadId,
        shouldRefreshTranscript,
        ...invalidationSummary,
      },
      {
        warn:
          invalidationSummary.duplicateTurnKeys.length > 0 ||
          invalidationSummary.duplicateTurnResourceIds.length > 0 ||
          invalidationSummary.duplicateWorkItemKeys.length > 0 ||
          invalidationSummary.duplicateWorkItemResourceIds.length > 0,
      },
    );
  }

  const turnInvalidations = invalidations.filter(
    (invalidation): invalidation is Extract<CodexResourceInvalidation, { type: 'turn' }> =>
      invalidation.type === 'turn' && invalidation.threadId === activeThreadId,
  );
  const workItemInvalidations = invalidations.filter(
    (invalidation): invalidation is Extract<CodexResourceInvalidation, { type: 'workItem' }> =>
      invalidation.type === 'workItem' && invalidation.threadId === activeThreadId,
  );
  const {
    immediateWorkItemInvalidations,
    streamingInvalidations,
  } = partitionStreamingTranscriptInvalidations({
    shouldRefreshTranscript,
    turnInvalidations,
    workItemInvalidations,
  });

  if (shouldRefreshTranscript) {
    streamingRefreshScheduler.cancelPending();
  } else {
    streamingRefreshScheduler.enqueue(streamingInvalidations);
  }

  const workItemRefresh = Promise.all(immediateWorkItemInvalidations.map((invalidation) =>
    requestWorkItem(activeThreadId, invalidation.turnId, invalidation.itemId, {
      keepExistingVisible: true,
    }))).then(() => undefined);

  if (!shouldRefreshTranscript) {
    await workItemRefresh;
    return;
  }

  void workItemRefresh.catch(() => undefined);
  await scheduleInvalidatedTranscriptRefresh(activeThreadId, {
    forceFullMeasure: false,
    preserveReady: true,
  });
}

export async function refreshActiveTranscriptResources(options: TranscriptRefreshOptions = {}) {
  const activeThreadId = resourceStore.getState().activeThreadId;
  if (!activeThreadId) {
    return;
  }

  cancelPendingTranscriptRefresh();
  streamingRefreshScheduler.cancelPending();
  transcriptReadGeneration += 1;
  await loadTranscript(activeThreadId, transcriptReadGeneration, {
    forceFullMeasure: options.forceFullMeasure ?? false,
    preserveReady: options.preserveReady ?? true,
  });
}

function scheduleInvalidatedTranscriptRefresh(activeThreadId: string, options: Required<TranscriptRefreshOptions>) {
  const pending = pendingTranscriptRefresh;
  if (pending && pending.threadId === activeThreadId) {
    pending.forceFullMeasure = pending.forceFullMeasure || options.forceFullMeasure;
    pending.preserveReady = pending.preserveReady && options.preserveReady;
    return pending.promise;
  }

  cancelPendingTranscriptRefresh();

  let resolveRefresh: () => void = () => undefined;
  let rejectRefresh: (reason: unknown) => void = () => undefined;
  const promise = new Promise<void>((resolve, reject) => {
    resolveRefresh = resolve;
    rejectRefresh = reject;
  });

  transcriptReadGeneration += 1;
  pendingTranscriptRefresh = {
    forceFullMeasure: options.forceFullMeasure,
    generation: transcriptReadGeneration,
    preserveReady: options.preserveReady,
    promise,
    reject: rejectRefresh,
    resolve: resolveRefresh,
    threadId: activeThreadId,
    timer: null,
  };
  queuePendingTranscriptRefresh(transcriptInvalidationCoalesceMs);
  return promise;
}

function queuePendingTranscriptRefresh(delayMs: number) {
  const pending = pendingTranscriptRefresh;
  if (!pending || pending.timer !== null) {
    return;
  }

  pending.timer = setTimeout(() => {
    pending.timer = null;
    runPendingTranscriptRefresh();
  }, delayMs);
}

function runPendingTranscriptRefresh() {
  const pending = pendingTranscriptRefresh;
  if (!pending) {
    return;
  }

  if (invalidatedTranscriptRefreshInFlight) {
    return;
  }

  pendingTranscriptRefresh = null;
  if (resourceStore.getState().activeThreadId !== pending.threadId) {
    pending.resolve();
    return;
  }

  invalidatedTranscriptRefreshInFlight = true;
  void loadTranscript(pending.threadId, pending.generation, {
    forceFullMeasure: pending.forceFullMeasure,
    preserveReady: pending.preserveReady,
  })
    .then(pending.resolve, pending.reject)
    .finally(() => {
      invalidatedTranscriptRefreshInFlight = false;
      if (pendingTranscriptRefresh?.timer === null) {
        queuePendingTranscriptRefresh(0);
      }
    });
}

function cancelPendingTranscriptRefresh() {
  const pending = pendingTranscriptRefresh;
  if (!pending) {
    return;
  }

  if (pending.timer !== null) {
    clearTimeout(pending.timer);
  }
  pendingTranscriptRefresh = null;
  pending.resolve();
}

function resetTranscriptResourceState(): Omit<
  TranscriptResourceStoreState,
  'ensureWorkDetails' | 'invalidateTranscriptResources' | 'refreshActiveTranscriptResources' | 'setActiveThreadId'
> {
  return {
    activeThreadId: null,
    isWorking: false,
    status: 'idle',
    threadRevision: null,
    turnOrder: [],
    turnResourcesById: {},
    workDetailsByKey: {},
    workItemsByKey: {},
    workingTurnId: null,
  };
}

async function loadActiveTranscript() {
  const activeThreadId = resourceStore.getState().activeThreadId;
  if (!activeThreadId) {
    return;
  }

  await loadTranscript(activeThreadId, transcriptReadGeneration, {
    forceFullMeasure: true,
    preserveReady: false,
  });
}

async function loadTranscript(
  activeThreadId: string,
  generation: number,
  options: TranscriptRefreshOptions = {},
) {
  if (getTranscriptLayoutState().width === null) {
    return;
  }

  const state = resourceStore.getState();
  if (!options.preserveReady || state.status !== 'ready') {
    resourceStore.setState({ status: 'loading' });
  }

  try {
    const currentState = resourceStore.getState();
    const currentThreadRevision = currentState.activeThreadId === activeThreadId ? currentState.threadRevision : null;
    const threadResponse = await readTranscriptResources(activeThreadId, [
      {
        knownRevision: currentThreadRevision ?? undefined,
        type: 'threadTranscript',
      },
    ]);
    if (isStaleLoad(activeThreadId, generation)) {
      return;
    }

    const threadResource = reconcileThreadResource(threadResponse.resources[0]);
    if (!threadResource) {
      resourceStore.setState({ status: 'failed' });
      return;
    }

    const previousTurnResources = resourceStore.getState().activeThreadId === activeThreadId
      ? resourceStore.getState().turnResourcesById
      : {};
    const turnResourcesById: Record<string, TranscriptTurnResourceEntry> = {};
    const dirtyTurnIds = new Set<string>();
    const nextTurnIds = new Set(threadResource.turnOrder);
    for (const turnId of threadResource.turnOrder) {
      const previous = previousTurnResources[turnId];
      if (previous) {
        turnResourcesById[turnId] = previous;
      } else {
        dirtyTurnIds.add(turnId);
      }
    }

    for (const turnId of Object.keys(previousTurnResources)) {
      if (!nextTurnIds.has(turnId)) {
        dirtyTurnIds.add(turnId);
      }
    }

    for (const chunk of chunkArray(threadResource.turnOrder, 50)) {
      if (chunk.length === 0) {
        continue;
      }

      const requests: CodexTranscriptResourceRequest[] = chunk.map((turnId) => ({
        knownRevision: turnResourcesById[turnId]?.revision,
        turnId,
        type: 'turn',
      }));
      const response = await readTranscriptResources(activeThreadId, requests);
      if (isStaleLoad(activeThreadId, generation)) {
        return;
      }

      for (const result of response.resources) {
        const request = requests[result.requestIndex];
        if (!request || request.type !== 'turn') {
          continue;
        }

        const previous = turnResourcesById[request.turnId];
        if (result.status === 'notModified' && previous) {
          continue;
        }

        if (result.status === 'missing' || result.status === 'error') {
          delete turnResourcesById[request.turnId];
          dirtyTurnIds.add(request.turnId);
          continue;
        }

        const turnResource = parseTurnResource(result);
        if (turnResource) {
          if (turnResourcesById[turnResource.turnId]?.revision !== turnResource.revision) {
            dirtyTurnIds.add(turnResource.turnId);
          }
          turnResourcesById[turnResource.turnId] = {
            layoutRevision: turnResource.layoutRevision,
            revision: turnResource.revision,
            status: 'ready',
            turn: turnResource.turn,
          };
        }
      }
    }

    if (isStaleLoad(activeThreadId, generation)) {
      return;
    }

    const nextWorkDetailsByKey = filterWorkDetailsForTurns(
      resourceStore.getState().workDetailsByKey,
      activeThreadId,
      new Set(threadResource.turnOrder),
    );
    const nextWorkItemsByKey = filterWorkItemsForTurns(
      resourceStore.getState().workItemsByKey,
      activeThreadId,
      new Set(threadResource.turnOrder),
    );
    const turns = threadResource.turnOrder
      .map((turnId) => turnResourcesById[turnId]?.turn)
      .filter((turn): turn is CodexTranscriptTurn => Boolean(turn));
    const workingTurnId = workingTurnIdFromTurns(turns);
    if (transcriptDebugEnabled()) {
      const turnSummary = summarizeTranscriptTurns(turns);
      logTranscriptDebug(
        'transcript.loaded',
        {
          activeThreadId,
          dirtyTurnIds: Array.from(dirtyTurnIds),
          threadRevision: threadResource.revision,
          turnOrder: threadResource.turnOrder,
          turns: turnSummary,
          workingTurnId,
        },
        {
          warn: turnSummary.some((turn) =>
            turn.duplicateSegmentIds.length > 0 || turn.duplicateWorkSegmentIds.length > 0),
        },
      );
    }
    resourceStore.setState({
      activeThreadId,
      isWorking: workingTurnId !== null,
      status: 'ready',
      threadRevision: threadResource.revision,
      turnOrder: threadResource.turnOrder,
      turnResourcesById,
      workDetailsByKey: nextWorkDetailsByKey,
      workItemsByKey: nextWorkItemsByKey,
      workingTurnId,
    });
    reconcileTranscriptLayoutFromResources(transcriptLayoutResourceSnapshot(), {
      dirtyTurnIds,
      forceFullMeasure: options.forceFullMeasure ?? true,
    });
    void refreshOpenWorkDetails(activeThreadId);
  } catch {
    if (!isStaleLoad(activeThreadId, generation)) {
      markTranscriptLoadFailed(activeThreadId, options);
    }
  }
}

function markTranscriptLoadFailed(activeThreadId: string, options: TranscriptRefreshOptions) {
  const state = resourceStore.getState();
  if (
    options.preserveReady &&
    state.activeThreadId === activeThreadId &&
    state.status === 'ready'
  ) {
    if (transcriptDebugEnabled()) {
      logTranscriptDebug('transcript.refresh.failed.preserved', {
        activeThreadId,
      }, { warn: true });
    }
    return;
  }

  resourceStore.setState({ status: 'failed' });
}

function reconcileThreadResource(result: CodexTranscriptResourceResult | undefined): CodexThreadTranscriptResource | null {
  if (!result) {
    return null;
  }

  const state = resourceStore.getState();
  if (result.status === 'notModified') {
    if (!state.activeThreadId || !state.threadRevision) {
      return null;
    }

    return {
      revision: state.threadRevision,
      threadId: state.activeThreadId,
      turnOrder: state.turnOrder,
    };
  }

  if (result.status !== 'ok' || !isThreadTranscriptResource(result.value)) {
    return null;
  }

  return result.value;
}

async function refreshStreamingTranscriptInvalidations(invalidations: CodexResourceInvalidation[]) {
  const activeThreadId = resourceStore.getState().activeThreadId;
  if (!activeThreadId) {
    return;
  }

  const turnInvalidations = invalidations.filter(
    (invalidation): invalidation is Extract<CodexResourceInvalidation, { type: 'turn' }> =>
      invalidation.type === 'turn' && invalidation.threadId === activeThreadId,
  );
  const workItemInvalidations = invalidations.filter(
    (invalidation): invalidation is Extract<CodexResourceInvalidation, { type: 'workItem' }> =>
      invalidation.type === 'workItem' && invalidation.threadId === activeThreadId,
  );

  await Promise.all([
    refreshInvalidatedTurns(activeThreadId, turnInvalidations),
    Promise.all(workItemInvalidations.map((invalidation) =>
      requestWorkItem(activeThreadId, invalidation.turnId, invalidation.itemId, {
        keepExistingVisible: true,
      }))).then(() => undefined),
  ]);
}

async function refreshInvalidatedTurns(
  activeThreadId: string,
  invalidations: Extract<CodexResourceInvalidation, { type: 'turn' }>[],
) {
  if (invalidations.length === 0 || getTranscriptLayoutState().width === null) {
    return;
  }

  const turnIds = Array.from(new Set(invalidations.map((invalidation) => invalidation.turnId)));
  const state = resourceStore.getState();
  if (state.activeThreadId !== activeThreadId) {
    return;
  }

  if (state.status !== 'ready') {
    logTranscriptDebug('turn.refresh.fallback', {
      activeThreadId,
      reason: 'transcriptNotReady',
      status: state.status,
      turnIds,
    }, { warn: true });
    await scheduleInvalidatedTranscriptRefresh(activeThreadId, {
      forceFullMeasure: false,
      preserveReady: true,
    });
    return;
  }

  const loadedTurnIds = new Set(state.turnOrder);
  const unloadedTurnIds = turnIds.filter((turnId) => !loadedTurnIds.has(turnId));
  if (unloadedTurnIds.length > 0) {
    logTranscriptDebug('turn.refresh.fallback', {
      activeThreadId,
      reason: 'turnNotLoaded',
      turnIds,
      unloadedTurnIds,
    }, { warn: true });
    await scheduleInvalidatedTranscriptRefresh(activeThreadId, {
      forceFullMeasure: false,
      preserveReady: true,
    });
    return;
  }

  const requests: CodexTranscriptResourceRequest[] = turnIds.map((turnId) => ({
    knownRevision: state.turnResourcesById[turnId]?.revision,
    turnId,
    type: 'turn',
  }));

  let response: CodexTranscriptResourcesReadResponse;
  try {
    response = await readTranscriptResources(activeThreadId, requests);
  } catch {
    logTranscriptDebug('turn.refresh.fallback', {
      activeThreadId,
      reason: 'readFailed',
      turnIds,
    }, { warn: true });
    await scheduleInvalidatedTranscriptRefresh(activeThreadId, {
      forceFullMeasure: false,
      preserveReady: true,
    });
    return;
  }

  const latestState = resourceStore.getState();
  if (latestState.activeThreadId !== activeThreadId) {
    return;
  }

  if (latestState.status !== 'ready') {
    logTranscriptDebug('turn.refresh.fallback', {
      activeThreadId,
      reason: 'transcriptNoLongerReady',
      status: latestState.status,
      turnIds,
    }, { warn: true });
    await scheduleInvalidatedTranscriptRefresh(activeThreadId, {
      forceFullMeasure: false,
      preserveReady: true,
    });
    return;
  }

  const latestLoadedTurnIds = new Set(latestState.turnOrder);
  const latestUnloadedTurnIds = turnIds.filter((turnId) => !latestLoadedTurnIds.has(turnId));
  if (latestUnloadedTurnIds.length > 0) {
    logTranscriptDebug('turn.refresh.fallback', {
      activeThreadId,
      reason: 'turnNoLongerLoaded',
      turnIds,
      unloadedTurnIds: latestUnloadedTurnIds,
    }, { warn: true });
    await scheduleInvalidatedTranscriptRefresh(activeThreadId, {
      forceFullMeasure: false,
      preserveReady: true,
    });
    return;
  }

  let nextTurnResourcesById = latestState.turnResourcesById;
  const dirtyTurnIds = new Set<string>();
  const staleTurnIds = new Set<string>();
  for (const result of response.resources) {
    const request = requests[result.requestIndex];
    if (!request || request.type !== 'turn') {
      continue;
    }

    const latestRevision = latestState.turnResourcesById[request.turnId]?.revision ?? null;
    const requestRevision = request.knownRevision ?? null;
    if (latestRevision !== requestRevision) {
      staleTurnIds.add(request.turnId);
      logTranscriptDebug('turn.refresh.stale', {
        activeThreadId,
        latestRevision,
        requestRevision,
        responseRevision: result.revision ?? null,
        turnId: request.turnId,
        turnIds,
      });
      continue;
    }

    const previous = nextTurnResourcesById[request.turnId];
    if (result.status === 'notModified' && previous) {
      logTranscriptDebug('turn.notModified', {
        activeThreadId,
        knownRevision: request.knownRevision ?? null,
        turnId: request.turnId,
      });
      continue;
    }

    if (result.status !== 'ok') {
      logTranscriptDebug('turn.refresh.fallback', {
        activeThreadId,
        reason: 'turnReadNotOk',
        responseRevision: result.revision ?? null,
        status: result.status,
        turnId: request.turnId,
        turnIds,
      }, { warn: true });
      await scheduleInvalidatedTranscriptRefresh(activeThreadId, {
        forceFullMeasure: false,
        preserveReady: true,
      });
      return;
    }

    const turnResource = parseTurnResource(result);
    if (
      !turnResource ||
      turnResource.threadId !== activeThreadId ||
      turnResource.turnId !== request.turnId
    ) {
      logTranscriptDebug('turn.refresh.fallback', {
        activeThreadId,
        reason: 'turnParseMismatch',
        responseRevision: result.revision ?? null,
        responseThreadId: turnResource?.threadId ?? null,
        responseTurnId: turnResource?.turnId ?? null,
        turnId: request.turnId,
        turnIds,
      }, { warn: true });
      await scheduleInvalidatedTranscriptRefresh(activeThreadId, {
        forceFullMeasure: false,
        preserveReady: true,
      });
      return;
    }

    if (nextTurnResourcesById === latestState.turnResourcesById) {
      nextTurnResourcesById = { ...latestState.turnResourcesById };
    }
    if (
      previous?.revision !== turnResource.revision ||
      previous?.layoutRevision !== turnResource.layoutRevision
    ) {
      dirtyTurnIds.add(turnResource.turnId);
    }
    nextTurnResourcesById[turnResource.turnId] = {
      layoutRevision: turnResource.layoutRevision,
      revision: turnResource.revision,
      status: 'ready',
      turn: turnResource.turn,
    };
  }

  if (dirtyTurnIds.size === 0) {
    if (staleTurnIds.size > 0) {
      await refreshInvalidatedTurns(activeThreadId, turnInvalidationsForStaleRefresh(activeThreadId, staleTurnIds));
    }
    return;
  }

  const turns = latestState.turnOrder
    .map((turnId) => nextTurnResourcesById[turnId]?.turn)
    .filter((turn): turn is CodexTranscriptTurn => Boolean(turn));
  const workingTurnId = workingTurnIdFromTurns(turns);
  if (transcriptDebugEnabled()) {
    const turnSummary = summarizeTranscriptTurns(turns);
    logTranscriptDebug(
      'turns.refreshed',
      {
        activeThreadId,
        dirtyTurnIds: Array.from(dirtyTurnIds),
        turnIds,
        turns: turnSummary,
        workingTurnId,
      },
      {
        warn: turnSummary.some((turn) =>
          turn.duplicateSegmentIds.length > 0 || turn.duplicateWorkSegmentIds.length > 0),
      },
    );
  }
  resourceStore.setState({
    isWorking: workingTurnId !== null,
    status: 'ready',
    turnResourcesById: nextTurnResourcesById,
    workingTurnId,
  });
  reconcileTranscriptLayoutFromResources(transcriptLayoutResourceSnapshot(), {
    dirtyTurnIds,
    forceFullMeasure: false,
  });
  if (staleTurnIds.size > 0) {
    await refreshInvalidatedTurns(activeThreadId, turnInvalidationsForStaleRefresh(activeThreadId, staleTurnIds));
  }
  void refreshOpenWorkDetails(activeThreadId);
}

function turnInvalidationsForStaleRefresh(
  activeThreadId: string,
  turnIds: ReadonlySet<string>,
): Extract<CodexResourceInvalidation, { type: 'turn' }>[] {
  return Array.from(turnIds, (turnId) => ({
    key: `turn:${activeThreadId}:${turnId}`,
    reason: 'appServerEvent' as const,
    threadId: activeThreadId,
    turnId,
    type: 'turn' as const,
  }));
}

async function ensureWorkDetails({ segmentId, turnId }: { segmentId: string; turnId: string }) {
  const activeThreadId = resourceStore.getState().activeThreadId;
  if (!activeThreadId) {
    return;
  }

  return requestWorkDetails(activeThreadId, turnId, segmentId, {
    keepExistingVisible: false,
  });
}

async function refreshOpenWorkDetails(activeThreadId: string) {
  const openWorks = Object.values(getTranscriptLayoutState().disclosure.openWorkByKey);
  if (openWorks.length === 0) {
    return;
  }

  const activeState = resourceStore.getState();
  if (activeState.activeThreadId !== activeThreadId) {
    return;
  }

  await Promise.all(openWorks.map(async (openWork) => {
    const turn = activeState.turnResourcesById[openWork.turnId]?.turn;
    const segment = turn?.segments.find((item) => item.id === openWork.segmentId);
    if (segment?.type !== 'work' || !segment.hasDetails) {
      return;
    }

    await requestWorkDetails(activeThreadId, openWork.turnId, openWork.segmentId, {
      keepExistingVisible: true,
    });
  }));
}

async function requestWorkDetails(
  activeThreadId: string,
  turnId: string,
  segmentId: string,
  options: { keepExistingVisible: boolean },
) {
  const key = workDetailsResourceKey(activeThreadId, turnId, segmentId);
  const existing = resourceStore.getState().workDetailsByKey[key];
  if (existing && !options.keepExistingVisible) {
    return workDetailsRequests.get(key) ?? Promise.resolve();
  }

  const inFlight = workDetailsRequests.get(key);
  if (inFlight) {
    return inFlight;
  }

  const knownRevision = existing?.revision ?? null;
  const request = readWorkDetails(activeThreadId, turnId, segmentId, knownRevision);
  workDetailsRequests.set(key, request);

  if (!existing || !options.keepExistingVisible) {
    resourceStore.setState({
      workDetailsByKey: {
        ...resourceStore.getState().workDetailsByKey,
        [key]: {
          details: null,
          revision: knownRevision,
          status: 'loading',
        },
      },
    });
  }

  try {
    await request;
  } finally {
    workDetailsRequests.delete(key);
  }
}

async function readWorkDetails(activeThreadId: string, turnId: string, segmentId: string, knownRevision: string | null) {
  const key = workDetailsResourceKey(activeThreadId, turnId, segmentId);
  try {
    const response = await readTranscriptResources(activeThreadId, [
      {
        knownRevision: knownRevision ?? undefined,
        segmentId,
        turnId,
        type: 'workDetails',
      },
    ]);
    if (resourceStore.getState().activeThreadId !== activeThreadId) {
      return;
    }

    const result = response.resources[0];
    const existing = resourceStore.getState().workDetailsByKey[key];
    if (result?.status === 'notModified' && existing?.status === 'ready') {
      logTranscriptDebug('workDetails.notModified', {
        activeThreadId,
        key,
        knownRevision,
        segmentId,
        turnId,
      });
      return;
    }

    if (result?.status === 'missing') {
      logTranscriptDebug('workDetails.missing', {
        activeThreadId,
        key,
        knownRevision,
        revision: result.revision ?? null,
        segmentId,
        turnId,
      }, { warn: true });
      setWorkDetailsEntry(key, { details: null, revision: result.revision ?? null, status: 'missing' });
      return;
    }

    if (result?.status !== 'ok') {
      logTranscriptDebug('workDetails.error', {
        activeThreadId,
        key,
        knownRevision,
        revision: result?.revision ?? null,
        segmentId,
        status: result?.status ?? 'missingResult',
        turnId,
      }, { warn: true });
      setWorkDetailsEntry(key, { details: null, revision: result?.revision ?? null, status: 'error' });
      return;
    }

    const resource = parseWorkDetailsResource(result);
    if (!resource) {
      logTranscriptDebug('workDetails.parseError', {
        activeThreadId,
        key,
        knownRevision,
        revision: result.revision ?? null,
        segmentId,
        turnId,
      }, { warn: true });
      setWorkDetailsEntry(key, { details: null, revision: result.revision ?? null, status: 'error' });
      return;
    }

    if (transcriptDebugEnabled()) {
      const detailsSummary = summarizeWorkDetails(resource.details);
      logTranscriptDebug(
        'workDetails.ok',
        {
          activeThreadId,
          details: detailsSummary,
          key,
          knownRevision,
          responseRevision: resource.revision,
          responseSegmentId: resource.segmentId,
          segmentId,
          turnId,
        },
        {
          warn: Boolean(
            detailsSummary &&
              (
                detailsSummary.duplicateEntryIds.length > 0 ||
                detailsSummary.duplicateItemIds.length > 0 ||
                detailsSummary.duplicateRenderItemIds.length > 0
              ),
          ),
        },
      );
    }
    setWorkDetailsEntry(key, {
      details: resource.details,
      revision: resource.revision,
      status: 'ready',
    });
    await requestWorkItemsForDetails(activeThreadId, turnId, resource.details, {
      keepExistingVisible: true,
    });
  } catch {
    if (resourceStore.getState().activeThreadId === activeThreadId) {
      setWorkDetailsEntry(key, { details: null, revision: null, status: 'error' });
    }
  }
}

async function requestWorkItemsForDetails(
  activeThreadId: string,
  turnId: string,
  details: CodexWorkDetails,
  options: { keepExistingVisible: boolean },
) {
  await Promise.all(details.itemIds.map((itemId) =>
    requestWorkItem(activeThreadId, turnId, itemId, options)));
}

async function requestWorkItem(
  activeThreadId: string,
  turnId: string,
  itemId: string,
  options: { keepExistingVisible: boolean },
) {
  const key = workItemResourceKey(activeThreadId, turnId, itemId);
  const existing = resourceStore.getState().workItemsByKey[key];
  if (existing && !options.keepExistingVisible) {
    return workItemRequests.get(key) ?? Promise.resolve();
  }

  if (shouldSuppressWorkItemRequest(key, existing, options)) {
    return Promise.resolve();
  }

  const inFlight = workItemRequests.get(key);
  if (inFlight) {
    dirtyWorkItemRequestKeys.add(key);
    logTranscriptDebug('workItem.request.inFlightDirty', {
      activeThreadId,
      itemId,
      key,
      keepExistingVisible: options.keepExistingVisible,
      turnId,
    });
    return inFlight;
  }

  const knownRevision = existing?.revision ?? null;
  logTranscriptDebug('workItem.request', {
    activeThreadId,
    itemId,
    key,
    keepExistingVisible: options.keepExistingVisible,
    knownRevision,
    turnId,
  });
  const request = readWorkItem(activeThreadId, turnId, itemId, knownRevision);
  workItemRequests.set(key, request);

  if (!existing || !options.keepExistingVisible) {
    resourceStore.setState({
      workItemsByKey: {
        ...resourceStore.getState().workItemsByKey,
        [key]: {
          item: null,
          revision: knownRevision,
          status: 'loading',
        },
      },
    });
  }

  let outcome: WorkItemReadOutcome = { revision: null, status: 'error' };
  try {
    outcome = await request;
  } finally {
    workItemRequests.delete(key);
    recordWorkItemRequestResult(key, outcome);
    if (dirtyWorkItemRequestKeys.delete(key) && resourceStore.getState().activeThreadId === activeThreadId) {
      await requestWorkItem(activeThreadId, turnId, itemId, {
        keepExistingVisible: true,
      });
    }
  }
}

function shouldSuppressWorkItemRequest(
  key: string,
  existing: TranscriptWorkItemEntry | undefined,
  options: { keepExistingVisible: boolean },
) {
  if (!options.keepExistingVisible || existing?.status !== 'missing') {
    return false;
  }

  const previous = workItemRequestResults.get(key);
  if (
    previous?.status !== 'missing' ||
    previous.revision !== (existing.revision ?? null) ||
    Date.now() - previous.completedAtMs >= workItemMissingRetryDelayMs
  ) {
    return false;
  }

  logTranscriptDebug('workItem.request.suppressedMissing', {
    key,
    retryAfterMs: Math.max(0, workItemMissingRetryDelayMs - (Date.now() - previous.completedAtMs)),
    revision: previous.revision,
  });
  return true;
}

function recordWorkItemRequestResult(key: string, outcome: WorkItemReadOutcome) {
  if (outcome.status === 'stale') {
    return;
  }

  workItemRequestResults.set(key, {
    completedAtMs: Date.now(),
    revision: outcome.revision,
    status: outcome.status,
  });
}

async function readWorkItem(
  activeThreadId: string,
  turnId: string,
  itemId: string,
  knownRevision: string | null,
): Promise<WorkItemReadOutcome> {
  const key = workItemResourceKey(activeThreadId, turnId, itemId);
  try {
    const response = await readTranscriptResources(activeThreadId, [
      {
        itemId,
        knownRevision: knownRevision ?? undefined,
        turnId,
        type: 'workItem',
      },
    ]);
    if (resourceStore.getState().activeThreadId !== activeThreadId) {
      return { revision: null, status: 'stale' };
    }

    const result = response.resources[0];
    const existing = resourceStore.getState().workItemsByKey[key];
    if (result?.status === 'notModified' && existing?.status === 'ready') {
      logTranscriptDebug('workItem.notModified', {
        activeThreadId,
        itemId,
        key,
        knownRevision,
        turnId,
      });
      return { revision: knownRevision, status: 'notModified' };
    }

    if (result?.status === 'missing') {
      logTranscriptDebug('workItem.missing', {
        activeThreadId,
        itemId,
        key,
        knownRevision,
        revision: result.revision ?? null,
        turnId,
      }, { warn: true });
      setWorkItemEntry(key, { item: null, revision: result.revision ?? null, status: 'missing' });
      return { revision: result.revision ?? null, status: 'missing' };
    }

    if (result?.status !== 'ok') {
      logTranscriptDebug('workItem.error', {
        activeThreadId,
        itemId,
        key,
        knownRevision,
        revision: result?.revision ?? null,
        status: result?.status ?? 'missingResult',
        turnId,
      }, { warn: true });
      setWorkItemEntry(key, { item: null, revision: result?.revision ?? null, status: 'error' });
      return { revision: result?.revision ?? null, status: 'error' };
    }

    const resource = parseWorkItemResource(result);
    if (!resource) {
      logTranscriptDebug('workItem.parseError', {
        activeThreadId,
        itemId,
        key,
        knownRevision,
        revision: result.revision ?? null,
        turnId,
      }, { warn: true });
      setWorkItemEntry(key, { item: null, revision: result.revision ?? null, status: 'error' });
      return { revision: result.revision ?? null, status: 'error' };
    }

    if (transcriptDebugEnabled()) {
      logTranscriptDebug(
        'workItem.ok',
        {
          activeThreadId,
          item: summarizeWorkItem(resource.item),
          key,
          knownRevision,
          requestItemId: itemId,
          responseItemId: resource.itemId,
          responseRevision: resource.revision,
          resolvedItemId: resource.item.id,
          turnId,
        },
        {
          warn: resource.itemId !== itemId || resource.item.id !== itemId,
        },
      );
    }
    setWorkItemEntry(key, {
      item: resource.item,
      revision: resource.revision,
      status: 'ready',
    });
    return { revision: resource.revision, status: 'ready' };
  } catch {
    if (resourceStore.getState().activeThreadId === activeThreadId) {
      setWorkItemEntry(key, { item: null, revision: null, status: 'error' });
    }
    return { revision: null, status: 'error' };
  }
}

function setWorkDetailsEntry(key: string, entry: TranscriptWorkDetailsEntry) {
  resourceStore.setState({
    workDetailsByKey: {
      ...resourceStore.getState().workDetailsByKey,
      [key]: entry,
    },
  });
}

function setWorkItemEntry(key: string, entry: TranscriptWorkItemEntry) {
  resourceStore.setState({
    workItemsByKey: {
      ...resourceStore.getState().workItemsByKey,
      [key]: entry,
    },
  });
}

function transcriptLayoutResourceSnapshot(): TranscriptLayoutResourceSnapshot {
  const state = resourceStore.getState();
  return {
    activeThreadId: state.activeThreadId,
    status: state.status,
    turnOrder: state.turnOrder,
    turnsById: state.turnResourcesById,
  };
}

function parseTurnResource(result: CodexTranscriptResourceResult): CodexTurnResource | null {
  return result.status === 'ok' && isTurnResource(result.value) ? result.value : null;
}

function parseWorkDetailsResource(result: CodexTranscriptResourceResult): CodexWorkDetailsResource | null {
  return result.status === 'ok' && isWorkDetailsResource(result.value) ? result.value : null;
}

function parseWorkItemResource(result: CodexTranscriptResourceResult): CodexWorkItemResource | null {
  return result.status === 'ok' && isWorkItemResource(result.value) ? result.value : null;
}

function isThreadTranscriptResource(value: unknown): value is CodexThreadTranscriptResource {
  return Boolean(
    value &&
      typeof value === 'object' &&
      typeof (value as { revision?: unknown }).revision === 'string' &&
      Array.isArray((value as { turnOrder?: unknown }).turnOrder),
  );
}

function isTurnResource(value: unknown): value is CodexTurnResource {
  return Boolean(
    value &&
      typeof value === 'object' &&
      typeof (value as { revision?: unknown }).revision === 'string' &&
      typeof (value as { layoutRevision?: unknown }).layoutRevision === 'string' &&
      typeof (value as { turnId?: unknown }).turnId === 'string' &&
      (value as { turn?: unknown }).turn &&
      typeof (value as { turn: { id?: unknown } }).turn.id === 'string',
  );
}

function isWorkDetailsResource(value: unknown): value is CodexWorkDetailsResource {
  return Boolean(
    value &&
      typeof value === 'object' &&
      typeof (value as { revision?: unknown }).revision === 'string' &&
      typeof (value as { segmentId?: unknown }).segmentId === 'string' &&
      (value as { details?: unknown }).details &&
      typeof (value as { details: { revision?: unknown } }).details.revision === 'string' &&
      Array.isArray((value as { details: { itemIds?: unknown } }).details.itemIds),
  );
}

function isWorkItemResource(value: unknown): value is CodexWorkItemResource {
  return Boolean(
    value &&
      typeof value === 'object' &&
      typeof (value as { revision?: unknown }).revision === 'string' &&
      typeof (value as { itemId?: unknown }).itemId === 'string' &&
      (value as { item?: unknown }).item &&
      typeof (value as { item: { id?: unknown } }).item.id === 'string',
  );
}

function filterWorkDetailsForTurns(
  workDetailsByKey: Record<string, TranscriptWorkDetailsEntry>,
  threadId: string,
  turnIds: Set<string>,
) {
  const next: Record<string, TranscriptWorkDetailsEntry> = {};
  for (const [key, details] of Object.entries(workDetailsByKey)) {
    const parsed = parseWorkDetailsKey(key);
    if (parsed?.threadId === threadId && turnIds.has(parsed.turnId)) {
      next[key] = details;
    }
  }
  return next;
}

function filterWorkItemsForTurns(
  workItemsByKey: Record<string, TranscriptWorkItemEntry>,
  threadId: string,
  turnIds: Set<string>,
) {
  const next: Record<string, TranscriptWorkItemEntry> = {};
  for (const [key, item] of Object.entries(workItemsByKey)) {
    const parsed = parseWorkItemKey(key);
    if (parsed?.threadId === threadId && turnIds.has(parsed.turnId)) {
      next[key] = item;
    }
  }
  return next;
}

function parseWorkDetailsKey(key: string) {
  const prefix = 'workDetails:';
  if (!key.startsWith(prefix)) {
    return null;
  }

  const rest = key.slice(prefix.length);
  const firstSeparator = rest.indexOf(':');
  if (firstSeparator === -1) {
    return null;
  }

  const threadId = rest.slice(0, firstSeparator);
  const remaining = rest.slice(firstSeparator + 1);
  const secondSeparator = remaining.indexOf(':');
  if (secondSeparator === -1) {
    return null;
  }

  return {
    segmentId: remaining.slice(secondSeparator + 1),
    threadId,
    turnId: remaining.slice(0, secondSeparator),
  };
}

function parseWorkItemKey(key: string) {
  const prefix = 'workItem:';
  if (!key.startsWith(prefix)) {
    return null;
  }

  const rest = key.slice(prefix.length);
  const firstSeparator = rest.indexOf(':');
  if (firstSeparator === -1) {
    return null;
  }

  const threadId = rest.slice(0, firstSeparator);
  const remaining = rest.slice(firstSeparator + 1);
  const secondSeparator = remaining.indexOf(':');
  if (secondSeparator === -1) {
    return null;
  }

  return {
    itemId: remaining.slice(secondSeparator + 1),
    threadId,
    turnId: remaining.slice(0, secondSeparator),
  };
}

function workingTurnIdFromTurns(turns: CodexTranscriptTurn[]) {
  return turns.find((turn) => turn.status === 'inProgress')?.id ?? null;
}

function isStaleLoad(activeThreadId: string, generation: number) {
  return resourceStore.getState().activeThreadId !== activeThreadId || generation !== transcriptReadGeneration;
}

function chunkArray<T>(items: T[], size: number) {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}
