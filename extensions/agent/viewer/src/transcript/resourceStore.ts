import { getHostStatusSnapshot } from '@remux/viewer-kit/host';

import type { AgentResourceInvalidation } from '../../../shared/transcript';
import {
  AGENT_TRANSCRIPT_PROJECTION_VERSION,
  AGENT_TRANSCRIPT_PROTOCOL_VERSION,
  DEFAULT_TRANSCRIPT_PREPEND_TURNS,
  DEFAULT_TRANSCRIPT_TAIL_TURNS,
  workEntryDetailResourceKey,
  workGroupResourceKey,
  type AgentTranscriptResourceResult,
  type AgentTranscriptSyncRequest,
  type AgentTranscriptSyncResource,
  type AgentTurnRenderFrame,
  type AgentWorkEntryDetailResource,
  type AgentWorkGroupResource,
  type AgentWorkRenderSegment,
} from '../../../shared/transcript';
import { readTranscriptResources } from '../ipc/transcript';
import { batchExternalStoreUpdates, createExternalStore } from './externalStore';
import {
  configureTranscriptLayoutResourceAdapter,
  getTranscriptLayoutState,
  reconcileTranscriptLayoutFromResources,
  resetTranscriptLayoutForConversation,
} from './layoutStore';
import { StreamingRefreshScheduler } from './streamingRefreshScheduler';

export type TranscriptStatus = 'idle' | 'loading' | 'ready' | 'failed';

export type TranscriptTurnResourceEntry = {
  layoutRevision: string;
  projectionError: { code: 'frameTooLarge' | 'projectionFailed'; message: string } | null;
  revision: string;
  status: 'ready';
  turn: AgentTurnRenderFrame;
};

export type TranscriptWorkGroupEntry =
  | { resource: AgentWorkGroupResource; revision: string; status: 'ready' }
  | {
      resource: AgentWorkGroupResource | null;
      revision: string | null;
      status: 'error' | 'loading' | 'missing';
      errorCode?: 'staleCursor' | 'resourceUnavailable';
    };

export type TranscriptWorkEntryDetailEntry =
  | { resource: AgentWorkEntryDetailResource; revision: string; status: 'ready' }
  | {
      resource: AgentWorkEntryDetailResource | null;
      revision: string | null;
      status: 'error' | 'loading' | 'missing';
      errorCode?: 'resourceUnavailable';
    };

type TranscriptResourceStoreState = {
  activeConversationId: string | null;
  basisSequence: number | null;
  conversationRevision: string | null;
  error: string | null;
  isWorking: boolean;
  serverGeneration: string | null;
  status: TranscriptStatus;
  turnOrder: string[];
  turnResourcesById: Record<string, TranscriptTurnResourceEntry>;
  window: AgentTranscriptSyncResource['window'] | null;
  workEntryDetailsByKey: Record<string, TranscriptWorkEntryDetailEntry>;
  workGroupsByKey: Record<string, TranscriptWorkGroupEntry>;
  workingTurnId: string | null;
  ensureWorkEntryDetail: (input: WorkEntryInput) => Promise<void>;
  ensureWorkGroup: (input: WorkGroupInput) => Promise<void>;
  ensureWorkResources: (input: { segmentId: string; turnId: string }) => Promise<void>;
  focusTranscriptTurn: (turnId: string) => Promise<boolean>;
  invalidateTranscriptResources: (
    invalidations: AgentResourceInvalidation[],
    serverGeneration?: string | null,
  ) => Promise<void>;
  loadEarlierTranscriptResources: () => Promise<void>;
  loadLaterTranscriptResources: () => Promise<void>;
  loadMoreWorkGroup: (input: WorkGroupInput) => Promise<void>;
  refreshActiveTranscriptResources: (options?: TranscriptRefreshOptions) => Promise<void>;
  setActiveConversationId: (conversationId: string | null) => Promise<void>;
};

type WorkGroupInput = {
  groupId: string;
  segmentId: string;
  turnId: string;
};

type WorkEntryInput = WorkGroupInput & { rowId: string };

export type TranscriptRefreshOptions = {
  forceFullMeasure?: boolean;
  preserveReady?: boolean;
  targetTurnId?: string | null;
  windowPolicy?: 'preserve' | 'tail';
};

let syncGeneration = 0;
let transcriptGenerationEpoch = 0;
let lifecycleState: 'active' | 'background' | 'inactive' = 'active';
let dirtyWhileInactive = false;
const groupRequests = new Map<string, Promise<void>>();
const detailRequests = new Map<string, Promise<void>>();

