import type { NativeTurnNotice } from '../../../shared/native-agent-protocol.ts';
import type { TurnOrigin, TurnTrigger } from '../../../shared/provider-runtime.ts';
import { createHash, randomUUID } from 'node:crypto';

import {
  NATIVE_AGENT_LIMITS,
  NATIVE_AGENT_PROTOCOL_VERSION,
  NATIVE_AGENT_RESOURCE_KEYS,
  parseAgentExecutionResourceKey,
  parseAgentExecutionTranscriptResourceKey,
  assertViewerSafeNativeResource,
  parseNativeAgentResourceReadParams,
  type AgentConversationResource,
  type AgentConversationVersionsResource,
  type AgentConversationsResource,
  type AgentExecutionResource,
  type AgentModelsResource,
  type AgentProvidersResource,
  type AgentQueueResource,
  type AgentRuntimeResource,
  type NativeAgentResourceKey,
  type NativeAgentResourceReadParams,
  type NativeAgentResourceReadResult,
  type NativeAgentResourceValue,
  type NativeAgentTurnFrame,
  type NativeAssistantPass,
  type NativeChildExecutionView,
  type NativeCompactionView,
  type NativeOrderedTurnBlock,
  type NativeOperationView,
  type ProviderLoginOperationView,
  type NativeTranscriptWindow,
} from '../../../shared/native-agent-protocol.ts';
import type {
  JsonValue,
  ProviderAccountUsage,
  ProviderEventEnvelope,
  ProviderModelDescriptor,
} from '../../../shared/provider-runtime.ts';
import {
  NativeAgentJournal,
  type LegacyJournalEvent,
  type JournalConversation,
  type JournalCompactionControlEvent,
  type JournalTurn,
  viewerCapabilities,
} from './native-journal.ts';
import { boundedUtf8Preview } from './native-output.ts';
import { ignoredWorkspacePaths } from '../providers/claude/workspace-file-changes.ts';

type RevisionEntry = { hash: string; revision: number };

// Leave room for the RPC result envelope and for another small resource in a
// batched read. The protocol's 8 MiB resource limit remains the final guard.
const NATIVE_TRANSCRIPT_RESOURCE_BUDGET_BYTES = NATIVE_AGENT_LIMITS.resourceBytes - (512 * 1024);

export class NativeAgentProjector {
  readonly serverGeneration = randomUUID();
  private readonly journal: NativeAgentJournal;
  private readonly now: () => number;
  private readonly modelsByInstance = new Map<string, readonly ProviderModelDescriptor[]>();
  private readonly loginByInstance = new Map<string, ProviderLoginOperationView>();
  private readonly revisions = new Map<NativeAgentResourceKey, RevisionEntry>();
  private readonly invalidatedKeys = new Set<NativeAgentResourceKey>();
  private readonly watchedFiles = new Map<string, { sequence: number; checkedAt: number; ignored: ReadonlySet<string> }>();
  private readonly pendingWatchedFiles = new Map<string, Promise<void>>();

  constructor(journal: NativeAgentJournal, now: () => number = Date.now) {
    this.journal = journal;
    this.now = now;
  }

  setModels(providerInstanceId: string, models: readonly ProviderModelDescriptor[]) {
    this.modelsByInstance.set(providerInstanceId, structuredClone(models));
  }

  listModels(providerInstanceId: string) {
    return structuredClone(this.modelsByInstance.get(providerInstanceId) ?? []);
  }

  setLoginOperation(providerInstanceId: string, operation?: ProviderLoginOperationView) {
    if (operation) this.loginByInstance.set(providerInstanceId, structuredClone(operation));
    else this.loginByInstance.delete(providerInstanceId);
  }

  hasModel(providerInstanceId: string, model: string) {
    return (this.modelsByInstance.get(providerInstanceId) ?? []).some(({ id }) => id === model);
  }

  resolveModel(providerInstanceId: string, requested?: string) {
    const models = this.modelsByInstance.get(providerInstanceId) ?? [];
    return (requested ? models.find(({ id }) => id === requested) : undefined)
      ?? models.find(({ isDefault }) => isDefault)
      ?? models[0];
  }

  resolveServiceTier(providerInstanceId: string, modelId: string, requested?: string | null) {
    const model = (this.modelsByInstance.get(providerInstanceId) ?? [])
      .find(({ id }) => id === modelId);
    const tiers = model?.serviceTiers ?? [];
    if (tiers.length === 0) return null;
    if (requested && tiers.some(({ id }) => id === requested)) return requested;
    if (tiers.some(({ id }) => id === 'default')) return 'default';
    if (model?.defaultServiceTier && tiers.some(({ id }) => id === model.defaultServiceTier)) {
      return model.defaultServiceTier;
    }
    return tiers[0]!.id;
  }

  runtimeResource(conversationId: string) {
    return this.runtime(conversationId);
  }

  providersResource() {
    return this.providers();
  }

  /** Filter historical watcher noise for the requested window without changing journal evidence. */
  async prepareWatchedFileChanges(unparsed: NativeAgentResourceReadParams) {
    const input = parseNativeAgentResourceReadParams(unparsed);
    const selected = new Map<string, JournalTurn>();
    for (const { key } of input.requests) {
      let turns: readonly JournalTurn[] = [];
      let window = 'tail-24';
      const direct = /^agent\/turn:([^:]+)/u.exec(key);
      const transcript = /^agent\/transcript:([^:]+)(?::(.+))?$/u.exec(key);
      const strand = /^agent\/strand-transcript:([^:]+):([^:]+):(.+)$/u.exec(key);
      const execution = parseAgentExecutionTranscriptResourceKey(key);
      if (direct) {
        const turn = this.journal.turn(direct[1]!);
        if (turn) selected.set(turn.turnId, turn);
        continue;
      } else if (transcript) {
        turns = this.journal.turns(transcript[1]!); window = transcript[2] ?? window;
      } else if (strand) {
        try { turns = this.journal.turnsForStrand(decodeURIComponent(strand[2]!)); }
        catch { continue; }
        window = strand[3]!;
      } else if (execution) {
        turns = this.journal.turnsForExecution(execution.executionId); window = execution.window;
      }
      const range = transcriptRange(turns, window);
      for (const turn of turns.slice(range.startIndex, range.endIndexExclusive)) selected.set(turn.turnId, turn);
    }
    // Serial batches avoid launching a Git process for every historical turn at once.
    for (const turn of selected.values()) {
      const pending = this.pendingWatchedFiles.get(turn.turnId);
      if (pending) { await pending; continue; }
      const task = this.checkWatchedFiles(turn);
      this.pendingWatchedFiles.set(turn.turnId, task);
      try { await task; } finally { this.pendingWatchedFiles.delete(turn.turnId); }
    }
  }

  private async checkWatchedFiles(turn: JournalTurn) {
    const execution = this.journal.execution(turn.executionId);
    const conversation = this.journal.conversation(turn.conversationId);
    if (!execution || !conversation) return;
    const sequence = Number(this.journal.database.prepare('SELECT max(sequence) AS sequence FROM events WHERE turn_id=?')
      .get(turn.turnId)?.sequence ?? 0);
    const cached = this.watchedFiles.get(turn.turnId);
    if (cached?.sequence === sequence && this.now() - cached.checkedAt < 30_000) return;
    const paths = (this.journal.database.prepare(`SELECT DISTINCT json_extract(envelope_json, '$.event.change.path') AS path
      FROM events WHERE turn_id=? AND native_kind='hook/file_changed' AND event_type='turn.file-changed'`)
      .all(turn.turnId) as { path: string }[]).map(({ path }) => path);
    const ignored = new Set<string>();
    for (let start = 0; start < paths.length; start += 512) {
      for (const path of await ignoredWorkspacePaths(conversation.cwd, paths.slice(start, start + 512))) ignored.add(path);
    }
    this.watchedFiles.delete(turn.turnId);
    this.watchedFiles.set(turn.turnId, { sequence, checkedAt: this.now(), ignored });
    while (this.watchedFiles.size > 128) this.watchedFiles.delete(this.watchedFiles.keys().next().value!);
    this.invalidate([`agent/turn:${turn.turnId}`, `agent/transcript:${turn.conversationId}:tail-24`,
      `agent/execution-transcript:${encodeURIComponent(turn.executionId)}:tail-24`]);
    for (const key of this.revisions.keys()) {
      if (key.startsWith(`agent/strand-transcript:${encodeURIComponent(turn.conversationId)}:`)) this.invalidatedKeys.add(key);
    }
  }

