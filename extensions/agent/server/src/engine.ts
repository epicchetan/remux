import type {
  AuthValue,
  ContextProbe,
  ModelInfo,
  ReasoningLevel,
} from '../../shared/protocol.ts';
import type { DurableContextSnapshot } from './logical-context.ts';

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
  compileContext(): Promise<DurableContextSnapshot>;
  beforeAssistantMessageEnd(input: {
    inferenceState: 'completed' | 'failed' | 'interrupted';
    text: string;
    reasoning: string;
    calls: Array<{ callId: string; name: string; args: unknown }>;
  }): Promise<void>;
  beforeProviderCall(input: {
    payload: unknown;
    requestMode: 'full' | 'continuation';
    estimatedInputTokens: number;
    context?: {
      basisSequence: number;
      logicalHash: string;
      renderedHash: string;
      messageCount: number;
    };
  }): Promise<void>;
  beforeTool(input: { callId: string; name: string; args: unknown }): Promise<void>;
  afterTool(input: {
    callId: string;
    name: string;
    result: unknown;
    isError: boolean;
  }): Promise<void>;
};

export interface ConversationRuntime {
  prompt(text: string): Promise<void>;
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
