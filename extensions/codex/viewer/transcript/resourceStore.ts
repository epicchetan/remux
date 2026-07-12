import type {
  CodexTranscriptCapabilities,
  CodexThreadTranscriptResource,
  CodexTranscriptResourceRequest,
  CodexTranscriptResourceResult,
  CodexTranscriptResourcesReadResponse,
  CodexTranscriptTurn,
  CodexTranscriptSyncResource,
  CodexTurnRenderFrame,
  CodexTurnResource,
  CodexWorkDetails,
  CodexWorkDetailsResource,
  CodexWorkItem,
  CodexWorkItemResource,
  CodexWorkGroupResource,
  CodexWorkEntryDetailResource,
} from '../../shared/transcript';
import type { CodexResourceInvalidation } from '../../shared/threadCommands';
import { readTranscriptCapabilities, readTranscriptResources } from '../ipc/transcript';
import { getHostStatusSnapshot } from '@remux/viewer-kit/host';
import { batchExternalStoreUpdates, createExternalStore } from './externalStore';
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

export type TranscriptWorkGroupEntry =
  | { resource: CodexWorkGroupResource; revision: string; status: 'ready' }
  | {
      resource: CodexWorkGroupResource | null;
      revision: string | null;
      status: 'error' | 'loading' | 'missing';
    };

export type TranscriptWorkEntryDetailEntry =
  | { resource: CodexWorkEntryDetailResource; revision: string; status: 'ready' }
  | {
      resource: CodexWorkEntryDetailResource | null;
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
  delayMs: number;
  forceFullMeasure: boolean;
  preserveReady: boolean;
  promise: Promise<void>;
  reject: (reason: unknown) => void;
  resolve: () => void;
  targetTurnId: string | null;
  threadId: string;
  timer: ReturnType<typeof setTimeout> | null;
  windowPolicy: TranscriptWindowPolicy;
};

type TranscriptResourceStoreState = {
  activeThreadId: string | null;
  allTurnOrder: string[];
  isWorking: boolean;
  status: TranscriptStatus;
  threadRevision: string | null;
  transcriptProtocolVersion: 1 | 2 | null;
  turnOrder: string[];
  turnResourcesById: Record<string, TranscriptTurnResourceEntry>;
  workDetailsByKey: Record<string, TranscriptWorkDetailsEntry>;
  workItemsByKey: Record<string, TranscriptWorkItemEntry>;
  workGroupsByKey: Record<string, TranscriptWorkGroupEntry>;
  workEntryDetailsByKey: Record<string, TranscriptWorkEntryDetailEntry>;
  window: CodexTranscriptSyncResource['window'] | null;
  workingTurnId: string | null;
  ensureWorkDetails: (input: { segmentId: string; turnId: string }) => Promise<void>;
  ensureWorkEntryDetail: (input: { groupId: string; rowId: string; segmentId: string; turnId: string }) => Promise<void>;
  ensureWorkGroup: (input: { groupId: string; segmentId: string; turnId: string }) => Promise<void>;
  ensureWorkGroups: (input: { groupIds: string[]; segmentId: string; turnId: string }) => Promise<void>;
  invalidateTranscriptResources: (invalidations: CodexResourceInvalidation[]) => Promise<void>;
  loadEarlierTranscriptResources: () => Promise<void>;
  loadLaterTranscriptResources: () => Promise<void>;
  loadTranscriptAroundTurn: (turnId: string) => Promise<void>;
  loadMoreWorkGroup: (input: { groupId: string; segmentId: string; turnId: string }) => Promise<void>;
  refreshActiveTranscriptResources: (options?: TranscriptRefreshOptions) => Promise<void>;
  setActiveThreadId: (activeThreadId: string | null) => Promise<void>;
};

export type TranscriptRefreshOptions = {
  forceFullMeasure?: boolean;
  preserveReady?: boolean;
  targetTurnId?: string | null;
  windowPolicy?: TranscriptWindowPolicy;
};

type TranscriptWindowPolicy = 'preserve' | 'tail';

type NormalizedTranscriptRefreshOptions = {
  forceFullMeasure: boolean;
  preserveReady: boolean;
  targetTurnId: string | null;
  windowPolicy: TranscriptWindowPolicy;
};

const workDetailsRequests = new Map<string, Promise<void>>();
const workGroupRequests = new Map<string, Promise<void>>();
const workEntryDetailRequests = new Map<string, Promise<void>>();
const workItemRequests = new Map<string, Promise<WorkItemReadOutcome>>();
const dirtyWorkItemRequestKeys = new Set<string>();
const workItemRequestResults = new Map<string, WorkItemRequestResult>();

