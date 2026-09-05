import { getHostStatusSnapshot } from '@remux/viewer-kit/host';

import type { AgentResourceInvalidation } from '../../../shared/transcript';
import {
  AGENT_TRANSCRIPT_PROJECTION_VERSION,
  AGENT_TRANSCRIPT_PROTOCOL_VERSION,
  DEFAULT_TRANSCRIPT_PREPEND_TURNS,
  DEFAULT_TRANSCRIPT_TAIL_TURNS,
  executionScopeResourceKey,
  operationDetailResourceKey,
  type AgentTranscriptResourceResult,
  type AgentExecutionScopeResource,
  type AgentExecutionScopeRequest,
  type AgentOperationDetailResource,
  type AgentTranscriptSyncRequest,
  type AgentTranscriptSyncResource,
  type AgentTurnRenderFrame,
} from '../../../shared/transcript';
import { readTranscriptResources, transcriptNativeResourceKey } from '../ipc/transcript';
import { batchExternalStoreUpdates, createExternalStore } from './externalStore';
import {
  configureTranscriptLayoutResourceAdapter,
  getTranscriptLayoutState,
  reconcileTranscriptLayoutFromResources,
  resetTranscriptLayoutForConversation,
} from './layoutStore';
import { StreamingRefreshScheduler } from './streamingRefreshScheduler';
import { captureActiveTranscriptViewport } from './viewportStore';

export type TranscriptStatus = 'idle' | 'loading' | 'ready' | 'failed';

export type TranscriptTurnResourceEntry = {
  layoutRevision: string;
  nativeRevision: number | null;
  projectionError: { code: 'frameTooLarge' | 'projectionFailed'; message: string } | null;
  revision: string;
  status: 'ready';
  turn: AgentTurnRenderFrame;
};

export type TranscriptExecutionScopeEntry =
  | { resource: AgentExecutionScopeResource; revision: string; status: 'ready' }
  | {
      resource: AgentExecutionScopeResource | null;
      revision: string | null;
      status: 'error' | 'loading' | 'missing';
      errorCode?: 'resourceUnavailable';
    };

export type TranscriptOperationDetailEntry =
  | { resource: AgentOperationDetailResource; revision: string; status: 'ready' }
  | {
      resource: AgentOperationDetailResource | null;
      revision: string | null;
      status: 'error' | 'loading' | 'missing';
      errorCode?: 'resourceUnavailable';
    };

type TranscriptResourceStoreState = {
  activeConversationId: string | null;
  basisSequence: number | null;
  conversationRevision: string | null;
  error: string | null;
  executionScopesByKey: Record<string, TranscriptExecutionScopeEntry>;
  isWorking: boolean;
  operationDetailsByKey: Record<string, TranscriptOperationDetailEntry>;
  serverGeneration: string | null;
  status: TranscriptStatus;
  transcriptNativeKey: string | null;
  transcriptNativeRevision: number | null;
  transcriptRequestWindow: AgentTranscriptSyncRequest['window'] | null;
  turnOrder: string[];
  turnResourcesById: Record<string, TranscriptTurnResourceEntry>;
  window: AgentTranscriptSyncResource['window'] | null;
  workingTurnId: string | null;
  ensureExecutionScope: (input: ExecutionScopeInput) => Promise<void>;
  ensureOperationDetail: (input: OperationDetailInput) => Promise<void>;
  focusTranscriptTurn: (turnId: string) => Promise<boolean>;
  invalidateTranscriptResources: (
    invalidations: AgentResourceInvalidation[],
    serverGeneration?: string | null,
  ) => Promise<void>;
  loadEarlierTranscriptResources: () => Promise<void>;
  loadLaterTranscriptResources: () => Promise<void>;
  refreshActiveTranscriptResources: (options?: TranscriptRefreshOptions) => Promise<void>;
  setActiveConversationId: (conversationId: string | null) => Promise<void>;
};

type TranscriptResourceSnapshot = Pick<
  TranscriptResourceStoreState,
  | 'activeConversationId'
  | 'basisSequence'
  | 'conversationRevision'
  | 'error'
  | 'executionScopesByKey'
  | 'isWorking'
  | 'operationDetailsByKey'
  | 'serverGeneration'
  | 'status'
  | 'transcriptNativeKey'
  | 'transcriptNativeRevision'
  | 'transcriptRequestWindow'
  | 'turnOrder'
  | 'turnResourcesById'
  | 'window'
  | 'workingTurnId'
>;

type TranscriptConversationCacheEntry = {
  dirtyTurnBasisById: Map<string, number>;
  fullSyncBasisSequence: number | null;
  lastUsedAt: number;
  requiredServerGeneration: string | null;
  snapshot: TranscriptResourceSnapshot;
};

type ExecutionScopeInput = {
  scopeId: string;
  turnId: string;
  window?: AgentExecutionScopeRequest['window'];
};

type OperationDetailInput = {
  operationId: string;
  scopeId: string;
  turnId: string;
};

export type TranscriptRefreshOptions = {
  forceFullMeasure?: boolean;
  historySync?: 'if-stale' | 'force';
  preserveReady?: boolean;
  requiredBasisSequence?: number | null;
  requiredServerGeneration?: string | null;
  requiredTurnId?: string | null;
  targetTurnId?: string | null;
  windowPolicy?: 'preserve' | 'tail';
};

export type TranscriptRefreshOutcome = 'applied' | 'unavailable';

type TranscriptSyncWaiter = {
  reject: (reason: unknown) => void;
  resolve: (outcome: TranscriptRefreshOutcome) => void;
};

type PendingTranscriptSync = {
  conversationId: string;
  dueAt: number;
  options: InternalLoadOptions;
  requiredBasisSequence: number | null;
  requiredServerGeneration: string | null;
  requiredTurnIds: Set<string>;
  waiters: TranscriptSyncWaiter[];
};

let transcriptGenerationEpoch = 0;
let lifecycleState: 'active' | 'background' | 'inactive' = 'active';
let activeTranscriptSyncAbort: AbortController | null = null;
let transcriptSyncInFlight = false;
let transcriptSyncTimer: ReturnType<typeof setTimeout> | null = null;
const pendingTranscriptSyncs: PendingTranscriptSync[] = [];
const executionScopeRequests = new Map<string, Promise<void>>();
const dirtyExecutionScopeRequests = new Set<string>();
const operationDetailRequests = new Map<string, Promise<void>>();
const transcriptConversationCache = new Map<string, TranscriptConversationCacheEntry>();
const MAX_CACHED_TRANSCRIPT_CONVERSATIONS = 5;
let transcriptCacheClock = 0;

const actions: Pick<
  TranscriptResourceStoreState,
  | 'ensureExecutionScope'
  | 'ensureOperationDetail'
  | 'focusTranscriptTurn'
  | 'invalidateTranscriptResources'
  | 'loadEarlierTranscriptResources'
  | 'loadLaterTranscriptResources'
  | 'refreshActiveTranscriptResources'
  | 'setActiveConversationId'
