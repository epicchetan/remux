/**
 * Viewer presentation types retained while the Remux UI consumes the
 * provider-neutral native-agent protocol. Wire contracts live in
 * `native-agent-protocol.ts`; this file deliberately contains no server RPC.
 */

import type { ViewerProviderCapabilities } from './native-agent-protocol.ts';
import type { ProviderAccess, ProviderKind } from './provider-runtime.ts';

export type ReasoningLevel = string;
export type ReasoningEffort = ReasoningLevel | null;

export type AgentFileSearchResult = {
  absolutePath: string;
  id: string;
  kind: 'directory' | 'file';
  name: string;
  parentPath: string;
  path: string;
  score: number;
};

export type AgentFileSearchParams = {
  cwd: string;
  limit?: number;
  query: string;
};

export type AgentFileSearchResponse = {
  results: AgentFileSearchResult[];
};

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
  nativeId?: string;
  name: string;
  provider: 'openai-codex' | 'codex' | 'claude-code' | 'fixture';
  providerInstanceId?: string;
  contextWindow: number;
  supportedReasoning: ReasoningLevel[];
  serviceTiers: Array<{ id: string; name: string; description?: string }>;
  defaultServiceTier: string | null;
};

export type ModelsValue = {
  models: ModelInfo[];
  defaultModelId: string | null;
  error: string | null;
};

export type ConversationSummary = {
  id: string;
  title: string;
  preview: string;
  cwd: string;
  modelId: string;
  reasoning: ReasoningEffort;
  serviceTier: string | null;
  provider: ProviderKind;
  providerInstanceId?: string;
  access?: ProviderAccess;
  resumable: boolean;
  status: 'idle' | 'running' | 'error';
  latestTurnId: string | null;
  parentConversationId: string | null;
  rootConversationId: string;
  activeStrandId: string;
  headRevision: number;
  versionCount: number;
  childCount: number;
  subtreeUpdatedAt: number;
  archivedAt: number | null;
  metadataRevision: number;
  lastUsedModelId: string | null;
  /** Latest user-send time used to order conversation history. */
  lastActivityAt: number;
  createdAt: number;
  updatedAt: number;
};

export type ConversationListValue = {
  conversations: ConversationSummary[];
  truncated: boolean;
};

export type AgentRuntimeValue = {
  conversationId: string | null;
  providerInstanceId: string;
  modelId: string;
  effort: ReasoningEffort;
  serviceTier: string | null;
  capabilities: ViewerProviderCapabilities;
  state: 'unloaded' | 'loading' | 'idle' | 'running' | 'interrupting' | 'error';
  activeTurnId: string | null;
  activeTurnElapsedMs: number | null;
  error: string | null;
};

export type AgentPendingQueueEntry = {
  attachmentCount: number;
  createdAt: number;
  id: string;
  mentionCount: number;
  kind: 'message' | 'compact';
  state?: 'queued' | 'dispatching' | 'blocked' | 'delivery-unknown';
  text: string;
};

export type AgentPendingQueueValue = {
  conversationId: string;
  entries: AgentPendingQueueEntry[];
};

/** Viewer-level projection combining one conversation with the singleton runtime. */
export type ConversationValue = Omit<ConversationSummary, 'status'> & {
  status: ConversationSummary['status'] | 'loading' | 'interrupting';
  activeTurnId: string | null;
  activeTurnElapsedMs: number | null;
  error: string | null;
  capabilities: ViewerProviderCapabilities | null;
};

export type AgentComposerMessagePart =
  | { text: string; type: 'text' }
  | {
      dataUrl: string;
      mimeType?: string | null;
      name?: string | null;
      type: 'image';
    }
  | {
      kind?: 'directory' | 'file';
      name?: string | null;
      path: string;
      type: 'mention';
    };

export type AgentTranscriptFence = {
  basisSequence: number;
  serverGeneration: string;
  turnId: string;
};

export type MessageSendResult = {
  accepted: true;
  operationId: string;
  turnId: string;
  delivery: 'sent' | 'queued' | 'steered';
  transcriptFence?: AgentTranscriptFence;
};

export type MessageBranchResult = {
  conversationId: string;
  strandId: string;
  headRevision: number;
  transcriptFence: AgentTranscriptFence;
  turnId: string;
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
