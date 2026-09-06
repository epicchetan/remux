import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import type { TranscriptRenderSnapshot } from '../controller/useTranscriptRenderSnapshot';
import { transcriptLayout } from '../layout/constants';
import type { TranscriptMeasuredTurn } from '../layout/types';
import { useTranscriptLayoutStore } from '../layoutStore';
import { resolveTranscriptContentWidth } from '../measureWidth';
import {
  getTranscriptResourceState,
  useTranscriptResourceStore,
} from '../resourceStore';
import {
  registerTranscriptViewportCapture,
  type TranscriptViewportIntent,
  useTranscriptViewportStore,
} from '../viewportStore';
import {
  nativeScrollOwnsViewport,
  sameTranscriptViewportIntent,
  transcriptScrollOwnerAfterNativeEvent,
  type TranscriptScrollOwner,
  type TranscriptScrollAnchor,
  type TranscriptViewportAnchor,
} from './viewportTypes';
import {
  historicalMessageNavigationDestination,
  initialTranscriptScrollTarget,
  nextTranscriptNavigationDestination,
  previousUserMessageScrollAnchor,
  resolveInitialTranscriptScrollTarget,
  resolveMessageAnchorScroll,
  viewportIntentAfterNativeScrollSettles,
  viewportIntentForStreamingTurn,
} from './viewportReducer';
import {
  cacheTranscriptViewportAnchor,
  cachedTranscriptViewportAnchor,
  type TranscriptInitialViewportIntent,
  type TranscriptViewportCacheEntry,
} from './viewportCache';
import {
  captureTranscriptViewportAnchor,
  computeAnchorExtentFloorHeight,
  distanceFromBottom,
  maxScrollableTop,
  naturalTranscriptContentMaxScrollableTop,
  naturalTranscriptMaxScrollableTop,
  parseCssPixels,
  scrollTopForViewportAnchor,
} from './viewportDom';
import {
  computeTranscriptSpacerRange,
  computeTranscriptVirtualRange,
  initialTranscriptActiveTurnIds,
  sameTurnIds,
} from '../virtualizerRange';
import {
  anchorTurnUserMessageScrollTop,
  anchorUserMessageScrollTop,
  userMessageScrollAnchors,
} from '../virtualizerScroll';

const bottomStickThresholdPx = 12;
const scrollNavigationDurationMs = 170;
const scrollNavigationThresholdPx = 12;
// A scrollTop write after touchend cancels native iOS deceleration. Older WebViews
// lack scrollend, so release ownership only after scroll events have gone quiet.
const touchScrollSettleDelayMs = 180;

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