> = {
  ensureExecutionScope,
  ensureOperationDetail,
  focusTranscriptTurn,
  invalidateTranscriptResources,
  loadEarlierTranscriptResources,
  loadLaterTranscriptResources,
  refreshActiveTranscriptResources,
  async setActiveConversationId(conversationId) {
    const state = resourceStore.getState();
    if (state.activeConversationId === conversationId) return;

    // Capture against the outgoing DOM before resetting either the resource or
    // layout stores. React effect cleanup runs after this synchronous reset and
    // the browser may already have clamped scrollTop to the replacement layout.
    captureActiveTranscriptViewport(state.activeConversationId);
    cacheTranscriptSnapshot(state);
    const cached = conversationId ? cachedTranscript(conversationId) : null;

    transcriptGenerationEpoch += 1;
    cancelActiveTranscriptSync();
    cancelPendingTranscriptSyncs();
    streamingRefreshScheduler.cancelPending();
    executionScopeRequests.clear();
    dirtyExecutionScopeRequests.clear();
    operationDetailRequests.clear();
    batchExternalStoreUpdates(() => {
      resetTranscriptLayoutForConversation(conversationId, { restoreCached: Boolean(cached) });
      if (!conversationId) {
        resourceStore.setState(resetTranscriptResourceState());
        return;
      }
      resourceStore.setState(cached
        ? {
            ...cached.snapshot,
            activeConversationId: conversationId,
            error: null,
            status: 'ready',
          }
        : {
            ...resetTranscriptResourceState(),
            activeConversationId: conversationId,
            status: getTranscriptLayoutState().width === null ? 'idle' : 'loading',
          });
      if (cached && getTranscriptLayoutState().width !== null) {
        reconcileTranscriptLayoutFromResources(layoutSnapshot(), { forceFullMeasure: false });
      }
    });
    if (!conversationId) return;
    if (cached) {
      await revalidateCachedTranscript(conversationId, cached);
    } else if (getTranscriptLayoutState().width !== null) {
        await requestTranscriptSync(conversationId, {
          forceFullMeasure: true,
          preserveReady: false,
          windowPolicy: 'tail',
        });
    }
  },
};

const resourceStore = createExternalStore<TranscriptResourceStoreState>({
  ...resetTranscriptResourceState(),
  ...actions,
});

export const useTranscriptResourceStore = resourceStore.useStore;

export function getTranscriptResourceState() {
  return resourceStore.getState();
}

function cacheTranscriptSnapshot(
  state: TranscriptResourceStoreState,
  clearInvalidationsThrough?: number,
) {
  const conversationId = state.activeConversationId;
  if (!conversationId || state.status !== 'ready') return;
  const existing = transcriptConversationCache.get(conversationId);
  const entry: TranscriptConversationCacheEntry = existing ?? {
    dirtyTurnBasisById: new Map(),
    fullSyncBasisSequence: null,
    lastUsedAt: 0,
    requiredServerGeneration: null,
    snapshot: transcriptSnapshot(state),
  };
  entry.snapshot = transcriptSnapshot(state);
  entry.lastUsedAt = nextTranscriptCacheClock();
  if (clearInvalidationsThrough !== undefined) {
    if (
      entry.fullSyncBasisSequence !== null &&
      entry.fullSyncBasisSequence <= clearInvalidationsThrough
    ) {
      entry.fullSyncBasisSequence = null;
      entry.requiredServerGeneration = null;
    }
    for (const [turnId, basisSequence] of entry.dirtyTurnBasisById) {
      if (basisSequence <= clearInvalidationsThrough) entry.dirtyTurnBasisById.delete(turnId);
    }
  }
  transcriptConversationCache.delete(conversationId);
  transcriptConversationCache.set(conversationId, entry);
  pruneTranscriptConversationCache(conversationId);
}

function cachedTranscript(conversationId: string) {
  const entry = transcriptConversationCache.get(conversationId) ?? null;
  if (!entry) return null;
  entry.lastUsedAt = nextTranscriptCacheClock();
  transcriptConversationCache.delete(conversationId);
  transcriptConversationCache.set(conversationId, entry);
  return entry;
}

function transcriptSnapshot(state: TranscriptResourceStoreState): TranscriptResourceSnapshot {
  return {
    activeConversationId: state.activeConversationId,
    basisSequence: state.basisSequence,
    conversationRevision: state.conversationRevision,
    error: state.error,
    executionScopesByKey: readyExecutionScopes(state.executionScopesByKey),
    isWorking: state.isWorking,
    operationDetailsByKey: readyOperationDetails(state.operationDetailsByKey),
    serverGeneration: state.serverGeneration,
    status: state.status,
    transcriptNativeKey: state.transcriptNativeKey,
    transcriptNativeRevision: state.transcriptNativeRevision,
    transcriptRequestWindow: state.transcriptRequestWindow,
    turnOrder: state.turnOrder,
    turnResourcesById: state.turnResourcesById,
    window: state.window,
    workingTurnId: state.workingTurnId,
  };
}

function readyExecutionScopes(entries: Record<string, TranscriptExecutionScopeEntry>) {
  return Object.fromEntries(Object.entries(entries).flatMap(([key, entry]) =>
    entry.resource
      ? [[key, { resource: entry.resource, revision: entry.resource.revision, status: 'ready' as const }]]
      : []));
}

function readyOperationDetails(entries: Record<string, TranscriptOperationDetailEntry>) {
  return Object.fromEntries(Object.entries(entries).flatMap(([key, entry]) =>
    entry.resource
      ? [[key, { resource: entry.resource, revision: entry.resource.revision, status: 'ready' as const }]]
      : []));
}

function nextTranscriptCacheClock() {
  transcriptCacheClock += 1;
  return transcriptCacheClock;
}

function pruneTranscriptConversationCache(activeConversationId: string) {
  while (transcriptConversationCache.size > MAX_CACHED_TRANSCRIPT_CONVERSATIONS) {
    const oldest = [...transcriptConversationCache.entries()]
      .filter(([conversationId]) => conversationId !== activeConversationId)
      .sort((left, right) => left[1].lastUsedAt - right[1].lastUsedAt)[0];
    if (!oldest) return;
    transcriptConversationCache.delete(oldest[0]);
  }
}

function markCachedTranscriptInvalidations(
  conversationId: string,
  invalidations: AgentResourceInvalidation[],
  serverGeneration: string,
) {
  const cached = transcriptConversationCache.get(conversationId);
  if (!cached) return;
  cached.lastUsedAt = nextTranscriptCacheClock();
  for (const invalidation of invalidations) {
    if (!('basisSequence' in invalidation)) continue;
    const generationChanged = cached.snapshot.serverGeneration !== null &&
      cached.snapshot.serverGeneration !== serverGeneration;
    if (
      !generationChanged &&
      cached.snapshot.basisSequence !== null &&
      invalidation.basisSequence <= cached.snapshot.basisSequence
    ) continue;
    if (generationChanged) cached.requiredServerGeneration = serverGeneration;
    if (
      generationChanged ||
      invalidation.type !== 'transcript' ||
      invalidation.affectsOrder ||
      !invalidation.turnId ||
      !cached.snapshot.turnResourcesById[invalidation.turnId]
    ) {
      cached.fullSyncBasisSequence = Math.max(
        cached.fullSyncBasisSequence ?? 0,
        invalidation.basisSequence,
      );
      continue;
    }
    cached.dirtyTurnBasisById.set(
      invalidation.turnId,
      Math.max(cached.dirtyTurnBasisById.get(invalidation.turnId) ?? 0, invalidation.basisSequence),
    );
  }
}

