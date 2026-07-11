import { Loader2 } from 'lucide-react';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import type { CodexTranscriptSegment, CodexWorkDetails } from '../../shared/transcript';
import { AssistantMessage } from './components/assistantMessage';
import { Compaction } from './components/compaction';
import { UserMessage } from './components/userMessage';
import { WorkSection } from './components/work/WorkSection';
import { resolveNarrationTargetElements } from '../narration/targetRegistry';
import { transcriptLayout } from './layout/constants';
import type { TranscriptMeasuredRow, TranscriptMeasuredTurn } from './layout/types';
import { useThreadRuntimeStore } from '../threads/runtimeStore';
import { useTranscriptLayoutStore } from './layoutStore';
import {
  useTranscriptResourceStore,
  workDetailsResourceKey,
  type TranscriptStatus,
} from './resourceStore';
import {
  notifyTranscriptNarrationManualScroll,
  type TranscriptAutoScrollMode,
  type TranscriptNarrationFocusRequest,
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
  autoScrollModeAfterNativeScrollSettles,
  autoScrollModeForStreamingTurn,
  initialTranscriptScrollTarget,
  nativeScrollOwnsTranscriptViewport,
  transcriptNativeScrollPhaseAfterEvent,
  userMessageAnchorScrollTop,
  type TranscriptNativeScrollPhase,
  type TranscriptScrollAnchor,
} from './virtualizerScroll';

const bottomStickThresholdPx = 12;
const scrollNavigationDurationMs = 170;
const scrollNavigationThresholdPx = 12;
const scrollDirectionThresholdPx = 4;
// A scrollTop write after touchend cancels native iOS deceleration. Older WebViews
// lack scrollend, so release ownership only after scroll events have gone quiet.
const touchScrollSettleDelayMs = 180;

type TranscriptViewportAnchor = {
  offset: number;
  rowId: string;
  turnId: string;
};

type TranscriptRowPosition = {
  rowId: string;
  scrollTop: number;
  turnId: string;
};

type TranscriptViewportModeChangeReason =
  | 'initial-scroll'
  | 'mount-stickiness'
  | 'manual-scroll'
  | 'narration-focus'
  | 'scroll-navigation'
  | 'scroll-navigation-bottom'
  | 'scroll-settled'
  | 'host-navigate'
  | 'streaming-turn'
  | 'touch-start';

