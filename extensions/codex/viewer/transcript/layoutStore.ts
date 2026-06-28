import type { CodexTranscriptTurn } from '../../shared/transcript';
import { getThreadRuntimeState } from '../threads/runtimeStore';
import {
  transcriptUserMessageDisclosureKey,
  transcriptWorkDisclosureKey,
} from './disclosureKeys';
import { createExternalStore } from './externalStore';
import { TranscriptMeasureCache } from './layout/measureCache';
import { reconcileMeasuredTranscript } from './layout/reconcileMeasured';
import type { TranscriptMeasuredTurn } from './layout/types';
import {
  getTranscriptViewportState,
  reconcileTranscriptViewportForLayout,
  resetTranscriptViewportForThread,
} from './viewportStore';

export type TranscriptOpenWorkDisclosure = {
  additionalHeight: number;
  key: string;
  openChildByKey: Record<string, boolean>;
  rowId: string;
  segmentId: string;
  source: 'auto' | 'user';
  turnId: string;
};

export type TranscriptDisclosureState = {
  autoOpenWorkKey: string | null;
  expandedUserMessageByKey: Record<string, true>;
  manuallyClosedAutoWorkByTurnId: Record<string, true>;
  openWorkByKey: Record<string, TranscriptOpenWorkDisclosure>;
};

export type TranscriptLayoutResourceSnapshot = {
  activeThreadId: string | null;
  status: 'idle' | 'loading' | 'ready' | 'failed';
  turnOrder: string[];
  turnsById: Record<string, { turn: CodexTranscriptTurn } | undefined>;
};

type TranscriptDisclosureReconcileOptions = {
  autoWorkManaged?: boolean;
  visibleWorkKeys?: ReadonlySet<string>;
};

type TranscriptLayoutResourceAdapter = {
  ensureWorkDetails: (input: { segmentId: string; turnId: string }) => Promise<void>;
  getSnapshot: () => TranscriptLayoutResourceSnapshot;
  loadActiveTranscript: () => Promise<void>;
};