async function revalidateCachedTranscript(
  conversationId: string,
  cached: TranscriptConversationCacheEntry,
) {
  const fullSyncBasisSequence = cached.fullSyncBasisSequence;
  if (fullSyncBasisSequence !== null) {
    await requestTranscriptSync(conversationId, {
      forceFresh:
        cached.requiredServerGeneration !== null &&
        cached.requiredServerGeneration !== cached.snapshot.serverGeneration,
      preserveReady: true,
      requiredBasisSequence: fullSyncBasisSequence,
      requiredServerGeneration: cached.requiredServerGeneration,
      windowPolicy: 'tail',
    });
    return;
  }
  if (cached.dirtyTurnBasisById.size > 0) {
    await refreshInvalidatedTurns(conversationId, [...cached.dirtyTurnBasisById].map(
      ([turnId, basisSequence]): AgentResourceInvalidation => ({
        type: 'transcript',
        key: `transcript:${conversationId}`,
        conversationId,
        turnId,
        reason: 'runtimeEvent',
        affectsOrder: false,
        affectsLayout: true,
        basisSequence,
      }),
    ));
    return;
  }
  await requestTranscriptSync(conversationId, {
    preserveReady: true,
    window: cached.snapshot.transcriptRequestWindow ?? undefined,
    windowPolicy: cached.snapshot.transcriptRequestWindow ? 'preserve' : 'tail',
  });
}

export async function refreshActiveTranscriptResources(options: TranscriptRefreshOptions = {}) {
  await synchronizeActiveTranscriptResources(options);
}

export async function retryActiveTranscriptHistorySync(): Promise<TranscriptRefreshOutcome> {
  const conversationId = resourceStore.getState().activeConversationId;
  if (!conversationId) return 'unavailable';
  return requestTranscriptSync(conversationId, {
    forceFresh: true,
    historySync: 'force',
    preserveReady: true,
    windowPolicy: 'tail',
  });
}

export async function synchronizeActiveTranscriptResources(
  options: TranscriptRefreshOptions = {},
): Promise<TranscriptRefreshOutcome> {
  const conversationId = resourceStore.getState().activeConversationId;
  if (!conversationId) return 'unavailable';
  return requestTranscriptSync(conversationId, options);
}

export async function recoverActiveTranscriptResources(
  options: TranscriptRefreshOptions & {
    attempts?: number;
    revalidateDetails?: boolean;
  } = {},
) {
  const attempts = Math.max(1, options.attempts ?? 4);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (
      lifecycleState !== 'active' ||
      getHostStatusSnapshot().status.type !== 'connected'
    ) {
      return false;
    }
    const outcome = await synchronizeActiveTranscriptResources(options);
    if (outcome === 'applied') {
      if (options.revalidateDetails) await revalidateLoadedTranscriptDetails();
      return true;
    }
    if (attempt + 1 < attempts) await waitForTranscriptRetry(transcriptRetryDelay(attempt));
  }
  return false;
}

export async function invalidateTranscriptResources(
  invalidations: AgentResourceInvalidation[],
  serverGeneration?: string | null,
) {
  const current = resourceStore.getState();
  const conversationId = current.activeConversationId;
  if (!serverGeneration) return;
  cacheTranscriptSnapshot(current);
  const byConversation = new Map<string, AgentResourceInvalidation[]>();
  for (const invalidation of invalidations) {
    if (!('conversationId' in invalidation)) continue;
    const entries = byConversation.get(invalidation.conversationId) ?? [];
    entries.push(invalidation);
    byConversation.set(invalidation.conversationId, entries);
  }
  for (const [invalidatedConversationId, entries] of byConversation) {
    markCachedTranscriptInvalidations(invalidatedConversationId, entries, serverGeneration);
  }
  if (!conversationId) return;
  if (current.serverGeneration !== null && current.serverGeneration !== serverGeneration) return;
  const relevant = invalidations.filter((invalidation) =>
    'conversationId' in invalidation &&
    invalidation.conversationId === conversationId &&
    (current.basisSequence === null || invalidation.basisSequence > current.basisSequence));
  if (relevant.length === 0) return;
  const requiredBasisSequence = Math.max(...relevant.flatMap((invalidation) =>
    'basisSequence' in invalidation ? [invalidation.basisSequence] : []));
  const invalidatedTurnIds = [...new Set(relevant.flatMap((invalidation) =>
    invalidation.type === 'transcript' && invalidation.turnId ? [invalidation.turnId] : []))];

  if (lifecycleState !== 'active') {
    return;
  }

  const immediateSync = relevant.some((invalidation) =>
    invalidation.type === 'transcript' &&
    (invalidation.reason !== 'runtimeEvent' || invalidation.affectsOrder ||
      !invalidation.turnId || !current.turnResourcesById[invalidation.turnId]));
  const streamingSync = relevant.filter((invalidation) =>
    invalidation.type === 'transcript' &&
    invalidation.reason === 'runtimeEvent' &&
    !invalidation.affectsOrder);

  const workRefreshes = relevant.flatMap((invalidation) => {
    if (invalidation.type === 'executionScope') {
      const key = executionScopeResourceKey(
        invalidation.conversationId,
        invalidation.turnId,
        invalidation.scopeId,
      );
      const state = resourceStore.getState();
      const refreshes: Promise<void>[] = state.executionScopesByKey[key]
        ? [ensureExecutionScope({
            scopeId: invalidation.scopeId,
            turnId: invalidation.turnId,
          }, true)]
        : [];
      for (const detail of Object.values(state.operationDetailsByKey)) {
        if (
          detail.resource?.turnId === invalidation.turnId &&
          detail.resource.scopeId === invalidation.scopeId
        ) {
          refreshes.push(ensureOperationDetail({
            operationId: detail.resource.operationId,
            scopeId: invalidation.scopeId,
            turnId: invalidation.turnId,
          }, true));
        }
      }
      return refreshes;
    }
    return [];
  });

  if (immediateSync) {
    streamingRefreshScheduler.cancelPending({ resetCadence: false });
    await Promise.all([
      recoverActiveTranscriptResources({
        attempts: 4,
        preserveReady: true,
        requiredBasisSequence,
        requiredTurnId: relevant.flatMap((invalidation) =>
          invalidation.type === 'transcript' && invalidation.affectsOrder
            ? [invalidation.turnId]
            : []).at(0) ?? null,
        windowPolicy: 'tail',
      }),
      revalidateNativeTurnResources(invalidatedTurnIds, serverGeneration),
      ...workRefreshes,
    ]);
  } else {
    if (streamingSync.length > 0) streamingRefreshScheduler.enqueue(streamingSync);
    await Promise.all(workRefreshes);
  }
}

