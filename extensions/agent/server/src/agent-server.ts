import { randomUUID } from 'node:crypto';

import {
  AGENT_METHODS,
  AGENT_RESOURCE_KEYS,
  type ArtifactReadParams,
  type ArtifactReadRange,
  type ArtifactReadResult,
  type AgentRuntimeValue,
  type AuthValue,
  type LoginCancelParams,
  type ModelsValue,
  type ResourceReadParams,
  type ResourceReadResult,
  type ThreadReadParams,
  type TurnReadParams,
} from '../../shared/protocol.ts';
import type { AgentResourceInvalidation } from '../../shared/transcript.ts';
import type { AgentStore } from './agent-store.ts';
import type { AgentEngine } from './engine.ts';
import { ArtifactIntegrityError } from './domain/errors.ts';
import { AgentRpcRouter, RpcFault } from './agent-rpc-router.ts';
export { RpcFault } from './agent-rpc-router.ts';
import { ConversationController } from './conversation-controller.ts';
import { ResourceStore } from './resources.ts';
import { searchAgentFiles } from './file-search.ts';
import { TranscriptProjectionRouter } from './transcript-router.ts';
import {
  parseTranscriptResourcesReadParams,
  TranscriptProtocolError,
} from './transcript-projector.ts';

const MAX_ARTIFACT_READ_BYTES = 48 * 1024;

export class AgentServer {
  readonly resources: ResourceStore;
  private readonly engine: AgentEngine;
  private readonly store: AgentStore;
  private readonly transcriptRouter: TranscriptProjectionRouter;
  private readonly rpc: AgentRpcRouter;
  private readonly conversations: ConversationController;
  private loginController: AbortController | null = null;
  private readonly notify: (method: string, params: unknown) => void;
  private closePromise: Promise<void> | null = null;

  constructor(options: {
    engine: AgentEngine;
    store: AgentStore;
    notify: (method: string, params: unknown) => void;
    monotonicNow?: () => number;
  }) {
    this.engine = options.engine;
    this.store = options.store;
    this.notify = options.notify;
    this.resources = new ResourceStore(
      (params) => options.notify(AGENT_METHODS.resourcesInvalidated, params),
    );
    this.transcriptRouter = new TranscriptProjectionRouter({ store: options.store });
    this.conversations = new ConversationController({
      engine: options.engine,
      store: options.store,
      resources: this.resources,
      ...(options.monotonicNow ? { monotonicNow: options.monotonicNow } : {}),
      publishProjectorInvalidations: (invalidations) => this.publishProjectorInvalidations(invalidations),
    });
    this.rpc = new AgentRpcRouter({
      readResources: (params) => this.readResources(params),
      readTranscriptResources: (params) => this.readTranscriptResources(params),
      readModels: () => this.refreshModels(),
      readArtifact: (params) => this.readArtifact(params),
      readThread: (params) => this.readThreadCanvas(params),
      readTurn: (params) => this.readDurableTurn(params),
      searchFiles: (params) => searchAgentFiles(params),
      startLogin: () => this.startLogin(),
      cancelLogin: (params) => this.cancelLogin(params),
      logout: () => this.conversations.enqueue(() => this.logout()),
      createConversation: (params) => this.conversations.enqueue(
        () => this.conversations.createConversation(params),
      ),
      sendMessage: (params) => this.conversations.enqueue(
        () => this.conversations.sendMessage(params),
      ),
      removeQueuedMessage: (params) => this.conversations.enqueue(
        () => this.conversations.removeQueuedMessage(params),
      ),
      runQueuedMessageNow: (params) => this.conversations.enqueue(
        () => this.conversations.runQueuedMessageNow(params),
      ),
      branchMessage: (params, mode) => this.conversations.enqueue(
        () => this.conversations.branchMessage(params, mode),
      ),
      interruptTurn: (params) => this.conversations.turns.interrupt(params),
    });
  }

  async initialize() {
    const auth = await this.engine.authStatus().catch((error): AuthValue => ({
      ...signedOutAuth(),
      state: 'error',
      error: safeMessage(error),
    }));
    this.resources.set(AGENT_RESOURCE_KEYS.auth, sanitizeAuth(auth), false);
    this.resources.set(AGENT_RESOURCE_KEYS.runtime, unloadedRuntime(), false);
    await this.refreshModels(false);
    if (auth.state === 'signed-in') {
      await this.conversations.dispatchOldestQueuedConversation();
    }
  }