  read(unparsed: NativeAgentResourceReadParams): NativeAgentResourceReadResult {
    const input = parseNativeAgentResourceReadParams(unparsed);
    const capabilityRevision = this.capabilityRevision();
    const generationChanged = input.knownServerGeneration !== undefined
      && input.knownServerGeneration !== this.serverGeneration;
    const capabilitiesChanged = input.capabilityRevision !== undefined
      && input.capabilityRevision !== capabilityRevision;
    const changedKeys = new Set<NativeAgentResourceKey>();
    if (generationChanged) for (const request of input.requests) changedKeys.add(request.key);
    if (capabilitiesChanged) {
      changedKeys.add(NATIVE_AGENT_RESOURCE_KEYS.providers);
      for (const instance of this.journal.listProviderInstances()) {
        changedKeys.add(`agent/models:${instance.providerInstanceId}`);
      }
    }

    const resources = input.requests.map((request) => {
      const cachedRevision = this.revisions.get(request.key)?.revision;
      if (
        !generationChanged &&
        !this.invalidatedKeys.has(request.key) &&
        request.ifNoneMatch !== undefined &&
        request.ifNoneMatch === cachedRevision
      ) {
        return {
          key: request.key,
          status: 'notModified' as const,
          revision: cachedRevision,
          basisSequence: this.journal.latestSequence(),
        };
      }
      const value = this.project(request.key);
      if (value === undefined) return { key: request.key, status: 'missing' as const };
      assertViewerSafeNativeResource(value);
      const revision = this.revision(request.key, value);
      this.invalidatedKeys.delete(request.key);
      if (!generationChanged && request.ifNoneMatch === revision) {
        return {
          key: request.key,
          status: 'notModified' as const,
          revision,
          basisSequence: this.journal.latestSequence(),
        };
      }
      return {
        key: request.key,
        status: 'ok' as const,
        revision,
        basisSequence: this.journal.latestSequence(),
        value,
      };
    });
    return {
      protocolVersion: NATIVE_AGENT_PROTOCOL_VERSION,
      serverGeneration: this.serverGeneration,
      capabilityRevision,
      changedKeys: [...changedKeys],
      resources,
    };
  }

  invalidate(keys: readonly NativeAgentResourceKey[]) {
    for (const key of keys) {
      this.invalidatedKeys.add(key);
      if (/^agent\/turn:[^:]+$/u.test(key)) {
        for (const cachedKey of this.revisions.keys()) {
          if (cachedKey.startsWith(`${key}:`)) this.invalidatedKeys.add(cachedKey);
        }
      }
      const windowedTranscript = /^(agent\/(?:transcript|execution-transcript):[^:]+):/u.exec(key);
      if (!windowedTranscript) continue;
      const prefix = `${windowedTranscript[1]}:`;
      for (const cachedKey of this.revisions.keys()) {
        if (cachedKey.startsWith(prefix)) this.invalidatedKeys.add(cachedKey);
      }
    }
  }

  project(key: NativeAgentResourceKey): NativeAgentResourceValue | undefined {
    if (key === NATIVE_AGENT_RESOURCE_KEYS.providers) return this.providers();
    if (key === NATIVE_AGENT_RESOURCE_KEYS.conversations) return this.conversations();
    const executionTranscript = parseAgentExecutionTranscriptResourceKey(key);
    if (executionTranscript) {
      return this.executionTranscript(
        executionTranscript.executionId,
        executionTranscript.window,
      );
    }
    const executionId = parseAgentExecutionResourceKey(key);
    if (executionId) return this.execution(executionId);
    const strandTranscript = /^agent\/strand-transcript:([^:]+):([^:]+):(.+)$/u.exec(key);
    if (strandTranscript) {
      try {
        return this.strandTranscript(
          decodeURIComponent(strandTranscript[1]!),
          decodeURIComponent(strandTranscript[2]!),
          strandTranscript[3]!,
        );
      } catch {
        return undefined;
      }
    }
    const parsed = /^agent\/([^:]+):([^:]+)(?::(.+))?$/u.exec(key);
    if (!parsed) return undefined;
    const [, kind, id, window] = parsed;
    switch (kind) {
      case 'models':
        return this.models(id!);
      case 'conversation':
        return this.conversation(id!);
      case 'conversation-versions':
        return this.conversationVersions(id!);
      case 'runtime':
        return this.runtime(id!);
      case 'queue':
        return this.queue(id!);
      case 'turn':
        return this.turn(id!, window === 'summary');
      case 'transcript':
        return this.transcript(id!, window ?? 'tail-24');
      default:
        return undefined;
    }
  }

  private providers(): AgentProvidersResource {
    const instances = this.journal.listProviderInstances();
    const defaultPreference = this.journal.composerPreference('default-provider', 'default');
    const readyInstanceIds = new Set(instances
      .filter(({ probe }) => probe.state === 'ready')
      .map(({ providerInstanceId }) => providerInstanceId));
    return {
      providers: instances.map((instance) => {
        const sticky = this.repairStoredPreference(
          this.journal.composerPreference('provider', instance.providerInstanceId),
          true,
        );
        return ({
        providerInstanceId: instance.providerInstanceId,
        provider: instance.provider,
        label: instance.label,
        state: instance.probe.state,
        ...(instance.probe.message ? { message: instance.probe.message } : {}),
        capabilityRevision: instance.capabilityRevision,
        ...(instance.probe.capabilities
          ? { capabilities: viewerCapabilities(instance.probe.capabilities) }
          : {}),
        ...(this.loginByInstance.get(instance.providerInstanceId)
          ? { loginOperation: structuredClone(this.loginByInstance.get(instance.providerInstanceId)!) }
          : {}),
        ...(sticky?.model ? {
          stickyPreference: {
            model: sticky.model,
            effort: sticky.effort,
            serviceTier: sticky.serviceTier,
          },
        } : {}),
        accountUsage: instance.probe.state === 'ready'
          ? this.journal.providerAccountUsage(instance.providerInstanceId)
            ?? unknownAccountUsage(instance.updatedAt)
          : unknownAccountUsage(instance.updatedAt),
      });
      }),
      defaultProviderInstanceId: defaultPreference
        && readyInstanceIds.has(defaultPreference.providerInstanceId)
        ? defaultPreference.providerInstanceId
        : instances.find(({ probe }) => probe.state === 'ready')?.providerInstanceId ?? null,
      preferenceRevision: this.journal.composerPreferencesRevision(),
    };
  }

  private models(providerInstanceId: string): AgentModelsResource | undefined {
    const instance = this.journal.providerInstance(providerInstanceId);
    if (!instance) return undefined;
    const models = this.modelsByInstance.get(providerInstanceId) ?? [];
    return {
      providerInstanceId,
      models,
      defaultModelId: models.find(({ isDefault }) => isDefault)?.id ?? models[0]?.id ?? null,
      error: instance.probe.state === 'ready' ? null : instance.probe.message ?? 'Provider unavailable.',
    };
  }

  private conversations(): AgentConversationsResource {
    return { conversations: this.journal.conversations(), truncated: false };
  }

  private conversation(conversationId: string): AgentConversationResource | undefined {
    const conversation = this.journal.conversation(conversationId);
    if (!conversation) return undefined;
    const instance = this.journal.providerInstance(conversation.providerInstanceId);
    return {
      ...conversation,
      capabilityRevision: instance?.capabilityRevision ?? 'unavailable',
      turnCount: this.journal.turns(conversationId).length,
    };
  }

  private conversationVersions(conversationId: string): AgentConversationVersionsResource | undefined {
    const head = this.journal.conversationHead(conversationId);
    if (!head) return undefined;
    return {
      conversationId,
      headRevision: head.revision,
      versions: this.journal.conversationVersions(conversationId),
    };
  }

