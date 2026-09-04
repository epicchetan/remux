import { Loader2, RotateCcw, X } from 'lucide-react';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import type { AgentTurnSegment } from '../../../shared/transcript';
import { AssistantMessage } from './components/assistantMessage';
import { CompactionDivider } from './components/CompactionDivider';
import { UserMessage } from './components/userMessage';
import { WorkSection } from './components/work/WorkSection';
import { transcriptLayout } from './layout/constants';
import type { TranscriptMeasuredRow, TranscriptMeasuredTurn } from './layout/types';
import { useTranscriptLayoutStore } from './layoutStore';
import { resolveTranscriptContentWidth } from './measureWidth';
import {
  getTranscriptResourceState,
  useTranscriptResourceStore,
  type TranscriptStatus,
} from './resourceStore';
import {
  registerTranscriptViewportCapture,
  type TranscriptAutoScrollMode,
  useTranscriptViewportStore,
} from './viewportStore';
import {
  computeTranscriptSpacerRange,
  computeTranscriptVirtualRange,
  initialTranscriptActiveTurnIds,
  sameTurnIds,
  type TranscriptExpandedRow,
} from './virtualizerRange';
import {
  anchorTurnUserMessageScrollTop,
  anchorUserMessageScrollTop,
  autoScrollModeAfterNativeScrollSettles,
  autoScrollModeForStreamingTurn,
  initialTranscriptScrollTarget,
  nativeScrollOwnsTranscriptViewport,
  nextUserMessageScrollAnchor,
  previousUserMessageScrollAnchor,
  resolveInitialTranscriptScrollTarget,
  resolveSentMessageScroll,
  transcriptMessageAnchorTopOffset,
  transcriptNativeScrollPhaseAfterEvent,
  userMessageScrollAnchors,
  type TranscriptNativeScrollPhase,
  type TranscriptScrollAnchor,
} from './virtualizerScroll';

const bottomStickThresholdPx = 12;
const scrollNavigationDurationMs = 170;
const scrollNavigationThresholdPx = 12;
// A scrollTop write after touchend cancels native iOS deceleration. Older WebViews
// lack scrollend, so release ownership only after scroll events have gone quiet.
const touchScrollSettleDelayMs = 180;

type TranscriptViewportAnchor = {
  offset: number;
  rowId: string;
  turnId: string;
};

type TranscriptViewportCacheEntry =
  | { kind: 'bottom' }
  | { kind: 'user-message'; segmentId: string; turnId: string }
  | { kind: 'row-offset'; anchor: TranscriptViewportAnchor };

type TranscriptInitialViewportIntent = Extract<
  TranscriptViewportCacheEntry,
  { kind: 'bottom' | 'user-message' }
>;

const transcriptViewportAnchorCache = new Map<string, TranscriptViewportCacheEntry>();
const MAX_CACHED_TRANSCRIPT_VIEWPORT_ANCHORS = 5;

type TranscriptRowPosition = {
  rowId: string;
  scrollTop: number;
  turnId: string;
};

type TranscriptViewportModeChangeReason =
  | 'initial-scroll'
  | 'mount-stickiness'
  | 'manual-scroll'
  | 'scroll-navigation'
  | 'scroll-navigation-bottom'
  | 'scroll-settled'
  | 'host-navigate'
  | 'streaming-turn'
  | 'touch-start';

