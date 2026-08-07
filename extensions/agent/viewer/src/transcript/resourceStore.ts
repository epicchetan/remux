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
    };

export type TranscriptWorkEntryDetailEntry =
  | { resource: AgentWorkEntryDetailResource; revision: string; status: 'ready' }
  | {
      resource: AgentWorkEntryDetailResource | null;
      revision: string | null;
      status: 'error' | 'loading' | 'missing';
    };

type TranscriptResourceStoreState = {
  activeConversationId: string | null;
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
  invalidateTranscriptResources: (invalidations: AgentResourceInvalidation[]) => Promise<void>;
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
let lifecycleState: 'active' | 'background' | 'inactive' = 'active';
let dirtyWhileInactive = false;
const groupRequests = new Map<string, Promise<void>>();
const detailRequests = new Map<string, Promise<void>>();

const actions: Pick<
  TranscriptResourceStoreState,
  | 'ensureWorkEntryDetail'
  | 'ensureWorkGroup'
  | 'ensureWorkResources'
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
  invalidateTranscriptResources,
  loadEarlierTranscriptResources,
  loadLaterTranscriptResources,
  loadMoreWorkGroup,
  refreshActiveTranscriptResources,
  async setActiveConversationId(conversationId) {
    const state = resourceStore.getState();
    if (state.activeConversationId === conversationId) return;

    syncGeneration += 1;
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

export async function invalidateTranscriptResources(invalidations: AgentResourceInvalidation[]) {
  const conversationId = resourceStore.getState().activeConversationId;
  if (!conversationId) return;
  const relevant = invalidations.filter((invalidation) =>
    'conversationId' in invalidation && invalidation.conversationId === conversationId);
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
  const request = readWorkGroup(conversationId, input, existing?.revision ?? undefined)
    .finally(() => groupRequests.delete(key));
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
  const request = readWorkGroup(
    conversationId,
    input,
    undefined,
    existing.resource.nextCursor,
    existing.resource,
  ).finally(() => groupRequests.delete(key));
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
    if (resourceStore.getState().activeConversationId !== conversationId) return;
    if (!acceptTranscriptResponseGeneration(response.serverGeneration)) return;
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
      setWorkGroupFailure(key, result?.status === 'missing' ? 'missing' : 'error');
      return;
    }
    setWorkGroup(key, previous ? {
      ...value,
      rows: [...previous.rows, ...value.rows],
    } : value);
  } catch {
    setWorkGroupFailure(key, 'error');
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
  const request = readWorkEntryDetail(
    conversationId,
    input,
    existing?.revision ?? undefined,
  ).finally(() => detailRequests.delete(key));
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
    if (resourceStore.getState().activeConversationId !== conversationId) return;
    if (!acceptTranscriptResponseGeneration(response.serverGeneration)) return;
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
      setWorkEntryDetailFailure(key, result?.status === 'missing' ? 'missing' : 'error');
      return;
    }
    setWorkEntryDetail(key, value);
  } catch {
    setWorkEntryDetailFailure(key, 'error');
  }
}

type InternalLoadOptions = TranscriptRefreshOptions & {
  window?: AgentTranscriptSyncRequest['window'];
};

async function loadTranscript(
  conversationId: string,
  generation: number,
  options: InternalLoadOptions,
) {
  const state = resourceStore.getState();
  if (!options.preserveReady || state.status !== 'ready') {
    resourceStore.setState({ status: 'loading', error: null });
  }
  const window = options.window ?? transcriptWindow(state, options);
  const knownTurns = state.turnOrder.slice(-80).flatMap((turnId) => {
    const entry = state.turnResourcesById[turnId];
    return entry ? [{ turnId, renderRevision: entry.revision }] : [];
  });

  try {
    const response = await readTranscriptResources(conversationId, [{
      type: 'transcriptSync',
      protocolVersion: AGENT_TRANSCRIPT_PROTOCOL_VERSION,
      projectionVersion: AGENT_TRANSCRIPT_PROJECTION_VERSION,
      window,
      ...(state.conversationRevision
        ? { knownConversationRevision: state.conversationRevision }
        : {}),
      ...(knownTurns.length > 0 ? { knownTurns } : {}),
    }]);
    if (isStaleSync(conversationId, generation)) return;
    if (state.serverGeneration && state.serverGeneration !== response.serverGeneration) {
      markTranscriptUnavailable('The ephemeral Agent conversation ended when the extension restarted.');
      return;
    }
    const result = response.resources[0];
    const sync = result?.status === 'ok' ? result.value as AgentTranscriptSyncResource : null;
    if (!sync) {
      markTranscriptUnavailable(result?.reason ?? 'The Agent transcript could not be loaded.');
      return;
    }
    applySync(sync, response.serverGeneration, options);
  } catch (error) {
    if (!isStaleSync(conversationId, generation)) {
      if (options.preserveReady && resourceStore.getState().status === 'ready') return;
      markTranscriptUnavailable(messageOf(error));
    }
  }
}

function applySync(
  sync: AgentTranscriptSyncResource,
  serverGeneration: string,
  options: InternalLoadOptions,
) {
  const previous = resourceStore.getState();
  const nextById: Record<string, TranscriptTurnResourceEntry> = {};
  const dirtyTurnIds = new Set<string>();
  for (const result of sync.turns) {
    if (result.status === 'ok') {
      nextById[result.turnId] = {
        layoutRevision: result.frame.layoutRevision,
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
    }
  }
  const turnOrder = sync.turnOrder.filter((turnId) => Boolean(nextById[turnId]));
  batchExternalStoreUpdates(() => {
    resourceStore.setState({
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

function setWorkGroupFailure(key: string, status: 'error' | 'missing') {
  const existing = resourceStore.getState().workGroupsByKey[key];
  resourceStore.setState({
    workGroupsByKey: {
      ...resourceStore.getState().workGroupsByKey,
      [key]: {
        resource: existing?.resource ?? null,
        revision: existing?.revision ?? null,
        status,
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

function setWorkEntryDetailFailure(key: string, status: 'error' | 'missing') {
  const existing = resourceStore.getState().workEntryDetailsByKey[key];
  resourceStore.setState({
    workEntryDetailsByKey: {
      ...resourceStore.getState().workEntryDetailsByKey,
      [key]: {
        resource: existing?.resource ?? null,
        revision: existing?.revision ?? null,
        status,
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

function acceptTranscriptResponseGeneration(serverGeneration: string) {
  const knownGeneration = resourceStore.getState().serverGeneration;
  if (!knownGeneration || knownGeneration === serverGeneration) return true;
  markTranscriptUnavailable('The ephemeral Agent conversation ended when the extension restarted.');
  return false;
}

function resetTranscriptResourceState(): Omit<
  TranscriptResourceStoreState,
  keyof typeof actions
> {
  return {
    activeConversationId: null,
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
