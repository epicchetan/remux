import { createHash, randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import type { AssistantMessage } from '@earendil-works/pi-ai';

import {
  AGENT_METHODS,
  AGENT_RESOURCE_KEYS,
  conversationResourceKey,
  contextResourceKey,
  queueResourceKey,
  type AgentCommandErrorData,
  type ArtifactReadParams,
  type ArtifactReadRange,
  type ArtifactReadResult,
  type AgentRuntimeValue,
  type AgentFileSearchParams,
  type AuthValue,
  type ConversationSummary,
  type ConversationCreateParams,
  type LoginCancelParams,
  type MessageSendParams,
  type MessageQueueMutationParams,
  type MessageBranchParams,
  type MessageBranchResult,
  type ModelsValue,
  type ReasoningLevel,
  type ResourceReadParams,
  type ResourceReadResult,
  type TurnInterruptParams,
  type ThreadReadParams,
  type TurnReadParams,
} from '../../shared/protocol.ts';
import type { AgentResourceInvalidation } from '../../shared/transcript.ts';
import type { AgentConversationJournal } from './conversation-journal.ts';
import type {
  AgentEngine,
  ConversationRuntime,
  RuntimeEvent,
  WorkUnitEnterInput,
  WorkUnitReturnInput,
} from './engine.ts';
import {
  normalizeWorkUnitReturnInput,
  type DurableInferenceContext,
  type PreparedWorkUnitReturn,
  type DurableTranscriptAction,
  type DurableTranscriptProjectionAction,
  type DurableTranscriptMutation,
  type DurableTurnHandle,
} from './storage/repository.ts';
import { ArtifactIntegrityError } from './storage/artifact-store.ts';
import { ResourceStore } from './resources.ts';
import { searchAgentFiles } from './file-search.ts';
import { agentPromptImages, agentPromptText, parseAgentComposerParts } from './user-input.ts';
import { createReplayedTranscriptProjector } from './transcript-replay.ts';
import { TranscriptProjectionRouter } from './transcript-router.ts';
import {
  EphemeralTranscriptProjector,
  parseTranscriptResourcesReadParams,
  TranscriptProtocolError,
} from './transcript-projector.ts';

const MAX_ARTIFACT_READ_BYTES = 48 * 1024;
const MAX_ARTIFACT_READ_LINES = 400;
const MAX_RESOURCE_READ_REQUESTS = 64;
const SHA256 = /^[0-9a-f]{64}$/u;

export class RpcFault extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'RpcFault';
    this.code = code;
    this.data = data;
  }
}

export class AgentServer {
  readonly resources: ResourceStore;
  private readonly engine: AgentEngine;
  private readonly journal: AgentConversationJournal;
  private readonly transcriptRouter: TranscriptProjectionRouter;
  private runtime: ConversationRuntime | null = null;
  private projector: EphemeralTranscriptProjector | null = null;
  private loginController: AbortController | null = null;
  private conversationId: string | null = null;
  private conversationOperationId: string | null = null;
  private readonly notify: (method: string, params: unknown) => void;
  private readonly monotonicNow: () => number;
  private conversationCommandTail: Promise<void> = Promise.resolve();
  private turnWriteTail: Promise<void> = Promise.resolve();
  private turnWriteError: unknown = null;
  private activeDurableTurn: DurableTurnHandle | null = null;
  private activeDurableScope: DurableTurnHandle | null = null;
  private readonly toolScopes = new Map<string, DurableTurnHandle>();
  private readonly pendingWorkUnitReturns = new Map<string, {
    handle: DurableTurnHandle;
    prepared: PreparedWorkUnitReturn;
  }>();
  private activeTurnStartedMonotonicAt: number | null = null;
  private pendingAssistantText = '';
  private pendingAssistantReasoning = '';
  private inferenceAssistantText = '';
  private inferenceAssistantReasoning = '';
  private assistantFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private turnCompletion: Promise<void> | null = null;
  private durabilityFailure: Promise<void> | null = null;
  private closePromise: Promise<void> | null = null;
  private nextQueuedOperationId: string | null = null;

