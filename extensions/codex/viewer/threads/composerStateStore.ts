import type { CodexComposerConfig } from '../../shared/composerConfig';
import type { ThreadTokenUsage } from '../../shared/protocol/v2/ThreadTokenUsage';
import type {
  CodexThreadComposerStateResource,
  CodexThreadResourceResult,
} from '../../shared/threads';
import type { CodexResourceInvalidation } from '../../shared/threadCommands';
import { readThreadResources } from '../ipc/threadResources';
import { createExternalStore } from '../transcript/externalStore';

export type ThreadComposerStateStatus = 'idle' | 'loading' | 'ready' | 'failed';

type ThreadComposerStateRefreshOptions = {
  preserveReady?: boolean;
};

type ThreadComposerStateStoreState = {
  activeThreadId: string | null;
  effective: CodexThreadComposerStateResource['effective'] | null;
  lastAppliedTurnId: string | null;
  observedConfig: CodexThreadComposerStateResource['observedConfig'] | null;
  preference: CodexComposerConfig | null;
  resourceStatus: ThreadComposerStateStatus;
  revision: string | null;
  tokenUsage: ThreadTokenUsage | null;
  tokenUsageSource: CodexThreadComposerStateResource['tokenUsageSource'];
  tokenUsageTurnId: string | null;
  invalidateThreadComposerStateResources: (invalidations: CodexResourceInvalidation[]) => Promise<void>;
  setActiveThreadId: (threadId: string | null) => Promise<void>;
};

let composerStateReadGeneration = 0;

const actions: Pick<
  ThreadComposerStateStoreState,
  'invalidateThreadComposerStateResources' | 'setActiveThreadId'
> = {
  invalidateThreadComposerStateResources,
  async setActiveThreadId(threadId) {
    const state = composerStateStore.getState();
    if (state.activeThreadId === threadId) {
      return;
    }

    composerStateReadGeneration += 1;
    const generation = composerStateReadGeneration;
    if (!threadId) {
      composerStateStore.setState(resetThreadComposerState());
      return;
    }

    composerStateStore.setState({
      activeThreadId: threadId,
      effective: null,
      lastAppliedTurnId: null,
      observedConfig: null,
      preference: null,
      resourceStatus: 'loading',
      revision: null,
      tokenUsage: null,
      tokenUsageSource: 'none',
      tokenUsageTurnId: null,
    });
    await loadThreadComposerState(threadId, generation);
  },
};

const composerStateStore = createExternalStore<ThreadComposerStateStoreState>({
  ...resetThreadComposerState(),
  ...actions,
});

export const useThreadComposerStateStore = composerStateStore.useStore;

export async function invalidateThreadComposerStateResources(invalidations: CodexResourceInvalidation[]) {
  const activeThreadId = composerStateStore.getState().activeThreadId;
  if (!activeThreadId) {
    return;
  }

  const shouldRefresh = invalidations.some((invalidation) =>
    invalidation.type === 'threadComposerState' && invalidation.threadId === activeThreadId);
  if (!shouldRefresh) {
    return;
  }

  composerStateReadGeneration += 1;
  await loadThreadComposerState(activeThreadId, composerStateReadGeneration);
}

export async function refreshActiveThreadComposerState(options: ThreadComposerStateRefreshOptions = {}) {
  const activeThreadId = composerStateStore.getState().activeThreadId;
  if (!activeThreadId) {
    return;
  }

  composerStateReadGeneration += 1;
  await loadThreadComposerState(activeThreadId, composerStateReadGeneration, {
    preserveReady: options.preserveReady ?? true,
  });
}

function resetThreadComposerState(): Omit<
  ThreadComposerStateStoreState,
  'invalidateThreadComposerStateResources' | 'setActiveThreadId'
> {
  return {
    activeThreadId: null,
    effective: null,
    lastAppliedTurnId: null,
    observedConfig: null,
    preference: null,
    resourceStatus: 'idle',
    revision: null,
    tokenUsage: null,
    tokenUsageSource: 'none',
    tokenUsageTurnId: null,
  };
}

async function loadThreadComposerState(
  threadId: string,
  generation: number,
  options: ThreadComposerStateRefreshOptions = {},
) {
  try {
    const knownRevision = composerStateStore.getState().activeThreadId === threadId
      ? composerStateStore.getState().revision ?? undefined
      : undefined;
    const response = await readThreadResources([
      {
        knownRevision,
        threadId,
        type: 'threadComposerState',
      },
    ]);
    if (isStaleLoad(threadId, generation)) {
      return;
    }

    const result = response.resources[0];
    if (result?.status === 'notModified') {
      composerStateStore.setState({ resourceStatus: 'ready' });
      return;
    }

    const resource = parseThreadComposerStateResource(result);
    if (!resource) {
      composerStateStore.setState({ resourceStatus: 'failed' });
      return;
    }

    composerStateStore.setState({
      activeThreadId: threadId,
      effective: resource.effective,
      lastAppliedTurnId: resource.lastAppliedTurnId,
      observedConfig: resource.observedConfig,
      preference: resource.preference,
      resourceStatus: 'ready',
      revision: resource.revision,
      tokenUsage: resource.tokenUsage,
      tokenUsageSource: resource.tokenUsageSource,
      tokenUsageTurnId: resource.tokenUsageTurnId,
    });
  } catch {
    if (!isStaleLoad(threadId, generation)) {
      markThreadComposerStateLoadFailed(threadId, options);
    }
  }
}

