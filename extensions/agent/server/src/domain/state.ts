import type {
  AgentComposerMessagePart,
  AgentPendingQueueValue,
  ConversationListValue,
  ConversationSummary,
  ContextInspectorValue,
  MessageSendParams,
  ReasoningLevel,
} from '../../../shared/protocol.ts';
import type {
  AgentTextContentReference,
  AgentUserMessagePart,
} from '../../../shared/transcript.ts';
import type {
  DurableContextSnapshot,
  LogicalContextMessage,
} from '../logical-context.ts';
import type { ThreadContextFrameCandidate } from '../context/manifest.ts';
import type { CanonicalJsonValue } from '../storage/canonical-json.ts';
import type {
  WorkUnitResourceView,
  WorkUnitReturnStatus,
} from './work.ts';

export type CreateConversationParams = {
  operationId: string;
  cwd: string;
  modelId: string;
  reasoning: ReasoningLevel;
  inheritThreadFrom?: {
    conversationId: string;
    turnId: string;
    position: 'before' | 'after';
  };
};

export type CreateConversationResult = {
  accepted: true;
  operationId: string;
  projectId: string;
  conversationId: string;
  threadDocumentId: string;
  threadVersionId: string;
  basisSequence: number;
  replayed: boolean;
};

export type DurableContentRef =
  | { kind: 'inline'; text: string; byteLength: number; sha256: string }
  | {
      kind: 'artifact';
      hash: string;
      byteLength: number;
      mediaType: string;
      storagePath: string;
    };

export type DurableTurnHandle = {
  projectId: string;
  conversationId: string;
  turnId: string;
  scopeId: string;
};

export type AcceptTurnParams = {
  operationId: string;
  conversationId: string;
  clientMessageId: string;
  parts?: AgentComposerMessagePart[];
  text: string;
};

export type AcceptTurnResult = DurableTurnHandle & {
  accepted: true;
  operationId: string;
  clientMessageId: string;
  basisSequence: number;
  transcriptSequence: number;
  transcriptCreatedAt: number;
  userItemId: string;
  userContent?: AgentTextContentReference;
  userParts?: AgentUserMessagePart[];
  replayed: boolean;
};

export type DurableTranscriptMutation = {
  basisSequence: number;
  createdAt: number;
  itemId: string | null;
  detailText?: string;
  detailContent?: AgentTextContentReference;
  outputText?: string;
  outputContent?: AgentTextContentReference;
};

export type DurableToolCallMutation = DurableTranscriptMutation & {
  callId: string;
  name: string;
  operationId: string;
  sourceInferenceId: string | null;
};

export type DurableInferenceFinalization = {
  inferenceId: string;
  sequence: number;
  calls: DurableToolCallMutation[];
};

export type DurableTurnStatus = 'completed' | 'failed' | 'interrupted' | 'interrupted_by_restart';
export type DurableTurnErrorCode = 'provider_error' | 'runtime_error' | 'storage_error';

export type DurableTranscriptAction =
  | {
      type: 'turn';
      turnId: string;
      scopeId: string;
      clientMessageId: string;
      text: string;
      parts?: AgentUserMessagePart[];
      content?: AgentTextContentReference;
    }
  | {
      type: 'assistant';
      turnId: string;
      textDelta: string;
      reasoningDelta: string;
      textContent?: AgentTextContentReference;
      reasoningContent?: AgentTextContentReference;
    }
  | {
      type: 'tool-start';
      turnId: string;
      callId: string;
      name: string;
      args: unknown;
      detailText?: string;
      detailContent?: AgentTextContentReference;
    }
  | {
      type: 'tool-end';
      turnId: string;
      callId: string;
      result: unknown;
      isError: boolean;
      outputText?: string;
      outputContent?: AgentTextContentReference;
    }
  | {
      type: 'work-unit-start';
      turnId: string;
      scopeId: string;
      objective: string;
      doneWhen: string[];
      resourceCount: number;
      operationCount: number;
    }
  | {
      type: 'work-unit-finish';
      turnId: string;
      scopeId: string;
      status: WorkUnitReturnStatus | 'abandoned';
      resultPreview: string | null;
      resourceCount: number;
      durationMs?: number;
    }
  | {
      type: 'terminal';
      turnId: string;
      status: DurableTurnStatus;
      error: string | null;
      errorCode?: DurableTurnErrorCode | null;
      durationMs?: number;
    };

