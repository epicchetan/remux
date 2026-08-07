import type { TranscriptMeasuredTurn } from './layout/types';

export const transcriptOverscanTurns = 10;
export const transcriptInitialRenderTurns = transcriptOverscanTurns * 2;

export type TranscriptExpandedRow = {
  additionalHeight: number;
  rowId: string;
  turnId: string;
};

export type TranscriptVirtualRange = {
  activeTurnIds: string[];
  bottomSpacerHeight: number;
  firstActiveIndex: number;
  lastActiveIndex: number;
  topSpacerHeight: number;
};

type ExpandedGeometry = {
  heightBeforeTurnIndex: (turnIndex: number) => number;
  heightInsideTurn: (turnId: string) => number;
  totalAdditionalHeight: number;
};

export function computeTranscriptVirtualRange({
  overscanTurns = transcriptOverscanTurns,
  expandedRows = [],
  scrollTop,
  topPadding,
  turns,
  viewportHeight,
}: {
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
  const expanded = expandedGeometry(turns, expandedRows);
  const firstVisibleIndex = firstTurnWithBottomAfter(turns, contentTop, expanded);
  const lastVisibleIndex = lastTurnWithTopBefore(turns, contentBottom, expanded);
  const firstActiveIndex = Math.max(0, firstVisibleIndex - overscanTurns);
  const lastActiveIndex = Math.min(turns.length - 1, lastVisibleIndex + overscanTurns);

  return rangeFromIndexes({ expanded, firstActiveIndex, lastActiveIndex, turns });
}

export function computeTranscriptSpacerRange({
  activeTurnIds,
  expandedRows = [],
  turns,
}: {
  activeTurnIds: string[];
  expandedRows?: TranscriptExpandedRow[];
  turns: TranscriptMeasuredTurn[];
}): TranscriptVirtualRange {
  if (turns.length === 0 || activeTurnIds.length === 0) {
    return emptyRange();
  }

  const firstActiveIndex = turnIndex(turns, activeTurnIds[0]);
  const lastActiveIndex = turnIndex(turns, activeTurnIds[activeTurnIds.length - 1]);

  if (firstActiveIndex === -1 || lastActiveIndex === -1 || lastActiveIndex < firstActiveIndex) {
    return emptyRange();
  }

  return rangeFromIndexes({ expanded: expandedGeometry(turns, expandedRows), firstActiveIndex, lastActiveIndex, turns });
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
  expanded,
  firstActiveIndex,
  lastActiveIndex,
  turns,
}: {
  expanded: ExpandedGeometry;
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
  const renderedBottom = adjustedTurnBottom(lastActiveTurn, lastActiveIndex, expanded);
  const totalCollapsedHeight = totalHeight(turns) + expanded.totalAdditionalHeight;

  return {
    activeTurnIds,
    bottomSpacerHeight: lastActiveIndex === turns.length - 1 ? 0 : Math.max(0, totalCollapsedHeight - renderedBottom),
    firstActiveIndex,
    lastActiveIndex,
    topSpacerHeight:
      firstActiveIndex === 0 ? 0 : adjustedTurnTop(firstActiveTurn, firstActiveIndex, expanded),
  };
}

function firstTurnWithBottomAfter(
  turns: TranscriptMeasuredTurn[],
  target: number,
  expanded: ExpandedGeometry,
) {
  let low = 0;
  let high = turns.length - 1;
  let result = turns.length - 1;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const turn = turns[middle];
    const bottom = turn ? adjustedTurnBottom(turn, middle, expanded) : 0;

    if (bottom >= target) {
      result = middle;
      high = middle - 1;
    } else {
      low = middle + 1;
    }
  }

  return result;
}

function lastTurnWithTopBefore(
  turns: TranscriptMeasuredTurn[],
  target: number,
  expanded: ExpandedGeometry,
) {
  let low = 0;
  let high = turns.length - 1;
  let result = 0;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const turn = turns[middle];
    const top = turn ? adjustedTurnTop(turn, middle, expanded) : 0;

    if (top <= target) {
      result = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  return result;
}

function adjustedTurnTop(
  turn: TranscriptMeasuredTurn,
  turnIndexValue: number,
  expanded: ExpandedGeometry,
) {
  return turn.collapsedTop + expanded.heightBeforeTurnIndex(turnIndexValue);
}

function adjustedTurnBottom(
  turn: TranscriptMeasuredTurn,
  turnIndexValue: number,
  expanded: ExpandedGeometry,
) {
  return (
    adjustedTurnTop(turn, turnIndexValue, expanded) +
    turn.collapsedHeight +
    expanded.heightInsideTurn(turn.turnId)
  );
}

function totalHeight(turns: TranscriptMeasuredTurn[]) {
  const lastTurn = turns[turns.length - 1];
  return lastTurn ? lastTurn.collapsedTop + lastTurn.collapsedHeight : 0;
}

function expandedGeometry(turns: TranscriptMeasuredTurn[], expandedRows: TranscriptExpandedRow[]): ExpandedGeometry {
  if (expandedRows.length === 0 || turns.length === 0) {
    return emptyExpandedGeometry();
  }

  const turnIndexById = new Map(turns.map((turn, index) => [turn.turnId, index]));
  const heightByTurnIndex = new Map<number, number>();
  const heightByTurnId = new Map<string, number>();
  for (const row of expandedRows) {
    const turnIndexValue = turnIndexById.get(row.turnId);
    if (turnIndexValue === undefined) {
      continue;
    }
    const height = Math.max(0, row.additionalHeight);
    heightByTurnIndex.set(turnIndexValue, (heightByTurnIndex.get(turnIndexValue) ?? 0) + height);
    heightByTurnId.set(row.turnId, (heightByTurnId.get(row.turnId) ?? 0) + height);
  }

  const sortedIndexes = Array.from(heightByTurnIndex.keys()).sort((left, right) => left - right);
  const prefixHeights: number[] = [];
  let totalAdditionalHeight = 0;
  for (const index of sortedIndexes) {
    totalAdditionalHeight += heightByTurnIndex.get(index) ?? 0;
    prefixHeights.push(totalAdditionalHeight);
  }

  return {
    heightBeforeTurnIndex(turnIndexValue) {
      let low = 0;
      let high = sortedIndexes.length - 1;
      let result = -1;
      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        const expandedIndex = sortedIndexes[middle] ?? 0;
        if (expandedIndex < turnIndexValue) {
          result = middle;
          low = middle + 1;
        } else {
          high = middle - 1;
        }
      }
      return result >= 0 ? prefixHeights[result] ?? 0 : 0;
    },
    heightInsideTurn(turnId) {
      return heightByTurnId.get(turnId) ?? 0;
    },
    totalAdditionalHeight,
  };
}

function emptyExpandedGeometry(): ExpandedGeometry {
  return {
    heightBeforeTurnIndex: () => 0,
    heightInsideTurn: () => 0,
    totalAdditionalHeight: 0,
  };
}

function turnIndex(turns: TranscriptMeasuredTurn[], turnId: string | undefined) {
  if (!turnId) {
    return -1;
  }

  return turns.findIndex((turn) => turn.turnId === turnId);
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