  private runtime(conversationId: string): AgentRuntimeResource | undefined {
    const conversation = this.journal.conversation(conversationId);
    if (!conversation) return undefined;
    const instance = this.journal.providerInstance(conversation.providerInstanceId);
    if (!instance?.probe.capabilities) return undefined;
    const capabilities = viewerCapabilities(instance.probe.capabilities);
    const lastUsed = this.journal.lastDispatchedTurn(conversationId);
    let conversationPreference = this.journal.composerPreference('conversation', conversationId);
    let providerPreference = this.journal.composerPreference('provider', conversation.providerInstanceId);
    providerPreference = this.repairStoredPreference(providerPreference, true);
    conversationPreference = this.repairStoredPreference(
      conversationPreference,
      capabilities.turns.changeModelOnExistingSession,
    );
    const resolved = this.resolveComposerConfiguration({
      conversation,
      conversationPreference,
      providerPreference,
      lastUsed,
      canChangeModel: capabilities.turns.changeModelOnExistingSession,
      canChangeEffort: capabilities.turns.changeEffortOnExistingSession,
    });
    const canChangeAccess = conversation.resumable &&
      conversation.state === 'idle' &&
      conversation.activeTurnId === null &&
      !this.journal.hasUnresolvedRootDelivery(conversationId) &&
      this.journal.queuedEntries(conversationId).length === 0 &&
      capabilities.session.resume &&
      capabilities.access.presets.length > 1;
    const usage = this.journal.latestUsage(conversationId) ?? emptyUsage();
    const activeTurn = conversation.activeTurnId
      ? this.journal.turn(conversation.activeTurnId)
      : undefined;
    const activeTurnElapsedMs = activeTurn?.startedAt === undefined
      ? null
      : Math.max(0, this.now() - activeTurn.startedAt);
    const activeChildren = this.journal.executionsForConversation(conversationId)
      .filter(({ ownership }) => ownership !== 'root')
      .filter(({ state }) => state === 'running' || state === 'recovering');
    const uncertain = this.journal.database.prepare(`SELECT attempt_id,kind,provider,recovery_payload_json,
      acceptance_evidence_json,transcript_gap FROM delivery_attempts WHERE conversation_id=? AND state='unknown'
      ORDER BY created_at LIMIT 1`).get(conversationId) as {
        attempt_id: string; kind: string; provider: string; recovery_payload_json: string;
        acceptance_evidence_json: string | null; transcript_gap: number;
      } | undefined;
    const stop = this.journal.stopLifecycle(conversationId);
    const rootExecutionId = conversation.rootExecutionId;
    const stoppedAgentIds = new Set(stop.targets
      .filter(({ state, execution_id }) => state !== 'terminal' && execution_id !== rootExecutionId)
      .map(({ execution_id }) => String(execution_id)));
    const stoppingAgentIds = new Set(stop.targets
      .filter(({ state, execution_id, error }) => state !== 'terminal' && !error && execution_id !== rootExecutionId)
      .map(({ execution_id }) => String(execution_id)));
    const stopErrorCount = new Set(stop.targets
      .filter(({ state, execution_id, error }) => state !== 'terminal' && Boolean(error) && execution_id !== rootExecutionId)
      .map(({ execution_id }) => String(execution_id))).size;
    const stopRequested = stop.intents.length > 0;
    const classifiedChildren = activeChildren.filter(({ executionId }) => !stoppedAgentIds.has(executionId));
    const checkingCount = classifiedChildren.filter(({ state, ownership, executionId }) =>
      state === 'recovering' || (ownership === 'native' && !this.journal.nativeChildHandle(executionId))).length;
    const runningCount = classifiedChildren.length - checkingCount;
    const rootStopError = stop.targets.find(({ state, execution_id, error }) =>
      state !== 'terminal' && Boolean(error) && execution_id === rootExecutionId)?.error;
    const reconciliationUnavailable = classifiedChildren.some(({ lifecycleError }) => Boolean(lifecycleError));
    return {
      conversationId,
      executionId: conversation.rootExecutionId,
      state: conversation.state,
      activeTurnId: conversation.activeTurnId,
      activeTurnElapsedMs,
      deliveryHeld: this.journal.hasUnresolvedRootDelivery(conversationId),
      ...(uncertain ? { uncertainDelivery: {
        attemptId: uncertain.attempt_id,
        content: JSON.parse(uncertain.recovery_payload_json).content ?? [],
        canAbandon: uncertain.provider === 'claude-code' && uncertain.kind !== 'manual-compact' &&
          !uncertain.acceptance_evidence_json && !uncertain.transcript_gap && activeChildren.length === 0 &&
          !this.journal.database.prepare('SELECT 1 FROM delivery_attempt_staging WHERE attempt_id=? LIMIT 1').get(uncertain.attempt_id),
      } } : {}),
      lifecycle: {
        state: stopErrorCount > 0 || typeof rootStopError === 'string' || reconciliationUnavailable
          ? 'unavailable' : stopRequested ? 'stopping' : checkingCount > 0
          ? (runningCount > 0 ? 'running' : 'checking')
          : runningCount > 0 ? 'running' : 'idle',
        runningCount,
        checkingCount,
        stoppingCount: stoppingAgentIds.size,
        stopErrorCount,
        stopRequested,
        ...(typeof rootStopError === 'string' ? { stopError: rootStopError } : {}),
      },
      history: conversation.history,
      provider: conversation.provider,
      providerInstanceId: conversation.providerInstanceId,
      activeConfiguration: {
        model: conversation.model,
        effort: conversation.effort ?? null,
        serviceTier: conversation.serviceTier ?? null,
        access: conversation.access,
      },
      composer: {
        revision: hashJson({
          conversationId,
          conversationPreference: conversationPreference?.revision ?? null,
          providerPreference: providerPreference?.revision ?? null,
          lastUsed: lastUsed
            ? [
                lastUsed.turnId,
                lastUsed.model,
                lastUsed.effort ?? null,
                lastUsed.serviceTier ?? null,
                lastUsed.startedAt,
              ]
            : null,
          models: this.modelsByInstance.get(conversation.providerInstanceId) ?? [],
          capabilities: [
            capabilities.turns.changeModelOnExistingSession,
            capabilities.turns.changeEffortOnExistingSession,
            canChangeAccess,
          ],
          access: conversation.access,
        }),
        providerInstanceId: conversation.providerInstanceId,
        nextTurn: {
          model: resolved.model,
          effort: resolved.effort,
          serviceTier: resolved.serviceTier,
          access: conversation.access,
          origin: resolved.origin,
        },
        lastUsed: lastUsed ? {
          turnId: lastUsed.turnId,
          model: lastUsed.model,
          effort: lastUsed.effort ?? null,
          serviceTier: lastUsed.serviceTier ?? null,
        } : null,
        editable: {
          model: capabilities.turns.changeModelOnExistingSession,
          effort: capabilities.turns.changeEffortOnExistingSession,
          serviceTier: Boolean(this.resolveModel(
            conversation.providerInstanceId,
            resolved.model,
          )?.serviceTiers?.length),
          access: canChangeAccess,
        },
      },
      capabilities,
      usage,
      compaction: this.journal.runtimeCompaction(
        conversationId,
        selectedCompactionPolicy(conversation.provider),
      ),
      ...(conversation.healthMessage ? { healthMessage: conversation.healthMessage } : {}),
    };
  }

