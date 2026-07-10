import type { CodexResourceInvalidation } from '../../shared/threadCommands';

type TurnInvalidation = Extract<CodexResourceInvalidation, { type: 'turn' }>;
type WorkItemInvalidation = Extract<CodexResourceInvalidation, { type: 'workItem' }>;

export function partitionStreamingTranscriptInvalidations({
  shouldRefreshTranscript,
  turnInvalidations,
  workItemInvalidations,
}: {
  shouldRefreshTranscript: boolean;
  turnInvalidations: TurnInvalidation[];
  workItemInvalidations: WorkItemInvalidation[];
}) {
  if (shouldRefreshTranscript) {
    return {
      immediateWorkItemInvalidations: workItemInvalidations,
      streamingInvalidations: [] as CodexResourceInvalidation[],
    };
  }

  // Turn invalidations currently originate only from item/agentMessage/delta.
  // Coalesce the matching message work item without delaying unrelated tools.
  const streamingTurnIds = new Set(turnInvalidations.map((invalidation) => invalidation.turnId));
  const streamingWorkItemInvalidations = workItemInvalidations.filter((invalidation) =>
    streamingTurnIds.has(invalidation.turnId));

  return {
    immediateWorkItemInvalidations: workItemInvalidations.filter((invalidation) =>
      !streamingTurnIds.has(invalidation.turnId)),
    streamingInvalidations: [
      ...turnInvalidations,
      ...streamingWorkItemInvalidations,
    ] as CodexResourceInvalidation[],
  };
}
