import type { TranscriptMeasuredTurn } from './layout/types';
import { createExternalStore } from './externalStore';
import { initialTranscriptActiveTurnIds, sameTurnIds } from './virtualizerRange';
import { userMessageRowMatchesId } from './virtualizerScroll';

type TranscriptScrollNavigationController = {
  focusNarration: (request: TranscriptNarrationFocusRequest) => void;
  scrollDown: () => void;
  scrollUp: () => void;
};

export type TranscriptNarrationFocusRequest = {
  assistantMessageId: string;
  bounds?: { bottom: number; top: number };
  materializeOnly?: boolean;
  reason: 'explicitSeek' | 'explicitSeekInPlace' | 'follow' | 'followReenabled';
  blockIds: string[];
  threadId: string;
  turnId: string;
};

export type TranscriptAutoScrollMode =
  | { type: 'bottom' }
  | {
      phase: 'anchored' | 'catching-up';
      segmentId: string;
      threadId: string;
      type: 'sent-message-anchor';
      turnId: string;
    }
  // Narration playback owns programmatic scrolling; content growth at the
  // bottom must not move the viewport. The narration store claims and
  // releases this mode and mirrors losing it as a follow suspension.
  | { type: 'narration-follow' }
  | { type: 'off' };

type TranscriptViewportStoreState = {
  activeTurnIds: string[];
  autoScrollMode: TranscriptAutoScrollMode;
  canScrollDown: boolean;
  canScrollUp: boolean;
  focusNarration: (request: TranscriptNarrationFocusRequest) => void;
  lifecycleState: 'active' | 'background' | 'inactive';
  pendingUserMessageIds: string[];
  requestedTurnScroll: TranscriptTurnScrollRequest | null;
  requestTurnScroll: (threadId: string, turnId: string) => void;
  trackUserMessage: (threadId: string, messageId: string, turnId?: string | null) => void;
  scrollDown: () => void;
  scrollUp: () => void;
  setActiveTurnIds: (activeTurnIds: string[]) => void;
  setAutoScrollMode: (mode: TranscriptAutoScrollMode) => void;
  setScrollAvailability: (availability: { canScrollDown: boolean; canScrollUp: boolean }) => void;
  setScrollNavigationController: (controller: TranscriptScrollNavigationController | null) => void;
  setLifecycleState: (state: 'active' | 'background' | 'inactive') => void;
  threadId: string | null;
};

type TranscriptTurnScrollRequest = {
  id: number;
  threadId: string;
  turnId: string;
};

const noopScrollNavigation = () => undefined;
const noopNarrationFocus = (_request: TranscriptNarrationFocusRequest) => undefined;
let turnScrollRequestId = 0;

const actions: Pick<
  TranscriptViewportStoreState,
  | 'requestTurnScroll'
  | 'setActiveTurnIds'
  | 'setAutoScrollMode'
  | 'setScrollAvailability'
  | 'setScrollNavigationController'
  | 'setLifecycleState'
  | 'trackUserMessage'