function markThreadComposerStateLoadFailed(threadId: string, options: ThreadComposerStateRefreshOptions) {
  const state = composerStateStore.getState();
  if (
    options.preserveReady &&
    state.activeThreadId === threadId &&
    state.resourceStatus === 'ready'
  ) {
    return;
  }

  composerStateStore.setState({ resourceStatus: 'failed' });
}

function parseThreadComposerStateResource(
  result: CodexThreadResourceResult | undefined,
): CodexThreadComposerStateResource | null {
  if (!result || result.status !== 'ok' || !result.value || typeof result.value !== 'object') {
    return null;
  }

  const value = result.value as Partial<CodexThreadComposerStateResource>;
  if (
    typeof value.threadId !== 'string' ||
    typeof value.revision !== 'string' ||
    !isEffectiveState(value.effective) ||
    !isObservedConfig(value.observedConfig) ||
    !isComposerConfig(value.preference) ||
    !isTokenUsageSource(value.tokenUsageSource) ||
    (value.lastAppliedTurnId !== null && typeof value.lastAppliedTurnId !== 'string') ||
    (value.rolloutRevision !== null && typeof value.rolloutRevision !== 'string') ||
    (value.tokenUsageTurnId !== null && typeof value.tokenUsageTurnId !== 'string') ||
    (value.tokenUsage !== null && !isThreadTokenUsage(value.tokenUsage))
  ) {
    return null;
  }

  return {
    effective: value.effective,
    lastAppliedTurnId: value.lastAppliedTurnId,
    observedConfig: value.observedConfig,
    preference: value.preference,
    revision: value.revision,
    rolloutRevision: value.rolloutRevision,
    threadId: value.threadId,
    tokenUsage: value.tokenUsage,
    tokenUsageSource: value.tokenUsageSource,
    tokenUsageTurnId: value.tokenUsageTurnId,
  };
}

function isObservedConfig(value: unknown): value is CodexThreadComposerStateResource['observedConfig'] {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const config = value as Partial<CodexThreadComposerStateResource['observedConfig']>;
  return (
    (config.intelligence === null ||
      config.intelligence === 'low' ||
      config.intelligence === 'medium' ||
      config.intelligence === 'high' ||
      config.intelligence === 'xhigh') &&
    (config.reviewMode === null ||
      config.reviewMode === 'auto-review' ||
      config.reviewMode === 'default' ||
      config.reviewMode === 'full-access') &&
    (config.speed === null || config.speed === 'default' || config.speed === 'fast')
  );
}

function isComposerConfig(value: unknown): value is CodexComposerConfig {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const config = value as Partial<CodexComposerConfig>;
  return (
    (config.intelligence === 'low' ||
      config.intelligence === 'medium' ||
      config.intelligence === 'high' ||
      config.intelligence === 'xhigh') &&
    (config.reviewMode === 'auto-review' ||
      config.reviewMode === 'default' ||
      config.reviewMode === 'full-access') &&
    typeof config.revision === 'string' &&
    (config.speed === 'default' || config.speed === 'fast')
  );
}

function isEffectiveState(value: unknown): value is CodexThreadComposerStateResource['effective'] {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const effective = value as Partial<CodexThreadComposerStateResource['effective']>;
  return (
    (effective.cwd === null || typeof effective.cwd === 'string') &&
    (effective.model === null || typeof effective.model === 'string') &&
    (effective.modelContextWindow === null || typeof effective.modelContextWindow === 'number') &&
    (effective.modelProvider === null || typeof effective.modelProvider === 'string')
  );
}

function isTokenUsageSource(value: unknown): value is CodexThreadComposerStateResource['tokenUsageSource'] {
  return value === 'live' || value === 'rollout' || value === 'none';
}

function isThreadTokenUsage(value: unknown): value is ThreadTokenUsage {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    isTokenUsageBreakdown(record.last) &&
    isTokenUsageBreakdown(record.total) &&
    (typeof record.modelContextWindow === 'number' || record.modelContextWindow === null)
  );
}

function isTokenUsageBreakdown(value: unknown) {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    typeof record.totalTokens === 'number' &&
    typeof record.inputTokens === 'number' &&
    typeof record.cachedInputTokens === 'number' &&
    typeof record.outputTokens === 'number' &&
    typeof record.reasoningOutputTokens === 'number'
  );
}

function isStaleLoad(threadId: string, generation: number) {
  return composerStateStore.getState().activeThreadId !== threadId || generation !== composerStateReadGeneration;
}
