import type {
  AuthValue,
  ContextProbe,
  ModelInfo,
  ReasoningLevel,
  AgentContextMode,
} from '../../shared/protocol.ts';
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
  compileContext(): Promise<DurableContextBoundarySnapshot>;
  beforeAssistantMessageEnd(input: {
    inferenceState: 'completed' | 'failed' | 'interrupted';
    text: string;
    reasoning: string;
    calls: Array<{ callId: string; name: string; args: unknown }>;
  }): Promise<void | { parentIntegrationPrompt: string }>;
  beforeProviderCall(input: {
    payload: unknown;
    requestMode: 'full' | 'continuation';
    estimatedInputTokens: number;
    context: DurableInferenceContext;
  }): Promise<void>;
  afterProviderCall?(input: {
    plannedRequestMode: 'full' | 'continuation';
    actualRequestMode: 'full' | 'continuation';
  }): Promise<void>;
  beforeTool(input: { callId: string; name: string; args: unknown }): Promise<void>;
  afterTool(input: {
    callId: string;
    name: string;
    result: unknown;
    isError: boolean;
  }): Promise<void>;
  journalSearch(input: JournalSearchInput): Promise<JournalSearchResult>;
  journalOpen(input: JournalOpenInput): Promise<JournalOpenResult>;
  updateContext(input: ContextUpdateInput): Promise<ContextWorkspaceView>;
  workUnit(input: WorkUnitInput): Promise<WorkUnitResult>;
};

export type JournalSearchInput = {
  query: string;
  limit?: number;
  scope?: 'conversation' | 'project';
  include?: 'operations';
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

export type ContextScope = 'thread' | 'project';
export type ContextUpdateInput = {
  set?: Array<{
    key: string;
    scope?: ContextScope;
    value: unknown;
    evidence?: string[];
  }>;
  remove?: Array<{ key: string; scope?: ContextScope }>;
  pin?: Array<{ ref: string; label?: string; scope?: ContextScope }>;
  unpin?: Array<{ ref: string; scope?: ContextScope }>;
};
export type WorkUnitInput =
  | { action: 'enter'; objective: string; refs?: string[]; expectedEvidence?: string[] }
  | {
      action: 'return';
      status: 'completed' | 'failed' | 'abandoned';
      findings: Array<{ text: string; evidence: string[] }>;
      changeRefs?: string[];
      validationRefs?: string[];
      unresolved?: string[];
      proposedPromotions?: Array<{ key: string; value: unknown }>;
    };
export type WorkUnitResult = {
  action: 'entered' | 'returned';
  scopeId: string;
  parentScopeId: string;
  epochId?: string;
  capsuleRef?: string;
  resultRef?: string;
  traceRef: string;
  status: 'running' | 'completed' | 'failed' | 'abandoned';
};
export type ContextWorkspaceView = {
  revision: number;
  state: Array<{ key: string; scope: ContextScope; version: number }>;
  pinned: Array<{
    ref: string;
    label: string;
    scope: ContextScope;
    state: 'pinned' | 'unpinned';
    version: number;
  }>;
  estimatedBytes: number;
  warnings: string[];
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
    contextMode?: AgentContextMode;
    workUnits?: boolean;
    onEvent: RuntimeEventSink;
    durability: RuntimeDurabilityHooks;
  }): Promise<ConversationRuntime>;
}
