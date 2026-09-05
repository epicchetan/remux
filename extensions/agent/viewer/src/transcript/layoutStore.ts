import type { AgentTurnRenderFrame } from '../../../shared/transcript';
import {
  emptyTranscriptDisclosureState,
  reconcileTranscriptDisclosure,
  setOnlyOpenWorkChildDisclosure as reduceOnlyOpenWorkChildDisclosure,
  setOpenWorkAdditionalHeight as reduceOpenWorkAdditionalHeight,
  toggleUserMessageDisclosure as reduceUserMessageDisclosure,
  toggleWorkChildDisclosure as reduceWorkChildDisclosure,
  toggleWorkDisclosure as reduceWorkDisclosure,
  type TranscriptDisclosureState,
} from './disclosure/disclosureReducer';
import { createExternalStore } from './externalStore';
import { TranscriptMeasureCache } from './layout/measureCache';
import { reconcileMeasuredTranscript } from './layout/reconcileMeasured';
import type { TranscriptMeasuredTurn, TranscriptTurnDisplayFooter } from './layout/types';
import {
  reconcileTranscriptViewportForLayout,
  resetTranscriptViewportForConversation,
} from './viewportStore';

export type TranscriptLayoutResourceSnapshot = {
  activeConversationId: string | null;
  activeTurnId: string | null;
  status: 'idle' | 'loading' | 'ready' | 'failed';
  turnOrder: string[];
  turnsById: Record<string, { turn: AgentTurnRenderFrame; displayFooter: TranscriptTurnDisplayFooter } | undefined>;
};

type TranscriptLayoutResourceAdapter = {
  getSnapshot: () => TranscriptLayoutResourceSnapshot;
  loadActiveTranscript: () => Promise<void>;
};

type TranscriptLayoutStoreState = {
  activeTurnId: string | null;
  disclosure: TranscriptDisclosureState;
  turnOrder: string[];
  turnsById: Record<string, TranscriptMeasuredTurn>;
  width: number | null;
  setOnlyOpenWorkChildDisclosure: (workKey: string, keys: string[], openKey: string | null) => void;
  setOpenWorkAdditionalHeight: (workKey: string, rowId: string, additionalHeight: number) => void;
  setWidth: (width: number) => Promise<void>;
  toggleUserMessageDisclosure: (input: { segmentId: string; turnId: string }) => void;
  toggleWorkChildDisclosure: (workKey: string, key: string, defaultOpen?: boolean) => void;
  toggleWorkDisclosure: (input: { rowId: string; segmentId: string; turnId: string }) => void;
};

const transcriptMeasureCache = new TranscriptMeasureCache();
const transcriptLayoutCache = new Map<string, Pick<
  TranscriptLayoutStoreState,
  'disclosure' | 'turnOrder' | 'turnsById'
>>();
const MAX_CACHED_TRANSCRIPT_LAYOUTS = 5;
let activeLayoutConversationId: string | null = null;
let resourceAdapter: TranscriptLayoutResourceAdapter | null = null;

const actions: Pick<
  TranscriptLayoutStoreState,
  | 'setOnlyOpenWorkChildDisclosure'
  | 'setOpenWorkAdditionalHeight'
  | 'setWidth'
  | 'toggleUserMessageDisclosure'
  | 'toggleWorkChildDisclosure'
  | 'toggleWorkDisclosure'
> = {
  setOnlyOpenWorkChildDisclosure(workKey, keys, openKey) {
    const disclosure = layoutStore.getState().disclosure;
    const next = reduceOnlyOpenWorkChildDisclosure(disclosure, workKey, keys, openKey);
    if (next !== disclosure) layoutStore.setState({ disclosure: next });
  },
  setOpenWorkAdditionalHeight(workKey, rowId, additionalHeight) {
    const disclosure = layoutStore.getState().disclosure;
    const next = reduceOpenWorkAdditionalHeight(disclosure, workKey, rowId, additionalHeight);
    if (next !== disclosure) layoutStore.setState({ disclosure: next });
  },
  async setWidth(width) {
    const state = layoutStore.getState();
    if (state.width !== null && Math.abs(state.width - width) <= 0.5) return;
    layoutStore.setState({ width });

    const resourceSnapshot = resourceAdapter?.getSnapshot();
    if (!resourceSnapshot?.activeConversationId) return;
    if (resourceSnapshot.status === 'ready') {
      reconcileTranscriptLayoutFromResources(resourceSnapshot, { forceFullMeasure: true });
      return;
    }
    if (resourceSnapshot.status === 'idle' || resourceSnapshot.status === 'loading') {
      await resourceAdapter?.loadActiveTranscript();
    }
  },
  toggleUserMessageDisclosure(input) {
    const state = layoutStore.getState();
    layoutStore.setState({
      disclosure: reduceUserMessageDisclosure(state.disclosure, input),
    });
    const resourceSnapshot = resourceAdapter?.getSnapshot();
    if (resourceSnapshot?.status === 'ready') {
      reconcileTranscriptLayoutFromResources(resourceSnapshot);
    }
  },
  toggleWorkChildDisclosure(workKey, key, defaultOpen = false) {
    const disclosure = layoutStore.getState().disclosure;
    const next = reduceWorkChildDisclosure(disclosure, workKey, key, defaultOpen);
    if (next !== disclosure) layoutStore.setState({ disclosure: next });
  },
  toggleWorkDisclosure(input) {
    const state = layoutStore.getState();
    const disclosure = reduceWorkDisclosure({
      activeTurnId: state.activeTurnId,
      disclosure: state.disclosure,
      input,
      turnsById: state.turnsById,
    });
    if (disclosure !== state.disclosure) layoutStore.setState({ disclosure });
  },
};

