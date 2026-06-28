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
  revision: string;
  state: 'running' | 'completed' | 'interrupted' | 'failed';
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
