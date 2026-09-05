export const AGENT_TRANSCRIPT_PROTOCOL_VERSION = 7 as const;
export const AGENT_TRANSCRIPT_PROJECTION_VERSION = 'agent-turn-render-v7' as const;

export const DEFAULT_TRANSCRIPT_TAIL_TURNS = 24;
export const DEFAULT_TRANSCRIPT_PREPEND_TURNS = 16;
export const MAX_TRANSCRIPT_WINDOW_TURNS = 40;
export const MAX_TRANSCRIPT_KNOWN_TURNS = 80;
export const MAX_TRANSCRIPT_REQUESTS = 64;
export const MAX_TRANSCRIPT_RESPONSE_BYTES = 8 * 1024 * 1024;
export const MAX_TURN_FRAME_BYTES = 1024 * 1024;
export const MAX_VISIBLE_TEXT_BYTES = 48 * 1024;
export const MAX_WORK_ENTRY_DETAIL_BYTES = 64 * 1024;

export type AgentTurnStatus =
  | 'queued'
  | 'inProgress'
  | 'completed'
  | 'failed'
  | 'interrupted';

export type AgentTurnError = {
  code: 'provider_error' | 'runtime_error' | 'storage_error';
  message: string;
};

export type AgentTextContentReference = {
  sha256: string;
  byteLength: number;
  returnedBytes: number;
  truncated: true;
  artifactHash: string | null;
  nextRange: {
    kind: 'utf8';
    offset: number;
    byteLength: number;
  } | null;
};

export type AgentUserMessagePart =
  | {
      text: string;
      type: 'text';
    }
  | {
      kind: 'directory' | 'file';
      name: string;
      path: string;
      type: 'mention';
    }
  | {
      artifactHash: string;
      dataUrl?: string;
      mimeType: string;
      name: string;
      sizeBytes: number;
      type: 'image';
    };

export type AgentUserMessageSegment = {
  id: string;
  type: 'userMessage';
  clientMessageId: string | null;
  revision: string;
  text: string;
  parts?: AgentUserMessagePart[];
  content?: AgentTextContentReference;
};

export type AgentAssistantMessageSegment = {
  id: string;
  type: 'assistantMessage';
  revision: string;
  text: string;
  content?: AgentTextContentReference;
};

export type AgentChildExecutionStatus =
  | 'running'
  | 'completed'
  | 'partial'
  | 'blocked'
  | 'abandoned';

export type AgentWorkRenderSegment = {
  id: string;
  type: 'work';
  scopeId: string;
  state: 'running' | 'completed' | 'failed' | 'interrupted';
  revision: string;
  layoutRevision: string;
  durationMs: number | null;
  inferenceCount: number;
  operationCount: number;
  childExecutionCount: number;
};

export type AgentCompactionSegment = {
  id: string;
  type: 'compaction';
  revision: string;
  status: 'compacting' | 'compacted' | 'failed';
  trigger: 'manual' | 'automatic';
  beforeTokens: number | null;
  afterTokens: number | null;
  error?: string;
};

export type AgentTurnSegment =
  | AgentUserMessageSegment
  | AgentWorkRenderSegment
  | AgentAssistantMessageSegment
  | AgentCompactionSegment;

export type AgentTurnRenderFrame = {
  id: string;
  pathEntryId?: string;
  strandId?: string;
  ordinal?: number;
  status: AgentTurnStatus;
  startedAt: number | null;
  completedAt: number | null;
  durationMs: number | null;
  error: AgentTurnError | null;
  interruptionReason?: 'restart' | 'user' | null;
  renderRevision: string;
  layoutRevision: string;
  segments: AgentTurnSegment[];
};