export function setTranscriptLifecycleState(
  state: 'active' | 'background' | 'inactive',
) {
  if (lifecycleState === state) return;
  lifecycleState = state;
  if (state === 'active') return;
  transcriptGenerationEpoch += 1;
  cancelActiveTranscriptSync();
  cancelPendingTranscriptSyncs();
  streamingRefreshScheduler.cancelPending();
  executionScopeRequests.clear();
  dirtyExecutionScopeRequests.clear();
  operationDetailRequests.clear();
  settleInterruptedScopedLoads();
}

function settleInterruptedScopedLoads() {
  const state = resourceStore.getState();
  resourceStore.setState({
    executionScopesByKey: Object.fromEntries(Object.entries(state.executionScopesByKey)
      .flatMap(([key, entry]) => entry.resource
        ? [[key, { resource: entry.resource, revision: entry.resource.revision, status: 'ready' as const }]]
        : [])),
    operationDetailsByKey: Object.fromEntries(Object.entries(state.operationDetailsByKey)
      .flatMap(([key, entry]) => entry.resource
        ? [[key, { resource: entry.resource, revision: entry.resource.revision, status: 'ready' as const }]]
        : [])),
  });
}

async function revalidateLoadedTranscriptDetails() {
  const state = resourceStore.getState();
  const scopeRefreshes = Object.values(state.executionScopesByKey).flatMap((entry) =>
    entry.resource
      ? [ensureExecutionScope({
          scopeId: entry.resource.scopeId,
          turnId: entry.resource.turnId,
        }, true)]
      : []);
  const detailRefreshes = Object.values(state.operationDetailsByKey).flatMap((entry) =>
    entry.resource
      ? [ensureOperationDetail({
          operationId: entry.resource.operationId,
          scopeId: entry.resource.scopeId,
          turnId: entry.resource.turnId,
        }, true)]
      : []);
  await Promise.allSettled([...scopeRefreshes, ...detailRefreshes]);
}

export async function revalidateNativeTurnResources(
  turnIds: readonly string[],
  serverGeneration?: string | null,
) {
  if (lifecycleState !== 'active' || turnIds.length === 0) return;
  const selected = new Set(turnIds);
  const state = resourceStore.getState();
  if (
    serverGeneration &&
    state.serverGeneration !== null &&
    state.serverGeneration !== serverGeneration
  ) return;
  const scopeRefreshes = Object.values(state.executionScopesByKey).flatMap((entry) =>
    entry.resource && selected.has(entry.resource.turnId)
      ? [ensureExecutionScope({
          scopeId: entry.resource.scopeId,
          turnId: entry.resource.turnId,
        }, true)]
      : []);
  const detailRefreshes = Object.values(state.operationDetailsByKey).flatMap((entry) =>
    entry.resource && selected.has(entry.resource.turnId)
      ? [ensureOperationDetail({
          operationId: entry.resource.operationId,
          scopeId: entry.resource.scopeId,
          turnId: entry.resource.turnId,
        }, true)]
      : []);
  await Promise.allSettled([...scopeRefreshes, ...detailRefreshes]);
}

export async function revalidateNativeExecutionResources(
  executionIds: readonly string[],
  serverGeneration?: string | null,
) {
  if (lifecycleState !== 'active' || executionIds.length === 0) return;
  const selected = new Set(executionIds.flatMap((executionId) => [
    `execution:${executionId}`,
    `federated:${executionId}`,
  ]));
  const state = resourceStore.getState();
  if (serverGeneration && state.serverGeneration !== null && state.serverGeneration !== serverGeneration) return;
  const refreshes = Object.values(state.executionScopesByKey).flatMap((entry) =>
    entry.resource && selected.has(entry.resource.scopeId)
      ? [ensureExecutionScope({
          scopeId: entry.resource.scopeId,
          turnId: entry.resource.turnId,
        }, true)]
      : []);
  await Promise.allSettled(refreshes);
}

function transcriptRetryDelay(attempt: number) {
  return [250, 750, 2_000][Math.min(attempt, 2)]!;
}

function waitForTranscriptRetry(delayMs: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, delayMs));
}

async function loadEarlierTranscriptResources() {
  const state = resourceStore.getState();
  const anchor = state.turnOrder[0];
  if (!state.activeConversationId || !anchor || !state.window?.hasEarlier) return;
  await requestTranscriptSync(state.activeConversationId, {
    preserveReady: true,
    window: {
      kind: 'around',
      turnId: anchor,
      before: DEFAULT_TRANSCRIPT_PREPEND_TURNS,
      after: Math.min(23, Math.max(0, state.turnOrder.length - 1)),
    },
  });
}

async function loadLaterTranscriptResources() {
  const state = resourceStore.getState();
  const anchor = state.turnOrder.at(-1);
  if (!state.activeConversationId || !anchor || !state.window?.hasLater) return;
  await requestTranscriptSync(state.activeConversationId, {
    preserveReady: true,
    window: {
      kind: 'around',
      turnId: anchor,
      before: Math.min(23, Math.max(0, state.turnOrder.length - 1)),
      after: DEFAULT_TRANSCRIPT_PREPEND_TURNS,
    },
  });
}

async function focusTranscriptTurn(turnId: string) {
  const state = resourceStore.getState();
  if (!state.activeConversationId) return false;
  if (state.turnResourcesById[turnId]) return true;
  const outcome = await requestTranscriptSync(state.activeConversationId, {
    preserveReady: true,
    requiredTurnId: turnId,
    targetTurnId: turnId,
  });
  return outcome === 'applied' && Boolean(resourceStore.getState().turnResourcesById[turnId]);
}

async function ensureOperationDetail(input: OperationDetailInput, force = false) {
  const conversationId = resourceStore.getState().activeConversationId;
  if (!conversationId) return;
  const key = operationDetailResourceKey(
    conversationId,
    input.turnId,
    input.scopeId,
    input.operationId,
  );
  const existing = resourceStore.getState().operationDetailsByKey[key];
  if (!force && (existing?.status === 'ready' || existing?.status === 'loading')) return;
  const pending = operationDetailRequests.get(key);
  if (pending) return pending;
  resourceStore.setState({
    operationDetailsByKey: {
      ...resourceStore.getState().operationDetailsByKey,
      [key]: {
        resource: existing?.resource ?? null,
        revision: existing?.revision ?? null,
        status: 'loading',
      },
    },
  });
  const request: Promise<void> = readOperationDetail(
    conversationId,
    input,
    existing?.revision ?? undefined,
  ).finally(() => {
    if (operationDetailRequests.get(key) === request) operationDetailRequests.delete(key);
  });
  operationDetailRequests.set(key, request);
  return request;
}