let transcriptReadGeneration = 0;
let transcriptCapabilitiesPromise: Promise<1 | 2> | null = null;
let transcriptCapabilitiesGeneration: number | null = null;
let transcriptLifecycleState: 'active' | 'background' | 'inactive' = 'active';
let transcriptDirtyWhileInactive = false;
let transcriptDetailsDirtyWhileInactive = false;
let pendingTranscriptRefresh: PendingTranscriptRefresh | null = null;
let invalidatedTranscriptRefreshInFlight = false;
const transcriptInvalidationCoalesceMs = 32;
const streamingTurnRefreshCadenceMs = 125;
const workItemMissingRetryDelayMs = 1000;

const actions: Pick<
  TranscriptResourceStoreState,
  'ensureWorkDetails' | 'ensureWorkEntryDetail' | 'ensureWorkGroup' | 'ensureWorkGroups' | 'invalidateTranscriptResources' | 'loadEarlierTranscriptResources' | 'loadLaterTranscriptResources' | 'loadMoreWorkGroup' | 'loadTranscriptAroundTurn' | 'refreshActiveTranscriptResources' | 'setActiveThreadId'
> = {
  ensureWorkDetails,
  ensureWorkEntryDetail,
  ensureWorkGroup,
  ensureWorkGroups,
  invalidateTranscriptResources,
  loadEarlierTranscriptResources,
  loadLaterTranscriptResources,
  loadMoreWorkGroup,
  loadTranscriptAroundTurn,
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
    workGroupRequests.clear();
    workEntryDetailRequests.clear();
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
      allTurnOrder: [],
      isWorking: false,
      status: getTranscriptLayoutState().width === null ? 'idle' : 'loading',
      threadRevision: null,
      transcriptProtocolVersion: null,
      turnOrder: [],
      turnResourcesById: {},
      workDetailsByKey: {},
      workItemsByKey: {},
      workGroupsByKey: {},
      workEntryDetailsByKey: {},
      window: null,
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

export function workGroupResourceKey(
  threadId: string,
  turnId: string,
  segmentId: string,
  groupId: string,
) {
  return `workGroup:${threadId}:${turnId}:${segmentId}:${groupId}`;
}

export function workEntryDetailResourceKey(
  threadId: string,
  turnId: string,
  segmentId: string,
  groupId: string,
  rowId: string,
) {
  return `workEntryDetail:${threadId}:${turnId}:${segmentId}:${groupId}:${rowId}`;
}

export async function invalidateTranscriptResources(invalidations: CodexResourceInvalidation[]) {
  const activeThreadId = resourceStore.getState().activeThreadId;
  if (!activeThreadId) {
    return;
  }

  if (transcriptLifecycleState !== 'active') {
    if (invalidations.some((invalidation) =>
      'threadId' in invalidation && invalidation.threadId === activeThreadId)) {
      transcriptDirtyWhileInactive = true;
    }
    if (invalidations.some((invalidation) =>
      invalidation.type === 'transcript' && invalidation.affectsLayout === false)) {
      transcriptDetailsDirtyWhileInactive = true;
    }
    return;
  }

  const shouldRefreshTranscript = invalidations.some((invalidation) =>
    (invalidation.type === 'threadTranscript' || invalidation.type === 'transcript') &&
    invalidation.threadId === activeThreadId);
  if (resourceStore.getState().transcriptProtocolVersion === 2) {
    const renderInvalidations = invalidations.filter(
      (invalidation): invalidation is Extract<CodexResourceInvalidation, { type: 'transcript' }> =>
        invalidation.type === 'transcript' && invalidation.threadId === activeThreadId,
    );
    if (
      renderInvalidations.some((invalidation) => invalidation.affectsLayout === false) ||
      invalidations.some((invalidation) =>
        (invalidation.type === 'workGroup' || invalidation.type === 'workEntryDetail') &&
        invalidation.threadId === activeThreadId)
    ) {
      resourceStore.setState({ workEntryDetailsByKey: {} });
    }
    if (invalidations.some((invalidation) =>
      invalidation.type === 'workGroup' && invalidation.threadId === activeThreadId)) {
      resourceStore.setState({ workGroupsByKey: {} });
    }
    if (!shouldRefreshTranscript) {
      return;
    }
    const requiresImmediateOrderRefresh =
      renderInvalidations.some((invalidation) => invalidation.affectsOrder) ||
      (renderInvalidations.length === 0 && invalidations.some((invalidation) =>
        invalidation.type === 'threadTranscript' && invalidation.threadId === activeThreadId));
    // Version 2 has one authoritative sync coordinator. The intent selects
    // both the window and its cadence; it does not feed a second streaming
    // scheduler before reaching the single-flight transcript read.
    await scheduleInvalidatedTranscriptRefresh(activeThreadId, {
      forceFullMeasure: false,
      preserveReady: true,
      targetTurnId: renderInvalidations.find((invalidation) => invalidation.affectsOrder)?.turnId ?? null,
      windowPolicy: requiresImmediateOrderRefresh ? 'tail' : 'preserve',
    }, requiresImmediateOrderRefresh
      ? transcriptInvalidationCoalesceMs
      : streamingTurnRefreshCadenceMs);
    return;
  }
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
    targetTurnId: null,
    windowPolicy: 'preserve',
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
    targetTurnId: options.targetTurnId ?? null,
    windowPolicy: options.windowPolicy ?? 'tail',
  });
}