type TranscriptLayoutStoreState = {
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
    const openWork = disclosure.openWorkByKey[workKey];
    if (!openWork) {
      return;
    }

    const openChildByKey = { ...openWork.openChildByKey };
    for (const key of keys) {
      openChildByKey[key] = key === openKey;
    }

    layoutStore.setState({
      disclosure: promoteOpenWorkDisclosure({
        ...disclosure,
        openWorkByKey: {
          ...disclosure.openWorkByKey,
          [workKey]: {
            ...openWork,
            openChildByKey,
          },
        },
      }, workKey),
    });
  },
  setOpenWorkAdditionalHeight(workKey, rowId, additionalHeight) {
    const disclosure = layoutStore.getState().disclosure;
    const openWork = disclosure.openWorkByKey[workKey];
    if (!openWork || openWork.rowId !== rowId || openWork.additionalHeight === additionalHeight) {
      return;
    }

    layoutStore.setState({
      disclosure: {
        ...disclosure,
        openWorkByKey: {
          ...disclosure.openWorkByKey,
          [workKey]: {
            ...openWork,
            additionalHeight,
          },
        },
      },
    });
  },
  async setWidth(width) {
    const state = layoutStore.getState();
    if (state.width !== null && Math.abs(state.width - width) <= 0.5) {
      return;
    }

    layoutStore.setState({ width });

    const resourceSnapshot = resourceAdapter?.getSnapshot();
    if (!resourceSnapshot?.activeThreadId) {
      return;
    }

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
    const key = transcriptUserMessageDisclosureKey(input.turnId, input.segmentId);
    const expandedUserMessageByKey = { ...state.disclosure.expandedUserMessageByKey };
    if (expandedUserMessageByKey[key]) {
      delete expandedUserMessageByKey[key];
    } else {
      expandedUserMessageByKey[key] = true;
    }

    layoutStore.setState({
      disclosure: {
        ...state.disclosure,
        expandedUserMessageByKey,
      },
    });

    const resourceSnapshot = resourceAdapter?.getSnapshot();
    if (resourceSnapshot?.status === 'ready') {
      reconcileTranscriptLayoutFromResources(resourceSnapshot);
    }
  },
  toggleWorkChildDisclosure(workKey, key, defaultOpen = false) {
    const disclosure = layoutStore.getState().disclosure;
    const openWork = disclosure.openWorkByKey[workKey];
    if (!openWork) {
      return;
    }

    layoutStore.setState({
      disclosure: promoteOpenWorkDisclosure({
        ...disclosure,
        openWorkByKey: {
          ...disclosure.openWorkByKey,
          [workKey]: {
            ...openWork,
            openChildByKey: {
              ...openWork.openChildByKey,
              [key]: !(openWork.openChildByKey[key] ?? defaultOpen),
            },
          },
        },
      }, workKey),
    });
  },
  toggleWorkDisclosure(input) {
    const state = layoutStore.getState();
    const disclosure = state.disclosure;
    const workKey = transcriptWorkDisclosureKey(input.turnId, input.segmentId);
    const openWork = disclosure.openWorkByKey[workKey];
    const isCurrentlyOpen =
      openWork?.rowId === input.rowId &&
      openWork.segmentId === input.segmentId &&
      openWork.turnId === input.turnId;
    const manuallyClosedAutoWorkByTurnId = { ...disclosure.manuallyClosedAutoWorkByTurnId };
    const openWorkByKey = { ...disclosure.openWorkByKey };

    if (isCurrentlyOpen) {
      const runtime = getThreadRuntimeState();
      const closingRuntimeActiveTurn =
        (runtime.status === 'running' || runtime.status === 'stopping') &&
        runtime.activeTurnId === input.turnId;
      if (openWork.source === 'auto' || closingRuntimeActiveTurn) {
        manuallyClosedAutoWorkByTurnId[input.turnId] = true;
      }
      delete openWorkByKey[workKey];
      layoutStore.setState({
        disclosure: {
          autoOpenWorkKey: disclosure.autoOpenWorkKey === workKey ? null : disclosure.autoOpenWorkKey,
          expandedUserMessageByKey: disclosure.expandedUserMessageByKey,
          manuallyClosedAutoWorkByTurnId,
          openWorkByKey,
        },
      });
      return;
    }

    delete manuallyClosedAutoWorkByTurnId[input.turnId];
    const row = workRowForDisclosure({
      additionalHeight: 0,
      key: workKey,
      openChildByKey: {},
      rowId: input.rowId,
      segmentId: input.segmentId,
      source: 'user',
      turnId: input.turnId,
    }, state.turnsById);
    if (!row) {
      return;
    }

    openWorkByKey[workKey] = workDisclosureForRow({
      previous: openWork ?? null,
      row,
      source: 'user',
    });
    layoutStore.setState({
      disclosure: {
        autoOpenWorkKey: disclosure.autoOpenWorkKey === workKey ? null : disclosure.autoOpenWorkKey,
        expandedUserMessageByKey: disclosure.expandedUserMessageByKey,
        manuallyClosedAutoWorkByTurnId,
        openWorkByKey,
      },
    });

    void resourceAdapter?.ensureWorkDetails({ segmentId: input.segmentId, turnId: input.turnId });
  },
};

const layoutStore = createExternalStore<TranscriptLayoutStoreState>({
  disclosure: emptyDisclosureState(),
  turnOrder: [],
  turnsById: {},
  width: null,
  ...actions,
});

export const useTranscriptLayoutStore = layoutStore.useStore;

export function getTranscriptLayoutState() {
  return layoutStore.getState();
}

export { transcriptUserMessageDisclosureKey, transcriptWorkDisclosureKey } from './disclosureKeys';

export function configureTranscriptLayoutResourceAdapter(adapter: TranscriptLayoutResourceAdapter) {
  resourceAdapter = adapter;
}

