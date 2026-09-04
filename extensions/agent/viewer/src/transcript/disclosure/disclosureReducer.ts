import type { TranscriptMeasuredTurn } from '../layout/types';
import {
  transcriptUserMessageDisclosureKey,
  transcriptWorkDisclosureKey,
} from '../disclosureKeys';

export type TranscriptOpenWorkDisclosure = {
  additionalHeight: number;
  key: string;
  openedAfterAssistantStarted?: boolean;
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

export type TranscriptWorkDisclosureInput = {
  rowId: string;
  segmentId: string;
  turnId: string;
};

export function emptyTranscriptDisclosureState(): TranscriptDisclosureState {
  return {
    autoOpenWorkKey: null,
    expandedUserMessageByKey: {},
    manuallyClosedAutoWorkByTurnId: {},
    openWorkByKey: {},
  };
}

export function setOnlyOpenWorkChildDisclosure(
  disclosure: TranscriptDisclosureState,
  workKey: string,
  keys: string[],
  openKey: string | null,
) {
  const openWork = disclosure.openWorkByKey[workKey];
  if (!openWork) return disclosure;

  const openChildByKey = { ...openWork.openChildByKey };
  for (const key of keys) openChildByKey[key] = key === openKey;
  return promoteOpenWorkDisclosure({
    ...disclosure,
    openWorkByKey: {
      ...disclosure.openWorkByKey,
      [workKey]: { ...openWork, openChildByKey },
    },
  }, workKey);
}

export function setOpenWorkAdditionalHeight(
  disclosure: TranscriptDisclosureState,
  workKey: string,
  rowId: string,
  additionalHeight: number,
) {
  const openWork = disclosure.openWorkByKey[workKey];
  if (!openWork || openWork.rowId !== rowId || openWork.additionalHeight === additionalHeight) {
    return disclosure;
  }
  return {
    ...disclosure,
    openWorkByKey: {
      ...disclosure.openWorkByKey,
      [workKey]: { ...openWork, additionalHeight },
    },
  };
}

export function toggleUserMessageDisclosure(
  disclosure: TranscriptDisclosureState,
  input: { segmentId: string; turnId: string },
) {
  const key = transcriptUserMessageDisclosureKey(input.turnId, input.segmentId);
  const expandedUserMessageByKey = { ...disclosure.expandedUserMessageByKey };
  if (expandedUserMessageByKey[key]) delete expandedUserMessageByKey[key];
  else expandedUserMessageByKey[key] = true;
  return { ...disclosure, expandedUserMessageByKey };
}

export function toggleWorkChildDisclosure(
  disclosure: TranscriptDisclosureState,
  workKey: string,
  key: string,
  defaultOpen = false,
) {
  const openWork = disclosure.openWorkByKey[workKey];
  if (!openWork) return disclosure;
  return promoteOpenWorkDisclosure({
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
  }, workKey);
}

export function toggleWorkDisclosure({
  activeTurnId,
  disclosure,
  input,
  turnsById,
}: {
  activeTurnId: string | null;
  disclosure: TranscriptDisclosureState;
  input: TranscriptWorkDisclosureInput;
  turnsById: Record<string, TranscriptMeasuredTurn>;
}) {
  const workKey = transcriptWorkDisclosureKey(input.turnId, input.segmentId);
  const openWork = disclosure.openWorkByKey[workKey];
  const isCurrentlyOpen =
    openWork?.rowId === input.rowId &&
    openWork.segmentId === input.segmentId &&
    openWork.turnId === input.turnId;
  const manuallyClosedAutoWorkByTurnId = { ...disclosure.manuallyClosedAutoWorkByTurnId };
  const openWorkByKey = { ...disclosure.openWorkByKey };

  if (isCurrentlyOpen) {
    const closingActiveTurn =
      activeTurnId === input.turnId && turnsById[input.turnId]?.turn.status === 'inProgress';
    if (openWork.source === 'auto' || closingActiveTurn) {
      manuallyClosedAutoWorkByTurnId[input.turnId] = true;
    }
    delete openWorkByKey[workKey];
    return {
      autoOpenWorkKey: disclosure.autoOpenWorkKey === workKey ? null : disclosure.autoOpenWorkKey,
      expandedUserMessageByKey: disclosure.expandedUserMessageByKey,
      manuallyClosedAutoWorkByTurnId,
      openWorkByKey,
    };
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
  }, turnsById);
  if (!row) return disclosure;

  openWorkByKey[workKey] = workDisclosureForRow({
    openedAfterAssistantStarted: turnHasAssistantMessage(turnsById[input.turnId]),
    previous: openWork ?? null,
    row,
    source: 'user',
  });
  return {
    autoOpenWorkKey: disclosure.autoOpenWorkKey === workKey ? null : disclosure.autoOpenWorkKey,
    expandedUserMessageByKey: disclosure.expandedUserMessageByKey,
    manuallyClosedAutoWorkByTurnId,
    openWorkByKey,
  };
}

