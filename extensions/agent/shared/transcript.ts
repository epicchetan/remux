export const AGENT_TRANSCRIPT_PROTOCOL_VERSION = 1 as const;
export const AGENT_TRANSCRIPT_PROJECTION_VERSION = 'agent-turn-render-v1' as const;

export const DEFAULT_TRANSCRIPT_TAIL_TURNS = 24;
export const DEFAULT_TRANSCRIPT_PREPEND_TURNS = 16;
export const MAX_TRANSCRIPT_WINDOW_TURNS = 40;
export const MAX_TRANSCRIPT_KNOWN_TURNS = 80;
export const MAX_TRANSCRIPT_REQUESTS = 64;
export const MAX_TRANSCRIPT_RESPONSE_BYTES = 8 * 1024 * 1024;
export const MAX_TURN_FRAME_BYTES = 1024 * 1024;
export const DEFAULT_WORK_GROUP_ROWS = 200;
export const MAX_WORK_GROUP_ROWS = 256;
export const WORK_GROUP_ROW_LIMITS = [50, 100, 200] as const;
export const MAX_WORK_ENTRY_DETAIL_BYTES = 64 * 1024;

export type AgentTurnStatus =
  | 'queued'
  | 'inProgress'
  | 'completed'
  | 'failed'
  | 'interrupted';

export type AgentTurnError = {
  code: 'provider_error' | 'runtime_error';
  message: string;
};

export type AgentUserMessageSegment = {
  id: string;
  type: 'userMessage';
  clientMessageId: string | null;
  revision: string;
  text: string;
};

export type AgentAssistantMessageSegment = {
  id: string;
  type: 'assistantMessage';
  revision: string;
  text: string;
};

export type AgentWorkTextTimelineEntry = {
  id: string;
  type: 'text';
  revision: string;
  text: string;
};

export type AgentWorkGroupTimelineEntry = {
  id: string;
  type: 'group';
  revision: string;
  groupType: 'activity' | 'files' | 'text' | 'tools';
  title: string;
  status: 'running' | 'completed' | 'failed' | 'interrupted';
  rowCount: number;
  hasMoreRows: boolean;
};

export type AgentWorkTimelineEntry =
  | AgentWorkTextTimelineEntry
  | AgentWorkGroupTimelineEntry;

export type AgentWorkRenderSegment = {
  id: string;
  type: 'work';
  state: 'running' | 'completed' | 'failed' | 'interrupted';
  revision: string;
  layoutRevision: string;
  durationMs: number | null;
  timeline: AgentWorkTimelineEntry[];
};

export type AgentTurnSegment =
  | AgentUserMessageSegment
  | AgentWorkRenderSegment
  | AgentAssistantMessageSegment;

export type AgentTurnRenderFrame = {
  id: string;
  status: AgentTurnStatus;
  startedAt: number | null;
  completedAt: number | null;
  durationMs: number | null;
  error: AgentTurnError | null;
  renderRevision: string;
  layoutRevision: string;
  segments: AgentTurnSegment[];
};

export type AgentTranscriptSyncRequest = {
  type: 'transcriptSync';
  protocolVersion: typeof AGENT_TRANSCRIPT_PROTOCOL_VERSION;
  projectionVersion: typeof AGENT_TRANSCRIPT_PROJECTION_VERSION;
  knownConversationRevision?: string;
  knownTurns?: Array<{
    turnId: string;
    renderRevision: string;
  }>;
  window:
    | {
        kind: 'tail';
        count?: number;
      }
    | {
        kind: 'around';
        turnId: string;
        before: number;
        after: number;
      }
    | {
        kind: 'range';
        startTurnId: string;
        endTurnId: string;
      };
};

export type AgentTranscriptSyncResource = {
  protocolVersion: typeof AGENT_TRANSCRIPT_PROTOCOL_VERSION;
  projectionVersion: typeof AGENT_TRANSCRIPT_PROJECTION_VERSION;
  conversationId: string;
  conversationRevision: string;
  basisSequence: number;
  activeTurnId: string | null;
  turnOrder: string[];
  turns: AgentTurnRenderResult[];
  removedTurnIds: string[];
  window: {
    startIndex: number;
    endIndexExclusive: number;
    hasEarlier: boolean;
    hasLater: boolean;
    turnIds: string[];
  };
};

export type AgentTurnRenderResult =
  | {
      status: 'ok';
      turnId: string;
      renderRevision: string;
      frame: AgentTurnRenderFrame;
    }
  | {
      status: 'notModified';
      turnId: string;
      renderRevision: string;
    }
  | {
      status: 'error';
      turnId: string;
      code: 'frameTooLarge' | 'projectionFailed';
      message: string;
    };

