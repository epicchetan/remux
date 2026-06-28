import type {
  CodexResourceInvalidation,
  CodexResourcesInvalidatedNotification,
} from '../../shared/threadCommands';
import { invalidateThreadResources } from '../threads/historyStore';
import { invalidateThreadComposerStateResources } from '../threads/composerStateStore';
import { invalidateThreadRuntimeResources } from '../threads/runtimeStore';
import { invalidateTranscriptResources } from '../transcript/store';
import { subscribeIpcEvents } from './client';

export const resourcesInvalidatedMethod = 'remux/codex/resources/invalidated';

export async function applyCodexResourceInvalidations(invalidations: CodexResourceInvalidation[]) {
  const uniqueInvalidations = dedupeInvalidations(invalidations);
  if (uniqueInvalidations.length === 0) {
    return;
  }

  await Promise.all([
    invalidateThreadResources(uniqueInvalidations),
    invalidateThreadComposerStateResources(uniqueInvalidations),
    invalidateThreadRuntimeResources(uniqueInvalidations),
  ]);
  await invalidateTranscriptResources(uniqueInvalidations);
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

  if (invalidation.type === 'threadHistory') {
    return true;
  }

  return (
    (
      invalidation.type === 'threadRuntime' ||
      invalidation.type === 'threadComposerState' ||
      invalidation.type === 'threadSummary' ||
      invalidation.type === 'threadTokenUsage' ||
      invalidation.type === 'threadTranscript'
    ) &&
    typeof invalidation.threadId === 'string'
  ) || (
    invalidation.type === 'turn' &&
    typeof invalidation.threadId === 'string' &&
    typeof invalidation.turnId === 'string'
  ) || (
    invalidation.type === 'workItem' &&
    typeof invalidation.threadId === 'string' &&
    typeof invalidation.turnId === 'string' &&
    typeof invalidation.itemId === 'string'
  );
}