> = {
  requestTurnScroll(threadId, turnId) {
    const normalizedThreadId = threadId.trim();
    const normalizedTurnId = turnId.trim();
    if (!normalizedThreadId || !normalizedTurnId) {
      return;
    }

    turnScrollRequestId += 1;
    viewportStore.setState({
      requestedTurnScroll: {
        id: turnScrollRequestId,
        threadId: normalizedThreadId,
        turnId: normalizedTurnId,
      },
    });
  },
  trackUserMessage(threadId, messageId, turnId) {
    const normalizedThreadId = threadId.trim();
    const normalizedMessageId = messageId.trim();
    const normalizedTurnId = turnId?.trim() || null;
    if (!normalizedThreadId || !normalizedMessageId) {
      return;
    }

    const state = viewportStore.getState();
    const pendingUserMessageIds = state.pendingUserMessageIds.filter((id) => id !== normalizedMessageId);
    if (!normalizedTurnId) {
      viewportStore.setState({
        pendingUserMessageIds: [...pendingUserMessageIds, normalizedMessageId].slice(-32),
        threadId: state.threadId ?? normalizedThreadId,
      });
      return;
    }

    viewportStore.setState({
      autoScrollMode: {
        phase: 'catching-up',
        segmentId: normalizedMessageId,
        threadId: normalizedThreadId,
        type: 'sent-message-anchor',
        turnId: normalizedTurnId,
      },
      pendingUserMessageIds,
    });
  },
  setActiveTurnIds(activeTurnIds) {
    if (sameTurnIds(viewportStore.getState().activeTurnIds, activeTurnIds)) {
      return;
    }

    viewportStore.setState({ activeTurnIds });
  },
  setLifecycleState(lifecycleState) {
    if (viewportStore.getState().lifecycleState === lifecycleState) return;
    viewportStore.setState({ lifecycleState });
  },
  setAutoScrollMode(autoScrollMode) {
    if (sameAutoScrollMode(viewportStore.getState().autoScrollMode, autoScrollMode)) {
      return;
    }

    viewportStore.setState({ autoScrollMode });
  },
  setScrollAvailability(availability) {
    const state = viewportStore.getState();
    if (
      state.canScrollDown === availability.canScrollDown &&
      state.canScrollUp === availability.canScrollUp
    ) {
      return;
    }

    viewportStore.setState(availability);
  },
  setScrollNavigationController(controller) {
    const state = viewportStore.getState();
    viewportStore.setState({
      canScrollDown: controller ? state.canScrollDown : false,
      canScrollUp: controller ? state.canScrollUp : false,
      focusNarration: controller?.focusNarration ?? noopNarrationFocus,
      scrollDown: controller?.scrollDown ?? noopScrollNavigation,
      scrollUp: controller?.scrollUp ?? noopScrollNavigation,
    });
  },
};

const viewportStore = createExternalStore<TranscriptViewportStoreState>({
  activeTurnIds: [],
  autoScrollMode: { type: 'off' },
  canScrollDown: false,
  canScrollUp: false,
  focusNarration: noopNarrationFocus,
  lifecycleState: 'active',
  pendingUserMessageIds: [],
  requestedTurnScroll: null,
  scrollDown: noopScrollNavigation,
  scrollUp: noopScrollNavigation,
  threadId: null,
  ...actions,
});

export const useTranscriptViewportStore = viewportStore.useStore;

export function getTranscriptViewportState() {
  return viewportStore.getState();
}

export function subscribeTranscriptViewport(listener: () => void) {
  return viewportStore.subscribe(listener);
}

export function resetTranscriptViewportForThread(threadId?: string | null) {
  const normalizedThreadId = threadId?.trim() || null;
  const state = viewportStore.getState();
  const requestedTurnScroll = state.requestedTurnScroll;
  const autoScrollMode =
    normalizedThreadId &&
    state.autoScrollMode.type === 'sent-message-anchor' &&
    state.autoScrollMode.threadId === normalizedThreadId
      ? state.autoScrollMode
      : { type: 'off' as const };

  viewportStore.setState({
    activeTurnIds: [],
    autoScrollMode,
    canScrollDown: false,
    canScrollUp: false,
    pendingUserMessageIds: [],
    requestedTurnScroll:
      normalizedThreadId && requestedTurnScroll?.threadId === normalizedThreadId
        ? requestedTurnScroll
        : null,
    threadId: normalizedThreadId,
  });
}

export function requestTranscriptTurnScroll(threadId: string, turnId: string) {
  viewportStore.getState().requestTurnScroll(threadId, turnId);
}

export function trackTranscriptUserMessage(
  threadId: string,
  messageId: string,
  turnId?: string | null,
) {
  viewportStore.getState().trackUserMessage(threadId, messageId, turnId);
}

export function setTranscriptViewportLifecycleState(
  state: 'active' | 'background' | 'inactive',
) {
  viewportStore.getState().setLifecycleState(state);
}