const layoutStore = createExternalStore<TranscriptLayoutStoreState>({
  activeTurnId: null,
  disclosure: emptyTranscriptDisclosureState(),
  turnOrder: [],
  turnsById: {},
  width: null,
  ...actions,
});

export const useTranscriptLayoutStore = layoutStore.useStore;

export function getTranscriptLayoutState() {
  return layoutStore.getState();
}

export function configureTranscriptLayoutResourceAdapter(adapter: TranscriptLayoutResourceAdapter) {
  resourceAdapter = adapter;
}

export function resetTranscriptLayoutForConversation(
  conversationId?: string | null,
  options: { restoreCached?: boolean } = {},
) {
  const normalizedConversationId = conversationId?.trim() || null;
  if (activeLayoutConversationId) {
    const state = layoutStore.getState();
    transcriptLayoutCache.delete(activeLayoutConversationId);
    transcriptLayoutCache.set(activeLayoutConversationId, {
      disclosure: state.disclosure,
      turnOrder: state.turnOrder,
      turnsById: state.turnsById,
    });
    while (transcriptLayoutCache.size > MAX_CACHED_TRANSCRIPT_LAYOUTS) {
      const oldestConversationId = transcriptLayoutCache.keys().next().value as string | undefined;
      if (!oldestConversationId) break;
      transcriptLayoutCache.delete(oldestConversationId);
    }
  }

  const cached = normalizedConversationId && options.restoreCached !== false
    ? transcriptLayoutCache.get(normalizedConversationId)
    : undefined;
  if (normalizedConversationId && cached) {
    transcriptLayoutCache.delete(normalizedConversationId);
    transcriptLayoutCache.set(normalizedConversationId, cached);
  }
  activeLayoutConversationId = normalizedConversationId;
  layoutStore.setState({
    activeTurnId: null,
    ...(cached ?? {
      disclosure: emptyTranscriptDisclosureState(),
      turnOrder: [],
      turnsById: {},
    }),
  });
  resetTranscriptViewportForConversation(normalizedConversationId);
}

export function reconcileTranscriptLayoutFromResources(
  resourceSnapshot: TranscriptLayoutResourceSnapshot,
  options: {
    dirtyTurnIds?: ReadonlySet<string>;
    forceFullMeasure?: boolean;
  } = {},
) {
  const width = layoutStore.getState().width;
  if (!resourceSnapshot.activeConversationId || width === null) return;

  const turns = resourceSnapshot.turnOrder
    .map((turnId) => resourceSnapshot.turnsById[turnId]?.turn)
    .filter((turn): turn is AgentTurnRenderFrame => Boolean(turn));
  const displayFootersByTurnId = Object.fromEntries(resourceSnapshot.turnOrder.flatMap((turnId) => {
    const footer = resourceSnapshot.turnsById[turnId]?.displayFooter;
    return footer ? [[turnId, footer]] : [];
  }));
  const previousState = layoutStore.getState();
  const layout = reconcileMeasuredTranscript({
    cache: transcriptMeasureCache,
    dirtyTurnIds: options.dirtyTurnIds,
    forceFullMeasure: options.forceFullMeasure,
    previousTurnOrder: previousState.turnOrder,
    previousTurnsById: previousState.turnsById,
    expandedUserMessageByKey: previousState.disclosure.expandedUserMessageByKey,
    conversationId: resourceSnapshot.activeConversationId,
    turns,
    displayFootersByTurnId,
    width,
  });

  // Message identity, work disclosure, and measured turns are reconciled from
  // one transcript snapshot. Neither reducer reads the separately refreshed
  // runtime resource or infers policy from the current viewport mode.
  reconcileTranscriptViewportForLayout(layout.turns, layout.turnsById);
  layoutStore.setState({
    activeTurnId: resourceSnapshot.activeTurnId,
    disclosure: reconcileTranscriptDisclosure(
      previousState.disclosure,
      layout.turns,
      resourceSnapshot.activeTurnId,
    ),
    turnOrder: layout.turns.map((turn) => turn.turnId),
    turnsById: layout.turnsById,
    width: layout.width,
  });
}

export { transcriptUserMessageDisclosureKey, transcriptWorkDisclosureKey } from './disclosureKeys';
export {
  emptyTranscriptDisclosureState,
  promoteOpenWorkDisclosure,
  reconcileTranscriptDisclosure,
} from './disclosure/disclosureReducer';
export type {
  TranscriptDisclosureState,
  TranscriptOpenWorkDisclosure,
} from './disclosure/disclosureReducer';
