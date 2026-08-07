import { subscribeIpcEvents } from '@remux/viewer-kit/ipc';

import { AGENT_METHODS } from '../../../shared/protocol';
import type { AgentResourceInvalidation } from '../../../shared/transcript';
import { invalidateTranscriptResources } from '../transcript/resourceStore';

export type AgentInvalidationEnvelope = {
  invalidations: AgentResourceInvalidation[];
  serverGeneration: string | null;
};

export function subscribeAgentResourceInvalidations(
  onGenericInvalidation: (invalidations: AgentResourceInvalidation[]) => void,
) {
  return subscribeIpcEvents((events) => {
    const envelopes = events
      .filter((event) => event.method === AGENT_METHODS.resourcesInvalidated)
      .map((event) => parseAgentInvalidationEnvelope(event.params));
    const invalidations = dedupeInvalidations(envelopes.flatMap((value) => value.invalidations));
    if (invalidations.length === 0) return;
    onGenericInvalidation(invalidations.filter((value) => value.type === 'resource'));
    void invalidateTranscriptResources(invalidations);
  });
}

export function parseAgentInvalidationEnvelope(params: unknown): AgentInvalidationEnvelope {
  if (!params || typeof params !== 'object') {
    return { invalidations: [], serverGeneration: null };
  }
  const value = params as { invalidations?: unknown; serverGeneration?: unknown };
  return {
    invalidations: Array.isArray(value.invalidations)
      ? value.invalidations.filter(isAgentResourceInvalidation)
      : [],
    serverGeneration: typeof value.serverGeneration === 'string'
      ? value.serverGeneration
      : null,
  };
}

function dedupeInvalidations(invalidations: AgentResourceInvalidation[]) {
  const byKey = new Map<string, AgentResourceInvalidation>();
  for (const invalidation of invalidations) {
    byKey.set(`${invalidation.type}:${invalidation.key}`, invalidation);
  }
  return [...byKey.values()];
}

function isAgentResourceInvalidation(value: unknown): value is AgentResourceInvalidation {
  if (!value || typeof value !== 'object') return false;
  const invalidation = value as Partial<AgentResourceInvalidation>;
  if (typeof invalidation.type !== 'string' || typeof invalidation.key !== 'string') return false;
  if (invalidation.type === 'resource') {
    return invalidation.reason === 'created' ||
      invalidation.reason === 'updated' ||
      invalidation.reason === 'deleted';
  }
  const scoped = invalidation as Partial<Exclude<AgentResourceInvalidation, { type: 'resource' }>>;
  if (typeof scoped.conversationId !== 'string') return false;
  if (invalidation.type === 'transcript') {
    return (invalidation.reason === 'sendAccepted' ||
      invalidation.reason === 'runtimeEvent' ||
      invalidation.reason === 'terminal') &&
      typeof invalidation.affectsOrder === 'boolean' &&
      typeof invalidation.affectsLayout === 'boolean';
  }
  if (
    invalidation.type === 'workGroup' ||
    invalidation.type === 'workEntryDetail'
  ) {
    return typeof invalidation.turnId === 'string' &&
      typeof invalidation.segmentId === 'string' &&
      typeof invalidation.groupId === 'string' &&
      typeof invalidation.affectsLayout === 'boolean' &&
      (invalidation.reason === 'runtimeEvent' || invalidation.reason === 'terminal') &&
      (invalidation.type !== 'workEntryDetail' || typeof invalidation.rowId === 'string');
  }
  return false;
}
