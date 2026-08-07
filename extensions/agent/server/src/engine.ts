import type {
  AuthValue,
  ContextProbe,
  ModelInfo,
  ReasoningLevel,
} from '../../shared/protocol.ts';

export type RuntimeEvent =
  | { type: 'assistant-start' }
  | { type: 'assistant-text'; delta: string }
  | { type: 'assistant-reasoning'; delta: string }
  | { type: 'assistant-complete'; interrupted: boolean; error?: string }
  | { type: 'tool-start'; callId: string; name: string; args: unknown }
  | { type: 'tool-update'; callId: string; name: string; result: unknown }
  | { type: 'tool-end'; callId: string; name: string; result: unknown; isError: boolean }
  | { type: 'context-probe'; probe: ContextProbe };

export type RuntimeEventSink = (event: RuntimeEvent) => void;

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
  }): Promise<ConversationRuntime>;
}