  private resolveComposerConfiguration(input: {
    conversation: JournalConversation;
    conversationPreference?: { model: string | null; effort: string | null; serviceTier: string | null };
    providerPreference?: { model: string | null; effort: string | null; serviceTier: string | null };
    lastUsed: JournalTurn | null;
    canChangeModel: boolean;
    canChangeEffort: boolean;
  }) {
    const candidates = [
      input.conversationPreference?.model
        ? { ...input.conversationPreference, origin: 'conversation-explicit' as const }
        : null,
      input.lastUsed
        ? {
            model: input.lastUsed.model,
            effort: input.lastUsed.effort ?? null,
            serviceTier: input.lastUsed.serviceTier ?? null,
            origin: 'last-used' as const,
          }
        : null,
      input.providerPreference?.model
        ? { ...input.providerPreference, origin: 'provider-sticky' as const }
        : null,
    ];
    if (!input.canChangeModel) {
      const model = (this.modelsByInstance.get(input.conversation.providerInstanceId) ?? [])
        .find(({ id }) => id === input.conversation.model);
      const effortCandidate = input.canChangeEffort
        ? candidates.find((candidate) => candidate?.model === input.conversation.model)
        : null;
      return {
        model: input.conversation.model,
        effort: input.canChangeEffort
          ? repairEffort(model, effortCandidate?.effort ?? input.conversation.effort ?? null)
          : input.conversation.effort ?? null,
        serviceTier: this.resolveServiceTier(
          input.conversation.providerInstanceId,
          input.conversation.model,
          effortCandidate?.serviceTier ?? input.conversation.serviceTier,
        ),
        origin: effortCandidate?.origin ?? 'last-used' as const,
      };
    }
    for (const candidate of candidates) {
      if (!candidate) continue;
      const model = this.resolveModel(input.conversation.providerInstanceId, candidate.model ?? undefined);
      if (model?.id !== candidate.model) continue;
      return {
        model: model.id,
        effort: input.canChangeEffort
          ? repairEffort(model, candidate.effort)
          : input.conversation.effort ?? null,
        serviceTier: this.resolveServiceTier(
          input.conversation.providerInstanceId,
          model.id,
          candidate.serviceTier,
        ),
        origin: candidate.origin,
      };
    }
    const model = this.resolveModel(input.conversation.providerInstanceId);
    return {
      model: model?.id ?? input.conversation.model,
      effort: input.canChangeEffort
        ? repairEffort(model, null)
        : input.conversation.effort ?? null,
      serviceTier: this.resolveServiceTier(
        input.conversation.providerInstanceId,
        model?.id ?? input.conversation.model,
        null,
      ),
      origin: 'provider-default' as const,
    };
  }

  private repairStoredPreference(
    preference: ReturnType<NativeAgentJournal['composerPreference']>,
    canReplaceMissingModel: boolean,
  ) {
    if (!preference?.model) return preference;
    let model = this.resolveModel(preference.providerInstanceId, preference.model);
    if (model?.id !== preference.model) {
      if (!canReplaceMissingModel) return preference;
      model = this.resolveModel(preference.providerInstanceId);
    }
    if (!model) return preference;
    const effort = repairEffort(model, preference.effort);
    const serviceTier = this.resolveServiceTier(
      preference.providerInstanceId,
      model.id,
      preference.serviceTier,
    );
    if (model.id === preference.model && effort === preference.effort &&
        serviceTier === preference.serviceTier) return preference;
    return this.journal.setComposerPreference({
      scope: preference.scope,
      scopeId: preference.scopeId,
      providerInstanceId: preference.providerInstanceId,
      model: model.id,
      effort,
      serviceTier,
      now: Math.max(Date.now(), preference.updatedAt + 1),
    });
  }

  private queue(conversationId: string): AgentQueueResource | undefined {
    if (!this.journal.conversation(conversationId)) return undefined;
    return { conversationId, entries: this.journal.queuedEntries(conversationId) };
  }

  private transcript(conversationId: string, window: string): NativeTranscriptWindow | undefined {
    const conversation = this.journal.conversation(conversationId);
    if (!conversation) return undefined;
    const turns = this.journal.turns(conversationId);
    return this.transcriptWindow({
      conversationId,
      strandId: conversation.activeStrandId,
      executionId: conversation.rootExecutionId,
      activeTurnId: conversation.activeTurnId,
      turns,
      window,
    });
  }

  private strandTranscript(
    conversationId: string,
    strandId: string,
    window: string,
  ): NativeTranscriptWindow | undefined {
    const strand = this.journal.strand(strandId);
    if (!strand || strand.conversationId !== conversationId ||
        (strand.state !== 'ready' && strand.state !== 'orphaned')) return undefined;
    const turns = this.journal.turnsForStrand(strandId);
    return this.transcriptWindow({
      conversationId,
      strandId,
      executionId: strand.rootExecutionId,
      activeTurnId: null,
      turns,
      window,
    });
  }

  private executionTranscript(executionId: string, window: string) {
    const execution = this.journal.execution(executionId);
    if (!execution || !execution.transcriptAvailable) return undefined;
    const allTurns = this.journal.turnsForExecution(executionId);
    return this.transcriptWindow({
      conversationId: execution.conversationId,
      strandId: execution.strandId ?? `execution:${executionId}`,
      executionId,
      activeTurnId: allTurns.find(({ state }) => state === 'running' || state === 'recovering')?.turnId ?? null,
      turns: allTurns,
      window,
    });
  }

  /**
   * A requested turn-count is an upper bound, not permission to overflow the
   * browser RPC frame. Dense tool transcripts can be much larger than ordinary
   * chat turns, so retain the requested anchor/newest turns and expose the
   * omitted side through the normal hasEarlier/hasLater pagination flags.
   */
  private transcriptWindow(input: {
    conversationId: string;
    strandId: string;
    executionId: string;
    activeTurnId: string | null;
    turns: readonly JournalTurn[];
    window: string;
  }): NativeTranscriptWindow {
    const range = transcriptRange(input.turns, input.window);
    let startIndex = range.startIndex;
    let endIndexExclusive = range.endIndexExclusive;
    const compactions = this.journal.compactionControlEvents(input.conversationId, input.strandId);
    const projectedTurns = input.turns.slice(startIndex, endIndexExclusive).map((turn) => projectTurn(
      turn,
      this.journal.eventsForTurn(turn.turnId, { includeToolOutputPreviews: false }),
      this.journal.legacyEventsForTurn(turn.turnId),
      this.journal,
      this.modelsByInstance,
      boundaryCompactions(turn, input.turns, compactions),
      { includeToolOutputPreviews: false, ignoredWatchedPaths: this.watchedFiles.get(turn.turnId)?.ignored,
        compactionControls: compactions },
    ));
    const projectedTurnBytes = projectedTurns.map(jsonByteLength);
    let projectedTurnsByteLength = projectedTurnBytes.reduce((total, bytes) => total + bytes, 0);
    const createWindow = (
      turnFrames: readonly NativeAgentTurnFrame[] = projectedTurns,
    ): NativeTranscriptWindow => ({
      conversationId: input.conversationId,
      strandId: input.strandId,
      executionId: input.executionId,
      activeTurnId: input.activeTurnId,
      turnOrder: input.turns.map(({ turnId }) => turnId),
      turns: turnFrames,
      window: {
        startIndex,
        endIndexExclusive,
        hasEarlier: startIndex > 0,
        hasLater: endIndexExclusive < input.turns.length,
      },
    });
    const resourceByteLength = () =>
      jsonByteLength(createWindow([])) + projectedTurnsByteLength +
      Math.max(0, projectedTurns.length - 1);
    while (
      projectedTurns.length > 1 &&
      resourceByteLength() > NATIVE_TRANSCRIPT_RESOURCE_BUDGET_BYTES
    ) {
      if (trimTranscriptStart(input.turns, input.window, startIndex, endIndexExclusive)) {
        projectedTurns.shift();
        projectedTurnsByteLength -= projectedTurnBytes.shift() ?? 0;
        startIndex += 1;
      } else {
        projectedTurns.pop();
        projectedTurnsByteLength -= projectedTurnBytes.pop() ?? 0;
        endIndexExclusive -= 1;
      }
    }
    return createWindow();
  }

  private turn(turnId: string, summary = false) {
    const turn = this.journal.turn(turnId);
    if (!turn) return undefined;
    const pathTurns = turn.strandId
      ? this.journal.turnsForStrand(turn.strandId)
      : this.journal.turns(turn.conversationId);
    const compactions = this.journal.compactionControlEvents(turn.conversationId, turn.strandId);
    return projectTurn(
      turn,
      this.journal.eventsForTurn(turn.turnId, {
        includeToolOutputPreviews: !summary,
      }),
      this.journal.legacyEventsForTurn(turn.turnId),
      this.journal,
      this.modelsByInstance,
      boundaryCompactions(turn, pathTurns, compactions),
      { includeToolOutputPreviews: !summary, ignoredWatchedPaths: this.watchedFiles.get(turn.turnId)?.ignored,
        compactionControls: compactions },
    );
  }