async function readOperationDetail(
  conversationId: string,
  input: OperationDetailInput,
  knownRevision?: string,
) {
  const key = operationDetailResourceKey(
    conversationId,
    input.turnId,
    input.scopeId,
    input.operationId,
  );
  const requestEpoch = transcriptGenerationEpoch;
  try {
    const response = await readTranscriptResources(conversationId, [{
      type: 'operationDetail',
      protocolVersion: AGENT_TRANSCRIPT_PROTOCOL_VERSION,
      turnId: input.turnId,
      scopeId: input.scopeId,
      operationId: input.operationId,
      ...(knownRevision ? { knownRevision } : {}),
    }], { knownServerGeneration: resourceStore.getState().serverGeneration });
    if (
      resourceStore.getState().activeConversationId !== conversationId ||
      requestEpoch !== transcriptGenerationEpoch ||
      !acceptScopedResponseGeneration(response.serverGeneration)
    ) return;
    const result = response.resources[0];
    if (result?.status === 'notModified') {
      const current = resourceStore.getState().operationDetailsByKey[key];
      if (current?.resource) setOperationDetail(key, current.resource);
      return;
    }
    const value = result?.status === 'ok' ? result.value as AgentOperationDetailResource : null;
    if (!value) {
      setOperationDetailFailure(key, result?.status === 'missing' ? 'missing' : 'error');
      return;
    }
    setOperationDetail(key, value);
  } catch {
    if (requestEpoch === transcriptGenerationEpoch) setOperationDetailFailure(key, 'error');
  }
}

async function ensureExecutionScope(input: ExecutionScopeInput, force = false) {
  const conversationId = resourceStore.getState().activeConversationId;
  if (!conversationId) return;
  const key = executionScopeResourceKey(conversationId, input.turnId, input.scopeId);
  const existing = resourceStore.getState().executionScopesByKey[key];
  if (!force && !input.window && (existing?.status === 'ready' || existing?.status === 'loading')) return;
  const pending = executionScopeRequests.get(key);
  if (pending) {
    if (force) dirtyExecutionScopeRequests.add(key);
    return pending;
  }

  resourceStore.setState({
    executionScopesByKey: {
      ...resourceStore.getState().executionScopesByKey,
      [key]: {
        resource: existing?.resource ?? null,
        revision: existing?.revision ?? null,
        status: 'loading',
      },
    },
  });
  const request: Promise<void> = readExecutionScope(
    conversationId,
    input,
    input.window ? undefined : existing?.revision ?? undefined,
    input.window ? existing?.resource ?? undefined : undefined,
  ).finally(() => {
    if (executionScopeRequests.get(key) !== request) return;
    executionScopeRequests.delete(key);
    if (dirtyExecutionScopeRequests.delete(key)) void ensureExecutionScope(input, true);
  });
  executionScopeRequests.set(key, request);
  return request;
}

async function readExecutionScope(
  conversationId: string,
  input: ExecutionScopeInput,
  knownRevision?: string,
  previous?: AgentExecutionScopeResource,
) {
  const key = executionScopeResourceKey(conversationId, input.turnId, input.scopeId);
  const requestEpoch = transcriptGenerationEpoch;
  try {
    const response = await readTranscriptResources(conversationId, [{
      type: 'executionScope',
      protocolVersion: AGENT_TRANSCRIPT_PROTOCOL_VERSION,
      turnId: input.turnId,
      scopeId: input.scopeId,
      ...(input.window ? { window: input.window } : {}),
      ...(knownRevision ? { knownRevision } : {}),
    }], { knownServerGeneration: resourceStore.getState().serverGeneration });
    if (
      resourceStore.getState().activeConversationId !== conversationId ||
      requestEpoch !== transcriptGenerationEpoch ||
      !acceptScopedResponseGeneration(response.serverGeneration)
    ) return;
    const result = response.resources[0];
    if (result?.status === 'notModified') {
      const current = resourceStore.getState().executionScopesByKey[key];
      if (current?.resource) setExecutionScope(key, current.resource);
      return;
    }
    const value = result?.status === 'ok' ? result.value as AgentExecutionScopeResource : null;
    if (!value) {
      setExecutionScopeFailure(key, result?.status === 'missing' ? 'missing' : 'error');
      return;
    }
    setExecutionScope(key, previous ? mergeExecutionScopeWindow(previous, value) : value);
  } catch {
    if (requestEpoch === transcriptGenerationEpoch) setExecutionScopeFailure(key, 'error');
  }
}

type InternalLoadOptions = TranscriptRefreshOptions & {
  forceFresh?: boolean;
  generationRetry?: number;
  signal?: AbortSignal;
  window?: AgentTranscriptSyncRequest['window'];
};

function requestTranscriptSync(
  conversationId: string,
  options: InternalLoadOptions,
  delayMs = 0,
): Promise<TranscriptRefreshOutcome> {
  if (resourceStore.getState().activeConversationId !== conversationId) {
    return Promise.resolve('unavailable');
  }

  return new Promise<TranscriptRefreshOutcome>((resolve, reject) => {
    const dueAt = Date.now() + Math.max(0, delayMs);
    const compatible = [...pendingTranscriptSyncs].reverse().find((pending) =>
      pending.conversationId === conversationId &&
      sameTranscriptWindow(pending.options.window, options.window));
    if (compatible) {
      compatible.dueAt = Math.min(compatible.dueAt, dueAt);
      compatible.options = mergeTranscriptSyncOptions(compatible.options, options);
      compatible.requiredBasisSequence = maxOptionalInteger(
        compatible.requiredBasisSequence,
        options.requiredBasisSequence,
      );
      compatible.requiredServerGeneration = options.requiredServerGeneration ??
        compatible.requiredServerGeneration;
      if (options.requiredTurnId) compatible.requiredTurnIds.add(options.requiredTurnId);
      compatible.waiters.push({ reject, resolve });
    } else {
      pendingTranscriptSyncs.push({
        conversationId,
        dueAt,
        options,
        requiredBasisSequence: options.requiredBasisSequence ?? null,
        requiredServerGeneration: options.requiredServerGeneration ?? null,
        requiredTurnIds: new Set(options.requiredTurnId ? [options.requiredTurnId] : []),
        waiters: [{ reject, resolve }],
      });
    }
    scheduleTranscriptSyncDrain();
  });
}

function scheduleTranscriptSyncDrain() {
  if (transcriptSyncInFlight || pendingTranscriptSyncs.length === 0) return;
  pendingTranscriptSyncs.sort((left, right) => left.dueAt - right.dueAt);
  const delayMs = Math.max(0, pendingTranscriptSyncs[0]!.dueAt - Date.now());
  if (transcriptSyncTimer !== null) clearTimeout(transcriptSyncTimer);
  transcriptSyncTimer = setTimeout(() => {
    transcriptSyncTimer = null;
    void drainNextTranscriptSync();
  }, delayMs);
}