  constructor(options: {
    engine: AgentEngine;
    journal: AgentConversationJournal;
    notify: (method: string, params: unknown) => void;
    monotonicNow?: () => number;
  }) {
    this.engine = options.engine;
    this.journal = options.journal;
    this.notify = options.notify;
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.resources = new ResourceStore(
      (params) => options.notify(AGENT_METHODS.resourcesInvalidated, params),
    );
    this.transcriptRouter = new TranscriptProjectionRouter({ journal: options.journal });
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
      const queuedConversationId = await this.journal.readOldestQueuedConversationId?.();
      if (queuedConversationId) {
        void this.enqueueConversationCommand(
          () => this.dispatchNextQueuedMessage(queuedConversationId),
        );
      }
    }
  }

  async handle(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case AGENT_METHODS.resourcesRead:
        return this.readResources(parseResourceRead(params));
      case AGENT_METHODS.transcriptResourcesRead:
        return this.readTranscriptResources(params);
      case AGENT_METHODS.modelsRead:
        return this.refreshModels();
      case AGENT_METHODS.artifactRead:
        return this.readArtifact(parseArtifactRead(params));
      case AGENT_METHODS.threadRead:
        return this.readThreadCanvas(parseThreadRead(params));
      case AGENT_METHODS.turnRead:
        return this.readDurableTurn(parseTurnRead(params));
      case AGENT_METHODS.filesSearch:
        return searchAgentFiles(parseFileSearch(params));
      case AGENT_METHODS.authLoginStart:
        return this.startLogin();
      case AGENT_METHODS.authLoginCancel:
        return this.cancelLogin(parseLoginCancel(params));
      case AGENT_METHODS.authLogout:
        return this.enqueueConversationCommand(() => this.logout());
      case AGENT_METHODS.conversationCreate:
        return this.enqueueConversationCommand(
          () => this.createConversation(parseConversationCreate(params)),
        );
      case AGENT_METHODS.messageSend:
        return this.enqueueConversationCommand(
          () => this.sendMessage(parseMessageSend(params)),
        );
      case AGENT_METHODS.messageQueueRemove:
        return this.enqueueConversationCommand(
          () => this.removeQueuedMessage(parseMessageQueueMutation(params)),
        );
      case AGENT_METHODS.messageQueueRunNow:
        return this.enqueueConversationCommand(
          () => this.runQueuedMessageNow(parseMessageQueueMutation(params)),
        );
      case AGENT_METHODS.messageEdit:
        return this.enqueueConversationCommand(
          () => this.branchMessage(parseMessageBranch(params), 'edit'),
        );
      case AGENT_METHODS.messageFork:
        return this.enqueueConversationCommand(
          () => this.branchMessage(parseMessageBranch(params), 'fork'),
        );
      case AGENT_METHODS.turnInterrupt:
        return this.interrupt(parseTurnInterrupt(params));
      default:
        throw new RpcFault(-32601, `Method not found: ${method}`);
    }
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
    let artifact: Awaited<ReturnType<AgentConversationJournal['readArtifact']>>;
    try {
      artifact = await this.journal.readArtifact(params.hash, requestedRange);
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
    await this.turnWriteTail;
    if (this.turnWriteError) throw this.turnWriteError;
    if (!this.journal.readThreadHistory) {
      throw new RpcFault(-32030, 'Durable thread history is unavailable.');
    }
    return this.journal.readThreadHistory(params.conversationId);
  }

  private async readDurableTurn(params: TurnReadParams) {
    await this.turnWriteTail;
    if (this.turnWriteError) throw this.turnWriteError;
    if (!this.journal.readTurn) {
      throw new RpcFault(-32030, 'Durable turn status is unavailable.');
    }
    return this.journal.readTurn(params.conversationId, params.turnId);
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
    await this.disposeConversation();
    await this.engine.logout();
    this.resources.set(AGENT_RESOURCE_KEYS.auth, signedOutAuth());
    await this.refreshModels();
    return { ok: true as const };
  }

  close() {
    this.closePromise ??= this.closeOnce();
    return this.closePromise;
  }

  private async createConversation(params: ConversationCreateParams) {
    const auth = this.resources.get<AuthValue>(AGENT_RESOURCE_KEYS.auth);
    if (auth?.state !== 'signed-in') throw new RpcFault(-32011, 'Sign in before starting a conversation.');
    const models = this.resources.get<ModelsValue>(AGENT_RESOURCE_KEYS.models);
    const selected = models?.models.find((model) => model.id === params.modelId);
    if (!selected) throw new RpcFault(-32602, 'The selected model is unavailable.');
    if (!selected.supportedReasoning.includes(params.reasoning)) {
      throw new RpcFault(-32602, 'The selected reasoning level is unavailable for this model.');
    }
    if (this.conversationId) {
      const current = this.resources.get<AgentRuntimeValue>(AGENT_RESOURCE_KEYS.runtime);
      if (
        (current?.state === 'running' || current?.state === 'interrupting') &&
        this.conversationOperationId !== params.operationId
      ) {
        throw activeRuntimeBusyFault(current);
      }
    }

    const cwd = await canonicalDirectory(params.cwd);
    let durable: Awaited<ReturnType<AgentConversationJournal['createConversation']>>;
    try {
      durable = await this.journal.createConversation({
        operationId: params.operationId,
        cwd,
        modelId: params.modelId,
        reasoning: params.reasoning,
      });
    } catch (error) {
      if (isOperationConflict(error, params.operationId)) {
        throw new RpcFault(-32018, 'Conversation creation operation conflicts with an earlier request.', {
          kind: 'operation_conflict',
          operationId: params.operationId,
        });
      }
      throw error;
    }
    if (!durable.replayed) {
      this.resources.invalidateKey(conversationResourceKey(durable.conversationId), 'created');
      this.resources.invalidateKey(AGENT_RESOURCE_KEYS.conversationList, 'updated');
    }

    await this.loadConversationRuntime({
      id: durable.conversationId,
      cwd,
      modelId: params.modelId,
      reasoning: params.reasoning,
    }, params.operationId);
    return { conversationId: durable.conversationId };
  }

  private async sendMessage(params: MessageSendParams) {
    if (!params.text.trim()) throw new RpcFault(-32602, 'Message text cannot be empty.');
    let queuedReplay;
    try {
      queuedReplay = await this.journal.reconcileQueuedTurn(params);
    } catch (error) {
      if (isOperationConflict(error, params.operationId)) {
        throw new RpcFault(-32018, 'Message operation conflicts with an earlier request.', {
          kind: 'operation_conflict', operationId: params.operationId,
        });
      }
      throw error;
    }
    if (queuedReplay) return {
      accepted: true as const,
      delivery: queuedReplay.delivery,
      operationId: queuedReplay.operationId,
      turnId: queuedReplay.turnId,
    };
    let replay: Awaited<ReturnType<AgentConversationJournal['reconcileTurn']>>;
    try {
      replay = await this.journal.reconcileTurn(params);
    } catch (error) {
      if (isOperationConflict(error, params.operationId)) {
        throw new RpcFault(-32018, 'Message operation conflicts with an earlier request.', {
          kind: 'operation_conflict',
          operationId: params.operationId,
        });
      }
      if (isClientMessageConflict(error)) {
        throw new RpcFault(-32017, 'clientMessageId was already used with different message content.', {
          kind: 'client_message_conflict',
          clientMessageId: params.clientMessageId,
        } satisfies AgentCommandErrorData);
      }
      throw error;
    }
    if (replay) return {
      accepted: true as const,
      operationId: replay.operationId,
      turnId: replay.turnId,
    };

    const currentRuntime = this.resources.get<AgentRuntimeValue>(AGENT_RESOURCE_KEYS.runtime);
    if (
      this.conversationId === params.conversationId &&
      currentRuntime?.conversationId === params.conversationId &&
      (currentRuntime.state === 'running' || currentRuntime.state === 'interrupting')
    ) {
      const queued = await this.journal.enqueueTurn(params);
      this.resources.invalidateKey(queueResourceKey(params.conversationId), 'updated');
      return {
        accepted: true as const,
        delivery: 'queued' as const,
        operationId: queued.operationId,
        turnId: null,
      };
    }
    const runtimeValue = await this.ensureConversationRuntime(params.conversationId);
    if (!this.runtime) throw new RpcFault(-32012, 'The conversation runtime is unavailable.');
    let durable: Awaited<ReturnType<AgentConversationJournal['acceptTurn']>>;
    try {
      durable = await this.journal.acceptTurn(params);
    } catch (error) {
      if (isOperationConflict(error, params.operationId)) {
        throw new RpcFault(-32018, 'Message operation conflicts with an earlier request.', {
          kind: 'operation_conflict',
          operationId: params.operationId,
        });
      }
      if (isClientMessageConflict(error)) {
        throw new RpcFault(-32017, 'clientMessageId was already used with different message content.', {
          kind: 'client_message_conflict',
          clientMessageId: params.clientMessageId,
        } satisfies AgentCommandErrorData);
      }
      throw error;
    }
    if (durable.replayed) return {
      accepted: true as const,
      operationId: durable.operationId,
      turnId: durable.turnId,
    };
    this.resources.invalidateKey(conversationResourceKey(params.conversationId));
    this.resources.invalidateKey(AGENT_RESOURCE_KEYS.conversationList);

    const turnId = durable.turnId;
    this.activeDurableTurn = durable;
    this.activeDurableScope = durable;
    this.activeTurnStartedMonotonicAt = this.monotonicNow();
    this.turnWriteTail = Promise.resolve();
    this.turnWriteError = null;
    this.turnCompletion = null;
    this.durabilityFailure = null;
    this.inferenceAssistantText = '';
    this.inferenceAssistantReasoning = '';
    runtimeValue.state = 'running';
    runtimeValue.activeTurnId = turnId;
    runtimeValue.activeTurnElapsedMs = 0;
    runtimeValue.error = null;
    this.resources.set(AGENT_RESOURCE_KEYS.runtime, runtimeValue);
    try {
      this.projector?.beginTurn({
        turnId,
        clientMessageId: params.clientMessageId,
        text: params.text,
        ...(durable.userParts ? { parts: durable.userParts } : {}),
        sequence: durable.transcriptSequence,
        basisSequence: durable.basisSequence,
        createdAt: durable.transcriptCreatedAt,
        userItemId: durable.userItemId,
        ...(durable.userContent ? { content: durable.userContent } : {}),
      });
    } catch (error) {
      const message = safeMessage(error);
      await this.journal.finishTurn(durable, {
        status: 'failed',
        error: message,
        errorCode: 'runtime_error',
        durationMs: this.activeTurnDurationMs(),
      });
      this.resources.invalidateKey(conversationResourceKey(params.conversationId));
      this.resources.invalidateKey(AGENT_RESOURCE_KEYS.conversationList);
      this.activeDurableTurn = null;
      this.activeDurableScope = null;
      this.activeTurnStartedMonotonicAt = null;
      runtimeValue.state = 'error';
      runtimeValue.activeTurnId = null;
      runtimeValue.activeTurnElapsedMs = null;
      runtimeValue.error = message;
      this.resources.set(AGENT_RESOURCE_KEYS.runtime, runtimeValue);
      throw error;
    }

    const runtime = this.runtime;
    void Promise.resolve().then(() => runtime.prompt({
      text: params.text,
      images: agentPromptImages(params.parts ?? [{ text: params.text, type: 'text' }]),
    })).then(() => {
      return this.completeTurn(params.conversationId, false);
    }).catch((error) => {
      return this.completeTurn(params.conversationId, false, safeMessage(error));
    }).catch((error) => this.failDurability(params.conversationId, error));
    return { accepted: true as const, operationId: durable.operationId, turnId };
  }

  private async removeQueuedMessage(params: MessageQueueMutationParams) {
    const removed = await this.journal.removeQueuedTurn(params.conversationId, params.operationId);
    this.resources.invalidateKey(queueResourceKey(params.conversationId), 'updated');
    return { status: removed ? 'removed' as const : 'retained' as const };
  }

  private async runQueuedMessageNow(params: MessageQueueMutationParams) {
    const queued = await this.journal.readQueuedTurn(params.conversationId, params.operationId);
    if (!queued) return { status: 'retained' as const };
    this.nextQueuedOperationId = params.operationId;
    const runtime = this.resources.get<AgentRuntimeValue>(AGENT_RESOURCE_KEYS.runtime);
    if (
      runtime?.conversationId === params.conversationId &&
      runtime.activeTurnId &&
      (runtime.state === 'running' || runtime.state === 'interrupting')
    ) {
      if (runtime.state === 'running') this.interrupt({
        conversationId: params.conversationId,
        turnId: runtime.activeTurnId,
      });
      return { status: 'running' as const };
    }
    await this.dispatchNextQueuedMessage(params.conversationId);
    return { status: 'running' as const };
  }

  private async dispatchNextQueuedMessage(conversationId: string) {
    if (this.closePromise) return;
    const requested = this.nextQueuedOperationId;
    this.nextQueuedOperationId = null;
    const queued = await this.journal.readQueuedTurn(conversationId, requested ?? undefined)
      ?? (requested ? await this.journal.readQueuedTurn(conversationId) : null);
    if (!queued) return;
    try {
      const sent = await this.sendMessage(queued);
      if (sent.turnId) {
        await this.journal.finishQueuedTurn(queued.queueOperationId, sent.turnId);
        this.resources.invalidateKey(queueResourceKey(conversationId), 'updated');
      }
    } catch (error) {
      const runtime = this.resources.get<AgentRuntimeValue>(AGENT_RESOURCE_KEYS.runtime);
      if (runtime?.conversationId === conversationId) {
        runtime.error = `Queued message could not start: ${safeMessage(error)}`;
        this.resources.set(AGENT_RESOURCE_KEYS.runtime, runtime);
      }
    }
  }

  private async branchMessage(
    params: MessageBranchParams,
    mode: 'edit' | 'fork',
  ): Promise<MessageBranchResult> {
    const active = this.resources.get<AgentRuntimeValue>(AGENT_RESOURCE_KEYS.runtime);
    if (active?.state === 'running' || active?.state === 'interrupting') {
      throw new RpcFault(-32013, 'Wait for the active turn to finish before editing or forking.');
    }
    const source = await this.readConversationSummary(params.sourceConversationId);
    const projection = await this.journal.readTranscriptProjection(params.sourceConversationId);
    if (!projection) throw new RpcFault(-32015, 'Source conversation transcript was not found.');
    const prefix = branchPrefix(projection.actions, params, mode);
    const branch = await this.journal.createConversation({
      operationId: params.operationId,
      cwd: source.cwd,
      modelId: source.modelId,
      reasoning: source.reasoning,
      inheritThreadFrom: {
        conversationId: params.sourceConversationId,
        turnId: params.sourceTurnId,
        position: mode === 'edit' ? 'before' : 'after',
      },
    });
    await this.cloneTranscriptPrefix(branch.conversationId, prefix, params.operationId);
    this.resources.invalidateKey(AGENT_RESOURCE_KEYS.conversationList, 'created');
    this.resources.invalidateKey(conversationResourceKey(branch.conversationId), 'created');
    const sent = await this.sendMessage({
      operationId: derivedUuid(params.operationId, 'branch-message'),
      conversationId: branch.conversationId,
      clientMessageId: params.clientMessageId,
      text: params.text,
      ...(params.parts ? { parts: params.parts } : {}),
    });
    if (!sent.turnId) throw new Error('A branch message was unexpectedly queued.');
    return { conversationId: branch.conversationId, turnId: sent.turnId };
  }

  private async cloneTranscriptPrefix(
    conversationId: string,
    actions: readonly DurableTranscriptProjectionAction[],
    branchOperationId: string,
  ) {
    const turns = groupedTranscriptActions(actions);
    for (const turn of turns) {
      const user = turn.find((action) => action.type === 'turn');
      if (!user || user.type !== 'turn') continue;
      const parts = user.parts ? await this.hydrateBranchParts(user.parts) : undefined;
      const handle = await this.journal.acceptTurn({
        operationId: derivedUuid(branchOperationId, `clone-operation:${user.turnId}`),
        conversationId,
        clientMessageId: derivedUuid(branchOperationId, `clone-message:${user.turnId}`),
        text: user.text,
        ...(parts ? { parts } : {}),
      });
      const existing = (await this.journal.readTranscriptActions(conversationId))
        .filter((action) => action.turnId === handle.turnId);
      if (existing.some((action) => action.type === 'terminal')) continue;
      const assistant = turn.filter((action) => action.type === 'assistant');
      const sourceText = assistant.map((action) => action.type === 'assistant' ? action.textDelta : '').join('');
      const sourceReasoning = assistant.map((action) => action.type === 'assistant' ? action.reasoningDelta : '').join('');
      const existingAssistant = existing.filter((action) => action.type === 'assistant');
      const existingText = existingAssistant.map((action) => action.type === 'assistant' ? action.textDelta : '').join('');
      const existingReasoning = existingAssistant.map((action) => action.type === 'assistant' ? action.reasoningDelta : '').join('');
      if (!sourceText.startsWith(existingText) || !sourceReasoning.startsWith(existingReasoning)) {
        throw new Error(`Partially cloned turn ${user.turnId} does not match its source.`);
      }
      if (sourceText.length > existingText.length || sourceReasoning.length > existingReasoning.length) {
        await this.journal.appendAssistantCheckpoint(handle, {
          textDelta: sourceText.slice(existingText.length),
          reasoningDelta: sourceReasoning.slice(existingReasoning.length),
        });
      }
      const existingCalls = new Set(existing.flatMap((action) =>
        action.type === 'tool-start' ? [action.callId] : []));
      for (const start of turn.filter((action) => action.type === 'tool-start')) {
        if (start.type !== 'tool-start' || existingCalls.has(start.callId)) continue;
        await this.journal.recordToolStarted(handle, {
          callId: start.callId,
          name: start.name,
          args: start.args,
        });
        const end = turn.find((action) => action.type === 'tool-end' && action.callId === start.callId);
        if (end?.type === 'tool-end') {
          await this.journal.recordToolFinished(handle, {
            callId: end.callId,
            result: end.result,
            isError: end.isError,
          });
        }
      }
      const terminal = turn.find((action) => action.type === 'terminal');
      if (!terminal || terminal.type !== 'terminal') {
        throw new Error(`Source turn ${user.turnId} has no terminal boundary.`);
      }
      await this.journal.finishTurn(handle, {
        status: terminal.status === 'interrupted_by_restart' ? 'interrupted' : terminal.status,
        error: terminal.error,
        errorCode: terminal.errorCode,
        durationMs: terminal.durationMs,
      });
    }
  }

  private async hydrateBranchParts(parts: NonNullable<DurableTranscriptAction & { type: 'turn' }>['parts']) {
    const hydrated = [];
    for (const part of parts ?? []) {
      if (part.type !== 'image') {
        hydrated.push(part);
        continue;
      }
      const artifact = await this.journal.readArtifact(part.artifactHash);
      if (!artifact) throw new Error(`Branch image artifact ${part.artifactHash} is missing.`);
      hydrated.push({
        dataUrl: `data:${part.mimeType};base64,${artifact.bytes.toString('base64')}`,
        mimeType: part.mimeType,
        name: part.name,
        type: 'image' as const,
      });
    }
    return hydrated;
  }

  private async ensureConversationRuntime(conversationId: string) {
    const current = this.resources.get<AgentRuntimeValue>(AGENT_RESOURCE_KEYS.runtime);
    if (
      this.conversationId === conversationId &&
      this.runtime &&
      this.projector &&
      current?.conversationId === conversationId
    ) {
      if (current.state === 'running' || current.state === 'interrupting') {
        throw turnActiveFault(current);
      }
      if (current.state === 'error') {
        const summary = await this.readConversationSummary(conversationId);
        await this.disposeConversation();
        return this.loadConversationRuntime(summary, null);
      }
      return current;
    }
    this.assertRuntimeSwitchAvailable(conversationId);
    const summary = await this.readConversationSummary(conversationId);
    return this.loadConversationRuntime(summary, null);
  }

  private async readConversationSummary(conversationId: string) {
    const [projection] = await this.journal.readResourceProjections([
      conversationResourceKey(conversationId),
    ]);
    if (!projection || projection.key === AGENT_RESOURCE_KEYS.conversationList) {
      throw new RpcFault(-32015, 'Conversation not found.');
    }
    return projection.value as ConversationSummary;
  }

  private assertRuntimeSwitchAvailable(targetConversationId: string) {
    const current = this.resources.get<AgentRuntimeValue>(AGENT_RESOURCE_KEYS.runtime);
    if (current?.state !== 'running' && current?.state !== 'interrupting') return;
    if (current.conversationId === targetConversationId) throw turnActiveFault(current);
    throw activeRuntimeBusyFault(current);
  }

  private async loadConversationRuntime(
    conversation: Pick<ConversationSummary, 'id' | 'cwd' | 'modelId' | 'reasoning'>,
    operationId: string | null,
  ) {
    const current = this.resources.get<AgentRuntimeValue>(AGENT_RESOURCE_KEYS.runtime);
    if (
      this.conversationId === conversation.id &&
      this.runtime &&
      this.projector &&
      current?.conversationId === conversation.id
    ) return current;

    this.assertRuntimeSwitchAvailable(conversation.id);
    const auth = this.resources.get<AuthValue>(AGENT_RESOURCE_KEYS.auth);
    if (auth?.state !== 'signed-in') throw new RpcFault(-32011, 'Sign in before continuing a conversation.');
    const models = this.resources.get<ModelsValue>(AGENT_RESOURCE_KEYS.models);
    const model = models?.models.find(({ id }) => id === conversation.modelId);
    if (!model || !model.supportedReasoning.includes(conversation.reasoning)) {
      const data: AgentCommandErrorData = {
        kind: 'model_unavailable',
        conversationId: conversation.id,
        modelId: conversation.modelId,
      };
      throw new RpcFault(-32020, 'The conversation model is no longer available.', data);
    }
    let cwd: string;
    try {
      cwd = await canonicalDirectory(conversation.cwd);
      if (cwd !== conversation.cwd) throw new Error('The canonical workspace identity changed.');
    } catch {
      const data: AgentCommandErrorData = {
        kind: 'workspace_unavailable',
        conversationId: conversation.id,
        cwd: conversation.cwd,
      };
      throw new RpcFault(-32021, 'The conversation workspace is no longer available.', data);
    }

    await this.disposeConversation();
    const loading = runtimeValue(conversation.id, conversation.modelId, 'loading');
    this.resources.set(AGENT_RESOURCE_KEYS.runtime, loading);
    try {
      const transcript = await this.journal.readTranscriptProjection(conversation.id);
      if (!transcript) throw new Error(`Conversation ${conversation.id} does not exist.`);
      const projector = createReplayedTranscriptProjector({
        conversationId: conversation.id,
        actions: transcript.actions,
        basisSequence: transcript.basisSequence,
        live: true,
        invalidate: (invalidations) => this.publishProjectorInvalidations(invalidations),
      });
      const runtime = await this.engine.createConversation({
        cwd,
        modelId: conversation.modelId,
        reasoning: conversation.reasoning,
        onEvent: (event) => this.applyRuntimeEvent(conversation.id, event),
        durability: {
          compileContext: (contextWindow) => this.compileContext(conversation.id, contextWindow),
          noticeContextPressure: (input) => this.noticeContextPressure(conversation.id, input),
          beforeAssistantMessageEnd: (input) => this.beforeAssistantMessageEnd(conversation.id, input),
          beforeProviderCall: (input) => this.beforeProviderCall(conversation.id, input),
          afterProviderCall: (input) => this.afterProviderCall(conversation.id, input),
          beforeTool: (input) => this.beforeTool(conversation.id, input),
          afterTool: (input) => this.afterTool(conversation.id, input),
          journalSearch: (input) => {
            if (!this.journal.searchJournal) throw new Error('Durable journal search is unavailable.');
            return this.journal.searchJournal(conversation.id, input);
          },
          journalOpen: (input) => {
            if (!this.journal.openJournal) throw new Error('Durable journal open is unavailable.');
            return this.journal.openJournal(conversation.id, input);
          },
          threadRead: () => {
            if (!this.journal.readThread) throw new Error('Durable thread state is unavailable.');
            return this.journal.readThread(conversation.id);
          },
          threadPatch: (input) => {
            if (!this.journal.patchThread) throw new Error('Durable thread patches are unavailable.');
            return this.journal.patchThread(this.requiredActiveDurableScope(conversation.id), input);
          },
          threadReplace: (input) => {
            if (!this.journal.replaceThread) throw new Error('Durable thread replacement is unavailable.');
            return this.journal.replaceThread(this.requiredActiveDurableScope(conversation.id), input);
          },
          workUnitEnter: (callId, input) => this.enterWorkUnit(conversation.id, callId, input),
          workUnitReturn: (callId, input) =>
            this.requestWorkUnitReturn(conversation.id, callId, input),
        },
      });
      this.runtime = runtime;
      this.projector = projector;
      this.conversationId = conversation.id;
      this.conversationOperationId = operationId;
      const resumed = await this.journal.resumeActiveTurn?.(conversation.id) ?? null;
      if (resumed) {
        this.activeDurableTurn = resumed.rootHandle;
        this.activeDurableScope = resumed.handle;
        this.activeTurnStartedMonotonicAt = this.monotonicNow();
        this.turnWriteTail = Promise.resolve();
        this.turnWriteError = null;
        this.turnCompletion = null;
        this.durabilityFailure = null;
      }
      const loaded = resumed ? {
        ...loading,
        state: 'running' as const,
        activeTurnId: resumed.handle.turnId,
        activeTurnElapsedMs: 0,
      } : { ...loading, state: 'idle' as const };
      this.resources.set(AGENT_RESOURCE_KEYS.runtime, loaded);
      if (resumed) {
        void runtime.prompt({ text: resumed.prompt })
          .catch((error) => this.completeTurn(conversation.id, false, safeMessage(error)))
          .catch((error) => this.failDurability(conversation.id, error));
      }
      return loaded;
    } catch (error) {
      this.runtime = null;
      this.projector = null;
      this.conversationId = null;
      this.conversationOperationId = null;
      const message = `Unable to load conversation runtime: ${safeMessage(error)}`;
      this.resources.set(AGENT_RESOURCE_KEYS.runtime, {
        ...loading,
        state: 'error',
        error: message,
      });
      const data: AgentCommandErrorData = {
        kind: 'runtime_hydration_failed',
        conversationId: conversation.id,
      };
      throw new RpcFault(-32022, message, data);
    }
  }

  private interrupt(params: TurnInterruptParams) {
    const runtimeValue = this.requiredConversation(params.conversationId);
    if (runtimeValue.activeTurnId !== params.turnId || runtimeValue.state === 'idle') {
      throw new RpcFault(-32014, 'The requested turn is no longer active.');
    }
    if (runtimeValue.state === 'interrupting') {
      return { accepted: true as const };
    }
    runtimeValue.state = 'interrupting';
    this.resources.set(AGENT_RESOURCE_KEYS.runtime, runtimeValue);
    const runtime = this.runtime;
    if (runtime) {
      void runtime.interrupt()
        .catch((error) => this.completeTurn(params.conversationId, true, safeMessage(error)))
        .catch((error) => this.failDurability(params.conversationId, error));
    }
    return { accepted: true as const };
  }

  private applyRuntimeEvent(conversationId: string, event: RuntimeEvent) {
    const runtimeValue = this.resources.get<AgentRuntimeValue>(AGENT_RESOURCE_KEYS.runtime);
    if (!runtimeValue || runtimeValue.conversationId !== conversationId) return;
    const turnId = runtimeValue.activeTurnId;
    let runtimeChanged = false;
    switch (event.type) {
      case 'assistant-start':
        if (turnId && this.activeDurableScope && this.isRootScope(this.activeDurableScope)) {
          this.projector?.assistantStarted(turnId);
        }
        break;
      case 'assistant-text':
        if (turnId) this.bufferAssistantCheckpoint(event.delta, '');
        break;
      case 'assistant-reasoning':
        if (turnId) this.bufferAssistantCheckpoint('', event.delta);
        break;
      case 'inference-end':
        void this.finishInferenceBoundary(conversationId, event.state)
          .catch((error) => this.failDurability(conversationId, error));
        break;
      case 'assistant-complete':
        void this.completeTurn(
          conversationId,
          event.interrupted,
          event.error ?? (
            this.activeDurableScope && !this.isRootScope(this.activeDurableScope)
              ? 'A work unit ended without calling work_unit_finish.'
              : undefined
          ),
        )
          .catch((error) => this.failDurability(conversationId, error));
        return;
      case 'tool-start':
        if (turnId) void this.beforeTool(conversationId, event)
          .catch((error) => this.failDurability(conversationId, error));
        break;
      case 'tool-update': {
        // Partial tool output is presentation-only. The authoritative result is
        // published after the tool wrapper commits its terminal boundary.
        break;
      }
      case 'tool-end': {
        if (turnId) void this.afterTool(conversationId, event)
          .catch((error) => this.failDurability(conversationId, error));
        break;
      }
      case 'context-probe':
        runtimeValue.contextProbe = event.probe;
        runtimeChanged = true;
        break;
    }
    if (runtimeChanged) {
      this.resources.set(AGENT_RESOURCE_KEYS.runtime, runtimeValue);
    }
  }

  private async beforeProviderCall(
    conversationId: string,
    input: {
      payload: unknown;
      requestMode: 'full' | 'continuation';
      estimatedInputTokens: number;
      context: DurableInferenceContext;
    },
  ) {
    const handle = this.requiredActiveDurableScope(conversationId);
    const runtime = this.resources.get<AgentRuntimeValue>(AGENT_RESOURCE_KEYS.runtime);
    const modelId = runtime?.contextProbe?.modelId;
    if (!modelId) throw new Error('Provider dispatch has no durable model identity.');
    await this.enqueueTurnWrite(() => this.journal.startInference(handle, {
      modelId,
      requestMode: input.requestMode,
      estimatedInputTokens: input.estimatedInputTokens,
      payload: input.payload,
      context: input.context,
    }));
    this.resources.invalidateKey(contextResourceKey(conversationId), 'updated');
    this.inferenceAssistantText = '';
    this.inferenceAssistantReasoning = '';
  }

  private async compileContext(conversationId: string, contextWindow: number) {
    this.requiredActiveDurableScope(conversationId);
    await this.flushAssistantCheckpoint();
    await this.turnWriteTail;
    if (this.turnWriteError) throw this.turnWriteError;
    return this.journal.compileContext(conversationId, contextWindow);
  }

  private async noticeContextPressure(
    conversationId: string,
    input: {
      estimatedInputTokens: number;
      softContextLimit: number;
      hardContextLimit: number;
    },
  ) {
    if (!this.journal.recordContextPressure) {
      throw new Error('Durable context pressure notices are unavailable.');
    }
    const handle = this.requiredActiveDurableScope(conversationId);
    const recorded = await this.enqueueTurnWrite(() =>
      this.journal.recordContextPressure!(handle, input));
    if (recorded) this.resources.invalidateKey(contextResourceKey(conversationId), 'updated');
    return recorded;
  }

  private async afterProviderCall(
    conversationId: string,
    input: {
      plannedRequestMode: 'full' | 'continuation';
      actualRequestMode: 'full' | 'continuation';
    },
  ) {
    const handle = this.requiredActiveDurableScope(conversationId);
    if (!this.journal.recordInferenceTransport) return;
    const recorded = await this.enqueueTurnWrite(() =>
      this.journal.recordInferenceTransport!(handle, input));
    if (recorded) this.resources.invalidateKey(contextResourceKey(conversationId), 'updated');
  }

  private async finishInferenceBoundary(
    conversationId: string,
    state: 'completed' | 'failed' | 'interrupted',
  ) {
    const handle = this.activeDurableScope;
    if (!handle || handle.conversationId !== conversationId) return;
    await this.flushAssistantCheckpoint();
    await this.enqueueTurnWrite(() => this.journal.finishInference(handle, { state }));
  }

  private async beforeAssistantMessageEnd(
    conversationId: string,
    input: {
      inferenceState: 'completed' | 'failed' | 'interrupted';
      text: string;
      reasoning: string;
      calls: Array<{ callId: string; name: string; args: unknown }>;
      providerMessage: AssistantMessage;
    },
  ) {
    const handle = this.requiredActiveDurableScope(conversationId);
    await this.flushAssistantCheckpoint();
    if (!this.journal.recordProviderItem) {
      throw new Error('Exact provider item durability is unavailable.');
    }
    await this.enqueueTurnWrite(() => this.journal.recordProviderItem!(handle, input.providerMessage));
    const textDelta = finalizedSuffix(
      this.inferenceAssistantText,
      input.text,
      'assistant text',
    );
    const reasoningDelta = finalizedSuffix(
      this.inferenceAssistantReasoning,
      input.reasoning,
      'assistant reasoning',
    );
    if (textDelta || reasoningDelta) {
      await this.enqueueTurnWrite(async () => {
        const mutation = await this.journal.appendAssistantCheckpoint(
          handle,
          { textDelta, reasoningDelta },
        );
        if (!mutation) return;
        if (this.isRootScope(handle)) {
          this.resources.invalidateKey(conversationResourceKey(handle.conversationId));
          this.resources.invalidateKey(AGENT_RESOURCE_KEYS.conversationList);
          const projection = transcriptMutation(mutation);
          if (reasoningDelta) this.projector?.appendReasoning(handle.turnId, reasoningDelta, projection);
          if (textDelta) this.projector?.appendAssistantText(handle.turnId, textDelta, projection);
        }
      });
    }
    this.inferenceAssistantText = input.text;
    this.inferenceAssistantReasoning = input.reasoning;
    await this.enqueueTurnWrite(() => this.journal.finishInference(handle, {
      state: input.inferenceState,
    }));
    for (const call of input.calls) {
      this.toolScopes.set(call.callId, handle);
      const inserted = await this.enqueueTurnWrite(() => this.journal.recordToolStarted(handle, call));
      if (inserted && this.isRootScope(handle)) {
        this.projector?.startTool(handle.turnId, {
          callId: call.callId,
          name: call.name,
          args: call.args,
          ...(inserted.detailText === undefined ? {} : { detailText: inserted.detailText }),
          ...(inserted.detailContent ? { detailContent: inserted.detailContent } : {}),
          ...transcriptMutation(inserted),
        });
      }
    }
  }

  private async beforeTool(
    conversationId: string,
    input: { callId: string; name: string; args: unknown },
  ) {
    const handle = this.toolScopes.get(input.callId) ?? this.requiredActiveDurableScope(conversationId);
    this.toolScopes.set(input.callId, handle);
    await this.flushAssistantCheckpoint();
    const inserted = await this.enqueueTurnWrite(() => this.journal.recordToolStarted(handle, input));
    if (inserted && this.isRootScope(handle)) {
      this.projector?.startTool(handle.turnId, {
        callId: input.callId,
        name: input.name,
        args: input.args,
        ...(inserted.detailText === undefined ? {} : { detailText: inserted.detailText }),
        ...(inserted.detailContent ? { detailContent: inserted.detailContent } : {}),
        ...transcriptMutation(inserted),
      });
    }
  }

  private async afterTool(
    conversationId: string,
    input: { callId: string; name: string; result: unknown; isError: boolean },
  ) {
    const handle = this.toolScopes.get(input.callId) ?? this.requiredActiveDurableScope(conversationId);
    await this.flushAssistantCheckpoint();
    const inserted = await this.enqueueTurnWrite(() => this.journal.recordToolFinished(handle, input));
    if (inserted && this.isRootScope(handle)) {
      this.projector?.endTool(handle.turnId, {
        callId: input.callId,
        result: input.result,
        isError: input.isError,
        ...(inserted.outputText === undefined ? {} : { outputText: inserted.outputText }),
        ...(inserted.outputContent ? { outputContent: inserted.outputContent } : {}),
        ...transcriptMutation(inserted),
      });
    }
    const pendingReturn = this.pendingWorkUnitReturns.get(input.callId);
    if (input.name === 'work_unit_finish' && !input.isError) {
      if (!pendingReturn || pendingReturn.handle.scopeId !== handle.scopeId) {
        throw new Error('The work unit return boundary was not prepared.');
      }
      if (!this.journal.commitWorkUnitReturn) {
        throw new Error('Durable work unit return commit is unavailable.');
      }
      const returned = await this.enqueueTurnWrite(() =>
        this.journal.commitWorkUnitReturn!(handle, pendingReturn.prepared));
      this.activeDurableScope = returned.parentHandle;
    }
    this.pendingWorkUnitReturns.delete(input.callId);
    this.toolScopes.delete(input.callId);
  }

  private async enterWorkUnit(
    conversationId: string,
    callId: string,
    input: WorkUnitEnterInput,
  ) {
    const parent = this.requiredActiveDurableScope(conversationId);
    if (!this.isRootScope(parent)) throw new Error('Work units cannot be nested.');
    if (!this.journal.enterWorkUnit) throw new Error('Durable work unit entry is unavailable.');
    await this.flushAssistantCheckpoint();
    const entered = await this.enqueueTurnWrite(() => this.journal.enterWorkUnit!(parent, input));
    this.toolScopes.set(callId, parent);
    this.activeDurableScope = entered.handle;
    return {
      scopeId: entered.handle.scopeId,
      parentScopeId: entered.parentScopeId,
      objective: entered.objective,
      doneWhen: entered.doneWhen,
      resources: entered.resources,
      state: 'running' as const,
    };
  }

  private async requestWorkUnitReturn(
    conversationId: string,
    callId: string,
    input: WorkUnitReturnInput,
  ) {
    const handle = this.requiredActiveDurableScope(conversationId);
    if (this.isRootScope(handle)) throw new Error('No work unit is active.');
    // Prepare and materialize the complete handoff before the tool reports
    // success. The durable scope transition intentionally waits for
    // tool_result, but correctable model input or resource errors must remain
    // tool errors so the child can fix them and retry.
    normalizeWorkUnitReturnInput(input);
    if (!this.journal.prepareWorkUnitReturn) {
      throw new Error('Durable work unit return preparation is unavailable.');
    }
    const prepared = await this.journal.prepareWorkUnitReturn(handle, input);
    this.toolScopes.set(callId, handle);
    this.pendingWorkUnitReturns.set(callId, { handle, prepared });
    return { scopeId: handle.scopeId, state: 'returning' as const };
  }

  private bufferAssistantCheckpoint(textDelta: string, reasoningDelta: string) {
    this.inferenceAssistantText += textDelta;
    this.inferenceAssistantReasoning += reasoningDelta;
    this.pendingAssistantText += textDelta;
    this.pendingAssistantReasoning += reasoningDelta;
    const pendingBytes = Buffer.byteLength(this.pendingAssistantText, 'utf8') +
      Buffer.byteLength(this.pendingAssistantReasoning, 'utf8');
    if (pendingBytes >= 8 * 1024) {
      void this.flushAssistantCheckpoint().catch((error) => {
        if (this.conversationId) this.failDurability(this.conversationId, error);
      });
      return;
    }
    if (!this.assistantFlushTimer) {
      this.assistantFlushTimer = setTimeout(() => {
        this.assistantFlushTimer = null;
        void this.flushAssistantCheckpoint().catch((error) => {
          if (this.conversationId) this.failDurability(this.conversationId, error);
        });
      }, 50);
    }
  }

  private flushAssistantCheckpoint() {
    if (this.assistantFlushTimer) clearTimeout(this.assistantFlushTimer);
    this.assistantFlushTimer = null;
    const textDelta = this.pendingAssistantText;
    const reasoningDelta = this.pendingAssistantReasoning;
    this.pendingAssistantText = '';
    this.pendingAssistantReasoning = '';
    const handle = this.activeDurableScope;
    if (!handle || (!textDelta && !reasoningDelta)) return this.turnWriteTail;
    return this.enqueueTurnWrite(async () => {
      const mutation = await this.journal.appendAssistantCheckpoint(
        handle,
        { textDelta, reasoningDelta },
      );
      if (!mutation) return;
      if (this.isRootScope(handle)) {
        this.resources.invalidateKey(conversationResourceKey(handle.conversationId));
        this.resources.invalidateKey(AGENT_RESOURCE_KEYS.conversationList);
        const projection = transcriptMutation(mutation);
        if (reasoningDelta) this.projector?.appendReasoning(handle.turnId, reasoningDelta, projection);
        if (textDelta) this.projector?.appendAssistantText(handle.turnId, textDelta, projection);
      }
    });
  }

  private enqueueTurnWrite<T>(work: () => Promise<T>): Promise<T> {
    const next = this.turnWriteTail.then(() => {
      if (this.turnWriteError) throw this.turnWriteError;
      return work();
    });
    this.turnWriteTail = next.then(
      () => undefined,
      (error) => {
        this.turnWriteError ??= error;
      },
    );
    return next;
  }

  private requiredActiveDurableTurn(conversationId: string) {
    const handle = this.activeDurableTurn;
    if (!handle || handle.conversationId !== conversationId) {
      throw new Error('No durable turn is active for this runtime effect.');
    }
    return handle;
  }

  private requiredActiveDurableScope(conversationId: string) {
    const handle = this.activeDurableScope;
    if (!handle || handle.conversationId !== conversationId) {
      throw new Error('No durable execution scope is active for this runtime effect.');
    }
    return handle;
  }

  private isRootScope(handle: DurableTurnHandle) {
    return this.activeDurableTurn?.scopeId === handle.scopeId;
  }

  private failDurability(conversationId: string, error: unknown) {
    this.durabilityFailure ??= this.failDurabilityOnce(conversationId, error);
  }

  private async failDurabilityOnce(conversationId: string, error: unknown) {
    const message = `Durable journal failure: ${safeMessage(error)}`;
    const runtimeValue = this.resources.get<AgentRuntimeValue>(AGENT_RESOURCE_KEYS.runtime);
    if (runtimeValue?.conversationId === conversationId) {
      runtimeValue.state = 'error';
      runtimeValue.error = message;
      this.resources.set(AGENT_RESOURCE_KEYS.runtime, runtimeValue);
    }
    await this.runtime?.interrupt().catch(() => undefined);
    const handle = this.activeDurableTurn;
    if (!handle || handle.conversationId !== conversationId) return;
    const durationMs = this.activeTurnDurationMs();
    let mutation: DurableTranscriptMutation | null;
    try {
      mutation = await this.journal.finishTurn(handle, {
        status: 'failed',
        error: message,
        errorCode: 'storage_error',
        durationMs,
      });
      this.turnWriteError = null;
      this.turnWriteTail = Promise.resolve();
      this.resources.invalidateKey(conversationResourceKey(conversationId));
      this.resources.invalidateKey(AGENT_RESOURCE_KEYS.conversationList);
    } catch {
      // The journal remains the authority. Startup recovery will terminate the
      // still-running row if storage cannot accept the failure transition now.
      return;
    }
    if (runtimeValue?.activeTurnId === handle.turnId) {
      runtimeValue.activeTurnId = null;
      runtimeValue.activeTurnElapsedMs = null;
      this.resources.set(AGENT_RESOURCE_KEYS.runtime, runtimeValue);
    }
    this.projector?.finishTurn(handle.turnId, {
      status: 'failed',
      error: { code: 'storage_error', message },
      durationMs,
      ...(mutation ? transcriptTerminalMutation(mutation) : {}),
    });
    this.activeDurableTurn = null;
    this.activeDurableScope = null;
    this.toolScopes.clear();
    this.pendingWorkUnitReturns.clear();
    this.activeTurnStartedMonotonicAt = null;
    if (!this.closePromise) {
      void this.enqueueConversationCommand(() => this.dispatchNextQueuedMessage(conversationId));
    }
  }

  private completeTurn(conversationId: string, interrupted: boolean, error?: string) {
    this.turnCompletion ??= this.completeTurnOnce(conversationId, interrupted, error);
    return this.turnCompletion;
  }

  private async completeTurnOnce(conversationId: string, interrupted: boolean, error?: string) {
    const runtimeValue = this.resources.get<AgentRuntimeValue>(AGENT_RESOURCE_KEYS.runtime);
    const handle = this.activeDurableTurn;
    if (
      !runtimeValue ||
      runtimeValue.conversationId !== conversationId ||
      !runtimeValue.activeTurnId ||
      !handle
    ) return;
    const turnId = runtimeValue.activeTurnId;
    await this.flushAssistantCheckpoint();
    await this.turnWriteTail;
    if (this.turnWriteError) throw this.turnWriteError;
    const status = error ? 'failed' : interrupted ? 'interrupted' : 'completed';
    const durationMs = this.activeTurnDurationMs();
    const mutation = await this.journal.finishTurn(handle, {
      status,
      error: error ?? null,
      errorCode: error ? 'provider_error' : null,
      durationMs,
    });
    this.resources.invalidateKey(conversationResourceKey(conversationId));
    this.resources.invalidateKey(AGENT_RESOURCE_KEYS.conversationList);
    runtimeValue.state = error ? 'error' : 'idle';
    runtimeValue.activeTurnId = null;
    runtimeValue.activeTurnElapsedMs = null;
    runtimeValue.error = error ?? null;
    this.resources.set(AGENT_RESOURCE_KEYS.runtime, runtimeValue);
    this.projector?.finishTurn(turnId, {
      status,
      error: error ? { code: 'provider_error', message: error } : null,
      durationMs,
      ...(mutation ? transcriptTerminalMutation(mutation) : {}),
    });
    this.activeDurableTurn = null;
    this.activeDurableScope = null;
    this.toolScopes.clear();
    this.pendingWorkUnitReturns.clear();
    this.activeTurnStartedMonotonicAt = null;
    if (!this.closePromise) {
      void this.enqueueConversationCommand(() => this.dispatchNextQueuedMessage(conversationId));
    }
  }

  private requiredConversation(id: string) {
    if (this.conversationId !== id) throw new RpcFault(-32015, 'Conversation not found.');
    const runtimeValue = this.resources.get<AgentRuntimeValue>(AGENT_RESOURCE_KEYS.runtime);
    if (runtimeValue?.conversationId !== id) throw new RpcFault(-32015, 'Conversation not found.');
    return runtimeValue;
  }

  private async disposeConversation() {
    const previous = this.runtime;
    if (previous && this.activeDurableTurn && this.conversationId) {
      await previous.interrupt().catch(() => undefined);
      await this.completeTurn(this.conversationId, true).catch((error) => {
        this.failDurability(this.conversationId!, error);
      });
      await this.durabilityFailure;
    }
    if (this.assistantFlushTimer) clearTimeout(this.assistantFlushTimer);
    this.assistantFlushTimer = null;
    await this.turnWriteTail;
    this.runtime = null;
    this.projector = null;
    if (previous) await previous.dispose();
    if (this.conversationId) {
      this.conversationId = null;
    }
    this.resources.set(AGENT_RESOURCE_KEYS.runtime, unloadedRuntime());
    this.conversationOperationId = null;
    this.activeDurableTurn = null;
    this.activeDurableScope = null;
    this.toolScopes.clear();
    this.pendingWorkUnitReturns.clear();
    this.activeTurnStartedMonotonicAt = null;
    this.turnCompletion = null;
    this.durabilityFailure = null;
  }

  private async closeOnce() {
    this.loginController?.abort(new DOMException('Agent server closed', 'AbortError'));
    this.loginController = null;
    await this.conversationCommandTail;
    await this.disposeConversation();
    this.transcriptRouter.clear();
  }

  private activeTurnDurationMs() {
    return this.activeTurnStartedMonotonicAt === null
      ? 0
      : Math.round(Math.max(0, this.monotonicNow() - this.activeTurnStartedMonotonicAt));
  }

  private enqueueConversationCommand<T>(work: () => T | Promise<T>) {
    const next = this.conversationCommandTail.then(work, work);
    this.conversationCommandTail = next.then(() => undefined, () => undefined);
    return next;
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
      ? await this.journal.readResourceProjections(durableRequests.map(({ key }) => key))
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
            if (key === AGENT_RESOURCE_KEYS.runtime && this.projector) {
              return {
                ...value as AgentRuntimeValue,
                activeTurnElapsedMs: this.projector.activeElapsedMs(),
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
      await this.turnWriteTail;
      if (this.turnWriteError) throw this.turnWriteError;
      return await this.transcriptRouter.read({
        params: parsed,
        serverGeneration: this.resources.serverGeneration,
        liveProjector: this.projector,
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

function finalizedSuffix(observed: string, finalized: string, label: string) {
  if (!finalized.startsWith(observed)) {
    // Pi streams formatting whitespace around reasoning summaries that the
    // finalized provider message may omit. The exact provider item is already
    // durable and authoritative for replay; an invisible provisional suffix
    // must not turn a successful inference into a provider failure.
    if (observed.startsWith(finalized) && observed.slice(finalized.length).trim() === '') {
      return '';
    }
    throw new Error(`Pi finalized ${label} by rewriting already journaled content.`);
  }
  return finalized.slice(observed.length);
}

function transcriptMutation(mutation: DurableTranscriptMutation) {
  return {
    sequence: mutation.basisSequence,
    basisSequence: mutation.basisSequence,
    createdAt: mutation.createdAt,
    itemId: mutation.itemId,
  };
}

function transcriptTerminalMutation(mutation: DurableTranscriptMutation) {
  return {
    sequence: mutation.basisSequence,
    basisSequence: mutation.basisSequence,
    createdAt: mutation.createdAt,
  };
}

function parseResourceRead(params: unknown): ResourceReadParams {
  const value = objectValue(params);
  if (!Array.isArray(value.requests)) throw new RpcFault(-32602, 'requests must be an array.');
  if (value.requests.length > MAX_RESOURCE_READ_REQUESTS) {
    throw new RpcFault(-32602, `requests exceeds the ${MAX_RESOURCE_READ_REQUESTS} item limit.`);
  }
  const seen = new Set<string>();
  return {
    requests: value.requests.map((request) => {
      const item = objectValue(request);
      if (typeof item.key !== 'string' || !isResourceKey(item.key)) {
        throw new RpcFault(-32602, 'Unknown resource key.');
      }
      if (seen.has(item.key)) {
        throw new RpcFault(-32602, 'requests contains a duplicate resource key.');
      }
      seen.add(item.key);
      if (item.ifNoneMatch !== undefined && (!Number.isInteger(item.ifNoneMatch) || Number(item.ifNoneMatch) < 0)) {
        throw new RpcFault(-32602, 'ifNoneMatch must be a non-negative integer.');
      }
      return {
        key: item.key,
        ...(item.ifNoneMatch === undefined ? {} : { ifNoneMatch: Number(item.ifNoneMatch) }),
      };
    }),
  };
}

function parseConversationCreate(params: unknown): ConversationCreateParams {
  const value = objectValue(params);
  return {
    operationId: requiredUuidV4(value.operationId, 'operationId'),
    cwd: requiredString(value.cwd, 'cwd'),
    modelId: requiredString(value.modelId, 'modelId'),
    reasoning: reasoningLevel(value.reasoning),
  };
}

function parseArtifactRead(params: unknown): ArtifactReadParams {
  const value = objectValue(params);
  const hash = requiredString(value.hash, 'hash');
  if (!SHA256.test(hash)) throw new RpcFault(-32602, 'hash must be a lowercase SHA-256 digest.');
  const range = objectValue(value.range);
  if (range.kind === 'bytes') {
    return {
      hash,
      range: {
        kind: 'bytes',
        offset: boundedInteger(range.offset, 'range.offset', 0, Number.MAX_SAFE_INTEGER),
        byteLength: boundedInteger(
          range.byteLength,
          'range.byteLength',
          1,
          MAX_ARTIFACT_READ_BYTES,
        ),
      },
    };
  }
  if (range.kind === 'utf8') {
    return {
      hash,
      range: {
        kind: 'utf8',
        offset: boundedInteger(range.offset, 'range.offset', 0, Number.MAX_SAFE_INTEGER),
        byteLength: boundedInteger(
          range.byteLength,
          'range.byteLength',
          1,
          MAX_ARTIFACT_READ_BYTES,
        ),
      },
    };
  }
  if (range.kind === 'lines') {
    return {
      hash,
      range: {
        kind: 'lines',
        startLine: boundedInteger(range.startLine, 'range.startLine', 1, Number.MAX_SAFE_INTEGER),
        lineCount: boundedInteger(range.lineCount, 'range.lineCount', 1, MAX_ARTIFACT_READ_LINES),
      },
    };
  }
  throw new RpcFault(-32602, 'range.kind must be bytes, utf8, or lines.');
}

function parseThreadRead(params: unknown): ThreadReadParams {
  const value = objectValue(params);
  return { conversationId: requiredUuidV4(value.conversationId, 'conversationId') };
}

function parseTurnRead(params: unknown): TurnReadParams {
  const value = objectValue(params);
  return {
    conversationId: requiredUuidV4(value.conversationId, 'conversationId'),
    turnId: requiredUuidV4(value.turnId, 'turnId'),
  };
}

function parseFileSearch(params: unknown): AgentFileSearchParams {
  const value = objectValue(params);
  return {
    cwd: requiredString(value.cwd, 'cwd'),
    limit: value.limit === undefined ? 80 : boundedInteger(value.limit, 'limit', 1, 80),
    query: requiredString(value.query, 'query'),
  };
}

function isUtf8ContinuationByte(value: number) {
  return (value & 0xc0) === 0x80;
}

function boundedInteger(value: unknown, name: string, minimum: number, maximum: number) {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new RpcFault(-32602, `${name} must be an integer from ${minimum} through ${maximum}.`);
  }
  return Number(value);
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function requiredUuidV4(value: unknown, name: string) {
  const id = requiredString(value, name);
  if (!UUID_V4.test(id)) throw new RpcFault(-32602, `${name} must be a lowercase UUID v4.`);
  return id;
}

function isOperationConflict(error: unknown, operationId: string) {
  return error instanceof Error &&
    error.name === 'OperationConflictError' &&
    'operationId' in error &&
    error.operationId === operationId;
}

function isClientMessageConflict(error: unknown) {
  return error instanceof Error && error.name === 'ClientMessageConflictError';
}

function parseMessageSend(params: unknown): MessageSendParams {
  const value = objectValue(params);
  if (value.parts === undefined) {
    return {
      operationId: requiredUuidV4(value.operationId, 'operationId'),
      conversationId: requiredUuidV4(value.conversationId, 'conversationId'),
      clientMessageId: requiredUuidV4(value.clientMessageId, 'clientMessageId'),
      text: requiredString(value.text, 'text'),
    };
  }
  let parts;
  try {
    parts = parseAgentComposerParts(value.parts);
  } catch (error) {
    throw new RpcFault(-32602, safeMessage(error));
  }
  return {
    operationId: requiredUuidV4(value.operationId, 'operationId'),
    conversationId: requiredUuidV4(value.conversationId, 'conversationId'),
    clientMessageId: requiredUuidV4(value.clientMessageId, 'clientMessageId'),
    parts,
    text: agentPromptText(parts),
  };
}

function parseMessageQueueMutation(params: unknown): MessageQueueMutationParams {
  const value = objectValue(params);
  return {
    conversationId: requiredUuidV4(value.conversationId, 'conversationId'),
    operationId: requiredUuidV4(value.operationId, 'operationId'),
  };
}

function parseMessageBranch(params: unknown): MessageBranchParams {
  const value = objectValue(params);
  let parts;
  try {
    parts = parseAgentComposerParts(value.parts);
  } catch (error) {
    throw new RpcFault(-32602, safeMessage(error));
  }
  return {
    operationId: requiredUuidV4(value.operationId, 'operationId'),
    clientMessageId: requiredUuidV4(value.clientMessageId, 'clientMessageId'),
    sourceConversationId: requiredUuidV4(value.sourceConversationId, 'sourceConversationId'),
    sourceTurnId: requiredUuidV4(value.sourceTurnId, 'sourceTurnId'),
    sourceMessageId: requiredUuidV4(value.sourceMessageId, 'sourceMessageId'),
    parts,
    text: agentPromptText(parts),
  };
}

function branchPrefix(
  actions: readonly DurableTranscriptProjectionAction[],
  params: MessageBranchParams,
  mode: 'edit' | 'fork',
) {
  if (mode === 'edit') {
    const target = actions.find((action) =>
      action.type === 'turn' &&
      action.turnId === params.sourceTurnId &&
      action.itemId === params.sourceMessageId);
    if (!target) throw new RpcFault(-32015, 'The message to edit was not found.');
    return actions.filter((action) => action.sequence < target.sequence);
  }
  const assistant = actions.find((action) =>
    action.type === 'assistant' &&
    action.turnId === params.sourceTurnId &&
    action.itemId === params.sourceMessageId);
  if (!assistant) throw new RpcFault(-32015, 'The response to fork was not found.');
  const terminal = actions.find((action) =>
    action.type === 'terminal' && action.turnId === params.sourceTurnId);
  if (!terminal) throw new RpcFault(-32013, 'The response is still changing and cannot be forked.');
  return actions.filter((action) => action.sequence <= terminal.sequence);
}

function groupedTranscriptActions(actions: readonly DurableTranscriptProjectionAction[]) {
  const order: string[] = [];
  const byTurn = new Map<string, DurableTranscriptProjectionAction[]>();
  for (const action of actions) {
    let group = byTurn.get(action.turnId);
    if (!group) {
      group = [];
      byTurn.set(action.turnId, group);
      order.push(action.turnId);
    }
    group.push(action);
  }
  return order.map((turnId) => byTurn.get(turnId)!);
}

function derivedUuid(namespace: string, label: string) {
  const bytes = createHash('sha256').update(namespace).update('\0').update(label).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function parseLoginCancel(params: unknown): LoginCancelParams {
  const value = objectValue(params);
  return { operationId: requiredUuidV4(value.operationId, 'operationId') };
}

function parseTurnInterrupt(params: unknown): TurnInterruptParams {
  const value = objectValue(params);
  return {
    conversationId: requiredUuidV4(value.conversationId, 'conversationId'),
    turnId: requiredUuidV4(value.turnId, 'turnId'),
  };
}

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RpcFault(-32602, 'Expected an object.');
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, name: string) {
  if (typeof value !== 'string' || value.length === 0) throw new RpcFault(-32602, `${name} must be a non-empty string.`);
  return value;
}

function reasoningLevel(value: unknown): ReasoningLevel {
  if (value === 'off' || value === 'minimal' || value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh' || value === 'max') {
    return value;
  }
  throw new RpcFault(-32602, 'Unknown reasoning level.');
}

async function canonicalDirectory(path: string) {
  try {
    const canonical = await realpath(path);
    if (!(await stat(canonical)).isDirectory()) throw new Error('not a directory');
    return canonical;
  } catch {
    throw new RpcFault(-32602, 'cwd must name an existing directory.');
  }
}

function isResourceKey(value: string): value is ResourceReadParams['requests'][number]['key'] {
  return value === 'auth' || value === 'models' || value === 'conversation-list' ||
    value === 'runtime' ||
    (value.startsWith('conversation:') && UUID_V4.test(value.slice('conversation:'.length))) ||
    (value.startsWith('context:') && UUID_V4.test(value.slice('context:'.length))) ||
    (value.startsWith('queue:') && UUID_V4.test(value.slice('queue:'.length)));
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

function runtimeValue(
  conversationId: string,
  modelId: string,
  state: 'loading' | 'idle',
): AgentRuntimeValue {
  return {
    conversationId,
    state,
    activeTurnId: null,
    activeTurnElapsedMs: null,
    contextProbe: {
      hookVersion: 'agent-durable-v1',
      modelCallCount: 0,
      messageCount: 0,
      messageHash: null,
      orderedMessageHashes: [],
      estimatedBytes: 0,
      provider: 'openai-codex',
      modelId,
      providerRequestMode: 'none',
    },
    error: null,
  };
}

function activeRuntimeBusyFault(runtime: AgentRuntimeValue) {
  const conversationId = runtime.conversationId;
  const turnId = runtime.activeTurnId;
  if (!conversationId || !turnId) return new RpcFault(-32603, 'The active runtime state is invalid.');
  const data: AgentCommandErrorData = {
    kind: 'active_runtime_busy',
    conversationId,
    turnId,
  };
  return new RpcFault(-32019, 'Another conversation has an active turn.', data);
}

function turnActiveFault(runtime: AgentRuntimeValue) {
  const conversationId = runtime.conversationId;
  const turnId = runtime.activeTurnId;
  if (!conversationId || !turnId) return new RpcFault(-32603, 'The active runtime state is invalid.');
  const data: AgentCommandErrorData = {
    kind: 'turn_active',
    conversationId,
    turnId,
  };
  return new RpcFault(-32013, 'A turn is already running in this conversation.', data);
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
