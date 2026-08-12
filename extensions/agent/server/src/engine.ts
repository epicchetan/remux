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
} from './storage/repository.ts';

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
  journalSearch(callId: string, input: JournalSearchInput): Promise<JournalSearchResult>;
  journalOpen(input: JournalOpenInput): Promise<JournalOpenResult>;
  threadRead(): Promise<ThreadDocumentView>;
  threadPatch(input: ThreadPatchInput): Promise<ThreadDocumentView>;
  threadReplace(input: ThreadReplaceInput): Promise<ThreadDocumentView>;
  workUnitEnter(callId: string, input: WorkUnitEnterInput): Promise<WorkUnitView>;
  workUnitReturn(callId: string, input: WorkUnitReturnInput): Promise<WorkUnitReturnPending>;
};

export type ThreadDocumentView = {
  documentId: string;
  versionId: string;
  content: string;
  ref: string;
};

export type ThreadPatchEdit = {
  oldText: string;
  newText: string;
};

export type ThreadPatchInput = {
  baseVersionId: string;
  edits: ThreadPatchEdit[];
};

export type ThreadReplaceInput = {
  baseVersionId: string;
  content: string;
};

export type WorkUnitEnterInput = {
  objective: string;
  doneWhen?: string[];
  resources?: WorkUnitResourceRef[];
};

export type WorkUnitReturnInput = {
  status: WorkUnitReturnStatus;
  result: string;
  threadUpdate?: string;
  resources?: WorkUnitResourceRef[];
};

export type WorkUnitReturnStatus = 'completed' | 'partial' | 'blocked';

export type WorkUnitResourceRole = 'authority' | 'deliverable' | 'evidence';

export type WorkUnitResourceRef = {
  ref: string;
  role: WorkUnitResourceRole;
  description?: string;
};

export type WorkUnitResourceView = WorkUnitResourceRef & {
  snapshot: {
    ref: string;
    hash: string;
    byteLength: number;
    mediaType: string;
    source: 'file' | 'history';
  };
  inclusion: 'materialized' | 'inherited';
};

export type WorkUnitView = {
  scopeId: string;
  parentScopeId: string;
  objective: string;
  doneWhen: string[];
  resources: WorkUnitResourceView[];
  state: 'running';
};

export type WorkUnitReturnPending = {
  scopeId: string;
  state: 'returning';
};

export type JournalSearchInput = {
  query: string;
  limit?: number;
  scope?: 'conversation' | 'project';
  include?: 'operations';
};

export type JournalSearchOptions = {
  excludeRef?: string;
};

export type JournalSearchHit = {
  ref: string;
  kind: string;
  excerpt: string;
  conversationId?: string;
  turnId?: string;
  sequence?: number;
  revision?: number;
  historical?: boolean;
};

export type JournalSearchResult = {
  query: string;
  scope: 'conversation' | 'project';
  hits: JournalSearchHit[];
  truncated: boolean;
  retention: 'ephemeral';
};

export type JournalOpenInput = { ref: string; offset?: number; maxBytes?: number };
export type JournalOpenResult = {
  ref: string;
  content: string;
  contentHash: string;
  offset: number;
  byteLength: number;
  totalByteLength: number;
  nextOffset: number | null;
  retention: 'ephemeral';
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