async function drainNextTranscriptSync() {
  if (transcriptSyncInFlight || pendingTranscriptSyncs.length === 0) return;
  pendingTranscriptSyncs.sort((left, right) => left.dueAt - right.dueAt);
  const pending = pendingTranscriptSyncs.shift()!;
  if (pending.dueAt > Date.now()) {
    pendingTranscriptSyncs.unshift(pending);
    scheduleTranscriptSyncDrain();
    return;
  }
  if (resourceStore.getState().activeConversationId !== pending.conversationId) {
    for (const waiter of pending.waiters) waiter.resolve('unavailable');
    scheduleTranscriptSyncDrain();
    return;
  }

  transcriptSyncInFlight = true;
  const abort = new AbortController();
  activeTranscriptSyncAbort = abort;
  const requestEpoch = transcriptGenerationEpoch;
  try {
    const loaded = await loadTranscript(pending.conversationId, requestEpoch, {
      ...pending.options,
      signal: abort.signal,
    });
    const outcome = loaded === 'applied' && transcriptSyncFenceSatisfied(pending)
      ? 'applied'
      : 'unavailable';
    for (const waiter of pending.waiters) waiter.resolve(outcome);
  } catch (error) {
    for (const waiter of pending.waiters) waiter.reject(error);
  } finally {
    if (activeTranscriptSyncAbort === abort) activeTranscriptSyncAbort = null;
    transcriptSyncInFlight = false;
    scheduleTranscriptSyncDrain();
  }
}

function cancelActiveTranscriptSync() {
  activeTranscriptSyncAbort?.abort('Transcript synchronization was superseded.');
  activeTranscriptSyncAbort = null;
}

function cancelPendingTranscriptSyncs() {
  if (transcriptSyncTimer !== null) {
    clearTimeout(transcriptSyncTimer);
    transcriptSyncTimer = null;
  }
  const pending = pendingTranscriptSyncs.splice(0);
  for (const request of pending) {
    for (const waiter of request.waiters) waiter.resolve('unavailable');
  }
}

function transcriptSyncFenceSatisfied(pending: PendingTranscriptSync) {
  const state = resourceStore.getState();
  if (
    pending.requiredBasisSequence !== null &&
    (state.basisSequence === null || state.basisSequence < pending.requiredBasisSequence)
  ) return false;
  if (
    pending.requiredServerGeneration !== null &&
    state.serverGeneration !== pending.requiredServerGeneration
  ) return false;
  for (const turnId of pending.requiredTurnIds) {
    if (!state.turnResourcesById[turnId]) return false;
  }
  return true;
}

function mergeTranscriptSyncOptions(
  current: InternalLoadOptions,
  incoming: InternalLoadOptions,
): InternalLoadOptions {
  return {
    ...current,
    ...incoming,
    forceFullMeasure: Boolean(current.forceFullMeasure || incoming.forceFullMeasure),
    historySync:
      current.historySync === 'force' || incoming.historySync === 'force'
        ? 'force'
        : 'if-stale',
    preserveReady: (current.preserveReady ?? true) && (incoming.preserveReady ?? true),
    requiredBasisSequence: maxOptionalInteger(
      current.requiredBasisSequence,
      incoming.requiredBasisSequence,
    ),
    requiredServerGeneration: incoming.requiredServerGeneration ??
      current.requiredServerGeneration ?? null,
    requiredTurnId: incoming.requiredTurnId ?? current.requiredTurnId ?? null,
    targetTurnId: incoming.targetTurnId ?? current.targetTurnId ?? null,
    windowPolicy:
      current.windowPolicy === 'tail' || incoming.windowPolicy === 'tail' ? 'tail' : 'preserve',
  };
}

function maxOptionalInteger(left: number | null | undefined, right: number | null | undefined) {
  if (left === null || left === undefined) return right ?? null;
  if (right === null || right === undefined) return left;
  return Math.max(left, right);
}

function sameTranscriptWindow(
  left: AgentTranscriptSyncRequest['window'] | undefined,
  right: AgentTranscriptSyncRequest['window'] | undefined,
) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

