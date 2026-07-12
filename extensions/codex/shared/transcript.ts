import type { MessagePhase } from './protocol/MessagePhase';
import type { TurnError } from './protocol/v2/TurnError';
import type { TurnStatus } from './protocol/v2/TurnStatus';
import type { UserInput } from './protocol/v2/UserInput';

export type CodexTranscriptResourcesReadParams = {
  requests: CodexTranscriptResourceRequest[];
  threadId: string;
};

export type CodexTranscriptResourceRequest =
  | {
      includeTailTurns?: number;
      knownRevision?: string;
      type: 'threadTranscript';
    }
  | {
      knownRevision?: string;
      turnId: string;
      type: 'turn';
    }
  | {
      knownRevision?: string;
      segmentId: string;
      turnId: string;
      type: 'workDetails';
    }
  | {
      itemId: string;
      knownRevision?: string;
      turnId: string;
      type: 'workItem';
    }
  | CodexTranscriptSyncRequest
  | CodexWorkGroupRequest
  | CodexWorkEntryDetailRequest;

export const CODEX_TRANSCRIPT_RENDER_PROTOCOL_VERSION = 2 as const;
export const CODEX_TRANSCRIPT_PROJECTION_VERSION = 'turn-render-v2' as const;
export const DEFAULT_TRANSCRIPT_TAIL_TURNS = 24;
export const DEFAULT_TRANSCRIPT_PREPEND_TURNS = 16;
export const MAX_TRANSCRIPT_WINDOW_TURNS = 40;
export const MAX_TRANSCRIPT_KNOWN_TURNS = 80;
export const DEFAULT_WORK_GROUP_ROWS = 200;
export const MAX_WORK_GROUP_ROWS = 256;

export type CodexTranscriptCapabilities = {
  limits: {
    maxGroupRows: number;
    maxKnownTurns: number;
    maxResponseBytes: number;
    maxWindowTurns: number;
  };
  preferredProtocolVersion: 2;
  projectionVersions: {
    2: typeof CODEX_TRANSCRIPT_PROJECTION_VERSION;
  };
  protocolVersions: Array<1 | 2>;
};

export type CodexTranscriptSyncRequest = {
  knownThreadRevision?: string;
  knownTurns?: Array<{
    renderRevision: string;
    turnId: string;
  }>;
  projectionVersion: typeof CODEX_TRANSCRIPT_PROJECTION_VERSION;
  protocolVersion: 2;
  type: 'transcriptSync';
  window:
    | {
        count?: number;
        kind: 'tail';
      }
    | {
        after: number;
        before: number;
        kind: 'around';
        turnId: string;
      }
    | {
        endTurnId: string;
        kind: 'range';
        startTurnId: string;
      };
};

export type CodexWorkGroupRequest = {
  cursor?: string;
  groupId: string;
  knownRevision?: string;
  limit?: number;
  protocolVersion: 2;
  segmentId: string;
  turnId: string;
  type: 'workGroup';
};

export type CodexWorkEntryDetailRequest = {
  groupId: string;
  knownRevision?: string;
  protocolVersion: 2;
  rowId: string;
  segmentId: string;
  turnId: string;
  type: 'workEntryDetail';
};

export type CodexTranscriptSyncResource = {
  activeTurnId: string | null;
  projectionVersion: typeof CODEX_TRANSCRIPT_PROJECTION_VERSION;
  protocolVersion: 2;
  removedTurnIds: string[];
  sessionId: string | null;
  threadId: string;
  threadRevision: string;
  turnOrder: string[];
  turns: CodexTurnRenderResult[];
  window: {
    endIndexExclusive: number;
    hasEarlier: boolean;
    hasLater: boolean;
    startIndex: number;
    turnIds: string[];
  };
};

export type CodexTurnRenderResult =
  | {
      frame: CodexTurnRenderFrame;
      renderRevision: string;
      status: 'ok';
      turnId: string;
    }
  | {
      renderRevision: string;
      status: 'notModified';
      turnId: string;
    }
  | {
      code: 'frameTooLarge' | 'projectionFailed';
      message: string;
      status: 'error';
      turnId: string;
    };