export function resetTranscriptLayoutForThread() {
  layoutStore.setState({
    disclosure: emptyDisclosureState(),
    turnOrder: [],
    turnsById: {},
  });
  resetTranscriptViewportForThread();
}

export function reconcileTranscriptLayoutFromResources(
  resourceSnapshot: TranscriptLayoutResourceSnapshot,
  options: {
    dirtyTurnIds?: ReadonlySet<string>;
    forceFullMeasure?: boolean;
  } = {},
) {
  const width = layoutStore.getState().width;
  if (!resourceSnapshot.activeThreadId || width === null) {
    return;
  }

  const turns = resourceSnapshot.turnOrder
    .map((turnId) => resourceSnapshot.turnsById[turnId]?.turn)
    .filter((turn): turn is CodexTranscriptTurn => Boolean(turn));
  const previousState = layoutStore.getState();
  const layout = reconcileMeasuredTranscript({
    cache: transcriptMeasureCache,
    dirtyTurnIds: options.dirtyTurnIds,
    forceFullMeasure: options.forceFullMeasure,
    previousTurnOrder: previousState.turnOrder,
    previousTurnsById: previousState.turnsById,
    expandedUserMessageByKey: previousState.disclosure.expandedUserMessageByKey,
    threadId: resourceSnapshot.activeThreadId,
    turns,
    width,
  });

  const runtime = getThreadRuntimeState();
  const autoOpenTurnId = runtime.status === 'running' || runtime.status === 'stopping' ? runtime.activeTurnId : null;
  layoutStore.setState({
    disclosure: reconcileTranscriptDisclosure(previousState.disclosure, layout.turns, autoOpenTurnId, {
      autoWorkManaged: transcriptViewportAllowsAutoWork(previousState.disclosure),
      visibleWorkKeys: new Set(getTranscriptViewportState().visibleWorkKeys),
    }),
    turnOrder: layout.turns.map((turn) => turn.turnId),
    turnsById: layout.turnsById,
    width: layout.width,
  });
  reconcileTranscriptViewportForLayout(layout.turns, layout.turnsById);
}

