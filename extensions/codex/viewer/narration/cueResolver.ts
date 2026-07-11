import type {
  CodexNarrationCue,
  CodexNarrationManifest,
  CodexNarrationSourceTarget,
  CodexNarrationUnit,
} from '../../shared/narration';

export type NarrationResolvedPosition = {
  cue: CodexNarrationCue | null;
  cueIndex: number;
  targetIds: string[];
  targets: CodexNarrationSourceTarget[];
  unit: CodexNarrationUnit | null;
  unitIndex: number;
};

export function resolveNarrationPosition(
  manifest: CodexNarrationManifest,
  globalTime: number,
): NarrationResolvedPosition {
  const unitIndex = findTimedIndex(manifest.units, globalTime);
  const unit = unitIndex >= 0 ? manifest.units[unitIndex] ?? null : null;
  const resolvedCueIndex = unit ? findTimedIndex(manifest.cues, globalTime) : -1;
  const cueIndex = resolvedCueIndex >= 0 && manifest.cues[resolvedCueIndex]?.unitId === unit?.id
    ? resolvedCueIndex
    : -1;
  const cue = cueIndex >= 0 ? manifest.cues[cueIndex] ?? null : null;
  const targetIds = cue?.targetIds ?? unit?.fallbackTargetIds ?? [];
  const targetSet = new Set(targetIds);
  return {
    cue,
    cueIndex,
    targetIds,
    targets: manifest.targets.filter((target) => targetSet.has(target.id)),
    unit,
    unitIndex,
  };
}

function findTimedIndex<T extends { end: number; start: number }>(
  items: T[],
  time: number,
) {
  let low = 0;
  let high = items.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const item = items[middle];
    if (time < item.start) high = middle - 1;
    else if (time > item.end) low = middle + 1;
    else return middle;
  }
  return Math.max(-1, Math.min(items.length - 1, high));
}
