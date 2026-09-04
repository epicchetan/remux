import type {
  ContextUsageSnapshot,
  ChildExecutionOwnership,
  FileChangeDisplay,
  JsonValue,
  ProviderAccess,
  ProviderCapabilities,
  ProviderAccountUsage,
  ProviderExecutionState,
  ProviderKind,
  ProviderModelDescriptor,
  ProviderProbeState,
  ProviderTurnOutcome,
  ToolDisplay,
  TurnBlockKind,
  TurnBlockPayload,
  TurnBlockState,
  UsageDisplay,
  UserContentPart,
  WebActivityDisplay,
} from './provider-runtime.ts';
import { parseUserContentParts, ProviderContractError } from './provider-runtime.ts';

/** Viewer-safe resource and command contract for the provider-native runtime. */
export const NATIVE_AGENT_PROTOCOL_VERSION = 7 as const;
export const NATIVE_AGENT_LIMITS = {
  resourceBytes: 8 * 1024 * 1024,
  resourceReads: 64,
  transcriptTurns: 40,
  queueEntries: 128,
  operationsPerTurn: 512,
  childrenPerTurn: 128,
  blocksPerTurn: 10_000,
  artifactBytes: 20 * 1024 * 1024,
} as const;

export const NATIVE_AGENT_METHODS = {
  resourcesRead: 'remux/agent/resources/read',
  transcriptRead: 'remux/agent/transcript/resources/read',
  providerLoginStart: 'remux/agent/provider/login/start',
  providerLoginCancel: 'remux/agent/provider/login/cancel',
  providerLogout: 'remux/agent/provider/logout',
  artifactPut: 'remux/agent/artifact/put',
  artifactRead: 'remux/agent/artifact/read',
  filesSearch: 'remux/agent/files/search',
  conversationCreate: 'remux/agent/conversation/create',
  messageSend: 'remux/agent/conversation/message/send',
  queuedMessageRemove: 'remux/agent/conversation/message/queue/remove',
  messageEdit: 'remux/agent/conversation/message/edit',
  messageFork: 'remux/agent/conversation/message/fork',
  conversationRename: 'remux/agent/conversation/rename',
  conversationArchiveSet: 'remux/agent/conversation/archive/set',
  conversationStrandActivate: 'remux/agent/conversation/strand/activate',
  turnInterrupt: 'remux/agent/conversation/turn/interrupt',
  conversationCompact: 'remux/agent/conversation/compact',
  conversationPreferenceSet: 'remux/agent/composer/conversation-preference/set',
  conversationAccessSet: 'remux/agent/composer/conversation-access/set',
  providerPreferenceSet: 'remux/agent/composer/provider-preference/set',
  runtimesRead: 'remux/agent/runtimes/read',
  resourcesInvalidated: 'remux/agent/resources/invalidated',
} as const;

export const NATIVE_AGENT_RESOURCE_KEYS = {
  providers: 'agent/providers',
  conversations: 'agent/conversations',
} as const;

export type NativeAgentResourceKey =
  | typeof NATIVE_AGENT_RESOURCE_KEYS[keyof typeof NATIVE_AGENT_RESOURCE_KEYS]
  | `agent/models:${string}`
  | `agent/conversation:${string}`
  | `agent/conversation-versions:${string}`
  | `agent/runtime:${string}`
  | `agent/queue:${string}`
  | `agent/transcript:${string}:${string}`
  | `agent/strand-transcript:${string}:${string}:${string}`
  | `agent/turn:${string}`
  | `agent/execution:${string}`
  | `agent/execution-transcript:${string}:${string}`
  | `agent/artifact:${string}:${string}`;

export type ViewerProviderCapabilities = {
  provider: ProviderKind;
  providerVersion: string;
  adapterVersion: string;
  authentication: ProviderCapabilities['authentication'];
  session: ProviderCapabilities['session'];
  turns: ProviderCapabilities['turns'];
  content: ProviderCapabilities['content'];
  collaboration: ProviderCapabilities['collaboration'];
  access: ProviderCapabilities['access'];
  usage: ProviderCapabilities['usage'];
  compaction: ProviderCapabilities['compaction'];
};

export type ProviderModelPreferenceView = {
  model: string;
  effort: string | null;
};

export type ProviderCatalogEntry = {
  providerInstanceId: string;
  provider: ProviderKind;
  label: string;
  state: ProviderProbeState;
  message?: string;
  capabilityRevision: string;
  capabilities?: ViewerProviderCapabilities;
  loginOperation?: ProviderLoginOperationView;
  stickyPreference?: ProviderModelPreferenceView;
  accountUsage: ProviderAccountUsage;
};

