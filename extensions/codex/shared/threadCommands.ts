import type {
  CodexComposerIntelligence,
  CodexComposerReviewMode,
  CodexComposerSpeed,
} from './composerConfig';

export type CodexThreadMessageSendParams = {
  clientMessageId?: string | null;
  parts: CodexComposerMessagePart[];
  threadId: string;
};

export type CodexThreadMessageStartConfig = {
  intelligence: CodexComposerIntelligence;
  model: string | null;
  reviewMode: CodexComposerReviewMode;
  speed: CodexComposerSpeed;
};

export type CodexThreadMessageStartParams = {
  clientMessageId?: string | null;
  composerConfig?: CodexThreadMessageStartConfig | null;
  cwd: string;
  parts: CodexComposerMessagePart[];
};

export type CodexThreadMessageEditParams = {
  clientMessageId?: string | null;
  parts: CodexComposerMessagePart[];
  threadId: string;
  turnId: string;
  userMessageId: string;
};

export type CodexThreadMessageForkParams = {
  assistantMessageId: string;
  clientMessageId?: string | null;
  parts: CodexComposerMessagePart[];
  threadId: string;
  turnId: string;
};

export type CodexThreadCompactParams = {
  threadId: string;
};

export type CodexComposerMessagePart =
  | {
      text: string;
      type: 'text';
    }
  | {
      dataUrl: string;
      mimeType?: string | null;
      name?: string | null;
      type: 'image';
    }
  | {
      name?: string | null;
      path: string;
      type: 'mention';
    };

export type CodexThreadMessageSendResponse = {
  delivery: 'queued' | 'sent';
  invalidations: CodexResourceInvalidation[];
  status: 'accepted';
  threadId: string;
  turnId?: string;
};

export type CodexThreadMessageStartResponse = Omit<CodexThreadMessageSendResponse, 'delivery' | 'turnId'> & {
  turnId: string;
};

export type CodexThreadMessageEditResponse = CodexThreadMessageStartResponse;

export type CodexThreadMessageForkResponse = CodexThreadMessageStartResponse;

export type CodexThreadCompactResponse = {
  delivery: 'queued' | 'sent';
  invalidations: CodexResourceInvalidation[];
  status: 'accepted';
  threadId: string;
};

export type CodexThreadTurnInterruptParams = {
  threadId: string;
  turnId?: string | null;
};

export type CodexThreadTurnInterruptResponse = {
  invalidations: CodexResourceInvalidation[];
  status: 'accepted';
  threadId: string;
  turnId: string;
};

export type CodexResourceInvalidation =
  | {
      key: string;
      reason: CodexResourceInvalidationReason;
      type: 'threadHistory';
    }
  | {
      key: string;
      reason: CodexResourceInvalidationReason;
      threadId: string;
      type:
        | 'threadComposerState'
        | 'threadOperationQueue'
        | 'threadRuntime'
        | 'threadSummary'
        | 'threadTokenUsage'
        | 'threadTranscript';
    }
  | {
      key: string;
      reason: CodexResourceInvalidationReason;
      threadId: string;
      turnId: string;
      type: 'turn';
    }
  | {
      itemId: string;
      key: string;
      reason: CodexResourceInvalidationReason;
      threadId: string;
      turnId: string;
      type: 'workItem';
    }
  | {
      affectsLayout: boolean;
      affectsOrder: boolean;
      key: string;
      reason: CodexResourceInvalidationReason;
      threadId: string;
      turnId?: string;
      type: 'transcript';
    }
  | {
      affectsLayout: boolean;
      groupId: string;
      key: string;
      reason: CodexResourceInvalidationReason;
      segmentId: string;
      threadId: string;
      turnId: string;
      type: 'workGroup';
    }
  | {
      affectsLayout: boolean;
      groupId: string;
      key: string;
      reason: CodexResourceInvalidationReason;
      rowId: string;
      segmentId: string;
      threadId: string;
      turnId: string;
      type: 'workEntryDetail';
    };

export type CodexResourceInvalidationReason = 'appServerEvent' | 'commandAccepted' | 'sendAccepted';

export type CodexResourcesInvalidatedNotification = {
  invalidations: CodexResourceInvalidation[];
};
