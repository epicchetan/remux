import type { AgentResourceInvalidation } from './transcript.ts';

export const AGENT_METHODS = {
  resourcesRead: 'remux/agent/resources/read',
  transcriptResourcesRead: 'remux/agent/transcript/resources/read',
  authLoginStart: 'remux/agent/auth/login/start',
  authLoginCancel: 'remux/agent/auth/login/cancel',
  authLogout: 'remux/agent/auth/logout',
  modelsRead: 'remux/agent/models/read',
  conversationStart: 'remux/agent/conversation/start',
  messageSend: 'remux/agent/conversation/message/send',
  turnInterrupt: 'remux/agent/conversation/turn/interrupt',
  resourcesInvalidated: 'remux/agent/resources/invalidated',
} as const;

export const AGENT_RESOURCE_KEYS = {
  auth: 'auth',
  models: 'models',
} as const;

export type AgentResourceKey =
  | typeof AGENT_RESOURCE_KEYS[keyof typeof AGENT_RESOURCE_KEYS]
  | `conversation:${string}`;

export function conversationResourceKey(conversationId: string): AgentResourceKey {
  return `conversation:${conversationId}`;
}

export type ReasoningLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type AuthValue = {
  state: 'signed-out' | 'signing-in' | 'signed-in' | 'error';
  operationId: string | null;
  displayLabel: string | null;
  verificationUri: string | null;
  userCode: string | null;
  expiresAt: string | null;
  progress: string | null;
  error: string | null;
};

export type ModelInfo = {
  id: string;
  name: string;
  provider: 'openai-codex';
  contextWindow: number;
  supportedReasoning: ReasoningLevel[];
};

export type ModelsValue = {
  models: ModelInfo[];
  defaultModelId: string | null;
  error: string | null;
};

export type ContextProbe = {
  hookVersion: 'phase0-v1';
  modelCallCount: number;
  messageCount: number;
  messageHash: string | null;
  orderedMessageHashes: string[];
  estimatedBytes: number;
  provider: 'openai-codex';
  modelId: string;
  providerRequestMode: 'none' | 'full' | 'continuation';
};

export type ConversationValue = {
  id: string;
  cwd: string;
  modelId: string;
  reasoning: ReasoningLevel;
  status: 'idle' | 'running' | 'interrupting' | 'error';
  activeTurnId: string | null;
  activeTurnElapsedMs: number | null;
  contextProbe: ContextProbe;
  error: string | null;
};

export type AgentResourceValue = AuthValue | ModelsValue | ConversationValue;

export type ResourceReadRequest = {
  key: AgentResourceKey;
  ifNoneMatch?: number;
};

export type ResourceReadParams = {
  requests: ResourceReadRequest[];
};

export type ResourceReadItem =
  | {
      key: AgentResourceKey;
      status: 'ok';
      revision: number;
      serverGeneration: string;
      value: AgentResourceValue;
    }
  | {
      key: AgentResourceKey;
      status: 'notModified';
      revision: number;
      serverGeneration: string;
    }
  | {
      key: AgentResourceKey;
      status: 'missing';
      serverGeneration: string;
    };

export type ResourceReadResult = {
  resources: ResourceReadItem[];
};

export type ResourcesInvalidatedParams = {
  invalidations: AgentResourceInvalidation[];
  serverGeneration: string;
};

export type LoginStartResult = {
  accepted: true;
  operationId: string;
};

export type ConversationStartParams = {
  cwd: string;
  modelId: string;
  reasoning: ReasoningLevel;
};

export type ConversationStartResult = {
  conversationId: string;
};

export type MessageSendParams = {
  conversationId: string;
  clientMessageId: string;
  text: string;
};

export type MessageSendResult = {
  accepted: true;
  turnId: string;
};

export type TurnInterruptParams = {
  conversationId: string;
  turnId: string;
};

export type LoginCancelParams = {
  operationId: string;
};

export type WorkspaceReadParams = {
  path: string;
  startLine?: number;
  lineCount?: number;
};

export type WorkspaceReadResult = {
  path: string;
  contentHash: string;
  startLine: number;
  endLine: number;
  text: string;
  truncated: boolean;
};
