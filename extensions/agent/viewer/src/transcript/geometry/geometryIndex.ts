import type { TranscriptMeasuredTurn } from '../layout/types';

export type TranscriptExpandedRow = {
  additionalHeight: number;
  rowId: string;
  turnId: string;
};

export type TranscriptRowPosition = {
  rowId: string;
  scrollTop: number;
  segmentId: string;
  turnId: string;
};

/**
 * One immutable coordinate system for a measured transcript snapshot.
 *
 * Collapsed row geometry comes from the deterministic layout model. Open work
 * contributes an overlay after its header row. Every range, navigation, and
 * restore calculation must resolve through this index so an expanded row can
 * never be counted by one feature and omitted by another.
 */
export class TranscriptGeometryIndex {
  readonly totalAdditionalHeight: number;
  readonly totalHeight: number;

  private readonly additionalHeightBeforeTurn: number[];
  private readonly additionalHeightByRowKey = new Map<string, number>();
  private readonly additionalHeightByTurnId = new Map<string, number>();
  private readonly turnIndexById = new Map<string, number>();

  constructor(
    readonly turns: TranscriptMeasuredTurn[],
    expandedRows: TranscriptExpandedRow[] = [],
  ) {
    turns.forEach((turn, index) => this.turnIndexById.set(turn.turnId, index));

    for (const row of expandedRows) {
      if (!this.turnIndexById.has(row.turnId)) continue;
      const height = Math.max(0, row.additionalHeight);
      this.additionalHeightByTurnId.set(
        row.turnId,
        (this.additionalHeightByTurnId.get(row.turnId) ?? 0) + height,
      );
      const key = expandedRowKey(row.turnId, row.rowId);
      this.additionalHeightByRowKey.set(
        key,
        (this.additionalHeightByRowKey.get(key) ?? 0) + height,
      );
    }

    this.additionalHeightBeforeTurn = new Array(turns.length + 1).fill(0);
    let additionalHeight = 0;
    turns.forEach((turn, index) => {
      this.additionalHeightBeforeTurn[index] = additionalHeight;
      additionalHeight += this.additionalHeightByTurnId.get(turn.turnId) ?? 0;
    });
    this.additionalHeightBeforeTurn[turns.length] = additionalHeight;
    this.totalAdditionalHeight = additionalHeight;

    const lastTurn = turns.at(-1);
    const totalCollapsedHeight = lastTurn
      ? lastTurn.collapsedTop + lastTurn.collapsedHeight
      : 0;
    this.totalHeight = totalCollapsedHeight + additionalHeight;
  }

  heightAfterRow(turnId: string, rowId: string) {
    return this.additionalHeightByRowKey.get(expandedRowKey(turnId, rowId)) ?? 0;
  }

  heightBeforeTurnIndex(turnIndex: number) {
    if (turnIndex <= 0) return 0;
    if (turnIndex >= this.turns.length) return this.totalAdditionalHeight;
    return this.additionalHeightBeforeTurn[turnIndex] ?? 0;
  }

  heightInsideTurn(turnId: string) {
    return this.additionalHeightByTurnId.get(turnId) ?? 0;
  }

  indexOfTurn(turnId: string | undefined) {
    return turnId ? this.turnIndexById.get(turnId) ?? -1 : -1;
  }

  turnTop(turnIndex: number) {
    const turn = this.turns[turnIndex];
    return turn
      ? turn.collapsedTop + this.heightBeforeTurnIndex(turnIndex)
      : 0;
  }

  turnBottom(turnIndex: number) {
    const turn = this.turns[turnIndex];
    return turn
      ? this.turnTop(turnIndex) + turn.collapsedHeight + this.heightInsideTurn(turn.turnId)
      : 0;
  }

  firstTurnWithBottomAfter(target: number) {
    if (this.turns.length === 0) return -1;
    let low = 0;
    let high = this.turns.length - 1;
    let result = high;

    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (this.turnBottom(middle) >= target) {
        result = middle;
        high = middle - 1;
      } else {
        low = middle + 1;
      }
    }
    return result;
  }

  lastTurnWithTopBefore(target: number) {
    if (this.turns.length === 0) return -1;
    let low = 0;
    let high = this.turns.length - 1;
    let result = 0;

    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (this.turnTop(middle) <= target) {
        result = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    return result;
  }

  rowPositions(topPadding = 0): TranscriptRowPosition[] {
    const positions: TranscriptRowPosition[] = [];
    this.turns.forEach((turn, turnIndex) => {
      let rowTop = this.turnTop(turnIndex);
      for (const row of turn.rows) {
        positions.push({
          rowId: row.id,
          scrollTop: topPadding + rowTop,
          segmentId: row.segmentId,
          turnId: turn.turnId,
        });
        rowTop += row.height + this.heightAfterRow(turn.turnId, row.id);
      }
    });
    return positions;
  }
}

function expandedRowKey(turnId: string, rowId: string) {
  return `${turnId}\u0000${rowId}`;
}