export function VirtualizedTranscript({ conversationId }: { conversationId: string }) {
  const activeConversationId = useTranscriptResourceStore((state) => state.activeConversationId);
  const setActiveConversationId = useTranscriptResourceStore((state) => state.setActiveConversationId);
  const status = useTranscriptResourceStore((state) => state.status);
  const error = useTranscriptResourceStore((state) => state.error);
  const refreshTranscript = useTranscriptResourceStore((state) => state.refreshActiveTranscriptResources);
  const workingTurnId = useTranscriptResourceStore((state) => state.workingTurnId);
  // Order and measured rows must come from the same external-store snapshot.
  // Resource hydration is intentionally separate and may publish before or
  // after layout reconciliation; mixing its order with measured layout causes
  // a transient partial transcript during window changes.
  const turnOrder = useTranscriptLayoutStore((state) => state.turnOrder);
  const hasEarlierTurns = useTranscriptResourceStore((state) => state.window?.hasEarlier === true);
  const hasLaterTurns = useTranscriptResourceStore((state) => state.window?.hasLater === true);
  const loadEarlierTranscriptResources = useTranscriptResourceStore((state) => state.loadEarlierTranscriptResources);
  const loadLaterTranscriptResources = useTranscriptResourceStore((state) => state.loadLaterTranscriptResources);
  const focusTranscriptTurn = useTranscriptResourceStore((state) => state.focusTranscriptTurn);
  const turnsById = useTranscriptLayoutStore((state) => state.turnsById);
  const openWorkByKey = useTranscriptLayoutStore((state) => state.disclosure.openWorkByKey);
  const setTranscriptWidth = useTranscriptLayoutStore((state) => state.setWidth);
  const activeTurnIds = useTranscriptViewportStore((state) => state.activeTurnIds);
  const autoScrollMode = useTranscriptViewportStore((state) => state.autoScrollMode);
  const setActiveTurnIds = useTranscriptViewportStore((state) => state.setActiveTurnIds);
  const setAutoScrollMode = useTranscriptViewportStore((state) => state.setAutoScrollMode);
  const setScrollAvailability = useTranscriptViewportStore((state) => state.setScrollAvailability);
  const setScrollNavigationController = useTranscriptViewportStore((state) => state.setScrollNavigationController);
  const viewportLifecycleState = useTranscriptViewportStore((state) => state.lifecycleState);
  const requestedTurnScroll = useTranscriptViewportStore((state) => state.requestedTurnScroll);
  const turnScrollError = useTranscriptViewportStore((state) => state.turnScrollError);
  const clearTurnScroll = useTranscriptViewportStore((state) => state.clearTurnScroll);
  const failTurnScroll = useTranscriptViewportStore((state) => state.failTurnScroll);
  const requestTurnScroll = useTranscriptViewportStore((state) => state.requestTurnScroll);
  const resolveTurnScroll = useTranscriptViewportStore((state) => state.resolveTurnScroll);
  const turns = useMemo(
    () => turnOrder.map((turnId) => turnsById[turnId]).filter((turn): turn is TranscriptMeasuredTurn => Boolean(turn)),
    [turnOrder, turnsById],
  );
  const streamingTurnId = workingTurnId;
  const expandedRows = useMemo(() => Object.values(openWorkByKey), [openWorkByKey]);
  const [viewportTopPadding, setViewportTopPadding] = useState<number>(transcriptLayout.viewport.padY);
  const [anchorExtentFloorHeight, setAnchorExtentFloorHeight] = useState(0);
  const [anchorRunwayHeight, setAnchorRunwayHeight] = useState(0);
  const navigationAnchors = useMemo(
    () =>
      userMessageScrollAnchors({
        expandedRows,
        topPadding: viewportTopPadding,
        turns,
      }),
    [expandedRows, turns, viewportTopPadding],
  );
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const measureRef = useRef<HTMLDivElement | null>(null);
  const transcriptBodyRef = useRef<HTMLDivElement | null>(null);
  const anchorRunwayRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const bottomScrollRafRef = useRef<number | null>(null);
  const scrollAnimationRafRef = useRef<number | null>(null);
  const scrollAnimationReleaseRafRef = useRef<number | null>(null);
  const initialPlacementReleaseRafRef = useRef<number | null>(null);
  const scrollAnimationCompletionRef = useRef<(() => void) | null>(null);
  const activeTurnIdsRef = useRef(activeTurnIds);
  const initialScrollConversationIdRef = useRef<string | null>(null);
  const initialPlacementEpochRef = useRef(0);
  const initialPlacementPendingRef = useRef(false);
  const initialViewportIntentRef = useRef<TranscriptInitialViewportIntent | null>(null);
  const captureViewportCacheEntryRef = useRef<() => TranscriptViewportCacheEntry | null>(() => null);
  const lastScrollTopRef = useRef(0);
  const navigationAnchorsRef = useRef(navigationAnchors);
  const expandedRowsRef = useRef(expandedRows);
  const programmaticScrollRef = useRef(false);
  const scrollAnchorRef = useRef<TranscriptViewportAnchor | null>(null);
  const autoScrollModeRef = useRef<TranscriptAutoScrollMode>(autoScrollMode);
  const anchorExtentFloorHeightRef = useRef(0);
  const anchorRunwayHeightRef = useRef(0);
  const viewportResizeSettlingRef = useRef(false);
  // Segment id of the anchor that ended the last managed scroll pinned.
  const anchorPinnedSegmentIdRef = useRef<string | null>(null);
  // Historical Up/Down navigation needs a semantic cursor so sequential
  // presses remain identity-based even after the viewport lands a few pixels
  // away from the modeled row position. This is deliberately separate from
  // sent-message auto-scroll ownership: historical navigation must settle and
  // stop writing scrollTop once its animation completes.
  const navigationCursorSegmentIdRef = useRef<string | null>(null);
  const nativeScrollPhaseRef = useRef<TranscriptNativeScrollPhase>('idle');
  const userScrollArmedRef = useRef(false);
  const turnsRef = useRef(turns);
  const focusLoadRequestIdRef = useRef<number | null>(null);
  const [width, setWidth] = useState<number | null>(null);

  useEffect(() => {
    void setActiveConversationId(conversationId);
  }, [setActiveConversationId, conversationId]);

  useLayoutEffect(() => {
    navigationCursorSegmentIdRef.current = null;
  }, [conversationId]);

  useLayoutEffect(() => {
    const content = measureRef.current;
    if (!content) return;
    const lane = content.parentElement;
    if (!lane) return;

    const updateLayout = () => {
      const contentStyle = window.getComputedStyle(content);
      const laneStyle = window.getComputedStyle(lane);
      const nextWidth = resolveTranscriptContentWidth({
        contentWidth: content.getBoundingClientRect().width,
        laneBorderWidth: lane.getBoundingClientRect().width,
        lanePaddingLeft: parseCssPixels(laneStyle.paddingLeft, 0),
        lanePaddingRight: parseCssPixels(laneStyle.paddingRight, 0),
        viewportWidth: window.innerWidth,
      });
      if (nextWidth !== null) {
        setWidth((current) => current !== null && Math.abs(current - nextWidth) <= 0.5
          ? current
          : nextWidth);
      }
      const nextTopPadding = parseCssPixels(contentStyle.paddingTop, transcriptLayout.viewport.padY);
      setViewportTopPadding((current) => Math.abs(current - nextTopPadding) <= 0.5
        ? current
        : nextTopPadding);
    };

    updateLayout();
    const observer = new ResizeObserver(updateLayout);
    observer.observe(content);
    observer.observe(lane);
    window.addEventListener('resize', updateLayout);
    window.visualViewport?.addEventListener('resize', updateLayout);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updateLayout);
      window.visualViewport?.removeEventListener('resize', updateLayout);
    };
  }, [activeConversationId, conversationId, status]);

  useEffect(() => {
    if (width === null) {
      return;
    }

    void setTranscriptWidth(width);
  }, [setTranscriptWidth, width]);

  useLayoutEffect(() => {
    activeTurnIdsRef.current = activeTurnIds;
  }, [activeTurnIds]);

  useLayoutEffect(() => {
    expandedRowsRef.current = expandedRows;
  }, [expandedRows]);

  useLayoutEffect(() => {
    navigationAnchorsRef.current = navigationAnchors;
  }, [navigationAnchors]);

  useLayoutEffect(() => {
    turnsRef.current = turns;
  }, [turns]);

  const setViewportAutoScrollMode = useCallback((
    mode: TranscriptAutoScrollMode,
    _reason: TranscriptViewportModeChangeReason,
  ) => {
    const previousMode = autoScrollModeRef.current;
    autoScrollModeRef.current = mode;
    if (!sameTranscriptAutoScrollMode(previousMode, mode)) {
      setAutoScrollMode(mode);
    }
  }, [setAutoScrollMode]);

  const setAnchorRunway = useCallback((height: number) => {
    const normalized = Math.max(0, height);
    const runway = anchorRunwayRef.current;
    if (runway) runway.style.height = `${normalized}px`;
    if (Math.abs(anchorRunwayHeightRef.current - normalized) <= 1) {
      return false;
    }
    anchorRunwayHeightRef.current = normalized;
    setAnchorRunwayHeight(normalized);
    return true;
  }, []);

  const setAnchorExtentFloor = useCallback((desiredScrollTop: number | null) => {
    const viewport = viewportRef.current;
    const content = measureRef.current;
    const normalized = desiredScrollTop === null || !viewport || !content
      ? 0
      : computeAnchorExtentFloorHeight(viewport, content, desiredScrollTop);
    if (content) content.style.minHeight = normalized > 0 ? `${normalized}px` : '';
    if (Math.abs(anchorExtentFloorHeightRef.current - normalized) <= 1) {
      return false;
    }
    anchorExtentFloorHeightRef.current = normalized;
    setAnchorExtentFloorHeight(normalized);
    return true;
  }, []);

  const captureViewportAnchor = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport || viewportLifecycleState !== 'active') {
      scrollAnchorRef.current = null;
      return null;
    }
    if (initialPlacementPendingRef.current) {
      return scrollAnchorRef.current;
    }

    const anchor = captureMountedViewportAnchor(viewport) ??
      captureTranscriptViewportAnchor({
        expandedRows: expandedRowsRef.current,
        scrollTop: viewport.scrollTop,
        topPadding: viewportTopPadding,
        turns: turnsRef.current,
      });
    scrollAnchorRef.current = anchor;
    return anchor;
  }, [viewportLifecycleState, viewportTopPadding]);

  const captureViewportCacheEntry = useCallback((): TranscriptViewportCacheEntry | null => {
    const viewport = viewportRef.current;
    if (!viewport || viewportLifecycleState !== 'active') return null;

    const naturalMaxScrollTop = naturalTranscriptMaxScrollableTop(
      viewport,
      transcriptBodyRef.current,
      measureRef.current,
    );
    const mode = autoScrollModeRef.current;
    if (
      mode.type === 'bottom' ||
      (
        anchorRunwayHeightRef.current <= 1 &&
        Math.abs(viewport.scrollTop - naturalMaxScrollTop) <= bottomStickThresholdPx
      )
    ) {
      return { kind: 'bottom' };
    }
    if (mode.type === 'sent-message-anchor') {
      return {
        kind: 'user-message',
        segmentId: mode.segmentId,
        turnId: mode.turnId,
      };
    }

    const latestUserMessage = navigationAnchorsRef.current.at(-1) ?? null;
    if (latestUserMessage) {
      const desiredScrollTop = mountedUserMessageAnchorScrollTop(
        viewport,
        latestUserMessage.segmentId,
        transcriptMessageAnchorTopOffset(viewportTopPadding),
      );
      if (
        desiredScrollTop !== null &&
        Math.abs(viewport.scrollTop - desiredScrollTop) <= 2
      ) {
        return {
          kind: 'user-message',
          segmentId: latestUserMessage.segmentId,
          turnId: latestUserMessage.turnId,
        };
      }
    }

    const anchor = captureViewportAnchor();
    return anchor ? { kind: 'row-offset', anchor } : null;
  }, [captureViewportAnchor, viewportLifecycleState, viewportTopPadding]);

  useLayoutEffect(() => {
    captureViewportCacheEntryRef.current = captureViewportCacheEntry;
  }, [captureViewportCacheEntry]);

  useLayoutEffect(() => registerTranscriptViewportCapture((outgoingConversationId) => {
    const entry = captureViewportCacheEntryRef.current();
    if (entry) cacheTranscriptViewportAnchor(outgoingConversationId, entry);
  }), []);

  useLayoutEffect(() => {
    if (initialPlacementReleaseRafRef.current !== null) {
      window.cancelAnimationFrame(initialPlacementReleaseRafRef.current);
      initialPlacementReleaseRafRef.current = null;
    }
    initialPlacementEpochRef.current += 1;
    initialPlacementPendingRef.current = false;
    const cachedEntry = cachedTranscriptViewportAnchor(conversationId);
    const cachedAnchor = cachedEntry?.kind === 'row-offset' ? cachedEntry.anchor : null;
    scrollAnchorRef.current = cachedAnchor;
    initialViewportIntentRef.current = cachedEntry?.kind === 'bottom' || cachedEntry?.kind === 'user-message'
      ? cachedEntry
      : null;
    if (cachedAnchor) initialScrollConversationIdRef.current = conversationId;
    return () => {
      if (initialPlacementReleaseRafRef.current !== null) {
        window.cancelAnimationFrame(initialPlacementReleaseRafRef.current);
        initialPlacementReleaseRafRef.current = null;
      }
      initialPlacementEpochRef.current += 1;
      initialPlacementPendingRef.current = false;
      // setActiveConversationId captures synchronously before clearing the old
      // layout. Once the resource store points elsewhere, this cleanup sees the
      // replacement DOM and must not overwrite that accurate outgoing anchor.
      if (getTranscriptResourceState().activeConversationId !== conversationId) return;
      const entry = captureViewportCacheEntryRef.current();
      if (!entry) return;
      cacheTranscriptViewportAnchor(conversationId, entry);
    };
  }, [conversationId]);

  const scheduleRangeUpdate = useCallback(() => {
    if (rafRef.current !== null) {
      return;
    }

    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = null;

      const viewport = viewportRef.current;
      const measuredTurns = turnsRef.current;
      if (!viewport || measuredTurns.length === 0) {
        setScrollAvailability({ canScrollDown: false, canScrollUp: false });
        return;
      }

      const range = computeTranscriptVirtualRange({
        expandedRows: expandedRowsRef.current,
        scrollTop: viewport.scrollTop,
        topPadding: viewportTopPadding,
        turns: measuredTurns,
        viewportHeight: viewport.clientHeight,
      });
      const nextActiveTurnIds = range.activeTurnIds;

      captureViewportAnchor();
      setScrollAvailability(scrollNavigationAvailability(
        viewport,
        navigationAnchorsRef.current,
        autoScrollModeRef.current,
        naturalTranscriptMaxScrollableTop(viewport, transcriptBodyRef.current, measureRef.current),
        anchorRunwayHeightRef.current,
        navigationCursorSegmentIdRef.current,
      ));

      if (sameTurnIds(activeTurnIdsRef.current, nextActiveTurnIds)) {
        return;
      }

      activeTurnIdsRef.current = nextActiveTurnIds;
      setActiveTurnIds(nextActiveTurnIds);
    });
  }, [
    captureViewportAnchor,
    setActiveTurnIds,
    setScrollAvailability,
    viewportTopPadding,
  ]);

  const applyManagedScroll = useCallback(() => {
    const viewport = viewportRef.current;
    const mode = autoScrollModeRef.current;
    if (!viewport || viewportLifecycleState !== 'active') {
      return;
    }

    // Manual viewport ownership prevents content growth from moving the transcript.
    if (mode.type === 'off') {
      anchorPinnedSegmentIdRef.current = null;
      setAnchorExtentFloor(null);
      setAnchorRunway(0);
      return;
    }
    if (nativeScrollOwnsTranscriptViewport(nativeScrollPhaseRef.current)) {
      return;
    }
    if (scrollAnimationRafRef.current !== null) {
      return;
    }

    const naturalMaxScrollTop = naturalTranscriptMaxScrollableTop(
      viewport,
      transcriptBodyRef.current,
      measureRef.current,
    );
    let targetScrollTop = naturalMaxScrollTop;
    let nextAnchorExtentFloor: number | null = null;
    let nextRunwayHeight = 0;

    if (mode.type === 'sent-message-anchor') {
      const measuredDesiredScrollTop = anchorUserMessageScrollTop({
        expandedRows: expandedRowsRef.current,
        segmentId: mode.segmentId,
        topPadding: viewportTopPadding,
        turnId: mode.turnId,
        turns: turnsRef.current,
      });
      const desiredScrollTop = mountedUserMessageAnchorScrollTop(
        viewport,
        mode.segmentId,
        transcriptMessageAnchorTopOffset(viewportTopPadding),
      ) ?? measuredDesiredScrollTop;
      if (desiredScrollTop === null && mode.phase !== 'catching-up') {
        return;
      }
      if (desiredScrollTop === null) {
        // The anchor row is not measured yet — a fork or new thread whose
        // turn has not reached the transcript. Catching-up follows the
        // bottom until the message can be anchored; the anchored phase keeps
        // its early return so a pinned view is never yanked by a transiently
        // missing row.
        anchorPinnedSegmentIdRef.current = null;
      } else {
        const resolution = resolveSentMessageScroll({
          anchorActivationAllowed: !viewportResizeSettlingRef.current,
          currentScrollTop: viewport.scrollTop,
          desiredScrollTop,
          naturalMaxScrollTop,
          phase: mode.phase,
          runwayHeight: anchorRunwayHeightRef.current,
          wasPinned: anchorPinnedSegmentIdRef.current === mode.segmentId,
        });
        anchorPinnedSegmentIdRef.current = resolution.phase === 'anchored' ? mode.segmentId : null;
        targetScrollTop = resolution.scrollTop;
        nextAnchorExtentFloor = resolution.phase === 'anchored' ? desiredScrollTop : null;
        nextRunwayHeight = resolution.runwayHeight;
        if (resolution.phase !== mode.phase) {
          setViewportAutoScrollMode({ ...mode, phase: resolution.phase }, 'mount-stickiness');
        }
      }
    } else {
      anchorPinnedSegmentIdRef.current = null;
    }

    // Keep the anchored scroll range valid continuously. A runway calculated
    // by ResizeObserver is still one layout too late when content shrinks:
    // the browser can clamp scrollTop before the observer repairs it. The
    // extent floor exists before that shrink and prevents the clamp entirely.
    setAnchorExtentFloor(nextAnchorExtentFloor);
    setAnchorRunway(nextRunwayHeight);
    const reachableTarget = Math.min(
      targetScrollTop,
      naturalMaxScrollTop + anchorRunwayHeightRef.current,
    );
    if (Math.abs(reachableTarget - viewport.scrollTop) > 1) {
      programmaticScrollRef.current = true;
      viewport.scrollTop = reachableTarget;
      lastScrollTopRef.current = viewport.scrollTop;
      scheduleRangeUpdate();
    }

    window.requestAnimationFrame(() => {
      programmaticScrollRef.current = false;
    });
  }, [
    scheduleRangeUpdate,
    setAnchorExtentFloor,
    setAnchorRunway,
    setViewportAutoScrollMode,
    viewportLifecycleState,
    viewportTopPadding,
  ]);

  const scheduleAutoScroll = useCallback(() => {
    if (
      bottomScrollRafRef.current !== null ||
      nativeScrollOwnsTranscriptViewport(nativeScrollPhaseRef.current)
    ) {
      return;
    }
    bottomScrollRafRef.current = window.requestAnimationFrame(() => {
      bottomScrollRafRef.current = null;
      applyManagedScroll();
    });
  }, [applyManagedScroll]);

  useLayoutEffect(() => {
    const transcriptBody = transcriptBodyRef.current;
    if (!transcriptBody) return;

    const observer = new ResizeObserver(() => {
      scheduleRangeUpdate();
      if (
        autoScrollModeRef.current.type !== 'off' &&
        !nativeScrollOwnsTranscriptViewport(nativeScrollPhaseRef.current)
      ) {
        // ResizeObserver runs before paint. Correct the managed position here
        // so streamed growth or work collapse never exposes a stale frame.
        applyManagedScroll();
      }
    });
    observer.observe(transcriptBody);
    return () => observer.disconnect();
  }, [applyManagedScroll, scheduleRangeUpdate]);

  useLayoutEffect(() => {
    autoScrollModeRef.current = autoScrollMode;
    if (autoScrollMode.type !== 'off') {
      scheduleAutoScroll();
    }
  }, [autoScrollMode, scheduleAutoScroll]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    // Composer lift (keyboard) resizes the viewport; managed modes must react
    // immediately — bottom stickiness re-pins, and a sent-message anchor that
    // was only satisfiable in a shrunken viewport releases its pin instead of
    // materializing runway once the viewport grows back.
    let observedHeight = viewport.clientHeight;
    let settleRaf: number | null = null;
    let finalizeRaf: number | null = null;
    const clearSettleFrames = () => {
      if (settleRaf !== null) window.cancelAnimationFrame(settleRaf);
      if (finalizeRaf !== null) window.cancelAnimationFrame(finalizeRaf);
      settleRaf = null;
      finalizeRaf = null;
    };
    const observer = new ResizeObserver(() => {
      const nextHeight = viewport.clientHeight;
      if (Math.abs(nextHeight - observedHeight) > 1) {
        observedHeight = nextHeight;
        viewportResizeSettlingRef.current = true;
        clearSettleFrames();
        settleRaf = window.requestAnimationFrame(() => {
          settleRaf = null;
          finalizeRaf = window.requestAnimationFrame(() => {
            finalizeRaf = null;
            viewportResizeSettlingRef.current = false;
            scheduleAutoScroll();
          });
        });
      }
      if (autoScrollModeRef.current.type !== 'off') {
        scheduleAutoScroll();
      }
    });
    observer.observe(viewport);
    return () => {
      observer.disconnect();
      clearSettleFrames();
      viewportResizeSettlingRef.current = false;
    };
  }, [scheduleAutoScroll]);

  const cancelScrollAnimation = useCallback(() => {
    if (scrollAnimationRafRef.current !== null) {
      window.cancelAnimationFrame(scrollAnimationRafRef.current);
      scrollAnimationRafRef.current = null;
    }
    if (scrollAnimationReleaseRafRef.current !== null) {
      window.cancelAnimationFrame(scrollAnimationReleaseRafRef.current);
      scrollAnimationReleaseRafRef.current = null;
    }
    programmaticScrollRef.current = false;
    const completion = scrollAnimationCompletionRef.current;
    scrollAnimationCompletionRef.current = null;
    completion?.();
  }, []);

  const releaseProgrammaticScroll = useCallback((onReleased: () => void) => {
    if (scrollAnimationReleaseRafRef.current !== null) {
      window.cancelAnimationFrame(scrollAnimationReleaseRafRef.current);
    }
    // scheduleRangeUpdate publishes a new virtual range on the next frame.
    // Retain ownership through that React commit so viewport-anchor restoration
    // cannot reinterpret the navigation animation as a content-layout shift.
    scrollAnimationReleaseRafRef.current = window.requestAnimationFrame(() => {
      scrollAnimationReleaseRafRef.current = window.requestAnimationFrame(() => {
        scrollAnimationReleaseRafRef.current = null;
        programmaticScrollRef.current = false;
        onReleased();
      });
    });
  }, []);

  const releaseInitialPlacement = useCallback((placementEpoch: number, onReleased: () => void) => {
    if (initialPlacementReleaseRafRef.current !== null) {
      window.cancelAnimationFrame(initialPlacementReleaseRafRef.current);
    }
    // Initial placement also publishes a new virtual range. Keep it distinct
    // from navigation animation ownership so an event-listener refresh cannot
    // cancel the release and leave anchor capture suppressed indefinitely.
    initialPlacementReleaseRafRef.current = window.requestAnimationFrame(() => {
      initialPlacementReleaseRafRef.current = window.requestAnimationFrame(() => {
        initialPlacementReleaseRafRef.current = null;
        if (initialPlacementEpochRef.current !== placementEpoch) return;
        initialPlacementPendingRef.current = false;
        programmaticScrollRef.current = false;
        onReleased();
      });
    });
  }, []);

  const scrollToPosition = useCallback((
    scrollTop: number,
    nextAutoScrollMode: TranscriptAutoScrollMode,
    reason: TranscriptViewportModeChangeReason,
    animated = true,
    onSettled?: () => void,
  ) => {
    const viewport = viewportRef.current;
    if (!viewport) {
      onSettled?.();
      return;
    }

    cancelScrollAnimation();
    const completion = () => onSettled?.();
    scrollAnimationCompletionRef.current = completion;
    const settle = () => {
      if (scrollAnimationCompletionRef.current !== completion) return;
      scrollAnimationCompletionRef.current = null;
      completion();
      if (nextAutoScrollMode.type !== 'off') scheduleAutoScroll();
    };

    if (bottomScrollRafRef.current !== null) {
      window.cancelAnimationFrame(bottomScrollRafRef.current);
      bottomScrollRafRef.current = null;
    }

    const startScrollTop = viewport.scrollTop;
    const maxScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    const targetScrollTop = Math.max(0, Math.min(scrollTop, maxScrollTop));

    setViewportAutoScrollMode(nextAutoScrollMode, reason);
    programmaticScrollRef.current = true;

    if (Math.abs(targetScrollTop - startScrollTop) <= 1) {
      viewport.scrollTop = targetScrollTop;
      lastScrollTopRef.current = viewport.scrollTop;
      scheduleRangeUpdate();
      releaseProgrammaticScroll(settle);
      return;
    }

    if (!animated) {
      viewport.scrollTop = targetScrollTop;
      lastScrollTopRef.current = viewport.scrollTop;
      scheduleRangeUpdate();
      releaseProgrammaticScroll(settle);
      return;
    }

    const startedAt = performance.now();
    const step = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / scrollNavigationDurationMs);
      const eased = 1 - Math.pow(1 - progress, 3);
      viewport.scrollTop = startScrollTop + (targetScrollTop - startScrollTop) * eased;
      lastScrollTopRef.current = viewport.scrollTop;
      scheduleRangeUpdate();

      if (progress < 1) {
        scrollAnimationRafRef.current = window.requestAnimationFrame(step);
        return;
      }

      scrollAnimationRafRef.current = null;
      releaseProgrammaticScroll(settle);
    };

    scrollAnimationRafRef.current = window.requestAnimationFrame(step);
  }, [
    cancelScrollAnimation,
    releaseProgrammaticScroll,
    scheduleAutoScroll,
    scheduleRangeUpdate,
    setViewportAutoScrollMode,
  ]);

  const scrollToMessageAnchor = useCallback((anchor: TranscriptScrollAnchor) => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    navigationCursorSegmentIdRef.current = anchor.segmentId;
    const desiredScrollTop = mountedUserMessageAnchorScrollTop(
      viewport,
      anchor.segmentId,
      transcriptMessageAnchorTopOffset(viewportTopPadding),
    ) ?? anchor.scrollTop;
    const targetsStreamingTurn = anchor.turnId === streamingTurnId;
    const naturalMaxScrollTop = naturalTranscriptMaxScrollableTop(
      viewport,
      transcriptBodyRef.current,
      measureRef.current,
    );
    if (targetsStreamingTurn) {
      // Only a live turn needs continuing viewport ownership. Its runway keeps
      // the sent user message pinned while content below it is still growing.
      setAnchorExtentFloor(desiredScrollTop);
      setAnchorRunway(Math.max(0, desiredScrollTop - naturalMaxScrollTop));
    } else {
      setAnchorExtentFloor(null);
      setAnchorRunway(0);
    }
    scrollToPosition(
      desiredScrollTop,
      targetsStreamingTurn
        ? {
            phase: 'anchored',
            segmentId: anchor.segmentId,
            conversationId: activeConversationId ?? '',
            type: 'sent-message-anchor',
            turnId: anchor.turnId,
          }
        : { type: 'off' },
      'scroll-navigation',
    );
  }, [
    activeConversationId,
    scrollToPosition,
    setAnchorExtentFloor,
    setAnchorRunway,
    streamingTurnId,
    viewportTopPadding,
  ]);

  const scrollUp = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    const mode = autoScrollModeRef.current;
    const anchor = previousUserMessageScrollAnchor({
      anchors: navigationAnchorsRef.current,
      atBottom: mode.type === 'bottom' && isNearBottom(viewport),
      currentSegmentId: mode.type === 'sent-message-anchor'
        ? mode.segmentId
        : navigationCursorSegmentIdRef.current,
      scrollTop: viewport.scrollTop,
      threshold: scrollNavigationThresholdPx,
    });
    if (!anchor) {
      return;
    }

    scrollToMessageAnchor(anchor);
  }, [scrollToMessageAnchor]);

  const scrollDown = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    const mode = autoScrollModeRef.current;
    const naturalMaxScrollTop = naturalTranscriptMaxScrollableTop(
      viewport,
      transcriptBodyRef.current,
      measureRef.current,
    );
    const anchor = nextUserMessageScrollAnchor({
      anchors: navigationAnchorsRef.current,
      atBottom: mode.type === 'bottom' && isNearBottom(viewport),
      currentSegmentId: mode.type === 'sent-message-anchor'
        ? mode.segmentId
        : navigationCursorSegmentIdRef.current,
      maxScrollTop: naturalMaxScrollTop,
      scrollTop: viewport.scrollTop,
      threshold: scrollNavigationThresholdPx,
    });
    if (anchor) {
      scrollToMessageAnchor(anchor);
      return;
    }

    // No later user row can reach the normal anchor offset. The remaining
    // destination is the transcript's real bottom, not a synthetic runway
    // that lifts an already-visible tail row to the top.
    navigationCursorSegmentIdRef.current = null;
    setAnchorExtentFloor(null);
    setAnchorRunway(0);
    scrollToPosition(naturalMaxScrollTop, { type: 'bottom' }, 'scroll-navigation-bottom');
  }, [scrollToMessageAnchor, scrollToPosition, setAnchorExtentFloor, setAnchorRunway]);

  useEffect(() => {
    setScrollNavigationController({ scrollDown, scrollUp });
    return () => setScrollNavigationController(null);
  }, [scrollDown, scrollUp, setScrollNavigationController]);

  useEffect(() => {
    if (
      !requestedTurnScroll ||
      requestedTurnScroll.conversationId !== activeConversationId ||
      turnScrollError?.requestId === requestedTurnScroll.id ||
      status !== 'ready' ||
      turns.some((turn) => turn.turnId === requestedTurnScroll.turnId) ||
      focusLoadRequestIdRef.current === requestedTurnScroll.id
    ) return;

    focusLoadRequestIdRef.current = requestedTurnScroll.id;
    void focusTranscriptTurn(requestedTurnScroll.turnId).then((found) => {
      if (!found) failTurnScroll(requestedTurnScroll.id, 'The requested turn could not be loaded.');
    }).catch(() => {
      failTurnScroll(requestedTurnScroll.id, 'The requested turn could not be loaded.');
    }).finally(() => {
      if (focusLoadRequestIdRef.current === requestedTurnScroll.id) focusLoadRequestIdRef.current = null;
    });
  }, [
    activeConversationId,
    failTurnScroll,
    focusTranscriptTurn,
    requestedTurnScroll,
    status,
    turnScrollError,
    turns,
  ]);

  useLayoutEffect(() => {
    if (
      !requestedTurnScroll ||
      requestedTurnScroll.conversationId !== activeConversationId ||
      status !== 'ready' ||
      width === null
    ) return;
    const desiredScrollTop = anchorTurnUserMessageScrollTop({
      expandedRows,
      topPadding: viewportTopPadding,
      turns,
      turnId: requestedTurnScroll.turnId,
    });
    if (desiredScrollTop === null) return;
    navigationCursorSegmentIdRef.current = null;
    scrollToPosition(desiredScrollTop, { type: 'off' }, 'host-navigate', false, () => {
      resolveTurnScroll(requestedTurnScroll.id);
    });
  }, [
    activeConversationId,
    expandedRows,
    requestedTurnScroll,
    resolveTurnScroll,
    scrollToPosition,
    status,
    turns,
    viewportTopPadding,
    width,
  ]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    const updateScrollPosition = () => {
      const currentScrollTop = viewport.scrollTop;
      lastScrollTopRef.current = currentScrollTop;
    };

    let scrollSettleTimer: number | null = null;
    const clearScrollSettleTimer = () => {
      if (scrollSettleTimer === null) {
        return;
      }
      window.clearTimeout(scrollSettleTimer);
      scrollSettleTimer = null;
    };
    const finishUserScroll = () => {
      clearScrollSettleTimer();
      const userInitiated = userScrollArmedRef.current && !programmaticScrollRef.current;
      userScrollArmedRef.current = false;
      if (nativeScrollPhaseRef.current === 'momentum') {
        nativeScrollPhaseRef.current = transcriptNativeScrollPhaseAfterEvent(
          nativeScrollPhaseRef.current,
          'settle',
        );
      }
      lastScrollTopRef.current = viewport.scrollTop;
      captureViewportAnchor();
      scheduleRangeUpdate();

      if (userInitiated) {
        if (viewport.scrollTop <= 96 && hasEarlierTurns) {
          void loadEarlierTranscriptResources();
        } else if (distanceFromBottom(viewport) <= 96 && hasLaterTurns) {
          void loadLaterTranscriptResources();
        }
      }

      if (!userInitiated) {
        return;
      }
      const mode = autoScrollModeAfterNativeScrollSettles({
        currentMode: autoScrollModeRef.current,
        nearBottom: isNearBottom(viewport),
        userInitiated,
      });
      setViewportAutoScrollMode(mode, 'scroll-settled');
      if (mode.type !== 'off') scheduleAutoScroll();
    };
    const scheduleUserScrollSettleFallback = () => {
      clearScrollSettleTimer();
      scrollSettleTimer = window.setTimeout(finishUserScroll, touchScrollSettleDelayMs);
    };
    const onScroll = () => {
      updateScrollPosition();
      scheduleRangeUpdate();
      if (nativeScrollPhaseRef.current === 'momentum') {
        scheduleUserScrollSettleFallback();
      }
    };
    const onTouchStart = () => {
      clearScrollSettleTimer();
      userScrollArmedRef.current = true;
      navigationCursorSegmentIdRef.current = null;
      cancelScrollAnimation();
      if (bottomScrollRafRef.current !== null) {
        window.cancelAnimationFrame(bottomScrollRafRef.current);
        bottomScrollRafRef.current = null;
      }
      nativeScrollPhaseRef.current = transcriptNativeScrollPhaseAfterEvent(
        nativeScrollPhaseRef.current,
        'touch-start',
      );
      setViewportAutoScrollMode({ type: 'off' }, 'touch-start');
    };
    const onWheel = () => {
      navigationCursorSegmentIdRef.current = null;
      cancelScrollAnimation();
      userScrollArmedRef.current = true;
      setViewportAutoScrollMode({ type: 'off' }, 'manual-scroll');
      scheduleUserScrollSettleFallback();
    };
    const onTouchEnd = () => {
      nativeScrollPhaseRef.current = transcriptNativeScrollPhaseAfterEvent(
        nativeScrollPhaseRef.current,
        'touch-end',
      );
      scheduleUserScrollSettleFallback();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') {
        clearScrollSettleTimer();
        userScrollArmedRef.current = false;
        nativeScrollPhaseRef.current = 'idle';
        cancelScrollAnimation();
        return;
      }
      lastScrollTopRef.current = viewport.scrollTop;
      captureViewportAnchor();
      scheduleRangeUpdate();
      if (autoScrollModeRef.current.type !== 'off') {
        scheduleAutoScroll();
      }
    };
    const observer = new ResizeObserver(scheduleRangeUpdate);

    viewport.addEventListener('scroll', onScroll, { passive: true });
    viewport.addEventListener('touchstart', onTouchStart, { passive: true });
    viewport.addEventListener('touchcancel', onTouchEnd, { passive: true });
    viewport.addEventListener('touchend', onTouchEnd, { passive: true });
    viewport.addEventListener('wheel', onWheel, { passive: true });
    viewport.addEventListener('scrollend', finishUserScroll, { passive: true });
    document.addEventListener('visibilitychange', onVisibilityChange);
    observer.observe(viewport);
    lastScrollTopRef.current = viewport.scrollTop;
    if (autoScrollModeRef.current.type === 'off') {
      setViewportAutoScrollMode(isNearBottom(viewport) ? { type: 'bottom' } : { type: 'off' }, 'mount-stickiness');
    }
    scheduleRangeUpdate();

    return () => {
      viewport.removeEventListener('scroll', onScroll);
      viewport.removeEventListener('touchstart', onTouchStart);
      viewport.removeEventListener('touchcancel', onTouchEnd);
      viewport.removeEventListener('touchend', onTouchEnd);
      viewport.removeEventListener('wheel', onWheel);
      viewport.removeEventListener('scrollend', finishUserScroll);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      clearScrollSettleTimer();
      nativeScrollPhaseRef.current = 'idle';
      observer.disconnect();
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      if (bottomScrollRafRef.current !== null) {
        window.cancelAnimationFrame(bottomScrollRafRef.current);
        bottomScrollRafRef.current = null;
      }
      cancelScrollAnimation();
    };
  }, [
    cancelScrollAnimation,
    captureViewportAnchor,
    hasEarlierTurns,
    hasLaterTurns,
    loadEarlierTranscriptResources,
    loadLaterTranscriptResources,
    scheduleAutoScroll,
    scheduleRangeUpdate,
    setViewportAutoScrollMode,
  ]);

  useEffect(() => {
    if (viewportLifecycleState !== 'active') {
      userScrollArmedRef.current = false;
      nativeScrollPhaseRef.current = 'idle';
      cancelScrollAnimation();
      if (bottomScrollRafRef.current !== null) {
        window.cancelAnimationFrame(bottomScrollRafRef.current);
        bottomScrollRafRef.current = null;
      }
      return;
    }

    lastScrollTopRef.current = viewportRef.current?.scrollTop ?? 0;
    captureViewportAnchor();
    scheduleRangeUpdate();
    if (autoScrollModeRef.current.type !== 'off') {
      scheduleAutoScroll();
    }
  }, [
    cancelScrollAnimation,
    captureViewportAnchor,
    scheduleAutoScroll,
    scheduleRangeUpdate,
    viewportLifecycleState,
  ]);

  useEffect(() => {
    scheduleRangeUpdate();
  }, [expandedRows, scheduleRangeUpdate, turns, width]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (status !== 'ready' || width === null || !viewport) {
      return;
    }

    if (
      initialPlacementPendingRef.current ||
      autoScrollModeRef.current.type !== 'off' ||
      nativeScrollOwnsTranscriptViewport(nativeScrollPhaseRef.current) ||
      programmaticScrollRef.current
    ) {
      captureViewportAnchor();
      return;
    }

    const anchor = scrollAnchorRef.current;
    if (!anchor) {
      captureViewportAnchor();
      return;
    }

    const restoredScrollTop = scrollTopForMountedViewportAnchor(viewport, anchor) ??
      scrollTopForViewportAnchor({
        anchor,
        expandedRows,
        topPadding: viewportTopPadding,
        turns,
      });
    if (restoredScrollTop === null) {
      captureViewportAnchor();
      return;
    }

    const targetScrollTop = Math.max(0, Math.min(restoredScrollTop, maxScrollableTop(viewport)));
    if (Math.abs(targetScrollTop - viewport.scrollTop) <= 1) {
      captureViewportAnchor();
      return;
    }

    programmaticScrollRef.current = true;
    viewport.scrollTop = targetScrollTop;
    lastScrollTopRef.current = viewport.scrollTop;
    captureViewportAnchor();
    scheduleRangeUpdate();

    window.requestAnimationFrame(() => {
      programmaticScrollRef.current = false;
    });
  }, [captureViewportAnchor, expandedRows, scheduleRangeUpdate, status, turns, viewportTopPadding, width]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (nativeScrollOwnsTranscriptViewport(nativeScrollPhaseRef.current)) {
      return;
    }

    if (!viewport) {
      return;
    }

    const mode = autoScrollModeForStreamingTurn({
      currentMode: autoScrollModeRef.current,
      nearBottom: isNearBottom(viewport),
      streamingTurnId,
    });
    setViewportAutoScrollMode(mode, 'streaming-turn');
    if (mode.type !== 'off') {
      scheduleAutoScroll();
    }
  }, [scheduleAutoScroll, setViewportAutoScrollMode, streamingTurnId]);

  useLayoutEffect(() => {
    if (
      status !== 'ready' ||
      width === null
    ) {
      return;
    }

    applyManagedScroll();
  }, [anchorRunwayHeight, applyManagedScroll, autoScrollMode, expandedRows, status, turns, width]);

  const validActiveTurnIds = activeTurnIds.filter((turnId) => Boolean(turnsById[turnId]));
  const sentAnchorNeedsMaterialization =
    autoScrollMode.type === 'sent-message-anchor' &&
    Boolean(turnsById[autoScrollMode.turnId]) &&
    !validActiveTurnIds.includes(autoScrollMode.turnId);
  // An appended turn is outside the mounted virtual range until scrolling
  // discovers it. Materialize the authoritative tail as soon as the sent turn
  // commits so the scroll target and message exist in the same React render.
  // The next range calculation replaces this bootstrap range with the normal
  // viewport-derived window.
  const renderTurnIds = sentAnchorNeedsMaterialization
    ? initialTranscriptActiveTurnIds(turns)
    : validActiveTurnIds.length > 0
      ? validActiveTurnIds
      : initialTranscriptActiveTurnIds(turns);
  const renderTurns = renderTurnIds
    .map((turnId) => turnsById[turnId])
    .filter((turn): turn is TranscriptMeasuredTurn => Boolean(turn));
  const spacerRange = computeTranscriptSpacerRange({
    activeTurnIds: renderTurnIds,
    expandedRows,
    turns,
  });

  useLayoutEffect(() => {
    if (status !== 'ready' || !activeConversationId || width === null) {
      return;
    }

    if (initialScrollConversationIdRef.current === activeConversationId) {
      return;
    }

    if (requestedTurnScroll?.conversationId === activeConversationId) {
      // A route-addressed turn is the authoritative initial position. Mark the
      // ordinary on-load placement consumed so it cannot race the focus scroll
      // and snap the viewport back to the tail after the target is measured.
      initialScrollConversationIdRef.current = activeConversationId;
      initialViewportIntentRef.current = null;
      return;
    }


    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    initialScrollConversationIdRef.current = activeConversationId;
    const currentMode = autoScrollModeRef.current;
    if (currentMode.type === 'sent-message-anchor' && currentMode.conversationId === activeConversationId) {
      // A send intent (fork, new thread) predates this mount and the on-load
      // heuristic must not clobber it: the anchor row may not even be in the
      // transcript yet. Start at the bottom and let the managed scroll own
      // positioning from here.
      const placementEpoch = ++initialPlacementEpochRef.current;
      initialPlacementPendingRef.current = true;
      initialViewportIntentRef.current = null;
      programmaticScrollRef.current = true;
      viewport.scrollTop = maxScrollableTop(viewport);
      lastScrollTopRef.current = viewport.scrollTop;
      releaseInitialPlacement(placementEpoch, () => {
        captureViewportAnchor();
        scheduleRangeUpdate();
        scheduleAutoScroll();
      });
      scheduleRangeUpdate();
      scheduleAutoScroll();
      return;
    }
    const modeledInitialTarget = initialTranscriptScrollTarget({
      anchors: navigationAnchors,
      conversationId: activeConversationId,
      streamingTurnId,
    });
    // The layout model identifies the semantic destination, but its pixel
    // position is provisional. Resolve completed transcripts from the mounted
    // user row and the matching live content extent so markdown, attachments,
    // and font wrapping cannot put the two sides of this comparison in
    // different coordinate systems.
    const cachedIntent = initialViewportIntentRef.current;
    const streamingSegmentId = modeledInitialTarget?.mode.type === 'sent-message-anchor'
      ? modeledInitialTarget.mode.segmentId
      : null;
    const streamingAnchor = streamingSegmentId
      ? navigationAnchors.find((anchor) => anchor.segmentId === streamingSegmentId) ?? null
      : null;
    const cachedMessage = cachedIntent?.kind === 'user-message' ? cachedIntent : null;
    const cachedAnchor = cachedMessage
      ? navigationAnchors.find((anchor) =>
          anchor.segmentId === cachedMessage.segmentId && anchor.turnId === cachedMessage.turnId) ?? null
      : null;
    const latestAnchor = navigationAnchors.at(-1) ?? null;
    const targetAnchor = streamingAnchor ?? cachedAnchor ?? latestAnchor;
    const mountedDesiredScrollTop = targetAnchor
      ? mountedUserMessageAnchorScrollTop(
          viewport,
          targetAnchor.segmentId,
          transcriptMessageAnchorTopOffset(viewportTopPadding),
        )
      : null;
    const liveInitialTarget = cachedIntent?.kind === 'bottom'
      ? null
      : mountedDesiredScrollTop !== null
        ? {
            mode: modeledInitialTarget?.mode.type === 'sent-message-anchor'
              ? modeledInitialTarget.mode
              : { type: 'off' as const },
            scrollTop: mountedDesiredScrollTop,
          }
        : modeledInitialTarget?.mode.type === 'sent-message-anchor'
          ? modeledInitialTarget
          : null;
    const naturalMaxScrollTop = naturalTranscriptMaxScrollableTop(
      viewport,
      transcriptBodyRef.current,
      measureRef.current,
    );
    const resolvedInitialTarget = resolveInitialTranscriptScrollTarget({
      maxScrollTop: naturalMaxScrollTop,
      target: liveInitialTarget,
    });
    const placementEpoch = ++initialPlacementEpochRef.current;
    initialPlacementPendingRef.current = true;
    initialViewportIntentRef.current = null;
    setViewportAutoScrollMode(resolvedInitialTarget.mode, 'initial-scroll');
    programmaticScrollRef.current = true;
    viewport.scrollTop = resolvedInitialTarget.scrollTop;
    lastScrollTopRef.current = viewport.scrollTop;
    releaseInitialPlacement(placementEpoch, () => {
      captureViewportAnchor();
      scheduleRangeUpdate();
      if (resolvedInitialTarget.mode.type !== 'off') scheduleAutoScroll();
    });
    scheduleRangeUpdate();
  }, [
    activeConversationId,
    captureViewportAnchor,
    navigationAnchors,
    releaseInitialPlacement,
    requestedTurnScroll,
    scheduleAutoScroll,
    scheduleRangeUpdate,
    setViewportAutoScrollMode,
    status,
    streamingTurnId,
    viewportTopPadding,
    width,
  ]);

  return (
    <div
      className="remux-transcript-viewport h-full min-h-0 flex-1 overflow-y-auto overflow-x-hidden bg-background"
      data-testid="agent-transcript-scroll"
      ref={viewportRef}
    >
      <div className="codex-transcript-lane mx-auto min-h-full w-full min-w-0 max-w-[var(--remux-feed-max-width)] px-[var(--remux-feed-pad-x)]">
        <div
          className="codex-transcript-content relative flex min-w-0 max-w-full flex-col"
          data-layout-width={width ?? undefined}
          data-testid="agent-transcript-content"
          ref={measureRef}
          style={{
            minHeight: anchorExtentFloorHeight > 0 ? `${anchorExtentFloorHeight}px` : undefined,
            paddingBottom: `${transcriptLayout.viewport.padY}px`,
            paddingTop: `max(${transcriptLayout.viewport.padY}px, env(safe-area-inset-top), var(--remux-safe-area-top, 0px))`,
          }}
        >
          {turnScrollError && requestedTurnScroll ? (
            <div className="agent-transcript-focus-error" role="alert">
              <span>{turnScrollError.message}</span>
              <button
                onClick={() => requestTurnScroll(conversationId, requestedTurnScroll.turnId)}
                type="button"
              >
                <RotateCcw className="size-3" /> Retry
              </button>
              <button
                aria-label="Dismiss turn focus error"
                onClick={() => clearTurnScroll(requestedTurnScroll.id)}
                type="button"
              >
                <X className="size-3.5" />
              </button>
            </div>
          ) : null}
          {status === 'failed' ? (
            <button
              className="agent-transcript-retry"
              onClick={() => void refreshTranscript({ forceFullMeasure: true })}
              type="button"
            >
              <RotateCcw className="size-3" /> {error ?? 'Retry transcript'}
            </button>
          ) : null}
          <div
            data-testid="agent-transcript-body"
            ref={transcriptBodyRef}
            style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}
          >
            {width === null ? null : (
              <VirtualizedTranscriptBody
                bottomSpacerHeight={spacerRange.bottomSpacerHeight}
                conversationId={activeConversationId}
                status={status}
                topSpacerHeight={spacerRange.topSpacerHeight}
                totalTurnCount={turns.length}
                turns={renderTurns}
                width={width}
              />
            )}
          </div>
          <div
            aria-hidden="true"
            data-testid="agent-transcript-anchor-runway"
            ref={anchorRunwayRef}
            style={{ height: `${anchorRunwayHeight}px` }}
          />
        </div>
      </div>
    </div>
  );
}