export type ProviderLoginOperationView = {
  operationId: string;
  mode: 'device-code' | 'browser';
  state: 'starting' | 'waiting' | 'completed' | 'failed' | 'cancelled';
  verificationUri?: string;
  userCode?: string;
  error?: string;
  startedAt: number;
  completedAt?: number;
};

export type AgentProvidersResource = {
  providers: readonly ProviderCatalogEntry[];
  defaultProviderInstanceId: string | null;
  preferenceRevision: string;
};

export type AgentHarnessRuntime = {
  providerInstanceId: string;
  provider: ProviderKind;
  label: string;
  readiness: ProviderProbeState;
  readinessMessage: string | null;
  topology: 'shared-daemon' | 'session-process' | 'fixture';
  runtimeState: 'running' | 'idle' | 'stopped' | 'starting' | 'stopping' | 'failed' | 'unknown';
  configuredExecutable: string | null;
  resolvedExecutable: string | null;
  installedVersion: string | null;
  runningVersion: string | null;
  adapterVersion: string | null;
  sdkVersion: string | null;
  restartRequired: boolean;
  activeSessions: number;
  lastError: string | null;
};

export type AgentHarnessRuntimesResource = {
  runtimes: readonly AgentHarnessRuntime[];
  observedAt: number;
};

export type AgentModelsResource = {
  providerInstanceId: string;
  models: readonly ProviderModelDescriptor[];
  defaultModelId: string | null;
  error: string | null;
};

export type NativeConversationSummary = {
  conversationId: string;
  provider: ProviderKind;
  providerInstanceId: string;
  title: string;
  preview: string;
  cwd: string;
  model: string;
  effort?: string;
  access: ProviderAccess;
  state: ProviderExecutionState;
  rootExecutionId: string;
  parentConversationId: string | null;
  rootConversationId: string;
  forkedFromPathEntryId: string | null;
  activeStrandId: string;
  headRevision: number;
  versionCount: number;
  childCount: number;
  subtreeUpdatedAt: number;
  archivedAt: number | null;
  metadataRevision: number;
  /** Model proven by the latest Remux-dispatched turn, not the next-turn preference. */
  lastUsedModel?: string | null;
  /** Latest user-send time on the active transcript; reads and metadata changes do not move the row. */
  lastActivityAt?: number;
  activeTurnId: string | null;
  history: {
    state: 'indexed' | 'loading' | 'ready' | 'failed';
    error?: string;
    lastSyncedAt?: number;
    nativeRevision?: string;
    syncedRevision?: string;
  };
  resumable: boolean;
  createdAt: number;
  updatedAt: number;
};

export type AgentConversationsResource = {
  conversations: readonly NativeConversationSummary[];
  truncated: boolean;
};

export type AgentConversationResource = NativeConversationSummary & {
  capabilityRevision: string;
  latestTurnId: string | null;
  turnCount: number;
};

export type NativeConversationVersionSummary = {
  strandId: string;
  active: boolean;
  reason: 'initial' | 'edit' | 'fork' | 'restore' | 'legacy';
  sourceStrandId: string | null;
  sourcePathEntryId: string | null;
  turnCount: number;
  preview: string;
  createdAt: number;
};

export type AgentConversationVersionsResource = {
  conversationId: string;
  headRevision: number;
  versions: readonly NativeConversationVersionSummary[];
};

export type AgentRuntimeResource = {
  conversationId: string;
  executionId: string;
  state: ProviderExecutionState;
  activeTurnId: string | null;
  activeTurnElapsedMs: number | null;
  history: NativeConversationSummary['history'];
  provider: ProviderKind;
  providerInstanceId: string;
  activeConfiguration: {
    model: string;
    effort: string | null;
    access: ProviderAccess;
  };
  composer: ComposerConfigurationView;
  capabilities: ViewerProviderCapabilities;
  usage: UsageDisplay;
  compaction: RuntimeCompactionView;
  healthMessage?: string;
};

export type ComposerConfigurationOrigin =
  | 'conversation-explicit'
  | 'last-used'
  | 'provider-sticky'
  | 'provider-default';

export type ComposerConfigurationView = {
  revision: string;
  providerInstanceId: string;
  nextTurn: {
    model: string;
    effort: string | null;
    access: ProviderAccess;
    origin: ComposerConfigurationOrigin;
  };
  lastUsed: {
    turnId: string;
    model: string;
    effort: string | null;
  } | null;
  editable: {
    model: boolean;
    effort: boolean;
    access: boolean;
  };
};

