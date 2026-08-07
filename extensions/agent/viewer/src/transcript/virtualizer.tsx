import { Loader2 } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import type { AgentTurnSegment } from '../../../shared/transcript';
import { AssistantMessage } from './components/assistantMessage';
import { UserMessage } from './components/userMessage';
import { WorkSection } from './components/work/WorkSection';
import { transcriptLayout } from './layout/constants';
import type { TranscriptMeasuredRow } from './layout/types';
import { useTranscriptLayoutStore } from './layoutStore';
import { useTranscriptResourceStore } from './resourceStore';
import { useTranscriptViewportStore } from './viewportStore';
import {
  computeTranscriptVirtualRange,
  initialTranscriptActiveTurnIds,
  type TranscriptExpandedRow,
} from './virtualizerRange';
import {
  anchorUserMessageScrollTop,
  autoScrollModeAfterNativeScrollSettles,
  autoScrollModeForStreamingTurn,
  resolveSentMessageScroll,
  userMessageScrollAnchors,
} from './virtualizerScroll';

const nearBottomTolerancePx = 32;

export function VirtualizedTranscript({
  conversationId,
}: {
  conversationId: string;
}) {
  const activeConversationId = useTranscriptResourceStore((state) => state.activeConversationId);
  const setActiveConversationId = useTranscriptResourceStore((state) => state.setActiveConversationId);
  const status = useTranscriptResourceStore((state) => state.status);
  const error = useTranscriptResourceStore((state) => state.error);
  const windowState = useTranscriptResourceStore((state) => state.window);
  const loadEarlier = useTranscriptResourceStore((state) => state.loadEarlierTranscriptResources);
  const loadLater = useTranscriptResourceStore((state) => state.loadLaterTranscriptResources);
  const workingTurnId = useTranscriptResourceStore((state) => state.workingTurnId);
  const turns = useTranscriptLayoutStore(
    (state) => state.turnOrder.flatMap((turnId) =>
      state.turnsById[turnId] ? [state.turnsById[turnId]!] : []),
    sameReferences,
  );
  const width = useTranscriptLayoutStore((state) => state.width);
  const setWidth = useTranscriptLayoutStore((state) => state.setWidth);
  const disclosure = useTranscriptLayoutStore((state) => state.disclosure);
  const activeTurnIds = useTranscriptViewportStore((state) => state.activeTurnIds);
  const setActiveTurnIds = useTranscriptViewportStore((state) => state.setActiveTurnIds);
  const autoScrollMode = useTranscriptViewportStore((state) => state.autoScrollMode);
  const setAutoScrollMode = useTranscriptViewportStore((state) => state.setAutoScrollMode);
  const setScrollAvailability = useTranscriptViewportStore((state) => state.setScrollAvailability);
  const setScrollNavigationController = useTranscriptViewportStore((state) => state.setScrollNavigationController);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const laneRef = useRef<HTMLDivElement | null>(null);
  const programmaticScroll = useRef(false);
  const previousTotalHeight = useRef(0);
  const sentAnchorRunway = useRef(0);
  const sentAnchorPinned = useRef(false);
  const [scrollMetrics, setScrollMetrics] = useState({ scrollTop: 0, viewportHeight: 1 });

  useEffect(() => {
    void setActiveConversationId(conversationId);
    return () => {
      void setActiveConversationId(null);
    };
  }, [conversationId, setActiveConversationId]);

  useLayoutEffect(() => {
    const lane = laneRef.current;
    if (!lane) return;
    const publish = () => void setWidth(lane.getBoundingClientRect().width);
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(lane);
    return () => observer.disconnect();
  }, [setWidth]);

  const expandedRows = useMemo<TranscriptExpandedRow[]>(() =>
    Object.values(disclosure.openWorkByKey).map((openWork) => ({
      additionalHeight: openWork.additionalHeight,
      rowId: openWork.rowId,
      turnId: openWork.turnId,
    })), [disclosure.openWorkByKey]);

  const navigationAnchors = useMemo(() => userMessageScrollAnchors({
    expandedRows,
    topPadding: transcriptLayout.viewport.padY,
    turns,
  }), [expandedRows, turns]);

  const range = useMemo(() => computeTranscriptVirtualRange({
    expandedRows,
    scrollTop: scrollMetrics.scrollTop,
    topPadding: transcriptLayout.viewport.padY,
    turns,
    viewportHeight: scrollMetrics.viewportHeight,
  }), [activeTurnIds, expandedRows, scrollMetrics, turns]);

  useEffect(() => {
    const next = range.activeTurnIds.length > 0
      ? range.activeTurnIds
      : initialTranscriptActiveTurnIds(turns);
    if (!sameStrings(activeTurnIds, next)) setActiveTurnIds(next);
  }, [activeTurnIds, range.activeTurnIds, setActiveTurnIds, turns]);

  const totalHeight = turns.reduce((sum, turn) => sum + turn.collapsedHeight, 0) +
    expandedRows.reduce((sum, row) => sum + row.additionalHeight, 0) +
    transcriptLayout.viewport.padY * 2 +
    sentAnchorRunway.current;

  const publishScrollMetrics = useCallback((userInitiated: boolean) => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const scrollTop = scroller.scrollTop;
    const viewportHeight = scroller.clientHeight;
    const maxScrollTop = Math.max(0, scroller.scrollHeight - viewportHeight);
    const nearBottom = maxScrollTop - scrollTop <= nearBottomTolerancePx;
    setScrollMetrics({ scrollTop, viewportHeight });
    setScrollAvailability({
      canScrollDown: scrollTop < maxScrollTop - 1,
      canScrollUp: scrollTop > 1,
    });
    if (userInitiated) {
      setAutoScrollMode(autoScrollModeAfterNativeScrollSettles({
        currentMode: autoScrollMode,
        nearBottom,
        userInitiated: true,
      }));
      sentAnchorPinned.current = false;
      sentAnchorRunway.current = 0;
    }
  }, [autoScrollMode, setAutoScrollMode, setScrollAvailability]);

  const scrollTo = useCallback((target: number, mode: { type: 'bottom' } | { type: 'off' }) => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    programmaticScroll.current = true;
    setAutoScrollMode(mode);
    scroller.scrollTop = Math.max(0, Math.min(target, scroller.scrollHeight - scroller.clientHeight));
    publishScrollMetrics(false);
    window.requestAnimationFrame(() => {
      programmaticScroll.current = false;
    });
  }, [publishScrollMetrics, setAutoScrollMode]);

  const scrollUp = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const anchor = [...navigationAnchors].reverse()
      .find((candidate) => candidate.scrollTop < scroller.scrollTop - 12);
    if (anchor) scrollTo(anchor.scrollTop, { type: 'off' });
  }, [navigationAnchors, scrollTo]);

  const scrollDown = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const anchor = navigationAnchors.find((candidate) => candidate.scrollTop > scroller.scrollTop + 12);
    if (anchor) {
      scrollTo(anchor.scrollTop, { type: 'off' });
      return;
    }
    scrollTo(scroller.scrollHeight, { type: 'bottom' });
  }, [navigationAnchors, scrollTo]);

  useEffect(() => {
    setScrollNavigationController({ scrollDown, scrollUp });
    return () => setScrollNavigationController(null);
  }, [scrollDown, scrollUp, setScrollNavigationController]);

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || status !== 'ready' || turns.length === 0) return;
    const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    const currentNearBottom = maxScrollTop - scroller.scrollTop <= nearBottomTolerancePx;
    const nextMode = autoScrollModeForStreamingTurn({
      currentMode: autoScrollMode,
      nearBottom: currentNearBottom,
      streamingTurnId: workingTurnId,
    });
    if (nextMode.type !== autoScrollMode.type) setAutoScrollMode(nextMode);

    let target: number | null = null;
    if (nextMode.type === 'bottom') {
      target = maxScrollTop;
    } else if (nextMode.type === 'sent-message-anchor') {
      const desired = anchorUserMessageScrollTop({
        expandedRows,
        segmentId: nextMode.segmentId,
        topPadding: transcriptLayout.viewport.padY,
        turnId: nextMode.turnId,
        turns,
      });
      if (desired !== null) {
        const resolution = resolveSentMessageScroll({
          currentScrollTop: scroller.scrollTop,
          desiredScrollTop: desired,
          naturalMaxScrollTop: maxScrollTop - sentAnchorRunway.current,
          phase: nextMode.phase,
          runwayHeight: sentAnchorRunway.current,
          viewportGrew: false,
          wasPinned: sentAnchorPinned.current,
        });
        sentAnchorRunway.current = resolution.runwayHeight;
        sentAnchorPinned.current = resolution.phase === 'anchored';
        target = resolution.scrollTop;
        if (resolution.phase !== nextMode.phase) {
          setAutoScrollMode({ ...nextMode, phase: resolution.phase });
        }
      }
    } else if (previousTotalHeight.current === 0) {
      target = maxScrollTop;
      setAutoScrollMode({ type: 'bottom' });
    }
    previousTotalHeight.current = totalHeight;
    if (target !== null) {
      programmaticScroll.current = true;
      scroller.scrollTop = target;
      publishScrollMetrics(false);
      requestAnimationFrame(() => {
        programmaticScroll.current = false;
      });
    }
  }, [
    autoScrollMode,
    expandedRows,
    publishScrollMetrics,
    setAutoScrollMode,
    status,
    totalHeight,
    turns,
    workingTurnId,
  ]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const resize = new ResizeObserver(() => publishScrollMetrics(false));
    resize.observe(scroller);
    publishScrollMetrics(false);
    return () => resize.disconnect();
  }, [publishScrollMetrics]);

  if (activeConversationId !== conversationId || status === 'idle' || status === 'loading' || width === null) {
    return (
      <div className="codex-transcript-scroll" ref={scrollerRef}>
        <div className="codex-transcript-lane" ref={laneRef}>
          <div className="agent-transcript-state"><Loader2 className="size-4 animate-spin" /> Loading transcript…</div>
        </div>
      </div>
    );
  }
  if (status === 'failed') {
    return <div className="agent-transcript-state agent-transcript-failed">{error ?? 'Transcript unavailable.'}</div>;
  }
  if (turns.length === 0) {
    return (
      <div className="agent-empty">
        <h2>Start with the work, not the ceremony.</h2>
        <p>This conversation is ephemeral and exposes only bounded workspace reads.</p>
      </div>
    );
  }

  const active = new Set(range.activeTurnIds);
  return (
    <div
      className="codex-transcript-scroll"
      data-testid="agent-transcript-scroll"
      onScroll={() => publishScrollMetrics(!programmaticScroll.current)}
      onTouchStart={() => {
        programmaticScroll.current = false;
        setAutoScrollMode({ type: 'off' });
      }}
      onWheel={() => {
        programmaticScroll.current = false;
      }}
      ref={scrollerRef}
    >
      <div className="codex-transcript-lane" ref={laneRef}>
        {windowState?.hasEarlier ? (
          <button className="codex-transcript-page" onClick={() => void loadEarlier()} type="button">
            Load earlier turns
          </button>
        ) : null}
        <div aria-hidden="true" style={{ height: range.topSpacerHeight }} />
        {turns.filter((turn) => active.has(turn.turnId)).map((turn) => (
          <article className="codex-transcript-turn" data-turn-id={turn.turnId} key={turn.turnId}>
            {turn.rows.map((row) => (
              <TranscriptRow
                conversationId={conversationId}
                key={row.id}
                laneWidth={width}
                row={row}
              />
            ))}
            {turn.turn.error ? (
              <div className="codex-turn-error" role="alert">{turn.turn.error.message}</div>
            ) : null}
          </article>
        ))}
        <div aria-hidden="true" style={{ height: range.bottomSpacerHeight + sentAnchorRunway.current }} />
        {windowState?.hasLater ? (
          <button className="codex-transcript-page" onClick={() => void loadLater()} type="button">
            Load later turns
          </button>
        ) : null}
      </div>
    </div>
  );
}

