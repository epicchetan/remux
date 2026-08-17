import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';

import {
  AGENT_RESOURCE_KEYS,
  DEFAULT_TURN_CONTEXT_DIALOGUE_TURNS,
  conversationResourceKey,
  queueResourceKey,
  type AgentCommandErrorData,
  type AgentRuntimeValue,
  type AuthValue,
  type ConversationCreateParams,
  type ConversationSummary,
  type MessageBranchParams,
  type MessageBranchResult,
  type MessageQueueMutationParams,
  type MessageSendParams,
  type ModelsValue,
} from '../../shared/protocol.ts';
import type { AgentResourceInvalidation } from '../../shared/transcript.ts';
import type { AgentStore } from './agent-store.ts';
import { RpcFault } from './agent-rpc-router.ts';
import type { ModelProvider, ModelSession } from './model-provider.ts';
import type {
  DurableTranscriptAction,
  DurableTranscriptProjectionAction,
} from './domain/state.ts';
import { ResourceStore } from './resources.ts';
import { createReplayedTranscriptProjector } from './transcript-replay.ts';
import type { EphemeralTranscriptProjector } from './transcript-projector.ts';
import { agentPromptImages } from './user-input.ts';
import { TurnCoordinator } from './turn-coordinator.ts';
import type { AgentTurnTerminalNotificationInput } from './app-notifications.ts';

type ConversationControllerOptions = {
  provider: ModelProvider;
  store: AgentStore;
  resources: ResourceStore;
  monotonicNow?: () => number;
  publishProjectorInvalidations: (invalidations: AgentResourceInvalidation[]) => void;
  publishTurnNotification: (input: AgentTurnTerminalNotificationInput) => Promise<void>;
};

/** Owns conversation selection, runtime hydration, branching, and the message queue. */
export class ConversationController {
  readonly turns: TurnCoordinator;
  private readonly options: ConversationControllerOptions;
  private readonly provider: ModelProvider;
  private readonly store: AgentStore;
  private readonly resources: ResourceStore;
  private sessionValue: ModelSession | null = null;
  private sessionModelIdValue: string | null = null;
  private projectorValue: EphemeralTranscriptProjector | null = null;
  private conversationIdValue: string | null = null;
  private conversationOperationId: string | null = null;
  private commandTail: Promise<void> = Promise.resolve();
  private nextQueuedOperationId: string | null = null;
  private closing = false;

  constructor(options: ConversationControllerOptions) {
    this.options = options;
    this.provider = options.provider;
    this.store = options.store;
    this.resources = options.resources;
    this.turns = new TurnCoordinator({
      store: options.store,
      resources: options.resources,
      ...(options.monotonicNow ? { monotonicNow: options.monotonicNow } : {}),
      session: () => this.sessionValue,
      projector: () => this.projectorValue,
      replaceProjector: (projector) => {
        this.projectorValue = projector;
      },
      conversationId: () => this.conversationIdValue,
      isClosing: () => this.closing,
      enqueueConversationCommand: (work) => {
        void this.enqueue(work);
      },
      dispatchNextQueuedMessage: (conversationId) => this.dispatchNextQueuedMessage(conversationId),
      publishProjectorInvalidations: options.publishProjectorInvalidations,
      publishTurnNotification: options.publishTurnNotification,
    });
  }

  get session() {
    return this.sessionValue;
  }

  get projector() {
    return this.projectorValue;
  }

  get conversationId() {
    return this.conversationIdValue;
  }

  enqueue<T>(work: () => T | Promise<T>) {
    const next = this.commandTail.then(work, work);
    this.commandTail = next.then(() => undefined, () => undefined);
    return next;
  }

  dispatchOldestQueuedConversation() {
    return this.store.readOldestQueuedConversationId().then((conversationId) => {
      if (conversationId) void this.enqueue(() => this.dispatchNextQueuedMessage(conversationId));
    });
  }