export type CompactResultView = {
  operationId: string;
  trigger: 'manual' | 'automatic';
  disposition: 'dispatched' | 'satisfied-by-native-auto';
  beforeTokens: number | null;
  afterTokens: number | null;
  completedAt: number;
};

export type ContextCompactionView =
  | { state: 'idle'; lastResult: CompactResultView | null }
  | {
      state: 'running';
      trigger: 'manual' | 'automatic';
      operationId: string;
      startedAt: number;
    }
  | {
      state: 'failed';
      trigger: 'manual' | 'automatic';
      operationId: string;
      error: { code: string; message: string; retryable?: boolean };
      failedAt: number;
      lastResult: CompactResultView | null;
    };

export type RuntimeCompactionView = {
  policy: 'native-auto' | 'manual';
  operation: ContextCompactionView;
};

export type NativeQueuedMessage = {
  kind: 'message';
  commandId: string;
  turnId: string;
  content: readonly UserContentPart[];
  model: string;
  effort?: string;
  access: ProviderAccess;
  state: 'queued' | 'dispatching' | 'blocked' | 'delivery-unknown';
  createdAt: number;
};

export type NativeQueuedCompact = {
  kind: 'compact';
  commandId: string;
  operationId: string;
  createdAt: number;
};

export type NativeQueueEntry = NativeQueuedMessage | NativeQueuedCompact;

export type AgentQueueResource = {
  conversationId: string;
  entries: readonly NativeQueueEntry[];
};

export type NativeOperationView = {
  eventId: string;
  tool: ToolDisplay;
  state: 'running' | 'completed' | 'failed';
  inputPreview?: JsonValue;
  outputPreview?: JsonValue;
  detailRef?: string;
  startedAt: number;
  completedAt?: number;
};

export type NativeChildExecutionView = {
  executionId: string;
  ownership: ChildExecutionOwnership;
  provider: ProviderKind;
  providerInstanceId?: string;
  model?: string;
  title?: string;
  state: ProviderExecutionState;
  outcome?: ProviderTurnOutcome;
  summary?: string;
};

export type NativeFileChangeView = FileChangeDisplay & {
  /** Ordered provider block that caused this change, when the provider exposes it. */
  blockId?: string;
};

export type NativeTurnActivity = {
  reasoning: string;
  commentary: string;
  operations: readonly NativeOperationView[];
  fileChanges: readonly NativeFileChangeView[];
  web: readonly WebActivityDisplay[];
  children: readonly NativeChildExecutionView[];
  notices: readonly { code: string; message: string }[];
  compacted: boolean;
};

export type NativeOrderedTurnBlock = {
  blockId: string;
  passId: string;
  ordinal: number;
  kind: TurnBlockKind;
  state: TurnBlockState;
  revision: number;
  payload: TurnBlockPayload;
  startedAt: number | null;
  completedAt: number | null;
};

export type NativeAssistantPass = {
  passId: string;
  ordinal: number;
  state: 'streaming' | 'completed' | 'reconciled';
  blocks: readonly NativeOrderedTurnBlock[];
};

export type NativeCompactionView = {
  operationId: string;
  trigger: 'manual' | 'automatic';
  state: 'started' | 'completed' | 'failed';
  beforeTokens: number | null;
  afterTokens: number | null;
  error?: { code: string; message: string; retryable?: boolean };
  createdAt: number;
  completedAt?: number;
};

export type NativeAgentTurnFrame = {
  pathEntryId: string;
  strandId: string;
  ordinal: number;
  turnId: string;
  clientMessageId: string;
  executionId: string;
  state: 'queued' | 'running' | 'recovering' | 'completed' | 'failed' | 'interrupted';
  outcome?: ProviderTurnOutcome;
  userContent: readonly UserContentPart[];
  ordering: 'native-exact' | 'live-provisional' | 'legacy-grouped';
  passes: readonly NativeAssistantPass[];
  finalBlockId: string | null;
  /** Conversation-scoped compactions positioned against this strand turn. */
  boundaryCompactions?: {
    beforeUser: readonly NativeCompactionView[];
    afterTurn: readonly NativeCompactionView[];
  };
  activity: NativeTurnActivity;
  assistantText: string;
  assistantContent?: {
    artifactId: string;
    sha256: string;
    byteLength: number;
    returnedBytes: number;
    nextOffset: number | null;
  };
  usage?: UsageDisplay;
  error?: { code: string; message: string; retryable?: boolean };
  startedAt?: number;
  completedAt?: number;
  renderRevision: string;
  layoutRevision: string;
};

