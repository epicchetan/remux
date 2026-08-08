import type { AgentResourceInvalidation } from './transcript.ts';

export const AGENT_METHODS = {
  resourcesRead: 'remux/agent/resources/read',
  transcriptResourcesRead: 'remux/agent/transcript/resources/read',
  authLoginStart: 'remux/agent/auth/login/start',
  authLoginCancel: 'remux/agent/auth/login/cancel',
  authLogout: 'remux/agent/auth/logout',
  modelsRead: 'remux/agent/models/read',
  artifactRead: 'remux/agent/artifact/read',
  conversationCreate: 'remux/agent/conversation/create',
  messageSend: 'remux/agent/conversation/message/send',
  turnInterrupt: 'remux/agent/conversation/turn/interrupt',
  resourcesInvalidated: 'remux/agent/resources/invalidated',
} as const;

export const AGENT_RESOURCE_KEYS = {
  auth: 'auth',
  models: 'models',
  conversationList: 'conversation-list',
  runtime: 'runtime',
} as const;

export type AgentResourceKey =
  | typeof AGENT_RESOURCE_KEYS[keyof typeof AGENT_RESOURCE_KEYS]
  | `conversation:${string}`;

export function conversationResourceKey(conversationId: string): `conversation:${string}` {
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
  hookVersion: 'agent-durable-v1';
  modelCallCount: number;
  messageCount: number;
  messageHash: string | null;
  orderedMessageHashes: string[];
  estimatedBytes: number;
  provider: 'openai-codex';
  modelId: string;
  providerRequestMode: 'none' | 'full' | 'continuation';
};

export type ConversationSummary = {
  id: string;
  title: string;
  preview: string;
  cwd: string;
  modelId: string;
  reasoning: ReasoningLevel;
  status: 'idle' | 'running' | 'error';
  latestTurnId: string | null;
  createdAt: number;
  updatedAt: number;
};

export type ConversationListValue = {
  conversations: ConversationSummary[];
  truncated: boolean;
};

export type AgentRuntimeValue = {
  conversationId: string | null;
  state: 'unloaded' | 'loading' | 'idle' | 'running' | 'interrupting' | 'error';
  activeTurnId: string | null;
  activeTurnElapsedMs: number | null;
  contextProbe: ContextProbe | null;
  error: string | null;
};

/** Viewer-level projection combining one durable conversation with the singleton runtime. */
export type ConversationValue = Omit<ConversationSummary, 'status'> & {
  status: ConversationSummary['status'] | 'loading' | 'interrupting';
  activeTurnId: string | null;
  activeTurnElapsedMs: number | null;
  contextProbe: ContextProbe;
  error: string | null;
};

export type AgentResourceValue =
  | AuthValue
  | ModelsValue
  | AgentRuntimeValue
  | ConversationSummary
  | ConversationListValue;

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
      basisSequence: number;
      serverGeneration: string;
      value: AgentResourceValue;
    }
  | {
      key: AgentResourceKey;
      status: 'notModified';
      revision: number;
      basisSequence: number;
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

export type ArtifactReadRange =
  | { kind: 'bytes'; offset: number; byteLength: number }
  | { kind: 'utf8'; offset: number; byteLength: number }
  | { kind: 'lines'; startLine: number; lineCount: number };

export type ArtifactReadParams = {
  hash: string;
  range: ArtifactReadRange;
};

export type ArtifactReadResult = {
  hash: string;
  mediaType: string;
  totalByteLength: number;
  totalLineCount: number | null;
  range:
    | { kind: 'bytes'; offset: number; byteLength: number }
    | { kind: 'utf8'; offset: number; byteLength: number }
    | { kind: 'lines'; startLine: number; endLine: number };
  encoding: 'base64' | 'utf8';
  content: string;
  truncated: boolean;
  nextRange: ArtifactReadRange | null;
};

export type ConversationCreateParams = {
  operationId: string;
  cwd: string;
  modelId: string;
  reasoning: ReasoningLevel;
};

export type ConversationCreateResult = {
  conversationId: string;
};

export type MessageSendParams = {
  operationId: string;
  conversationId: string;
  clientMessageId: string;
  text: string;
};

export type MessageSendResult = {
  accepted: true;
  operationId: string;
  turnId: string;
};

export type AgentCommandErrorData =
  | {
      kind: 'operation_conflict';
      operationId: string;
    }
  | {
      kind: 'client_message_conflict';
      clientMessageId: string;
    }
  | {
      kind: 'active_runtime_busy';
      conversationId: string;
      turnId: string;
    }
  | {
      kind: 'turn_active';
      conversationId: string;
      turnId: string;
    }
  | {
      kind: 'workspace_unavailable';
      conversationId: string;
      cwd: string;
    }
  | {
      kind: 'model_unavailable';
      conversationId: string;
      modelId: string;
    }
  | {
      kind: 'runtime_hydration_failed';
      conversationId: string;
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
