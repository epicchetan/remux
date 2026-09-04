import { rpc } from '@remux/viewer-kit/ipc';

import {
  NATIVE_AGENT_METHODS,
  type NativeAgentResourceKey,
  type NativeAgentResourceReadResult,
  type NativeAgentTurnFrame,
  type NativeTranscriptWindow,
} from '../../../shared/native-agent-protocol.ts';
import {
  AGENT_TRANSCRIPT_PROJECTION_VERSION,
  AGENT_TRANSCRIPT_PROTOCOL_VERSION,
  type AgentExecutionScopeRequest,
  type AgentOperationDetailRequest,
  type AgentTranscriptResourceRequest,
  type AgentTranscriptResourcesReadResult,
  type AgentTranscriptSyncRequest,
  type AgentTurnRenderRequest,
} from '../../../shared/transcript.ts';
import {
  projectNativeExecutionScope,
  projectNativeChildExecutionScope,
  projectNativeOperationDetail,
  projectNativeTranscript,
  projectNativeTurn,
  nativeFederatedExecutionId,
} from '../nativeTranscriptViewModel.ts';

export async function readTranscriptResources(
  conversationId: string,
  requests: AgentTranscriptResourceRequest[],
  options: {
    historySync?: 'if-stale' | 'force';
    knownServerGeneration?: string | null;
    signal?: AbortSignal;
  } = {},
): Promise<AgentTranscriptResourcesReadResult> {
  const keys = requests.map((request) => nativeKey(conversationId, request));
  const nativeRequests = new Map<NativeAgentResourceKey, { key: NativeAgentResourceKey; ifNoneMatch?: number }>();
  for (const [index, key] of keys.entries()) {
    const request = requests[index]!;
    const knownNativeRevision = request.type === 'turn' || request.type === 'transcriptSync'
      ? request.knownNativeRevision
      : undefined;
    const existing = nativeRequests.get(key);
    nativeRequests.set(key, knownNativeRevision === undefined
      ? existing ?? { key }
      : { key, ifNoneMatch: knownNativeRevision });
  }
  const { historySync, knownServerGeneration, signal } = options;
  const result = await rpc.query<NativeAgentResourceReadResult>(
    NATIVE_AGENT_METHODS.transcriptRead,
    {
      focusedConversationId: conversationId,
      ...(historySync ? { historySync } : {}),
      ...(knownServerGeneration ? { knownServerGeneration } : {}),
      visibility: 'foreground',
      requests: [...nativeRequests.values()],
    },
    { resourceKey: `agent/transcript:${conversationId}`, ...(signal ? { signal } : {}) },
  );
  const byKey = new Map(result.resources.map((resource) => [resource.key, resource]));
  return {
    conversationId,
    serverGeneration: result.serverGeneration,
    resources: requests.map((request, requestIndex) => {
      const key = keys[requestIndex]!;
      const resource = byKey.get(key);
      if (!resource || resource.status === 'missing') {
        return { requestIndex, key, status: 'missing' as const, code: 'resourceUnavailable' as const };
      }
      if (resource.status !== 'ok') {
        return {
          requestIndex,
          key,
          status: 'notModified' as const,
          basisSequence: resource.basisSequence,
          revision: request.type === 'turn' ? request.knownRevision : String(resource.revision),
          nativeRevision: resource.revision,
        };
      }
      if (request.type === 'transcriptSync') {
        const value = resource.value as NativeTranscriptWindow;
        return {
          requestIndex,
          key,
          status: 'ok' as const,
          basisSequence: resource.basisSequence,
          revision: String(resource.revision),
          nativeRevision: resource.revision,
          value: projectNativeTranscript(value, request, resource.basisSequence),
        };
      }
      const frame = resource.value as NativeAgentTurnFrame;
      if (request.type === 'turn') {
        return {
          requestIndex,
          key,
          status: 'ok' as const,
          basisSequence: resource.basisSequence,
          revision: frame.renderRevision,
          nativeRevision: resource.revision,
          value: projectNativeTurn(frame),
        };
      }
      if (request.type === 'executionScope') {
        const federatedExecutionId = nativeFederatedExecutionId(request.scopeId);
        return {
          requestIndex,
          key,
          status: 'ok' as const,
          basisSequence: resource.basisSequence,
          nativeRevision: resource.revision,
          revision: federatedExecutionId
            ? String(resource.revision)
            : frame.renderRevision,
          value: federatedExecutionId
            ? projectNativeChildExecutionScope(
                conversationId,
                resource.value as NativeTranscriptWindow,
                request,
                resource.basisSequence,
              )
            : projectNativeExecutionScope(conversationId, frame, request, resource.basisSequence),
        };
      }
      return {
        requestIndex,
        key,
        status: 'ok' as const,
        basisSequence: resource.basisSequence,
        nativeRevision: resource.revision,
        revision: frame.renderRevision,
        value: projectNativeOperationDetail(conversationId, frame, request),
      };
    }),
  };
}

function nativeKey(
  conversationId: string,
  request: AgentTranscriptResourceRequest,
): NativeAgentResourceKey {
  if (request.type === 'executionScope') {
    const executionId = nativeFederatedExecutionId(request.scopeId);
    if (executionId) return `agent/execution-transcript:${executionId}:tail-24`;
  }
  if (request.type === 'turn') return `agent/turn:${request.turnId}:summary`;
  if (request.type !== 'transcriptSync') return `agent/turn:${request.turnId}`;
  return transcriptNativeResourceKey(conversationId, request.window);
}

export function transcriptNativeResourceKey(
  conversationId: string,
  window: AgentTranscriptSyncRequest['window'],
): NativeAgentResourceKey {
  return `agent/transcript:${conversationId}:${nativeWindow(window)}`;
}

function nativeWindow(window: AgentTranscriptSyncRequest['window']) {
  switch (window.kind) {
    case 'tail':
      return `tail-${window.count ?? 24}`;
    case 'around':
      return `around:${window.turnId}:${window.before}:${window.after}`;
    case 'range':
      return `range:${window.startTurnId}:${window.endTurnId}`;
  }
}

export const nativeTranscriptProtocol = {
  protocolVersion: AGENT_TRANSCRIPT_PROTOCOL_VERSION,
  projectionVersion: AGENT_TRANSCRIPT_PROJECTION_VERSION,
} as const;

export type NativeTranscriptDetailRequest = AgentTurnRenderRequest | AgentExecutionScopeRequest | AgentOperationDetailRequest;
