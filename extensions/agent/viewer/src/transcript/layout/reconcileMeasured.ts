import type { AgentTurnRenderFrame } from '../../../../shared/transcript';
import {
  latestUserMessageActionRowId,
  measureCollapsedTurnWithCache,
  emptyDisplayFooter,
  userMessageDisclosureRevisionForTurn,
} from './measureCollapsed';
import type { TranscriptMeasureCache } from './measureCache';
import type { TranscriptMeasuredLayout, TranscriptMeasuredTurn, TranscriptTurnDisplayFooter } from './types';

export function reconcileMeasuredTranscript({
  cache,
  dirtyTurnIds,
  expandedUserMessageByKey = {},
  forceFullMeasure = false,
  previousTurnOrder,
  previousTurnsById,
  conversationId,
  turns,
  displayFootersByTurnId = {},
  width,
}: {
  cache?: TranscriptMeasureCache;
  dirtyTurnIds?: ReadonlySet<string>;
  expandedUserMessageByKey?: Record<string, true>;
  forceFullMeasure?: boolean;
  previousTurnOrder: string[];
  previousTurnsById: Record<string, TranscriptMeasuredTurn>;
  conversationId?: string;
  turns: AgentTurnRenderFrame[];
  displayFootersByTurnId?: Record<string, TranscriptTurnDisplayFooter>;
  width: number;
}): TranscriptMeasuredLayout {
  const contentWidth = Math.max(1, width);
  const measuredTurns: TranscriptMeasuredTurn[] = [];
  const userActionRowId = latestUserMessageActionRowId(turns);
  const previousUserActionRowId = latestUserMessageActionRowId(
    previousTurnOrder
      .map((turnId) => previousTurnsById[turnId]?.turn)
      .filter((turn): turn is AgentTurnRenderFrame => Boolean(turn)),
  );
  let top = 0;

  for (const turn of turns) {
    const turnTop = top;
    const turnUserActionRowId = actionRowIdForTurn(userActionRowId, turn.id);
    const previousTurnUserActionRowId = actionRowIdForTurn(previousUserActionRowId, turn.id);
    const turnUserMessageDisclosureRevision = userMessageDisclosureRevisionForTurn(turn, expandedUserMessageByKey);
    const previousTurn = previousTurnsById[turn.id];
    const displayFooter = displayFootersByTurnId[turn.id] ?? emptyDisplayFooter;
    const canReusePreviousTurn =
      !forceFullMeasure &&
      !dirtyTurnIds?.has(turn.id) &&
      previousTurn?.revision === turn.renderRevision &&
      previousTurn.displayFooter.revision === displayFooter.revision &&
      previousTurn.userMessageDisclosureRevision === turnUserMessageDisclosureRevision &&
      previousTurnUserActionRowId === turnUserActionRowId &&
      previousTurn.rows.length === turn.segments.length &&
      previousTurn.rows.every((row, index) => row.segmentId === turn.segments[index]?.id);

    if (canReusePreviousTurn) {
      const measuredTurn = {
        ...previousTurn,
        collapsedTop: turnTop,
        rows: previousTurn.rows.map((row, index) => ({
          ...row,
          segment: turn.segments[index]!,
          turn,
        })),
        turn,
        displayFooter,
      };
      top += measuredTurn.collapsedHeight;
      measuredTurns.push(measuredTurn);
      continue;
    }

    const measuredTurn = measureCollapsedTurnWithCache({
      cache,
      contentWidth,
      expandedUserMessageByKey,
      conversationId,
      turn,
      displayFooter,
      userActionRowId: turnUserActionRowId,
      userMessageDisclosureRevision: turnUserMessageDisclosureRevision,
    });
    top += measuredTurn.collapsedHeight;

    measuredTurns.push({
      collapsedHeight: measuredTurn.collapsedHeight,
      collapsedTop: turnTop,
      revision: turn.renderRevision,
      rows: measuredTurn.rows,
      displayFooter,
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
