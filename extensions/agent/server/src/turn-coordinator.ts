import { performance } from 'node:perf_hooks';
import type { AssistantMessage } from '@earendil-works/pi-ai';

import {
  AGENT_RESOURCE_KEYS,
  conversationResourceKey,
  contextResourceKey,
  type AgentRuntimeValue,
  type MessageSendParams,
  type TurnInterruptParams,
} from '../../shared/protocol.ts';
import type { AgentResourceInvalidation } from '../../shared/transcript.ts';
import type { AgentStore } from './agent-store.ts';
import type {
  ConversationRuntime,
  RuntimeEvent,
  WorkUnitEnterInput,
  WorkUnitReturnInput,
} from './engine.ts';
import type {
  DurableInferenceContext,
  DurableTranscriptMutation,
  DurableTurnHandle,
  PreparedWorkUnitReturn,
} from './domain/state.ts';
import { createReplayedTranscriptProjector } from './transcript-replay.ts';
import type { EphemeralTranscriptProjector } from './transcript-projector.ts';
import { ResourceStore } from './resources.ts';
import { RpcFault } from './agent-rpc-router.ts';

type TurnCoordinatorOptions = {
  store: AgentStore;
  resources: ResourceStore;
  monotonicNow?: () => number;
  runtime: () => ConversationRuntime | null;
  projector: () => EphemeralTranscriptProjector | null;
  replaceProjector: (projector: EphemeralTranscriptProjector) => void;
  conversationId: () => string | null;
  isClosing: () => boolean;
  enqueueConversationCommand: (work: () => void | Promise<void>) => void;
  dispatchNextQueuedMessage: (conversationId: string) => Promise<void>;
  publishProjectorInvalidations: (invalidations: AgentResourceInvalidation[]) => void;
};

type AcceptedTurn = Awaited<ReturnType<AgentStore['acceptTurn']>>;

/**
 * Owns the active-turn state machine and its serialized durable write fence.
 * Conversation selection and RPC routing deliberately live outside this class.
 */
export class TurnCoordinator {
  private readonly options: TurnCoordinatorOptions;
  private readonly store: AgentStore;
  private readonly resources: ResourceStore;
  private readonly monotonicNow: () => number;
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

  constructor(options: TurnCoordinatorOptions) {
    this.options = options;
    this.store = options.store;
    this.resources = options.resources;
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
  }

