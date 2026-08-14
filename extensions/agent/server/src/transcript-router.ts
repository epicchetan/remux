import type {
  AgentTranscriptResourcesReadParams,
  AgentTranscriptResourcesReadResult,
  AgentTranscriptSyncRequest,
  AgentTranscriptSyncResource,
} from '../../shared/transcript.ts';
import {
  executionScopeResourceKey,
  MAX_TRANSCRIPT_RESPONSE_BYTES,
  operationDetailResourceKey,
} from '../../shared/transcript.ts';
import type { AgentStore } from './agent-store.ts';
import { createReplayedTranscriptProjector } from './transcript-replay.ts';
import {
  EphemeralTranscriptProjector,
  TranscriptProtocolError,
} from './transcript-projector.ts';
import type {
  DurableTranscriptWindow,
} from './domain/state.ts';
import { DurableTranscriptSelectionError } from './domain/errors.ts';

type FrozenProjection = {
  bytes: number;
  projector: EphemeralTranscriptProjector;
  windows: DurableTranscriptWindow[];
};

export class TranscriptProjectionRouter {
  private readonly store: AgentStore;
  private readonly maxFrozenBytes: number;
  private readonly frozen = new Map<string, FrozenProjection>();
  private frozenBytes = 0;

  constructor(options: {
    store: AgentStore;
    maxFrozenBytes?: number;
  }) {
    this.store = options.store;
    this.maxFrozenBytes = options.maxFrozenBytes ?? 16 * 1024 * 1024;
  }

  async read(options: {
    params: AgentTranscriptResourcesReadParams;
    serverGeneration: string;
    liveProjector: EphemeralTranscriptProjector | null;
  }): Promise<AgentTranscriptResourcesReadResult> {
    if (options.liveProjector?.conversationId === options.params.conversationId) {
      const basisSequence = await this.store.readTranscriptBasis(options.params.conversationId);
      if (basisSequence === null) throw new TranscriptProtocolError(-32015, 'Conversation not found.');
      options.liveProjector.fenceBasis(basisSequence);
      return this.withDurableScopeResources(
        options.params,
        options.liveProjector.read(options.params, options.serverGeneration),
      );
    }

    const basisSequence = await this.store.readTranscriptBasis(options.params.conversationId);
    if (basisSequence === null) throw new TranscriptProtocolError(-32015, 'Conversation not found.');
    const key = projectionCacheKey(options.params, basisSequence);
    let entry = this.frozen.get(key);
    if (!entry) {
      let projection: Awaited<ReturnType<AgentStore['readTranscriptWindowProjection']>>;
      try {
        projection = await this.store.readTranscriptWindowProjection(options.params);
      } catch (error) {
        if (error instanceof DurableTranscriptSelectionError) {
          throw new TranscriptProtocolError(error.code, error.message);
        }
        throw error;
      }
      if (!projection) throw new TranscriptProtocolError(-32015, 'Conversation not found.');
      entry = {
        bytes: Math.max(1024, projection.estimatedBytes),
        projector: createReplayedTranscriptProjector({
          conversationId: options.params.conversationId,
          actions: projection.actions,
          basisSequence: projection.basisSequence,
          live: false,
        }),
        windows: projection.windows,
      };
      if (entry.bytes <= this.maxFrozenBytes) {
        this.frozen.set(key, entry);
        this.frozenBytes += entry.bytes;
        this.trim();
      }
    } else {
      this.frozen.delete(key);
      this.frozen.set(key, entry);
    }
    const normalized = normalizeTranscriptWindows(options.params, entry.windows);
    const response = entry.projector.read(normalized, options.serverGeneration);
    applyDurableWindows(response, entry.windows);
    return this.withDurableScopeResources(options.params, response);
  }

  private async withDurableScopeResources(
    params: AgentTranscriptResourcesReadParams,
    response: AgentTranscriptResourcesReadResult,
  ) {
    const resources = [...response.resources];
    for (const [requestIndex, request] of params.requests.entries()) {
      if (
        request.type !== 'executionScope' &&
        request.type !== 'operationDetail'
      ) continue;
      const key = request.type === 'executionScope'
          ? executionScopeResourceKey(params.conversationId, request.turnId, request.scopeId)
          : operationDetailResourceKey(
              params.conversationId,
              request.turnId,
              request.scopeId,
              request.operationId,
            );
      const value = request.type === 'executionScope'
          ? await this.store.readExecutionScopeTranscriptResource(params.conversationId, request)
          : await this.store.readOperationDetailTranscriptResource(params.conversationId, request);
      resources[requestIndex] = !value
        ? { requestIndex, key, status: 'missing' }
        : request.knownRevision === value.revision &&
            (request.type !== 'executionScope' || request.window === undefined)
          ? { requestIndex, key, status: 'notModified', revision: value.revision }
          : { requestIndex, key, status: 'ok', revision: value.revision, value };
    }
    const hydrated = { ...response, resources };
    if (Buffer.byteLength(JSON.stringify(hydrated), 'utf8') > MAX_TRANSCRIPT_RESPONSE_BYTES) {
      throw new TranscriptProtocolError(-32018, 'Transcript response exceeds the 8 MiB limit.');
    }
    return hydrated;
  }

  clear() {
    this.frozen.clear();
    this.frozenBytes = 0;
  }

  private trim() {
    while (this.frozenBytes > this.maxFrozenBytes && this.frozen.size > 0) {
      const oldest = this.frozen.entries().next().value as
        | [string, FrozenProjection]
        | undefined;
      if (!oldest) return;
      this.frozen.delete(oldest[0]);
      this.frozenBytes -= oldest[1].bytes;
    }
  }
}

function projectionCacheKey(
  params: AgentTranscriptResourcesReadParams,
  basisSequence: number,
) {
  const selection = params.requests.map((request) => {
    if (request.type === 'transcriptSync') return { type: request.type, window: request.window };
    return { type: request.type, turnId: request.turnId, scopeId: request.scopeId };
  });
  return [
    params.conversationId,
    basisSequence,
    JSON.stringify(selection),
  ].join('\0');
}

function normalizeTranscriptWindows(
  params: AgentTranscriptResourcesReadParams,
  windows: DurableTranscriptWindow[],
): AgentTranscriptResourcesReadParams {
  const byIndex = new Map(windows.map((window) => [window.requestIndex, window]));
  return {
    ...params,
    requests: params.requests.map((request, requestIndex) => {
      if (request.type !== 'transcriptSync') return request;
      const window = byIndex.get(requestIndex);
      if (!window || window.turnIds.length === 0) {
        return { ...request, window: { kind: 'tail', count: 1 } };
      }
      return {
        ...request,
        window: {
          kind: 'range',
          startTurnId: window.turnIds[0]!,
          endTurnId: window.turnIds.at(-1)!,
        },
      } satisfies AgentTranscriptSyncRequest;
    }),
  };
}

function applyDurableWindows(
  response: AgentTranscriptResourcesReadResult,
  windows: DurableTranscriptWindow[],
) {
  for (const window of windows) {
    const result = response.resources[window.requestIndex];
    if (result?.status !== 'ok' || !result.value || !('turnOrder' in result.value)) continue;
    const value = result.value as AgentTranscriptSyncResource;
    value.turnOrder = [...window.turnIds];
    value.window = {
      startIndex: window.startIndex,
      endIndexExclusive: window.endIndexExclusive,
      hasEarlier: window.hasEarlier,
      hasLater: window.hasLater,
      turnIds: [...window.turnIds],
    };
  }
}