const actions: Pick<
  TranscriptResourceStoreState,
  | 'ensureWorkEntryDetail'
  | 'ensureWorkGroup'
  | 'ensureWorkResources'
  | 'focusTranscriptTurn'
  | 'invalidateTranscriptResources'
  | 'loadEarlierTranscriptResources'
  | 'loadLaterTranscriptResources'
  | 'loadMoreWorkGroup'
  | 'refreshActiveTranscriptResources'
  | 'setActiveConversationId'
> = {
  ensureWorkEntryDetail,
  ensureWorkGroup,
  ensureWorkResources,
  focusTranscriptTurn,
  invalidateTranscriptResources,
  loadEarlierTranscriptResources,
  loadLaterTranscriptResources,
  loadMoreWorkGroup,
  refreshActiveTranscriptResources,
  async setActiveConversationId(conversationId) {
    const state = resourceStore.getState();
    if (state.activeConversationId === conversationId) return;

    syncGeneration += 1;
    transcriptGenerationEpoch += 1;
    streamingRefreshScheduler.cancelPending();
    groupRequests.clear();
    detailRequests.clear();
    dirtyWhileInactive = false;
    resetTranscriptLayoutForConversation(conversationId);

    if (!conversationId) {
      resourceStore.setState(resetTranscriptResourceState());
      return;
    }

    resourceStore.setState({
      ...resetTranscriptResourceState(),
      activeConversationId: conversationId,
      status: getTranscriptLayoutState().width === null ? 'idle' : 'loading',
    });
    if (getTranscriptLayoutState().width !== null) {
      await loadTranscript(conversationId, ++syncGeneration, {
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

export async function refreshActiveTranscriptResources(options: TranscriptRefreshOptions = {}) {
  const conversationId = resourceStore.getState().activeConversationId;
  if (!conversationId) return;
  const generation = ++syncGeneration;
  await loadTranscript(conversationId, generation, options);
}

export async function invalidateTranscriptResources(
  invalidations: AgentResourceInvalidation[],
  serverGeneration?: string | null,
) {
  const current = resourceStore.getState();
  const conversationId = current.activeConversationId;
  if (!conversationId) return;
  if (
    !serverGeneration ||
    (current.serverGeneration !== null && current.serverGeneration !== serverGeneration)
  ) return;
  const relevant = invalidations.filter((invalidation) =>
    'conversationId' in invalidation &&
    invalidation.conversationId === conversationId &&
    (current.basisSequence === null || invalidation.basisSequence > current.basisSequence));
  if (relevant.length === 0) return;

  if (lifecycleState !== 'active') {
    dirtyWhileInactive = true;
    return;
  }

  const immediateSync = relevant.some((invalidation) =>
    invalidation.type === 'transcript' &&
    (invalidation.reason !== 'runtimeEvent' || invalidation.affectsOrder));
  const streamingSync = relevant.filter((invalidation) =>
    invalidation.type === 'transcript' &&
    invalidation.reason === 'runtimeEvent' &&
    !invalidation.affectsOrder);

  const workRefreshes = relevant.flatMap((invalidation) => {
    if (invalidation.type === 'workGroup') {
      const key = workGroupResourceKey(
        invalidation.conversationId,
        invalidation.turnId,
        invalidation.segmentId,
        invalidation.groupId,
      );
      return resourceStore.getState().workGroupsByKey[key]
        ? [ensureWorkGroup({
            groupId: invalidation.groupId,
            segmentId: invalidation.segmentId,
            turnId: invalidation.turnId,
          }, true)]
        : [];
    }
    if (invalidation.type === 'workEntryDetail') {
      const key = workEntryDetailResourceKey(
        invalidation.conversationId,
        invalidation.turnId,
        invalidation.segmentId,
        invalidation.groupId,
        invalidation.rowId,
      );
      return resourceStore.getState().workEntryDetailsByKey[key]
        ? [ensureWorkEntryDetail({
            groupId: invalidation.groupId,
            rowId: invalidation.rowId,
            segmentId: invalidation.segmentId,
            turnId: invalidation.turnId,
          }, true)]
        : [];
    }
    return [];
  });

  if (immediateSync) {
    streamingRefreshScheduler.cancelPending({ resetCadence: false });
    await Promise.all([
      refreshActiveTranscriptResources({ preserveReady: true, windowPolicy: 'tail' }),
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
  lifecycleState = state;
  if (state !== 'active' || !dirtyWhileInactive) return;
  dirtyWhileInactive = false;
  void refreshActiveTranscriptResources({
    forceFullMeasure: true,
    preserveReady: true,
    windowPolicy: 'preserve',
  });
}

async function loadEarlierTranscriptResources() {
  const state = resourceStore.getState();
  const anchor = state.turnOrder[0];
  if (!state.activeConversationId || !anchor || !state.window?.hasEarlier) return;
  await loadTranscript(state.activeConversationId, ++syncGeneration, {
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
  await loadTranscript(state.activeConversationId, ++syncGeneration, {
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
  const outcome = await loadTranscript(state.activeConversationId, ++syncGeneration, {
    preserveReady: true,
    targetTurnId: turnId,
  });
  return outcome === 'applied' && Boolean(resourceStore.getState().turnResourcesById[turnId]);
}

async function ensureWorkResources({ segmentId, turnId }: { segmentId: string; turnId: string }) {
  const turn = resourceStore.getState().turnResourcesById[turnId]?.turn;
  const work = turn?.segments.find((segment): segment is AgentWorkRenderSegment =>
    segment.type === 'work' && segment.id === segmentId);
  if (!work) return;
  await Promise.all(work.timeline
    .filter((entry) => entry.type === 'group')
    .map((group) => ensureWorkGroup({ groupId: group.id, segmentId, turnId })));
}

async function ensureWorkGroup(input: WorkGroupInput, force = false) {
  const conversationId = resourceStore.getState().activeConversationId;
  if (!conversationId) return;
  const key = workGroupResourceKey(
    conversationId,
    input.turnId,
    input.segmentId,
    input.groupId,
  );
  const existing = resourceStore.getState().workGroupsByKey[key];
  if (!force && (existing?.status === 'ready' || existing?.status === 'loading')) return;
  const pending = groupRequests.get(key);
  if (pending) return pending;

  resourceStore.setState({
    workGroupsByKey: {
      ...resourceStore.getState().workGroupsByKey,
      [key]: {
        resource: existing?.resource ?? null,
        revision: existing?.revision ?? null,
        status: 'loading',
      },
    },
  });
  const request: Promise<void> = readWorkGroup(conversationId, input, existing?.revision ?? undefined)
    .finally(() => {
      if (groupRequests.get(key) === request) groupRequests.delete(key);
    });
  groupRequests.set(key, request);
  return request;
}

async function loadMoreWorkGroup(input: WorkGroupInput) {
  const conversationId = resourceStore.getState().activeConversationId;
  if (!conversationId) return;
  const key = workGroupResourceKey(
    conversationId,
    input.turnId,
    input.segmentId,
    input.groupId,
  );
  const existing = resourceStore.getState().workGroupsByKey[key];
  if (existing?.status !== 'ready' || !existing.resource.nextCursor || groupRequests.has(key)) return;
  const request: Promise<void> = readWorkGroup(
    conversationId,
    input,
    undefined,
    existing.resource.nextCursor,
    existing.resource,
  ).finally(() => {
    if (groupRequests.get(key) === request) groupRequests.delete(key);
  });
  groupRequests.set(key, request);
  return request;
}

async function readWorkGroup(
  conversationId: string,
  input: WorkGroupInput,
  knownRevision?: string,
  cursor?: string,
  previous?: AgentWorkGroupResource,
) {
  const key = workGroupResourceKey(conversationId, input.turnId, input.segmentId, input.groupId);
  const requestEpoch = transcriptGenerationEpoch;
  try {
    const response = await readTranscriptResources(conversationId, [{
      type: 'workGroup',
      protocolVersion: AGENT_TRANSCRIPT_PROTOCOL_VERSION,
      turnId: input.turnId,
      segmentId: input.segmentId,
      groupId: input.groupId,
      limit: 200,
      ...(knownRevision ? { knownRevision } : {}),
      ...(cursor ? { cursor } : {}),
    }]);
    if (
      resourceStore.getState().activeConversationId !== conversationId ||
      requestEpoch !== transcriptGenerationEpoch ||
      !acceptScopedResponseGeneration(response.serverGeneration)
    ) return;
    const result = response.resources[0];
    if (result?.status === 'notModified') {
      if (previous) setWorkGroup(key, previous);
      else {
        const current = resourceStore.getState().workGroupsByKey[key]?.resource;
        if (current) setWorkGroup(key, current);
      }
      return;
    }
    const value = result?.status === 'ok' ? result.value as AgentWorkGroupResource : null;
    if (!value) {
      setWorkGroupFailure(
        key,
        result?.status === 'missing' ? 'missing' : 'error',
        result?.code === 'staleCursor' ? 'staleCursor' : 'resourceUnavailable',
      );
      return;
    }
    setWorkGroup(key, previous ? mergeWorkGroupPage(previous, value) : value);
  } catch {
    if (requestEpoch === transcriptGenerationEpoch) {
      setWorkGroupFailure(key, 'error', 'resourceUnavailable');
    }
  }
}

async function ensureWorkEntryDetail(input: WorkEntryInput, force = false) {
  const conversationId = resourceStore.getState().activeConversationId;
  if (!conversationId) return;
  const key = workEntryDetailResourceKey(
    conversationId,
    input.turnId,
    input.segmentId,
    input.groupId,
    input.rowId,
  );
  const existing = resourceStore.getState().workEntryDetailsByKey[key];
  if (!force && (existing?.status === 'ready' || existing?.status === 'loading')) return;
  const pending = detailRequests.get(key);
  if (pending) return pending;

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
  const request: Promise<void> = readWorkEntryDetail(
    conversationId,
    input,
    existing?.revision ?? undefined,
  ).finally(() => {
    if (detailRequests.get(key) === request) detailRequests.delete(key);
  });
  detailRequests.set(key, request);
  return request;
}

async function readWorkEntryDetail(
  conversationId: string,
  input: WorkEntryInput,
  knownRevision?: string,
) {
  const key = workEntryDetailResourceKey(
    conversationId,
    input.turnId,
    input.segmentId,
    input.groupId,
    input.rowId,
  );
  const requestEpoch = transcriptGenerationEpoch;
  try {
    const response = await readTranscriptResources(conversationId, [{
      type: 'workEntryDetail',
      protocolVersion: AGENT_TRANSCRIPT_PROTOCOL_VERSION,
      turnId: input.turnId,
      segmentId: input.segmentId,
      groupId: input.groupId,
      rowId: input.rowId,
      ...(knownRevision ? { knownRevision } : {}),
    }]);
    if (
      resourceStore.getState().activeConversationId !== conversationId ||
      requestEpoch !== transcriptGenerationEpoch ||
      !acceptScopedResponseGeneration(response.serverGeneration)
    ) return;
    const result = response.resources[0];
    if (result?.status === 'notModified') {
      const current = resourceStore.getState().workEntryDetailsByKey[key];
      if (current?.resource) setWorkEntryDetail(key, current.resource);
      return;
    }
    const value = result?.status === 'ok'
      ? result.value as AgentWorkEntryDetailResource
      : null;
    if (!value) {
      setWorkEntryDetailFailure(
        key,
        result?.status === 'missing' ? 'missing' : 'error',
        'resourceUnavailable',
      );
      return;
    }
    setWorkEntryDetail(key, value);
  } catch {
    if (requestEpoch === transcriptGenerationEpoch) {
      setWorkEntryDetailFailure(key, 'error', 'resourceUnavailable');
    }
  }
}

type InternalLoadOptions = TranscriptRefreshOptions & {
  forceFresh?: boolean;
  generationRetry?: number;
  window?: AgentTranscriptSyncRequest['window'];
};

async function loadTranscript(
  conversationId: string,
  generation: number,
  options: InternalLoadOptions,
) {
  const state = resourceStore.getState();
  const expectedServerGeneration = state.serverGeneration;
  if (!options.preserveReady || state.status !== 'ready') {
    resourceStore.setState({ status: 'loading', error: null });
  }
  const window = options.window ?? transcriptWindow(state, options);
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
      ...(!options.forceFresh && state.conversationRevision
        ? { knownConversationRevision: state.conversationRevision }
        : {}),
      ...(knownTurns.length > 0 ? { knownTurns } : {}),
    }]);
    if (isStaleSync(conversationId, generation)) return;
    if (
      expectedServerGeneration !== null &&
      expectedServerGeneration !== response.serverGeneration
    ) {
      transitionTranscriptGeneration(response.serverGeneration);
      if ((options.generationRetry ?? 0) >= 1) {
        markTranscriptUnavailable('The Agent server generation changed repeatedly during transcript recovery.');
        return 'unavailable' as const;
      }
      return loadTranscript(conversationId, ++syncGeneration, {
        ...options,
        forceFresh: true,
        generationRetry: (options.generationRetry ?? 0) + 1,
        preserveReady: true,
      });
    }
    const result = response.resources[0];
    const sync = result?.status === 'ok' ? result.value as AgentTranscriptSyncResource : null;
    if (!sync) {
      markTranscriptUnavailable(result?.reason ?? 'The Agent transcript could not be loaded.');
      return 'unavailable' as const;
    }
    applySync(sync, response.serverGeneration, options);
    return 'applied' as const;
  } catch (error) {
    if (!isStaleSync(conversationId, generation)) {
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
        projectionError: null,
        revision: result.renderRevision,
        status: 'ready',
        turn: result.frame,
      };
      if (previous.turnResourcesById[result.turnId]?.revision !== result.renderRevision) {
        dirtyTurnIds.add(result.turnId);
      }
    } else if (result.status === 'notModified') {
      const known = previous.turnResourcesById[result.turnId];
      if (known) nextById[result.turnId] = known;
    } else if (result.status === 'error') {
      nextById[result.turnId] = {
        layoutRevision: result.frame.layoutRevision,
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
    status: state.status,
    turnOrder: state.turnOrder,
    turnsById: state.turnResourcesById,
  };
}

function setWorkGroup(key: string, resource: AgentWorkGroupResource) {
  resourceStore.setState({
    workGroupsByKey: {
      ...resourceStore.getState().workGroupsByKey,
      [key]: { resource, revision: resource.revision, status: 'ready' },
    },
  });
}

function setWorkGroupFailure(
  key: string,
  status: 'error' | 'missing',
  errorCode: 'staleCursor' | 'resourceUnavailable',
) {
  const existing = resourceStore.getState().workGroupsByKey[key];
  resourceStore.setState({
    workGroupsByKey: {
      ...resourceStore.getState().workGroupsByKey,
      [key]: {
        resource: existing?.resource ?? null,
        revision: existing?.revision ?? null,
        status,
        errorCode,
      },
    },
  });
}

function setWorkEntryDetail(key: string, resource: AgentWorkEntryDetailResource) {
  resourceStore.setState({
    workEntryDetailsByKey: {
      ...resourceStore.getState().workEntryDetailsByKey,
      [key]: { resource, revision: resource.revision, status: 'ready' },
    },
  });
}

function setWorkEntryDetailFailure(
  key: string,
  status: 'error' | 'missing',
  errorCode: 'resourceUnavailable',
) {
  const existing = resourceStore.getState().workEntryDetailsByKey[key];
  resourceStore.setState({
    workEntryDetailsByKey: {
      ...resourceStore.getState().workEntryDetailsByKey,
      [key]: {
        resource: existing?.resource ?? null,
        revision: existing?.revision ?? null,
        status,
        errorCode,
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

function mergeWorkGroupPage(
  previous: AgentWorkGroupResource,
  page: AgentWorkGroupResource,
) {
  if (
    previous.conversationId !== page.conversationId ||
    previous.turnId !== page.turnId ||
    previous.segmentId !== page.segmentId ||
    previous.groupId !== page.groupId ||
    previous.revision !== page.revision
  ) return page;
  const rows = new Map(previous.rows.map((row) => [row.id, row]));
  for (const row of page.rows) rows.set(row.id, row);
  return { ...page, rows: [...rows.values()] };
}

function transitionTranscriptGeneration(serverGeneration: string) {
  const state = resourceStore.getState();
  if (state.serverGeneration === serverGeneration) return false;
  transcriptGenerationEpoch += 1;
  streamingRefreshScheduler.cancelPending();
  groupRequests.clear();
  detailRequests.clear();
  resourceStore.setState({
    basisSequence: null,
    conversationRevision: null,
    error: null,
    serverGeneration,
    workEntryDetailsByKey: {},
    workGroupsByKey: {},
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
  syncGeneration += 1;
  void loadTranscript(state.activeConversationId, syncGeneration, {
    forceFresh: true,
    forceFullMeasure: true,
    preserveReady: true,
    windowPolicy: 'preserve',
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
    isWorking: false,
    serverGeneration: null,
    status: 'idle',
    turnOrder: [],
    turnResourcesById: {},
    window: null,
    workEntryDetailsByKey: {},
    workGroupsByKey: {},
    workingTurnId: null,
  };
}

function isStaleSync(conversationId: string, generation: number) {
  return resourceStore.getState().activeConversationId !== conversationId ||
    generation !== syncGeneration;
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

const streamingRefreshScheduler = new StreamingRefreshScheduler<AgentResourceInvalidation>({
  cadenceMs: 125,
  key: (invalidation) => `${invalidation.type}:${invalidation.key}`,
  run: () => refreshActiveTranscriptResources({
    preserveReady: true,
    windowPolicy: 'preserve',
  }),
});

configureTranscriptLayoutResourceAdapter({
  ensureWorkResources,
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
