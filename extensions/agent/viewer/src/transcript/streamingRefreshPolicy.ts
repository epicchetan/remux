import type { AgentResourceInvalidation } from '../../../shared/transcript';

export function partitionStreamingTranscriptInvalidations(
  invalidations: AgentResourceInvalidation[],
) {
  return {
    immediateInvalidations: invalidations.filter((invalidation) =>
      invalidation.type !== 'transcript' ||
      invalidation.reason !== 'runtimeEvent' ||
      invalidation.affectsOrder),
    streamingInvalidations: invalidations.filter((invalidation) =>
      invalidation.type === 'transcript' &&
      invalidation.reason === 'runtimeEvent' &&
      !invalidation.affectsOrder),
  };
}