export function VirtualizedTranscript({ threadId = null }: { threadId?: string | null }) {
  const activeThreadId = useTranscriptResourceStore((state) => state.activeThreadId);
  const setTranscriptThreadId = useTranscriptResourceStore((state) => state.setActiveThreadId);
  const status = useTranscriptResourceStore((state) => state.status);
  const turnOrder = useTranscriptResourceStore((state) => state.turnOrder);
  const runtimeThreadId = useThreadRuntimeStore((state) => state.activeThreadId);
  const runtimeActiveTurnId = useThreadRuntimeStore((state) => state.activeTurnId);
  const runtimeResourceStatus = useThreadRuntimeStore((state) => state.resourceStatus);
  const runtimeStatus = useThreadRuntimeStore((state) => state.status);
  const turnsById = useTranscriptLayoutStore((state) => state.turnsById);
  const openWorkByKey = useTranscriptLayoutStore((state) => state.disclosure.openWorkByKey);
  const setTranscriptWidth = useTranscriptLayoutStore((state) => state.setWidth);
  const activeTurnIds = useTranscriptViewportStore((state) => state.activeTurnIds);
  const autoScrollMode = useTranscriptViewportStore((state) => state.autoScrollMode);
  const setActiveTurnIds = useTranscriptViewportStore((state) => state.setActiveTurnIds);
  const setAutoScrollMode = useTranscriptViewportStore((state) => state.setAutoScrollMode);
  const setScrollAvailability = useTranscriptViewportStore((state) => state.setScrollAvailability);
  const setScrollNavigationController = useTranscriptViewportStore((state) => state.setScrollNavigationController);
  const requestedTurnScroll = useTranscriptViewportStore((state) => state.requestedTurnScroll);
  const turns = useMemo(
    () => turnOrder.map((turnId) => turnsById[turnId]).filter((turn): turn is TranscriptMeasuredTurn => Boolean(turn)),
    [turnOrder, turnsById],
  );
  const streamingTurnId =
    runtimeThreadId === activeThreadId && (runtimeStatus === 'running' || runtimeStatus === 'stopping')
      ? runtimeActiveTurnId
      : null;
  const expandedRows = useMemo(() => Object.values(openWorkByKey), [openWorkByKey]);
  const [viewportTopPadding, setViewportTopPadding] = useState<number>(transcriptLayout.viewport.padY);
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
  const rafRef = useRef<number | null>(null);
  const bottomScrollRafRef = useRef<number | null>(null);
  const scrollAnimationRafRef = useRef<number | null>(null);
  const activeTurnIdsRef = useRef(activeTurnIds);
  const initialScrollThreadIdRef = useRef<string | null>(null);
  const handledTurnScrollRequestIdRef = useRef(0);
  const lastScrollTopRef = useRef(0);
  const navigationAnchorsRef = useRef(navigationAnchors);
  const expandedRowsRef = useRef(expandedRows);
  const programmaticScrollRef = useRef(false);
  const scrollAnchorRef = useRef<TranscriptViewportAnchor | null>(null);
  const autoScrollModeRef = useRef<TranscriptAutoScrollMode>(autoScrollMode);
  const nativeScrollPhaseRef = useRef<TranscriptNativeScrollPhase>('idle');
  const turnsRef = useRef(turns);
  const streamingTurnIdRef = useRef(streamingTurnId);
  const [width, setWidth] = useState<number | null>(null);

  useEffect(() => {
    void setTranscriptThreadId(threadId);
  }, [setTranscriptThreadId, threadId]);

  useLayoutEffect(() => {
    const node = measureRef.current;
    if (!node) {
      return;
    }

    const updateLayout = () => {
      const nextWidth = Math.max(1, node.getBoundingClientRect().width);
      setWidth((current) => (current !== null && Math.abs(current - nextWidth) <= 0.5 ? current : nextWidth));
      setViewportTopPadding((current) => {
        const nextTopPadding = parseCssPixels(getComputedStyle(node).paddingTop, transcriptLayout.viewport.padY);
        return Math.abs(current - nextTopPadding) <= 0.5 ? current : nextTopPadding;
      });
    };

    updateLayout();

    const observer = new ResizeObserver(updateLayout);
    observer.observe(node);
    window.addEventListener('resize', updateLayout);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updateLayout);
    };
  }, []);

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

  useLayoutEffect(() => {
    streamingTurnIdRef.current = streamingTurnId;
  }, [streamingTurnId]);

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

  const captureViewportAnchor = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      scrollAnchorRef.current = null;
      return null;
    }

    const anchor = captureTranscriptViewportAnchor({
      expandedRows: expandedRowsRef.current,
      scrollTop: viewport.scrollTop,
      topPadding: viewportTopPadding,
      turns: turnsRef.current,
    });
    scrollAnchorRef.current = anchor;
    return anchor;
  }, [viewportTopPadding]);

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
      setScrollAvailability(scrollNavigationAvailability(viewport, navigationAnchorsRef.current));

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

  const scheduleAutoScroll = useCallback(() => {
    if (
      bottomScrollRafRef.current !== null ||
      nativeScrollOwnsTranscriptViewport(nativeScrollPhaseRef.current)
    ) {
      return;
    }

    bottomScrollRafRef.current = window.requestAnimationFrame(() => {
      bottomScrollRafRef.current = null;

      const viewport = viewportRef.current;
      if (
        !viewport ||
        autoScrollModeRef.current.type === 'off' ||
        nativeScrollOwnsTranscriptViewport(nativeScrollPhaseRef.current)
      ) {
        return;
      }

      const target = autoScrollTarget({
        mode: autoScrollModeRef.current,
        expandedRows: expandedRowsRef.current,
        topPadding: viewportTopPadding,
        turns: turnsRef.current,
        viewport,
      });

      if (target === null) {
        return;
      }

      if (Math.abs(target.scrollTop - viewport.scrollTop) > 1) {
        programmaticScrollRef.current = true;
        viewport.scrollTop = target.scrollTop;
        lastScrollTopRef.current = viewport.scrollTop;
        scheduleRangeUpdate();
      }

      window.requestAnimationFrame(() => {
        programmaticScrollRef.current = false;
      });
    });
  }, [scheduleRangeUpdate, viewportTopPadding]);

  useEffect(() => {
    autoScrollModeRef.current = autoScrollMode;
    if (autoScrollMode.type !== 'off') {
      scheduleAutoScroll();
    }
  }, [autoScrollMode, scheduleAutoScroll]);

  const cancelScrollAnimation = useCallback(() => {
    if (scrollAnimationRafRef.current === null) {
      return;
    }

    window.cancelAnimationFrame(scrollAnimationRafRef.current);
    scrollAnimationRafRef.current = null;
    programmaticScrollRef.current = false;
  }, []);

  const scrollToPosition = useCallback((
    scrollTop: number,
    nextAutoScrollMode: TranscriptAutoScrollMode,
    reason: TranscriptViewportModeChangeReason,
    animated = true,
  ) => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    cancelScrollAnimation();

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
      window.requestAnimationFrame(() => {
        programmaticScrollRef.current = false;
      });
      return;
    }

    if (!animated) {
      viewport.scrollTop = targetScrollTop;
      lastScrollTopRef.current = viewport.scrollTop;
      scheduleRangeUpdate();
      window.requestAnimationFrame(() => {
        programmaticScrollRef.current = false;
      });
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
      programmaticScrollRef.current = false;
    };

    scrollAnimationRafRef.current = window.requestAnimationFrame(step);
  }, [cancelScrollAnimation, scheduleRangeUpdate, setViewportAutoScrollMode]);

  const focusNarration = useCallback((request: TranscriptNarrationFocusRequest) => {
    if (request.threadId !== activeThreadId) return;
    let attempts = 0;
    const focusWhenMounted = () => {
      const viewport = viewportRef.current;
      if (!viewport) return;
      const elements = resolveNarrationTargetElements(request.assistantMessageId, request.targetIds);
      if (elements.length === 0) {
        if (attempts === 0 && turnsRef.current.some((turn) => turn.turnId === request.turnId)) {
          const nextIds = Array.from(new Set([...activeTurnIdsRef.current, request.turnId]));
          activeTurnIdsRef.current = nextIds;
          setActiveTurnIds(nextIds);
          scheduleRangeUpdate();
        }
        attempts += 1;
        if (attempts <= 8) window.requestAnimationFrame(focusWhenMounted);
        return;
      }
      if (request.reason === 'follow' && nativeScrollOwnsTranscriptViewport(nativeScrollPhaseRef.current)) {
        return;
      }
      const viewportBounds = viewport.getBoundingClientRect();
      const composerTop = document.querySelector<HTMLElement>('[data-remux-composer-root]')
        ?.getBoundingClientRect().top ?? viewportBounds.bottom;
      const usableBottom = Math.min(viewportBounds.bottom, composerTop);
      const usableHeight = Math.max(1, usableBottom - viewportBounds.top);
      const bounds = elements.map((element) => element.getBoundingClientRect());
      const targetTop = Math.min(...bounds.map((bound) => bound.top));
      const targetBottom = Math.max(...bounds.map((bound) => bound.bottom));
      const bandTop = viewportBounds.top + usableHeight * 0.22;
      const bandBottom = viewportBounds.top + usableHeight * 0.65;
      if (request.reason === 'follow' && targetTop >= bandTop && targetBottom <= bandBottom) {
        return;
      }
      const desiredScrollTop = viewport.scrollTop
        + targetTop
        - viewportBounds.top
        - usableHeight * 0.30;
      scrollToPosition(
        desiredScrollTop,
        { type: 'off' },
        'narration-focus',
        request.reason !== 'follow',
      );
    };
    focusWhenMounted();
  }, [activeThreadId, scheduleRangeUpdate, scrollToPosition, setActiveTurnIds]);

  const scrollUp = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    const anchor = previousScrollAnchor(navigationAnchorsRef.current, viewport);
    if (!anchor) {
      return;
    }

    const nextMode = anchor === lastScrollAnchor(navigationAnchorsRef.current) && anchor.turnId === streamingTurnIdRef.current
      ? { type: 'sent-message-anchor' as const, turnId: anchor.turnId }
      : { type: 'off' as const };
    scrollToPosition(anchor.scrollTop, nextMode, 'scroll-navigation');
  }, [scrollToPosition]);

  const scrollDown = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    const anchor = nextScrollAnchor(navigationAnchorsRef.current, viewport);
    if (anchor) {
      const nextMode = anchor === lastScrollAnchor(navigationAnchorsRef.current) && anchor.turnId === streamingTurnIdRef.current
        ? { type: 'sent-message-anchor' as const, turnId: anchor.turnId }
        : { type: 'off' as const };
      scrollToPosition(anchor.scrollTop, nextMode, 'scroll-navigation');
      return;
    }

    if (isNearBottom(viewport)) {
      return;
    }

    scrollToPosition(viewport.scrollHeight, { type: 'bottom' }, 'scroll-navigation-bottom');
  }, [scrollToPosition]);

  useEffect(() => {
    setScrollNavigationController({ focusNarration, scrollDown, scrollUp });
    return () => setScrollNavigationController(null);
  }, [focusNarration, scrollDown, scrollUp, setScrollNavigationController]);

  useLayoutEffect(() => {
    if (
      !requestedTurnScroll ||
      requestedTurnScroll.id === handledTurnScrollRequestIdRef.current ||
      requestedTurnScroll.threadId !== activeThreadId ||
      status !== 'ready' ||
      width === null
    ) {
      return;
    }

    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    const desiredScrollTop = anchorTurnUserMessageScrollTop({
      expandedRows,
      topPadding: viewportTopPadding,
      turns,
      turnId: requestedTurnScroll.turnId,
    });
    if (desiredScrollTop === null) {
      return;
    }

    handledTurnScrollRequestIdRef.current = requestedTurnScroll.id;
    scrollToPosition(desiredScrollTop, { type: 'off' }, 'host-navigate');
  }, [
    expandedRows,
    activeThreadId,
    requestedTurnScroll,
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

    const updateStickiness = () => {
      const currentScrollTop = viewport.scrollTop;

      if (
        programmaticScrollRef.current ||
        nativeScrollOwnsTranscriptViewport(nativeScrollPhaseRef.current)
      ) {
        lastScrollTopRef.current = currentScrollTop;
        return;
      }

      const nearBottom = isNearBottom(viewport);
      const movedManually = Math.abs(currentScrollTop - lastScrollTopRef.current) > scrollDirectionThresholdPx;

      if (nearBottom) {
        setViewportAutoScrollMode({ type: 'bottom' }, 'manual-scroll');
      } else if (movedManually) {
        setViewportAutoScrollMode({ type: 'off' }, 'manual-scroll');
      }

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
      if (nativeScrollPhaseRef.current !== 'momentum') {
        return;
      }

      nativeScrollPhaseRef.current = transcriptNativeScrollPhaseAfterEvent(
        nativeScrollPhaseRef.current,
        'settle',
      );
      lastScrollTopRef.current = viewport.scrollTop;
      captureViewportAnchor();
      scheduleRangeUpdate();

      const mode = autoScrollModeAfterNativeScrollSettles({
        nearBottom: isNearBottom(viewport),
      });
      setViewportAutoScrollMode(mode, 'scroll-settled');
      if (mode.type === 'off') {
        return;
      }
      scheduleAutoScroll();
    };
    const scheduleUserScrollSettleFallback = () => {
      clearScrollSettleTimer();
      scrollSettleTimer = window.setTimeout(finishUserScroll, touchScrollSettleDelayMs);
    };
    const onScroll = () => {
      if (!programmaticScrollRef.current && nativeScrollPhaseRef.current === 'momentum') {
        notifyTranscriptNarrationManualScroll();
      }
      updateStickiness();
      scheduleRangeUpdate();
      if (nativeScrollPhaseRef.current === 'momentum') {
        scheduleUserScrollSettleFallback();
      }
    };
    const onTouchStart = () => {
      clearScrollSettleTimer();
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
    const onWheel = () => notifyTranscriptNarrationManualScroll();
    const onTouchEnd = () => {
      nativeScrollPhaseRef.current = transcriptNativeScrollPhaseAfterEvent(
        nativeScrollPhaseRef.current,
        'touch-end',
      );
      scheduleUserScrollSettleFallback();
    };
    const observer = new ResizeObserver(scheduleRangeUpdate);

    viewport.addEventListener('scroll', onScroll, { passive: true });
    viewport.addEventListener('touchstart', onTouchStart, { passive: true });
    viewport.addEventListener('touchcancel', onTouchEnd, { passive: true });
    viewport.addEventListener('touchend', onTouchEnd, { passive: true });
    viewport.addEventListener('wheel', onWheel, { passive: true });
    viewport.addEventListener('scrollend', finishUserScroll, { passive: true });
    observer.observe(viewport);
    lastScrollTopRef.current = viewport.scrollTop;
    setViewportAutoScrollMode(isNearBottom(viewport) ? { type: 'bottom' } : { type: 'off' }, 'mount-stickiness');
    scheduleRangeUpdate();

    return () => {
      viewport.removeEventListener('scroll', onScroll);
      viewport.removeEventListener('touchstart', onTouchStart);
      viewport.removeEventListener('touchcancel', onTouchEnd);
      viewport.removeEventListener('touchend', onTouchEnd);
      viewport.removeEventListener('wheel', onWheel);
      viewport.removeEventListener('scrollend', finishUserScroll);
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
    scheduleAutoScroll,
    scheduleRangeUpdate,
    setViewportAutoScrollMode,
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

    const restoredScrollTop = scrollTopForViewportAnchor({
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
      width === null ||
      autoScrollModeRef.current.type === 'off' ||
      nativeScrollOwnsTranscriptViewport(nativeScrollPhaseRef.current)
    ) {
      return;
    }

    scheduleAutoScroll();
  }, [autoScrollMode, expandedRows, scheduleAutoScroll, status, turns, width]);

  const validActiveTurnIds = activeTurnIds.filter((turnId) => Boolean(turnsById[turnId]));
  const renderTurnIds = validActiveTurnIds.length > 0 ? validActiveTurnIds : initialTranscriptActiveTurnIds(turns);
  const renderTurns = renderTurnIds
    .map((turnId) => turnsById[turnId])
    .filter((turn): turn is TranscriptMeasuredTurn => Boolean(turn));
  const spacerRange = computeTranscriptSpacerRange({
    activeTurnIds: renderTurnIds,
    expandedRows,
    turns,
  });

  useLayoutEffect(() => {
    if (status !== 'ready' || !activeThreadId || width === null) {
      return;
    }

    if (initialScrollThreadIdRef.current === activeThreadId) {
      return;
    }

    if (
      runtimeResourceStatus === 'loading' ||
      (runtimeThreadId !== activeThreadId && runtimeResourceStatus !== 'idle')
    ) {
      return;
    }

    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    initialScrollThreadIdRef.current = activeThreadId;
    const initialTarget = initialTranscriptScrollTarget({
      anchors: navigationAnchors,
      streamingTurnId,
    });
    const initialMode = initialTarget?.mode ?? { type: 'bottom' as const };
    const initialScrollTop = initialTarget
      ? Math.max(0, Math.min(initialTarget.scrollTop, maxScrollableTop(viewport)))
      : maxScrollableTop(viewport);
    setViewportAutoScrollMode(initialMode, 'initial-scroll');
    programmaticScrollRef.current = true;
    viewport.scrollTop = initialScrollTop;
    lastScrollTopRef.current = viewport.scrollTop;
    window.requestAnimationFrame(() => {
      programmaticScrollRef.current = false;
    });
    scheduleRangeUpdate();
  }, [
    activeThreadId,
    navigationAnchors,
    runtimeResourceStatus,
    runtimeThreadId,
    scheduleRangeUpdate,
    setViewportAutoScrollMode,
    status,
    streamingTurnId,
    width,
  ]);

  return (
    <div className="remux-transcript-viewport h-full min-h-0 flex-1 overflow-y-auto overflow-x-hidden bg-background" ref={viewportRef}>
      <div className="mx-auto min-h-full w-full max-w-[var(--remux-feed-max-width)] px-[var(--remux-feed-pad-x)]">
        <div
          className="relative flex min-w-0 flex-col"
          ref={measureRef}
          style={{
            paddingBottom: `${transcriptLayout.viewport.padY}px`,
            paddingTop: `max(${transcriptLayout.viewport.padY}px, env(safe-area-inset-top))`,
          }}
        >
          {width === null ? null : (
            <VirtualizedTranscriptBody
              bottomSpacerHeight={spacerRange.bottomSpacerHeight}
              status={status}
              threadId={activeThreadId}
              topSpacerHeight={spacerRange.topSpacerHeight}
              totalTurnCount={turns.length}
              turns={renderTurns}
              width={width}
            />
          )}
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
    (right.type === 'sent-message-anchor' && left.turnId === right.turnId)
  );
}

function autoScrollTarget({
  expandedRows,
  mode,
  topPadding,
  turns,
  viewport,
}: {
  expandedRows: TranscriptExpandedRow[];
  mode: TranscriptAutoScrollMode;
  topPadding: number;
  turns: TranscriptMeasuredTurn[];
  viewport: HTMLElement;
}): { scrollTop: number } | null {
  if (mode.type === 'bottom') {
    return { scrollTop: maxScrollableTop(viewport) };
  }

  if (mode.type !== 'sent-message-anchor') {
    return null;
  }

  const desiredScrollTop = anchorTurnUserMessageScrollTop({
    expandedRows,
    topPadding,
    turns,
    turnId: mode.turnId,
  });

  if (desiredScrollTop === null) {
    return null;
  }

  const maxScrollTop = maxScrollableTop(viewport);
  const scrollTop = Math.max(0, Math.min(desiredScrollTop, maxScrollTop));
  return { scrollTop };
}

function scrollNavigationAvailability(node: HTMLElement, anchors: TranscriptScrollAnchor[]) {
  return {
    canScrollDown: Boolean(nextScrollAnchor(anchors, node)) || !isNearBottom(node),
    canScrollUp: Boolean(previousScrollAnchor(anchors, node)),
  };
}

function previousScrollAnchor(anchors: TranscriptScrollAnchor[], node: HTMLElement) {
  const maxScrollTop = maxScrollableTop(node);
  const target = node.scrollTop - scrollNavigationThresholdPx;

  for (let index = anchors.length - 1; index >= 0; index -= 1) {
    const anchor = anchors[index];
    if (anchor && clampedAnchorScrollTop(anchor, maxScrollTop) < target) {
      return anchor;
    }
  }

  return null;
}

function nextScrollAnchor(anchors: TranscriptScrollAnchor[], node: HTMLElement) {
  const maxScrollTop = maxScrollableTop(node);
  const target = node.scrollTop + scrollNavigationThresholdPx;
  return anchors.find((anchor) => clampedAnchorScrollTop(anchor, maxScrollTop) > target) ?? null;
}

function lastScrollAnchor(anchors: TranscriptScrollAnchor[]) {
  return anchors[anchors.length - 1] ?? null;
}

function clampedAnchorScrollTop(anchor: TranscriptScrollAnchor, maxScrollTop: number) {
  return Math.max(0, Math.min(anchor.scrollTop, maxScrollTop));
}

function maxScrollableTop(node: HTMLElement) {
  return Math.max(0, node.scrollHeight - node.clientHeight);
}

function parseCssPixels(value: string, fallback: number) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
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

function userMessageScrollAnchors({
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
          scrollTop: userMessageAnchorScrollTop(rowTop, topPadding),
          turnId: turn.turnId,
        });
      }

      rowTop += row.height + expanded.heightAfterRow(turn.turnId, row.id);
    }
  });

  return anchors;
}

