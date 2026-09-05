import type {
  AgentConversationResource,
  AgentModelsResource,
  AgentProvidersResource,
  AgentQueueResource,
  AgentRuntimeResource,
  NativeConversationSummary,
} from '../../shared/native-agent-protocol.ts';
import type {
  AgentPendingQueueValue,
  AgentRuntimeValue,
  AuthValue,
  ConversationSummary,
  ModelInfo,
  ModelsValue,
  ReasoningLevel,
} from '../../shared/protocol.ts';

const REASONING_LEVELS = new Set<ReasoningLevel>([
  'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
]);

export function projectNativeAuth(resource: AgentProvidersResource): AuthValue {
  const provider = resource.providers.find(({ state }) => state === 'ready')
    ?? resource.providers.find(({ provider }) => provider === 'codex')
    ?? resource.providers[0];
  if (!provider) {
    return {
      state: 'error',
      operationId: null,
      displayLabel: null,
      verificationUri: null,
      userCode: null,
      expiresAt: null,
      progress: null,
      error: 'No native Agent provider is configured.',
    };
  }
  const login = provider.loginOperation;
  const state: AuthValue['state'] = provider.state === 'ready'
    ? 'signed-in'
    : login?.state === 'starting' || login?.state === 'waiting'
      ? 'signing-in'
      : provider.state === 'signed-out'
        ? 'signed-out'
        : 'error';
  return {
    state,
    operationId: login?.operationId ?? null,
    displayLabel: provider.label,
    verificationUri: login?.verificationUri ?? null,
    userCode: login?.userCode ?? null,
    expiresAt: null,
    progress: login?.state === 'starting'
      ? 'Starting native sign-in…'
      : login?.state === 'waiting' ? 'Waiting for native sign-in…' : null,
    error: login?.state === 'failed'
      ? login.error ?? 'Native sign-in failed.'
      : state === 'error' ? provider.message ?? 'Native provider is unavailable.' : null,
  };
}

export function projectNativeModels(resources: readonly AgentModelsResource[]): ModelsValue {
  const models: ModelInfo[] = resources.flatMap((resource) => resource.models.map((model) => ({
    id: viewerModelId(resource.providerInstanceId, model.id),
    nativeId: model.id,
    name: model.name,
    provider: model.provider,
    providerInstanceId: resource.providerInstanceId,
    contextWindow: model.contextWindow ?? 0,
    supportedReasoning: model.supportedEffort.filter(isReasoningLevel),
  })));
  const defaultResource = resources.find((resource) => resource.defaultModelId) ?? resources[0];
  return {
    models,
    defaultModelId: defaultResource?.defaultModelId
      ? viewerModelId(defaultResource.providerInstanceId, defaultResource.defaultModelId)
      : models[0]?.id ?? null,
    error: models.length > 0
      ? null
      : resources.find(({ error }) => error)?.error ?? 'No native provider models are available.',
  };
}

export function viewerModelId(providerInstanceId: string, nativeModelId: string) {
  return `${providerInstanceId}::${nativeModelId}`;
}

export function projectNativeConversation(
  conversation: NativeConversationSummary | AgentConversationResource,
): ConversationSummary {
  return {
    id: conversation.conversationId,
    title: conversation.title,
    preview: conversation.preview,
    cwd: conversation.cwd,
    modelId: viewerModelId(conversation.providerInstanceId, conversation.model),
    reasoning: isReasoningLevel(conversation.effort) ? conversation.effort : 'off',
    provider: conversation.provider,
    providerInstanceId: conversation.providerInstanceId,
    access: conversation.access,
    status: conversation.state === 'idle'
      ? 'idle'
      : conversation.state === 'failed' || conversation.state === 'interrupted'
        ? 'error'
        : 'running',
    latestTurnId: 'latestTurnId' in conversation ? conversation.latestTurnId : conversation.activeTurnId,
    parentConversationId: conversation.parentConversationId ?? null,
    rootConversationId: conversation.rootConversationId ?? conversation.conversationId,
    activeStrandId: conversation.activeStrandId ?? `legacy:${conversation.conversationId}`,
    headRevision: conversation.headRevision ?? 1,
    versionCount: conversation.versionCount ?? 1,
    childCount: conversation.childCount ?? 0,
    subtreeUpdatedAt: conversation.subtreeUpdatedAt ?? conversation.updatedAt,
    archivedAt: conversation.archivedAt ?? null,
    metadataRevision: conversation.metadataRevision ?? 1,
    lastUsedModelId: conversation.lastUsedModel
      ? viewerModelId(conversation.providerInstanceId, conversation.lastUsedModel)
      : null,
    lastActivityAt: conversation.lastActivityAt ?? conversation.updatedAt,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
  };
}

export function projectNativeRuntime(resource: AgentRuntimeResource | null): AgentRuntimeValue | null {
  if (!resource) return null;
  return {
    conversationId: resource.conversationId,
    providerInstanceId: resource.providerInstanceId,
    modelId: viewerModelId(resource.providerInstanceId, resource.composer.nextTurn.model),
    effort: isReasoningLevel(resource.composer.nextTurn.effort) ? resource.composer.nextTurn.effort : 'off',
    capabilities: resource.capabilities,
    state: resource.state === 'idle'
      ? 'idle'
      : resource.state === 'failed' || resource.state === 'interrupted'
        ? 'error'
        : 'running',
    activeTurnId: resource.activeTurnId,
    activeTurnElapsedMs:
      typeof resource.activeTurnElapsedMs === 'number' && Number.isFinite(resource.activeTurnElapsedMs)
        ? Math.max(0, resource.activeTurnElapsedMs)
        : null,
    error: resource.state === 'failed' ? resource.healthMessage ?? 'Native provider failed.' : null,
  };
}

export function projectNativeQueue(resource: AgentQueueResource | null): AgentPendingQueueValue | null {
  if (!resource) return null;
  return {
    conversationId: resource.conversationId,
    entries: resource.entries.map((entry) => ({
      id: entry.kind === 'message' ? entry.turnId : entry.operationId,
      createdAt: entry.createdAt,
      ...(entry.kind === 'message' ? { state: entry.state } : {}),
      text: entry.kind === 'message'
        ? entry.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n')
        : 'Compact context',
      attachmentCount: entry.kind === 'message'
        ? entry.content.filter((part) => part.type === 'image-artifact').length : 0,
      mentionCount: entry.kind === 'message'
        ? entry.content.filter((part) => part.type === 'file-reference').length : 0,
    })),
  };
}

function isReasoningLevel(value: unknown): value is ReasoningLevel {
  return typeof value === 'string' && REASONING_LEVELS.has(value as ReasoningLevel);
}