function distanceFromBottom(node: HTMLElement) {
  return Math.max(0, node.scrollHeight - node.clientHeight - node.scrollTop);
}

function isNearBottom(node: HTMLElement) {
  return distanceFromBottom(node) <= bottomStickThresholdPx;
}

function sameTranscriptAutoScrollMode(left: TranscriptAutoScrollMode, right: TranscriptAutoScrollMode) {
  return left.type === right.type && (
    left.type !== 'sent-message-anchor' ||
    (
      right.type === 'sent-message-anchor' &&
      left.phase === right.phase &&
      left.segmentId === right.segmentId &&
      left.conversationId === right.conversationId &&
      left.turnId === right.turnId
    )
  );
}

function scrollNavigationAvailability(
  node: HTMLElement,
  anchors: TranscriptScrollAnchor[],
  mode: TranscriptAutoScrollMode,
  naturalMaxScrollTop: number,
  anchorRunwayHeight: number,
  navigationCursorSegmentId: string | null,
) {
  const currentSegmentId = mode.type === 'sent-message-anchor'
    ? mode.segmentId
    : navigationCursorSegmentId;
  const atBottom = mode.type === 'bottom' &&
    node.scrollTop >= naturalMaxScrollTop - bottomStickThresholdPx;
  return {
    canScrollDown:
      Boolean(nextUserMessageScrollAnchor({
        anchors,
        atBottom,
        currentSegmentId,
        maxScrollTop: naturalMaxScrollTop,
        scrollTop: node.scrollTop,
        threshold: scrollNavigationThresholdPx,
      })) ||
      node.scrollTop < naturalMaxScrollTop - scrollNavigationThresholdPx ||
      anchorRunwayHeight > 1,
    canScrollUp: Boolean(previousUserMessageScrollAnchor({
      anchors,
      atBottom,
      currentSegmentId,
      scrollTop: node.scrollTop,
      threshold: scrollNavigationThresholdPx,
    })),
  };
}

