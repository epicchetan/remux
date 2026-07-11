import type { TranscriptMeasuredTurn } from './layout/types';
import type { TranscriptAutoScrollMode } from './viewportStore';
import type { TranscriptExpandedRow } from './virtualizerRange';

export const sentMessageAnchorTopOffsetPx = 24;

export type TranscriptScrollAnchor = {
  scrollTop: number;
  turnId: string;
};

export type TranscriptInitialScrollTarget = {
  mode: TranscriptAutoScrollMode;
  scrollTop: number;
};

export type TranscriptNativeScrollPhase = 'idle' | 'momentum' | 'touch';

export type TranscriptNativeScrollEvent = 'settle' | 'touch-end' | 'touch-start';

type ExpandedRowGeometry = {
  heightAfterRow: (turnId: string, rowId: string) => number;
  heightBeforeTurnIndex: (turnIndex: number) => number;
};

export function transcriptMessageAnchorTopOffset(topPadding: number) {
  return Math.max(sentMessageAnchorTopOffsetPx, topPadding);
}

export function transcriptNativeScrollPhaseAfterEvent(
  phase: TranscriptNativeScrollPhase,
  event: TranscriptNativeScrollEvent,
): TranscriptNativeScrollPhase {
  if (event === 'touch-start') {
    return 'touch';
  }
  if (event === 'touch-end') {
    return 'momentum';
  }
  return phase === 'touch' ? phase : 'idle';
}

export function nativeScrollOwnsTranscriptViewport(phase: TranscriptNativeScrollPhase) {
  return phase !== 'idle';
}

export function autoScrollModeAfterNativeScrollSettles({
  nearBottom,
}: {
  nearBottom: boolean;
}): TranscriptAutoScrollMode {
  return nearBottom ? { type: 'bottom' } : { type: 'off' };
}

export function autoScrollModeForStreamingTurn({
  currentMode,
  nearBottom,
  streamingTurnId,
}: {
  currentMode: TranscriptAutoScrollMode;
  nearBottom: boolean;
  streamingTurnId: string | null;
}): TranscriptAutoScrollMode {
  // Streaming lifecycle changes must not turn bottom stickiness into a
  // sent-message anchor. That anchor is entered explicitly by turn navigation.
  if (!streamingTurnId) {
    return currentMode.type === 'sent-message-anchor' ? { type: 'off' } : currentMode;
  }

  if (currentMode.type === 'sent-message-anchor') {
    if (currentMode.turnId === streamingTurnId) {
      return currentMode;
    }
    return nearBottom ? { type: 'bottom' } : { type: 'off' };
  }

  if (currentMode.type === 'bottom' || nearBottom) {
    return { type: 'bottom' };
  }

  return { type: 'off' };
}

export function userMessageAnchorScrollTop(rowTop: number, topPadding: number) {
  return Math.max(0, topPadding + rowTop - transcriptMessageAnchorTopOffset(topPadding));
}

export function initialTranscriptScrollTarget({
  anchors,
  streamingTurnId,
}: {
  anchors: TranscriptScrollAnchor[];
  streamingTurnId: string | null;
}): TranscriptInitialScrollTarget | null {
  const streamingAnchor = streamingTurnId
    ? anchors.find((anchor) => anchor.turnId === streamingTurnId) ?? null
    : null;
  if (streamingAnchor && streamingTurnId) {
    return {
      mode: { type: 'off' },
      scrollTop: streamingAnchor.scrollTop,
    };
  }

  const anchor = anchors[anchors.length - 1] ?? null;
  return anchor ? { mode: { type: 'off' }, scrollTop: anchor.scrollTop } : null;
}

export function anchorTurnUserMessageScrollTop({
  expandedRows,
  topPadding,
  turnId,
  turns,
}: {
  expandedRows: TranscriptExpandedRow[];
  topPadding: number;
  turnId: string;
  turns: TranscriptMeasuredTurn[];
}) {
  const expanded = expandedRowGeometry(turns, expandedRows);

  for (let turnIndex = 0; turnIndex < turns.length; turnIndex += 1) {
    const turn = turns[turnIndex];
    if (!turn || turn.turnId !== turnId) {
      continue;
    }

    let rowTop = turn.collapsedTop + expanded.heightBeforeTurnIndex(turnIndex);

    for (const row of turn.rows) {
      if (row.segment.type === 'userMessage') {
        return userMessageAnchorScrollTop(rowTop, topPadding);
      }

      rowTop += row.height + expanded.heightAfterRow(turn.turnId, row.id);
    }
  }

  return null;
}

function expandedRowGeometry(turns: TranscriptMeasuredTurn[], expandedRows: TranscriptExpandedRow[]): ExpandedRowGeometry {
  if (expandedRows.length === 0 || turns.length === 0) {
    return emptyExpandedRowGeometry();
  }

  const turnIndexById = new Map(turns.map((turn, index) => [turn.turnId, index]));
  const heightByTurnIndex = new Map<number, number>();
  const heightByRowKey = new Map<string, number>();
  for (const row of expandedRows) {
    const turnIndexValue = turnIndexById.get(row.turnId);
    if (turnIndexValue === undefined) {
      continue;
    }
    const height = Math.max(0, row.additionalHeight);
    heightByTurnIndex.set(turnIndexValue, (heightByTurnIndex.get(turnIndexValue) ?? 0) + height);
    const rowKey = expandedRowKey(row.turnId, row.rowId);
    heightByRowKey.set(rowKey, (heightByRowKey.get(rowKey) ?? 0) + height);
  }

  const sortedIndexes = Array.from(heightByTurnIndex.keys()).sort((left, right) => left - right);
  const prefixHeights: number[] = [];
  let total = 0;
  for (const index of sortedIndexes) {
    total += heightByTurnIndex.get(index) ?? 0;
    prefixHeights.push(total);
  }

  return {
    heightAfterRow(turnId, rowId) {
      return heightByRowKey.get(expandedRowKey(turnId, rowId)) ?? 0;
    },
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
  };
}

function emptyExpandedRowGeometry(): ExpandedRowGeometry {
  return {
    heightAfterRow: () => 0,
    heightBeforeTurnIndex: () => 0,
  };
}

function expandedRowKey(turnId: string, rowId: string) {
  return `${turnId}:${rowId}`;
}
