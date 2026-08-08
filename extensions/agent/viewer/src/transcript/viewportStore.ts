import type { TranscriptMeasuredTurn } from './layout/types';
import { createExternalStore } from './externalStore';
import { initialTranscriptActiveTurnIds, sameTurnIds } from './virtualizerRange';
import { userMessageRowMatchesId } from './virtualizerScroll';

type TranscriptScrollNavigationController = {
  scrollDown: () => void;
  scrollUp: () => void;
};

export type TranscriptAutoScrollMode =
  | { type: 'bottom' }
  | {
      phase: 'anchored' | 'catching-up';
      segmentId: string;
      conversationId: string;
      type: 'sent-message-anchor';
      turnId: string;
    }
  | { type: 'off' };

type TranscriptViewportStoreState = {
  activeTurnIds: string[];
  autoScrollMode: TranscriptAutoScrollMode;
  canScrollDown: boolean;
  canScrollUp: boolean;
  lifecycleState: 'active' | 'background' | 'inactive';
  pendingUserMessageIds: string[];
  requestedTurnScroll: TranscriptTurnScrollRequest | null;
  turnScrollError: { message: string; requestId: number } | null;
  clearTurnScroll: (requestId: number) => void;
  failTurnScroll: (requestId: number, message: string) => void;
  requestTurnScroll: (conversationId: string, turnId: string) => void;
  resolveTurnScroll: (requestId: number) => void;
  trackUserMessage: (conversationId: string, messageId: string, turnId?: string | null) => void;
  scrollDown: () => void;
  scrollUp: () => void;
  setActiveTurnIds: (activeTurnIds: string[]) => void;
  setAutoScrollMode: (mode: TranscriptAutoScrollMode) => void;
  setScrollAvailability: (availability: { canScrollDown: boolean; canScrollUp: boolean }) => void;
  setScrollNavigationController: (controller: TranscriptScrollNavigationController | null) => void;
  setLifecycleState: (state: 'active' | 'background' | 'inactive') => void;
  conversationId: string | null;
};

type TranscriptTurnScrollRequest = {
  id: number;
  conversationId: string;
  turnId: string;
};

const noopScrollNavigation = () => undefined;
let turnScrollRequestId = 0;

const actions: Pick<
  TranscriptViewportStoreState,
  | 'clearTurnScroll'
  | 'failTurnScroll'
  | 'requestTurnScroll'
  | 'resolveTurnScroll'
  | 'setActiveTurnIds'
  | 'setAutoScrollMode'
  | 'setScrollAvailability'
  | 'setScrollNavigationController'
  | 'setLifecycleState'
  | 'trackUserMessage'
