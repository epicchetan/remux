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
  preserveReady?: boolean;
  targetTurnId?: string | null;
  windowPolicy?: 'preserve' | 'tail';
};

let syncGeneration = 0;
let transcriptGenerationEpoch = 0;
let lifecycleState: 'active' | 'background' | 'inactive' = 'active';
let dirtyWhileInactive = false;
const executionScopeRequests = new Map<string, Promise<void>>();
const dirtyExecutionScopeRequests = new Set<string>();
const operationDetailRequests = new Map<string, Promise<void>>();

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

    syncGeneration += 1;
    transcriptGenerationEpoch += 1;
    streamingRefreshScheduler.cancelPending();
    executionScopeRequests.clear();
    dirtyExecutionScopeRequests.clear();
    operationDetailRequests.clear();
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
    }]);
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
    }]);
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
  transcriptGenerationEpoch += 1;
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
    executionScopesByKey: {},
    isWorking: false,
    operationDetailsByKey: {},
    serverGeneration: null,
    status: 'idle',
    turnOrder: [],
    turnResourcesById: {},
    window: null,
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