function maxScrollableTop(node: HTMLElement) {
  return Math.max(0, node.scrollHeight - node.clientHeight);
}

function computeAnchorExtentFloorHeight(
  viewport: HTMLElement,
  content: HTMLElement,
  desiredScrollTop: number,
) {
  const viewportBounds = viewport.getBoundingClientRect();
  const contentBounds = content.getBoundingClientRect();
  const contentTop = viewport.scrollTop + contentBounds.top - viewportBounds.top;
  return Math.max(0, Math.ceil(desiredScrollTop + viewport.clientHeight - contentTop));
}

function naturalTranscriptMaxScrollableTop(
  viewport: HTMLElement,
  transcriptBody: HTMLElement | null,
  content: HTMLElement | null,
) {
  if (!transcriptBody || !content) return maxScrollableTop(viewport);
  const viewportBounds = viewport.getBoundingClientRect();
  const bodyBounds = transcriptBody.getBoundingClientRect();
  const contentStyle = window.getComputedStyle(content);
  const bodyBottom = viewport.scrollTop + bodyBounds.bottom - viewportBounds.top;
  return Math.max(
    0,
    bodyBottom + parseCssPixels(contentStyle.paddingBottom, 0) - viewport.clientHeight,
  );
}

function parseCssPixels(value: string, fallback: number) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function mountedUserMessageAnchorScrollTop(
  viewport: HTMLElement,
  segmentId: string,
  anchorTop: number,
) {
  const viewportBounds = viewport.getBoundingClientRect();
  const rows = viewport.querySelectorAll<HTMLElement>('[data-row-kind="userMessage"]');
  for (const row of rows) {
    if (
      row.dataset.segmentId !== segmentId &&
      row.dataset.clientMessageId !== segmentId
    ) continue;
    return Math.max(
      0,
      viewport.scrollTop + row.getBoundingClientRect().top - viewportBounds.top - anchorTop,
    );
  }
  return null;
}