export type NativeTranscriptWindow = {
  conversationId: string;
  strandId: string;
  executionId: string;
  activeTurnId: string | null;
  turnOrder: readonly string[];
  turns: readonly NativeAgentTurnFrame[];
  window: {
    startIndex: number;
    endIndexExclusive: number;
    hasEarlier: boolean;
    hasLater: boolean;
  };
};

export type AgentExecutionResource = {
  executionId: string;
  conversationId: string;
  parentExecutionId: string | null;
  rootTurnId: string | null;
  ownership: 'root' | ChildExecutionOwnership;
  provider: ProviderKind;
  providerInstanceId: string;
  model?: string;
  effort?: string;
  access?: ProviderAccess;
  federationScheduling?: 'background' | 'foreground';
  federationDepth: number;
  title?: string;
  state: ProviderExecutionState;
  outcome?: ProviderTurnOutcome;
  summary?: string;
  childExecutionIds: readonly string[];
  transcriptAvailable: boolean;
  startedAt: number;
  completedAt?: number;
};

export type NativeAgentResourceValue =
  | AgentProvidersResource
  | AgentModelsResource
  | AgentConversationsResource
  | AgentConversationResource
  | AgentConversationVersionsResource
  | AgentRuntimeResource
  | AgentQueueResource
  | NativeTranscriptWindow
  | NativeAgentTurnFrame
  | AgentExecutionResource;

export type NativeAgentResourceReadParams = {
  knownServerGeneration?: string;
  capabilityRevision?: string;
  focusedConversationId?: string;
  focusedExecutionId?: string;
  historySync?: 'if-stale' | 'force';
  visibility?: 'foreground' | 'background' | 'inactive';
  requests: readonly {
    key: NativeAgentResourceKey;
    ifNoneMatch?: number;
  }[];
};

export type NativeAgentResourceReadResult = {
  protocolVersion: typeof NATIVE_AGENT_PROTOCOL_VERSION;
  serverGeneration: string;
  capabilityRevision: string;
  changedKeys: readonly NativeAgentResourceKey[];
  resources: readonly (
    | { key: NativeAgentResourceKey; status: 'missing' }
    | { key: NativeAgentResourceKey; status: 'notModified'; revision: number; basisSequence: number }
    | {
        key: NativeAgentResourceKey;
        status: 'ok';
        revision: number;
        basisSequence: number;
        value: NativeAgentResourceValue;
      }
  )[];
};

export type NativeAgentResourcesInvalidated = {
  protocolVersion: typeof NATIVE_AGENT_PROTOCOL_VERSION;
  serverGeneration: string;
  basisSequence: number;
  keys: readonly NativeAgentResourceKey[];
};

export type NativeConversationCreateCommand = {
  commandId: string;
  providerInstanceId: string;
  cwd: string;
  model: string;
  effort?: string;
  access: ProviderAccess;
};

export type NativeProviderLoginStartCommand = {
  commandId: string;
  providerInstanceId: string;
  mode: 'device-code' | 'browser';
};

export type NativeProviderAuthMutationCommand = {
  commandId: string;
  providerInstanceId: string;
};

export type NativeArtifactPutCommand = {
  commandId: string;
  dataUrl: string;
  name?: string;
};

export type NativeArtifactPutResult = {
  accepted: true;
  artifactId: string;
  mimeType: string;
  name?: string;
  byteLength: number;
};

export type NativeArtifactReadCommand = {
  artifactId: string;
  offset: number;
  byteLength: number;
};

export type NativeArtifactReadResult = {
  artifactId: string;
  mimeType: string;
  totalByteLength: number;
  offset: number;
  byteLength: number;
  base64: string;
};

export type NativeMessageSendCommand = {
  commandId: string;
  conversationId: string;
  clientMessageId: string;
  content: readonly UserContentPart[];
  providerInstanceId: string;
  model: string;
  effort: string | null;
  access: ProviderAccess;
  configurationRevision: string;
  delivery: 'auto' | 'queue' | 'steer';
};

export type NativeTurnMutationCommand = {
  commandId: string;
  conversationId: string;
  turnId: string;
};

export type NativeBranchCommand = {
  commandId: string;
  clientMessageId: string;
  sourceConversationId: string;
  sourceStrandId: string;
  sourcePathEntryId: string;
  expectedHeadRevision: number;
  content: readonly UserContentPart[];
  mode: 'edit' | 'fork';
  providerInstanceId: string;
  model: string;
  effort: string | null;
  access: ProviderAccess;
  configurationRevision: string;
};

