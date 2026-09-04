import { useMemo } from 'react';

import {
  TranscriptGeometryIndex,
  type TranscriptExpandedRow,
} from '../geometry/geometryIndex';
import type { TranscriptMeasuredTurn } from '../layout/types';
import { useTranscriptLayoutStore } from '../layoutStore';

/**
 * The immutable, layout-owned input to viewport reconciliation.
 *
 * Keeping this assembly in one hook makes it impossible for range, spacer,
 * navigation, and running-turn policy to accidentally select different
 * versions of measured transcript state in the same render.
 */
export type TranscriptRenderSnapshot = {
  activeTurnId: string | null;
  expandedRows: TranscriptExpandedRow[];
  geometry: TranscriptGeometryIndex;
  turns: TranscriptMeasuredTurn[];
  turnsById: Record<string, TranscriptMeasuredTurn>;
};

export function useTranscriptRenderSnapshot(): TranscriptRenderSnapshot {
  const activeTurnId = useTranscriptLayoutStore((state) => state.activeTurnId);
  const turnOrder = useTranscriptLayoutStore((state) => state.turnOrder);
  const turnsById = useTranscriptLayoutStore((state) => state.turnsById);
  const openWorkByKey = useTranscriptLayoutStore((state) => state.disclosure.openWorkByKey);

  return useMemo(() => {
    const turns = turnOrder
      .map((turnId) => turnsById[turnId])
      .filter((turn): turn is TranscriptMeasuredTurn => Boolean(turn));
    const expandedRows = Object.values(openWorkByKey);

    return {
      activeTurnId,
      expandedRows,
      geometry: new TranscriptGeometryIndex(turns, expandedRows),
      turns,
      turnsById,
    };
  }, [activeTurnId, openWorkByKey, turnOrder, turnsById]);
}