type ExpandedRowGeometry = {
  heightAfterRow: (turnId: string, rowId: string) => number;
  heightBeforeTurnIndex: (turnIndex: number) => number;
};

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

function captureTranscriptViewportAnchor({
  expandedRows,
  scrollTop,
  topPadding,
  turns,
}: {
  expandedRows: TranscriptExpandedRow[];
  scrollTop: number;
  topPadding: number;
  turns: TranscriptMeasuredTurn[];
}): TranscriptViewportAnchor | null {
  const positions = transcriptRowPositions({ expandedRows, topPadding, turns });
  if (positions.length === 0) {
    return null;
  }

  let anchor = positions[0]!;
  const target = scrollTop + 1;
  for (const position of positions) {
    if (position.scrollTop > target) {
      break;
    }
    anchor = position;
  }

  return {
    offset: scrollTop - anchor.scrollTop,
    rowId: anchor.rowId,
    turnId: anchor.turnId,
  };
}

function captureMountedViewportAnchor(viewport: HTMLElement): TranscriptViewportAnchor | null {
  const viewportBounds = viewport.getBoundingClientRect();
  const rows = viewport.querySelectorAll<HTMLElement>('[data-transcript-row-id][data-turn-id]');
  let firstRow: HTMLElement | null = null;
  for (const row of rows) {
    firstRow ??= row;
    const bounds = row.getBoundingClientRect();
    if (bounds.bottom <= viewportBounds.top + 1) {
      continue;
    }
    return mountedViewportAnchor(row, bounds, viewportBounds);
  }
  return firstRow
    ? mountedViewportAnchor(firstRow, firstRow.getBoundingClientRect(), viewportBounds)
    : null;
}