export type CodexTurnRenderFrame = {
  completedAt: number | null;
  durationMs: number | null;
  error: TurnError | null;
  id: string;
  layoutRevision: string;
  renderRevision: string;
  segments: CodexTurnRenderSegment[];
  startedAt: number | null;
  status: TurnStatus;
};

export type CodexTurnRenderSegment =
  | CodexUserMessageSegment
  | CodexAssistantMessageSegment
  | CodexCompactionSegment
  | CodexWorkRenderSegment;

export type CodexWorkRenderSegment = {
  durationMs: number | null;
  id: string;
  layoutRevision: string;
  revision: string;
  state: 'completed' | 'failed' | 'interrupted' | 'running';
  timeline: CodexWorkTimelineEntry[];
  type: 'work';
};

export type CodexWorkTimelineEntry =
  | (CodexWorkItem & { revision: string })
  | {
      groupType: 'activity' | 'files' | 'text' | 'tools';
      hasMoreRows: boolean;
      id: string;
      revision: string;
      rowCount: number;
      status: 'completed' | 'failed' | 'interrupted' | 'running';
      summary?: CodexWorkGroupSummary;
      title: string;
      type: 'group';
    };

export type CodexWorkGroupSummary = {
  commands: number;
  fileNames: string[];
  files: number;
  reads: number;
  searches: number;
  tools: number;
};

export type CodexWorkGroupResource = {
  groupId: string;
  layoutRevision: string;
  nextCursor: string | null;
  revision: string;
  rows: CodexWorkRowSummary[];
  segmentId: string;
  threadId: string;
  title: string;
  turnId: string;
  type: 'activity' | 'files' | 'text' | 'tools';
};

export type CodexWorkRowSummary =
  | {
      command: string | null;
      durationMs: number | null;
      exitCode: number | null;
      hasDetail: boolean;
      id: string;
      kind: CodexWorkActivity['kind'];
      path: string | null;
      revision: string;
      status: string;
      text: string;
      type: 'activity';
    }
  | {
      additions: number;
      deletions: number;
      hasDetail: boolean;
      id: string;
      kind: CodexFileChange['kind'];
      path: string;
      revision: string;
      status: string;
      type: 'fileChange';
    }
  | {
      category: CodexToolRow['category'];
      detailPreview: string | null;
      hasDetail: boolean;
      id: string;
      label: string;
      mediaCount: number;
      revision: string;
      status: string;
      type: 'tool';
    }
  | {
      hasDetail: false;
      id: string;
      revision: string;
      text: string;
      type: 'text';
    };

export type CodexWorkEntryDetailResource = {
  detail:
    | { detail: string | null; output: string | null; type: 'activity' }
    | { diff: string; type: 'fileChange' }
    | {
        detail: string | null;
        media: CodexMediaPreview[];
        result: string | null;
        type: 'tool';
      };
  groupId: string;
  layoutRevision: string;
  revision: string;
  rowId: string;
  segmentId: string;
  threadId: string;
  truncation: {
    originalBytes: number;
    returnedBytes: number;
    truncated: boolean;
  };
  turnId: string;
};

export type CodexTranscriptResourcesReadResponse = {
  resources: CodexTranscriptResourceResult[];
  threadId: string;
};

export type CodexTranscriptResourceResult = {
  key: string;
  reason?: string;
  requestIndex: number;
  revision?: string;
  status: 'ok' | 'notModified' | 'missing' | 'error';
  value?: unknown;
};

export type CodexThreadTranscriptResource = {
  revision: string;
  sessionId?: string | null;
  threadId: string;
  turnOrder: string[];
  turns?: CodexTranscriptTurn[];
};

export type CodexTurnResource = {
  layoutRevision: string;
  revision: string;
  threadId: string;
  turn: CodexTranscriptTurn;
  turnId: string;
};

export type CodexWorkDetailsResource = {
  details: CodexWorkDetails;
  revision: string;
  segmentId: string;
  threadId: string;
  turnId: string;
};

export type CodexWorkItemResource = {
  item: CodexWorkItem;
  itemId: string;
  revision: string;
  threadId: string;
  turnId: string;
};

