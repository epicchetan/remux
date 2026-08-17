import type { AgentResourceInvalidation } from './transcript.ts';

export const AGENT_METHODS = {
  resourcesRead: 'remux/agent/resources/read',
  transcriptResourcesRead: 'remux/agent/transcript/resources/read',
  authLoginStart: 'remux/agent/auth/login/start',
  authLoginCancel: 'remux/agent/auth/login/cancel',
  authLogout: 'remux/agent/auth/logout',
  modelsRead: 'remux/agent/models/read',
  artifactRead: 'remux/agent/artifact/read',
  turnRead: 'remux/agent/turn/read',
  conversationCreate: 'remux/agent/conversation/create',
  messageSend: 'remux/agent/conversation/message/send',
  messageQueueRemove: 'remux/agent/conversation/message/queue/remove',
  messageQueueRunNow: 'remux/agent/conversation/message/queue/run-now',
  messageEdit: 'remux/agent/conversation/message/edit',
  messageFork: 'remux/agent/conversation/message/fork',
  filesSearch: 'remux/agent/files/search',
  turnInterrupt: 'remux/agent/conversation/turn/interrupt',
  resourcesInvalidated: 'remux/agent/resources/invalidated',
} as const;

export const AGENT_RESOURCE_KEYS = {
  auth: 'auth',
  models: 'models',
  conversationList: 'conversation-list',
  runtime: 'runtime',
} as const;

export type AgentResourceKey =
  | typeof AGENT_RESOURCE_KEYS[keyof typeof AGENT_RESOURCE_KEYS]
  | `conversation:${string}`
  | `context:${string}`
  | `queue:${string}`;

export function conversationResourceKey(conversationId: string): `conversation:${string}` {
  return `conversation:${conversationId}`;
}

export function contextResourceKey(conversationId: string): `context:${string}` {
  return `context:${conversationId}`;
}

export function queueResourceKey(conversationId: string): `queue:${string}` {
  return `queue:${conversationId}`;
}

export type ReasoningLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type AgentFileSearchResult = {
  absolutePath: string;
  id: string;
  kind: 'directory' | 'file';
  name: string;
  parentPath: string;
  path: string;
  score: number;
};

export type AgentFileSearchParams = {
  cwd: string;
  limit?: number;
  query: string;
};

export type AgentFileSearchResponse = {
  results: AgentFileSearchResult[];
};

export type AuthValue = {
  state: 'signed-out' | 'signing-in' | 'signed-in' | 'error';
  operationId: string | null;
  displayLabel: string | null;
  verificationUri: string | null;
  userCode: string | null;
  expiresAt: string | null;
  progress: string | null;
  error: string | null;
};

export type ModelInfo = {
  id: string;
  name: string;
  provider: 'openai-codex';
  contextWindow: number;
  supportedReasoning: ReasoningLevel[];
};

export type ModelsValue = {
  models: ModelInfo[];
  defaultModelId: string | null;
  error: string | null;
};

export type ContextProbe = {
  hookVersion: 'agent-durable-v1';
  modelCallCount: number;
  messageCount: number;
  messageHash: string | null;
  orderedMessageHashes: string[];
  estimatedBytes: number;
  provider: 'openai-codex';
  modelId: string;
  providerRequestMode: 'none' | 'full' | 'continuation';
};

export type ConversationSummary = {
  id: string;
  title: string;
  preview: string;
  cwd: string;
  modelId: string;
  reasoning: ReasoningLevel;
  status: 'idle' | 'running' | 'error';
  latestTurnId: string | null;
  createdAt: number;
  updatedAt: number;
};

export type ConversationListValue = {
  conversations: ConversationSummary[];
  truncated: boolean;
};

export type ContextInspectorArtifact = {
  hash: string;
  byteLength: number;
  mediaType: string;
};

export const CONTEXT_INSPECTOR_VERSION = 7 as const;