  private execution(executionId: string): AgentExecutionResource | undefined {
    const execution = this.journal.execution(executionId);
    if (!execution) return undefined;
    const activeAssignmentTurnId = this.journal.turnsForExecution(executionId)
      .find(({ state }) => state === 'running' || state === 'recovering')?.turnId;
    const lifecycleState = execution.lifecycleError
      ? 'unavailable'
      : execution.state === 'recovering'
      ? 'checking'
      : execution.state === 'running' && execution.ownership === 'native' &&
          !this.journal.nativeChildHandle(executionId)
        ? 'unavailable'
        : execution.state === 'idle' ? 'completed' : execution.state;
    const stopTarget = this.journal.stopLifecycle(execution.conversationId).targets
      .filter(({ execution_id }) => execution_id === executionId)
      .at(-1);
    return {
      executionId,
      conversationId: execution.conversationId,
      parentExecutionId: execution.parentExecutionId,
      rootTurnId: execution.rootTurnId,
      ownership: execution.ownership,
      provider: execution.provider,
      providerInstanceId: execution.providerInstanceId,
      ...(execution.model ? { model: execution.model } : {}),
      ...(execution.effort ? { effort: execution.effort } : {}),
      ...(execution.access ? { access: execution.access } : {}),
      ...(execution.federationScheduling
        ? { federationScheduling: execution.federationScheduling }
        : {}),
      federationDepth: execution.federationDepth,
      ...(execution.title ? { title: execution.title } : {}),
      state: execution.state,
      ...(execution.outcome ? { outcome: execution.outcome } : {}),
      ...(execution.summary ? { summary: execution.summary } : {}),
      childExecutionIds: this.journal.childExecutions(executionId).map(({ executionId }) => executionId),
      transcriptAvailable: execution.transcriptAvailable,
      lifecycle: {
        state: stopTarget?.error ? 'unavailable'
          : stopTarget && stopTarget.state !== 'terminal' ? 'stopping' : lifecycleState,
        ...(activeAssignmentTurnId ? { activeAssignmentTurnId } : {}),
        ...(typeof stopTarget?.error === 'string'
          ? { stopError: stopTarget.error } : {}),
      },
      startedAt: execution.createdAt,
      ...(execution.completedAt === undefined ? {} : { completedAt: execution.completedAt }),
    };
  }

  private capabilityRevision() {
    return hashJson(this.journal.listProviderInstances().map((instance) => [
      instance.providerInstanceId,
      instance.capabilityRevision,
    ]));
  }

  private revision(key: NativeAgentResourceKey, value: NativeAgentResourceValue) {
    // Elapsed time is a read-time anchor that the viewer advances locally. It
    // must not make the runtime resource look semantically different on every
    // conditional read; activeTurnId/state still invalidate when work changes,
    // while null versus non-null captures whether a timing anchor is ready.
    const revisionValue = key.startsWith('agent/runtime:')
      ? {
          ...value,
          activeTurnElapsedMs:
            (value as AgentRuntimeResource).activeTurnElapsedMs === null ? null : 0,
        }
      : value;
    const hash = hashJson(revisionValue);
    const previous = this.revisions.get(key);
    if (previous?.hash === hash) return previous.revision;
    const revision = (previous?.revision ?? 0) + 1;
    this.revisions.set(key, { hash, revision });
    return revision;
  }
}

function selectedCompactionPolicy(provider: 'codex' | 'claude-code' | 'fixture') {
  return provider === 'codex' || provider === 'claude-code' ? 'native-auto' : 'manual';
}

function projectTurn(
  turn: JournalTurn,
  allEvents: readonly ProviderEventEnvelope[],
  allLegacyEvents: readonly LegacyJournalEvent[],
  journal: NativeAgentJournal,
  modelsByInstance: ReadonlyMap<string, readonly ProviderModelDescriptor[]>,
  boundary: NativeAgentTurnFrame['boundaryCompactions'],
  options: {
    includeToolOutputPreviews?: boolean;
    ignoredWatchedPaths?: ReadonlySet<string>;
    compactionControls?: readonly JournalCompactionControlEvent[];
  } = {},
): NativeAgentTurnFrame {
  const events = allEvents.filter((event) =>
    event.scope.kind === 'turn' && event.scope.turnId === turn.turnId);
  const legacyEvents = allLegacyEvents.filter((event) => event.turnId === turn.turnId);
  let userContent = turn.userContent;
  if (journal.execution(turn.executionId)?.ownership === 'native') {
    userContent = [];
    for (const envelope of events) {
      if (envelope.event.type === 'user.message') userContent = envelope.event.content;
    }
  }
  let completePasses = viewerSafePasses(journal.orderedPasses(turn.turnId, {
    includeToolOutputPreviews: options.includeToolOutputPreviews !== false,
  }));
  if (completePasses.length === 0 && legacyEvents.length > 0) {
    completePasses = projectLegacyPass(turn, legacyEvents);
  }
  const passes = options.includeToolOutputPreviews === false
    ? withoutToolOutputPreviews(completePasses)
    : completePasses;
  const compatibility = flattenCompatibilityActivity(passes);
  const usage = journal.latestUsage(turn.conversationId, turn.turnId) ?? undefined;
  let compacted = false;
  const fileChangesByPath = new Map<
    string,
    NativeAgentTurnFrame['activity']['fileChanges'][number]
  >();

  for (const envelope of events) {
    const event = envelope.event;
    switch (event.type) {
      case 'turn.file-changed':
        if (envelope.native.kind === 'hook/file_changed' && options.ignoredWatchedPaths?.has(event.change.path)) break;
        // A file may be revised more than once in a turn. Keep its final
        // display state and its latest causal block so it renders where the
        // provider actually performed the edit rather than in a turn footer.
        const previousChange = fileChangesByPath.get(event.change.path);
        fileChangesByPath.delete(event.change.path);
        fileChangesByPath.set(event.change.path, {
          ...previousChange,
          ...event.change,
          ...(!event.change.diffArtifactId && previousChange?.diffArtifactId
            ? { diffArtifactId: previousChange.diffArtifactId }
            : {}),
          ...(event.blockId ? { blockId: event.blockId } : {}),
        });
        break;
      case 'context.compaction.completed':
        compacted = true;
        break;
    }
  }
  const fileChanges = [...fileChangesByPath.values()];

  // Reconciled execution records fill status/summary if their event arrived
  // outside the currently loaded root event slice.
  const children = new Map(compatibility.children.map((child) => [child.executionId, child]));
  for (const execution of journal.childExecutions(turn.executionId)
    .filter(({ rootTurnId }) => rootTurnId === turn.turnId)) {
    const current = children.get(execution.executionId);
    children.set(execution.executionId, {
      ...current,
      executionId: execution.executionId,
      ownership: execution.ownership === 'root' ? 'native' : execution.ownership,
      provider: execution.provider,
      providerInstanceId: execution.providerInstanceId,
      ...(execution.model ? { model: execution.model } : {}),
      ...(execution.title ? { title: execution.title } : {}),
      state: execution.state,
      ...(execution.outcome ? { outcome: execution.outcome } : {}),
      ...(execution.summary ? { summary: execution.summary } : {}),
    });
  }

  const orderedBlocks = passes.flatMap(({ blocks }, passIndex) =>
    blocks.map((block, blockIndex) => ({ block, passIndex, blockIndex })));
  const lastWorkPosition = [...orderedBlocks].reverse().find(({ block }) =>
    block.kind !== 'compatibility-notice');
  const finalBlock = lastWorkPosition?.block.kind === 'final-message' &&
    lastWorkPosition.block.payload.kind === 'final-message' &&
    lastWorkPosition.block.payload.text.trim()
    ? lastWorkPosition.block
    : turn.outcome
      ? trailingFinalMessage(orderedBlocks.map(({ block }) => block))
      : undefined;
  const assistantText = finalBlock?.payload.kind === 'final-message'
    ? finalBlock.payload.text
    : '';
  const assistantPreview = boundedUtf8Preview(assistantText);
  const assistantArtifact = turn.assistantArtifactId
    ? journal.artifact(turn.assistantArtifactId)
    : undefined;
  const additionalInputs = journal.additionalTurnMessages(turn.turnId).map((input, inputOrdinal) => ({ ...input, inputOrdinal }));
  const additionalMessages = additionalInputs.filter(input => input.origin === 'user');
  const inputItems: NativeTurnNotice[] = [];
  if (turn.origin !== 'user') inputItems.push(projectContinuationNotice(journal, modelsByInstance, turn.conversationId,
    turn.clientMessageId, null, turn.origin, turn.trigger, turn.startedAt ?? turn.createdAt, undefined, turn.triggers));
  for (const input of additionalInputs) if (input.origin !== 'user') inputItems.push(projectContinuationNotice(
    journal, modelsByInstance, turn.conversationId, input.clientMessageId, input.afterBlockId, input.origin, input.trigger, input.createdAt, input.inputOrdinal, input.triggers));
  const compactionNotices = withinTurnCompactionNotices(turn, options.compactionControls ?? []);
  inputItems.push(...compactionNotices);
  if (compactionNotices.length) compacted = true;
  if (turn.origin !== 'user') userContent = [];
  const base = {
    origin: turn.origin,
    ...(turn.trigger ? { trigger: turn.trigger } : {}),
    ...(turn.triggers ? { triggers: turn.triggers } : {}),
    inputItems,
    additionalMessages,
    pathEntryId: turn.pathEntryId ?? `turn:${turn.turnId}`,
    strandId: turn.strandId ?? `execution:${turn.executionId}`,
    ordinal: turn.ordinal ?? 0,
    turnId: turn.turnId,
    clientMessageId: turn.clientMessageId,
    executionId: turn.executionId,
    state: projectTurnState(turn.state),
    ...(turn.outcome ? { outcome: turn.outcome } : {}),
    userContent,
    ordering: turn.ordering,
    passes,
    finalBlockId: finalBlock?.blockId ?? null,
    ...(boundary && (boundary.beforeUser.length > 0 || boundary.afterTurn.length > 0)
      ? { boundaryCompactions: boundary }
      : {}),
    activity: {
      reasoning: compatibility.reasoning,
      commentary: compatibility.commentary,
      operations: compatibility.operations,
      fileChanges,
      web: compatibility.web,
      children: [...children.values()],
      notices: compatibility.notices,
      compacted,
    },
    assistantText: assistantPreview.text,
    ...(assistantArtifact ? {
      assistantContent: {
        artifactId: assistantArtifact.artifactId,
        sha256: assistantArtifact.sha256,
        byteLength: assistantArtifact.byteLength,
        returnedBytes: assistantPreview.returnedBytes,
        nextOffset: assistantPreview.returnedBytes < assistantArtifact.byteLength
          ? assistantPreview.returnedBytes
          : null,
      },
    } : {}),
    ...(usage ? { usage } : {}),
    ...(turn.error ? { error: turn.error } : {}),
    ...(turn.startedAt === undefined ? {} : { startedAt: turn.startedAt }),
    ...(turn.completedAt === undefined ? {} : { completedAt: turn.completedAt }),
  };
  const renderRevision = hashJson(options.includeToolOutputPreviews === false
    ? { ...base, passes: completePasses }
    : base);
  const layoutRevision = hashJson({
    projection: 'agent-turn-layout-v1',
    inputItems,
    turnId: turn.turnId,
    state: projectTurnState(turn.state),
    userContent,
    workLayout: passes.map(({ passId, blocks }) => ({
      passId,
      blocks: blocks.flatMap((block) => block.blockId === finalBlock?.blockId
        ? []
        : [visibleBlockLayout(block)]),
    })),
    fileChanges,
    boundaryCompactions: boundary ?? null,
    additionalMessages,
    children: [...children.values()].map((child) => ({
      executionId: child.executionId,
      title: child.title ?? null,
      summary: child.summary ?? null,
      state: child.state,
    })),
    assistantText: assistantPreview.text,
    assistantContent: assistantArtifact ? {
      sha256: assistantArtifact.sha256,
      byteLength: assistantArtifact.byteLength,
      returnedBytes: assistantPreview.returnedBytes,
    } : null,
    error: turn.error ?? null,
    completedAt: turn.completedAt ?? null,
  });
  return { ...base, renderRevision, layoutRevision };
}