  async beginTurn(
    durable: AcceptedTurn,
    params: MessageSendParams,
    runtimeValue: AgentRuntimeValue,
  ) {
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
      this.options.projector()?.beginTurn({
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
      await this.store.finishTurn(durable, {
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
  }

  resume(rootHandle: DurableTurnHandle, handle: DurableTurnHandle) {
    this.activeDurableTurn = rootHandle;
    this.activeDurableScope = handle;
    this.activeTurnStartedMonotonicAt = this.monotonicNow();
    this.turnWriteTail = Promise.resolve();
    this.turnWriteError = null;
    this.turnCompletion = null;
    this.durabilityFailure = null;
  }

  durabilityHooks(conversationId: string) {
    return {
      compileContext: (contextWindow: number) => this.compileContext(conversationId, contextWindow),
      noticeContextPressure: (input: {
        estimatedInputTokens: number;
        softContextLimit: number;
        hardContextLimit: number;
      }) => this.noticeContextPressure(conversationId, input),
      beforeAssistantMessageEnd: (input: {
        inferenceState: 'completed' | 'failed' | 'interrupted';
        text: string;
        reasoning: string;
        calls: Array<{ callId: string; name: string; args: unknown }>;
        providerMessage: AssistantMessage;
      }) => this.beforeAssistantMessageEnd(conversationId, input),
      beforeProviderCall: (input: {
        payload: unknown;
        requestMode: 'full' | 'continuation';
        estimatedInputTokens: number;
        retryOfInferenceId?: string;
        context: DurableInferenceContext;
      }) => this.beforeProviderCall(conversationId, input),
      afterProviderCall: (input: {
        plannedRequestMode: 'full' | 'continuation';
        actualRequestMode: 'full' | 'continuation';
        carrier: 'websocket' | 'sse' | 'unknown';
        websocketRequests: number;
        connectionsCreated: number;
        connectionsReused: number;
        websocketFailures: number;
        sseFallbacks: number;
        dispatchToFirstEventMs: number | null;
        durationMs: number;
      }) => this.afterProviderCall(conversationId, input),
      supersedeProviderAttempt: (input: {
        attempt: number;
        maxAttempts: number;
        delayMs: number;
        error: string;
      }) => this.supersedeProviderAttempt(conversationId, input),
      beforeTool: (input: { callId: string; name: string; args: unknown }) =>
        this.beforeTool(conversationId, input),
      afterTool: (input: { callId: string; name: string; result: unknown; isError: boolean }) =>
        this.afterTool(conversationId, input),
      historySearch: (callId: string, input: Parameters<AgentStore['searchHistory']>[1]) => {
        return this.store.searchHistory(conversationId, input, {
          excludeRef: `history://tool/${encodeURIComponent(callId)}`,
        });
      },
      historyOpen: (input: Parameters<AgentStore['openHistory']>[1]) =>
        this.store.openHistory(conversationId, input),
      threadRead: () => this.store.readThread(conversationId),
      threadPatch: (input: Parameters<AgentStore['patchThread']>[1]) =>
        this.store.patchThread(this.requiredActiveDurableScope(conversationId), input),
      threadReplace: (input: Parameters<AgentStore['replaceThread']>[1]) =>
        this.store.replaceThread(this.requiredActiveDurableScope(conversationId), input),
      workUnitEnter: (callId: string, input: WorkUnitEnterInput) =>
        this.enterWorkUnit(conversationId, callId, input),
      workUnitReturn: (callId: string, input: WorkUnitReturnInput) =>
        this.requestWorkUnitReturn(conversationId, callId, input),
    };
  }

  applyRuntimeEvent(conversationId: string, event: RuntimeEvent) {
    const runtimeValue = this.resources.get<AgentRuntimeValue>(AGENT_RESOURCE_KEYS.runtime);
    if (!runtimeValue || runtimeValue.conversationId !== conversationId) return;
    const turnId = runtimeValue.activeTurnId;
    let runtimeChanged = false;
    switch (event.type) {
      case 'assistant-start':
        if (turnId && this.activeDurableScope && this.isRootScope(this.activeDurableScope)) {
          this.options.projector()?.assistantStarted(turnId);
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
        ).catch((error) => this.failDurability(conversationId, error));
        return;
      case 'tool-start':
        if (turnId) void this.beforeTool(conversationId, event)
          .catch((error) => this.failDurability(conversationId, error));
        break;
      case 'tool-update':
        break;
      case 'tool-end':
        if (turnId) void this.afterTool(conversationId, event)
          .catch((error) => this.failDurability(conversationId, error));
        break;
      case 'context-probe':
        runtimeValue.contextProbe = event.probe;
        runtimeChanged = true;
        break;
    }
    if (runtimeChanged) this.resources.set(AGENT_RESOURCE_KEYS.runtime, runtimeValue);
  }

  interrupt(params: TurnInterruptParams) {
    const runtimeValue = this.requiredConversation(params.conversationId);
    if (runtimeValue.activeTurnId !== params.turnId || runtimeValue.state === 'idle') {
      throw new RpcFault(-32014, 'The requested turn is no longer active.');
    }
    if (runtimeValue.state === 'interrupting') return { accepted: true as const };
    runtimeValue.state = 'interrupting';
    this.resources.set(AGENT_RESOURCE_KEYS.runtime, runtimeValue);
    const runtime = this.options.runtime();
    if (runtime) {
      void runtime.interrupt()
        .catch((error) => this.completeTurn(params.conversationId, true, safeMessage(error)))
        .catch((error) => this.failDurability(params.conversationId, error));
    }
    return { accepted: true as const };
  }

  completeTurn(conversationId: string, interrupted: boolean, error?: string) {
    this.turnCompletion ??= this.completeTurnOnce(conversationId, interrupted, error);
    return this.turnCompletion;
  }

  failDurability(conversationId: string, error: unknown) {
    this.durabilityFailure ??= this.failDurabilityOnce(conversationId, error);
  }

  async settleWrites() {
    await this.turnWriteTail;
    if (this.turnWriteError) throw this.turnWriteError;
  }

  async disposeConversation(previous: ConversationRuntime | null, conversationId: string | null) {
    if (previous && this.activeDurableTurn && conversationId) {
      await previous.interrupt().catch(() => undefined);
      await this.completeTurn(conversationId, true).catch((error) => {
        this.failDurability(conversationId, error);
      });
      await this.durabilityFailure;
    }
    if (this.assistantFlushTimer) clearTimeout(this.assistantFlushTimer);
    this.assistantFlushTimer = null;
    await this.turnWriteTail;
    this.reset();
  }

  private async beforeProviderCall(
    conversationId: string,
    input: {
      payload: unknown;
      requestMode: 'full' | 'continuation';
      estimatedInputTokens: number;
      retryOfInferenceId?: string;
      context: DurableInferenceContext;
    },
  ) {
    const handle = this.requiredActiveDurableScope(conversationId);
    const runtime = this.resources.get<AgentRuntimeValue>(AGENT_RESOURCE_KEYS.runtime);
    const modelId = runtime?.contextProbe?.modelId;
    if (!modelId) throw new Error('Provider dispatch has no durable model identity.');
    await this.enqueueTurnWrite(() => this.store.startInference(handle, {
      modelId,
      requestMode: input.requestMode,
      estimatedInputTokens: input.estimatedInputTokens,
      payload: input.payload,
      ...(input.retryOfInferenceId ? { retryOfInferenceId: input.retryOfInferenceId } : {}),
      context: input.context,
    }));
    this.resources.invalidateKey(contextResourceKey(conversationId), 'updated');
    this.inferenceAssistantText = '';
    this.inferenceAssistantReasoning = '';
  }

  private async supersedeProviderAttempt(
    conversationId: string,
    input: { attempt: number; maxAttempts: number; delayMs: number; error: string },
  ) {
    const handle = this.requiredActiveDurableScope(conversationId);
    await this.flushAssistantCheckpoint();
    const result = await this.enqueueTurnWrite(() => this.store.supersedeInference(handle, input));
    this.inferenceAssistantText = '';
    this.inferenceAssistantReasoning = '';
    this.pendingAssistantText = '';
    this.pendingAssistantReasoning = '';
    this.resources.invalidateKey(contextResourceKey(conversationId), 'updated');
    if (this.isRootScope(handle)) {
      const projection = await this.store.readTranscriptProjection(conversationId);
      if (!projection) throw new Error(`Conversation ${conversationId} disappeared during provider recovery.`);
      this.options.replaceProjector(createReplayedTranscriptProjector({
        conversationId,
        actions: projection.actions,
        basisSequence: projection.basisSequence,
        live: true,
        invalidate: (invalidations) => this.options.publishProjectorInvalidations(invalidations),
      }));
      this.options.publishProjectorInvalidations([{
        type: 'transcript',
        key: `transcript:${conversationId}`,
        conversationId,
        turnId: handle.turnId,
        reason: 'runtimeEvent',
        affectsOrder: false,
        affectsLayout: true,
        basisSequence: projection.basisSequence,
      }]);
    }
    return result;
  }

  private async compileContext(conversationId: string, contextWindow: number) {
    this.requiredActiveDurableScope(conversationId);
    await this.flushAssistantCheckpoint();
    await this.settleWrites();
    return this.store.compileContext(conversationId, contextWindow);
  }

  private async noticeContextPressure(
    conversationId: string,
    input: { estimatedInputTokens: number; softContextLimit: number; hardContextLimit: number },
  ) {
    const handle = this.requiredActiveDurableScope(conversationId);
    const recorded = await this.enqueueTurnWrite(() => this.store.recordContextPressure(handle, input));
    if (recorded) this.resources.invalidateKey(contextResourceKey(conversationId), 'updated');
    return recorded;
  }

  private async afterProviderCall(
    conversationId: string,
    input: {
      plannedRequestMode: 'full' | 'continuation';
      actualRequestMode: 'full' | 'continuation';
      carrier: 'websocket' | 'sse' | 'unknown';
      websocketRequests: number;
      connectionsCreated: number;
      connectionsReused: number;
      websocketFailures: number;
      sseFallbacks: number;
      dispatchToFirstEventMs: number | null;
      durationMs: number;
    },
  ) {
    const handle = this.requiredActiveDurableScope(conversationId);
    const recorded = await this.enqueueTurnWrite(() => this.store.recordInferenceTransport(handle, input));
    if (recorded) this.resources.invalidateKey(contextResourceKey(conversationId), 'updated');
  }

  private async finishInferenceBoundary(
    conversationId: string,
    state: 'completed' | 'failed' | 'interrupted',
  ) {
    const handle = this.activeDurableScope;
    if (!handle || handle.conversationId !== conversationId) return;
    await this.flushAssistantCheckpoint();
    await this.enqueueTurnWrite(() => this.store.finishInference(handle, { state }));
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
    await this.enqueueTurnWrite(() => this.store.recordProviderItem(handle, input.providerMessage));
    const textDelta = finalizedSuffix(this.inferenceAssistantText, input.text, 'assistant text');
    const reasoningDelta = finalizedSuffix(
      this.inferenceAssistantReasoning,
      input.reasoning,
      'assistant reasoning',
    );
    if (textDelta || reasoningDelta) {
      await this.enqueueTurnWrite(async () => {
        const mutation = await this.store.appendAssistantCheckpoint(handle, { textDelta, reasoningDelta });
        if (!mutation) return;
        if (this.isRootScope(handle)) {
          this.resources.invalidateKey(conversationResourceKey(handle.conversationId));
          this.resources.invalidateKey(AGENT_RESOURCE_KEYS.conversationList);
          const projection = transcriptMutation(mutation);
          if (reasoningDelta) this.options.projector()?.appendReasoning(handle.turnId, reasoningDelta, projection);
          if (textDelta) this.options.projector()?.appendAssistantText(handle.turnId, textDelta, projection);
        }
      });
    }
    this.inferenceAssistantText = input.text;
    this.inferenceAssistantReasoning = input.reasoning;
    await this.enqueueTurnWrite(() => this.store.finishInference(handle, { state: input.inferenceState }));
    for (const call of input.calls) {
      this.toolScopes.set(call.callId, handle);
      const inserted = await this.enqueueTurnWrite(() => this.store.recordToolStarted(handle, call));
      if (inserted && this.isRootScope(handle)) {
        this.options.projector()?.startTool(handle.turnId, {
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
    const inserted = await this.enqueueTurnWrite(() => this.store.recordToolStarted(handle, input));
    if (inserted && this.isRootScope(handle)) {
      this.options.projector()?.startTool(handle.turnId, {
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
    const inserted = await this.enqueueTurnWrite(() => this.store.recordToolFinished(handle, input));
    if (inserted && this.isRootScope(handle)) {
      this.options.projector()?.endTool(handle.turnId, {
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
      const returned = await this.enqueueTurnWrite(() =>
        this.store.commitWorkUnitReturn(handle, pendingReturn.prepared));
      this.activeDurableScope = returned.parentHandle;
    }
    this.pendingWorkUnitReturns.delete(input.callId);
    this.toolScopes.delete(input.callId);
  }

  private async enterWorkUnit(conversationId: string, callId: string, input: WorkUnitEnterInput) {
    const parent = this.requiredActiveDurableScope(conversationId);
    if (!this.isRootScope(parent)) throw new Error('Work units cannot be nested.');
    await this.flushAssistantCheckpoint();
    const prepared = await this.store.prepareWorkUnitEntry(parent, input);
    const entered = await this.enqueueTurnWrite(() => this.store.commitWorkUnitEntry(parent, prepared));
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
    const prepared = await this.store.prepareWorkUnitReturn(handle, input);
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
        const conversationId = this.options.conversationId();
        if (conversationId) this.failDurability(conversationId, error);
      });
      return;
    }
    if (!this.assistantFlushTimer) {
      this.assistantFlushTimer = setTimeout(() => {
        this.assistantFlushTimer = null;
        void this.flushAssistantCheckpoint().catch((error) => {
          const conversationId = this.options.conversationId();
          if (conversationId) this.failDurability(conversationId, error);
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
      const mutation = await this.store.appendAssistantCheckpoint(handle, { textDelta, reasoningDelta });
      if (!mutation) return;
      if (this.isRootScope(handle)) {
        this.resources.invalidateKey(conversationResourceKey(handle.conversationId));
        this.resources.invalidateKey(AGENT_RESOURCE_KEYS.conversationList);
        const projection = transcriptMutation(mutation);
        if (reasoningDelta) this.options.projector()?.appendReasoning(handle.turnId, reasoningDelta, projection);
        if (textDelta) this.options.projector()?.appendAssistantText(handle.turnId, textDelta, projection);
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

  private async failDurabilityOnce(conversationId: string, error: unknown) {
    const message = `Durable state failure: ${safeMessage(error)}`;
    const runtimeValue = this.resources.get<AgentRuntimeValue>(AGENT_RESOURCE_KEYS.runtime);
    if (runtimeValue?.conversationId === conversationId) {
      runtimeValue.state = 'error';
      runtimeValue.error = message;
      this.resources.set(AGENT_RESOURCE_KEYS.runtime, runtimeValue);
    }
    await this.options.runtime()?.interrupt().catch(() => undefined);
    const handle = this.activeDurableTurn;
    if (!handle || handle.conversationId !== conversationId) return;
    const durationMs = this.activeTurnDurationMs();
    let mutation: DurableTranscriptMutation | null;
    try {
      mutation = await this.store.finishTurn(handle, {
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
      return;
    }
    if (runtimeValue?.activeTurnId === handle.turnId) {
      runtimeValue.activeTurnId = null;
      runtimeValue.activeTurnElapsedMs = null;
      this.resources.set(AGENT_RESOURCE_KEYS.runtime, runtimeValue);
    }
    this.options.projector()?.finishTurn(handle.turnId, {
      status: 'failed',
      error: { code: 'storage_error', message },
      durationMs,
      ...(mutation ? transcriptTerminalMutation(mutation) : {}),
    });
    this.resetActiveTurn();
    if (!this.options.isClosing()) {
      this.options.enqueueConversationCommand(() => this.options.dispatchNextQueuedMessage(conversationId));
    }
  }

  private async completeTurnOnce(conversationId: string, interrupted: boolean, error?: string) {
    const runtimeValue = this.resources.get<AgentRuntimeValue>(AGENT_RESOURCE_KEYS.runtime);
    const handle = this.activeDurableTurn;
    if (!runtimeValue || runtimeValue.conversationId !== conversationId || !runtimeValue.activeTurnId || !handle) {
      return;
    }
    const turnId = runtimeValue.activeTurnId;
    await this.flushAssistantCheckpoint();
    await this.settleWrites();
    const status = error ? 'failed' : interrupted ? 'interrupted' : 'completed';
    const durationMs = this.activeTurnDurationMs();
    const mutation = await this.store.finishTurn(handle, {
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
    this.options.projector()?.finishTurn(turnId, {
      status,
      error: error ? { code: 'provider_error', message: error } : null,
      durationMs,
      ...(mutation ? transcriptTerminalMutation(mutation) : {}),
    });
    this.resetActiveTurn();
    if (!this.options.isClosing()) {
      this.options.enqueueConversationCommand(() => this.options.dispatchNextQueuedMessage(conversationId));
    }
  }

  private requiredConversation(id: string) {
    if (this.options.conversationId() !== id) throw new RpcFault(-32015, 'Conversation not found.');
    const runtimeValue = this.resources.get<AgentRuntimeValue>(AGENT_RESOURCE_KEYS.runtime);
    if (runtimeValue?.conversationId !== id) throw new RpcFault(-32015, 'Conversation not found.');
    return runtimeValue;
  }

  private activeTurnDurationMs() {
    return this.activeTurnStartedMonotonicAt === null
      ? 0
      : Math.round(Math.max(0, this.monotonicNow() - this.activeTurnStartedMonotonicAt));
  }

  private resetActiveTurn() {
    this.activeDurableTurn = null;
    this.activeDurableScope = null;
    this.toolScopes.clear();
    this.pendingWorkUnitReturns.clear();
    this.activeTurnStartedMonotonicAt = null;
  }

  private reset() {
    this.resetActiveTurn();
    this.turnCompletion = null;
    this.durabilityFailure = null;
  }
}

function finalizedSuffix(observed: string, finalized: string, label: string) {
  if (!finalized.startsWith(observed)) {
    if (observed.startsWith(finalized) && observed.slice(finalized.length).trim() === '') return '';
    throw new Error(`Pi finalized ${label} by rewriting already recorded content.`);
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

function safeMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/Bearer\s+\S+/giu, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, '[redacted]')
    .slice(0, 1_000);
}