function mountedViewportAnchor(
  row: HTMLElement,
  rowBounds: DOMRect,
  viewportBounds: DOMRect,
): TranscriptViewportAnchor | null {
  const rowId = row.dataset.transcriptRowId;
  const turnId = row.dataset.turnId;
  if (!rowId || !turnId) {
    return null;
  }
  return {
    // Existing model anchors store scrollTop - rowTop. In viewport space that
    // is the negative of the row's visual top offset.
    offset: viewportBounds.top - rowBounds.top,
    rowId,
    turnId,
  };
}

function cachedTranscriptViewportAnchor(conversationId: string) {
  const anchor = transcriptViewportAnchorCache.get(conversationId) ?? null;
  if (!anchor) return null;
  transcriptViewportAnchorCache.delete(conversationId);
  transcriptViewportAnchorCache.set(conversationId, anchor);
  return anchor;
}

function cacheTranscriptViewportAnchor(
  conversationId: string,
  anchor: TranscriptViewportCacheEntry,
) {
  transcriptViewportAnchorCache.delete(conversationId);
  transcriptViewportAnchorCache.set(conversationId, anchor);
  while (transcriptViewportAnchorCache.size > MAX_CACHED_TRANSCRIPT_VIEWPORT_ANCHORS) {
    const oldestConversationId = transcriptViewportAnchorCache.keys().next().value as
      | string
      | undefined;
    if (!oldestConversationId) return;
    transcriptViewportAnchorCache.delete(oldestConversationId);
  }
}