/**
 * Conversation controls are not turn events, so place each completed operation
 * against the surrounding strand turns without rewriting its canonical scope.
 * A trailing marker naturally moves in front of the next user message once that
 * turn exists, matching the native transcript chronology.
 */
/**
 * A finished turn's answer is the last message the provider wrote after its
 * work. Narration that preceded later tool calls is progress, not the answer;
 * an interrupted or failed turn that ended mid-work has no answer at all.
 */
function trailingFinalMessage(blocks: readonly NativeOrderedTurnBlock[]) {
  for (const block of [...blocks].reverse()) {
    if (block.kind === 'final-message') {
      if (block.payload.kind === 'final-message' && block.payload.text.trim()) return block;
      continue;
    }
    if (block.kind === 'tool' || block.kind === 'native-child' || block.kind === 'federated-child' ||
        block.kind === 'web') return undefined;
  }
  return undefined;
}

function boundaryCompactions(
  turn: JournalTurn,
  pathTurns: readonly JournalTurn[],
  events: readonly JournalCompactionControlEvent[],
): NativeAgentTurnFrame['boundaryCompactions'] {
  const turnIndex = pathTurns.findIndex(({ turnId }) => turnId === turn.turnId);
  if (turnIndex < 0) return { beforeUser: [], afterTurn: [] };
  const previousTurn = pathTurns[turnIndex - 1];
  const nextTurn = pathTurns[turnIndex + 1];
  const controls = latestBoundaryCompactions(events, turn.executionId);
  const structuralBefore = controls.filter(({ event }) =>
    event.strandId !== null && (event.nextTurnId === turn.turnId ||
      (event.nextTurnId === null && previousTurn !== undefined &&
        event.previousTurnId === previousTurn.turnId)));
  const structuralAfter = controls.filter(({ event }) =>
    event.strandId !== null && event.nextTurnId === null &&
      event.previousTurnId === turn.turnId && nextTurn === undefined);
  const legacy = controls.filter(({ event }) => event.strandId === null);
  return {
    beforeUser: [
      ...structuralBefore,
      ...legacy.filter((control) =>
        control.createdAt <= turn.createdAt &&
        (!previousTurn || control.createdAt > previousTurn.createdAt)),
    ].map(({ view }) => view),
    afterTurn: structuralAfter.map(({ view }) => view).concat(nextTurn
      ? []
      : legacy.filter((control) => control.createdAt > turn.createdAt).map(({ view }) => view)),
  };
}

/**
 * Compactions that happened inside a turn render as positioned notices after
 * the block that was in flight, so an hour-long turn shows where the provider
 * dropped its context instead of stacking dividers at the boundary.
 */
function withinTurnCompactionNotices(
  turn: JournalTurn,
  controls: readonly JournalCompactionControlEvent[],
): NativeTurnNotice[] {
  return mergeCompactionControls(controls)
    .filter(({ event }) => {
      const boundary = event.boundary;
      if (boundary.kind === 'within-turn') return boundary.turnId === turn.turnId;
      if (boundary.kind === 'native-unresolved') return turn.nativeTurnId !== undefined && boundary.nativeTurnId === turn.nativeTurnId;
      return false;
    })
    .map(({ event, createdAt, view }) => {
      return {
        type: 'notice' as const,
        clientMessageId: `compaction:${event.operationId}`,
        afterBlockId: event.boundary.kind === 'within-turn' ? event.boundary.afterBlockId ?? null : null,
        origin: 'compaction' as const,
        createdAt,
        text: compactionNoticeText(view),
      };
    });
}

function compactionNoticeText(view: NativeCompactionView) {
  if (view.state === 'failed') return 'Compaction failed';
  if (view.beforeTokens === null || view.afterTokens === null) return 'Compacted context';
  return `Compacted ${formatTokenCount(view.beforeTokens)} → ${formatTokenCount(view.afterTokens)} tokens`;
}

function formatTokenCount(tokens: number) {
  return tokens >= 1_000 ? `${Math.round(tokens / 1_000)}k` : String(tokens);
}