export type NativeConversationRenameCommand = {
  commandId: string;
  conversationId: string;
  expectedMetadataRevision: number;
  title: string;
};

export type NativeConversationArchiveSetCommand = {
  commandId: string;
  conversationId: string;
  expectedMetadataRevision: number;
  archived: boolean;
};

export type NativeConversationStrandActivateCommand = {
  commandId: string;
  conversationId: string;
  strandId: string;
  expectedHeadRevision: number;
};

export type NativeCompactConversationCommand = {
  commandId: string;
  conversationId: string;
};

export type NativeComposerPreferenceSetCommand = {
  commandId: string;
  conversationId: string;
  expectedRevision: string;
  model: string;
  effort: string | null;
};

export type NativeConversationAccessSetCommand = {
  commandId: string;
  conversationId: string;
  expectedRevision: string;
  access: ProviderAccess;
};

export type NativeProviderPreferenceSetCommand = {
  commandId: string;
  providerInstanceId: string;
  expectedProvidersRevision: string;
  model: string;
  effort: string | null;
  makeDefaultProvider: true;
};

export function parseNativeProviderLoginStartCommand(
  value: unknown,
): NativeProviderLoginStartCommand {
  const record = strict(value, '$', ['commandId', 'providerInstanceId', 'mode']);
  return {
    commandId: identifier(record.commandId, '$.commandId'),
    providerInstanceId: identifier(record.providerInstanceId, '$.providerInstanceId'),
    mode: choice(record.mode, ['device-code', 'browser'], '$.mode'),
  };
}

export function parseNativeProviderAuthMutationCommand(
  value: unknown,
): NativeProviderAuthMutationCommand {
  const record = strict(value, '$', ['commandId', 'providerInstanceId']);
  return {
    commandId: identifier(record.commandId, '$.commandId'),
    providerInstanceId: identifier(record.providerInstanceId, '$.providerInstanceId'),
  };
}

export function parseNativeArtifactPutCommand(value: unknown): NativeArtifactPutCommand {
  const record = strict(value, '$', ['commandId', 'dataUrl', 'name'], ['name']);
  const dataUrl = string(record.dataUrl, '$.dataUrl', Math.ceil(NATIVE_AGENT_LIMITS.artifactBytes * 1.4) + 512);
  if (!/^data:image\/[A-Za-z0-9.+-]+;base64,/u.test(dataUrl)) {
    throw new ProviderContractError('$.dataUrl', 'must be a base64 image data URL');
  }
  return {
    commandId: identifier(record.commandId, '$.commandId'),
    dataUrl,
    ...(record.name === undefined ? {} : { name: string(record.name, '$.name', 1_024) }),
  };
}

export function parseNativeArtifactReadCommand(value: unknown): NativeArtifactReadCommand {
  const record = strict(value, '$', ['artifactId', 'offset', 'byteLength']);
  return {
    artifactId: identifier(record.artifactId, '$.artifactId'),
    offset: nonnegativeInteger(record.offset, '$.offset'),
    byteLength: nonnegativeInteger(record.byteLength, '$.byteLength'),
  };
}

export function parseNativeConversationCreateCommand(value: unknown): NativeConversationCreateCommand {
  const record = strict(value, '$', [
    'commandId', 'providerInstanceId', 'cwd', 'model', 'effort', 'access',
  ], ['effort']);
  return {
    commandId: identifier(record.commandId, '$.commandId'),
    providerInstanceId: identifier(record.providerInstanceId, '$.providerInstanceId'),
    cwd: string(record.cwd, '$.cwd', 32 * 1024),
    model: string(record.model, '$.model'),
    ...(record.effort === undefined ? {} : { effort: string(record.effort, '$.effort') }),
    access: choice(record.access, ['read-only', 'workspace-write', 'full-access'], '$.access'),
  };
}

export function parseNativeMessageSendCommand(value: unknown): NativeMessageSendCommand {
  const record = strict(value, '$', [
    'commandId', 'conversationId', 'clientMessageId', 'content', 'providerInstanceId',
    'model', 'effort', 'access', 'configurationRevision', 'delivery',
  ]);
  return {
    commandId: identifier(record.commandId, '$.commandId'),
    conversationId: identifier(record.conversationId, '$.conversationId'),
    clientMessageId: identifier(record.clientMessageId, '$.clientMessageId'),
    content: parseUserContentParts(record.content),
    providerInstanceId: identifier(record.providerInstanceId, '$.providerInstanceId'),
    model: string(record.model, '$.model'),
    effort: record.effort === null ? null : string(record.effort, '$.effort'),
    access: choice(record.access, ['read-only', 'workspace-write', 'full-access'], '$.access'),
    configurationRevision: identifier(record.configurationRevision, '$.configurationRevision'),
    delivery: choice(record.delivery, ['auto', 'queue', 'steer'], '$.delivery'),
  };
}

