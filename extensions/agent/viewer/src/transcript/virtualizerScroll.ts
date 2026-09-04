import type { TranscriptMeasuredTurn } from './layout/types';
import type { TranscriptAutoScrollMode } from './viewportStore';
import type { TranscriptExpandedRow } from './virtualizerRange';

export const sentMessageAnchorTopOffsetPx = 24;

export type TranscriptScrollAnchor = {
  /** Measured user-row bounds in the transcript scroll coordinate space. */
  contentBottom: number;
  contentTop: number;
  segmentId: string;
  scrollTop: number;
  turnId: string;
};

export type TranscriptScrollAnchorSelection = {
  anchors: TranscriptScrollAnchor[];
  atBottom: boolean;
  currentSegmentId?: string | null;
  maxScrollTop?: number;
  scrollTop: number;
  threshold?: number;
};

export type SentMessageScrollResolution = {
  phase: 'anchored' | 'catching-up';
  runwayHeight: number;
  scrollTop: number;
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
  currentMode = { type: 'off' },
  nearBottom,
  userInitiated = true,
}: {
  currentMode?: TranscriptAutoScrollMode;
  nearBottom: boolean;
  userInitiated?: boolean;
}): TranscriptAutoScrollMode {
  if (!userInitiated) {
    return currentMode;
  }
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
    return currentMode;
  }

  if (currentMode.type === 'sent-message-anchor') {
    // An explicit message intent survives runtime/transcript ordering, work
    // collapse, completion, and background hydration. Only user input or a
    // newer message intent may replace it.
    return currentMode;
  }

  if (currentMode.type === 'bottom' || nearBottom) {
    return { type: 'bottom' };
  }

  return { type: 'off' };
}

export function userMessageAnchorScrollTop(rowTop: number, topPadding: number) {
  return Math.max(0, topPadding + rowTop - transcriptMessageAnchorTopOffset(topPadding));
}

export function userMessageScrollAnchors({
  expandedRows,
  topPadding,
  turns,
}: {
  expandedRows: TranscriptExpandedRow[];
  topPadding: number;
  turns: TranscriptMeasuredTurn[];
}): TranscriptScrollAnchor[] {
  const anchors: TranscriptScrollAnchor[] = [];
  const expanded = expandedRowGeometry(turns, expandedRows);
  turns.forEach((turn, turnIndex) => {
    let rowTop = turn.collapsedTop + expanded.heightBeforeTurnIndex(turnIndex);
    for (const row of turn.rows) {
      if (row.segment.type === 'userMessage') {
        anchors.push({
          contentBottom: topPadding + rowTop + row.height,
          contentTop: topPadding + rowTop,
          segmentId: row.segmentId,
          scrollTop: userMessageAnchorScrollTop(rowTop, topPadding),
          turnId: turn.turnId,
        });
      }
      rowTop += row.height + expanded.heightAfterRow(turn.turnId, row.id);
    }
  });
  return anchors;
}

export function previousUserMessageScrollAnchor({
  anchors,
  currentSegmentId = null,
  scrollTop,
}: TranscriptScrollAnchorSelection) {
  const currentIndex = currentSegmentId
    ? anchors.findIndex((anchor) => anchor.segmentId === currentSegmentId)
    : -1;
  if (currentIndex >= 0) {
    return currentIndex > 0 ? anchors[currentIndex - 1] ?? null : null;
  }

  // Without an explicit navigation anchor, Up means "show me the preceding
  // user message I cannot currently see." Comparing preferred anchor tops
  // made a partially or fully visible tail message eligible. Pinning that row
  // then created artificial runway beneath a short transcript. Use the whole
  // measured user row instead and select only a row already above the viewport.
  const viewportTop = Math.max(0, scrollTop) + 1;
  for (let index = anchors.length - 1; index >= 0; index -= 1) {
    const anchor = anchors[index];
    if (anchor && anchor.contentBottom <= viewportTop) return anchor;
  }
  return null;
}

export function nextUserMessageScrollAnchor({
  anchors,
  atBottom,
  currentSegmentId = null,
  maxScrollTop,
  scrollTop,
  threshold = 12,
}: TranscriptScrollAnchorSelection) {
  const isReachable = (anchor: TranscriptScrollAnchor | undefined) => Boolean(
    anchor && (maxScrollTop === undefined || anchor.scrollTop <= Math.max(0, maxScrollTop)),
  );
  const currentIndex = currentSegmentId
    ? anchors.findIndex((anchor) => anchor.segmentId === currentSegmentId)
    : -1;
  if (currentIndex >= 0) {
    const next = anchors[currentIndex + 1];
    return isReachable(next) ? next ?? null : null;
  }
  if (atBottom) return null;

  const target = scrollTop + Math.max(0, threshold);
  return anchors.find((anchor) => anchor.scrollTop > target && isReachable(anchor)) ?? null;
}

const anchorPinTolerancePx = 2;

