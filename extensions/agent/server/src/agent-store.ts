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
  DurableInferenceFinalization,
  DurableToolCallMutation,
  DurableQueuedTurn,
  PreparedWorkUnitReturn,
  PreparedWorkUnitEntry,
  QueueTurnResult,
} from './domain/state.ts';
import type { AgentResourceKey } from '../../shared/protocol.ts';
import type { ThreadCanvasValue } from '../../shared/protocol.ts';
import type { TurnReadValue } from '../../shared/protocol.ts';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { AssistantTextPhase } from './model-provider.ts';
import type {
  HistoryOpenInput,
  HistoryOpenResult,
  HistorySearchInput,
  HistorySearchOptions,
  HistorySearchResult,
  ThreadDocumentView,
  ThreadPatchInput,
  ThreadReplaceInput,
  WorkUnitContextResource,
  WorkUnitEnterInput,
  WorkUnitReturnInput,
  WorkUnitReturnStatus,
} from './domain/work.ts';
import type {
  AgentExecutionScopeRequest,
  AgentExecutionScopeResource,
  AgentOperationDetailRequest,
  AgentOperationDetailResource,
  AgentTranscriptResourcesReadParams,
} from '../../shared/transcript.ts';

export interface AgentStore {
  createConversation(params: CreateConversationParams): Promise<CreateConversationResult>;
  reconcileTurn(params: AcceptTurnParams): Promise<AcceptTurnResult | null>;
  acceptTurn(params: AcceptTurnParams): Promise<AcceptTurnResult>;
  reconcileQueuedTurn(params: AcceptTurnParams): Promise<QueueTurnResult | null>;
  enqueueTurn(params: AcceptTurnParams): Promise<QueueTurnResult>;
  readQueuedTurn(conversationId: string, operationId?: string): Promise<DurableQueuedTurn | null>;
  readOldestQueuedConversationId(): Promise<string | null>;
  finishQueuedTurn(operationId: string, turnId: string): Promise<boolean>;
  removeQueuedTurn(conversationId: string, operationId: string): Promise<boolean>;
  appendAssistantCheckpoint(
    handle: DurableTurnHandle,
    checkpoint: { textDelta: string; reasoningDelta: string; textPhase?: AssistantTextPhase },
  ): Promise<DurableTranscriptMutation | null>;
  recordToolStarted(
    handle: DurableTurnHandle,
    input: { callId: string; name: string; args: unknown; sourceInferenceId?: string },
  ): Promise<DurableToolCallMutation | null>;
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
      retryOfInferenceId?: string;
      context: DurableInferenceContext;
    },
  ): Promise<{ inferenceId: string; ordinal: number; sequence: number }>;
  supersedeInference(
    handle: DurableTurnHandle,
    input: {
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      error: string;
    },
  ): Promise<{ inferenceId: string; sequence: number }>;
  recordInferenceTransport(
    handle: DurableTurnHandle,
    input: {
      plannedRequestMode: 'full' | 'continuation';
      actualRequestMode: 'full' | 'continuation';
      carrier: 'websocket' | 'sse' | 'unknown';
      websocketRequests: number;
      connectionsCreated: number;
      connectionsReused: number;
      websocketFailures: number;
      sseFallbacks: number;
      dispatchToFirstEventMs: number | null;
      durationMs: number;
    },
  ): Promise<boolean>;
  recordProviderItem(handle: DurableTurnHandle, message: AssistantMessage): Promise<unknown>;
  finalizeInference(
    handle: DurableTurnHandle,
    input: {
      state: 'completed' | 'failed' | 'interrupted';
      providerMessage: AssistantMessage;
      calls: Array<{ callId: string; name: string; args: unknown }>;
    },
  ): Promise<DurableInferenceFinalization>;
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
  compileContext(
    conversationId: string,
    contextWindow?: number,
  ): Promise<DurableContextBoundarySnapshot>;
  recordContextPressure(
    handle: DurableTurnHandle,
    input: {
      estimatedInputTokens: number;
      softContextLimit: number;
      hardContextLimit: number;
    },
  ): Promise<boolean>;
  resumeActiveTurn(conversationId: string): Promise<{
    handle: DurableTurnHandle;
    rootHandle: DurableTurnHandle;
    prompt: string;
  } | null>;
  readTranscriptActions(conversationId: string): Promise<DurableTranscriptAction[]>;
  readTranscriptBasis(conversationId: string): Promise<number | null>;
  readTranscriptProjection(conversationId: string): Promise<DurableTranscriptProjection | null>;
  readTranscriptWindowProjection(
    params: AgentTranscriptResourcesReadParams,
  ): Promise<DurableTranscriptWindowProjection | null>;
  readExecutionScopeTranscriptResource(
    conversationId: string,
    request: AgentExecutionScopeRequest,
  ): Promise<AgentExecutionScopeResource | null>;
  readOperationDetailTranscriptResource(
    conversationId: string,
    request: AgentOperationDetailRequest,
  ): Promise<AgentOperationDetailResource | null>;
  readResourceProjections(
    keys: readonly AgentResourceKey[],
  ): Promise<Array<DurableResourceProjection | null>>;
  readArtifact(
    hash: string,
    range?: { offset: number; byteLength: number },
  ): Promise<DurableArtifact | null>;
  searchHistory(
    conversationId: string,
    input: HistorySearchInput,
    options?: HistorySearchOptions,
  ): Promise<HistorySearchResult>;
  openHistory(conversationId: string, input: HistoryOpenInput): Promise<HistoryOpenResult>;
  readThread(conversationId: string): Promise<ThreadDocumentView>;
  readThreadHistory(conversationId: string): Promise<ThreadCanvasValue>;
  readTurn(conversationId: string, turnId: string): Promise<TurnReadValue>;
  patchThread(handle: DurableTurnHandle, input: ThreadPatchInput): Promise<ThreadDocumentView>;
  replaceThread(handle: DurableTurnHandle, input: ThreadReplaceInput): Promise<ThreadDocumentView>;
  prepareWorkUnitEntry(
    handle: DurableTurnHandle,
    input: WorkUnitEnterInput,
  ): Promise<PreparedWorkUnitEntry>;
  commitWorkUnitEntry(
    handle: DurableTurnHandle,
    prepared: PreparedWorkUnitEntry,
    linkage: { parentCallId: string; parentOperationId: string; parentInferenceId: string },
  ): Promise<{
    handle: DurableTurnHandle;
    parentScopeId: string;
    objective: string;
    doneWhen: string[];
    resources: WorkUnitContextResource[];
    transcriptSequence: number;
    transcriptCreatedAt: number;
  }>;
  prepareWorkUnitReturn(
    handle: DurableTurnHandle,
    input: WorkUnitReturnInput,
  ): Promise<PreparedWorkUnitReturn>;
  commitWorkUnitFinish(
    handle: DurableTurnHandle,
    callId: string,
    prepared: PreparedWorkUnitReturn,
  ): Promise<{
    parentHandle: DurableTurnHandle;
    status: WorkUnitReturnStatus;
    result: string;
    resources: WorkUnitContextResource[];
    resultRef: string;
    historyRef: string;
    scopeId: string;
    toolMutation: DurableTranscriptMutation;
    transcriptSequence: number;
    transcriptCreatedAt: number;
  }>;
  commitWorkUnitReturn(
    handle: DurableTurnHandle,
    prepared: PreparedWorkUnitReturn,
  ): Promise<{
    parentHandle: DurableTurnHandle;
    status: WorkUnitReturnStatus;
    result: string;
    resources: WorkUnitContextResource[];
    resultRef: string;
    historyRef: string;
    scopeId: string;
    transcriptSequence: number;
    transcriptCreatedAt: number;
  }>;
  returnWorkUnit(handle: DurableTurnHandle, input: WorkUnitReturnInput): Promise<{
    parentHandle: DurableTurnHandle;
    status: WorkUnitReturnStatus;
    result: string;
    resources: WorkUnitContextResource[];
    resultRef: string;
    historyRef: string;
    scopeId: string;
    transcriptSequence: number;
    transcriptCreatedAt: number;
  }>;
}