export function reconcileTranscriptDisclosure(
  disclosure: TranscriptDisclosureState,
  turns: TranscriptMeasuredTurn[],
  autoOpenTurnId?: string | null,
  options: TranscriptDisclosureReconcileOptions = {},
): TranscriptDisclosureState {
  const autoWorkManaged = options.autoWorkManaged ?? true;
  const visibleWorkKeys = options.visibleWorkKeys ?? new Set<string>();
  const turnsById = Object.fromEntries(turns.map((turn) => [turn.turnId, turn]));
  const manuallyClosedAutoWorkByTurnId = filterManualClosedWorkTurns(
    disclosure.manuallyClosedAutoWorkByTurnId,
    turns,
  );
  const expandedUserMessageByKey = filterExpandedUserMessages(disclosure.expandedUserMessageByKey, turns);
  const openWorkByKey: Record<string, TranscriptOpenWorkDisclosure> = {};
  let previousAutoOpenWork: TranscriptOpenWorkDisclosure | null = null;

  for (const openWork of Object.values(disclosure.openWorkByKey)) {
    const existingOpenWork = reconcileExistingOpenWork(openWork, turnsById);
    if (!existingOpenWork) {
      continue;
    }
    if (existingOpenWork.source === 'user') {
      openWorkByKey[existingOpenWork.key] = existingOpenWork;
    } else if (disclosure.autoOpenWorkKey === existingOpenWork.key) {
      previousAutoOpenWork = existingOpenWork;
    }
  }

  const preservePreviousAutoWork = () => {
    if (!previousAutoOpenWork || manuallyClosedAutoWorkByTurnId[previousAutoOpenWork.turnId]) {
      return null;
    }

    return {
      autoOpenWorkKey: previousAutoOpenWork.key,
      expandedUserMessageByKey,
      manuallyClosedAutoWorkByTurnId,
      openWorkByKey: {
        ...openWorkByKey,
        [previousAutoOpenWork.key]: previousAutoOpenWork,
      },
    };
  };

  const workingTurn = autoOpenTurnId === undefined
    ? turns.find((turn) => turn.turn.status === 'inProgress') ?? null
    : turns.find((turn) => turn.turnId === autoOpenTurnId && turn.turn.status === 'inProgress') ?? null;

  const preserveUnmanagedPreviousAutoWork = () => {
    if (!previousAutoOpenWork || manuallyClosedAutoWorkByTurnId[previousAutoOpenWork.turnId]) {
      return null;
    }
    if (!visibleWorkKeys.has(previousAutoOpenWork.key) && !hasOpenWorkChild(previousAutoOpenWork)) {
      return null;
    }

    return {
      autoOpenWorkKey: null,
      expandedUserMessageByKey,
      manuallyClosedAutoWorkByTurnId,
      openWorkByKey: {
        ...openWorkByKey,
        [previousAutoOpenWork.key]: {
          ...previousAutoOpenWork,
          source: 'user' as const,
        },
      },
    };
  };

  if (!autoWorkManaged) {
    const preserved = preserveUnmanagedPreviousAutoWork();
    return preserved ?? {
      autoOpenWorkKey: null,
      expandedUserMessageByKey,
      manuallyClosedAutoWorkByTurnId,
      openWorkByKey,
    };
  }

  if (!workingTurn) {
    return {
      autoOpenWorkKey: null,
      expandedUserMessageByKey,
      manuallyClosedAutoWorkByTurnId,
      openWorkByKey,
    };
  }

  if (manuallyClosedAutoWorkByTurnId[workingTurn.turnId]) {
    return {
      autoOpenWorkKey: null,
      expandedUserMessageByKey,
      manuallyClosedAutoWorkByTurnId,
      openWorkByKey,
    };
  }

  if (turnHasAssistantMessage(workingTurn)) {
    return {
      autoOpenWorkKey: null,
      expandedUserMessageByKey,
      manuallyClosedAutoWorkByTurnId,
      openWorkByKey,
    };
  }

  const autoRow = preferredAutoOpenWorkRow(workingTurn);
  if (!autoRow) {
    const preserved = previousAutoOpenWork?.turnId === workingTurn.turnId ? preservePreviousAutoWork() : null;
    return preserved ?? {
      autoOpenWorkKey: null,
      expandedUserMessageByKey,
      manuallyClosedAutoWorkByTurnId,
      openWorkByKey,
    };
  }

  const autoWorkKey = transcriptWorkDisclosureKey(autoRow.turnId, autoRow.segmentId);
  if (openWorkByKey[autoWorkKey]) {
    return {
      autoOpenWorkKey: null,
      expandedUserMessageByKey,
      manuallyClosedAutoWorkByTurnId,
      openWorkByKey,
    };
  }

  openWorkByKey[autoWorkKey] = workDisclosureForRow({
    previous: previousAutoOpenWork?.key === autoWorkKey ? previousAutoOpenWork : null,
    row: autoRow,
    source: 'auto',
  });

  return {
    autoOpenWorkKey: autoWorkKey,
    expandedUserMessageByKey,
    manuallyClosedAutoWorkByTurnId,
    openWorkByKey,
  };
}

export function promoteOpenWorkDisclosure(
  disclosure: TranscriptDisclosureState,
  workKey: string,
): TranscriptDisclosureState {
  const openWork = disclosure.openWorkByKey[workKey];
  if (!openWork || openWork.source !== 'auto') {
    return disclosure;
  }

  return {
    ...disclosure,
    autoOpenWorkKey: disclosure.autoOpenWorkKey === workKey ? null : disclosure.autoOpenWorkKey,
    openWorkByKey: {
      ...disclosure.openWorkByKey,
      [workKey]: {
        ...openWork,
        source: 'user',
      },
    },
  };
}