export function resolveSentMessageScroll({
  anchorActivationAllowed = true,
  currentScrollTop,
  desiredScrollTop,
  naturalMaxScrollTop,
  phase,
  runwayHeight,
  wasPinned,
}: {
  anchorActivationAllowed?: boolean;
  currentScrollTop: number;
  desiredScrollTop: number;
  naturalMaxScrollTop: number;
  phase: 'anchored' | 'catching-up';
  runwayHeight: number;
  /**
   * Whether the previous resolution ended pinned. Content collapse clamps the
   * DOM scroll position before the next managed scroll runs, so pinned-ness
   * cannot be re-derived from the live scrollTop at that moment.
   */
  wasPinned: boolean;
}): SentMessageScrollResolution {
  const desired = Math.max(0, desiredScrollTop);
  const naturalMax = Math.max(0, naturalMaxScrollTop);
  if (desired <= naturalMax + 1) {
    if (phase === 'catching-up' && !anchorActivationAllowed) {
      return {
        phase: 'catching-up',
        runwayHeight: 0,
        scrollTop: Math.min(Math.max(0, currentScrollTop), naturalMax),
      };
    }
    return {
      phase: 'anchored',
      runwayHeight: 0,
      scrollTop: desired,
    };
  }

  // Once a message has reached its anchor, layout changes must not revoke that
  // user-visible state. Work collapse, attachment trays, and keyboard changes
  // can all reduce the natural scroll range; runway preserves the established
  // position until explicit user navigation releases it.
  const pinned =
    phase === 'anchored' &&
    (runwayHeight > 0 || wasPinned || Math.abs(currentScrollTop - desired) <= anchorPinTolerancePx);
  if (pinned) {
    return {
      phase: 'anchored',
      runwayHeight: desired - naturalMax,
      scrollTop: desired,
    };
  }

  return {
    phase: 'catching-up',
    runwayHeight: 0,
    scrollTop: naturalMax,
  };
}

export function initialTranscriptScrollTarget({
  anchors,
  conversationId,
  streamingTurnId,
}: {
  anchors: TranscriptScrollAnchor[];
  conversationId: string;
  streamingTurnId: string | null;
}): TranscriptInitialScrollTarget | null {
  const streamingAnchor = streamingTurnId
    ? anchors.find((anchor) => anchor.turnId === streamingTurnId) ?? null
    : null;
  if (streamingAnchor && streamingTurnId) {
    return {
      mode: {
        phase: 'catching-up',
        segmentId: streamingAnchor.segmentId,
        conversationId,
        type: 'sent-message-anchor',
        turnId: streamingTurnId,
      },
      scrollTop: streamingAnchor.scrollTop,
    };
  }

  const anchor = anchors[anchors.length - 1] ?? null;
  return anchor ? { mode: { type: 'off' }, scrollTop: anchor.scrollTop } : null;
}

export function resolveInitialTranscriptScrollTarget({
  maxScrollTop,
  target,
}: {
  maxScrollTop: number;
  target: TranscriptInitialScrollTarget | null;
}): TranscriptInitialScrollTarget {
  const normalizedMaxScrollTop = Math.max(0, maxScrollTop);
  if (!target) {
    return {
      mode: { type: 'bottom' },
      scrollTop: normalizedMaxScrollTop,
    };
  }

  const targetWasClampedToBottom = target.scrollTop > normalizedMaxScrollTop;
  return {
    mode: targetWasClampedToBottom && target.mode.type !== 'sent-message-anchor'
      ? { type: 'bottom' }
      : target.mode,
    scrollTop: Math.max(0, Math.min(target.scrollTop, normalizedMaxScrollTop)),
  };
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

export function anchorUserMessageScrollTop({
  expandedRows,
  segmentId,
  topPadding,
  turnId,
  turns,
}: {
  expandedRows: TranscriptExpandedRow[];
  segmentId: string;
  topPadding: number;
  turnId: string;
  turns: TranscriptMeasuredTurn[];
}) {
  const expanded = expandedRowGeometry(turns, expandedRows);

  for (let turnIndex = 0; turnIndex < turns.length; turnIndex += 1) {
    const turn = turns[turnIndex];
    if (!turn || turn.turnId !== turnId) continue;
    let rowTop = turn.collapsedTop + expanded.heightBeforeTurnIndex(turnIndex);
    for (const row of turn.rows) {
      if (row.segment.type === 'userMessage' && userMessageRowMatchesId(row.segmentId, row.segment.clientMessageId, segmentId)) {
        return userMessageAnchorScrollTop(rowTop, topPadding);
      }
      rowTop += row.height + expanded.heightAfterRow(turn.turnId, row.id);
    }
  }

  return null;
}

// Anchors created by the composer reference the clientMessageId; the
// authoritative transcript keys the same message by an Agent-owned segment id
// and echoes the composer id as clientMessageId.
export function userMessageRowMatchesId(
  segmentId: string,
  clientMessageId: string | null | undefined,
  trackedId: string,
) {
  return segmentId === trackedId || clientMessageId === trackedId;
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
