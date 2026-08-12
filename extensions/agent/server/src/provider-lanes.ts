export type ProviderLaneState = {
  callCount: number;
  lastRenderedHashes: readonly string[] | null;
};

export type ProviderLanePlan = {
  requestMode: 'full' | 'continuation';
  next: ProviderLaneState;
};

export function planProviderLaneRequest(
  current: ProviderLaneState | undefined,
  orderedMessageHashes: readonly string[],
): ProviderLanePlan {
  const lane = current ?? { callCount: 0, lastRenderedHashes: null };
  const extendsPriorFrame = lane.callCount > 0 &&
    lane.lastRenderedHashes !== null &&
    lane.lastRenderedHashes.length <= orderedMessageHashes.length &&
    lane.lastRenderedHashes.every((hash, index) => orderedMessageHashes[index] === hash);
  return {
    requestMode: extendsPriorFrame ? 'continuation' : 'full',
    next: {
      callCount: lane.callCount + 1,
      lastRenderedHashes: [...orderedMessageHashes],
    },
  };
}

export function invalidateProviderLane(
  current: ProviderLaneState | undefined,
): ProviderLaneState {
  return {
    callCount: current?.callCount ?? 0,
    lastRenderedHashes: null,
  };
}