export type ContextInspectorValue = {
  version: typeof CONTEXT_INSPECTOR_VERSION;
  conversationId: string;
  inferenceId: string;
  frameId: string;
  basisSequence: number;
  compilerVersion: string;
  policyVersion: string;
  estimatedInputTokens: number;
  semanticHash: string;
  buildDurationMs: number;
  transportMode: 'full' | 'continuation';
  messageCount: number;
  turnCount: number;
  logicalHash: string;
  renderedHash: string;
  fixedContractsHash: string;
  manifestArtifact: ContextInspectorArtifact;
  dispatchArtifact: ContextInspectorArtifact;
  groups: ReadonlyArray<{
    turnId: string;
    source: string;
    messageCount: number;
    estimatedTokens: number;
    roles: { user: number; assistant: number; tool: number };
  }>;
  groupsTruncated: boolean;
  scopeKind: 'turn' | 'work_unit';
  requestedPlan: TurnContextPlan;
  selectedTurns: ReadonlyArray<{
    turnId: string;
    resolution: Exclude<TurnContextResolution, 'off'>;
    origin: 'automatic' | 'explicit';
    messageCount: number;
    estimatedTokens: number;
  }>;
  layers: ReadonlyArray<{
    kind: 'selected_dialogue' | 'selected_full_turns' | 'provider_checkpoint' | 'active_scope';
    hash: string;
    estimatedTokens: number;
    sources: readonly string[];
    sourceCount: number;
    sourcesTruncated: boolean;
  }>;
  omissions: ReadonlyArray<{
    source: string;
    reason: string;
    retrieval: string;
    count: number;
  }>;
  omissionsTruncated: boolean;
  compaction: {
    epoch: number;
    checkpointSequence: number | null;
    compactedThroughSequence: number | null;
    warningIssued: boolean;
    modelRequested: boolean;
    policyInputTokens: number;
  };
};

export function isContextInspectorValue(value: unknown): value is ContextInspectorValue {
  if (!isRecord(value) || value.version !== CONTEXT_INSPECTOR_VERSION) return false;
  return typeof value.conversationId === 'string' &&
    typeof value.inferenceId === 'string' &&
    typeof value.frameId === 'string' &&
    isNonnegativeSafeInteger(value.basisSequence) &&
    typeof value.compilerVersion === 'string' &&
    typeof value.policyVersion === 'string' &&
    isNonnegativeSafeInteger(value.estimatedInputTokens) &&
    typeof value.semanticHash === 'string' &&
    isNonnegativeSafeInteger(value.buildDurationMs) &&
    (value.transportMode === 'full' || value.transportMode === 'continuation') &&
    isNonnegativeSafeInteger(value.messageCount) &&
    isNonnegativeSafeInteger(value.turnCount) &&
    typeof value.logicalHash === 'string' &&
    typeof value.renderedHash === 'string' &&
    typeof value.fixedContractsHash === 'string' &&
    isContextInspectorArtifact(value.manifestArtifact) &&
    isContextInspectorArtifact(value.dispatchArtifact) &&
    Array.isArray(value.groups) && value.groups.every(isContextInspectorGroup) &&
    typeof value.groupsTruncated === 'boolean' &&
    (value.scopeKind === 'turn' || value.scopeKind === 'work_unit') &&
    isTurnContextPlan(value.requestedPlan) &&
    Array.isArray(value.selectedTurns) && value.selectedTurns.every(isContextInspectorTurn) &&
    Array.isArray(value.layers) && value.layers.every(isContextInspectorLayer) &&
    Array.isArray(value.omissions) && value.omissions.every(isContextInspectorOmission) &&
    typeof value.omissionsTruncated === 'boolean' &&
    isContextInspectorCompaction(value.compaction);
}

function isContextInspectorArtifact(value: unknown): value is ContextInspectorArtifact {
  return isRecord(value) &&
    typeof value.hash === 'string' &&
    isNonnegativeSafeInteger(value.byteLength) &&
    typeof value.mediaType === 'string';
}

function isContextInspectorGroup(value: unknown) {
  return isRecord(value) &&
    typeof value.turnId === 'string' &&
    typeof value.source === 'string' &&
    isNonnegativeSafeInteger(value.messageCount) &&
    isNonnegativeSafeInteger(value.estimatedTokens) &&
    isRecord(value.roles) &&
    isNonnegativeSafeInteger(value.roles.user) &&
    isNonnegativeSafeInteger(value.roles.assistant) &&
    isNonnegativeSafeInteger(value.roles.tool);
}

