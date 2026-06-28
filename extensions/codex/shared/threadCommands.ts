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
  invalidations: CodexResourceInvalidation[];
  status: 'accepted';
  threadId: string;
  turnId: string;
};

export type CodexThreadMessageStartResponse = CodexThreadMessageSendResponse;

export type CodexThreadMessageEditResponse = CodexThreadMessageSendResponse;

export type CodexThreadMessageForkResponse = CodexThreadMessageSendResponse;

export type CodexThreadCompactResponse = {
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
      type: 'threadComposerState' | 'threadRuntime' | 'threadSummary' | 'threadTokenUsage' | 'threadTranscript';
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
    };

export type CodexResourceInvalidationReason = 'appServerEvent' | 'commandAccepted' | 'sendAccepted';

export type CodexResourcesInvalidatedNotification = {
  invalidations: CodexResourceInvalidation[];
};