  async createConversation(params: ConversationCreateParams) {
    const auth = this.resources.get<AuthValue>(AGENT_RESOURCE_KEYS.auth);
    if (auth?.state !== 'signed-in') throw new RpcFault(-32011, 'Sign in before starting a conversation.');
    const models = this.resources.get<ModelsValue>(AGENT_RESOURCE_KEYS.models);
    const selected = models?.models.find((model) => model.id === params.modelId);
    if (!selected) throw new RpcFault(-32602, 'The selected model is unavailable.');
    if (!selected.supportedReasoning.includes(params.reasoning)) {
      throw new RpcFault(-32602, 'The selected reasoning level is unavailable for this model.');
    }
    if (this.conversationIdValue) {
      const current = this.resources.get<AgentRuntimeValue>(AGENT_RESOURCE_KEYS.runtime);
      if (
        (current?.state === 'running' || current?.state === 'interrupting') &&
        this.conversationOperationId !== params.operationId
      ) {
        throw activeRuntimeBusyFault(current);
      }
    }

    const cwd = await canonicalDirectory(params.cwd);
    let durable: Awaited<ReturnType<AgentStore['createConversation']>>;
    try {
      durable = await this.store.createConversation({
        operationId: params.operationId,
        cwd,
        modelId: params.modelId,
        reasoning: params.reasoning,
      });
    } catch (error) {
      if (isOperationConflict(error, params.operationId)) {
        throw operationConflictFault('Conversation creation operation', params.operationId);
      }
      throw error;
    }
    if (!durable.replayed) {
      this.resources.invalidateKey(conversationResourceKey(durable.conversationId), 'created');
      this.resources.invalidateKey(AGENT_RESOURCE_KEYS.conversationList, 'updated');
    }
    await this.loadModelSession({
      id: durable.conversationId,
      cwd,
    }, params.operationId, params.modelId, params.reasoning);
    return { conversationId: durable.conversationId };
  }