export function reconcileTranscriptDisclosure(
  disclosure: TranscriptDisclosureState,
  turns: TranscriptMeasuredTurn[],
  activeTurnId: string | null,
): TranscriptDisclosureState {
  const turnsById = Object.fromEntries(turns.map((turn) => [turn.turnId, turn]));
  const manuallyClosedAutoWorkByTurnId = filterManualClosedWorkTurns(
    disclosure.manuallyClosedAutoWorkByTurnId,
    turns,
  );
  const expandedUserMessageByKey = filterExpandedUserMessages(
    disclosure.expandedUserMessageByKey,
    turns,
  );
  const openWorkByKey: Record<string, TranscriptOpenWorkDisclosure> = {};
  let previousAutoOpenWork: TranscriptOpenWorkDisclosure | null = null;

  for (const openWork of Object.values(disclosure.openWorkByKey)) {
    const existingOpenWork = reconcileExistingOpenWork(openWork, turnsById);
    if (!existingOpenWork) continue;
    if (existingOpenWork.source === 'user') {
      const turn = turnsById[existingOpenWork.turnId];
      if (
        turn &&
        turnHasAssistantMessage(turn) &&
        !existingOpenWork.openedAfterAssistantStarted
      ) continue;
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

  const workingTurn = activeTurnId
    ? turns.find((turn) => turn.turnId === activeTurnId && turn.turn.status === 'inProgress') ?? null
    : null;
  if (!workingTurn || manuallyClosedAutoWorkByTurnId[workingTurn.turnId]) {
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
    const preserved = previousAutoOpenWork?.turnId === workingTurn.turnId
      ? preservePreviousAutoWork()
      : null;
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
  if (!openWork || openWork.source !== 'auto') return disclosure;
  return {
    ...disclosure,
    autoOpenWorkKey: disclosure.autoOpenWorkKey === workKey ? null : disclosure.autoOpenWorkKey,
    openWorkByKey: {
      ...disclosure.openWorkByKey,
      [workKey]: { ...openWork, source: 'user' },
    },
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
      if (row.segment.type !== 'userMessage' || !row.userMessageDisclosure?.collapsible) continue;
      const key = transcriptUserMessageDisclosureKey(row.turnId, row.segmentId);
      if (expandedUserMessageByKey[key]) next[key] = true;
    }
  }
  return next;
}

function reconcileExistingOpenWork(
  openWork: TranscriptOpenWorkDisclosure,
  turnsById: Record<string, TranscriptMeasuredTurn>,
) {
  const row = workRowForDisclosure(openWork, turnsById);
  return row
    ? workDisclosureForRow({ previous: openWork, row, source: openWork.source })
    : null;
}

function preferredAutoOpenWorkRow(turn: TranscriptMeasuredTurn) {
  return [...turn.rows].reverse().find((row) =>
    row.segment.type === 'work' && row.segment.state === 'running') ?? null;
}

function turnHasAssistantMessage(turn: TranscriptMeasuredTurn | undefined) {
  return Boolean(turn?.rows.some((row) => row.segment.type === 'assistantMessage'));
}

function workRowForDisclosure(
  openWork: TranscriptOpenWorkDisclosure,
  turnsById: Record<string, TranscriptMeasuredTurn>,
) {
  const turn = turnsById[openWork.turnId];
  if (!turn) return null;
  return turn.rows.find((row) =>
    row.segment.type === 'work' &&
    row.id === openWork.rowId &&
    row.segmentId === openWork.segmentId) ??
    turn.rows.find((row) =>
      row.segment.type === 'work' && row.segmentId === openWork.segmentId) ??
    null;
}

function workDisclosureForRow({
  openedAfterAssistantStarted,
  previous,
  row,
  source,
}: {
  openedAfterAssistantStarted?: boolean;
  previous: TranscriptOpenWorkDisclosure | null;
  row: TranscriptMeasuredTurn['rows'][number];
  source: TranscriptOpenWorkDisclosure['source'];
}): TranscriptOpenWorkDisclosure {
  const sameWork =
    previous?.rowId === row.id &&
    previous.segmentId === row.segmentId &&
    previous.turnId === row.turnId;
  const key = transcriptWorkDisclosureKey(row.turnId, row.segmentId);
  return {
    additionalHeight: sameWork ? previous.additionalHeight : 0,
    key,
    openedAfterAssistantStarted:
      openedAfterAssistantStarted ??
      (sameWork ? Boolean(previous.openedAfterAssistantStarted) : false),
    openChildByKey: sameWork ? previous.openChildByKey : {},
    rowId: row.id,
    segmentId: row.segmentId,
    source,
    turnId: row.turnId,
  };
}
