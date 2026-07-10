import type {
  CodexComposerConfig,
  CodexComposerIntelligence,
  CodexComposerReviewMode,
  CodexComposerSpeed,
} from './composerConfig';
import type { ThreadTokenUsage } from './protocol/v2/ThreadTokenUsage';
import type { CodexPendingQueueResource } from './operationQueue';

export type { CodexPendingQueueResource } from './operationQueue';

export type CodexThreadResourcesReadParams = {
  requests: CodexThreadResourceRequest[];
};

export type CodexThreadResourceRequest =
  | {
      knownRevision?: string;
      threadId: string;
      type: 'threadComposerState';
    }
  | {
      archived?: boolean | null;
      cursor?: string | null;
      knownRevision?: string;
      limit?: number | null;
      searchTerm?: string | null;
      sortDirection?: 'asc' | 'desc' | null;
      sortKey?: 'created_at' | 'updated_at' | 'recency_at' | null;
      type: 'threadHistory';
    }
  | {
      knownRevision?: string;
      threadId: string;
      type: 'threadOperationQueue';
    }
  | {
      knownRevision?: string;
      threadId: string;
      type: 'threadSummary';
    }
  | {
      knownRevision?: string;
      threadId: string;
      type: 'threadRuntime';
    }
  | {
      knownRevision?: string;
      threadId: string;
      type: 'threadTokenUsage';
    };

export type CodexThreadResourcesReadResponse = {
  resources: CodexThreadResourceResult[];
};

export type CodexThreadOperationQueueReadResult = CodexPendingQueueResource;

export type CodexThreadResourceResult = {
  key: string;
  reason?: string;
  requestIndex: number;
  revision?: string;
  status: 'ok' | 'notModified' | 'missing' | 'error';
  value?: unknown;
};

export type CodexThreadHistoryResource = {
  backwardsCursor: string | null;
  nextCursor: string | null;
  revision: string;
  threads: CodexThreadSummary[];
};

export type CodexThreadSummaryResource = {
  revision: string;
  thread: CodexThreadSummary;
};

export type CodexThreadRuntimeStatus = 'failed' | 'ready' | 'running' | 'stopping';

export type CodexThreadRuntimeError = {
  codexErrorInfo: string | null;
  message: string;
  turnId: string | null;
};

export type CodexThreadRuntimeResource = {
  activeTurnElapsedMs: number | null;
  activeTurnId: string | null;
  lastError: CodexThreadRuntimeError | null;
  revision: string;
  status: CodexThreadRuntimeStatus;
  threadId: string;
};

export type CodexThreadComposerStateResource = {
  effective: {
    cwd: string | null;
    model: string | null;
    modelContextWindow: number | null;
    modelProvider: string | null;
  };
  lastAppliedTurnId: string | null;
  observedConfig: CodexThreadObservedComposerConfig;
  preference: CodexComposerConfig;
  revision: string;
  rolloutRevision: string | null;
  threadId: string;
  tokenUsage: ThreadTokenUsage | null;
  tokenUsageSource: 'live' | 'rollout' | 'none';
  tokenUsageTurnId: string | null;
};

export type CodexThreadObservedComposerConfig = {
  intelligence: CodexComposerIntelligence | null;
  model: string | null;
  reviewMode: CodexComposerReviewMode | null;
  speed: CodexComposerSpeed | null;
};

export type CodexThreadTokenUsageResource = {
  revision: string;
  threadId: string;
  tokenUsage: ThreadTokenUsage | null;
  turnId: string | null;
};

export type CodexThreadSummary = {
  archived: boolean;
  createdAt: number;
  cwd: string | null;
  id: string;
  modelProvider: string | null;
  name: string | null;
  path: string | null;
  preview: string;
  sessionId: string | null;
  source: unknown;
  status: unknown;
  title: string;
  updatedAt: number;
};