function latestBoundaryCompactions(
  events: readonly JournalCompactionControlEvent[],
  executionId: string,
): Array<{ event: JournalCompactionControlEvent; createdAt: number; view: NativeCompactionView }> {
  return mergeCompactionControls(events.filter((event) => event.boundary.kind === 'between-turns' &&
    !(event.strandId === null && event.executionId !== executionId)));
}

/** One entry per operation: earliest start, latest state. */
function mergeCompactionControls(
  events: readonly JournalCompactionControlEvent[],
): Array<{ event: JournalCompactionControlEvent; createdAt: number; view: NativeCompactionView }> {
  const latestByOperation = new Map<string, {
    event: JournalCompactionControlEvent;
    createdAt: number;
  }>();
  for (const event of events) {
    const current = latestByOperation.get(event.operationId);
    if (!current) {
      latestByOperation.set(event.operationId, { event, createdAt: event.createdAt });
      continue;
    }
    current.createdAt = Math.min(current.createdAt, event.createdAt);
    if (compactionStateRank(event.state) >= compactionStateRank(current.event.state)) {
      current.event = event;
    }
  }
  return [...latestByOperation.values()]
    .sort((left, right) => left.createdAt - right.createdAt ||
      left.event.operationId.localeCompare(right.event.operationId))
    .map(({ event, createdAt }) => ({
      event,
      createdAt,
      view: {
        operationId: event.operationId,
        trigger: event.trigger,
        state: event.state,
        beforeTokens: event.beforeTokens,
        afterTokens: event.afterTokens,
        ...(event.error ? { error: event.error } : {}),
        createdAt,
        ...(event.completedAt === undefined ? {} : { completedAt: event.completedAt }),
      },
    }));
}

function compactionStateRank(state: JournalCompactionControlEvent['state']) {
  return state === 'started' ? 0 : 1;
}

function visibleBlockLayout(block: NativeOrderedTurnBlock) {
  const payload = block.payload;
  switch (payload.kind) {
    case 'reasoning-summary':
      return {
        blockId: block.blockId,
        kind: payload.kind,
        text: payload.text,
        parts: payload.parts ?? null,
      };
    case 'commentary':
    case 'final-message':
      return { blockId: block.blockId, kind: payload.kind, text: payload.text };
    case 'compatibility-notice':
      return { blockId: block.blockId, kind: payload.kind, message: payload.message };
    case 'tool':
      return {
        blockId: block.blockId,
        kind: payload.kind,
        name: payload.tool.name,
        title: payload.tool.title ?? null,
        inputPreview: payload.inputPreview ?? null,
      };
    case 'native-child':
    case 'federated-child':
      return {
        blockId: block.blockId,
        kind: payload.kind,
        title: payload.child.title ?? null,
        summary: payload.summary ?? null,
        state: payload.executionState,
      };
    case 'web':
      return { blockId: block.blockId, kind: payload.kind, activity: payload.activity };
  }
}

function viewerSafePasses(passes: readonly NativeAssistantPass[]): NativeAssistantPass[] {
  return passes.map((pass) => ({
    ...pass,
    blocks: pass.blocks.map((block) => {
      if (block.payload.kind !== 'native-child' && block.payload.kind !== 'federated-child') {
        return block;
      }
      const { nativeSessionId: _privateNativeSessionId, ...child } = block.payload.child;
      return {
        ...block,
        payload: { ...block.payload, child },
      };
    }),
  }));
}

function withoutToolOutputPreviews(passes: readonly NativeAssistantPass[]): NativeAssistantPass[] {
  return passes.map((pass) => ({
    ...pass,
    blocks: pass.blocks.map((block) => {
      if (block.payload.kind !== 'tool') return block;
      const { outputPreview: _outputPreview, ...payload } = block.payload;
      return {
        ...block,
        payload: {
          ...payload,
          detailRef: payload.detailRef ?? block.blockId,
        },
      };
    }),
  }));
}

function flattenCompatibilityActivity(passes: readonly NativeAssistantPass[]) {
  let reasoning = '';
  let commentary = '';
  const operations: NativeOperationView[] = [];
  const web: NativeAgentTurnFrame['activity']['web'][number][] = [];
  const children: NativeChildExecutionView[] = [];
  const notices: Array<{ code: string; message: string }> = [];
  for (const block of passes.flatMap(({ blocks }) => blocks)) {
    switch (block.payload.kind) {
      case 'reasoning-summary':
        reasoning += block.payload.text;
        break;
      case 'commentary':
        commentary += block.payload.text;
        break;
      case 'tool':
        operations.push({
          eventId: block.blockId,
          tool: block.payload.tool,
          state: block.state === 'failed' ? 'failed'
            : block.state === 'completed' || block.state === 'interrupted' ? 'completed' : 'running',
          // The ordered block is the canonical payload. Compatibility
          // operations only need identity/state metadata; copying previews
          // here can nearly double a transcript containing command output.
          ...(block.payload.detailRef === undefined ? {} : { detailRef: block.payload.detailRef }),
          startedAt: block.startedAt ?? 0,
          ...(block.completedAt === null ? {} : { completedAt: block.completedAt }),
        });
        break;
      case 'web':
        web.push(block.payload.activity);
        break;
      case 'native-child':
      case 'federated-child':
        children.push({
          executionId: block.payload.child.executionId,
          ownership: block.payload.child.ownership,
          provider: block.payload.child.provider,
          ...(block.payload.child.providerInstanceId
            ? { providerInstanceId: block.payload.child.providerInstanceId }
            : {}),
          ...(block.payload.child.model ? { model: block.payload.child.model } : {}),
          ...(block.payload.child.title ? { title: block.payload.child.title } : {}),
          state: block.payload.executionState,
          ...(block.payload.outcome ? { outcome: block.payload.outcome } : {}),
          ...(block.payload.summary ? { summary: block.payload.summary } : {}),
        });
        break;
      case 'compatibility-notice':
        notices.push({ code: block.payload.code, message: block.payload.message });
        break;
    }
  }
  return { reasoning, commentary, operations, web, children, notices };
}