function emptyDisclosureState(): TranscriptDisclosureState {
  return {
    autoOpenWorkKey: null,
    expandedUserMessageByKey: {},
    manuallyClosedAutoWorkByTurnId: {},
    openWorkByKey: {},
  };
}

function filterManualClosedWorkTurns(
  manuallyClosedWorkByTurnId: Record<string, true>,
  turns: TranscriptMeasuredTurn[],
) {
  const next: Record<string, true> = {};
  for (const turn of turns) {
    if (turn.turn.status === 'inProgress' && manuallyClosedWorkByTurnId[turn.turnId]) {
      next[turn.turnId] = true;
    }
  }
  return next;
}

function filterExpandedUserMessages(
  expandedUserMessageByKey: Record<string, true>,
  turns: TranscriptMeasuredTurn[],
) {
  const next: Record<string, true> = {};
  for (const turn of turns) {
    for (const row of turn.rows) {
      if (row.segment.type !== 'userMessage' || !row.userMessageDisclosure?.collapsible) {
        continue;
      }

      const key = transcriptUserMessageDisclosureKey(row.turnId, row.segmentId);
      if (expandedUserMessageByKey[key]) {
        next[key] = true;
      }
    }
  }
  return next;
}

function reconcileExistingOpenWork(
  openWork: TranscriptOpenWorkDisclosure | null,
  turnsById: Record<string, TranscriptMeasuredTurn>,
) {
  if (!openWork) {
    return null;
  }

  const row = workRowForDisclosure(openWork, turnsById);
  if (!row) {
    return null;
  }

  return workDisclosureForRow({
    previous: openWork,
    row,
    source: openWork.source,
  });
}

function preferredAutoOpenWorkRow(turn: TranscriptMeasuredTurn) {
  return (
    [...turn.rows].reverse().find((row) => row.segment.type === 'work' && row.segment.state === 'running') ??
    null
  );
}

function turnHasAssistantMessage(turn: TranscriptMeasuredTurn) {
  return turn.rows.some((row) => row.segment.type === 'assistantMessage');
}

function transcriptViewportAllowsAutoWork(disclosure: TranscriptDisclosureState) {
  const viewport = getTranscriptViewportState();
  if (viewport.autoScrollMode.type !== 'off') {
    return true;
  }

  return viewport.activeTurnIds.length === 0 && !hasAutoOpenWork(disclosure);
}

function hasAutoOpenWork(disclosure: TranscriptDisclosureState) {
  return Object.values(disclosure.openWorkByKey).some((openWork) => openWork.source === 'auto');
}

function hasOpenWorkChild(openWork: TranscriptOpenWorkDisclosure) {
  return Object.values(openWork.openChildByKey).some(Boolean);
}

function workRowForDisclosure(
  openWork: TranscriptOpenWorkDisclosure,
  turnsById: Record<string, TranscriptMeasuredTurn>,
) {
  const turn = turnsById[openWork.turnId];
  if (!turn) {
    return null;
  }

  return (
    turn.rows.find((row) =>
      row.segment.type === 'work' &&
      row.id === openWork.rowId &&
      row.segmentId === openWork.segmentId) ??
    turn.rows.find((row) =>
      row.segment.type === 'work' &&
      row.segmentId === openWork.segmentId) ??
    null
  );
}

function workDisclosureForRow({
  previous,
  row,
  source,
}: {
  previous: TranscriptOpenWorkDisclosure | null;
  row: TranscriptMeasuredTurn['rows'][number];
  source: TranscriptOpenWorkDisclosure['source'];
}): TranscriptOpenWorkDisclosure {
  const sameWork = previous?.rowId === row.id && previous.segmentId === row.segmentId && previous.turnId === row.turnId;
  const key = transcriptWorkDisclosureKey(row.turnId, row.segmentId);
  return {
    additionalHeight: sameWork ? previous.additionalHeight : 0,
    key,
    openChildByKey: sameWork ? previous.openChildByKey : {},
    rowId: row.id,
    segmentId: row.segmentId,
    source,
    turnId: row.turnId,
  };
}