  async sendMessage(params: MessageSendParams) {
    if (!params.text.trim()) throw new RpcFault(-32602, 'Message text cannot be empty.');
    let queuedReplay;
    try {
      queuedReplay = await this.store.reconcileQueuedTurn(params);
    } catch (error) {
      if (isOperationConflict(error, params.operationId)) {
        throw operationConflictFault('Message operation', params.operationId);
      }
      throw error;
    }
    if (queuedReplay) return {
      accepted: true as const,
      delivery: queuedReplay.delivery,
      operationId: queuedReplay.operationId,
      turnId: queuedReplay.turnId,
    };
    let replay: Awaited<ReturnType<AgentStore['reconcileTurn']>>;
    try {
      replay = await this.store.reconcileTurn(params);
    } catch (error) {
      if (isOperationConflict(error, params.operationId)) {
        throw operationConflictFault('Message operation', params.operationId);
      }
      if (isClientMessageConflict(error)) throw clientMessageConflictFault(params.clientMessageId);
      throw error;
    }
    if (replay) return {
      accepted: true as const,
      operationId: replay.operationId,
      turnId: replay.turnId,
    };

    this.assertTurnConfigurationAvailable(
      params.conversationId,
      params.modelId,
      params.reasoning,
    );

    const currentRuntime = this.resources.get<AgentRuntimeValue>(AGENT_RESOURCE_KEYS.runtime);
    if (
      this.conversationIdValue === params.conversationId &&
      currentRuntime?.conversationId === params.conversationId &&
      (currentRuntime.state === 'running' || currentRuntime.state === 'interrupting')
    ) {
      const queued = await this.store.enqueueTurn(params);
      this.resources.invalidateKey(queueResourceKey(params.conversationId), 'updated');
      return {
        accepted: true as const,
        delivery: 'queued' as const,
        operationId: queued.operationId,
        turnId: null,
      };
    }
    const runtimeState = await this.ensureModelSession(
      params.conversationId,
      params.modelId,
      params.reasoning,
    );
    if (!this.sessionValue) throw new RpcFault(-32012, 'The conversation runtime is unavailable.');
    let durable: Awaited<ReturnType<AgentStore['acceptTurn']>>;
    try {
      durable = await this.store.acceptTurn(params);
    } catch (error) {
      if (isOperationConflict(error, params.operationId)) {
        throw operationConflictFault('Message operation', params.operationId);
      }
      if (isClientMessageConflict(error)) throw clientMessageConflictFault(params.clientMessageId);
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
    await this.turns.beginTurn(durable, params, runtimeState);
    const session = this.sessionValue;
    void Promise.resolve().then(() => session.prompt({
      text: params.text,
      reasoning: params.reasoning,
      images: agentPromptImages(params.parts ?? [{ text: params.text, type: 'text' }]),
    })).then(() => this.turns.completeTurn(params.conversationId, false))
      .catch((error) => this.turns.completeTurn(params.conversationId, false, safeMessage(error)))
      .catch((error) => this.turns.failDurability(params.conversationId, error));
    return { accepted: true as const, operationId: durable.operationId, turnId };
  }

  async removeQueuedMessage(params: MessageQueueMutationParams) {
    const removed = await this.store.removeQueuedTurn(params.conversationId, params.operationId);
    this.resources.invalidateKey(queueResourceKey(params.conversationId), 'updated');
    return { status: removed ? 'removed' as const : 'retained' as const };
  }

  async runQueuedMessageNow(params: MessageQueueMutationParams) {
    const queued = await this.store.readQueuedTurn(params.conversationId, params.operationId);
    if (!queued) return { status: 'retained' as const };
    this.nextQueuedOperationId = params.operationId;
    const runtime = this.resources.get<AgentRuntimeValue>(AGENT_RESOURCE_KEYS.runtime);
    if (
      runtime?.conversationId === params.conversationId &&
      runtime.activeTurnId &&
      (runtime.state === 'running' || runtime.state === 'interrupting')
    ) {
      if (runtime.state === 'running') this.turns.interrupt({
        conversationId: params.conversationId,
        turnId: runtime.activeTurnId,
      });
      return { status: 'running' as const };
    }
    await this.dispatchNextQueuedMessage(params.conversationId);
    return { status: 'running' as const };
  }

  async branchMessage(
    params: MessageBranchParams,
    mode: 'edit' | 'fork',
  ): Promise<MessageBranchResult> {
    const active = this.resources.get<AgentRuntimeValue>(AGENT_RESOURCE_KEYS.runtime);
    if (active?.state === 'running' || active?.state === 'interrupting') {
      throw new RpcFault(-32013, 'Wait for the active turn to finish before editing or forking.');
    }
    this.assertTurnConfigurationAvailable(
      params.sourceConversationId,
      params.modelId,
      params.reasoning,
    );
    const source = await this.readConversationSummary(params.sourceConversationId);
    const projection = await this.store.readTranscriptProjection(params.sourceConversationId);
    if (!projection) throw new RpcFault(-32015, 'Source conversation transcript was not found.');
    const prefix = branchPrefix(projection.actions, params, mode);
    const branch = await this.store.createConversation({
      operationId: params.operationId,
      cwd: source.cwd,
      modelId: params.modelId,
      reasoning: params.reasoning,
    });
    const clonedTurnIds = await this.cloneTranscriptPrefix(
      params.sourceConversationId,
      branch.conversationId,
      prefix,
      params.operationId,
    );
    this.resources.invalidateKey(AGENT_RESOURCE_KEYS.conversationList, 'created');
    this.resources.invalidateKey(conversationResourceKey(branch.conversationId), 'created');
    const sent = await this.sendMessage({
      operationId: derivedUuid(params.operationId, 'branch-message'),
      conversationId: branch.conversationId,
      clientMessageId: params.clientMessageId,
      modelId: params.modelId,
      contextPlan: {
        ...params.contextPlan,
        overrides: params.contextPlan.overrides.flatMap((override) => {
          const clonedTurnId = clonedTurnIds.get(override.turnId);
          return clonedTurnId ? [{ ...override, turnId: clonedTurnId }] : [];
        }),
      },
      reasoning: params.reasoning,
      text: params.text,
      ...(params.parts ? { parts: params.parts } : {}),
    });
    if (!sent.turnId) throw new Error('A branch message was unexpectedly queued.');
    return { conversationId: branch.conversationId, turnId: sent.turnId };
  }

  async disposeConversation() {
    const previous = this.sessionValue;
    await this.turns.disposeConversation(previous, this.conversationIdValue);
    this.sessionValue = null;
    this.sessionModelIdValue = null;
    this.projectorValue = null;
    if (previous) await previous.dispose();
    this.conversationIdValue = null;
    this.resources.set(AGENT_RESOURCE_KEYS.runtime, unloadedRuntime());
    this.conversationOperationId = null;
  }

  async close() {
    this.closing = true;
    await this.commandTail;
    await this.disposeConversation();
  }

  private async dispatchNextQueuedMessage(conversationId: string) {
    if (this.closing) return;
    const requested = this.nextQueuedOperationId;
    this.nextQueuedOperationId = null;
    const queued = await this.store.readQueuedTurn(conversationId, requested ?? undefined)
      ?? (requested ? await this.store.readQueuedTurn(conversationId) : null);
    if (!queued) return;
    try {
      const sent = await this.sendMessage(queued);
      if (sent.turnId) {
        await this.store.finishQueuedTurn(queued.queueOperationId, sent.turnId);
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

  private async cloneTranscriptPrefix(
    sourceConversationId: string,
    conversationId: string,
    actions: readonly DurableTranscriptProjectionAction[],
    branchOperationId: string,
  ) {
    const clonedTurnIds = new Map<string, string>();
    const turns = groupedTranscriptActions(actions);
    for (const turn of turns) {
      const user = turn.find((action) => action.type === 'turn');
      if (!user || user.type !== 'turn') continue;
      const sourceTurn = await this.store.readTurn(sourceConversationId, user.turnId);
      const parts = user.parts ? await this.hydrateBranchParts(user.parts) : undefined;
      const handle = await this.store.acceptTurn({
        operationId: derivedUuid(branchOperationId, `clone-operation:${user.turnId}`),
        conversationId,
        clientMessageId: derivedUuid(branchOperationId, `clone-message:${user.turnId}`),
        contextPlan: {
          version: 1,
          automaticDialogueTurns: DEFAULT_TURN_CONTEXT_DIALOGUE_TURNS,
          overrides: [],
        },
        modelId: sourceTurn.modelId,
        reasoning: sourceTurn.reasoning,
        text: user.text,
        ...(parts ? { parts } : {}),
      });
      clonedTurnIds.set(user.turnId, handle.turnId);
      const existing = (await this.store.readTranscriptActions(conversationId))
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
        await this.store.appendAssistantCheckpoint(handle, {
          textDelta: sourceText.slice(existingText.length),
          reasoningDelta: sourceReasoning.slice(existingReasoning.length),
        });
      }
      const existingCalls = new Set(existing.flatMap((action) =>
        action.type === 'tool-start' ? [action.callId] : []));
      for (const start of turn.filter((action) => action.type === 'tool-start')) {
        if (start.type !== 'tool-start' || existingCalls.has(start.callId)) continue;
        await this.store.recordToolStarted(handle, {
          callId: start.callId,
          name: start.name,
          args: start.args,
        });
        const end = turn.find((action) => action.type === 'tool-end' && action.callId === start.callId);
        if (end?.type === 'tool-end') {
          await this.store.recordToolFinished(handle, {
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
      await this.store.finishTurn(handle, {
        status: terminal.status === 'interrupted_by_restart' ? 'interrupted' : terminal.status,
        error: terminal.error,
        errorCode: terminal.errorCode,
        durationMs: terminal.durationMs,
      });
    }
    return clonedTurnIds;
  }

  private async hydrateBranchParts(parts: NonNullable<DurableTranscriptAction & { type: 'turn' }>['parts']) {
    const hydrated = [];
    for (const part of parts ?? []) {
      if (part.type !== 'image') {
        hydrated.push(part);
        continue;
      }
      const artifact = await this.store.readArtifact(part.artifactHash);
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

  private async ensureModelSession(
    conversationId: string,
    modelId: string,
    reasoning: MessageSendParams['reasoning'],
  ) {
    const current = this.resources.get<AgentRuntimeValue>(AGENT_RESOURCE_KEYS.runtime);
    if (
      this.conversationIdValue === conversationId &&
      this.sessionValue &&
      this.projectorValue &&
      current?.conversationId === conversationId
    ) {
      if (current.state === 'running' || current.state === 'interrupting') throw turnActiveFault(current);
      if (current.state === 'error' || this.sessionModelIdValue !== modelId) {
        const summary = await this.readConversationSummary(conversationId);
        await this.disposeConversation();
        return this.loadModelSession(summary, null, modelId, reasoning);
      }
      return current;
    }
    this.assertRuntimeSwitchAvailable(conversationId);
    const summary = await this.readConversationSummary(conversationId);
    return this.loadModelSession(summary, null, modelId, reasoning);
  }

  private async readConversationSummary(conversationId: string) {
    const [projection] = await this.store.readResourceProjections([conversationResourceKey(conversationId)]);
    if (!projection || projection.key === AGENT_RESOURCE_KEYS.conversationList) {
      throw new RpcFault(-32015, 'Conversation not found.');
    }
    return projection.value as ConversationSummary;
  }

  private assertTurnConfigurationAvailable(
    conversationId: string,
    modelId: string,
    reasoning: MessageSendParams['reasoning'],
  ) {
    const models = this.resources.get<ModelsValue>(AGENT_RESOURCE_KEYS.models);
    const model = models?.models.find(({ id }) => id === modelId);
    if (!model) {
      const data: AgentCommandErrorData = { kind: 'model_unavailable', conversationId, modelId };
      throw new RpcFault(-32020, 'The selected model is no longer available.', data);
    }
    if (!model.supportedReasoning.includes(reasoning)) {
      throw new RpcFault(-32602, 'The selected reasoning level is unavailable for the selected model.');
    }
  }

  private assertRuntimeSwitchAvailable(targetConversationId: string) {
    const current = this.resources.get<AgentRuntimeValue>(AGENT_RESOURCE_KEYS.runtime);
    if (current?.state !== 'running' && current?.state !== 'interrupting') return;
    if (current.conversationId === targetConversationId) throw turnActiveFault(current);
    throw activeRuntimeBusyFault(current);
  }

  private async loadModelSession(
    conversation: Pick<ConversationSummary, 'id' | 'cwd'>,
    operationId: string | null,
    requestedModelId: string,
    initialReasoning: MessageSendParams['reasoning'],
  ) {
    const current = this.resources.get<AgentRuntimeValue>(AGENT_RESOURCE_KEYS.runtime);
    if (
      this.conversationIdValue === conversation.id &&
      this.sessionValue &&
      this.projectorValue &&
      this.sessionModelIdValue === requestedModelId &&
      current?.conversationId === conversation.id
    ) return current;

    this.assertRuntimeSwitchAvailable(conversation.id);
    const auth = this.resources.get<AuthValue>(AGENT_RESOURCE_KEYS.auth);
    if (auth?.state !== 'signed-in') throw new RpcFault(-32011, 'Sign in before continuing a conversation.');
    const resumed = await this.store.resumeActiveTurn(conversation.id);
    const modelId = resumed?.modelId ?? requestedModelId;
    const reasoning = resumed?.reasoning ?? initialReasoning;
    const models = this.resources.get<ModelsValue>(AGENT_RESOURCE_KEYS.models);
    const model = models?.models.find(({ id }) => id === modelId);
    if (!model) {
      const data: AgentCommandErrorData = {
        kind: 'model_unavailable',
        conversationId: conversation.id,
        modelId,
      };
      throw new RpcFault(-32020, 'The selected model is no longer available.', data);
    }
    if (!model.supportedReasoning.includes(reasoning)) {
      throw new RpcFault(-32602, 'The selected reasoning level is unavailable for the selected model.');
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
    const loading = runtimeValue(conversation.id, modelId, 'loading');
    this.resources.set(AGENT_RESOURCE_KEYS.runtime, loading);
    try {
      const transcript = await this.store.readTranscriptProjection(conversation.id);
      if (!transcript) throw new Error(`Conversation ${conversation.id} does not exist.`);
      const projector = createReplayedTranscriptProjector({
        conversationId: conversation.id,
        actions: transcript.actions,
        basisSequence: transcript.basisSequence,
        live: true,
        invalidate: this.options.publishProjectorInvalidations,
      });
      const session = await this.provider.createSession({
        cwd,
        modelId,
        reasoning,
        onEvent: (event) => this.turns.applySessionEvent(conversation.id, event),
        durability: this.turns.durabilityHooks(conversation.id),
      });
      this.sessionValue = session;
      this.sessionModelIdValue = modelId;
      this.projectorValue = projector;
      this.conversationIdValue = conversation.id;
      this.conversationOperationId = operationId;
      if (resumed) this.turns.resume(resumed.rootHandle, resumed.handle);
      const loaded = resumed ? {
        ...loading,
        state: 'running' as const,
        activeTurnId: resumed.handle.turnId,
        activeTurnElapsedMs: 0,
      } : { ...loading, state: 'idle' as const };
      this.resources.set(AGENT_RESOURCE_KEYS.runtime, loaded);
      if (resumed) {
        void session.prompt({ text: resumed.prompt, reasoning: resumed.reasoning })
          .catch((error) => this.turns.completeTurn(conversation.id, false, safeMessage(error)))
          .catch((error) => this.turns.failDurability(conversation.id, error));
      }
      return loaded;
    } catch (error) {
      this.sessionValue = null;
      this.sessionModelIdValue = null;
      this.projectorValue = null;
      this.conversationIdValue = null;
      this.conversationOperationId = null;
      const message = `Unable to load conversation runtime: ${safeMessage(error)}`;
      this.resources.set(AGENT_RESOURCE_KEYS.runtime, { ...loading, state: 'error', error: message });
      const data: AgentCommandErrorData = { kind: 'runtime_hydration_failed', conversationId: conversation.id };
      throw new RpcFault(-32022, message, data);
    }
  }
}

function branchPrefix(
  actions: readonly DurableTranscriptProjectionAction[],
  params: MessageBranchParams,
  mode: 'edit' | 'fork',
) {
  if (mode === 'edit') {
    const target = actions.find((action) =>
      action.type === 'turn' && action.turnId === params.sourceTurnId && action.itemId === params.sourceMessageId);
    if (!target) throw new RpcFault(-32015, 'The message to edit was not found.');
    return actions.filter((action) => action.sequence < target.sequence);
  }
  const assistant = actions.find((action) =>
    action.type === 'assistant' && action.turnId === params.sourceTurnId && action.itemId === params.sourceMessageId);
  if (!assistant) throw new RpcFault(-32015, 'The response to fork was not found.');
  const terminal = actions.find((action) => action.type === 'terminal' && action.turnId === params.sourceTurnId);
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

async function canonicalDirectory(path: string) {
  try {
    const canonical = await realpath(path);
    if (!(await stat(canonical)).isDirectory()) throw new Error('not a directory');
    return canonical;
  } catch {
    throw new RpcFault(-32602, 'cwd must name an existing directory.');
  }
}

function isOperationConflict(error: unknown, operationId: string) {
  return error instanceof Error && error.name === 'OperationConflictError' &&
    'operationId' in error && error.operationId === operationId;
}

function isClientMessageConflict(error: unknown) {
  return error instanceof Error && error.name === 'ClientMessageConflictError';
}

function operationConflictFault(label: string, operationId: string) {
  return new RpcFault(-32018, `${label} conflicts with an earlier request.`, {
    kind: 'operation_conflict',
    operationId,
  });
}

function clientMessageConflictFault(clientMessageId: string) {
  return new RpcFault(-32017, 'clientMessageId was already used with different message content.', {
    kind: 'client_message_conflict',
    clientMessageId,
  } satisfies AgentCommandErrorData);
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
  const data: AgentCommandErrorData = { kind: 'active_runtime_busy', conversationId, turnId };
  return new RpcFault(-32019, 'Another conversation has an active turn.', data);
}

function turnActiveFault(runtime: AgentRuntimeValue) {
  const conversationId = runtime.conversationId;
  const turnId = runtime.activeTurnId;
  if (!conversationId || !turnId) return new RpcFault(-32603, 'The active runtime state is invalid.');
  const data: AgentCommandErrorData = { kind: 'turn_active', conversationId, turnId };
  return new RpcFault(-32013, 'A turn is already running in this conversation.', data);
}

function safeMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/Bearer\s+\S+/giu, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, '[redacted]')
    .slice(0, 1_000);
}
