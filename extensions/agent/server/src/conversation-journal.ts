import type {
  AcceptTurnParams,
  AcceptTurnResult,
  CreateConversationParams,
  CreateConversationResult,
  DurableTranscriptAction,
  DurableTranscriptProjection,
  DurableTranscriptWindowProjection,
  DurableTranscriptMutation,
  DurableTurnErrorCode,
  DurableTurnHandle,
  DurableResourceProjection,
  DurableArtifact,
  DurableContextBoundarySnapshot,
  DurableInferenceContext,
  DurableQueuedTurn,
  DurableWorkUnitTransition,
  QueueTurnResult,
} from './storage/repository.ts';
import type { AgentResourceKey } from '../../shared/protocol.ts';
import type {
  ContextUpdateInput,
  ContextWorkspaceView,
  JournalOpenInput,
  JournalOpenResult,
  JournalSearchInput,
  JournalSearchResult,
  WorkUnitInput,
} from './engine.ts';
import type { AgentTranscriptResourcesReadParams } from '../../shared/transcript.ts';

export interface AgentConversationJournal {
  createConversation(params: CreateConversationParams): Promise<CreateConversationResult>;
  reconcileTurn(params: AcceptTurnParams): Promise<AcceptTurnResult | null>;
  acceptTurn(params: AcceptTurnParams): Promise<AcceptTurnResult>;
  reconcileQueuedTurn(params: AcceptTurnParams): Promise<QueueTurnResult | null>;
  enqueueTurn(params: AcceptTurnParams): Promise<QueueTurnResult>;
  readQueuedTurn(conversationId: string, operationId?: string): Promise<DurableQueuedTurn | null>;
  readOldestQueuedConversationId?(): Promise<string | null>;
  finishQueuedTurn(operationId: string, turnId: string): Promise<boolean>;
  removeQueuedTurn(conversationId: string, operationId: string): Promise<boolean>;
  appendAssistantCheckpoint(
    handle: DurableTurnHandle,
    checkpoint: { textDelta: string; reasoningDelta: string },
  ): Promise<DurableTranscriptMutation | null>;
  recordToolStarted(
    handle: DurableTurnHandle,
    input: { callId: string; name: string; args: unknown },
  ): Promise<DurableTranscriptMutation | null>;
  recordToolFinished(
    handle: DurableTurnHandle,
    input: { callId: string; result: unknown; isError: boolean },
  ): Promise<DurableTranscriptMutation | null>;
  startInference(
    handle: DurableTurnHandle,
    input: {
      modelId: string;
      requestMode: 'full' | 'continuation';
      estimatedInputTokens: number;
      payload: unknown;
      context: DurableInferenceContext;
    },
  ): Promise<{ inferenceId: string; ordinal: number; sequence: number }>;
  recordInferenceTransport?(
    handle: DurableTurnHandle,
    input: {
      plannedRequestMode: 'full' | 'continuation';
      actualRequestMode: 'full' | 'continuation';
    },
  ): Promise<boolean>;
  finishInference(
    handle: DurableTurnHandle,
    input: { state: 'completed' | 'failed' | 'interrupted' },
  ): Promise<boolean>;
  finishTurn(
    handle: DurableTurnHandle,
    input: {
      status: 'completed' | 'failed' | 'interrupted';
      error?: string | null;
      errorCode?: DurableTurnErrorCode | null;
      durationMs?: number;
    },
  ): Promise<DurableTranscriptMutation | null>;
  compileContext(conversationId: string): Promise<DurableContextBoundarySnapshot>;
  readTranscriptActions(conversationId: string): Promise<DurableTranscriptAction[]>;
  readTranscriptBasis(conversationId: string): Promise<number | null>;
  readTranscriptProjection(conversationId: string): Promise<DurableTranscriptProjection | null>;
  readTranscriptWindowProjection(
    params: AgentTranscriptResourcesReadParams,
  ): Promise<DurableTranscriptWindowProjection | null>;
  readResourceProjections(
    keys: readonly AgentResourceKey[],
  ): Promise<Array<DurableResourceProjection | null>>;
  readArtifact(
    hash: string,
    range?: { offset: number; byteLength: number },
  ): Promise<DurableArtifact | null>;
  readContextMode?(conversationId: string): Promise<'full-history' | 'stateful'>;
  readWorkUnitMode?(conversationId: string): Promise<boolean>;
  searchJournal?(conversationId: string, input: JournalSearchInput): Promise<JournalSearchResult>;
  openJournal?(conversationId: string, input: JournalOpenInput): Promise<JournalOpenResult>;
  updateContext?(handle: DurableTurnHandle, input: ContextUpdateInput): Promise<ContextWorkspaceView>;
  workUnit?(handle: DurableTurnHandle, input: WorkUnitInput): Promise<DurableWorkUnitTransition>;
  completeWorkUnitImplicit?(
    handle: DurableTurnHandle,
    input: { text: string; reasoning: string; state?: 'completed' | 'failed' | 'interrupted' },
  ): Promise<DurableWorkUnitTransition & { parentIntegrationPrompt: string }>;
  resumeActiveWorkUnit?(conversationId: string): Promise<{
    handle: DurableTurnHandle;
    prompt: string;
  } | null>;
}