export type DurableTranscriptProjectionAction = DurableTranscriptAction & {
  sequence: number;
  createdAt: number;
  itemId: string | null;
};

export type DurableTranscriptProjection = {
  basisSequence: number;
  actions: DurableTranscriptProjectionAction[];
};

export type DurableTranscriptWindow = {
  requestIndex: number;
  startIndex: number;
  endIndexExclusive: number;
  hasEarlier: boolean;
  hasLater: boolean;
  turnIds: string[];
};

export type DurableTranscriptWindowProjection = DurableTranscriptProjection & {
  selectedTurnIds: string[];
  windows: DurableTranscriptWindow[];
  estimatedBytes: number;
};

export type AgentStateEvent = {
  sequence: number;
  eventId: string;
  projectId: string;
  conversationId: string;
  turnId: string | null;
  scopeId: string | null;
  type: string;
  actor: string;
  visibility: string;
  causalEventId: string | null;
  operationId: string | null;
  payload: CanonicalJsonValue | null;
  artifactHash: string | null;
  createdAt: number;
};

export type DurableResourceProjection = {
  key: 'conversation-list' | `conversation:${string}` | `context:${string}` | `queue:${string}`;
  basisSequence: number;
  value: ConversationListValue | ConversationSummary | ContextInspectorValue | AgentPendingQueueValue;
};

export type DurableQueuedTurn = MessageSendParams & {
  queueOperationId: string;
};

export type QueueTurnResult = {
  accepted: true;
  delivery: 'queued' | 'sent';
  operationId: string;
  replayed: boolean;
  turnId: string | null;
};

export type DurableArtifact = {
  hash: string;
  byteLength: number;
  mediaType: string;
  offset: number;
  bytes: Buffer;
};

export type ArtifactScrubReport = {
  orphanStoragePaths: string[];
  referencedArtifacts: number;
  verifiedBytes: number;
};

export type DurableContextBoundarySnapshot = DurableContextSnapshot & {
  frame: ThreadContextFrameCandidate;
  scopeId: string;
  scopeKind: 'turn' | 'work_unit';
  nextFrameOrdinal: number;
};

export type DurableInferenceContext = {
  basisSequence: number;
  logicalHash: string;
  renderedHash: string;
  orderedMessageHashes: readonly string[];
  messageCount: number;
  fixedContractsHash: string;
  frame: ThreadContextFrameCandidate;
  frameBuildDurationMs: number;
  activeMessages: readonly LogicalContextMessage[];
};

export type DurableArtifactDescriptor = {
  hash: string;
  byteLength: number;
  mediaType: string;
  storagePath: string;
};

export type PreparedReference = {
  ref: DurableContentRef;
  artifact: DurableArtifactDescriptor | null;
  sha256: string;
  text: string;
};

export type PreparedWorkUnitResource = {
  artifact: DurableArtifactDescriptor;
  content: string;
  view: WorkUnitResourceView;
};

export type PreparedWorkUnitEntry = {
  child: DurableTurnHandle;
  doneWhen: string[];
  materializedResources: PreparedWorkUnitResource[];
  objective: string;
  orientation: PreparedReference;
};

export type PreparedWorkUnitReturn = {
  status: WorkUnitReturnStatus;
  result: string;
  threadUpdate?: string;
  resources: PreparedWorkUnitResource[];
  bundle: string;
  resultArtifact: DurableArtifactDescriptor;
  folded: PreparedReference;
};