export type AgentWorkGroupRequest = {
  type: 'workGroup';
  protocolVersion: typeof AGENT_TRANSCRIPT_PROTOCOL_VERSION;
  turnId: string;
  segmentId: string;
  groupId: string;
  cursor?: string;
  limit?: number;
  knownRevision?: string;
};

export type AgentWorkEntryDetailRequest = {
  type: 'workEntryDetail';
  protocolVersion: typeof AGENT_TRANSCRIPT_PROTOCOL_VERSION;
  turnId: string;
  segmentId: string;
  groupId: string;
  rowId: string;
  knownRevision?: string;
};

export type AgentWorkActivityRow = {
  id: string;
  type: 'activity';
  revision: string;
  kind: 'read';
  status: 'running' | 'completed' | 'failed' | 'interrupted';
  text: string;
  path: string | null;
  durationMs: number | null;
  hasDetail: boolean;
};

export type AgentWorkFileChangeRow = {
  id: string;
  type: 'fileChange';
  revision: string;
  kind: 'added' | 'deleted' | 'edited' | 'moved';
  status: 'completed' | 'failed';
  path: string;
  additions: number;
  deletions: number;
  hasDetail: boolean;
};

export type AgentWorkToolRow = {
  id: string;
  type: 'tool';
  revision: string;
  category: 'generic';
  status: 'running' | 'completed' | 'failed' | 'interrupted';
  label: string;
  detailPreview: string | null;
  hasDetail: boolean;
};

export type AgentWorkTextRow = {
  id: string;
  type: 'text';
  revision: string;
  text: string;
  hasDetail: false;
};

export type AgentWorkRowSummary =
  | AgentWorkActivityRow
  | AgentWorkFileChangeRow
  | AgentWorkToolRow
  | AgentWorkTextRow;

export type AgentWorkGroupResource = {
  conversationId: string;
  turnId: string;
  segmentId: string;
  groupId: string;
  type: 'activity' | 'files' | 'text' | 'tools';
  title: string;
  revision: string;
  layoutRevision: string;
  rows: AgentWorkRowSummary[];
  nextCursor: string | null;
};

export type AgentWorkEntryDetailResource = {
  conversationId: string;
  turnId: string;
  segmentId: string;
  groupId: string;
  rowId: string;
  revision: string;
  layoutRevision: string;
  detail:
    | {
        type: 'activity';
        detail: string | null;
        output: string | null;
      }
    | {
        type: 'fileChange';
        diff: string;
      }
    | {
        type: 'tool';
        detail: string | null;
        result: string | null;
      };
  truncation: {
    originalBytes: number;
    returnedBytes: number;
    truncated: boolean;
  };
};

export type AgentTranscriptResourceRequest =
  | AgentTranscriptSyncRequest
  | AgentWorkGroupRequest
  | AgentWorkEntryDetailRequest;

export type AgentTranscriptResourcesReadParams = {
  conversationId: string;
  requests: AgentTranscriptResourceRequest[];
};

export type AgentTranscriptResourceResult = {
  requestIndex: number;
  key: string;
  status: 'ok' | 'notModified' | 'missing' | 'error';
  revision?: string;
  reason?: string;
  value?: AgentTranscriptSyncResource | AgentWorkGroupResource | AgentWorkEntryDetailResource;
};

export type AgentTranscriptResourcesReadResult = {
  conversationId: string;
  serverGeneration: string;
  resources: AgentTranscriptResourceResult[];
};

export type AgentResourceInvalidation =
  | {
      type: 'resource';
      key: 'auth' | 'models' | `conversation:${string}`;
      reason: 'created' | 'updated' | 'deleted';
    }
  | {
      type: 'transcript';
      key: `transcript:${string}`;
      conversationId: string;
      turnId?: string;
      reason: 'sendAccepted' | 'runtimeEvent' | 'terminal';
      affectsOrder: boolean;
      affectsLayout: boolean;
    }
  | {
      type: 'workGroup';
      key: string;
      conversationId: string;
      turnId: string;
      segmentId: string;
      groupId: string;
      reason: 'runtimeEvent' | 'terminal';
      affectsLayout: boolean;
    }
  | {
      type: 'workEntryDetail';
      key: string;
      conversationId: string;
      turnId: string;
      segmentId: string;
      groupId: string;
      rowId: string;
      reason: 'runtimeEvent' | 'terminal';
      affectsLayout: boolean;
    };

export function workGroupResourceKey(
  conversationId: string,
  turnId: string,
  segmentId: string,
  groupId: string,
) {
  return `workGroup:${conversationId}:${turnId}:${segmentId}:${groupId}`;
}

export function workEntryDetailResourceKey(
  conversationId: string,
  turnId: string,
  segmentId: string,
  groupId: string,
  rowId: string,
) {
  return `workEntryDetail:${conversationId}:${turnId}:${segmentId}:${groupId}:${rowId}`;
}