function isTurnContextPlan(value: unknown): value is TurnContextPlan {
  return isRecord(value) &&
    value.version === 1 &&
    isNonnegativeSafeInteger(value.automaticDialogueTurns) &&
    Array.isArray(value.overrides) &&
    value.overrides.every((override) => isRecord(override) &&
      typeof override.turnId === 'string' &&
      (override.resolution === 'off' || override.resolution === 'dialogue' ||
        override.resolution === 'full'));
}

function isContextInspectorTurn(value: unknown) {
  return isRecord(value) &&
    typeof value.turnId === 'string' &&
    (value.resolution === 'dialogue' || value.resolution === 'full') &&
    (value.origin === 'automatic' || value.origin === 'explicit') &&
    isNonnegativeSafeInteger(value.messageCount) &&
    isNonnegativeSafeInteger(value.estimatedTokens);
}

function isContextInspectorLayer(value: unknown) {
  return isRecord(value) &&
    (value.kind === 'selected_dialogue' || value.kind === 'selected_full_turns' ||
      value.kind === 'provider_checkpoint' || value.kind === 'active_scope') &&
    typeof value.hash === 'string' &&
    isNonnegativeSafeInteger(value.estimatedTokens) &&
    Array.isArray(value.sources) && value.sources.every((source) => typeof source === 'string') &&
    isNonnegativeSafeInteger(value.sourceCount) &&
    typeof value.sourcesTruncated === 'boolean';
}

function isContextInspectorOmission(value: unknown) {
  return isRecord(value) &&
    typeof value.source === 'string' &&
    typeof value.reason === 'string' &&
    typeof value.retrieval === 'string' &&
    isNonnegativeSafeInteger(value.count);
}

