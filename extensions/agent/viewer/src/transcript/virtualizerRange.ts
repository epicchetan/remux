import type { TranscriptMeasuredTurn } from './layout/types';
import {
  TranscriptGeometryIndex,
  type TranscriptExpandedRow,
} from './geometry/geometryIndex';

export const transcriptOverscanTurns = 10;
export const transcriptInitialRenderTurns = transcriptOverscanTurns * 2;

export type TranscriptVirtualRange = {
  activeTurnIds: string[];
  bottomSpacerHeight: number;
  firstActiveIndex: number;
  lastActiveIndex: number;
  topSpacerHeight: number;
};

export function computeTranscriptVirtualRange({
  geometry,
  overscanTurns = transcriptOverscanTurns,
  expandedRows = [],
  scrollTop,
  topPadding,
  turns,
  viewportHeight,
}: {
  geometry?: TranscriptGeometryIndex;
  overscanTurns?: number;
  expandedRows?: TranscriptExpandedRow[];
  scrollTop: number;
  topPadding: number;
  turns: TranscriptMeasuredTurn[];
  viewportHeight: number;
}): TranscriptVirtualRange {
  if (turns.length === 0) {
    return emptyRange();
  }

  const contentTop = Math.max(0, scrollTop - topPadding);
  const contentBottom = Math.max(0, scrollTop + viewportHeight - topPadding);
  const index = geometry ?? new TranscriptGeometryIndex(turns, expandedRows);
  const firstVisibleIndex = index.firstTurnWithBottomAfter(contentTop);
  const lastVisibleIndex = index.lastTurnWithTopBefore(contentBottom);
  const firstActiveIndex = Math.max(0, firstVisibleIndex - overscanTurns);
  const lastActiveIndex = Math.min(turns.length - 1, lastVisibleIndex + overscanTurns);

  return rangeFromIndexes({ geometry: index, firstActiveIndex, lastActiveIndex, turns });
}

export function computeTranscriptSpacerRange({
  activeTurnIds,
  expandedRows = [],
  geometry,
  turns,
}: {
  activeTurnIds: string[];
  expandedRows?: TranscriptExpandedRow[];
  geometry?: TranscriptGeometryIndex;
  turns: TranscriptMeasuredTurn[];
}): TranscriptVirtualRange {
  if (turns.length === 0 || activeTurnIds.length === 0) {
    return emptyRange();
  }

  const index = geometry ?? new TranscriptGeometryIndex(turns, expandedRows);
  const firstActiveIndex = index.indexOfTurn(activeTurnIds[0]);
  const lastActiveIndex = index.indexOfTurn(activeTurnIds[activeTurnIds.length - 1]);

  if (firstActiveIndex === -1 || lastActiveIndex === -1 || lastActiveIndex < firstActiveIndex) {
    return emptyRange();
  }

  return rangeFromIndexes({ geometry: index, firstActiveIndex, lastActiveIndex, turns });
}

export function initialTranscriptActiveTurnIds(turns: TranscriptMeasuredTurn[]) {
  return turns.slice(Math.max(0, turns.length - transcriptInitialRenderTurns)).map((turn) => turn.turnId);
}

export function sameTurnIds(left: string[], right: string[]) {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((id, index) => id === right[index]);
}

function rangeFromIndexes({
  geometry,
  firstActiveIndex,
  lastActiveIndex,
  turns,
}: {
  geometry: TranscriptGeometryIndex;
  firstActiveIndex: number;
  lastActiveIndex: number;
  turns: TranscriptMeasuredTurn[];
}): TranscriptVirtualRange {
  const firstActiveTurn = turns[firstActiveIndex];
  const lastActiveTurn = turns[lastActiveIndex];

  if (!firstActiveTurn || !lastActiveTurn) {
    return emptyRange();
  }

  const activeTurnIds = turns.slice(firstActiveIndex, lastActiveIndex + 1).map((turn) => turn.turnId);
  const renderedBottom = geometry.turnBottom(lastActiveIndex);

  return {
    activeTurnIds,
    bottomSpacerHeight: lastActiveIndex === turns.length - 1 ? 0 : Math.max(0, geometry.totalHeight - renderedBottom),
    firstActiveIndex,
    lastActiveIndex,
    topSpacerHeight:
      firstActiveIndex === 0 ? 0 : geometry.turnTop(firstActiveIndex),
  };
}

function emptyRange(): TranscriptVirtualRange {
  return {
    activeTurnIds: [],
    bottomSpacerHeight: 0,
    firstActiveIndex: -1,
    lastActiveIndex: -1,
    topSpacerHeight: 0,
  };
}

export type { TranscriptExpandedRow } from './geometry/geometryIndex';
