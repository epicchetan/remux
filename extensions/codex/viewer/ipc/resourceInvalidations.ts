import type {
  CodexResourceInvalidation,
  CodexResourcesInvalidatedNotification,
} from '../../shared/threadCommands';
import { invalidateThreadResources } from '../threads/historyStore';
import { invalidateThreadComposerStateResources } from '../threads/composerStateStore';
import { invalidateThreadRuntimeResources } from '../threads/runtimeStore';
import { invalidateOperationQueueResources } from '../threads/operationQueueStore';
import { invalidateTranscriptResources } from '../transcript/store';
import { subscribeIpcEvents } from '@remux/viewer-kit/ipc';

export const resourcesInvalidatedMethod = 'remux/codex/resources/invalidated';

export async function applyCodexResourceInvalidations(invalidations: CodexResourceInvalidation[]) {
  const uniqueInvalidations = dedupeInvalidations(invalidations);
  if (uniqueInvalidations.length === 0) {
    return;
  }

  // Transcript presentation is the user-visible critical path. Start it in
  // the same task as the invalidation instead of waiting for history, queue,
  // composer, and runtime reads to finish first.
  await Promise.all([
    invalidateTranscriptResources(uniqueInvalidations),
    invalidateThreadResources(uniqueInvalidations),
    invalidateThreadComposerStateResources(uniqueInvalidations),
    invalidateThreadRuntimeResources(uniqueInvalidations),
    invalidateOperationQueueResources(uniqueInvalidations),
  ]);
}

export function subscribeCodexResourceInvalidations() {
  return subscribeIpcEvents((events) => {
    const invalidations = events.flatMap((event) => {
      if (event.method !== resourcesInvalidatedMethod) {
        return [];
      }

      return parseResourcesInvalidatedParams(event.params).invalidations;
    });

    if (invalidations.length > 0) {
      void applyCodexResourceInvalidations(invalidations);
    }
  });
}

function parseResourcesInvalidatedParams(params: unknown): CodexResourcesInvalidatedNotification {
  if (!params || typeof params !== 'object' || !Array.isArray((params as { invalidations?: unknown }).invalidations)) {
    return { invalidations: [] };
  }

  return {
    invalidations: (params as { invalidations: unknown[] }).invalidations.filter(isCodexResourceInvalidation),
  };
}

function dedupeInvalidations(invalidations: CodexResourceInvalidation[]) {
  const seen = new Set<string>();
  const uniqueInvalidations: CodexResourceInvalidation[] = [];
  for (const invalidation of invalidations) {
    const key = `${invalidation.type}:${invalidation.key}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    uniqueInvalidations.push(invalidation);
  }
  return uniqueInvalidations;
}

function isCodexResourceInvalidation(value: unknown): value is CodexResourceInvalidation {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const invalidation = value as Partial<CodexResourceInvalidation>;
  if (
    typeof invalidation.key !== 'string' ||
    (
      invalidation.reason !== 'sendAccepted' &&
      invalidation.reason !== 'commandAccepted' &&
      invalidation.reason !== 'appServerEvent'
    )
  ) {
    return false;
  }

  switch (invalidation.type) {
    case 'threadHistory':
      return true;
    case 'threadRuntime':
    case 'threadOperationQueue':
    case 'threadComposerState':
    case 'threadSummary':
    case 'threadTokenUsage':
    case 'threadTranscript':
      return typeof invalidation.threadId === 'string';
    case 'turn':
      return typeof invalidation.threadId === 'string' && typeof invalidation.turnId === 'string';
    case 'workItem':
      return (
        typeof invalidation.threadId === 'string' &&
        typeof invalidation.turnId === 'string' &&
        typeof invalidation.itemId === 'string'
      );
    case 'transcript':
      return (
        typeof invalidation.threadId === 'string' &&
        (invalidation.turnId === undefined || typeof invalidation.turnId === 'string') &&
        typeof invalidation.affectsLayout === 'boolean' &&
        typeof invalidation.affectsOrder === 'boolean'
      );
    case 'workGroup':
      return (
        typeof invalidation.threadId === 'string' &&
        typeof invalidation.turnId === 'string' &&
        typeof invalidation.segmentId === 'string' &&
        typeof invalidation.groupId === 'string' &&
        typeof invalidation.affectsLayout === 'boolean'
      );
    case 'workEntryDetail':
      return (
        typeof invalidation.threadId === 'string' &&
        typeof invalidation.turnId === 'string' &&
        typeof invalidation.segmentId === 'string' &&
        typeof invalidation.groupId === 'string' &&
        typeof invalidation.rowId === 'string' &&
        typeof invalidation.affectsLayout === 'boolean'
      );
    default:
      return false;
  }
}