async function loadEarlierTranscriptResources() {
  const state = resourceStore.getState();
  const firstTurnId = state.turnOrder[0];
  if (
    state.transcriptProtocolVersion !== 2 ||
    !state.activeThreadId ||
    !state.window?.hasEarlier ||
    !firstTurnId ||
    invalidatedTranscriptRefreshInFlight
  ) {
    return;
  }
  transcriptReadGeneration += 1;
  const generation = transcriptReadGeneration;
  invalidatedTranscriptRefreshInFlight = true;
  try {
    await loadTranscriptV2(
      state.activeThreadId,
      generation,
      { forceFullMeasure: false, preserveReady: true },
      {
        after: Math.min(23, Math.max(0, state.turnOrder.length - 1)),
        before: 16,
        kind: 'around',
        turnId: firstTurnId,
      },
    );
  } finally {
    invalidatedTranscriptRefreshInFlight = false;
  }
}

async function loadLaterTranscriptResources() {
  const state = resourceStore.getState();
  const lastTurnId = state.turnOrder.at(-1);
  if (
    state.transcriptProtocolVersion !== 2 ||
    !state.activeThreadId ||
    !state.window?.hasLater ||
    !lastTurnId ||
    invalidatedTranscriptRefreshInFlight
  ) {
    return;
  }
  transcriptReadGeneration += 1;
  const generation = transcriptReadGeneration;
  invalidatedTranscriptRefreshInFlight = true;
  try {
    await loadTranscriptV2(
      state.activeThreadId,
      generation,
      { forceFullMeasure: false, preserveReady: true },
      {
        after: 16,
        before: Math.min(23, Math.max(0, state.turnOrder.length - 1)),
        kind: 'around',
        turnId: lastTurnId,
      },
    );
  } finally {
    invalidatedTranscriptRefreshInFlight = false;
  }
}

async function loadTranscriptAroundTurn(turnId: string) {
  const state = resourceStore.getState();
  if (
    state.transcriptProtocolVersion !== 2 ||
    !state.activeThreadId ||
    !state.allTurnOrder.includes(turnId) ||
    invalidatedTranscriptRefreshInFlight
  ) {
    return;
  }
  transcriptReadGeneration += 1;
  const generation = transcriptReadGeneration;
  invalidatedTranscriptRefreshInFlight = true;
  try {
    await loadTranscriptV2(
      state.activeThreadId,
      generation,
      { forceFullMeasure: false, preserveReady: true },
      { after: 12, before: 12, kind: 'around', turnId },
    );
  } finally {
    invalidatedTranscriptRefreshInFlight = false;
  }
}

export function setTranscriptLifecycleState(
  state: 'active' | 'background' | 'inactive',
) {
  if (transcriptLifecycleState === state) {
    return;
  }
  transcriptLifecycleState = state;
  if (state !== 'active') {
    cancelPendingTranscriptRefresh();
    streamingRefreshScheduler.cancelPending();
    transcriptReadGeneration += 1;
    return;
  }
  if (transcriptDirtyWhileInactive) {
    transcriptDirtyWhileInactive = false;
  }
  if (transcriptDetailsDirtyWhileInactive) {
    transcriptDetailsDirtyWhileInactive = false;
    resourceStore.setState({ workEntryDetailsByKey: {} });
  }
}