export type AgentTranscriptSyncRequest = {
  type: 'transcriptSync';
  protocolVersion: typeof AGENT_TRANSCRIPT_PROTOCOL_VERSION;
  projectionVersion: typeof AGENT_TRANSCRIPT_PROJECTION_VERSION;
  knownConversationRevision?: string;
  knownNativeRevision?: number;
  knownTurns?: Array<{
    turnId: string;
    renderRevision: string;
  }>;
  window:
    | {
        kind: 'tail';
        count?: number;
      }
    | {
        kind: 'around';
        turnId: string;
        before: number;
        after: number;
      }
    | {
        kind: 'range';
        startTurnId: string;
        endTurnId: string;
      };
};

export type AgentTranscriptSyncResource = {
  protocolVersion: typeof AGENT_TRANSCRIPT_PROTOCOL_VERSION;
  projectionVersion: typeof AGENT_TRANSCRIPT_PROJECTION_VERSION;
  conversationId: string;
  conversationRevision: string;
  basisSequence: number;
  activeTurnId: string | null;
  turnOrder: string[];
  turns: AgentTurnRenderResult[];
  removedTurnIds: string[];
  window: {
    startIndex: number;
    endIndexExclusive: number;
    hasEarlier: boolean;
    hasLater: boolean;
    turnIds: string[];
  };
};

export type AgentTurnRenderResult =
  | {
      status: 'ok';
      turnId: string;
      renderRevision: string;
      frame: AgentTurnRenderFrame;
    }
  | {
      status: 'notModified';
      turnId: string;
      renderRevision: string;
    }
  | {
      status: 'error';
      turnId: string;
      renderRevision: string;
      code: 'frameTooLarge' | 'projectionFailed';
      message: string;
      frame: AgentTurnRenderFrame;
    };

export type AgentExecutionScopeRequest = {
  type: 'executionScope';
  protocolVersion: typeof AGENT_TRANSCRIPT_PROTOCOL_VERSION;
  turnId: string;
  scopeId: string;
  knownRevision?: string;
  window?:
    | { kind: 'tail'; count?: number }
    | { kind: 'around'; inferenceId: string; before: number; after: number }
    | { kind: 'range'; startInferenceId: string; endInferenceId: string };
};

export type AgentExecutionArtifactReference = {
  ref: string;
  snapshotRef: string;
  byteLength: number;
};

export type AgentToolPresentation = {
  category: 'command' | 'read' | 'edit' | 'search' | 'context' | 'tool';
  label: string;
  subject: string | null;
};

export type AgentToolCallSummary = {
  id: string;
  callId: string;
  name: string;
  presentation: AgentToolPresentation;
  status: 'running' | 'completed' | 'failed' | 'interrupted';
  revision: string;
  detailPreview: string | null;
  outputPreview: string | null;
  durationMs: number | null;
  childScopeId: string | null;
  childBoundary: string | null;
  childState: 'running' | 'completed' | 'partial' | 'blocked' | 'failed' |
    'interrupted' | 'abandoned' | null;
  childDurationMs: number | null;
  childOperationCount: number;
  childArtifactCount: number;
  hasDetail: boolean;
  diffArtifactId?: string;
};

export type AgentInferenceBlock =
  | {
      id: string;
      type: 'reasoning' | 'commentary' | 'assistantText' | 'notice';
      state: 'streaming' | 'final' | 'partial';
      revision: string;
      text: string;
      /** Stable semantic marker for provider/runtime notices. */
      code?: string;
      /** Native reasoning-summary boundaries, when this is a reasoning block. */
      parts?: string[];
      content?: AgentTextContentReference;
    }
  | {
      id: string;
      type: 'action';
      state: 'running' | 'completed' | 'failed' | 'interrupted';
      revision: string;
      call: AgentToolCallSummary;
    };

export type AgentOperationDetailRequest = {
  type: 'operationDetail';
  protocolVersion: typeof AGENT_TRANSCRIPT_PROTOCOL_VERSION;
  turnId: string;
  scopeId: string;
  operationId: string;
  knownRevision?: string;
};

