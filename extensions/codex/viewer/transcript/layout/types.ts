import type { CodexTranscriptSegment, CodexTranscriptTurn } from '../../../shared/transcript';

export type TranscriptMeasuredLayout = {
  contentWidth: number;
  totalCollapsedHeight: number;
  turns: TranscriptMeasuredTurn[];
  turnsById: Record<string, TranscriptMeasuredTurn>;
  width: number;
};

export type TranscriptMeasuredTurn = {
  collapsedHeight: number;
  collapsedTop: number;
  revision: string;
  rows: TranscriptMeasuredRow[];
  turn: CodexTranscriptTurn;
  turnId: string;
  userMessageDisclosureRevision: string;
};

export type TranscriptMeasuredRow = {
  height: number;
  id: string;
  segment: CodexTranscriptSegment;
  segmentId: string;
  showAssistantActions: boolean;
  showUserActions: boolean;
  turn: CodexTranscriptTurn;
  turnId: string;
  userMessageDisclosure?: TranscriptUserMessageDisclosure;
};

export type TranscriptUserMessageDisclosure = {
  collapsible: boolean;
  expanded: boolean;
  maxLines: number;
};