function projectLegacyPass(turn: JournalTurn, events: readonly LegacyJournalEvent[]): NativeAssistantPass[] {
  let reasoning = '';
  let commentary = '';
  let finalText = '';
  const toolBlocks = new Map<string, NativeOrderedTurnBlock>();
  const trailingBlocks: NativeOrderedTurnBlock[] = [];
  const start = events[0]?.observedAt ?? turn.createdAt;
  for (const envelope of events) {
    const event = envelope.event;
    switch (event.type) {
      case 'assistant.reasoning':
        reasoning = typeof event.summary === 'string'
          ? event.summary
          : `${reasoning}${typeof event.delta === 'string' ? event.delta : ''}`;
        break;
      case 'assistant.text': {
        const value = typeof event.text === 'string'
          ? event.text
          : typeof event.delta === 'string' ? event.delta : '';
        if (event.phase === 'commentary') commentary = typeof event.text === 'string'
          ? event.text
          : `${commentary}${value}`;
        else finalText = typeof event.text === 'string' ? event.text : `${finalText}${value}`;
        break;
      }
      case 'tool.started': {
        const tool = event.tool as NativeOperationView['tool'];
        if (!tool?.callId) break;
        toolBlocks.set(tool.callId, legacyBlock(
          turn,
          `legacy-tool-${tool.callId}`,
          toolBlocks.size,
          'tool',
          'running',
          {
            kind: 'tool',
            tool,
            ...(event.inputPreview === undefined ? {} : { inputPreview: event.inputPreview as JsonValue }),
          },
          envelope.observedAt,
          null,
        ));
        break;
      }
      case 'tool.updated': {
        if (typeof event.toolCallId !== 'string') break;
        const block = toolBlocks.get(event.toolCallId);
        if (!block || block.payload.kind !== 'tool') break;
        toolBlocks.set(event.toolCallId, {
          ...block,
          revision: block.revision + 1,
          payload: {
            ...block.payload,
            ...(event.outputPreview === undefined
              ? {}
              : { outputPreview: mergePreview(block.payload.outputPreview, event.outputPreview as JsonValue) }),
          },
        });
        break;
      }
      case 'tool.completed': {
        if (typeof event.toolCallId !== 'string') break;
        const block = toolBlocks.get(event.toolCallId);
        if (!block) break;
        toolBlocks.set(event.toolCallId, {
          ...block,
          revision: block.revision + 1,
          state: event.outcome === 'failed' ? 'failed' : 'completed',
          completedAt: envelope.observedAt,
        });
        break;
      }
      case 'web.activity':
        trailingBlocks.push(legacyBlock(
          turn,
          `legacy-web-${envelope.eventId}`,
          trailingBlocks.length,
          'web',
          'completed',
          { kind: 'web', activity: event.activity as NativeAgentTurnFrame['activity']['web'][number] },
          envelope.observedAt,
          envelope.observedAt,
        ));
        break;
      case 'compatibility.notice':
        trailingBlocks.push(legacyBlock(
          turn,
          `legacy-notice-${envelope.eventId}`,
          trailingBlocks.length,
          'compatibility-notice',
          'completed',
          { kind: 'compatibility-notice', code: String(event.code), message: String(event.message) },
          envelope.observedAt,
          envelope.observedAt,
        ));
        break;
    }
  }
  const passId = `legacy-pass-${turn.turnId}`;
  const blocks: NativeOrderedTurnBlock[] = [];
  const addText = (kind: 'reasoning-summary' | 'commentary' | 'final-message', text: string) => {
    if (!text) return;
    blocks.push(legacyBlock(
      turn,
      `legacy-${kind}-${turn.turnId}`,
      blocks.length,
      kind,
      'completed',
      kind === 'reasoning-summary' ? { kind, text, truncated: false } : { kind, text },
      start,
      turn.completedAt ?? events.at(-1)?.observedAt ?? start,
    ));
  };
  addText('reasoning-summary', reasoning);
  addText('commentary', commentary);
  for (const block of toolBlocks.values()) blocks.push({ ...block, ordinal: blocks.length });
  for (const block of trailingBlocks) blocks.push({ ...block, ordinal: blocks.length });
  addText('final-message', finalText);
  return [{
    passId,
    ordinal: 0,
    state: turn.state === 'completed' ? 'reconciled' : 'streaming',
    blocks: blocks.map((block) => ({ ...block, passId })),
  }];
}

function legacyBlock(
  turn: JournalTurn,
  blockId: string,
  ordinal: number,
  kind: NativeOrderedTurnBlock['kind'],
  state: NativeOrderedTurnBlock['state'],
  payload: NativeOrderedTurnBlock['payload'],
  startedAt: number | null,
  completedAt: number | null,
): NativeOrderedTurnBlock {
  return {
    blockId,
    passId: `legacy-pass-${turn.turnId}`,
    ordinal,
    kind,
    state,
    revision: 1,
    payload,
    startedAt,
    completedAt,
  };
}

function projectTurnState(state: JournalTurn['state']): NativeAgentTurnFrame['state'] {
  return state;
}

function transcriptRange(turns: readonly JournalTurn[], window: string) {
  const length = turns.length;
  const tail = /^tail-(\d+)$/u.exec(window);
  if (tail) {
    const count = Math.min(40, Math.max(1, Number(tail[1])));
    return { startIndex: Math.max(0, length - count), endIndexExclusive: length };
  }
  const around = /^around:([^:]+):(\d+):(\d+)$/u.exec(window);
  if (around) {
    const index = turns.findIndex(({ turnId }) => turnId === around[1]);
    if (index >= 0) {
      const before = Math.min(39, Number(around[2]));
      const after = Math.min(39, Number(around[3]));
      let startIndex = Math.max(0, index - before);
      let endIndexExclusive = Math.min(length, index + after + 1);
      if (endIndexExclusive - startIndex > 40) endIndexExclusive = startIndex + 40;
      return { startIndex, endIndexExclusive };
    }
  }
  const range = /^range:([^:]+):([^:]+)$/u.exec(window);
  if (range) {
    const first = turns.findIndex(({ turnId }) => turnId === range[1]);
    const last = turns.findIndex(({ turnId }) => turnId === range[2]);
    if (first >= 0 && last >= first) {
      return { startIndex: first, endIndexExclusive: Math.min(last + 1, first + 40) };
    }
  }
  const count = Math.min(40, Math.max(1, 24));
  return { startIndex: Math.max(0, length - count), endIndexExclusive: length };
}

function trimTranscriptStart(
  turns: readonly JournalTurn[],
  window: string,
  startIndex: number,
  endIndexExclusive: number,
) {
  if (window.startsWith('tail-')) return true;
  const around = /^around:([^:]+):\d+:\d+$/u.exec(window);
  if (around) {
    const anchorIndex = turns.findIndex(({ turnId }) => turnId === around[1]);
    if (anchorIndex >= startIndex && anchorIndex < endIndexExclusive) {
      if (startIndex === anchorIndex) return false;
      if (endIndexExclusive - 1 === anchorIndex) return true;
      return anchorIndex - startIndex >= endIndexExclusive - 1 - anchorIndex;
    }
  }
  return true;
}

function jsonByteLength(value: unknown) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function mergePreview(previous: JsonValue | undefined, next: JsonValue): JsonValue {
  const previousRecord = jsonRecord(previous);
  const nextRecord = jsonRecord(next);
  if (
    previousRecord && nextRecord &&
    typeof previousRecord.delta === 'string' && typeof nextRecord.delta === 'string'
  ) {
    return {
      ...previousRecord,
      delta: `${previousRecord.delta}${nextRecord.delta}`.slice(-32 * 1024),
    };
  }
  return next;
}

function jsonRecord(value: JsonValue | undefined) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as { readonly [key: string]: JsonValue }
    : null;
}

function repairEffort(model: ProviderModelDescriptor | undefined, requested: string | null) {
  if (!model || model.supportedEffort.length === 0) return null;
  if (requested && model.supportedEffort.includes(requested)) return requested;
  for (const fallback of ['high', 'medium', 'low', 'off']) {
    if (model.supportedEffort.includes(fallback)) return fallback;
  }
  return model.supportedEffort[0] ?? null;
}

function emptyUsage() {
  return {
    turn: null,
    cumulative: null,
    context: null,
    estimatedCost: null,
  } as const;
}

function unknownAccountUsage(observedAt: number): ProviderAccountUsage {
  return {
    availability: 'unknown',
    windows: [],
    source: 'provider-push',
    freshness: 'cached',
    observedAt,
  };
}

function hashJson(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function projectContinuationNotice(journal: NativeAgentJournal,
  modelsByInstance: ReadonlyMap<string, readonly ProviderModelDescriptor[]>, conversationId: string,
  clientMessageId: string, afterBlockId: string | null, origin: Exclude<TurnOrigin, 'user'>,
  trigger: TurnTrigger | undefined, continuedAt: number, inputOrdinal?: number,
  triggers?: readonly TurnTrigger[]): NativeTurnNotice {
  const sources = triggers?.length ? triggers : [trigger];
  const children = sources.map(source => {
    const child = source?.childExecutionId ? journal.execution(source.childExecutionId) : undefined;
    return child?.conversationId === conversationId ? child : undefined;
  });
  const titles = sources.map((source, index) => {
    const child = children[index];
    if (child?.ownership === 'federated') {
      return modelsByInstance.get(child.providerInstanceId)?.find(({ id }) => id === child.model)?.name
        ?? child.model ?? child.providerInstanceId ?? 'federated child';
    }
    return child?.title ?? (source?.kind === 'federation' ? 'federated child' : 'subagent');
  });
  const names = titles.length === 1 ? titles[0]
    : `${titles.slice(0, -1).join(', ')} and ${titles.at(-1)}`;
  const startedAt = children.flatMap(child => child ? [child.createdAt] : []);
  return { type: 'notice', clientMessageId, afterBlockId, origin, createdAt: continuedAt,
    ...(inputOrdinal === undefined ? {} : { inputOrdinal }), ...(trigger ? { trigger } : {}),
    ...(triggers ? { triggers } : {}),
    text: `Continued after ${names} finished`,
    ...(startedAt.length ? { elapsedMs: Math.max(0, continuedAt - Math.min(...startedAt)) } : {}) };
}