export type AgentOperationDetailResource = {
  conversationId: string;
  turnId: string;
  scopeId: string;
  operationId: string;
  revision: string;
  detail: string | null;
  output: string | null;
  truncation: {
    originalBytes: number;
    returnedBytes: number;
    truncated: boolean;
  };
  content?: {
    detail?: AgentTextContentReference;
    output?: AgentTextContentReference;
  };
};

export type AgentInferenceTrace = {
  id: string;
  ordinal: number;
  state: 'running' | 'completed' | 'failed' | 'interrupted' | 'superseded';
  revision: string;
  startedAt: number;
  completedAt: number | null;
  durationMs: number | null;
  /** Exact provider order. Repeated block kinds are intentional. */
  blocks: AgentInferenceBlock[];
};

export type AgentTurnRenderRequest = {
  type: 'turn';
  protocolVersion: typeof AGENT_TRANSCRIPT_PROTOCOL_VERSION;
  turnId: string;
  knownRevision?: string;
  knownNativeRevision?: number;
};

export type AgentExecutionScopeResource = {
  conversationId: string;
  turnId: string;
  scopeId: string;
  parentScopeId: string | null;
  parentOperationId: string | null;
  kind: 'turn' | 'childExecution';
  state: 'running' | 'completed' | 'partial' | 'blocked' | 'failed' |
    'interrupted' | 'abandoned';
  revision: string;
  basisSequence: number;
  startedAt: number;
  completedAt: number | null;
  durationMs: number | null;
  boundary: string | null;
  inferenceOrder: string[];
  inferences: AgentInferenceTrace[];
  window: {
    startIndex: number;
    endIndexExclusive: number;
    hasEarlier: boolean;
    hasLater: boolean;
  };
  result: string | null;
  artifacts: AgentExecutionArtifactReference[];
};

export type AgentTranscriptResourceRequest =
  | AgentTranscriptSyncRequest
  | AgentTurnRenderRequest
  | AgentExecutionScopeRequest
  | AgentOperationDetailRequest;

export type AgentTranscriptResourcesReadParams = {
  conversationId: string;
  requests: AgentTranscriptResourceRequest[];
};

export type AgentTranscriptResourceResult = {
  requestIndex: number;
  key: string;
  status: 'ok' | 'notModified' | 'missing' | 'error';
  basisSequence?: number;
  code?: 'staleCursor' | 'resourceUnavailable';
  revision?: string;
  nativeRevision?: number;
  reason?: string;
  value?: AgentTranscriptSyncResource | AgentTurnRenderFrame | AgentExecutionScopeResource | AgentOperationDetailResource;
};

export type AgentTranscriptResourcesReadResult = {
  conversationId: string;
  serverGeneration: string;
  resources: AgentTranscriptResourceResult[];
};

export type AgentResourceInvalidation =
  | {
      type: 'resource';
      key: 'auth' | 'models' | 'conversation-list' | 'runtime' | `conversation:${string}` | `context:${string}` | `queue:${string}`;
      reason: 'created' | 'updated' | 'deleted';
    }
  | {
      type: 'transcript';
      key: `transcript:${string}`;
      conversationId: string;
      turnId?: string;
      reason: 'sendAccepted' | 'runtimeEvent' | 'terminal';
      affectsOrder: boolean;
      affectsLayout: boolean;
      basisSequence: number;
    }
  | {
      type: 'executionScope';
      key: string;
      conversationId: string;
      turnId: string;
      scopeId: string;
      reason: 'runtimeEvent' | 'terminal';
      affectsLayout: boolean;
      basisSequence: number;
    };

export function executionScopeResourceKey(
  conversationId: string,
  turnId: string,
  scopeId: string,
) {
  return `executionScope:${conversationId}:${turnId}:${scopeId}`;
}

export function operationDetailResourceKey(
  conversationId: string,
  turnId: string,
  scopeId: string,
  operationId: string,
) {
  return `operationDetail:${conversationId}:${turnId}:${scopeId}:${operationId}`;
}