export function focusTranscriptNarration(request: TranscriptNarrationFocusRequest) {
  viewportStore.getState().focusNarration(request);
}

export function reconcileTranscriptViewportForLayout(
  turns: TranscriptMeasuredTurn[],
  turnsById: Record<string, TranscriptMeasuredTurn>,
) {
  const state = viewportStore.getState();
  const nextActiveTurnIds = state.activeTurnIds.filter((turnId) => turnsById[turnId]);
  const resolvedActiveTurnIds = nextActiveTurnIds.length > 0
    ? nextActiveTurnIds
    : initialTranscriptActiveTurnIds(turns);

  let autoScrollMode = state.autoScrollMode;
  let pendingUserMessageIds = state.pendingUserMessageIds;
  if (pendingUserMessageIds.length > 0) {
    // Tracked ids are composer clientMessageIds; the authoritative row keys
    // the message by the codex item id and echoes the composer id as
    // clientId. Anchor to the authoritative segment id once resolved.
    const resolvedMessages = new Map<string, { segmentId: string; turnId: string }>();
    for (const turn of turns) {
      for (const row of turn.rows) {
        const segment = row.segment;
        if (segment.type !== 'userMessage') {
          continue;
        }
        const trackedId = pendingUserMessageIds.find((id) =>
          userMessageRowMatchesId(row.segmentId, segment.clientId, id));
        if (trackedId !== undefined) {
          resolvedMessages.set(trackedId, { segmentId: row.segmentId, turnId: turn.turnId });
        }
      }
    }
    const latestResolvedId = [...pendingUserMessageIds].reverse().find((id) => resolvedMessages.has(id));
    if (latestResolvedId) {
      const resolved = resolvedMessages.get(latestResolvedId)!;
      autoScrollMode = {
        phase: 'catching-up',
        segmentId: resolved.segmentId,
        threadId: state.threadId ?? '',
        type: 'sent-message-anchor',
        turnId: resolved.turnId,
      };
      pendingUserMessageIds = pendingUserMessageIds.filter((id) => !resolvedMessages.has(id));
    }
  }

  if (
    sameTurnIds(state.activeTurnIds, resolvedActiveTurnIds) &&
    sameAutoScrollMode(state.autoScrollMode, autoScrollMode) &&
    sameStrings(state.pendingUserMessageIds, pendingUserMessageIds)
  ) {
    return;
  }

  viewportStore.setState({ activeTurnIds: resolvedActiveTurnIds, autoScrollMode, pendingUserMessageIds });
}

export function useTranscriptViewportControls() {
  return useTranscriptViewportStore((snapshot) => ({
    canScrollDown: snapshot.canScrollDown,
    canScrollUp: snapshot.canScrollUp,
    scrollDown: snapshot.scrollDown,
    scrollUp: snapshot.scrollUp,
  }), shallowEqualViewportControls);
}

function shallowEqualViewportControls(
  left: ReturnType<typeof viewportControlsSnapshot>,
  right: ReturnType<typeof viewportControlsSnapshot>,
) {
  return (
    left.canScrollDown === right.canScrollDown &&
    left.canScrollUp === right.canScrollUp &&
    left.scrollDown === right.scrollDown &&
    left.scrollUp === right.scrollUp
  );
}

function viewportControlsSnapshot(state: TranscriptViewportStoreState) {
  return {
    canScrollDown: state.canScrollDown,
    canScrollUp: state.canScrollUp,
    scrollDown: state.scrollDown,
    scrollUp: state.scrollUp,
  };
}

function sameAutoScrollMode(left: TranscriptAutoScrollMode, right: TranscriptAutoScrollMode) {
  return left.type === right.type && (
    left.type !== 'sent-message-anchor' ||
    (
      right.type === 'sent-message-anchor' &&
      left.phase === right.phase &&
      left.segmentId === right.segmentId &&
      left.threadId === right.threadId &&
      left.turnId === right.turnId
    )
  );
}

function sameStrings(left: string[], right: string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