function isContextInspectorCompaction(value: unknown) {
  return isRecord(value) &&
    isNonnegativeSafeInteger(value.epoch) &&
    isNullableNonnegativeSafeInteger(value.checkpointSequence) &&
    isNullableNonnegativeSafeInteger(value.compactedThroughSequence) &&
    typeof value.warningIssued === 'boolean' &&
    typeof value.modelRequested === 'boolean' &&
    isNonnegativeSafeInteger(value.policyInputTokens);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isNullableNonnegativeSafeInteger(value: unknown): value is number | null {
  return value === null || isNonnegativeSafeInteger(value);
}

export type TurnReadParams = {
  conversationId: string;
  turnId: string;
};

export type TurnReadValue = {
  conversationId: string;
  turnId: string;
  reasoning: ReasoningLevel;
  state: 'running' | 'completed' | 'failed' | 'interrupted' | 'interrupted_by_restart';
  terminal: boolean;
  terminalSequence: number | null;
  error: string | null;
  errorCode: 'provider_error' | 'runtime_error' | 'storage_error' | null;
  contextPlan: TurnContextPlan;
  createdAt: number;
  updatedAt: number;
};

export type AgentRuntimeValue = {
  conversationId: string | null;
  state: 'unloaded' | 'loading' | 'idle' | 'running' | 'interrupting' | 'error';
  activeTurnId: string | null;
  activeTurnElapsedMs: number | null;
  contextProbe: ContextProbe | null;
  error: string | null;
};

export type AgentPendingQueueEntry = {
  attachmentCount: number;
  createdAt: number;
  id: string;
  mentionCount: number;
  text: string;
};

export type AgentPendingQueueValue = {
  conversationId: string;
  entries: AgentPendingQueueEntry[];
};

/** Viewer-level projection combining one durable conversation with the singleton runtime. */
export type ConversationValue = Omit<ConversationSummary, 'status'> & {
  status: ConversationSummary['status'] | 'loading' | 'interrupting';
  activeTurnId: string | null;
  activeTurnElapsedMs: number | null;
  contextProbe: ContextProbe;
  error: string | null;
};

export type AgentResourceValue =
  | AuthValue
  | ModelsValue
  | AgentRuntimeValue
  | ConversationSummary
  | ConversationListValue
  | ContextInspectorValue
  | AgentPendingQueueValue;

export type ResourceReadRequest = {
  key: AgentResourceKey;
  ifNoneMatch?: number;
};

export type ResourceReadParams = {
  requests: ResourceReadRequest[];
};

export type ResourceReadItem =
  | {
      key: AgentResourceKey;
      status: 'ok';
      revision: number;
      basisSequence: number;
      serverGeneration: string;
      value: AgentResourceValue;
    }
  | {
      key: AgentResourceKey;
      status: 'notModified';
      revision: number;
      basisSequence: number;
      serverGeneration: string;
    }
  | {
      key: AgentResourceKey;
      status: 'missing';
      serverGeneration: string;
    };

export type ResourceReadResult = {
  resources: ResourceReadItem[];
};

export type ResourcesInvalidatedParams = {
  invalidations: AgentResourceInvalidation[];
  serverGeneration: string;
};

export type LoginStartResult = {
  accepted: true;
  operationId: string;
};

export type ArtifactReadRange =
  | { kind: 'bytes'; offset: number; byteLength: number }
  | { kind: 'utf8'; offset: number; byteLength: number }
  | { kind: 'lines'; startLine: number; lineCount: number };

export type ArtifactReadParams = {
  hash: string;
  range: ArtifactReadRange;
};

export type ArtifactReadResult = {
  hash: string;
  mediaType: string;
  totalByteLength: number;
  totalLineCount: number | null;
  range:
    | { kind: 'bytes'; offset: number; byteLength: number }
    | { kind: 'utf8'; offset: number; byteLength: number }
    | { kind: 'lines'; startLine: number; endLine: number };
  encoding: 'base64' | 'utf8';
  content: string;
  truncated: boolean;
  nextRange: ArtifactReadRange | null;
};

export type ConversationCreateParams = {
  operationId: string;
  cwd: string;
  modelId: string;
  reasoning: ReasoningLevel;
};

export type ConversationCreateResult = {
  conversationId: string;
};

export type AgentComposerMessagePart =
  | {
      text: string;
      type: 'text';
    }
  | {
      dataUrl: string;
      mimeType?: string | null;
      name?: string | null;
      type: 'image';
    }
  | {
      kind?: 'directory' | 'file';
      name?: string | null;
      path: string;
      type: 'mention';
    };

export const DEFAULT_TURN_CONTEXT_DIALOGUE_TURNS = 2;

export type TurnContextResolution = 'off' | 'dialogue' | 'full';

export type TurnContextOverride = {
  turnId: string;
  resolution: TurnContextResolution;
};

export type TurnContextPlan = {
  version: 1;
  automaticDialogueTurns: number;
  overrides: TurnContextOverride[];
};

export type MessageSendParams = {
  operationId: string;
  conversationId: string;
  clientMessageId: string;
  parts?: AgentComposerMessagePart[];
  contextPlan: TurnContextPlan;
  reasoning: ReasoningLevel;
  text: string;
};

export type MessageSendResult =
  | { accepted: true; operationId: string; turnId: string; delivery?: 'sent' }
  | { accepted: true; operationId: string; turnId: null; delivery: 'queued' };

export type MessageQueueMutationParams = {
  conversationId: string;
  operationId: string;
};

export type MessageQueueMutationResult = {
  status: 'removed' | 'running' | 'retained';
};

export type MessageBranchParams = {
  clientMessageId: string;
  operationId: string;
  parts?: AgentComposerMessagePart[];
  contextPlan: TurnContextPlan;
  reasoning: ReasoningLevel;
  sourceConversationId: string;
  sourceMessageId: string;
  sourceTurnId: string;
  text: string;
};

export type MessageBranchResult = {
  conversationId: string;
  turnId: string;
};

export type AgentCommandErrorData =
  | {
      kind: 'operation_conflict';
      operationId: string;
    }
  | {
      kind: 'client_message_conflict';
      clientMessageId: string;
    }
  | {
      kind: 'active_runtime_busy';
      conversationId: string;
      turnId: string;
    }
  | {
      kind: 'turn_active';
      conversationId: string;
      turnId: string;
    }
  | {
      kind: 'workspace_unavailable';
      conversationId: string;
      cwd: string;
    }
  | {
      kind: 'model_unavailable';
      conversationId: string;
      modelId: string;
    }
  | {
      kind: 'runtime_hydration_failed';
      conversationId: string;
    };

export type TurnInterruptParams = {
  conversationId: string;
  turnId: string;
};

export type LoginCancelParams = {
  operationId: string;
};

export type WorkspaceReadParams = {
  path: string;
  startLine?: number;
  lineCount?: number;
};

export type WorkspaceReadResult = {
  path: string;
  contentHash: string;
  startLine: number;
  endLine: number;
  text: string;
  truncated: boolean;
};