export function parseNativeTurnMutationCommand(value: unknown): NativeTurnMutationCommand {
  const record = strict(value, '$', ['commandId', 'conversationId', 'turnId']);
  return {
    commandId: identifier(record.commandId, '$.commandId'),
    conversationId: identifier(record.conversationId, '$.conversationId'),
    turnId: identifier(record.turnId, '$.turnId'),
  };
}

export function parseNativeBranchCommand(value: unknown): NativeBranchCommand {
  const record = strict(value, '$', [
    'commandId', 'clientMessageId', 'sourceConversationId', 'sourceStrandId',
    'sourcePathEntryId', 'expectedHeadRevision', 'content', 'mode',
    'providerInstanceId', 'model', 'effort', 'access', 'configurationRevision',
  ]);
  return {
    commandId: identifier(record.commandId, '$.commandId'),
    clientMessageId: identifier(record.clientMessageId, '$.clientMessageId'),
    sourceConversationId: identifier(record.sourceConversationId, '$.sourceConversationId'),
    sourceStrandId: identifier(record.sourceStrandId, '$.sourceStrandId'),
    sourcePathEntryId: identifier(record.sourcePathEntryId, '$.sourcePathEntryId'),
    expectedHeadRevision: nonnegativeInteger(record.expectedHeadRevision, '$.expectedHeadRevision'),
    content: parseUserContentParts(record.content),
    mode: choice(record.mode, ['edit', 'fork'], '$.mode'),
    providerInstanceId: identifier(record.providerInstanceId, '$.providerInstanceId'),
    model: string(record.model, '$.model'),
    effort: record.effort === null ? null : string(record.effort, '$.effort'),
    access: choice(record.access, ['read-only', 'workspace-write', 'full-access'], '$.access'),
    configurationRevision: identifier(record.configurationRevision, '$.configurationRevision'),
  };
}

export function parseNativeConversationRenameCommand(
  value: unknown,
): NativeConversationRenameCommand {
  const record = strict(value, '$', [
    'commandId', 'conversationId', 'expectedMetadataRevision', 'title',
  ]);
  const title = string(record.title, '$.title', 512).trim();
  if (!title) throw new ProviderContractError('$.title', 'must not be empty');
  return {
    commandId: identifier(record.commandId, '$.commandId'),
    conversationId: identifier(record.conversationId, '$.conversationId'),
    expectedMetadataRevision: nonnegativeInteger(
      record.expectedMetadataRevision,
      '$.expectedMetadataRevision',
    ),
    title,
  };
}

export function parseNativeConversationArchiveSetCommand(
  value: unknown,
): NativeConversationArchiveSetCommand {
  const record = strict(value, '$', [
    'commandId', 'conversationId', 'expectedMetadataRevision', 'archived',
  ]);
  if (typeof record.archived !== 'boolean') {
    throw new ProviderContractError('$.archived', 'must be a boolean');
  }
  return {
    commandId: identifier(record.commandId, '$.commandId'),
    conversationId: identifier(record.conversationId, '$.conversationId'),
    expectedMetadataRevision: nonnegativeInteger(
      record.expectedMetadataRevision,
      '$.expectedMetadataRevision',
    ),
    archived: record.archived,
  };
}

export function parseNativeConversationStrandActivateCommand(
  value: unknown,
): NativeConversationStrandActivateCommand {
  const record = strict(value, '$', [
    'commandId', 'conversationId', 'strandId', 'expectedHeadRevision',
  ]);
  return {
    commandId: identifier(record.commandId, '$.commandId'),
    conversationId: identifier(record.conversationId, '$.conversationId'),
    strandId: identifier(record.strandId, '$.strandId'),
    expectedHeadRevision: nonnegativeInteger(record.expectedHeadRevision, '$.expectedHeadRevision'),
  };
}

export function parseNativeCompactConversationCommand(
  value: unknown,
): NativeCompactConversationCommand {
  const record = strict(value, '$', ['commandId', 'conversationId']);
  return {
    commandId: identifier(record.commandId, '$.commandId'),
    conversationId: identifier(record.conversationId, '$.conversationId'),
  };
}

