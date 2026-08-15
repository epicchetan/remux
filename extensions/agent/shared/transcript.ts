export const AGENT_TRANSCRIPT_PROTOCOL_VERSION = 4 as const;
export const AGENT_TRANSCRIPT_PROJECTION_VERSION = 'agent-turn-render-v4' as const;

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

export type AgentWorkUnitStatus =
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
  workUnitCount: number;
};

export type AgentTurnSegment =
  | AgentUserMessageSegment
  | AgentWorkRenderSegment
  | AgentAssistantMessageSegment;

export type AgentTurnRenderFrame = {
  id: string;
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

export type AgentWorkUnitResourceReference = {
  ref: string;
  role: 'authority' | 'deliverable' | 'evidence';
  description?: string;
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
  childObjective: string | null;
  childState: 'running' | 'completed' | 'partial' | 'blocked' | 'failed' |
    'interrupted' | 'abandoned' | null;
  childDurationMs: number | null;
  childOperationCount: number;
  childReturnedResourceCount: number;
  hasDetail: boolean;
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
  /** Provider content order. Absent only during a viewer/server rolling reload. */
  contentOrder?: Array<'reasoning' | 'commentary' | 'actions'>;
  commentary: null | {
    kind: 'assistantCommentary';
    state: 'streaming' | 'final' | 'partial';
    text: string;
    content?: AgentTextContentReference;
  };
  reasoning: null | {
    kind: 'providerSummary';
    state: 'streaming' | 'final' | 'partial';
    text: string;
    content?: AgentTextContentReference;
  };
  actionGroup: null | {
    id: string;
    status: 'running' | 'completed' | 'failed' | 'interrupted';
    callCount: number;
    calls: AgentToolCallSummary[];
  };
};

export type AgentExecutionScopeResource = {
  conversationId: string;
  turnId: string;
  scopeId: string;
  parentScopeId: string | null;
  parentOperationId: string | null;
  kind: 'turn' | 'workUnit';
  state: 'running' | 'completed' | 'partial' | 'blocked' | 'failed' |
    'interrupted' | 'abandoned';
  revision: string;
  basisSequence: number;
  startedAt: number;
  completedAt: number | null;
  durationMs: number | null;
  objective: string | null;
  doneWhen: string[];
  providedResources: AgentWorkUnitResourceReference[];
  inferenceOrder: string[];
  inferences: AgentInferenceTrace[];
  window: {
    startIndex: number;
    endIndexExclusive: number;
    hasEarlier: boolean;
    hasLater: boolean;
  };
  result: string | null;
  returnedResources: AgentWorkUnitResourceReference[];
};

export type AgentTranscriptResourceRequest =
  | AgentTranscriptSyncRequest
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
  code?: 'staleCursor' | 'resourceUnavailable';
  revision?: string;
  reason?: string;
  value?: AgentTranscriptSyncResource | AgentExecutionScopeResource | AgentOperationDetailResource;
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