  async handle(method: string, params: unknown): Promise<unknown> {
    return this.rpc.handle(method, params);
  }

  private async refreshModels(notify = true): Promise<ModelsValue> {
    const auth = this.resources.get<AuthValue>(AGENT_RESOURCE_KEYS.auth);
    let value: ModelsValue;
    if (auth?.state !== 'signed-in') {
      value = { models: [], defaultModelId: null, error: null };
    } else {
      try {
        const models = await this.engine.listModels();
        value = { models, defaultModelId: models[0]?.id ?? null, error: null };
      } catch (error) {
        value = { models: [], defaultModelId: null, error: safeMessage(error) };
      }
    }
    this.resources.set(AGENT_RESOURCE_KEYS.models, value, notify);
    return value;
  }

  private async readArtifact(params: ArtifactReadParams): Promise<ArtifactReadResult> {
    const requestedRange = params.range.kind === 'lines'
      ? undefined
      : {
          offset: params.range.offset,
          byteLength: params.range.byteLength + (params.range.kind === 'utf8' ? 3 : 0),
        };
    let artifact: Awaited<ReturnType<AgentStore['readArtifact']>>;
    try {
      artifact = await this.store.readArtifact(params.hash, requestedRange);
    } catch (error) {
      if (error instanceof ArtifactIntegrityError) {
        throw new RpcFault(-32023, 'Durable artifact failed integrity verification.', {
          kind: 'durable_corruption',
        });
      }
      throw error;
    }
    if (!artifact) throw new RpcFault(-32015, 'Artifact not found.');
    if (params.range.kind === 'bytes') {
      const start = Math.min(params.range.offset, artifact.byteLength);
      const end = Math.min(artifact.byteLength, start + params.range.byteLength);
      const nextRange: ArtifactReadRange | null = end < artifact.byteLength
        ? { kind: 'bytes', offset: end, byteLength: params.range.byteLength }
        : null;
      return {
        hash: artifact.hash,
        mediaType: artifact.mediaType,
        totalByteLength: artifact.byteLength,
        totalLineCount: null,
        range: { kind: 'bytes', offset: start, byteLength: end - start },
        encoding: 'base64',
        content: artifact.bytes.subarray(0, end - start).toString('base64'),
        truncated: nextRange !== null,
        nextRange,
      };
    }

    if (params.range.kind === 'utf8') {
      const start = Math.min(params.range.offset, artifact.byteLength);
      if (start < artifact.byteLength && isUtf8ContinuationByte(artifact.bytes[0]!)) {
        throw new RpcFault(-32602, 'UTF-8 range offset must start on a code-point boundary.');
      }
      let end = Math.min(artifact.byteLength, start + params.range.byteLength);
      while (
        end > start &&
        end < artifact.byteLength &&
        isUtf8ContinuationByte(artifact.bytes[end - artifact.offset]!)
      ) {
        end -= 1;
      }
      if (end === start && start < artifact.byteLength) {
        end = Math.min(artifact.byteLength, start + params.range.byteLength);
        while (
          end < artifact.byteLength &&
          isUtf8ContinuationByte(artifact.bytes[end - artifact.offset]!)
        ) {
          end += 1;
        }
      }
      let content: string;
      try {
        content = new TextDecoder('utf-8', { fatal: true }).decode(
          artifact.bytes.subarray(0, end - start),
        );
      } catch {
        throw new RpcFault(-32016, 'Artifact does not contain valid UTF-8 text.');
      }
      const nextRange: ArtifactReadRange | null = end < artifact.byteLength
        ? { kind: 'utf8', offset: end, byteLength: params.range.byteLength }
        : null;
      return {
        hash: artifact.hash,
        mediaType: artifact.mediaType,
        totalByteLength: artifact.byteLength,
        totalLineCount: null,
        range: { kind: 'utf8', offset: start, byteLength: end - start },
        encoding: 'utf8',
        content,
        truncated: nextRange !== null,
        nextRange,
      };
    }

    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(artifact.bytes);
    } catch {
      throw new RpcFault(-32016, 'Artifact does not contain valid UTF-8 text.');
    }
    const lines = text.split('\n');
    const startIndex = Math.min(params.range.startLine - 1, lines.length);
    const endIndex = Math.min(lines.length, startIndex + params.range.lineCount);
    const content = lines.slice(startIndex, endIndex).join('\n');
    if (Buffer.byteLength(content, 'utf8') > MAX_ARTIFACT_READ_BYTES) {
      throw new RpcFault(
        -32602,
        `Requested line range exceeds ${MAX_ARTIFACT_READ_BYTES} UTF-8 bytes; use a byte range.`,
      );
    }
    const nextRange: ArtifactReadRange | null = endIndex < lines.length
      ? { kind: 'lines', startLine: endIndex + 1, lineCount: params.range.lineCount }
      : null;
    return {
      hash: artifact.hash,
      mediaType: artifact.mediaType,
      totalByteLength: artifact.byteLength,
      totalLineCount: lines.length,
      range: {
        kind: 'lines',
        startLine: params.range.startLine,
        endLine: endIndex,
      },
      encoding: 'utf8',
      content,
      truncated: nextRange !== null,
      nextRange,
    };
  }

  private async readThreadCanvas(params: ThreadReadParams) {
    await this.conversations.turns.settleWrites();
    if (!this.store.readThreadHistory) {
      throw new RpcFault(-32030, 'Durable thread history is unavailable.');
    }
    return this.store.readThreadHistory(params.conversationId);
  }

  private async readDurableTurn(params: TurnReadParams) {
    await this.conversations.turns.settleWrites();
    if (!this.store.readTurn) {
      throw new RpcFault(-32030, 'Durable turn status is unavailable.');
    }
    return this.store.readTurn(params.conversationId, params.turnId);
  }

  private startLogin() {
    if (this.loginController) throw new RpcFault(-32010, 'A sign-in operation is already running.');
    const operationId = randomUUID();
    const controller = new AbortController();
    this.loginController = controller;
    this.resources.set(AGENT_RESOURCE_KEYS.auth, {
      ...signedOutAuth(),
      state: 'signing-in',
      operationId,
      progress: 'Starting OpenAI device sign-in…',
    });

    void this.engine.login(operationId, controller.signal, (value) => {
      if (this.loginController === controller) {
        this.resources.set(AGENT_RESOURCE_KEYS.auth, sanitizeAuth(value));
      }
    }).then(async () => {
      if (this.loginController !== controller) return;
      const auth = await this.engine.authStatus();
      this.resources.set(AGENT_RESOURCE_KEYS.auth, sanitizeAuth(auth));
      await this.refreshModels();
    }).catch((error) => {
      if (this.loginController !== controller) return;
      this.resources.set(AGENT_RESOURCE_KEYS.auth, controller.signal.aborted
        ? signedOutAuth()
        : { ...signedOutAuth(), state: 'error', error: publicAuthError(error) });
    }).finally(() => {
      if (this.loginController === controller) this.loginController = null;
    });

    return { accepted: true as const, operationId };
  }

  private cancelLogin(params: LoginCancelParams) {
    const auth = this.resources.get<AuthValue>(AGENT_RESOURCE_KEYS.auth);
    if (!this.loginController || auth?.operationId !== params.operationId) {
      throw new RpcFault(-32016, 'The sign-in operation is no longer active.');
    }
    this.loginController?.abort(new DOMException('Sign-in canceled', 'AbortError'));
    this.loginController = null;
    this.resources.set(AGENT_RESOURCE_KEYS.auth, signedOutAuth());
    return { accepted: true as const };
  }

  private async logout() {
    this.loginController?.abort(new DOMException('Sign-in canceled', 'AbortError'));
    this.loginController = null;
    await this.conversations.disposeConversation();
    await this.engine.logout();
    this.resources.set(AGENT_RESOURCE_KEYS.auth, signedOutAuth());
    await this.refreshModels();
    return { ok: true as const };
  }

  close() {
    this.closePromise ??= this.closeOnce();
    return this.closePromise;
  }

  private async closeOnce() {
    this.loginController?.abort(new DOMException('Agent server closed', 'AbortError'));
    this.loginController = null;
    await this.conversations.close();
    this.transcriptRouter.clear();
  }

  private async readResources(params: ResourceReadParams): Promise<ResourceReadResult> {
    const durableRequests = params.requests
      .map((request, index) => ({ index, key: request.key }))
      .filter(({ key }) =>
        key === AGENT_RESOURCE_KEYS.conversationList ||
        key.startsWith('conversation:') ||
        key.startsWith('context:') ||
        key.startsWith('queue:'));
    const durableProjections = durableRequests.length > 0
      ? await this.store.readResourceProjections(durableRequests.map(({ key }) => key))
      : [];
    const durableByRequest = new Map(
      durableRequests.map(({ index }, durableIndex) => [index, durableProjections[durableIndex] ?? null]),
    );
    return {
      resources: params.requests.map((request, index) => {
        if (
          request.key === AGENT_RESOURCE_KEYS.auth ||
          request.key === AGENT_RESOURCE_KEYS.models ||
          request.key === AGENT_RESOURCE_KEYS.runtime
        ) {
          return this.resources.read({ requests: [request] }, (key, value) => {
            if (key === AGENT_RESOURCE_KEYS.runtime && this.conversations.projector) {
              return {
                ...value as AgentRuntimeValue,
                activeTurnElapsedMs: this.conversations.projector.activeElapsedMs(),
              };
            }
            return value;
          }).resources[0]!;
        }
        const projection = durableByRequest.get(index) ?? null;
        if (!projection) {
          return {
            key: request.key,
            status: 'missing' as const,
            serverGeneration: this.resources.serverGeneration,
          };
        }
        if (request.ifNoneMatch === projection.basisSequence) {
          return {
            key: request.key,
            status: 'notModified' as const,
            revision: projection.basisSequence,
            basisSequence: projection.basisSequence,
            serverGeneration: this.resources.serverGeneration,
          };
        }
        return {
          key: request.key,
          status: 'ok' as const,
          revision: projection.basisSequence,
          basisSequence: projection.basisSequence,
          serverGeneration: this.resources.serverGeneration,
          value: projection.value,
        };
      }),
    };
  }

  private async readTranscriptResources(params: unknown) {
    try {
      const parsed = parseTranscriptResourcesReadParams(params);
      await this.conversations.turns.settleWrites();
      return await this.transcriptRouter.read({
        params: parsed,
        serverGeneration: this.resources.serverGeneration,
        liveProjector: this.conversations.projector,
      });
    } catch (error) {
      if (error instanceof TranscriptProtocolError) {
        throw new RpcFault(error.code, error.message);
      }
      throw error;
    }
  }

  private publishProjectorInvalidations(invalidations: AgentResourceInvalidation[]) {
    this.notify(AGENT_METHODS.resourcesInvalidated, {
      invalidations,
      serverGeneration: this.resources.serverGeneration,
    });
  }
}

function isUtf8ContinuationByte(value: number) {
  return (value & 0xc0) === 0x80;
}


function sanitizeAuth(value: AuthValue): AuthValue {
  return {
    ...value,
    displayLabel: value.displayLabel ? safeMessage(value.displayLabel) : null,
    progress: value.progress ? safeMessage(value.progress) : null,
    error: value.error ? safeMessage(value.error) : null,
  };
}

function signedOutAuth(): AuthValue {
  return {
    state: 'signed-out',
    operationId: null,
    displayLabel: null,
    verificationUri: null,
    userCode: null,
    expiresAt: null,
    progress: null,
    error: null,
  };
}

function unloadedRuntime(): AgentRuntimeValue {
  return {
    conversationId: null,
    state: 'unloaded',
    activeTurnId: null,
    activeTurnElapsedMs: null,
    contextProbe: null,
    error: null,
  };
}


function publicAuthError(error: unknown) {
  if (error instanceof DOMException && error.name === 'AbortError') return 'Sign-in was canceled.';
  return 'OpenAI sign-in failed. Please try again.';
}

function safeMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/Bearer\s+\S+/giu, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, '[redacted]')
    .slice(0, 1_000);
}
