import { subscribeIpcEvents } from '@remux/viewer-kit/ipc';

import {
  NATIVE_AGENT_METHODS,
  NATIVE_AGENT_PROTOCOL_VERSION,
  parseAgentExecutionResourceKey,
  parseAgentExecutionTranscriptResourceKey,
  type NativeAgentResourceKey,
  type NativeAgentResourcesInvalidated,
} from '../../../shared/native-agent-protocol.ts';
import type { AgentResourceInvalidation } from '../../../shared/transcript.ts';
import {
  invalidateTranscriptResources,
  revalidateNativeExecutionResources,
} from '../transcript/resourceStore.ts';

export type AgentInvalidationEnvelope = NativeAgentResourcesInvalidated;
type GenericInvalidationListener = (keys: NativeAgentResourceKey[]) => void;

const genericListeners = new Set<GenericInvalidationListener>();
const pendingKeys = new Set<NativeAgentResourceKey>();
let stopBridge: (() => void) | null = null;

export function startAgentResourceInvalidationBridge() {
  if (stopBridge) return stopBridge;
  const unsubscribe = subscribeIpcEvents((events) => {
    const envelopes = events
      .filter((event) => event.method === NATIVE_AGENT_METHODS.resourcesInvalidated)
      .map((event) => parseAgentInvalidationEnvelope(event.params));
    for (const envelope of envelopes) {
      if (envelope.keys.length === 0) continue;
      if (genericListeners.size === 0) {
        for (const key of envelope.keys) pendingKeys.add(key);
      } else {
        for (const listener of genericListeners) listener([...envelope.keys]);
      }
      const turnIds = envelope.keys.flatMap((key) =>
        key.startsWith('agent/turn:') ? [key.slice('agent/turn:'.length)] : []);
      const transcriptInvalidations = envelope.keys.flatMap((key): AgentResourceInvalidation[] => {
        const match = /^agent\/transcript:([^:]+):/u.exec(key);
        if (!match) return [];
        return [{
          type: 'transcript',
          key: `transcript:${match[1]!}`,
          conversationId: match[1]!,
          ...(turnIds.length === 1 ? { turnId: turnIds[0] } : {}),
          reason: 'runtimeEvent',
          affectsOrder: false,
          affectsLayout: true,
          basisSequence: envelope.basisSequence,
        }];
      });
      if (transcriptInvalidations.length > 0) {
        void invalidateTranscriptResources(transcriptInvalidations, envelope.serverGeneration);
      }
      const executionIds = envelope.keys.flatMap((key) => {
        const executionId = parseAgentExecutionResourceKey(key)
          ?? parseAgentExecutionTranscriptResourceKey(key)?.executionId;
        return executionId ? [executionId] : [];
      });
      if (executionIds.length > 0) {
        void revalidateNativeExecutionResources(executionIds, envelope.serverGeneration);
      }
    }
  });
  stopBridge = () => {
    unsubscribe();
    stopBridge = null;
  };
  return stopBridge;
}

export function subscribeAgentResourceInvalidations(onInvalidation: GenericInvalidationListener) {
  startAgentResourceInvalidationBridge();
  genericListeners.add(onInvalidation);
  if (pendingKeys.size > 0) {
    const pending = [...pendingKeys];
    pendingKeys.clear();
    onInvalidation(pending);
  }
  return () => genericListeners.delete(onInvalidation);
}

export function parseAgentInvalidationEnvelope(params: unknown): AgentInvalidationEnvelope {
  if (!params || typeof params !== 'object') return emptyEnvelope();
  const value = params as Partial<NativeAgentResourcesInvalidated>;
  if (
    value.protocolVersion !== NATIVE_AGENT_PROTOCOL_VERSION ||
    typeof value.serverGeneration !== 'string' ||
    !Number.isSafeInteger(value.basisSequence) ||
    Number(value.basisSequence) < 0 ||
    !Array.isArray(value.keys)
  ) return emptyEnvelope();
  return {
    protocolVersion: NATIVE_AGENT_PROTOCOL_VERSION,
    serverGeneration: value.serverGeneration,
    basisSequence: Number(value.basisSequence),
    keys: [...new Set(value.keys.filter(isNativeResourceKey))],
  };
}

function emptyEnvelope(): AgentInvalidationEnvelope {
  return {
    protocolVersion: NATIVE_AGENT_PROTOCOL_VERSION,
    serverGeneration: '',
    basisSequence: 0,
    keys: [],
  };
}

function isNativeResourceKey(value: unknown): value is NativeAgentResourceKey {
  return typeof value === 'string' && (
    value === 'agent/providers' ||
    value === 'agent/conversations' ||
    /^agent\/(?:models|conversation|runtime|queue|turn|execution|transcript|execution-transcript|artifact):/u.test(value)
  );
}
