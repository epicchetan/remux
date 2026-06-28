import type { TranscriptMeasuredTurn } from './layout/types';
import { createExternalStore } from './externalStore';
import { initialTranscriptActiveTurnIds, sameTurnIds } from './virtualizerRange';

type TranscriptScrollNavigationController = {
  scrollDown: () => void;
  scrollUp: () => void;
};

export type TranscriptAutoScrollMode =
  | { type: 'bottom' }
  | { type: 'sent-message-anchor'; turnId: string }
  | { type: 'off' };

type TranscriptViewportStoreState = {
  activeTurnIds: string[];
  autoScrollMode: TranscriptAutoScrollMode;
  canScrollDown: boolean;
  canScrollUp: boolean;
  scrollDown: () => void;
  scrollUp: () => void;
  setActiveTurnIds: (activeTurnIds: string[]) => void;
  setAutoScrollMode: (mode: TranscriptAutoScrollMode) => void;
  setScrollAvailability: (availability: { canScrollDown: boolean; canScrollUp: boolean }) => void;
  setScrollNavigationController: (controller: TranscriptScrollNavigationController | null) => void;
  setVisibleWorkKeys: (visibleWorkKeys: string[]) => void;
  visibleWorkKeys: string[];
};

const noopScrollNavigation = () => undefined;

const actions: Pick<
  TranscriptViewportStoreState,
  | 'setActiveTurnIds'
  | 'setAutoScrollMode'
  | 'setScrollAvailability'
  | 'setScrollNavigationController'
  | 'setVisibleWorkKeys'
> = {
  setActiveTurnIds(activeTurnIds) {
    if (sameTurnIds(viewportStore.getState().activeTurnIds, activeTurnIds)) {
      return;
    }

    viewportStore.setState({ activeTurnIds });
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
  setVisibleWorkKeys(visibleWorkKeys) {
    if (sameTurnIds(viewportStore.getState().visibleWorkKeys, visibleWorkKeys)) {
      return;
    }

    viewportStore.setState({ visibleWorkKeys });
  },
};

const viewportStore = createExternalStore<TranscriptViewportStoreState>({
  activeTurnIds: [],
  autoScrollMode: { type: 'off' },
  canScrollDown: false,
  canScrollUp: false,
  scrollDown: noopScrollNavigation,
  scrollUp: noopScrollNavigation,
  visibleWorkKeys: [],
  ...actions,
});

export const useTranscriptViewportStore = viewportStore.useStore;

export function getTranscriptViewportState() {
  return viewportStore.getState();
}

export function resetTranscriptViewportForThread() {
  viewportStore.setState({
    activeTurnIds: [],
    autoScrollMode: { type: 'off' },
    canScrollDown: false,
    canScrollUp: false,
    visibleWorkKeys: [],
  });
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

  if (sameTurnIds(state.activeTurnIds, resolvedActiveTurnIds)) {
    return;
  }

  viewportStore.setState({ activeTurnIds: resolvedActiveTurnIds });
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
    (right.type === 'sent-message-anchor' && left.turnId === right.turnId)
  );
}
