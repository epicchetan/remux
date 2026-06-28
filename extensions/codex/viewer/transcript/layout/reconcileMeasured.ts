import type { CodexTranscriptTurn } from '../../../shared/transcript';
import {
  latestUserMessageActionRowId,
  measureCollapsedTurnWithCache,
  userMessageDisclosureRevisionForTurn,
} from './measureCollapsed';
import type { TranscriptMeasureCache } from './measureCache';
import type { TranscriptMeasuredLayout, TranscriptMeasuredTurn } from './types';

export function reconcileMeasuredTranscript({
  cache,
  dirtyTurnIds,
  expandedUserMessageByKey = {},
  forceFullMeasure = false,
  previousTurnOrder,
  previousTurnsById,
  threadId,
  turns,
  width,
}: {
  cache?: TranscriptMeasureCache;
  dirtyTurnIds?: ReadonlySet<string>;
  expandedUserMessageByKey?: Record<string, true>;
  forceFullMeasure?: boolean;
  previousTurnOrder: string[];
  previousTurnsById: Record<string, TranscriptMeasuredTurn>;
  threadId?: string;
  turns: CodexTranscriptTurn[];
  width: number;
}): TranscriptMeasuredLayout {
  const contentWidth = Math.max(1, width);
  const measuredTurns: TranscriptMeasuredTurn[] = [];
  const userActionRowId = latestUserMessageActionRowId(turns);
  const previousUserActionRowId = latestUserMessageActionRowId(
    previousTurnOrder
      .map((turnId) => previousTurnsById[turnId]?.turn)
      .filter((turn): turn is CodexTranscriptTurn => Boolean(turn)),
  );
  let top = 0;

  for (const turn of turns) {
    const turnTop = top;
    const turnUserActionRowId = actionRowIdForTurn(userActionRowId, turn.id);
    const previousTurnUserActionRowId = actionRowIdForTurn(previousUserActionRowId, turn.id);
    const turnUserMessageDisclosureRevision = userMessageDisclosureRevisionForTurn(turn, expandedUserMessageByKey);
    const previousTurn = previousTurnsById[turn.id];
    const canReusePreviousTurn =
      !forceFullMeasure &&
      !dirtyTurnIds?.has(turn.id) &&
      previousTurn?.revision === turn.revision &&
      previousTurn.userMessageDisclosureRevision === turnUserMessageDisclosureRevision &&
      previousTurnUserActionRowId === turnUserActionRowId &&
      previousTurn.rows.length === turn.segments.length &&
      previousTurn.rows.every((row, index) => row.segmentId === turn.segments[index]?.id);

    if (canReusePreviousTurn) {
      const measuredTurn = previousTurn.collapsedTop === turnTop
        ? previousTurn
        : {
            ...previousTurn,
            collapsedTop: turnTop,
          };
      top += measuredTurn.collapsedHeight;
      measuredTurns.push(measuredTurn);
      continue;
    }

    const measuredTurn = measureCollapsedTurnWithCache({
      cache,
      contentWidth,
      expandedUserMessageByKey,
      threadId,
      turn,
      userActionRowId: turnUserActionRowId,
      userMessageDisclosureRevision: turnUserMessageDisclosureRevision,
    });
    top += measuredTurn.collapsedHeight;

    measuredTurns.push({
      collapsedHeight: measuredTurn.collapsedHeight,
      collapsedTop: turnTop,
      revision: turn.revision,
      rows: measuredTurn.rows,
      turn,
      turnId: turn.id,
      userMessageDisclosureRevision: turnUserMessageDisclosureRevision,
    });
  }

  return {
    contentWidth,
    totalCollapsedHeight: top,
    turns: measuredTurns,
    turnsById: Object.fromEntries(measuredTurns.map((turn) => [turn.turnId, turn])),
    width,
  };
}

function actionRowIdForTurn(rowId: string | null, turnId: string) {
  return rowId?.startsWith(`${turnId}:`) ? rowId : null;
}