function scrollTopForMountedViewportAnchor(
  viewport: HTMLElement,
  anchor: TranscriptViewportAnchor,
): number | null {
  const viewportBounds = viewport.getBoundingClientRect();
  const rows = viewport.querySelectorAll<HTMLElement>('[data-transcript-row-id][data-turn-id]');
  for (const row of rows) {
    if (
      row.dataset.transcriptRowId !== anchor.rowId ||
      row.dataset.turnId !== anchor.turnId
    ) {
      continue;
    }
    const currentVisualOffset = row.getBoundingClientRect().top - viewportBounds.top;
    return viewport.scrollTop + currentVisualOffset + anchor.offset;
  }
  return null;
}

function scrollTopForViewportAnchor({
  anchor,
  expandedRows,
  topPadding,
  turns,
}: {
  anchor: TranscriptViewportAnchor;
  expandedRows: TranscriptExpandedRow[];
  topPadding: number;
  turns: TranscriptMeasuredTurn[];
}) {
  const positions = transcriptRowPositions({ expandedRows, topPadding, turns });
  const exact = positions.find((position) => position.rowId === anchor.rowId && position.turnId === anchor.turnId);
  if (exact) {
    return exact.scrollTop + anchor.offset;
  }

  const sameTurn = positions.find((position) => position.turnId === anchor.turnId);
  return sameTurn ? sameTurn.scrollTop + Math.max(0, anchor.offset) : null;
}