export function parseNativeComposerPreferenceSetCommand(
  value: unknown,
): NativeComposerPreferenceSetCommand {
  const record = strict(value, '$', [
    'commandId', 'conversationId', 'expectedRevision', 'model', 'effort',
  ]);
  return {
    commandId: identifier(record.commandId, '$.commandId'),
    conversationId: identifier(record.conversationId, '$.conversationId'),
    expectedRevision: identifier(record.expectedRevision, '$.expectedRevision'),
    model: string(record.model, '$.model'),
    effort: record.effort === null ? null : string(record.effort, '$.effort'),
  };
}

export function parseNativeConversationAccessSetCommand(
  value: unknown,
): NativeConversationAccessSetCommand {
  const record = strict(value, '$', [
    'commandId', 'conversationId', 'expectedRevision', 'access',
  ]);
  return {
    commandId: identifier(record.commandId, '$.commandId'),
    conversationId: identifier(record.conversationId, '$.conversationId'),
    expectedRevision: identifier(record.expectedRevision, '$.expectedRevision'),
    access: choice(record.access, ['read-only', 'workspace-write', 'full-access'], '$.access'),
  };
}

export function parseNativeProviderPreferenceSetCommand(
  value: unknown,
): NativeProviderPreferenceSetCommand {
  const record = strict(value, '$', [
    'commandId', 'providerInstanceId', 'expectedProvidersRevision', 'model', 'effort',
    'makeDefaultProvider',
  ]);
  if (record.makeDefaultProvider !== true) {
    throw new ProviderContractError('$.makeDefaultProvider', 'must equal true');
  }
  return {
    commandId: identifier(record.commandId, '$.commandId'),
    providerInstanceId: identifier(record.providerInstanceId, '$.providerInstanceId'),
    expectedProvidersRevision: identifier(
      record.expectedProvidersRevision,
      '$.expectedProvidersRevision',
    ),
    model: string(record.model, '$.model'),
    effort: record.effort === null ? null : string(record.effort, '$.effort'),
    makeDefaultProvider: true,
  };
}

export function parseNativeAgentResourceReadParams(value: unknown): NativeAgentResourceReadParams {
  const record = strict(value, '$', [
    'knownServerGeneration', 'capabilityRevision', 'focusedConversationId',
    'focusedExecutionId', 'historySync', 'visibility', 'requests',
  ], [
    'knownServerGeneration', 'capabilityRevision', 'focusedConversationId',
    'focusedExecutionId', 'historySync', 'visibility',
  ]);
  if (!Array.isArray(record.requests)) {
    throw new ProviderContractError('$.requests', 'must be an array');
  }
  if (record.requests.length > NATIVE_AGENT_LIMITS.resourceReads) {
    throw new ProviderContractError(
      '$.requests',
      `exceeds ${NATIVE_AGENT_LIMITS.resourceReads} entries`,
    );
  }
  const seen = new Set<string>();
  const requests = record.requests.map((value, index) => {
    const item = strict(value, `$.requests[${index}]`, ['key', 'ifNoneMatch'], ['ifNoneMatch']);
    const key = resourceKey(item.key, `$.requests[${index}].key`);
    if (seen.has(key)) throw new ProviderContractError(`$.requests[${index}].key`, 'is duplicated');
    seen.add(key);
    const revision = item.ifNoneMatch === undefined
      ? undefined
      : nonnegativeInteger(item.ifNoneMatch, `$.requests[${index}].ifNoneMatch`);
    return { key, ...(revision === undefined ? {} : { ifNoneMatch: revision }) };
  });
  return {
    ...(record.knownServerGeneration === undefined
      ? {}
      : { knownServerGeneration: identifier(record.knownServerGeneration, '$.knownServerGeneration') }),
    ...(record.capabilityRevision === undefined
      ? {}
      : { capabilityRevision: identifier(record.capabilityRevision, '$.capabilityRevision') }),
    ...(record.focusedConversationId === undefined
      ? {}
      : { focusedConversationId: identifier(record.focusedConversationId, '$.focusedConversationId') }),
    ...(record.focusedExecutionId === undefined
      ? {}
      : { focusedExecutionId: identifier(record.focusedExecutionId, '$.focusedExecutionId') }),
    ...(record.historySync === undefined
      ? {}
      : { historySync: choice(record.historySync, ['if-stale', 'force'], '$.historySync') }),
    ...(record.visibility === undefined
      ? {}
      : { visibility: choice(record.visibility, ['foreground', 'background', 'inactive'], '$.visibility') }),
    requests,
  };
}