export type CodexTranscriptTurn = {
  completedAt: number | null;
  durationMs: number | null;
  error: TurnError | null;
  id: string;
  revision: string;
  segments: CodexTranscriptSegment[];
  startedAt: number | null;
  status: TurnStatus;
};

export type CodexTranscriptSegment =
  | CodexUserMessageSegment
  | CodexWorkSegment
  | CodexAssistantMessageSegment
  | CodexCompactionSegment;

export type CodexUserMessageSegment = {
  content: UserInput[];
  id: string;
  isSteering?: boolean;
  revision: string;
  type: 'userMessage';
};

export type CodexAssistantMessageSegment = {
  id: string;
  phase: MessagePhase | null;
  revision: string;
  text: string;
  type: 'assistantMessage';
};

export type CodexWorkSegment = {
  durationMs: number | null;
  hasDetails: boolean;
  id: string;
  layoutRevision?: string;
  revision: string;
  state: 'running' | 'completed' | 'interrupted' | 'failed';
  timeline?: CodexWorkTimelineEntry[];
  type: 'work';
};

export type CodexCompactionSegment = {
  id: string;
  revision: string;
  status: 'compacting' | 'compacted' | 'cancelled';
  type: 'compaction';
};

export type CodexWorkDetails = {
  entries: CodexWorkEntry[];
  itemIds: string[];
  revision: string;
  segmentId: string;
};

export type CodexWorkEntry =
  | {
      id: string;
      itemId: string;
      type: 'message';
    }
  | {
      id: string;
      itemId: string;
      type: 'userMessage';
    }
  | {
      id: string;
      itemId: string;
      type: 'compaction';
    }
  | {
      group: CodexWorkGroupRef;
      id: string;
      type: 'group';
    };

export type CodexWorkGroupRef = {
  id: string;
  itemIds: string[];
  title: string;
  type: 'activity' | 'files' | 'text' | 'tools';
};

export type CodexWorkItem =
  | {
      id: string;
      phase: MessagePhase | null;
      text: string;
      type: 'message';
    }
  | {
      content: UserInput[];
      id: string;
      isSteering?: boolean;
      type: 'userMessage';
    }
  | {
      id: string;
      status: 'compacting' | 'compacted' | 'cancelled';
      type: 'compaction';
    }
  | {
      activity: CodexWorkActivity;
      id: string;
      type: 'activity';
    }
  | {
      files: CodexFileChange[];
      id: string;
      type: 'fileChanges';
    }
  | {
      id: string;
      row: CodexToolRow;
      type: 'tool';
    };

export type CodexWorkGroup =
  | CodexFileWorkGroup
  | CodexActivityWorkGroup
  | CodexTextWorkGroup
  | CodexToolWorkGroup;

export type CodexFileWorkGroup = {
  files: CodexFileChange[];
  id: string;
  title: string;
  type: 'files';
};

export type CodexActivityWorkGroup = {
  activities: CodexWorkActivity[];
  id: string;
  title: string;
  type: 'activity';
};

export type CodexTextWorkGroup = {
  id: string;
  lines: string[];
  title: string;
  type: 'text';
};

export type CodexToolWorkGroup = {
  id: string;
  rows: CodexToolRow[];
  title: string;
  type: 'tools';
};

export type CodexFileChange = {
  additions: number;
  deletions: number;
  diff: string;
  id: string;
  kind: 'added' | 'deleted' | 'edited' | 'moved';
  path: string;
  status: string;
};

export type CodexWorkActivity = {
  command: string | null;
  detail: string | null;
  durationMs: number | null;
  exitCode: number | null;
  id: string;
  kind: 'read' | 'list' | 'search' | 'webSearch' | 'command' | 'approval';
  output: string | null;
  path: string | null;
  status: string;
  text: string;
};

export type CodexToolRow = {
  category: 'browser' | 'generic' | 'image' | 'nodeRepl';
  detail: string | null;
  id: string;
  label: string;
  media: CodexMediaPreview[];
  result: string | null;
  status: string;
};

export type CodexMediaPreview = {
  id: string;
  label: string | null;
  source:
    | {
        type: 'localPath';
        path: string;
      }
    | {
        type: 'uri';
        uri: string;
      };
};