async function loadTranscript(
  conversationId: string,
  requestEpoch: number,
  options: InternalLoadOptions,
) {
  const state = resourceStore.getState();
  const expectedServerGeneration = state.serverGeneration;
  if (!options.preserveReady || state.status !== 'ready') {
    resourceStore.setState({ status: 'loading', error: null });
  }
  const window = options.window ?? transcriptWindow(state, options);
  const nativeKey = transcriptNativeResourceKey(conversationId, window);
  const knownTurns = options.forceFresh ? [] : state.turnOrder.slice(-80).flatMap((turnId) => {
    const entry = state.turnResourcesById[turnId];
    return entry ? [{ turnId, renderRevision: entry.revision }] : [];
  });

  try {
    const response = await readTranscriptResources(conversationId, [{
      type: 'transcriptSync',
      protocolVersion: AGENT_TRANSCRIPT_PROTOCOL_VERSION,
      projectionVersion: AGENT_TRANSCRIPT_PROJECTION_VERSION,
      window,
      ...(!options.forceFresh && state.transcriptNativeKey === nativeKey &&
        state.transcriptNativeRevision !== null
        ? { knownNativeRevision: state.transcriptNativeRevision }
        : {}),
      ...(!options.forceFresh && state.conversationRevision
        ? { knownConversationRevision: state.conversationRevision }
        : {}),
      ...(knownTurns.length > 0 ? { knownTurns } : {}),
    }], {
      historySync: options.historySync ?? 'if-stale',
      knownServerGeneration: expectedServerGeneration,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (isStaleSync(conversationId, requestEpoch)) return 'unavailable' as const;
    if (
      expectedServerGeneration !== null &&
      expectedServerGeneration !== response.serverGeneration
    ) {
      transitionTranscriptGeneration(response.serverGeneration);
      if ((options.generationRetry ?? 0) >= 1) {
        markTranscriptUnavailable('The Agent server generation changed repeatedly during transcript recovery.');
        return 'unavailable' as const;
      }
      return loadTranscript(conversationId, transcriptGenerationEpoch, {
        ...options,
        forceFresh: true,
        generationRetry: (options.generationRetry ?? 0) + 1,
        preserveReady: true,
      });
    }
    const result = response.resources[0];
    const latest = resourceStore.getState();
    if (result?.status === 'notModified' && latest.status === 'ready') {
      const basisSequence = Math.max(latest.basisSequence ?? 0, result.basisSequence ?? 0);
      resourceStore.setState({
        basisSequence,
        serverGeneration: response.serverGeneration,
        transcriptNativeKey: result.key,
        transcriptNativeRevision: result.nativeRevision ?? latest.transcriptNativeRevision,
        transcriptRequestWindow: window,
      });
      cacheTranscriptSnapshot(resourceStore.getState(), basisSequence);
      return 'applied' as const;
    }
    const sync = result?.status === 'ok' ? result.value as AgentTranscriptSyncResource : null;
    if (!sync) {
      markTranscriptUnavailable(result?.reason ?? 'The Agent transcript could not be loaded.');
      return 'unavailable' as const;
    }
    applySync(sync, response.serverGeneration, options, {
      key: result.key,
      revision: result.nativeRevision ?? null,
      window,
    });
    return 'applied' as const;
  } catch (error) {
    if (!isStaleSync(conversationId, requestEpoch)) {
      if (options.preserveReady && resourceStore.getState().status === 'ready') {
        return 'unavailable' as const;
      }
      markTranscriptUnavailable(messageOf(error));
    }
    return 'unavailable' as const;
  }
}

function applySync(
  sync: AgentTranscriptSyncResource,
  serverGeneration: string,
  options: InternalLoadOptions,
  native: {
    key: string;
    revision: number | null;
    window: AgentTranscriptSyncRequest['window'];
  },
) {
  const previous = resourceStore.getState();
  if (
    previous.serverGeneration === serverGeneration &&
    previous.basisSequence !== null &&
    sync.basisSequence < previous.basisSequence
  ) return;
  const nextById: Record<string, TranscriptTurnResourceEntry> = {};
  const dirtyTurnIds = new Set<string>();
  for (const result of sync.turns) {
    if (result.status === 'ok') {
      nextById[result.turnId] = {
        layoutRevision: result.frame.layoutRevision,
        nativeRevision: null,
        projectionError: null,
        revision: result.renderRevision,
        status: 'ready',
        turn: result.frame,
      };
      if (previous.turnResourcesById[result.turnId]?.revision !== result.renderRevision) {
        if (previous.turnResourcesById[result.turnId]?.layoutRevision !== result.frame.layoutRevision) {
          dirtyTurnIds.add(result.turnId);
        }
      }
    } else if (result.status === 'notModified') {
      const known = previous.turnResourcesById[result.turnId];
      if (known) nextById[result.turnId] = known;
    } else if (result.status === 'error') {
      nextById[result.turnId] = {
        layoutRevision: result.frame.layoutRevision,
        nativeRevision: null,
        projectionError: { code: result.code, message: result.message },
        revision: result.renderRevision,
        status: 'ready',
        turn: result.frame,
      };
      dirtyTurnIds.add(result.turnId);
    }
  }
  const turnOrder = sync.turnOrder.filter((turnId) => Boolean(nextById[turnId]));
  batchExternalStoreUpdates(() => {
    resourceStore.setState({
      basisSequence: sync.basisSequence,
      conversationRevision: sync.conversationRevision,
      error: null,
      isWorking: sync.activeTurnId !== null,
      serverGeneration,
      status: 'ready',
      transcriptNativeKey: native.key,
      transcriptNativeRevision: native.revision,
      transcriptRequestWindow: native.window,
      turnOrder,
      turnResourcesById: nextById,
      window: sync.window,
      workingTurnId: sync.activeTurnId,
    });
    reconcileTranscriptLayoutFromResources(layoutSnapshot(), {
      dirtyTurnIds,
      forceFullMeasure: options.forceFullMeasure,
    });
  });
  cacheTranscriptSnapshot(resourceStore.getState(), sync.basisSequence);
}

async function refreshInvalidatedTurns(
  conversationId: string,
  invalidations: AgentResourceInvalidation[],
) {
  const requiredBasisSequence = Math.max(0, ...invalidations.flatMap((invalidation) =>
    'basisSequence' in invalidation ? [invalidation.basisSequence] : []));
  const turnIds = [...new Set(invalidations.flatMap((invalidation) =>
    invalidation.type === 'transcript' && invalidation.turnId ? [invalidation.turnId] : []))];
  const state = resourceStore.getState();
  if (
    turnIds.length === 0 ||
    state.activeConversationId !== conversationId ||
    state.status !== 'ready' ||
    turnIds.some((turnId) => !state.turnResourcesById[turnId])
  ) {
    await recoverActiveTranscriptResources({
      attempts: 4,
      preserveReady: true,
      requiredBasisSequence,
      windowPolicy: 'tail',
    });
    return;
  }

  const requested = new Map(turnIds.map((turnId) => [turnId, state.turnResourcesById[turnId]!]));
  let response: Awaited<ReturnType<typeof readTranscriptResources>>;
  try {
    [response] = await Promise.all([
      readTranscriptResources(conversationId, turnIds.map((turnId) => ({
        type: 'turn' as const,
        protocolVersion: AGENT_TRANSCRIPT_PROTOCOL_VERSION,
        turnId,
        knownRevision: requested.get(turnId)!.revision,
        ...(requested.get(turnId)!.nativeRevision === null
          ? {}
          : { knownNativeRevision: requested.get(turnId)!.nativeRevision! }),
      })), { knownServerGeneration: state.serverGeneration }),
      revalidateNativeTurnResources(turnIds, state.serverGeneration),
    ]);
  } catch {
    await recoverActiveTranscriptResources({
      attempts: 4,
      preserveReady: true,
      requiredBasisSequence,
      windowPolicy: 'tail',
    });
    return;
  }
  if (resourceStore.getState().activeConversationId !== conversationId) return;
  const latest = resourceStore.getState();
  if (latest.serverGeneration !== null && latest.serverGeneration !== response.serverGeneration) {
    observeTranscriptServerGeneration(response.serverGeneration);
    return;
  }

  let nextById = latest.turnResourcesById;
  const dirtyTurnIds = new Set<string>();
  let basisSequence = latest.basisSequence ?? 0;
  let stale = false;
  let needsRecovery = false;
  for (const result of response.resources) {
    const turnId = turnIds[result.requestIndex];
    if (!turnId) continue;
    const before = requested.get(turnId)!;
    if (latest.turnResourcesById[turnId]?.revision !== before.revision) {
      stale = true;
      continue;
    }
    if (result.nativeRevision !== undefined && result.status === 'notModified') {
      if (before.nativeRevision !== result.nativeRevision) {
        if (nextById === latest.turnResourcesById) nextById = { ...latest.turnResourcesById };
        nextById[turnId] = { ...before, nativeRevision: result.nativeRevision };
      }
      continue;
    }
    if (result.status !== 'ok' || !result.value || !('segments' in result.value)) {
      needsRecovery = true;
      continue;
    }
    const frame = result.value;
    if (nextById === latest.turnResourcesById) nextById = { ...latest.turnResourcesById };
    if (before.layoutRevision !== frame.layoutRevision) dirtyTurnIds.add(turnId);
    nextById[turnId] = {
      layoutRevision: frame.layoutRevision,
      nativeRevision: result.nativeRevision ?? null,
      projectionError: null,
      revision: frame.renderRevision,
      status: 'ready',
      turn: frame,
    };
    if (result.basisSequence !== undefined) basisSequence = Math.max(basisSequence, result.basisSequence);
  }
  if (stale) {
    streamingRefreshScheduler.enqueue(invalidations);
    return;
  }
  if (needsRecovery) {
    await recoverActiveTranscriptResources({
      attempts: 4,
      preserveReady: true,
      requiredBasisSequence,
      windowPolicy: 'tail',
    });
    return;
  }
  const workingTurnId = latest.turnOrder.find((turnId) =>
    nextById[turnId]?.turn.status === 'inProgress') ?? null;
  batchExternalStoreUpdates(() => {
    resourceStore.setState({
      basisSequence: Math.max(
        basisSequence,
        requiredBasisSequence,
      ),
      isWorking: workingTurnId !== null,
      turnResourcesById: nextById,
      workingTurnId,
    });
    if (dirtyTurnIds.size > 0) {
      reconcileTranscriptLayoutFromResources(layoutSnapshot(), {
        dirtyTurnIds,
        forceFullMeasure: false,
      });
    }
  });
  cacheTranscriptSnapshot(resourceStore.getState(), resourceStore.getState().basisSequence ?? basisSequence);
}

function transcriptWindow(
  state: TranscriptResourceStoreState,
  options: TranscriptRefreshOptions,
): AgentTranscriptSyncRequest['window'] {
  if (options.targetTurnId) {
    return {
      kind: 'around',
      turnId: options.targetTurnId,
      before: DEFAULT_TRANSCRIPT_PREPEND_TURNS,
      after: 23,
    };
  }
  if (
    options.windowPolicy !== 'tail' &&
    state.window &&
    state.turnOrder.length > 0
  ) {
    return {
      kind: 'range',
      startTurnId: state.turnOrder[0]!,
      endTurnId: state.turnOrder.at(-1)!,
    };
  }
  return { kind: 'tail', count: DEFAULT_TRANSCRIPT_TAIL_TURNS };
}

function layoutSnapshot() {
  const state = resourceStore.getState();
  return {
    activeConversationId: state.activeConversationId,
    activeTurnId: state.workingTurnId,
    status: state.status,
    turnOrder: state.turnOrder,
    turnsById: state.turnResourcesById,
  };
}

function setExecutionScope(key: string, resource: AgentExecutionScopeResource) {
  resourceStore.setState({
    executionScopesByKey: {
      ...resourceStore.getState().executionScopesByKey,
      [key]: { resource, revision: resource.revision, status: 'ready' },
    },
  });
}

function setExecutionScopeFailure(key: string, status: 'error' | 'missing') {
  const existing = resourceStore.getState().executionScopesByKey[key];
  resourceStore.setState({
    executionScopesByKey: {
      ...resourceStore.getState().executionScopesByKey,
      [key]: {
        resource: existing?.resource ?? null,
        revision: existing?.revision ?? null,
        status,
        errorCode: 'resourceUnavailable',
      },
    },
  });
}

function setOperationDetail(key: string, resource: AgentOperationDetailResource) {
  resourceStore.setState({
    operationDetailsByKey: {
      ...resourceStore.getState().operationDetailsByKey,
      [key]: { resource, revision: resource.revision, status: 'ready' },
    },
  });
}

function setOperationDetailFailure(key: string, status: 'error' | 'missing') {
  const existing = resourceStore.getState().operationDetailsByKey[key];
  resourceStore.setState({
    operationDetailsByKey: {
      ...resourceStore.getState().operationDetailsByKey,
      [key]: {
        resource: existing?.resource ?? null,
        revision: existing?.revision ?? null,
        status,
        errorCode: 'resourceUnavailable',
      },
    },
  });
}

function markTranscriptUnavailable(error: string) {
  resourceStore.setState({
    error,
    isWorking: false,
    status: 'failed',
    workingTurnId: null,
  });
}

function acceptScopedResponseGeneration(serverGeneration: string) {
  const knownGeneration = resourceStore.getState().serverGeneration;
  return knownGeneration === null || knownGeneration === serverGeneration;
}

function mergeExecutionScopeWindow(
  previous: AgentExecutionScopeResource,
  page: AgentExecutionScopeResource,
) {
  if (
    previous.conversationId !== page.conversationId ||
    previous.turnId !== page.turnId ||
    previous.scopeId !== page.scopeId ||
    previous.revision !== page.revision
  ) return page;
  const byId = new Map(previous.inferences.map((inference) => [inference.id, inference]));
  for (const inference of page.inferences) byId.set(inference.id, inference);
  return {
    ...page,
    inferences: page.inferenceOrder.flatMap((inferenceId) => {
      const inference = byId.get(inferenceId);
      return inference ? [inference] : [];
    }),
    window: {
      startIndex: Math.min(previous.window.startIndex, page.window.startIndex),
      endIndexExclusive: Math.max(
        previous.window.endIndexExclusive,
        page.window.endIndexExclusive,
      ),
      hasEarlier: previous.window.hasEarlier && page.window.hasEarlier,
      hasLater: previous.window.hasLater && page.window.hasLater,
    },
  };
}

function transitionTranscriptGeneration(serverGeneration: string) {
  const state = resourceStore.getState();
  if (state.serverGeneration === serverGeneration) return false;
  cacheTranscriptSnapshot(state);
  for (const entry of transcriptConversationCache.values()) {
    if (entry.snapshot.serverGeneration === serverGeneration) continue;
    entry.requiredServerGeneration = serverGeneration;
    entry.fullSyncBasisSequence = Math.max(
      entry.fullSyncBasisSequence ?? 0,
      entry.snapshot.basisSequence ?? 0,
    );
  }
  transcriptGenerationEpoch += 1;
  cancelPendingTranscriptSyncs();
  streamingRefreshScheduler.cancelPending();
  executionScopeRequests.clear();
  dirtyExecutionScopeRequests.clear();
  operationDetailRequests.clear();
  resourceStore.setState({
    basisSequence: null,
    conversationRevision: null,
    error: null,
    executionScopesByKey: {},
    operationDetailsByKey: {},
    serverGeneration,
    transcriptNativeKey: null,
    transcriptNativeRevision: null,
    transcriptRequestWindow: null,
  });
  return true;
}

export function observeTranscriptServerGeneration(serverGeneration: string | null) {
  if (!serverGeneration) return;
  const state = resourceStore.getState();
  if (state.serverGeneration === null) {
    resourceStore.setState({ serverGeneration });
    return;
  }
  if (!transitionTranscriptGeneration(serverGeneration) || !state.activeConversationId) return;
  void requestTranscriptSync(state.activeConversationId, {
    forceFresh: true,
    forceFullMeasure: true,
    preserveReady: true,
    windowPolicy: 'tail',
  });
}

function resetTranscriptResourceState(): Omit<
  TranscriptResourceStoreState,
  keyof typeof actions
> {
  return {
    activeConversationId: null,
    basisSequence: null,
    conversationRevision: null,
    error: null,
    executionScopesByKey: {},
    isWorking: false,
    operationDetailsByKey: {},
    serverGeneration: null,
    status: 'idle',
    transcriptNativeKey: null,
    transcriptNativeRevision: null,
    transcriptRequestWindow: null,
    turnOrder: [],
    turnResourcesById: {},
    window: null,
    workingTurnId: null,
  };
}

function isStaleSync(conversationId: string, requestEpoch: number) {
  return resourceStore.getState().activeConversationId !== conversationId ||
    requestEpoch !== transcriptGenerationEpoch;
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

const streamingRefreshScheduler = new StreamingRefreshScheduler<AgentResourceInvalidation>({
  cadenceMs: 125,
  key: (invalidation) => `${invalidation.type}:${invalidation.key}`,
  run: (invalidations) => {
    const conversationId = resourceStore.getState().activeConversationId;
    return conversationId ? refreshInvalidatedTurns(conversationId, invalidations) : undefined;
  },
});

configureTranscriptLayoutResourceAdapter({
  getSnapshot: layoutSnapshot,
  loadActiveTranscript: () => refreshActiveTranscriptResources({
    forceFullMeasure: true,
    preserveReady: true,
    windowPolicy: 'tail',
  }),
});

if (typeof window !== 'undefined') {
  lifecycleState = getHostStatusSnapshot().status.type === 'connected' ? 'active' : 'inactive';
}