> = {
  clearTurnScroll(requestId) {
    const state = viewportStore.getState();
    if (state.requestedTurnScroll?.id !== requestId) return;
    viewportStore.setState({ requestedTurnScroll: null, turnScrollError: null });
  },
  failTurnScroll(requestId, message) {
    const state = viewportStore.getState();
    if (state.requestedTurnScroll?.id !== requestId) return;
    viewportStore.setState({ turnScrollError: { message, requestId } });
  },
  requestTurnScroll(conversationId, turnId) {
    const normalizedConversationId = conversationId.trim();
    const normalizedTurnId = turnId.trim();
    if (!normalizedConversationId || !normalizedTurnId) {
      return;
    }

    turnScrollRequestId += 1;
    viewportStore.setState({
      requestedTurnScroll: {
        id: turnScrollRequestId,
        conversationId: normalizedConversationId,
        turnId: normalizedTurnId,
      },
      turnScrollError: null,
    });
  },
  resolveTurnScroll(requestId) {
    const state = viewportStore.getState();
    if (state.requestedTurnScroll?.id !== requestId) return;
    viewportStore.setState({ requestedTurnScroll: null, turnScrollError: null });
  },
  trackUserMessage(conversationId, messageId, turnId) {
    const normalizedConversationId = conversationId.trim();
    const normalizedMessageId = messageId.trim();
    const normalizedTurnId = turnId?.trim() || null;
    if (!normalizedConversationId || !normalizedMessageId) {
      return;
    }

    const state = viewportStore.getState();
    const pendingUserMessageIds = state.pendingUserMessageIds.filter((id) => id !== normalizedMessageId);
    if (!normalizedTurnId) {
      viewportStore.setState({
        pendingUserMessageIds: [...pendingUserMessageIds, normalizedMessageId].slice(-32),
        conversationId: state.conversationId ?? normalizedConversationId,
      });
      return;
    }

    viewportStore.setState({
      autoScrollMode: {
        phase: 'catching-up',
        segmentId: normalizedMessageId,
        conversationId: normalizedConversationId,
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
  lifecycleState: 'active',
  pendingUserMessageIds: [],
  requestedTurnScroll: null,
  turnScrollError: null,
  scrollDown: noopScrollNavigation,
  scrollUp: noopScrollNavigation,
  conversationId: null,
  ...actions,
});

export const useTranscriptViewportStore = viewportStore.useStore;

export function getTranscriptViewportState() {
  return viewportStore.getState();
}

export function subscribeTranscriptViewport(listener: () => void) {
  return viewportStore.subscribe(listener);
}

export function resetTranscriptViewportForConversation(conversationId?: string | null) {
  const normalizedConversationId = conversationId?.trim() || null;
  const state = viewportStore.getState();
  const requestedTurnScroll = state.requestedTurnScroll;
  const autoScrollMode =
    normalizedConversationId &&
    state.autoScrollMode.type === 'sent-message-anchor' &&
    state.autoScrollMode.conversationId === normalizedConversationId
      ? state.autoScrollMode
      : { type: 'off' as const };

  viewportStore.setState({
    activeTurnIds: [],
    autoScrollMode,
    canScrollDown: false,
    canScrollUp: false,
    pendingUserMessageIds: [],
    requestedTurnScroll:
      normalizedConversationId && requestedTurnScroll?.conversationId === normalizedConversationId
        ? requestedTurnScroll
        : null,
    turnScrollError:
      normalizedConversationId && requestedTurnScroll?.conversationId === normalizedConversationId
        ? state.turnScrollError
        : null,
    conversationId: normalizedConversationId,
  });
}

export function requestTranscriptTurnScroll(conversationId: string, turnId: string) {
  viewportStore.getState().requestTurnScroll(conversationId, turnId);
}

export function trackTranscriptUserMessage(
  conversationId: string,
  messageId: string,
  turnId?: string | null,
) {
  viewportStore.getState().trackUserMessage(conversationId, messageId, turnId);
}

export function discardTranscriptUserMessage(messageId: string) {
  const normalized = messageId.trim();
  if (!normalized) return;
  const state = viewportStore.getState();
  const pendingUserMessageIds = state.pendingUserMessageIds.filter((id) => id !== normalized);
  const autoScrollMode = state.autoScrollMode.type === 'sent-message-anchor' &&
    state.autoScrollMode.segmentId === normalized
    ? { type: 'off' as const }
    : state.autoScrollMode;
  if (
    sameStrings(state.pendingUserMessageIds, pendingUserMessageIds) &&
    sameAutoScrollMode(state.autoScrollMode, autoScrollMode)
  ) return;
  viewportStore.setState({ autoScrollMode, pendingUserMessageIds });
}

export function setTranscriptViewportLifecycleState(
  state: 'active' | 'background' | 'inactive',
) {
  viewportStore.getState().setLifecycleState(state);
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
    // Resolve a composer clientMessageId to the authoritative Agent segment.
    const resolvedMessages = new Map<string, { segmentId: string; turnId: string }>();
    for (const turn of turns) {
      for (const row of turn.rows) {
        const segment = row.segment;
        if (segment.type !== 'userMessage') {
          continue;
        }
        const trackedId = pendingUserMessageIds.find((id) =>
          userMessageRowMatchesId(row.segmentId, segment.clientMessageId, id));
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
        conversationId: state.conversationId ?? '',
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
      left.conversationId === right.conversationId &&
      left.turnId === right.turnId
    )
  );
}

function sameStrings(left: string[], right: string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
