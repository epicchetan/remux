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
  InstallContextCompactionInput,
} from './domain/state.ts';
import type {
  HistoryOpenInput,
  HistoryOpenResult,
  HistorySearchInput,
  HistorySearchResult,
  WorkUnitEnterInput,
  WorkUnitCompletion,
  WorkUnitReturnInput,
  WorkUnitView,
} from './domain/work.ts';

export type {
  HistoryOpenInput,
  HistoryOpenResult,
  HistorySearchHit,
  HistorySearchInput,
  HistorySearchOptions,
  HistorySearchResult,
  WorkUnitEnterInput,
  WorkUnitCompletion,
  WorkUnitArtifactView,
  WorkUnitReturnInput,
  WorkUnitReturnStatus,
  WorkUnitView,
} from './domain/work.ts';

export type AssistantTextPhase = 'commentary' | 'final_answer';

export type ModelSessionEvent =
  | { type: 'assistant-start' }
  | { type: 'assistant-text'; delta: string; phase: AssistantTextPhase }
  | { type: 'assistant-reasoning'; delta: string }
  | { type: 'inference-end'; state: 'completed' | 'failed' | 'interrupted' }
  | { type: 'assistant-complete'; interrupted: boolean; error?: string }
  | { type: 'tool-start'; callId: string; name: string; args: unknown }
  | { type: 'tool-update'; callId: string; name: string; result: unknown }
  | { type: 'tool-end'; callId: string; name: string; result: unknown; isError: boolean }
  | { type: 'context-probe'; probe: ContextProbe };

export type ModelSessionEventSink = (event: ModelSessionEvent) => void;

export type ModelSessionDurabilityHooks = {
  compileContext(): Promise<DurableContextBoundarySnapshot>;
  recordContextCompactionWarning(input: {
    epoch: number;
    estimatedInputTokens: number;
    targetTokens: number;
  }): Promise<void>;
  installContextCompaction(input: InstallContextCompactionInput): Promise<void>;
  beforeAssistantMessageEnd(input: {
    inferenceState: 'completed' | 'failed' | 'interrupted';
    text: string;
    textPhase: AssistantTextPhase;
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
  workUnitEnter(callId: string, input: WorkUnitEnterInput): Promise<WorkUnitView>;
  workUnitFinish(callId: string, input: WorkUnitReturnInput): Promise<WorkUnitCompletion>;
  workUnitAbort(input: { reason: string }): Promise<WorkUnitCompletion>;
};

export interface ModelSession {
  prompt(input: { text: string; images?: Array<{ data: string; mimeType: string }> }): Promise<void>;
  interrupt(): Promise<void>;
  dispose(): Promise<void>;
}

export interface ModelProvider {
  authStatus(): Promise<AuthValue>;
  login(operationId: string, signal: AbortSignal, onUpdate: (value: AuthValue) => void): Promise<void>;
  logout(): Promise<void>;
  listModels(): Promise<ModelInfo[]>;
  createSession(options: {
    cwd: string;
    modelId: string;
    reasoning: ReasoningLevel;
    onEvent: ModelSessionEventSink;
    durability: ModelSessionDurabilityHooks;
  }): Promise<ModelSession>;
}