/**
 * Defense in depth for the browser boundary. Provider-native cursors, wire
 * envelopes, credentials, and unbounded raw payloads are server-only even if a
 * future mapper accidentally adds them to an otherwise typed object.
 */
export function assertViewerSafeNativeResource(value: unknown): asserts value is NativeAgentResourceValue {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new Error('Native Agent resource must be JSON serializable.');
  }
  if (encoded === undefined || new TextEncoder().encode(encoded).byteLength > NATIVE_AGENT_LIMITS.resourceBytes) {
    throw new Error(`Native Agent resource exceeds ${NATIVE_AGENT_LIMITS.resourceBytes} bytes.`);
  }
  inspectViewerValue(value, '$', 0);
}

function inspectViewerValue(value: unknown, path: string, depth: number) {
  if (depth > 32) throw new Error(`${path} exceeds the viewer resource nesting limit.`);
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      inspectViewerValue(value[index], `${path}[${index}]`, depth + 1);
    }
    return;
  }
  if (!value || typeof value !== 'object') throw new Error(`${path} is not JSON-safe.`);
  for (const [key, child] of Object.entries(value)) {
    if (isPrivateViewerKey(key)) throw new Error(`${path}.${key} is server-private.`);
    inspectViewerValue(child, `${path}.${key}`, depth + 1);
  }
}

function isPrivateViewerKey(key: string) {
  const normalized = key.replaceAll(/[-_]/gu, '').toLowerCase();
  return normalized === 'native'
    || normalized === 'sessionid'
    || normalized === 'nativesession'
    || normalized === 'resumecursor'
    || normalized === 'authorizationheader'
    || normalized === 'rawartifactref'
    || normalized === 'providereventenvelope'
    || normalized.includes('bearertoken')
    || normalized.includes('accesstoken')
    || normalized.includes('refreshtoken');
}

function strict(
  value: unknown,
  path: string,
  allowed: readonly string[],
  optional: readonly string[] = [],
) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProviderContractError(path, 'must be an object');
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) throw new ProviderContractError(`${path}.${key}`, 'is not allowed');
  }
  for (const key of allowed) {
    if (!optional.includes(key) && !(key in record)) {
      throw new ProviderContractError(`${path}.${key}`, 'is required');
    }
  }
  return record;
}

function string(value: unknown, path: string, limit = 8 * 1024) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ProviderContractError(path, 'must be a nonempty string');
  }
  if ([...value].length > limit) throw new ProviderContractError(path, `exceeds ${limit} characters`);
  return value;
}

function identifier(value: unknown, path: string) {
  const result = string(value, path, 512);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/u.test(result)) {
    throw new ProviderContractError(path, 'contains unsupported identifier characters');
  }
  return result;
}

function choice<const T extends readonly string[]>(value: unknown, choices: T, path: string): T[number] {
  if (typeof value !== 'string' || !choices.includes(value)) {
    throw new ProviderContractError(path, `must be one of ${choices.join(', ')}`);
  }
  return value as T[number];
}

function nonnegativeInteger(value: unknown, path: string) {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ProviderContractError(path, 'must be a nonnegative safe integer');
  }
  return value as number;
}

function resourceKey(value: unknown, path: string): NativeAgentResourceKey {
  const key = string(value, path, 2 * 1024);
  if (key === NATIVE_AGENT_RESOURCE_KEYS.providers || key === NATIVE_AGENT_RESOURCE_KEYS.conversations) {
    return key;
  }
  if (/^agent\/(?:models|conversation|conversation-versions|runtime|queue|turn|execution):[A-Za-z0-9][A-Za-z0-9._:@+/-]*$/u.test(key)) {
    return key as NativeAgentResourceKey;
  }
  if (/^agent\/(?:transcript|execution-transcript|artifact):[A-Za-z0-9][A-Za-z0-9._:@+/-]*:[A-Za-z0-9][A-Za-z0-9._:@+/-]*$/u.test(key)) {
    return key as NativeAgentResourceKey;
  }
  if (/^agent\/strand-transcript:[A-Za-z0-9][A-Za-z0-9._%+/-]*:[A-Za-z0-9][A-Za-z0-9._%+/-]*:[A-Za-z0-9][A-Za-z0-9._:@+/-]*$/u.test(key)) {
    return key as NativeAgentResourceKey;
  }
  throw new ProviderContractError(path, 'is not a Native Agent resource key');
}