function scheduleInvalidatedTranscriptRefresh(
  activeThreadId: string,
  options: NormalizedTranscriptRefreshOptions,
  delayMs = transcriptInvalidationCoalesceMs,
) {
  const pending = pendingTranscriptRefresh;
  if (pending && pending.threadId === activeThreadId) {
    const nextDelayMs = Math.min(pending.delayMs, Math.max(0, delayMs));
    const scheduledTimer = pending.timer;
    const shouldRescheduleSooner = nextDelayMs < pending.delayMs && scheduledTimer !== null;
    pending.delayMs = nextDelayMs;
    pending.forceFullMeasure = pending.forceFullMeasure || options.forceFullMeasure;
    pending.preserveReady = pending.preserveReady && options.preserveReady;
    pending.targetTurnId = options.targetTurnId ?? pending.targetTurnId;
    pending.windowPolicy =
      pending.windowPolicy === 'tail' || options.windowPolicy === 'tail' ? 'tail' : 'preserve';
    if (shouldRescheduleSooner && scheduledTimer !== null) {
      clearTimeout(scheduledTimer);
      pending.timer = null;
      queuePendingTranscriptRefresh(nextDelayMs);
    }
    return pending.promise;
  }

  cancelPendingTranscriptRefresh();

  let resolveRefresh: () => void = () => undefined;
  let rejectRefresh: (reason: unknown) => void = () => undefined;
  const promise = new Promise<void>((resolve, reject) => {
    resolveRefresh = resolve;
    rejectRefresh = reject;
  });

  pendingTranscriptRefresh = {
    delayMs: Math.max(0, delayMs),
    forceFullMeasure: options.forceFullMeasure,
    preserveReady: options.preserveReady,
    promise,
    reject: rejectRefresh,
    resolve: resolveRefresh,
    targetTurnId: options.targetTurnId,
    threadId: activeThreadId,
    timer: null,
    windowPolicy: options.windowPolicy,
  };
  queuePendingTranscriptRefresh(pendingTranscriptRefresh.delayMs);
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

  // Advancing the read generation cancels an older response. Do that only
  // when this pending intent actually becomes the single in-flight sync.
  // Invalidations received while another sync is running remain queued and
  // must not make the authoritative response already on the wire stale.
  transcriptReadGeneration += 1;
  const generation = transcriptReadGeneration;
  invalidatedTranscriptRefreshInFlight = true;
  void loadTranscript(pending.threadId, generation, {
    forceFullMeasure: pending.forceFullMeasure,
    preserveReady: pending.preserveReady,
    targetTurnId: pending.targetTurnId,
    windowPolicy: pending.windowPolicy,
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
  'ensureWorkDetails' | 'ensureWorkEntryDetail' | 'ensureWorkGroup' | 'ensureWorkGroups' | 'invalidateTranscriptResources' | 'loadEarlierTranscriptResources' | 'loadLaterTranscriptResources' | 'loadMoreWorkGroup' | 'loadTranscriptAroundTurn' | 'refreshActiveTranscriptResources' | 'setActiveThreadId'
> {
  return {
    activeThreadId: null,
    allTurnOrder: [],
    isWorking: false,
    status: 'idle',
    threadRevision: null,
    transcriptProtocolVersion: null,
    turnOrder: [],
    turnResourcesById: {},
    workDetailsByKey: {},
    workItemsByKey: {},
    workGroupsByKey: {},
    workEntryDetailsByKey: {},
    window: null,
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
    const protocolVersion = await resolveTranscriptProtocolVersion();
    if (isStaleLoad(activeThreadId, generation)) {
      return;
    }
    if (protocolVersion === 2) {
      await loadTranscriptV2(activeThreadId, generation, options);
      return;
    }

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
    batchExternalStoreUpdates(() => {
      resourceStore.setState({
        activeThreadId,
        allTurnOrder: threadResource.turnOrder,
        isWorking: workingTurnId !== null,
        status: 'ready',
        threadRevision: threadResource.revision,
        transcriptProtocolVersion: 1,
        turnOrder: threadResource.turnOrder,
        turnResourcesById,
        workDetailsByKey: nextWorkDetailsByKey,
        workItemsByKey: nextWorkItemsByKey,
        workGroupsByKey: {},
        workEntryDetailsByKey: {},
        window: null,
        workingTurnId,
      });
      reconcileTranscriptLayoutFromResources(transcriptLayoutResourceSnapshot(), {
        dirtyTurnIds,
        forceFullMeasure: options.forceFullMeasure ?? true,
      });
    });
    void refreshOpenWorkDetails(activeThreadId);
  } catch {
    if (!isStaleLoad(activeThreadId, generation)) {
      markTranscriptLoadFailed(activeThreadId, options);
    }
  }
}

async function resolveTranscriptProtocolVersion(): Promise<1 | 2> {
  const status = getHostStatusSnapshot().status;
  const generation = status.type === 'connected' ? status.generation : null;
  if (generation !== transcriptCapabilitiesGeneration) {
    transcriptCapabilitiesGeneration = generation;
    transcriptCapabilitiesPromise = null;
  }
  if (!transcriptCapabilitiesPromise) {
    transcriptCapabilitiesPromise = readTranscriptCapabilities()
      .then((capabilities: CodexTranscriptCapabilities) =>
        capabilities.protocolVersions.includes(2) &&
        capabilities.projectionVersions[2] === 'turn-render-v2'
          ? 2
          : 1)
      .catch(() => 1);
  }
  return transcriptCapabilitiesPromise;
}

async function loadTranscriptV2(
  activeThreadId: string,
  generation: number,
  options: TranscriptRefreshOptions,
  windowOverride?: Extract<CodexTranscriptResourceRequest, { type: 'transcriptSync' }>['window'],
) {
  const current = resourceStore.getState();
  const currentWindowTurnIds =
    current.activeThreadId === activeThreadId && current.transcriptProtocolVersion === 2
      ? current.turnOrder
      : [];
  const firstTurnId = currentWindowTurnIds[0];
  const lastTurnId = currentWindowTurnIds.at(-1);
  const window = windowOverride ?? (
    options.windowPolicy === 'tail' || !firstTurnId || !lastTurnId
      ? {
          count: Math.min(40, Math.max(24, currentWindowTurnIds.length)),
          kind: 'tail' as const,
        }
      : { endTurnId: lastTurnId, kind: 'range' as const, startTurnId: firstTurnId }
  );
  const knownTurns = currentWindowTurnIds.flatMap((turnId) => {
    const entry = current.turnResourcesById[turnId];
    return entry ? [{ renderRevision: entry.revision, turnId }] : [];
  });
  const response = await readTranscriptResources(activeThreadId, [{
    knownThreadRevision: current.threadRevision ?? undefined,
    knownTurns,
    projectionVersion: 'turn-render-v2',
    protocolVersion: 2,
    type: 'transcriptSync',
    window,
  }]);
  if (isStaleLoad(activeThreadId, generation)) {
    return;
  }
  const result = response.resources[0];
  if (result?.status !== 'ok' || !isTranscriptSyncResource(result.value)) {
    throw new Error(result?.reason ?? 'Invalid transcript sync response');
  }
  const sync = result.value;
  if (
    options.targetTurnId &&
    !sync.window.turnIds.includes(options.targetTurnId) &&
    sync.turnOrder.includes(options.targetTurnId) &&
    window.kind !== 'around'
  ) {
    await loadTranscriptV2(
      activeThreadId,
      generation,
      options,
      { after: 12, before: 12, kind: 'around', turnId: options.targetTurnId },
    );
    return;
  }
  const previous = resourceStore.getState().turnResourcesById;
  const turnResourcesById: Record<string, TranscriptTurnResourceEntry> = {};
  const dirtyTurnIds = new Set<string>();
  for (const turnResult of sync.turns) {
    if (turnResult.status === 'notModified') {
      const existing = previous[turnResult.turnId];
      if (!existing) {
        throw new Error(`Transcript frame ${turnResult.turnId} was not modified but is not cached`);
      }
      turnResourcesById[turnResult.turnId] = existing;
      continue;
    }
    if (turnResult.status === 'error') {
      const existing = previous[turnResult.turnId];
      if (existing) {
        turnResourcesById[turnResult.turnId] = existing;
      }
      continue;
    }
    const turn = turnFromRenderFrame(turnResult.frame);
    turnResourcesById[turn.id] = {
      layoutRevision: turnResult.frame.layoutRevision,
      revision: turnResult.renderRevision,
      status: 'ready',
      turn,
    };
    if (previous[turn.id]?.layoutRevision !== turnResult.frame.layoutRevision) {
      dirtyTurnIds.add(turn.id);
    }
  }
  for (const turnId of Object.keys(previous)) {
    if (!turnResourcesById[turnId]) {
      dirtyTurnIds.add(turnId);
    }
  }

  const visibleTurnIds = new Set(sync.window.turnIds);
  const nextWorkGroups = filterResourceMapForTurns(
    resourceStore.getState().workGroupsByKey,
    'workGroup:',
    activeThreadId,
    visibleTurnIds,
  );
  const nextEntryDetails = filterResourceMapForTurns(
    resourceStore.getState().workEntryDetailsByKey,
    'workEntryDetail:',
    activeThreadId,
    visibleTurnIds,
  );
  const turns = sync.window.turnIds
    .map((turnId) => turnResourcesById[turnId]?.turn)
    .filter((turn): turn is CodexTranscriptTurn => Boolean(turn));
  const nextResourceState = {
    activeThreadId,
    allTurnOrder: sync.turnOrder,
    isWorking: sync.activeTurnId !== null,
    status: 'ready',
    threadRevision: sync.threadRevision,
    transcriptProtocolVersion: 2,
    turnOrder: sync.window.turnIds,
    turnResourcesById,
    window: sync.window,
    workDetailsByKey: {},
    workEntryDetailsByKey: nextEntryDetails,
    workGroupsByKey: nextWorkGroups,
    workItemsByKey: {},
    workingTurnId: sync.activeTurnId,
  } satisfies Partial<TranscriptResourceStoreState>;

  // Prepare and publish the complete measured presentation before exposing
  // the resource revision as ready. On initial hydration the loading frame
  // remains visible until layout is complete; on paging this is one atomic
  // layout-store update rather than a new order paired with stale rows.
  batchExternalStoreUpdates(() => {
    reconcileTranscriptLayoutFromResources({
      activeThreadId,
      status: 'ready',
      turnOrder: sync.window.turnIds,
      turnsById: turnResourcesById,
    }, {
      dirtyTurnIds,
      forceFullMeasure: options.forceFullMeasure ?? current.status !== 'ready',
    });
    resourceStore.setState(nextResourceState);
  });
  void refreshOpenWorkDetails(activeThreadId);
}

function turnFromRenderFrame(frame: CodexTurnRenderFrame): CodexTranscriptTurn {
  return {
    completedAt: frame.completedAt,
    durationMs: frame.durationMs,
    error: frame.error,
    id: frame.id,
    revision: frame.layoutRevision,
    segments: frame.segments.map((segment) =>
      segment.type === 'work'
        ? {
            ...segment,
            hasDetails: segment.timeline.length > 0,
          }
        : segment),
    startedAt: frame.startedAt,
    status: frame.status,
  };
}

function isTranscriptSyncResource(value: unknown): value is CodexTranscriptSyncResource {
  return Boolean(
    value &&
      typeof value === 'object' &&
      (value as { protocolVersion?: unknown }).protocolVersion === 2 &&
      (value as { projectionVersion?: unknown }).projectionVersion === 'turn-render-v2' &&
      Array.isArray((value as { turnOrder?: unknown }).turnOrder) &&
      Array.isArray((value as { turns?: unknown }).turns) &&
      (value as { window?: unknown }).window,
  );
}

function filterResourceMapForTurns<T>(
  resources: Record<string, T>,
  prefix: string,
  threadId: string,
  turnIds: Set<string>,
) {
  const next: Record<string, T> = {};
  for (const [key, value] of Object.entries(resources)) {
    if (!key.startsWith(prefix)) {
      continue;
    }
    const rest = key.slice(prefix.length);
    const threadPrefix = `${threadId}:`;
    if (!rest.startsWith(threadPrefix)) {
      continue;
    }
    const turnId = rest.slice(threadPrefix.length).split(':', 1)[0];
    if (turnId && turnIds.has(turnId)) {
      next[key] = value;
    }
  }
  return next;
}

function trimResourceRecord<T>(resources: Record<string, T>, maxEntries: number) {
  const entries = Object.entries(resources);
  return entries.length <= maxEntries
    ? resources
    : Object.fromEntries(entries.slice(entries.length - maxEntries)) as Record<string, T>;
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
      targetTurnId: turnIds[0] ?? null,
      windowPolicy: 'tail',
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
      targetTurnId: unloadedTurnIds[0] ?? null,
      windowPolicy: 'tail',
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
      targetTurnId: null,
      windowPolicy: 'preserve',
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
      targetTurnId: turnIds[0] ?? null,
      windowPolicy: 'tail',
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
      targetTurnId: latestUnloadedTurnIds[0] ?? null,
      windowPolicy: 'tail',
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
        targetTurnId: null,
        windowPolicy: 'preserve',
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
        targetTurnId: null,
        windowPolicy: 'preserve',
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
  batchExternalStoreUpdates(() => {
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

async function ensureWorkGroup(input: { groupId: string; segmentId: string; turnId: string }) {
  const activeThreadId = resourceStore.getState().activeThreadId;
  if (!activeThreadId) {
    return;
  }
  await requestWorkGroup(activeThreadId, input, false);
}

async function ensureWorkGroups(input: { groupIds: string[]; segmentId: string; turnId: string }) {
  const activeThreadId = resourceStore.getState().activeThreadId;
  if (!activeThreadId) return;
  const waits: Promise<void>[] = [];
  const requests = Array.from(new Set(input.groupIds)).flatMap((groupId) => {
    const key = workGroupResourceKey(activeThreadId, input.turnId, input.segmentId, groupId);
    const existing = resourceStore.getState().workGroupsByKey[key];
    if (existing?.status === 'ready') return [];
    const inFlight = workGroupRequests.get(key);
    if (inFlight) {
      waits.push(inFlight);
      return [];
    }
    return [{ existing, groupId, key }];
  });
  if (requests.length === 0) {
    await Promise.all(waits);
    return;
  }

  resourceStore.setState({
    workGroupsByKey: trimResourceRecord({
      ...resourceStore.getState().workGroupsByKey,
      ...Object.fromEntries(requests.map(({ existing, key }) => [key, {
        resource: existing?.resource ?? null,
        revision: existing?.revision ?? null,
        status: 'loading' as const,
      }])),
    }, 48),
  });

  const batch = (async () => {
    try {
      const response = await readTranscriptResources(activeThreadId, requests.map(({ existing, groupId }) => ({
        groupId,
        knownRevision: existing?.revision ?? undefined,
        protocolVersion: 2 as const,
        segmentId: input.segmentId,
        turnId: input.turnId,
        type: 'workGroup' as const,
      })));
      if (resourceStore.getState().activeThreadId !== activeThreadId) return;
      const next = { ...resourceStore.getState().workGroupsByKey };
      for (const [requestIndex, request] of requests.entries()) {
        const result = response.resources.find((resource) => resource.requestIndex === requestIndex);
        if (result?.status === 'notModified' && request.existing?.resource) {
          next[request.key] = {
            resource: request.existing.resource,
            revision: request.existing.resource.revision,
            status: 'ready',
          };
        } else if (result?.status === 'ok' && isWorkGroupResourceV2(result.value)) {
          next[request.key] = {
            resource: result.value,
            revision: result.value.revision,
            status: 'ready',
          };
        } else {
          next[request.key] = {
            resource: request.existing?.resource ?? null,
            revision: result?.revision ?? request.existing?.revision ?? null,
            status: result?.status === 'missing' ? 'missing' : 'error',
          };
        }
      }
      resourceStore.setState({ workGroupsByKey: trimResourceRecord(next, 48) });
    } catch {
      if (resourceStore.getState().activeThreadId !== activeThreadId) return;
      const next = { ...resourceStore.getState().workGroupsByKey };
      for (const request of requests) {
        next[request.key] = {
          resource: request.existing?.resource ?? null,
          revision: request.existing?.revision ?? null,
          status: 'error',
        };
      }
      resourceStore.setState({ workGroupsByKey: next });
    }
  })();
  for (const request of requests) workGroupRequests.set(request.key, batch);
  try {
    await Promise.all([...waits, batch]);
  } finally {
    for (const request of requests) {
      if (workGroupRequests.get(request.key) === batch) workGroupRequests.delete(request.key);
    }
  }
}

async function loadMoreWorkGroup(input: { groupId: string; segmentId: string; turnId: string }) {
  const state = resourceStore.getState();
  const activeThreadId = state.activeThreadId;
  if (!activeThreadId) {
    return;
  }
  const key = workGroupResourceKey(activeThreadId, input.turnId, input.segmentId, input.groupId);
  const entry = state.workGroupsByKey[key];
  if (entry?.status !== 'ready' || !entry.resource.nextCursor) {
    return;
  }
  await requestWorkGroup(activeThreadId, input, false, entry.resource.nextCursor);
}

async function requestWorkGroup(
  activeThreadId: string,
  input: { groupId: string; segmentId: string; turnId: string },
  refresh: boolean,
  cursor?: string,
) {
  const key = workGroupResourceKey(
    activeThreadId,
    input.turnId,
    input.segmentId,
    input.groupId,
  );
  const existing = resourceStore.getState().workGroupsByKey[key];
  if (existing?.status === 'ready' && !refresh && !cursor) {
    return;
  }
  const requestKey = cursor ? `${key}:page:${cursor}` : key;
  const inFlight = workGroupRequests.get(requestKey);
  if (inFlight) {
    return inFlight;
  }
  const promise = (async () => {
    if ((!existing || existing.status !== 'ready') && !cursor) {
      resourceStore.setState({
        workGroupsByKey: trimResourceRecord({
          ...resourceStore.getState().workGroupsByKey,
          [key]: {
            resource: existing?.resource ?? null,
            revision: existing?.revision ?? null,
            status: 'loading',
          },
        }, 12),
      });
    }
    try {
      const response = await readTranscriptResources(activeThreadId, [{
        cursor,
        groupId: input.groupId,
        knownRevision: cursor ? undefined : existing?.revision ?? undefined,
        protocolVersion: 2,
        segmentId: input.segmentId,
        turnId: input.turnId,
        type: 'workGroup',
      }]);
      if (resourceStore.getState().activeThreadId !== activeThreadId) {
        return;
      }
      const result = response.resources[0];
      if (result?.status === 'notModified' && existing?.resource) {
        resourceStore.setState({
          workGroupsByKey: {
            ...resourceStore.getState().workGroupsByKey,
            [key]: {
              resource: existing.resource,
              revision: existing.resource.revision,
              status: 'ready',
            },
          },
        });
        return;
      }
      if (result?.status !== 'ok' || !isWorkGroupResourceV2(result.value)) {
        if (existing?.status === 'ready') {
          return;
        }
        resourceStore.setState({
          workGroupsByKey: {
            ...resourceStore.getState().workGroupsByKey,
            [key]: {
              resource: existing?.resource ?? null,
              revision: result?.revision ?? existing?.revision ?? null,
              status: result?.status === 'missing' ? 'missing' : 'error',
            },
          },
        });
        return;
      }
      const resource = cursor && existing?.status === 'ready'
        ? {
            ...result.value,
            rows: [...existing.resource.rows, ...result.value.rows],
          }
        : result.value;
      resourceStore.setState({
        workGroupsByKey: trimResourceRecord({
          ...resourceStore.getState().workGroupsByKey,
          [key]: {
            resource,
            revision: resource.revision,
            status: 'ready',
          },
        }, 12),
      });
    } catch {
      if (resourceStore.getState().activeThreadId === activeThreadId) {
        if (existing?.status === 'ready') {
          return;
        }
        resourceStore.setState({
          workGroupsByKey: {
            ...resourceStore.getState().workGroupsByKey,
            [key]: {
              resource: existing?.resource ?? null,
              revision: existing?.revision ?? null,
              status: 'error',
            },
          },
        });
      }
    }
  })();
  workGroupRequests.set(requestKey, promise);
  try {
    await promise;
  } finally {
    workGroupRequests.delete(requestKey);
  }
}

async function ensureWorkEntryDetail(input: {
  groupId: string;
  rowId: string;
  segmentId: string;
  turnId: string;
}) {
  const activeThreadId = resourceStore.getState().activeThreadId;
  if (!activeThreadId) {
    return;
  }
  const key = workEntryDetailResourceKey(
    activeThreadId,
    input.turnId,
    input.segmentId,
    input.groupId,
    input.rowId,
  );
  const existing = resourceStore.getState().workEntryDetailsByKey[key];
  if (existing?.status === 'ready') {
    return;
  }
  const inFlight = workEntryDetailRequests.get(key);
  if (inFlight) {
    return inFlight;
  }
  const promise = (async () => {
    resourceStore.setState({
      workEntryDetailsByKey: {
        ...resourceStore.getState().workEntryDetailsByKey,
        [key]: {
          resource: existing?.resource ?? null,
          revision: existing?.revision ?? null,
          status: 'loading',
        },
      },
    });
    try {
      const response = await readTranscriptResources(activeThreadId, [{
        groupId: input.groupId,
        knownRevision: existing?.revision ?? undefined,
        protocolVersion: 2,
        rowId: input.rowId,
        segmentId: input.segmentId,
        turnId: input.turnId,
        type: 'workEntryDetail',
      }]);
      if (resourceStore.getState().activeThreadId !== activeThreadId) {
        return;
      }
      const result = response.resources[0];
      if (result?.status === 'notModified' && existing?.resource) {
        resourceStore.setState({
          workEntryDetailsByKey: {
            ...resourceStore.getState().workEntryDetailsByKey,
            [key]: {
              resource: existing.resource,
              revision: existing.resource.revision,
              status: 'ready',
            },
          },
        });
        return;
      }
      if (result?.status !== 'ok' || !isWorkEntryDetailResourceV2(result.value)) {
        resourceStore.setState({
          workEntryDetailsByKey: {
            ...resourceStore.getState().workEntryDetailsByKey,
            [key]: {
              resource: existing?.resource ?? null,
              revision: result?.revision ?? existing?.revision ?? null,
              status: result?.status === 'missing' ? 'missing' : 'error',
            },
          },
        });
        return;
      }
      resourceStore.setState({
        workEntryDetailsByKey: trimResourceRecord({
          ...resourceStore.getState().workEntryDetailsByKey,
          [key]: {
            resource: result.value,
            revision: result.value.revision,
            status: 'ready',
          },
        }, 24),
      });
    } catch {
      if (resourceStore.getState().activeThreadId === activeThreadId) {
        resourceStore.setState({
          workEntryDetailsByKey: {
            ...resourceStore.getState().workEntryDetailsByKey,
            [key]: {
              resource: existing?.resource ?? null,
              revision: existing?.revision ?? null,
              status: 'error',
            },
          },
        });
      }
    }
  })();
  workEntryDetailRequests.set(key, promise);
  try {
    await promise;
  } finally {
    workEntryDetailRequests.delete(key);
  }
}

async function ensureWorkDetails({ segmentId, turnId }: { segmentId: string; turnId: string }) {
  const state = resourceStore.getState();
  const activeThreadId = state.activeThreadId;
  if (!activeThreadId) {
    return;
  }
  if (state.transcriptProtocolVersion === 2) {
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

  if (activeState.transcriptProtocolVersion === 2) {
    const openGroupKeys = new Set<string>();
    for (const openWork of openWorks) {
      const prefix = `${openWork.segmentId}:group:`;
      for (const [disclosureId, open] of Object.entries(openWork.openChildByKey)) {
        if (!open || !disclosureId.startsWith(prefix)) {
          continue;
        }
        openGroupKeys.add(workGroupResourceKey(
          activeThreadId,
          openWork.turnId,
          openWork.segmentId,
          disclosureId.slice(prefix.length),
        ));
      }
    }
    await Promise.all(Object.values(activeState.workGroupsByKey).flatMap((entry) => {
      if (entry.status !== 'ready') {
        return [];
      }
      const resource = entry.resource;
      const key = workGroupResourceKey(
        activeThreadId,
        resource.turnId,
        resource.segmentId,
        resource.groupId,
      );
      if (!openGroupKeys.has(key)) {
        return [];
      }
      return [requestWorkGroup(activeThreadId, {
        groupId: resource.groupId,
        segmentId: resource.segmentId,
        turnId: resource.turnId,
      }, true)];
    }));
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

function isWorkGroupResourceV2(value: unknown): value is CodexWorkGroupResource {
  return Boolean(
    value &&
      typeof value === 'object' &&
      typeof (value as { groupId?: unknown }).groupId === 'string' &&
      typeof (value as { revision?: unknown }).revision === 'string' &&
      Array.isArray((value as { rows?: unknown }).rows),
  );
}

function isWorkEntryDetailResourceV2(value: unknown): value is CodexWorkEntryDetailResource {
  return Boolean(
    value &&
      typeof value === 'object' &&
      typeof (value as { rowId?: unknown }).rowId === 'string' &&
      typeof (value as { revision?: unknown }).revision === 'string' &&
      (value as { detail?: unknown }).detail,
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