export function useTranscriptViewportController(
  conversationId: string,
  renderSnapshot: TranscriptRenderSnapshot,
) {
  const activeConversationId = useTranscriptResourceStore((state) => state.activeConversationId);
  const setActiveConversationId = useTranscriptResourceStore((state) => state.setActiveConversationId);
  const status = useTranscriptResourceStore((state) => state.status);
  const error = useTranscriptResourceStore((state) => state.error);
  const refreshTranscript = useTranscriptResourceStore((state) => state.refreshActiveTranscriptResources);
  // Measured rows, disclosure overlays, geometry, and running identity come
  // from one layout-owned snapshot. Resource hydration may publish before or
  // after layout reconciliation, so viewport policy never reassembles these
  // inputs directly from the transport store.
  const {
    activeTurnId,
    expandedRows,
    geometry,
    turns,
    turnsById,
  } = renderSnapshot;
  const hasEarlierTurns = useTranscriptResourceStore((state) => state.window?.hasEarlier === true);
  const hasLaterTurns = useTranscriptResourceStore((state) => state.window?.hasLater === true);
  const loadEarlierTranscriptResources = useTranscriptResourceStore((state) => state.loadEarlierTranscriptResources);
  const loadLaterTranscriptResources = useTranscriptResourceStore((state) => state.loadLaterTranscriptResources);
  const focusTranscriptTurn = useTranscriptResourceStore((state) => state.focusTranscriptTurn);
  const setTranscriptWidth = useTranscriptLayoutStore((state) => state.setWidth);
  const activeTurnIds = useTranscriptViewportStore((state) => state.activeTurnIds);
  const viewportIntent = useTranscriptViewportStore((state) => state.viewportIntent);
  const setActiveTurnIds = useTranscriptViewportStore((state) => state.setActiveTurnIds);
  const setViewportIntent = useTranscriptViewportStore((state) => state.setViewportIntent);
  const setScrollAvailability = useTranscriptViewportStore((state) => state.setScrollAvailability);
  const setScrollNavigationController = useTranscriptViewportStore((state) => state.setScrollNavigationController);
  const viewportLifecycleState = useTranscriptViewportStore((state) => state.lifecycleState);
  const requestedTurnScroll = useTranscriptViewportStore((state) => state.requestedTurnScroll);
  const turnScrollError = useTranscriptViewportStore((state) => state.turnScrollError);
  const clearTurnScroll = useTranscriptViewportStore((state) => state.clearTurnScroll);
  const failTurnScroll = useTranscriptViewportStore((state) => state.failTurnScroll);
  const requestTurnScroll = useTranscriptViewportStore((state) => state.requestTurnScroll);
  const resolveTurnScroll = useTranscriptViewportStore((state) => state.resolveTurnScroll);
  const streamingTurnId = activeTurnId;
  const [viewportTopPadding, setViewportTopPadding] = useState<number>(transcriptLayout.viewport.padY);
  const [anchorExtentFloorHeight, setAnchorExtentFloorHeight] = useState(0);
  const [anchorRunwayHeight, setAnchorRunwayHeight] = useState(0);
  const navigationAnchors = useMemo(
    () =>
      userMessageScrollAnchors({
        expandedRows,
        geometry,
        topPadding: viewportTopPadding,
        turns,
      }),
    [expandedRows, geometry, turns, viewportTopPadding],
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
  const geometryRef = useRef(geometry);
  const scrollOwnerRef = useRef<TranscriptScrollOwner>('idle');
  const scrollAnchorRef = useRef<TranscriptViewportAnchor | null>(null);
  const viewportIntentRef = useRef<TranscriptViewportIntent>(viewportIntent);
  const anchorExtentFloorHeightRef = useRef(0);
  const anchorRunwayHeightRef = useRef(0);
  const viewportResizeSettlingRef = useRef(false);
  // Segment id of the anchor that ended the last managed scroll pinned.
  const anchorPinnedSegmentIdRef = useRef<string | null>(null);
  // Historical Up/Down navigation needs a semantic cursor so sequential
  // presses remain identity-based even after the viewport lands a few pixels
  // away from the modeled row position. This is deliberately separate from
  // message-anchor auto-scroll ownership: historical navigation must settle and
  // stop writing scrollTop once its animation completes.
  const navigationCursorSegmentIdRef = useRef<string | null>(null);
  const userScrollArmedRef = useRef(false);
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
    geometryRef.current = geometry;
  }, [geometry]);

  useLayoutEffect(() => {
    navigationAnchorsRef.current = navigationAnchors;
  }, [navigationAnchors]);

  const setTranscriptViewportIntent = useCallback((
    mode: TranscriptViewportIntent,
    _reason: TranscriptViewportModeChangeReason,
  ) => {
    const previousMode = viewportIntentRef.current;
    viewportIntentRef.current = mode;
    if (!sameTranscriptViewportIntent(previousMode, mode)) {
      setViewportIntent(mode);
    }
  }, [setViewportIntent]);

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

    const anchor = captureTranscriptViewportAnchor({
      geometry: geometryRef.current,
      scrollTop: viewport.scrollTop,
      topPadding: viewportTopPadding,
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
    const mode = viewportIntentRef.current;
    if (
      mode.kind === 'bottom-follow' ||
      (
        anchorRunwayHeightRef.current <= 1 &&
        Math.abs(viewport.scrollTop - naturalMaxScrollTop) <= bottomStickThresholdPx
      )
    ) {
      return { kind: 'bottom' };
    }
    if (mode.kind === 'message-anchor') {
      return {
        kind: 'user-message',
        segmentId: mode.segmentId,
        turnId: mode.turnId,
      };
    }

    const latestUserMessage = navigationAnchorsRef.current.at(-1) ?? null;
    if (latestUserMessage) {
      if (
        Math.abs(viewport.scrollTop - latestUserMessage.scrollTop) <= 2
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
      const measuredTurns = geometryRef.current.turns;
      if (!viewport || measuredTurns.length === 0) {
        setScrollAvailability({ canScrollDown: false, canScrollUp: false });
        return;
      }

      const range = computeTranscriptVirtualRange({
        geometry: geometryRef.current,
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
        viewportIntentRef.current,
        naturalTranscriptContentMaxScrollableTop(viewport, transcriptBodyRef.current),
        naturalTranscriptMaxScrollableTop(viewport, transcriptBodyRef.current, measureRef.current),
        navigationCursorSegmentIdRef.current,
      ));

      if (initialPlacementPendingRef.current) {
        return;
      }

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
    const mode = viewportIntentRef.current;
    if (!viewport || viewportLifecycleState !== 'active') {
      return;
    }

    if (nativeScrollOwnsViewport(scrollOwnerRef.current)) {
      return;
    }
    if (scrollOwnerRef.current !== 'idle' || scrollAnimationRafRef.current !== null) {
      return;
    }
    // Manual viewport ownership prevents content growth from moving the transcript.
    // Programmatic navigation retains the previous anchor's extent through its
    // animation and range commit, so do not release it until navigation gives
    // ownership back and this branch runs again.
    if (mode.kind === 'free') {
      anchorPinnedSegmentIdRef.current = null;
      setAnchorExtentFloor(null);
      setAnchorRunway(0);
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

    if (mode.kind === 'message-anchor') {
      const desiredScrollTop = anchorUserMessageScrollTop({
        expandedRows: [],
        geometry: geometryRef.current,
        segmentId: mode.segmentId,
        topPadding: viewportTopPadding,
        turnId: mode.turnId,
        turns: geometryRef.current.turns,
      });
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
        const resolution = resolveMessageAnchorScroll({
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
          setTranscriptViewportIntent({ ...mode, phase: resolution.phase }, 'mount-stickiness');
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
      scrollOwnerRef.current = 'programmatic-navigation';
      viewport.scrollTop = reachableTarget;
      lastScrollTopRef.current = viewport.scrollTop;
      scheduleRangeUpdate();
    }

    window.requestAnimationFrame(() => {
      if (scrollOwnerRef.current === 'programmatic-navigation') scrollOwnerRef.current = 'idle';
    });
  }, [
    scheduleRangeUpdate,
    setAnchorExtentFloor,
    setAnchorRunway,
    setTranscriptViewportIntent,
    viewportLifecycleState,
    viewportTopPadding,
  ]);

  const scheduleAutoScroll = useCallback(() => {
    if (
      bottomScrollRafRef.current !== null ||
      nativeScrollOwnsViewport(scrollOwnerRef.current)
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
        viewportIntentRef.current.kind !== 'free' &&
        !nativeScrollOwnsViewport(scrollOwnerRef.current)
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
    viewportIntentRef.current = viewportIntent;
    if (viewportIntent.kind !== 'free') {
      scheduleAutoScroll();
    }
  }, [viewportIntent, scheduleAutoScroll]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    // Composer lift (keyboard) resizes the viewport; managed modes must react
    // immediately — bottom stickiness re-pins, and a message anchor that
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
      if (viewportIntentRef.current.kind !== 'free') {
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
    if (!nativeScrollOwnsViewport(scrollOwnerRef.current)) scrollOwnerRef.current = 'idle';
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
        if (scrollOwnerRef.current === 'programmatic-navigation') scrollOwnerRef.current = 'idle';
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
        if (scrollOwnerRef.current === 'initial-placement') scrollOwnerRef.current = 'idle';
        onReleased();
      });
    });
  }, []);

  const scrollToPosition = useCallback((
    scrollTop: number,
    nextViewportIntent: TranscriptViewportIntent,
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
      if (nextViewportIntent.kind !== 'free') scheduleAutoScroll();
    };

    if (bottomScrollRafRef.current !== null) {
      window.cancelAnimationFrame(bottomScrollRafRef.current);
      bottomScrollRafRef.current = null;
    }

    const startScrollTop = viewport.scrollTop;
    const maxScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    const targetScrollTop = Math.max(0, Math.min(scrollTop, maxScrollTop));

    setTranscriptViewportIntent(nextViewportIntent, reason);
    scrollOwnerRef.current = 'programmatic-navigation';

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
    setTranscriptViewportIntent,
  ]);

  const scrollToMessageAnchor = useCallback((
    anchor: TranscriptScrollAnchor,
    bottomIfUnreachable = false,
  ) => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    navigationCursorSegmentIdRef.current = anchor.segmentId;
    const desiredScrollTop = anchor.scrollTop;
    const naturalMaxScrollTop = naturalTranscriptMaxScrollableTop(
      viewport,
      transcriptBodyRef.current,
      measureRef.current,
    );
    const destination = historicalMessageNavigationDestination({
      bottomIfUnreachable,
      desiredScrollTop,
      naturalMaxScrollTop,
    });
    const anchorsMessage = destination.kind === 'message';
    if (anchorsMessage) {
      // Navigation promises an exact user-message position, including for a
      // near-tail historical turn that cannot naturally reach the top. Retain
      // any larger existing extent during motion so changing anchors cannot
      // clamp the starting position before the first animation frame.
      const currentMaxScrollTop = maxScrollableTop(viewport);
      if (desiredScrollTop > currentMaxScrollTop + 1) {
        setAnchorExtentFloor(desiredScrollTop);
        setAnchorRunway(Math.max(
          anchorRunwayHeightRef.current,
          desiredScrollTop - naturalMaxScrollTop,
        ));
      }
    }
    if (destination.kind === 'bottom') {
      navigationCursorSegmentIdRef.current = null;
    }
    scrollToPosition(
      destination.scrollTop,
      anchorsMessage
        ? {
            kind: 'message-anchor',
            phase: 'anchored',
            reason: 'navigation',
            segmentId: anchor.segmentId,
            conversationId: activeConversationId ?? '',
            turnId: anchor.turnId,
          }
        : destination.kind === 'bottom' ? { kind: 'bottom-follow' } : { kind: 'free' },
      destination.kind === 'bottom' ? 'scroll-navigation-bottom' : 'scroll-navigation',
      true,
      () => {
        if (destination.kind === 'bottom') {
          setAnchorExtentFloor(null);
          setAnchorRunway(0);
        }
        scheduleRangeUpdate();
      },
    );
  }, [
    activeConversationId,
    scheduleRangeUpdate,
    scrollToPosition,
    setAnchorExtentFloor,
    setAnchorRunway,
  ]);

  const scrollUp = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    const mode = viewportIntentRef.current;
    const currentSegmentId = mode.kind === 'message-anchor'
      ? mode.segmentId
      : navigationCursorSegmentIdRef.current;
    const anchor = previousUserMessageScrollAnchor({
      anchors: navigationAnchorsRef.current,
      atBottom: mode.kind === 'bottom-follow' && isNearBottom(viewport),
      currentSegmentId,
      scrollTop: viewport.scrollTop,
      threshold: scrollNavigationThresholdPx,
    });
    if (!anchor) {
      return;
    }

    scrollToMessageAnchor(anchor, false);
  }, [scrollToMessageAnchor]);

  const scrollDown = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    const mode = viewportIntentRef.current;
    const currentSegmentId = mode.kind === 'message-anchor'
      ? mode.segmentId
      : navigationCursorSegmentIdRef.current;
    const naturalMaxScrollTop = naturalTranscriptMaxScrollableTop(
      viewport,
      transcriptBodyRef.current,
      measureRef.current,
    );
    const naturalContentMaxScrollTop = naturalTranscriptContentMaxScrollableTop(
      viewport,
      transcriptBodyRef.current,
    );
    const destination = nextTranscriptNavigationDestination({
      anchors: navigationAnchorsRef.current,
      atBottom: mode.kind === 'bottom-follow' &&
        viewport.scrollTop >= naturalMaxScrollTop - bottomStickThresholdPx,
      currentSegmentId,
      naturalContentMaxScrollTop,
      naturalMaxScrollTop,
      scrollTop: viewport.scrollTop,
      threshold: scrollNavigationThresholdPx,
    });
    if (!destination) return;
    if (destination.kind === 'message') {
      scrollToMessageAnchor(destination.anchor, false);
      return;
    }

    // No later user row can reach the normal anchor offset. The remaining
    // destination is the transcript's real bottom, not a synthetic runway
    // that lifts an already-visible tail row to the top.
    navigationCursorSegmentIdRef.current = null;
    scrollToPosition(
      destination.scrollTop,
      { kind: 'bottom-follow' },
      'scroll-navigation-bottom',
      true,
      () => {
        setAnchorExtentFloor(null);
        setAnchorRunway(0);
        scheduleRangeUpdate();
      },
    );
  }, [
    scheduleRangeUpdate,
    scrollToMessageAnchor,
    scrollToPosition,
    setAnchorExtentFloor,
    setAnchorRunway,
  ]);

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
      geometry,
      topPadding: viewportTopPadding,
      turns,
      turnId: requestedTurnScroll.turnId,
    });
    if (desiredScrollTop === null) return;
    navigationCursorSegmentIdRef.current = null;
    scrollToPosition(desiredScrollTop, { kind: 'free' }, 'host-navigate', false, () => {
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
      const userInitiated = userScrollArmedRef.current &&
        scrollOwnerRef.current !== 'programmatic-navigation' &&
        scrollOwnerRef.current !== 'initial-placement';
      userScrollArmedRef.current = false;
      if (scrollOwnerRef.current === 'native-momentum') {
        scrollOwnerRef.current = transcriptScrollOwnerAfterNativeEvent(
          scrollOwnerRef.current,
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
      const mode = viewportIntentAfterNativeScrollSettles({
        currentIntent: viewportIntentRef.current,
        nearBottom: isNearBottom(viewport),
        userInitiated,
      });
      setTranscriptViewportIntent(mode, 'scroll-settled');
      if (mode.kind !== 'free') scheduleAutoScroll();
    };
    const scheduleUserScrollSettleFallback = () => {
      clearScrollSettleTimer();
      scrollSettleTimer = window.setTimeout(finishUserScroll, touchScrollSettleDelayMs);
    };
    const onScroll = () => {
      updateScrollPosition();
      scheduleRangeUpdate();
      if (scrollOwnerRef.current === 'native-momentum') {
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
      scrollOwnerRef.current = transcriptScrollOwnerAfterNativeEvent(
        scrollOwnerRef.current,
        'touch-start',
      );
      setTranscriptViewportIntent({ kind: 'free' }, 'touch-start');
    };
    const onWheel = () => {
      navigationCursorSegmentIdRef.current = null;
      cancelScrollAnimation();
      userScrollArmedRef.current = true;
      setTranscriptViewportIntent({ kind: 'free' }, 'manual-scroll');
      scheduleUserScrollSettleFallback();
    };
    const onTouchEnd = () => {
      scrollOwnerRef.current = transcriptScrollOwnerAfterNativeEvent(
        scrollOwnerRef.current,
        'touch-end',
      );
      scheduleUserScrollSettleFallback();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') {
        clearScrollSettleTimer();
        userScrollArmedRef.current = false;
        scrollOwnerRef.current = 'idle';
        cancelScrollAnimation();
        return;
      }
      lastScrollTopRef.current = viewport.scrollTop;
      captureViewportAnchor();
      scheduleRangeUpdate();
      if (viewportIntentRef.current.kind !== 'free') {
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
    if (viewportIntentRef.current.kind === 'free') {
      setTranscriptViewportIntent(
        isNearBottom(viewport) ? { kind: 'bottom-follow' } : { kind: 'free' },
        'mount-stickiness',
      );
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
      scrollOwnerRef.current = 'idle';
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
    setTranscriptViewportIntent,
  ]);

  useEffect(() => {
    if (viewportLifecycleState !== 'active') {
      userScrollArmedRef.current = false;
      scrollOwnerRef.current = 'idle';
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
    if (viewportIntentRef.current.kind !== 'free') {
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
      viewportIntentRef.current.kind !== 'free' ||
      nativeScrollOwnsViewport(scrollOwnerRef.current) ||
      scrollOwnerRef.current === 'programmatic-navigation'
    ) {
      captureViewportAnchor();
      return;
    }

    const anchor = scrollAnchorRef.current;
    if (!anchor) {
      captureViewportAnchor();
      return;
    }

    const restoredScrollTop = scrollTopForViewportAnchor({
      anchor,
      geometry,
      topPadding: viewportTopPadding,
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

    scrollOwnerRef.current = 'programmatic-navigation';
    viewport.scrollTop = targetScrollTop;
    lastScrollTopRef.current = viewport.scrollTop;
    captureViewportAnchor();
    scheduleRangeUpdate();

    window.requestAnimationFrame(() => {
      if (scrollOwnerRef.current === 'programmatic-navigation') scrollOwnerRef.current = 'idle';
    });
  }, [captureViewportAnchor, expandedRows, scheduleRangeUpdate, status, turns, viewportTopPadding, width]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (nativeScrollOwnsViewport(scrollOwnerRef.current)) {
      return;
    }

    if (!viewport) {
      return;
    }

    const mode = viewportIntentForStreamingTurn({
      currentIntent: viewportIntentRef.current,
      nearBottom: isNearBottom(viewport),
      streamingTurnId,
    });
    setTranscriptViewportIntent(mode, 'streaming-turn');
    if (mode.kind !== 'free') {
      scheduleAutoScroll();
    }
  }, [scheduleAutoScroll, setTranscriptViewportIntent, streamingTurnId]);

  useLayoutEffect(() => {
    if (
      status !== 'ready' ||
      width === null ||
      turns.length === 0 ||
      navigationAnchors.length === 0
    ) {
      return;
    }

    applyManagedScroll();
  }, [anchorRunwayHeight, applyManagedScroll, viewportIntent, expandedRows, status, turns, width]);

  const validActiveTurnIds = activeTurnIds.filter((turnId) => Boolean(turnsById[turnId]));
  const sentAnchorNeedsMaterialization =
    viewportIntent.kind === 'message-anchor' &&
    Boolean(turnsById[viewportIntent.turnId]) &&
    !validActiveTurnIds.includes(viewportIntent.turnId);
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
    geometry,
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
    const currentMode = viewportIntentRef.current;
    if (currentMode.kind === 'message-anchor' && currentMode.conversationId === activeConversationId) {
      // A send intent (fork, new thread) predates this mount and the on-load
      // heuristic must not clobber it: the anchor row may not even be in the
      // transcript yet. Start at the bottom and let the managed scroll own
      // positioning from here.
      const placementEpoch = ++initialPlacementEpochRef.current;
      initialPlacementPendingRef.current = true;
      initialViewportIntentRef.current = null;
      scrollOwnerRef.current = 'initial-placement';
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
    const defaultInitialTarget = initialTranscriptScrollTarget({
      anchors: navigationAnchors,
      conversationId: activeConversationId,
      streamingTurnId,
    });
    const cachedIntent = initialViewportIntentRef.current;
    const cachedMessage = cachedIntent?.kind === 'user-message' ? cachedIntent : null;
    const cachedAnchor = cachedMessage
      ? navigationAnchors.find((anchor) =>
          anchor.segmentId === cachedMessage.segmentId && anchor.turnId === cachedMessage.turnId) ?? null
      : null;
    const modeledInitialTarget = cachedIntent?.kind === 'bottom'
      ? null
      : cachedAnchor
        ? {
            intent: { kind: 'free' as const },
            scrollTop: cachedAnchor.scrollTop,
          }
        : defaultInitialTarget;
    const modeledIntent = modeledInitialTarget?.intent;
    const targetAnchor = modeledIntent?.kind === 'message-anchor'
      ? navigationAnchors.find((anchor) =>
          anchor.segmentId === modeledIntent.segmentId) ?? null
      : cachedAnchor ?? navigationAnchors.at(-1) ?? null;
    const naturalMaxScrollTop = naturalTranscriptMaxScrollableTop(
      viewport,
      transcriptBodyRef.current,
      measureRef.current,
    );
    const resolvedInitialTarget = resolveInitialTranscriptScrollTarget({
      maxScrollTop: naturalMaxScrollTop,
      target: modeledInitialTarget,
    });
    const placementEpoch = ++initialPlacementEpochRef.current;
    initialPlacementPendingRef.current = true;
    initialViewportIntentRef.current = null;
    setTranscriptViewportIntent(resolvedInitialTarget.intent, 'initial-scroll');
    scrollOwnerRef.current = 'initial-placement';
    viewport.scrollTop = resolvedInitialTarget.scrollTop;
    lastScrollTopRef.current = viewport.scrollTop;
    releaseInitialPlacement(placementEpoch, () => {
      navigationCursorSegmentIdRef.current = resolvedInitialTarget.intent.kind === 'free' && targetAnchor
        ? targetAnchor.segmentId
        : null;
      captureViewportAnchor();
      scheduleRangeUpdate();
      if (resolvedInitialTarget.intent.kind !== 'free') scheduleAutoScroll();
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
    setTranscriptViewportIntent,
    status,
    streamingTurnId,
    viewportTopPadding,
    width,
  ]);

  return {
    anchorExtentFloorHeight,
    anchorRunwayHeight,
    anchorRunwayRef,
    bottomSpacerHeight: spacerRange.bottomSpacerHeight,
    contentRef: measureRef,
    conversationId: activeConversationId,
    error,
    focusError: turnScrollError && requestedTurnScroll ? turnScrollError.message : null,
    onDismissFocusError: requestedTurnScroll
      ? () => clearTurnScroll(requestedTurnScroll.id)
      : null,
    onRetryFocus: requestedTurnScroll
      ? () => requestTurnScroll(conversationId, requestedTurnScroll.turnId)
      : null,
    onRetryTranscript: () => void refreshTranscript({ forceFullMeasure: true }),
    status,
    topSpacerHeight: spacerRange.topSpacerHeight,
    totalTurnCount: turns.length,
    transcriptBodyRef,
    turns: renderTurns,
    viewportRef,
    width,
  };
}

function isNearBottom(node: HTMLElement) {
  return distanceFromBottom(node) <= bottomStickThresholdPx;
}

function scrollNavigationAvailability(
  node: HTMLElement,
  anchors: TranscriptScrollAnchor[],
  mode: TranscriptViewportIntent,
  naturalContentMaxScrollTop: number,
  naturalMaxScrollTop: number,
  navigationCursorSegmentId: string | null,
) {
  const currentSegmentId = mode.kind === 'message-anchor'
    ? mode.segmentId
    : navigationCursorSegmentId;
  const atBottom = mode.kind === 'bottom-follow' &&
    node.scrollTop >= naturalMaxScrollTop - bottomStickThresholdPx;
  const previousAnchor = previousUserMessageScrollAnchor({
    anchors,
    atBottom,
    currentSegmentId,
    scrollTop: node.scrollTop,
    threshold: scrollNavigationThresholdPx,
  });
  const downDestination = nextTranscriptNavigationDestination({
    anchors,
    atBottom,
    currentSegmentId,
    naturalContentMaxScrollTop,
    naturalMaxScrollTop,
    scrollTop: node.scrollTop,
    threshold: scrollNavigationThresholdPx,
  });
  return {
    canScrollDown: Boolean(downDestination),
    canScrollUp: Boolean(previousAnchor),
  };
}
