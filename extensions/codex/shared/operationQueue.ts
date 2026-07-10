import type { CodexResourceInvalidation } from './threadCommands';

export type CodexPendingMessagePreview = {
  attachmentCount: number;
  mentionCount: number;
  text: string;
};

export type CodexPendingQueueEntry =
  | {
      createdAt: number;
      id: string;
      kind: 'message';
      preview: CodexPendingMessagePreview;
    }
  | {
      createdAt: number;
      id: string;
      kind: 'compact';
    };

export type CodexPendingQueueResource = {
  entries: CodexPendingQueueEntry[];
  revision: string;
  threadId: string;
};

export type CodexQueueEntryMutationParams = {
  operationId: string;
  threadId: string;
};

export type CodexQueueMutationResponse = {
  invalidations: CodexResourceInvalidation[];
  queueRevision: string;
  status: 'accepted' | 'retained';
  threadId: string;
};