function VirtualizedTranscriptBody({
  bottomSpacerHeight,
  status,
  threadId,
  topSpacerHeight,
  totalTurnCount,
  turns,
  width,
}: {
  bottomSpacerHeight: number;
  status: TranscriptStatus;
  threadId: string | null;
  topSpacerHeight: number;
  totalTurnCount: number;
  turns: TranscriptMeasuredTurn[];
  width: number;
}) {
  if (status === 'idle') {
    return <TranscriptFrameMessage label="No thread selected" />;
  }

  if (status === 'loading') {
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

  return (
    <>
      {topSpacerHeight > 0 ? <div aria-hidden="true" style={{ height: `${topSpacerHeight}px` }} /> : null}
      {turns.map((turn) => (
        <TranscriptTurn key={turn.turnId} threadId={threadId} turn={turn} width={width} />
      ))}
      {bottomSpacerHeight > 0 ? <div aria-hidden="true" style={{ height: `${bottomSpacerHeight}px` }} /> : null}
    </>
  );
}

const TranscriptTurn = memo(function TranscriptTurn({
  threadId,
  turn,
  width,
}: {
  threadId: string | null;
  turn: TranscriptMeasuredTurn;
  width: number;
}) {
  return (
    <div className="min-w-0" data-turn-id={turn.turnId}>
      {turn.rows.map((row) => (
        <TranscriptRow key={row.id} row={row} threadId={threadId} width={width} />
      ))}
    </div>
  );
}, areTranscriptTurnPropsEqual);

const TranscriptRow = memo(function TranscriptRow({
  row,
  threadId,
  width,
}: {
  row: TranscriptMeasuredRow;
  threadId: string | null;
  width: number;
}) {
  const workDetails = useTranscriptResourceStore((state) => {
    if (row.segment.type !== 'work' || !state.activeThreadId) {
      return null;
    }

    return state.workDetailsByKey[workDetailsResourceKey(state.activeThreadId, row.turnId, row.segment.id)]?.details ?? null;
  });

  return (
    <div
      className="min-w-0"
      data-row-kind={row.segment.type === 'work' ? 'workSection' : row.segment.type}
      data-transcript-row-id={row.id}
      data-turn-id={row.turnId}
      style={{ paddingBottom: `${rowPaddingBottom(row)}px` }}
    >
      <TranscriptSegmentBody
        rowId={row.id}
        segment={row.segment}
        showAssistantActions={row.showAssistantActions}
        showUserActions={row.showUserActions}
        threadId={threadId}
        turnStatus={row.turn.status}
        userMessageDisclosure={row.userMessageDisclosure}
        workDetails={workDetails}
        turnId={row.turnId}
        width={width}
      />
    </div>
  );
}, areTranscriptRowPropsEqual);

function areTranscriptTurnPropsEqual(
  previous: { threadId: string | null; turn: TranscriptMeasuredTurn; width: number },
  next: { threadId: string | null; turn: TranscriptMeasuredTurn; width: number },
) {
  return previous.threadId === next.threadId && previous.width === next.width && previous.turn.rows === next.turn.rows;
}

function areTranscriptRowPropsEqual(
  previous: { row: TranscriptMeasuredRow; threadId: string | null; width: number },
  next: { row: TranscriptMeasuredRow; threadId: string | null; width: number },
) {
  return previous.threadId === next.threadId && previous.width === next.width && previous.row === next.row;
}

function TranscriptSegmentBody({
  rowId,
  segment,
  showAssistantActions,
  showUserActions,
  threadId,
  turnStatus,
  userMessageDisclosure,
  workDetails,
  turnId,
  width,
}: {
  rowId: string;
  segment: CodexTranscriptSegment;
  showAssistantActions: boolean;
  showUserActions: boolean;
  threadId: string | null;
  turnStatus: TranscriptMeasuredRow['turn']['status'];
  userMessageDisclosure: TranscriptMeasuredRow['userMessageDisclosure'];
  workDetails: CodexWorkDetails | null;
  turnId: string;
  width: number;
}) {
  switch (segment.type) {
    case 'userMessage':
      return (
        <UserMessage
          disclosure={userMessageDisclosure}
          editEnabled={turnStatus !== 'inProgress'}
          laneWidth={width}
          segment={segment}
          showActions={showUserActions}
          threadId={threadId}
          turnId={turnId}
        />
      );
    case 'assistantMessage':
      return (
        <AssistantMessage
          segment={segment}
          showActions={showAssistantActions}
          threadId={threadId}
          turnStatus={turnStatus}
          turnId={turnId}
          width={width}
        />
      );
    case 'work':
      return (
        <WorkSection
          details={workDetails}
          rowId={rowId}
          segment={segment}
          threadId={threadId}
          turnId={turnId}
          width={width}
        />
      );
    case 'compaction':
      return <Compaction segment={segment} />;
  }
}

function TranscriptFrameMessage({
  icon,
  label,
}: {
  icon?: React.ReactNode;
  label: string;
}) {
  return (
    <div className="flex min-h-[240px] flex-1 items-center justify-center text-sm text-muted-foreground">
      <div className="flex items-center gap-2">
        {icon}
        <span>{label}</span>
      </div>
    </div>
  );
}

function rowPaddingBottom(row: TranscriptMeasuredRow) {
  return row.segment.type === 'work'
    ? transcriptLayout.row.workBoundaryGap
    : transcriptLayout.row.defaultGap;
}
