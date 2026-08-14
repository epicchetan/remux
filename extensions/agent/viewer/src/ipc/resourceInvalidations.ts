import { subscribeIpcEvents } from '@remux/viewer-kit/ipc';

import { AGENT_METHODS } from '../../../shared/protocol';
import type { AgentResourceInvalidation } from '../../../shared/transcript';
import { invalidateTranscriptResources } from '../transcript/resourceStore';

export type AgentInvalidationEnvelope = {
  invalidations: AgentResourceInvalidation[];
  serverGeneration: string | null;
};

type GenericInvalidationListener = (invalidations: AgentResourceInvalidation[]) => void;

const genericListeners = new Set<GenericInvalidationListener>();
const pendingGenericInvalidations = new Map<string, AgentResourceInvalidation>();
let stopBridge: (() => void) | null = null;

export function startAgentResourceInvalidationBridge() {
  if (stopBridge) return stopBridge;
  const unsubscribe = subscribeIpcEvents((events) => {
    const envelopes = events
      .filter((event) => event.method === AGENT_METHODS.resourcesInvalidated)
      .map((event) => parseAgentInvalidationEnvelope(event.params));
    for (const envelope of envelopes) {
      const invalidations = dedupeInvalidations(envelope.invalidations);
      if (invalidations.length === 0) continue;
      const generic = invalidations.filter((value) => value.type === 'resource');
      if (genericListeners.size === 0) {
        for (const invalidation of generic) {
          pendingGenericInvalidations.set(`${invalidation.type}:${invalidation.key}`, invalidation);
        }
      } else {
        for (const listener of genericListeners) listener(generic);
      }
      void invalidateTranscriptResources(invalidations, envelope.serverGeneration);
    }
  });
  stopBridge = () => {
    unsubscribe();
    stopBridge = null;
  };
  return stopBridge;
}

export function subscribeAgentResourceInvalidations(
  onGenericInvalidation: (invalidations: AgentResourceInvalidation[]) => void,
) {
  startAgentResourceInvalidationBridge();
  genericListeners.add(onGenericInvalidation);
  if (pendingGenericInvalidations.size > 0) {
    const pending = [...pendingGenericInvalidations.values()];
    pendingGenericInvalidations.clear();
    onGenericInvalidation(pending);
  }
  return () => genericListeners.delete(onGenericInvalidation);
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
    const key = `${invalidation.type}:${invalidation.key}`;
    const previous = byKey.get(key);
    if (
      previous &&
      previous.type !== 'resource' &&
      invalidation.type !== 'resource' &&
      previous.basisSequence > invalidation.basisSequence
    ) continue;
    byKey.set(key, invalidation);
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
  if (
    typeof scoped.conversationId !== 'string' ||
    !Number.isSafeInteger(scoped.basisSequence) ||
    Number(scoped.basisSequence) < 0
  ) return false;
  if (invalidation.type === 'transcript') {
    return (invalidation.reason === 'sendAccepted' ||
      invalidation.reason === 'runtimeEvent' ||
      invalidation.reason === 'terminal') &&
      typeof invalidation.affectsOrder === 'boolean' &&
      typeof invalidation.affectsLayout === 'boolean';
  }
  if (invalidation.type === 'executionScope') {
    return typeof invalidation.turnId === 'string' &&
      typeof invalidation.scopeId === 'string' &&
      typeof invalidation.affectsLayout === 'boolean' &&
      (invalidation.reason === 'runtimeEvent' || invalidation.reason === 'terminal');
  }
  return false;
}