function TranscriptRow({
  conversationId,
  laneWidth,
  row,
}: {
  conversationId: string;
  laneWidth: number;
  row: TranscriptMeasuredRow;
}) {
  return (
    <div
      className={`codex-transcript-row codex-transcript-row-${row.segment.type}`}
      data-segment-id={row.segmentId}
    >
      <Segment
        conversationId={conversationId}
        laneWidth={laneWidth}
        row={row}
        segment={row.segment}
      />
    </div>
  );
}

function Segment({
  conversationId,
  laneWidth,
  row,
  segment,
}: {
  conversationId: string;
  laneWidth: number;
  row: TranscriptMeasuredRow;
  segment: AgentTurnSegment;
}) {
  if (segment.type === 'userMessage') {
    return (
      <UserMessage
        disclosure={row.userMessageDisclosure}
        laneWidth={laneWidth}
        segment={segment}
        showActions={row.showUserActions}
        turnId={row.turnId}
      />
    );
  }
  if (segment.type === 'assistantMessage') {
    return (
      <AssistantMessage
        segment={segment}
        showActions={row.showAssistantActions}
        turnStatus={row.turn.status}
        width={laneWidth}
      />
    );
  }
  return (
    <WorkSection
      conversationId={conversationId}
      laneWidth={laneWidth}
      rowId={row.id}
      segment={segment}
      turnId={row.turnId}
    />
  );
}

function sameStrings(left: string[], right: string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameReferences<T>(left: T[], right: T[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export { VirtualizedTranscript as AgentTranscript };
export default VirtualizedTranscript;