function transcriptRowPositions({
  expandedRows,
  topPadding,
  turns,
}: {
  expandedRows: TranscriptExpandedRow[];
  topPadding: number;
  turns: TranscriptMeasuredTurn[];
}): TranscriptRowPosition[] {
  const positions: TranscriptRowPosition[] = [];
  const expanded = expandedRowGeometry(turns, expandedRows);

  turns.forEach((turn, turnIndex) => {
    let rowTop = turn.collapsedTop + expanded.heightBeforeTurnIndex(turnIndex);

    for (const row of turn.rows) {
      positions.push({
        rowId: row.id,
        scrollTop: topPadding + rowTop,
        turnId: turn.turnId,
      });

      rowTop += row.height + expanded.heightAfterRow(turn.turnId, row.id);
    }
  });

  return positions;
}

function VirtualizedTranscriptBody({
  bottomSpacerHeight,
  conversationId,
  status,
  topSpacerHeight,
  totalTurnCount,
  turns,
  width,
}: {
  bottomSpacerHeight: number;
  conversationId: string | null;
  status: TranscriptStatus;
  topSpacerHeight: number;
  totalTurnCount: number;
  turns: TranscriptMeasuredTurn[];
  width: number;
}) {
  if (status === 'idle' || status === 'loading') {
    return (
      <TranscriptFrameMessage
        icon={<Loader2 aria-hidden="true" className="size-4 animate-spin" />}
        label="Loading transcript"
      />
    );
  }

  if (status === 'failed') {
    return <TranscriptFrameMessage label="Transcript unavailable" />;
  }

  if (totalTurnCount === 0) {
    return <TranscriptFrameMessage label="No transcript yet" />;
  }

  if (!conversationId) {
    return <TranscriptFrameMessage label="No conversation selected" />;
  }

  return (
    <>
      {topSpacerHeight > 0 ? <div aria-hidden="true" style={{ height: `${topSpacerHeight}px` }} /> : null}
      {turns.map((turn) => (
        <TranscriptTurn conversationId={conversationId} key={turn.turnId} turn={turn} width={width} />
      ))}
      {bottomSpacerHeight > 0 ? <div aria-hidden="true" style={{ height: `${bottomSpacerHeight}px` }} /> : null}
    </>
  );
}

const TranscriptTurn = memo(function TranscriptTurn({
  conversationId,
  turn,
  width,
}: {
  conversationId: string;
  turn: TranscriptMeasuredTurn;
  width: number;
}) {
  const projectionError = useTranscriptResourceStore(
    (state) => state.turnResourcesById[turn.turnId]?.projectionError ?? null,
  );
  const refreshTranscript = useTranscriptResourceStore((state) => state.refreshActiveTranscriptResources);

  return (
    <article className="codex-transcript-turn" data-turn-id={turn.turnId}>
      {turn.rows.map((row) => (
        <TranscriptRow conversationId={conversationId} key={row.id} row={row} width={width} />
      ))}
      {turn.turn.error ? (
        <div className="codex-turn-error" role="alert">{turn.turn.error.message}</div>
      ) : null}
      {projectionError ? (
        <button
          className="agent-transcript-retry"
          onClick={() => void refreshTranscript({ preserveReady: true, windowPolicy: 'preserve' })}
          type="button"
        >
          <RotateCcw className="size-3" /> Retry turn projection
        </button>
      ) : null}
    </article>
  );
}, areTranscriptTurnPropsEqual);

const TranscriptRow = memo(function TranscriptRow({
  conversationId,
  row,
  width,
}: {
  conversationId: string;
  row: TranscriptMeasuredRow;
  width: number;
}) {
  return (
    <div
      className={`codex-transcript-row codex-transcript-row-${row.segment.type}`}
      data-client-message-id={row.segment.type === 'userMessage' ? row.segment.clientMessageId ?? undefined : undefined}
      data-row-kind={row.segment.type === 'work' ? 'workSection' : row.segment.type}
      data-segment-id={row.segmentId}
      data-transcript-row-id={row.id}
      data-turn-id={row.turnId}
    >
      <TranscriptSegmentBody
        conversationId={conversationId}
        row={row}
        segment={row.segment}
        width={width}
      />
    </div>
  );
}, areTranscriptRowPropsEqual);

function areTranscriptTurnPropsEqual(
  previous: { conversationId: string; turn: TranscriptMeasuredTurn; width: number },
  next: { conversationId: string; turn: TranscriptMeasuredTurn; width: number },
) {
  return previous.conversationId === next.conversationId &&
    previous.width === next.width &&
    previous.turn.rows === next.turn.rows &&
    previous.turn.turn.error === next.turn.turn.error;
}

function areTranscriptRowPropsEqual(
  previous: { conversationId: string; row: TranscriptMeasuredRow; width: number },
  next: { conversationId: string; row: TranscriptMeasuredRow; width: number },
) {
  return previous.conversationId === next.conversationId &&
    previous.width === next.width &&
    previous.row === next.row;
}

function TranscriptSegmentBody({
  conversationId,
  row,
  segment,
  width,
}: {
  conversationId: string;
  row: TranscriptMeasuredRow;
  segment: AgentTurnSegment;
  width: number;
}) {
  if (segment.type === 'userMessage') {
    return (
      <UserMessage
        conversationId={conversationId}
        disclosure={row.userMessageDisclosure}
        laneWidth={width}
        segment={segment}
        showActions={row.showUserActions}
        turnId={row.turnId}
        pathEntryId={row.turn.pathEntryId}
        strandId={row.turn.strandId}
      />
    );
  }
  if (segment.type === 'assistantMessage') {
    return (
      <AssistantMessage
        conversationId={conversationId}
        segment={segment}
        showActions={row.showAssistantActions}
        turnStatus={row.turn.status}
        turnId={row.turnId}
        pathEntryId={row.turn.pathEntryId}
        strandId={row.turn.strandId}
        width={width}
      />
    );
  }
  if (segment.type === 'compaction') {
    return (
      <CompactionDivider
        density="transcript"
        status={segment.status}
        title={segment.error}
      />
    );
  }
  return (
    <WorkSection
      conversationId={conversationId}
      laneWidth={width}
      responseStarted={row.turn.segments.some((candidate) =>
        candidate.type === 'assistantMessage' && Boolean(candidate.text.trim()))}
      rowId={row.id}
      segment={segment}
      turnId={row.turnId}
    />
  );
}

function TranscriptFrameMessage({
  icon,
  label,
}: {
  icon?: React.ReactNode;
  label: string;
}) {
  return (
    <div className="agent-transcript-state">
      {icon}
      <span>{label}</span>
    </div>
  );
}

export { VirtualizedTranscript as AgentTranscript };
export default VirtualizedTranscript;
