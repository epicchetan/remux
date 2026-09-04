import type { TranscriptRowPosition } from '../geometry/geometryIndex';
import type {
  MessageAnchorScrollResolution,
  TranscriptInitialScrollTarget,
  TranscriptScrollAnchorSelection,
  TranscriptViewportAnchor,
  TranscriptViewportIntent,
} from './viewportTypes';

export function viewportIntentAfterNativeScrollSettles({
  currentIntent = { kind: 'free' },
  nearBottom,
  userInitiated = true,
}: {
  currentIntent?: TranscriptViewportIntent;
  nearBottom: boolean;
  userInitiated?: boolean;
}): TranscriptViewportIntent {
  if (!userInitiated) return currentIntent;
  return nearBottom ? { kind: 'bottom-follow' } : { kind: 'free' };
}

export function viewportIntentForStreamingTurn({
  currentIntent,
  nearBottom,
  streamingTurnId,
}: {
  currentIntent: TranscriptViewportIntent;
  nearBottom: boolean;
  streamingTurnId: string | null;
}): TranscriptViewportIntent {
  if (!streamingTurnId || currentIntent.kind === 'message-anchor') return currentIntent;
  return currentIntent.kind === 'bottom-follow' || nearBottom
    ? { kind: 'bottom-follow' }
    : { kind: 'free' };
}

export function previousUserMessageScrollAnchor({
  anchors,
  currentSegmentId = null,
  scrollTop,
}: TranscriptScrollAnchorSelection) {
  const currentIndex = currentSegmentId
    ? anchors.findIndex((anchor) => anchor.segmentId === currentSegmentId)
    : -1;
  if (currentIndex >= 0) return currentIndex > 0 ? anchors[currentIndex - 1] ?? null : null;

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
  scrollTop,
  threshold = 12,
}: TranscriptScrollAnchorSelection) {
  const currentIndex = currentSegmentId
    ? anchors.findIndex((anchor) => anchor.segmentId === currentSegmentId)
    : -1;
  if (currentIndex >= 0) return anchors[currentIndex + 1] ?? null;
  if (atBottom) return null;

  const target = scrollTop + Math.max(0, threshold);
  return anchors.find((anchor) => anchor.scrollTop > target) ?? null;
}

export function historicalMessageNavigationDestination({
  bottomIfUnreachable,
  desiredScrollTop,
  naturalMaxScrollTop,
}: {
  bottomIfUnreachable: boolean;
  desiredScrollTop: number;
  naturalMaxScrollTop: number;
}): { kind: 'bottom' | 'message'; scrollTop: number } {
  const desired = Math.max(0, desiredScrollTop);
  const naturalMax = Math.max(0, naturalMaxScrollTop);
  return bottomIfUnreachable && desired > naturalMax + 1
    ? { kind: 'bottom', scrollTop: naturalMax }
    : { kind: 'message', scrollTop: desired };
}

export function transcriptViewportAnchorScrollTop(
  anchor: TranscriptViewportAnchor,
  positions: TranscriptRowPosition[],
) {
  const exact = positions.find((position) =>
    position.rowId === anchor.rowId && position.turnId === anchor.turnId);
  if (exact) return exact.scrollTop + anchor.offset;

  // Between-turn compaction can move to the next turn while retaining its
  // stable segment identity.
  const sameSegment = positions.find((position) => position.segmentId === anchor.segmentId);
  if (sameSegment) return sameSegment.scrollTop + anchor.offset;

  const sameTurn = positions.find((position) => position.turnId === anchor.turnId);
  return sameTurn ? sameTurn.scrollTop + Math.max(0, anchor.offset) : null;
}

const anchorPinTolerancePx = 2;

export function resolveMessageAnchorScroll({
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
  wasPinned: boolean;
}): MessageAnchorScrollResolution {
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
    return { phase: 'anchored', runwayHeight: 0, scrollTop: desired };
  }

  const pinned = phase === 'anchored' && (
    runwayHeight > 0 || wasPinned || Math.abs(currentScrollTop - desired) <= anchorPinTolerancePx
  );
  return pinned
    ? { phase: 'anchored', runwayHeight: desired - naturalMax, scrollTop: desired }
    : { phase: 'catching-up', runwayHeight: 0, scrollTop: naturalMax };
}

export function initialTranscriptScrollTarget({
  anchors,
  conversationId,
  streamingTurnId,
}: {
  anchors: Array<{ segmentId: string; scrollTop: number; turnId: string }>;
  conversationId: string;
  streamingTurnId: string | null;
}): TranscriptInitialScrollTarget | null {
  const streamingAnchor = streamingTurnId
    ? anchors.find((anchor) => anchor.turnId === streamingTurnId) ?? null
    : null;
  if (streamingAnchor && streamingTurnId) {
    return {
      intent: {
        conversationId,
        kind: 'message-anchor',
        phase: 'catching-up',
        reason: 'restore',
        segmentId: streamingAnchor.segmentId,
        turnId: streamingTurnId,
      },
      scrollTop: streamingAnchor.scrollTop,
    };
  }

  const anchor = anchors.at(-1) ?? null;
  return anchor ? { intent: { kind: 'free' }, scrollTop: anchor.scrollTop } : null;
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
    return { intent: { kind: 'bottom-follow' }, scrollTop: normalizedMaxScrollTop };
  }

  const targetWasClampedToBottom = target.scrollTop > normalizedMaxScrollTop;
  return {
    intent: targetWasClampedToBottom && target.intent.kind !== 'message-anchor'
      ? { kind: 'bottom-follow' }
      : target.intent,
    scrollTop: Math.max(0, Math.min(target.scrollTop, normalizedMaxScrollTop)),
  };
}

export function userMessageRowMatchesId(
  segmentId: string,
  clientMessageId: string | null | undefined,
  trackedId: string,
) {
  return segmentId === trackedId || clientMessageId === trackedId;
}
