import type {
  AuthValue,
  ContextProbe,
  ModelInfo,
  ReasoningLevel,
} from '../../shared/protocol.ts';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type {
  DurableContextBoundarySnapshot,
  DurableInferenceContext,
} from './domain/state.ts';
import type {
  HistoryOpenInput,
  HistoryOpenResult,
  HistorySearchInput,
  HistorySearchResult,
  ThreadDocumentView,
  ThreadPatchInput,
  ThreadReplaceInput,
  WorkUnitEnterInput,
  WorkUnitReturnInput,
  WorkUnitReturnPending,
  WorkUnitView,
} from './domain/work.ts';

export type {
  HistoryOpenInput,
  HistoryOpenResult,
  HistorySearchHit,
  HistorySearchInput,
  HistorySearchOptions,
  HistorySearchResult,
  ThreadDocumentView,
  ThreadPatchEdit,
  ThreadPatchInput,
  ThreadReplaceInput,
  WorkUnitEnterInput,
  WorkUnitResourceRef,
  WorkUnitResourceRole,
  WorkUnitResourceView,
  WorkUnitReturnInput,
  WorkUnitReturnPending,
  WorkUnitReturnStatus,
  WorkUnitView,
} from './domain/work.ts';

export type RuntimeEvent =
  | { type: 'assistant-start' }
  | { type: 'assistant-text'; delta: string }
  | { type: 'assistant-reasoning'; delta: string }
  | { type: 'inference-end'; state: 'completed' | 'failed' | 'interrupted' }
  | { type: 'assistant-complete'; interrupted: boolean; error?: string }
  | { type: 'tool-start'; callId: string; name: string; args: unknown }
  | { type: 'tool-update'; callId: string; name: string; result: unknown }
  | { type: 'tool-end'; callId: string; name: string; result: unknown; isError: boolean }
  | { type: 'context-probe'; probe: ContextProbe };

export type RuntimeEventSink = (event: RuntimeEvent) => void;

export type RuntimeDurabilityHooks = {
  compileContext(contextWindow: number): Promise<DurableContextBoundarySnapshot>;
  noticeContextPressure(input: {
    estimatedInputTokens: number;
    softContextLimit: number;
    hardContextLimit: number;
  }): Promise<boolean>;
  beforeAssistantMessageEnd(input: {
    inferenceState: 'completed' | 'failed' | 'interrupted';
    text: string;
    reasoning: string;
    calls: Array<{ callId: string; name: string; args: unknown }>;
    providerMessage: AssistantMessage;
  }): Promise<void>;
  beforeProviderCall(input: {
    payload: unknown;
    requestMode: 'full' | 'continuation';
    estimatedInputTokens: number;
    retryOfInferenceId?: string;
    context: DurableInferenceContext;
  }): Promise<void>;
  supersedeProviderAttempt(input: {
    attempt: number;
    maxAttempts: number;
    delayMs: number;
    error: string;
  }): Promise<{ inferenceId: string }>;
  afterProviderCall?(input: {
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
  }): Promise<void>;
  beforeTool(input: { callId: string; name: string; args: unknown }): Promise<void>;
  afterTool(input: {
    callId: string;
    name: string;
    result: unknown;
    isError: boolean;
  }): Promise<void>;
  historySearch(callId: string, input: HistorySearchInput): Promise<HistorySearchResult>;
  historyOpen(input: HistoryOpenInput): Promise<HistoryOpenResult>;
  threadRead(): Promise<ThreadDocumentView>;
  threadPatch(input: ThreadPatchInput): Promise<ThreadDocumentView>;
  threadReplace(input: ThreadReplaceInput): Promise<ThreadDocumentView>;
  workUnitEnter(callId: string, input: WorkUnitEnterInput): Promise<WorkUnitView>;
  workUnitReturn(callId: string, input: WorkUnitReturnInput): Promise<WorkUnitReturnPending>;
};

export interface ConversationRuntime {
  prompt(input: { text: string; images?: Array<{ data: string; mimeType: string }> }): Promise<void>;
  interrupt(): Promise<void>;
  dispose(): Promise<void>;
}

export interface AgentEngine {
  authStatus(): Promise<AuthValue>;
  login(operationId: string, signal: AbortSignal, onUpdate: (value: AuthValue) => void): Promise<void>;
  logout(): Promise<void>;
  listModels(): Promise<ModelInfo[]>;
  createConversation(options: {
    cwd: string;
    modelId: string;
    reasoning: ReasoningLevel;
    onEvent: RuntimeEventSink;
    durability: RuntimeDurabilityHooks;
  }): Promise<ConversationRuntime>;
}
