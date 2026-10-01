import {
  TranscriptGeometryIndex,
  type TranscriptExpandedRow,
} from './geometry/geometryIndex';
import type { TranscriptMeasuredTurn } from './layout/types';
import type { AgentTurnSegment } from '../../../shared/transcript';
import { userMessageRowMatchesId } from './viewport/viewportReducer';
import type { TranscriptScrollAnchor } from './viewport/viewportTypes';

export const messageAnchorTopOffsetPx = 24;

export function isTranscriptSection(segment: AgentTurnSegment) {
  return segment.type === 'userMessage' || isContinuationSection(segment);
}

export function isContinuationSection(segment: AgentTurnSegment) {
  return segment.type === 'notice' &&
    (segment.origin === 'native-followup' || segment.origin === 'federation-notification');
}

export function transcriptMessageAnchorTopOffset(topPadding: number) {
  return Math.max(messageAnchorTopOffsetPx, topPadding);
}

export function transcriptSectionAnchorScrollTop(rowTop: number, topPadding: number) {
  return Math.max(0, topPadding + rowTop - transcriptMessageAnchorTopOffset(topPadding));
}

export function transcriptSectionScrollAnchors({
  expandedRows,
  geometry,
  topPadding,
  turns,
}: {
  expandedRows: TranscriptExpandedRow[];
  geometry?: TranscriptGeometryIndex;
  topPadding: number;
  turns: TranscriptMeasuredTurn[];
}): TranscriptScrollAnchor[] {
  const anchors: TranscriptScrollAnchor[] = [];
  const index = geometry ?? new TranscriptGeometryIndex(turns, expandedRows);
  turns.forEach((turn, turnIndex) => {
    let rowTop = index.turnTop(turnIndex);
    for (const row of turn.rows) {
      if (isTranscriptSection(row.segment)) {
        anchors.push({
          contentBottom: topPadding + rowTop + row.height,
          contentTop: topPadding + rowTop,
          segmentId: row.segmentId,
          scrollTop: transcriptSectionAnchorScrollTop(rowTop, topPadding),
          turnId: turn.turnId,
        });
      }
      rowTop += row.height + index.heightAfterRow(turn.turnId, row.id);
    }
  });
  return anchors;
}

export function anchorTurnSectionScrollTop({
  expandedRows,
  geometry,
  topPadding,
  turnId,
  turns,
}: {
  expandedRows: TranscriptExpandedRow[];
  geometry?: TranscriptGeometryIndex;
  topPadding: number;
  turnId: string;
  turns: TranscriptMeasuredTurn[];
}) {
  const index = geometry ?? new TranscriptGeometryIndex(turns, expandedRows);
  const turnIndex = index.indexOfTurn(turnId);
  const turn = turns[turnIndex];
  if (!turn) return null;

  let rowTop = index.turnTop(turnIndex);
  for (const row of turn.rows) {
    if (isTranscriptSection(row.segment)) {
      return transcriptSectionAnchorScrollTop(rowTop, topPadding);
    }
    rowTop += row.height + index.heightAfterRow(turn.turnId, row.id);
  }
  return null;
}

export function anchorTranscriptSectionScrollTop({
  expandedRows,
  geometry,
  segmentId,
  topPadding,
  turnId,
  turns,
}: {
  expandedRows: TranscriptExpandedRow[];
  geometry?: TranscriptGeometryIndex;
  segmentId: string;
  topPadding: number;
  turnId: string;
  turns: TranscriptMeasuredTurn[];
}) {
  const index = geometry ?? new TranscriptGeometryIndex(turns, expandedRows);
  const turnIndex = index.indexOfTurn(turnId);
  const turn = turns[turnIndex];
  if (!turn) return null;

  let rowTop = index.turnTop(turnIndex);
  for (const row of turn.rows) {
    if (
      isTranscriptSection(row.segment) &&
      userMessageRowMatchesId(row.segmentId,
        row.segment.type === 'userMessage' ? row.segment.clientMessageId : null, segmentId)
    ) {
      return transcriptSectionAnchorScrollTop(rowTop, topPadding);
    }
    rowTop += row.height + index.heightAfterRow(turn.turnId, row.id);
  }
  return null;
}

export {
  historicalMessageNavigationDestination,
  initialTranscriptScrollTarget,
  nextTranscriptSectionScrollAnchor,
  nextTranscriptNavigationDestination,
  previousTranscriptSectionScrollAnchor,
  resolveInitialTranscriptScrollTarget,
  resolveMessageAnchorScroll,
  transcriptViewportAnchorScrollTop,
  userMessageRowMatchesId,
  viewportIntentAfterNativeScrollSettles,
  viewportIntentForStreamingTurn,
} from './viewport/viewportReducer';

export type { TranscriptRowPosition } from './geometry/geometryIndex';
export type {
  MessageAnchorScrollResolution,
  TranscriptInitialScrollTarget,
  TranscriptDownNavigationDestination,
  TranscriptScrollAnchor,
  TranscriptScrollAnchorSelection,
  TranscriptViewportAnchor,
} from './viewport/viewportTypes';
