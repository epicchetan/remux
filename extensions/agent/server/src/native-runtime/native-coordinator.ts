import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import {
  NATIVE_AGENT_RESOURCE_KEYS,
  agentExecutionResourceKey,
  agentExecutionTranscriptResourceKey,
  parseAgentExecutionTranscriptResourceKey,
  parseNativeAgentResourceReadParams,
  parseNativeBranchCommand,
  parseNativeCommandReadParams,
  parseNativeConversationCreateCommand,
  parseNativeConversationInterruptCommand,
  parseNativeConversationRenameCommand,
  parseNativeConversationArchiveSetCommand,
  parseNativeConversationStrandActivateCommand,
  parseNativeExecutionMutationCommand,
  parseNativeCompactConversationCommand,
  parseNativeComposerPreferenceSetCommand,
  parseNativeConversationAccessSetCommand,
  parseNativeMessageSendCommand,
  parseNativeProviderAuthMutationCommand,
  parseNativeProviderLoginStartCommand,
  parseNativeProviderPreferenceSetCommand,
  parseNativeTurnMutationCommand,
  type NativeAgentResourceKey,
  type NativeAgentResourceReadParams,
  type NativeBranchCommand,
  type NativeCommandReadParams,
  type NativeCommandReadResult,
  type NativeConversationCreateCommand,
  type NativeConversationInterruptCommand,
  type NativeConversationRenameCommand,
  type NativeConversationArchiveSetCommand,
  type NativeConversationStrandActivateCommand,
  type NativeExecutionMutationCommand,
  type NativeCompactConversationCommand,
  type NativeComposerPreferenceSetCommand,
  type NativeConversationAccessSetCommand,
  type NativeMessageSendCommand,
  type NativeProviderAuthMutationCommand,
  type NativeProviderLoginStartCommand,
  type NativeProviderPreferenceSetCommand,
  type NativeQueuedMessage,
  type ProviderLoginOperationView,
  type NativeTurnMutationCommand,
} from '../../../shared/native-agent-protocol.ts';
import {
  PROVIDER_RUNTIME_CONTRACT_VERSION,
  parseProviderEventEnvelope,
  type NativeSessionRef,
  type ProviderAccess,
  type ProviderAccountUsage,
  type ProviderCapabilities,
  type ProviderEvent,
  type ProviderEventEnvelope,
  type FileChangeDisplay,
  type ProviderKind,
  type ProviderModelDescriptor,
  type UserContentPart,
} from '../../../shared/provider-runtime.ts';
import type {
  ProviderAdapter,
  ProviderLoginOperation,
  ProviderSession,
  ProviderRuntimeView,
} from '../provider-adapter.ts';
import {
  NativeAgentJournal,
  type JournalConversation,
  type JournalExecution,
} from './native-journal.ts';
import { NativeAgentProjector } from './native-projector.ts';
import {
  NATIVE_ASSISTANT_PREVIEW_BYTES,
  boundedUtf8Preview,
  terminalAssistantText,
} from './native-output.ts';
import type { FederationTargetCatalogEntry } from '../federation/credential-registry.ts';
import { resolveCheckout, type CheckoutResolver } from './checkout-resolver.ts';
import { FederationCheckoutOwner, FederationCommandInProgressError,
  FederationCommandSettledError } from './federation-checkout-owner.ts';
import { DeliveryAttemptOwner } from './delivery-attempt-owner.ts';
import { requireLegacyAcceptance, type StagedProviderEnvelope } from './delivery-contract.ts';

export type NativeProviderRegistration = {
  providerInstanceId: string;
  provider: ProviderKind;
  label: string;
  adapter: ProviderAdapter;
};

export type NativeCoordinatorOptions = {
  journal: NativeAgentJournal;
  providers: readonly NativeProviderRegistration[];
  now?: () => number;
  onResourcesInvalidated?: (keys: readonly NativeAgentResourceKey[]) => void;
  onTerminalTurn?: (input: {
    conversationId: string;
    turnId: string;
    outcome: 'completed' | 'failed' | 'interrupted' | 'recovery_failed';
  }) => void;
  sealTurnOutput?: (input: { turnId: string; text: string }) => Promise<void>;
  sealFileDiff?: (input: { conversationId: string; executionId: string; turnId?: string; diff: string }) => Promise<{ artifactId: string }>;
  federationForSession?: (input: {
    conversationId: string;
    executionId: string;
    providerInstanceId: string;
  }) => Promise<{
    endpoint: string;
    authorizationHeader: string;
    bindNativeSession?: (nativeSession: NativeSessionRef) => void;
    touch?: () => void;
    revoke?: () => void;
  } | undefined>;
  onDiagnostic?: (event: NativeCoordinatorDiagnostic) => void;
  checkoutResolver?: CheckoutResolver;
};

export type NativeCoordinatorDiagnostic = {
  stage: string;
  durationMs: number;
  status: 'completed' | 'failed' | 'cancelled';
  providerInstanceId?: string;
  conversationId?: string;
  executionId?: string;
  eventCount?: number;
  eventId?: string;
  eventType?: string;
  nativeKind?: string;
  policy?: 'initial' | 'if-stale' | 'required-fresh';
  activeSessions: number;
  pendingHydrations: number;
  error?: string;
};

export type NativeConversationCreateResult = {
  accepted: true;
  conversationId: string;
};

export type NativeConversationBranchResult = NativeConversationCreateResult & {
  strandId: string;
  headRevision: number;
  turnId: string;
};

export type NativeMessageSendResult = {
  accepted: true;
  commandId: string;
  turnId: string;
  delivery: 'sent' | 'queued' | 'steered';
};

export type NativeCompactConversationResult = {
  accepted: true;
  operationId: string;
  delivery: 'sent' | 'queued';
};

export type NativeProviderLoginResult = {
  accepted: true;
  operationId: string;
};

export type FederatedSpawnInput = {
  commandId: string;
  parentConversationId: string;
  parentExecutionId: string;
  rootTurnId: string;
  targetProviderInstanceId: string;
  task: string;
  access: 'read-only' | 'workspace-write';
  model?: string;
  effort?: string;
  depth: number;
  scheduling: 'background' | 'foreground';
  attachments?: readonly Extract<UserContentPart, { type: 'image-artifact' }>[];
};

export type FederatedFollowUpInput = {
  commandId: string;
  executionId: string;
  message: string;
};

export type FederatedExecutionResult = {
  executionId: string;
  status: 'running' | 'completed' | 'failed' | 'interrupted';
  provider: ProviderKind;
  providerInstanceId: string;
  model?: string;
  summary?: string;
  turnId?: string;
  finalAnswer?:
    | { kind: 'inline'; text: string }
    | { kind: 'unavailable'; preview: string; error: string }
    | {
        kind: 'artifact';
        preview: string;
        artifact: {
          uri: string;
          mimeType: string;
          byteLength: number;
          sha256: string;
        };
      };
  changedFiles: readonly FileChangeDisplay[];
  changedFilesTruncated: number;
};

type ActiveProviderLogin = {
  operationId: string;
  mode: 'device-code' | 'browser';
  operation: ProviderLoginOperation;
  view: ProviderLoginOperationView;
  cancelRequested: boolean;
};

type HistoryHydrationJob = {
  conversationId: string;
  executionId: string;
  controller: AbortController;
  promise: Promise<void>;
  waiters: number;
  settled: boolean;
};

type HistorySyncPolicy = 'initial' | 'if-stale' | 'required-fresh';

const BASE_DEVELOPER_INSTRUCTIONS = [
  'Remux uses ordinary chat for all user interaction. Do not request a blocking approval form or structured multiple-choice input; explain what is needed in your response instead.',
  'Use the provider\'s native same-provider collaboration tools for same-provider subagents. Use Remux federation tools only when delegating to a different provider.',
];

const MAX_AUTOMATIC_STREAM_RECOVERIES = 3;
const MAX_PROVIDER_EVENT_BATCH = 64;
const PROVIDER_TEXT_CHECKPOINT_MS = 60;
const MAX_IDLE_PROVIDER_SESSIONS = 8;
const IDLE_PROVIDER_SESSION_TTL_MS = 10 * 60 * 1_000;
const IDLE_PROVIDER_SESSION_SWEEP_MS = 60 * 1_000;
const UNAVAILABLE_PROVIDER_REPROBE_INTERVAL_MS = 5_000;
const ACCOUNT_USAGE_REFRESH_INTERVAL_MS = 60_000;
const CONTEXT_REFRESH_INTERVAL_MS = 30_000;
const HISTORY_REVALIDATE_INTERVAL_MS = 30_000;
const REPEATED_STREAM_LOSS_MESSAGE =
  'Native provider event stream was lost repeatedly; the conversation is no longer resumable.';

export class NativeAgentCoordinator {
  readonly projector: NativeAgentProjector;

  private readonly journal: NativeAgentJournal;
  private readonly providers = new Map<string, NativeProviderRegistration>();
  private readonly sessions = new Map<string, ProviderSession>();
  private readonly openingSessions = new Map<string, Promise<ProviderSession>>();
  private readonly consumers = new Map<string, Promise<void>>();
  private readonly providerLogins = new Map<string, ActiveProviderLogin>();
  private readonly providerRefreshes = new Map<string, Promise<void>>();
  private readonly providerLastProbedAt = new Map<string, number>();
  private readonly accountUsageRefreshes = new Map<string, Promise<void>>();
  private readonly accountUsageLastRefreshedAt = new Map<string, number>();
  private readonly loginConsumers = new Set<Promise<void>>();
  private readonly dispatchingConversations = new Set<string>();
  private readonly pendingDispatchConversations = new Set<string>();
  private readonly deliveryOwner: DeliveryAttemptOwner;
  private readonly deliveryOwnerInstanceId = randomUUID();
  private readonly executionWaiters = new Map<string, Set<(result: FederatedExecutionResult) => void>>();
  private readonly federationBindings = new Map<string, { touch?: () => void; revoke?: () => void }>();
  private readonly hydrationJobs = new Map<string, HistoryHydrationJob>();
  private readonly sessionLastUsedAt = new Map<string, number>();
  private readonly contextLastRefreshedAt = new Map<string, number>();
  private readonly accessReconfigurations = new Set<string>();
  private readonly automaticRecoveryAttempts = new Map<string, number>();
  private readonly automaticRecoveryProbation = new Set<string>();
  private readonly stopJobs = new Map<string, Promise<void>>();
  private readonly childReconciliationJobs = new Map<string, Promise<void>>();
  private readonly stopReconcileAttempts = new Map<string, number>();
  private readonly stopReconcileTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly federationBlockRevision = new Map<string, number>();
  private readonly now: () => number;
  private readonly onResourcesInvalidated: NonNullable<NativeCoordinatorOptions['onResourcesInvalidated']>;
  private readonly onTerminalTurn: NonNullable<NativeCoordinatorOptions['onTerminalTurn']>;
  private readonly sealTurnOutput?: NativeCoordinatorOptions['sealTurnOutput'];
  private readonly sealFileDiff?: NativeCoordinatorOptions['sealFileDiff'];
  private readonly federationForSession?: NativeCoordinatorOptions['federationForSession'];
  private readonly onDiagnostic?: NativeCoordinatorOptions['onDiagnostic'];
  private readonly checkoutResolver: CheckoutResolver;
  private readonly checkoutOwner: FederationCheckoutOwner;
  private readonly sessionSweep: ReturnType<typeof setInterval>;
  private readonly queueSweep: ReturnType<typeof setInterval>;
  private initializePromise?: Promise<void>;
  private initialized = false;
  private checkoutReconciled = false;
  private closed = false;

  constructor(options: NativeCoordinatorOptions) {
    this.journal = options.journal;
    this.now = options.now ?? Date.now;
    this.projector = new NativeAgentProjector(options.journal, this.now);
    for (const provider of options.providers) {
      if (this.providers.has(provider.providerInstanceId)) {
        throw new Error(`Duplicate provider instance ${provider.providerInstanceId}.`);
      }
      this.providers.set(provider.providerInstanceId, provider);
    }
    this.onResourcesInvalidated = options.onResourcesInvalidated ?? (() => undefined);
    this.onTerminalTurn = options.onTerminalTurn ?? (() => undefined);
    this.sealTurnOutput = options.sealTurnOutput;
    this.sealFileDiff = options.sealFileDiff;
    this.federationForSession = options.federationForSession;
    this.onDiagnostic = options.onDiagnostic;
    this.checkoutResolver = options.checkoutResolver ?? resolveCheckout;
    this.checkoutOwner = new FederationCheckoutOwner(this.journal, this.checkoutResolver);
    this.deliveryOwner = new DeliveryAttemptOwner(this.journal, this.now, this.deliveryOwnerInstanceId);
    this.sessionSweep = setInterval(() => void this.evictIdleSessions(), IDLE_PROVIDER_SESSION_SWEEP_MS);
    this.sessionSweep.unref?.();
    this.queueSweep = setInterval(
      () => this.wakeDurableQueues(),
      UNAVAILABLE_PROVIDER_REPROBE_INTERVAL_MS,
    );
    this.queueSweep.unref?.();
  }

  initialize() {
    this.initializePromise ??= this.initializeOnce();
    return this.initializePromise;
  }

  private async initializeOnce() {
    this.assertOpen();
    const checkoutOwners = this.checkoutOwner.captureStartupOwners(this.now());
    this.deliveryOwner.recover();
    await this.recoverAcceptedDeliveryStages();
    const resolutions = new Map<string, Awaited<ReturnType<CheckoutResolver>>>();
    const uniqueCwds = [...new Set(checkoutOwners.map(({ cwd }) => cwd))];
    for (let offset = 0; offset < uniqueCwds.length; offset += 4) {
      const batch = uniqueCwds.slice(offset, offset + 4);
      const values = await Promise.all(batch.map((cwd) => this.checkoutResolver(cwd)));
      batch.forEach((cwd, index) => resolutions.set(cwd, values[index]!));
    }
    for (const owner of checkoutOwners) {
      const resolution = resolutions.get(owner.cwd);
      if (resolution?.state !== 'resolved') continue;
      this.checkoutOwner.scopeCapturedStartupOwner(owner, resolution.value.checkoutKey, this.now());
    }
    this.checkoutReconciled = true;
    this.journal.resetInterruptedHistoryLoads();
    this.journal.markPersistedUsageCached();
    this.journal.repairRecoveryFailuresWithLaterNativeTerminalEvents();
    this.journal.repairDuplicatedNativeImportsInStrands();
    await Promise.all([...this.providers.values()].map(async (registration) => {
      const probe = await this.measure(
        'provider.probe',
        { providerInstanceId: registration.providerInstanceId },
        () => registration.adapter.probe(registration.providerInstanceId),
      );
      this.providerLastProbedAt.set(registration.providerInstanceId, this.now());
      this.journal.upsertProviderInstance({
        providerInstanceId: registration.providerInstanceId,
        provider: registration.provider,
        label: registration.label,
        probe,
        now: this.now(),
      });
      if (probe.state === 'ready') {
        const models = await this.measure(
          'provider.models',
          { providerInstanceId: registration.providerInstanceId },
          () => registration.adapter.listModels(registration.providerInstanceId),
        ).catch(() => []);
        this.projector.setModels(registration.providerInstanceId, models);
        await this.discoverProviderHistory(registration, probe.capabilities);
      }
    }));
    await this.reconcileRootDeliveryAttempts();
    this.journal.markAmbiguousCommandsForRecovery(this.now());
    this.journal.markInterruptedQueueDispatchesDeliveryUnknown();
    this.journal.failInterruptedBranchOperations(this.now());
    for (const conversation of this.journal.conversationsWithoutRecoveryHandle()) {
      this.journal.failRecovery(
        conversation.conversationId,
        'Provider session creation was interrupted before its native resume identity was recorded.',
        this.now(),
      );
    }
    for (const execution of this.journal.federatedExecutionsWithoutRecoveryHandle()) {
      this.journal.failExecution(
        execution.executionId,
        'Provider session creation was interrupted before its native resume identity was recorded.',
        this.now(),
      );
      this.finalizeFederatedExecution(execution.executionId);
    }
    for (const execution of this.journal.federatedExecutionsWithoutInitialTurn()) {
      this.journal.failExecution(
        execution.executionId,
        'Federated spawn was interrupted before its accepted initial turn was recorded.',
        this.now(),
      );
      this.finalizeFederatedExecution(execution.executionId);
    }
    for (const conversation of this.journal.conversationsNeedingRecovery()) {
      await this.recoverConversation(conversation);
    }
    for (const execution of this.journal.federatedExecutionsNeedingRecovery()) {
      await this.recoverFederatedExecution(execution);
    }
    // Native children share their root provider session. Reconcile every
    // unfinished child after root recovery so missed terminal notifications do
    // not depend on opening the Agents view.
    const unresolvedNativeChildren = this.journal.executionsForAllConversations()
      .filter((execution) => execution.ownership === 'native' &&
        (execution.state === 'running' || execution.state === 'recovering' ||
          this.journal.turnsForExecution(execution.executionId).some((turn) =>
            turn.state === 'running' || turn.state === 'recovering')));
    for (let offset = 0; offset < unresolvedNativeChildren.length; offset += 4) {
      await Promise.allSettled(unresolvedNativeChildren.slice(offset, offset + 4)
        .map((execution) => this.synchronizeNativeChildHistory(execution.executionId)));
    }
    for (const intent of this.journal.outstandingStopIntents()) {
      if (typeof intent.intent_id === 'string') await this.processStopIntent(intent.intent_id);
    }
    // The durable queue is a server-owned command lane. A process may stop
    // after committing a follow-up but before its dispatch microtask runs, so
    // initialization must wake idle lanes without waiting for a viewer read or
    // another provider event.
    this.initialized = true;
    this.wakeDurableQueues();
    this.invalidateGlobal();
  }

  federationTargetCatalog(callerProvider: ProviderKind): readonly FederationTargetCatalogEntry[] {
    return this.journal.listProviderInstances()
      .filter((instance) => instance.provider !== callerProvider && instance.probe.state === 'ready')
      .map((instance) => ({
        providerInstanceId: instance.providerInstanceId,
        provider: instance.provider,
        label: instance.label,
        models: this.projector.listModels(instance.providerInstanceId)
          .map((model) => ({
            id: model.id,
            name: model.name,
            supportedEffort: [...model.supportedEffort],
            isDefault: model.isDefault === true,
          }))
          .sort((left, right) => left.id.localeCompare(right.id)),
      }))
      .sort((left, right) => left.providerInstanceId.localeCompare(right.providerInstanceId));
  }

  async readRuntimeStatuses(): Promise<{ runtimes: readonly ProviderRuntimeView[]; observedAt: number }> {
    const runtimes = await Promise.all([...this.providers.values()].map(async (registration) => {
      const instance = this.journal.providerInstance(registration.providerInstanceId);
      const readiness: ProviderRuntimeView['readiness'] = instance?.probe.state ?? 'error';
      const base = {
        provider: registration.provider,
        providerInstanceId: registration.providerInstanceId,
        label: registration.label,
        readiness,
        readinessMessage: instance?.probe.message ?? null,
      };
      if (!registration.adapter.readRuntimeStatus) {
        return {
          ...base,
          topology: 'fixture' as const,
          runtimeState: 'unknown' as const,
          configuredExecutable: null,
          resolvedExecutable: null,
          installedVersion: instance?.probe.capabilities?.providerVersion ?? null,
          runningVersion: null,
          adapterVersion: instance?.probe.capabilities?.adapterVersion ?? null,
          sdkVersion: null,
          restartRequired: false,
          activeSessions: 0,
          lastError: null,
        };
      }
      try {
        return {
          ...base,
          ...await registration.adapter.readRuntimeStatus(registration.providerInstanceId),
        };
      } catch (error) {
        return {
          ...base,
          topology: registration.provider === 'codex' ? 'shared-daemon' as const : 'session-process' as const,
          runtimeState: 'failed' as const,
          configuredExecutable: null,
          resolvedExecutable: null,
          installedVersion: instance?.probe.capabilities?.providerVersion ?? null,
          runningVersion: null,
          adapterVersion: instance?.probe.capabilities?.adapterVersion ?? null,
          sdkVersion: null,
          restartRequired: false,
          activeSessions: 0,
          lastError: safeMessage(error),
        };
      }
    }));
    return { runtimes, observedAt: this.now() };
  }

  prepareResourceRead(unparsed: NativeAgentResourceReadParams) {
    const input = parseNativeAgentResourceReadParams(unparsed);
    if (input.requests.some(({ key }) => key === NATIVE_AGENT_RESOURCE_KEYS.providers ||
      key.startsWith('agent/models:'))) {
      this.scheduleUnavailableProviderRefreshes();
    }
    if (input.visibility !== 'inactive' &&
        input.requests.some(({ key }) => key === NATIVE_AGENT_RESOURCE_KEYS.providers)) {
      this.scheduleAccountUsageRefreshes();
    }
  }

  async prepareTranscriptRead(
    unparsed: NativeAgentResourceReadParams,
    signal?: AbortSignal,
  ) {
    const input = parseNativeAgentResourceReadParams(unparsed);
    const conversationIds = new Set<string>();
    const executionIds = new Set<string>();
    for (const { key } of input.requests) {
      const transcript = /^agent\/transcript:([^:]+)/u.exec(key);
      if (transcript?.[1]) conversationIds.add(transcript[1]);
      const turn = /^agent\/turn:([^:]+)/u.exec(key);
      if (turn?.[1]) {
        const conversationId = this.journal.turn(turn[1])?.conversationId;
        if (conversationId) conversationIds.add(conversationId);
      }
      const execution = parseAgentExecutionTranscriptResourceKey(key);
      if (execution) {
        executionIds.add(execution.executionId);
        const conversationId = this.journal.execution(execution.executionId)?.conversationId;
        if (conversationId) conversationIds.add(conversationId);
      }
    }
    if (conversationIds.size === 0 && input.focusedConversationId) {
      conversationIds.add(input.focusedConversationId);
    }
    for (const conversationId of conversationIds) {
      const hasCachedTurns = this.journal.turns(conversationId).length > 0;
      if (input.historySync === 'force' || !hasCachedTurns) {
        await this.synchronizeConversationHistory(
          conversationId,
          input.historySync === 'force' ? 'required-fresh' : 'initial',
          signal,
        );
      } else {
        // Existing journal data is immediately renderable. Revalidate it in
        // the background so selecting a long native thread never blanks the
        // transcript while the provider snapshot is read.
        void this.synchronizeConversationHistory(conversationId, 'if-stale')
          .catch(() => undefined);
      }
      this.scheduleFocusedContextRefresh(conversationId);
    }
    for (const executionId of executionIds) {
      await this.synchronizeNativeChildHistory(executionId, signal);
    }
  }

  async createConversation(
    unparsed: NativeConversationCreateCommand,
  ): Promise<NativeConversationCreateResult> {
    this.assertOpen();
    const input = parseNativeConversationCreateCommand(unparsed);
    return this.journal.runAsyncCommand(input.commandId, 'conversation.create', input, () =>
      this.createConversationOwned(input));
  }

  readCommand(unparsed: NativeCommandReadParams): NativeCommandReadResult {
    this.assertOpen();
    const input = parseNativeCommandReadParams(unparsed);
    const receipt = this.journal.commandReceipt(input.commandId);
    if (!receipt) return { state: 'missing' };
    if (receipt.kind !== input.kind) {
      throw new Error(`Command ${input.commandId} is not a ${input.kind} command.`);
    }
    const base = { commandId: receipt.commandId, kind: input.kind };
    if (receipt.state === 'received' || receipt.state === 'dispatching') {
      return { ...base, state: receipt.state };
    }
    if (receipt.state === 'rejected' || receipt.state === 'recovery_failed') {
      return {
        ...base,
        state: receipt.state,
        ...(receipt.errorMessage ? { errorMessage: receipt.errorMessage } : {}),
      };
    }
    const result = receipt.result;
    if (!result || typeof result !== 'object' || Array.isArray(result) ||
        (result as { accepted?: unknown }).accepted !== true) {
      throw new Error(`Accepted ${input.kind} command ${input.commandId} has no valid public result.`);
    }
    if (input.kind === 'conversation.create') {
      const conversationId = (result as { conversationId?: unknown }).conversationId;
      if (typeof conversationId !== 'string' || !conversationId) {
        throw new Error(`Accepted conversation.create command ${input.commandId} has no conversation ID.`);
      }
      return { ...base, kind: input.kind, state: 'accepted', result: { accepted: true, conversationId } };
    }
    const send = result as { commandId?: unknown; turnId?: unknown; delivery?: unknown };
    if (typeof send.commandId !== 'string' || typeof send.turnId !== 'string' ||
        !['sent', 'queued', 'steered'].includes(String(send.delivery))) {
      throw new Error(`Accepted turn.send command ${input.commandId} has no valid public result.`);
    }
    return {
      ...base,
      kind: input.kind,
      state: 'accepted',
      result: {
        accepted: true,
        commandId: send.commandId,
        turnId: send.turnId,
        delivery: send.delivery as 'sent' | 'queued' | 'steered',
      },
    };
  }

  private async createConversationOwned(
    input: NativeConversationCreateCommand,
  ): Promise<NativeConversationCreateResult> {
    this.assertOpen();
    const replay = this.replay<NativeConversationCreateResult>(
      this.journal.claimCommand(input.commandId, 'conversation.create', input, this.now()).receipt,
    );
    if (replay) return replay;
    let registration: NativeProviderRegistration;
    let serviceTier: string | null;
    try {
      registration = this.requireReadyProvider(input.providerInstanceId);
      const capabilities = this.requireCapabilities(input.providerInstanceId);
      if (!capabilities.access.presets.includes(input.access)) {
        throw coordinatorError(
          'capability_unavailable',
          `Provider does not support ${input.access} access.`,
        );
      }
      const model = this.projector.resolveModel(input.providerInstanceId, input.model);
      if (!model || model.id !== input.model) throw new Error('Selected model is unavailable.');
      if (input.effort && !model.supportedEffort.includes(input.effort)) {
        throw new Error(`Effort ${input.effort} is unavailable for model ${input.model}.`);
      }
      serviceTier = this.projector.resolveServiceTier(
        input.providerInstanceId,
        model.id,
        input.serviceTier,
      );
      if (input.serviceTier !== undefined && serviceTier !== input.serviceTier) {
        throw new Error(`Service tier ${input.serviceTier ?? 'none'} is unavailable for model ${input.model}.`);
      }
    } catch (error) {
      this.journal.rejectCommand(input.commandId, safeMessage(error), this.now());
      throw error;
    }
    const conversationId = stableUuid(`conversation\0${input.commandId}`);
    const executionId = stableUuid(`root-execution\0${input.commandId}`);
    this.journal.transaction(() => {
      this.journal.createConversation({
        conversationId,
        rootExecutionId: executionId,
        provider: registration.provider,
        providerInstanceId: input.providerInstanceId,
        title: 'New chat',
        cwd: input.cwd,
        model: input.model,
        ...(input.effort ? { effort: input.effort } : {}),
        ...(serviceTier ? { serviceTier } : {}),
        access: input.access,
        now: this.now(),
      });
      this.journal.setComposerPreference({
        scope: 'conversation',
        scopeId: conversationId,
        providerInstanceId: input.providerInstanceId,
        model: input.model,
        effort: input.effort ?? null,
        serviceTier,
        now: this.now(),
      });
      this.journal.setComposerPreference({
        scope: 'provider',
        scopeId: input.providerInstanceId,
        providerInstanceId: input.providerInstanceId,
        model: input.model,
        effort: input.effort ?? null,
        serviceTier,
        now: this.now(),
      });
      this.journal.setComposerPreference({
        scope: 'default-provider',
        scopeId: 'default',
        providerInstanceId: input.providerInstanceId,
        model: null,
        effort: null,
        serviceTier: null,
        now: this.now(),
      });
      this.journal.markCommandDispatching(input.commandId, this.now());
    });
    try {
      await this.openAttachedSession(conversationId, executionId, () => this.openSession(
        this.journal.conversation(conversationId)!,
        registration,
        'create',
      ));
      const result = { accepted: true as const, conversationId };
      this.journal.acceptCommand(input.commandId, result, this.now());
      this.invalidateConversation(conversationId);
      return result;
    } catch (error) {
      const message = safeMessage(error);
      this.journal.rejectCommand(input.commandId, message, this.now());
      this.journal.failRecovery(conversationId, message, this.now());
      this.invalidateConversation(conversationId);
      throw error;
    }
  }

  async startProviderLogin(
    unparsed: NativeProviderLoginStartCommand,
  ): Promise<NativeProviderLoginResult> {
    this.assertOpen();
    const input = parseNativeProviderLoginStartCommand(unparsed);
    return this.journal.runAsyncCommand(input.commandId, 'provider.login.start', input, () =>
      this.startProviderLoginOwned(input));
  }

  private async startProviderLoginOwned(
    input: NativeProviderLoginStartCommand,
  ): Promise<NativeProviderLoginResult> {
    this.assertOpen();
    const claim = this.journal.claimCommand(input.commandId, 'provider.login.start', input, this.now());
    const replay = this.replay<NativeProviderLoginResult>(claim.receipt);
    if (replay) return replay;

    let registration: NativeProviderRegistration;
    try {
      registration = this.requireProvider(input.providerInstanceId);
      const instance = this.journal.providerInstance(input.providerInstanceId);
      const supportedMode = instance?.probe.capabilities?.authentication.login;
      if (instance?.probe.state !== 'signed-out') {
        throw new Error('Provider is not currently signed out.');
      }
      if (supportedMode === 'none' || supportedMode !== input.mode || !registration.adapter.startLogin) {
        throw new Error(`Provider does not support ${input.mode} native login.`);
      }
      if (this.providerLogins.has(input.providerInstanceId)) {
        throw new Error('Provider already has a login operation in progress.');
      }
    } catch (error) {
      this.journal.rejectCommand(input.commandId, safeMessage(error), this.now());
      throw error;
    }

    const operationId = stableUuid(`provider-login\0${input.commandId}`);
    const starting: ProviderLoginOperationView = {
      operationId,
      mode: input.mode,
      state: 'starting',
      startedAt: this.now(),
    };
    this.projector.setLoginOperation(input.providerInstanceId, starting);
    this.invalidateProvider(input.providerInstanceId);
    this.journal.markCommandDispatching(input.commandId, this.now());
    try {
      const operation = await registration.adapter.startLogin!({
        commandId: input.commandId,
        providerInstanceId: input.providerInstanceId,
        mode: input.mode,
      });
      const active: ActiveProviderLogin = {
        operationId,
        mode: input.mode,
        operation,
        view: starting,
        cancelRequested: false,
      };
      this.providerLogins.set(input.providerInstanceId, active);
      const result = { accepted: true as const, operationId };
      this.journal.acceptCommand(input.commandId, result, this.now());
      const consumer = this.consumeProviderLogin(input.providerInstanceId, active);
      this.loginConsumers.add(consumer);
      void consumer.finally(() => this.loginConsumers.delete(consumer));
      return result;
    } catch (error) {
      const failed: ProviderLoginOperationView = {
        ...starting,
        state: 'failed',
        error: safeMessage(error),
        completedAt: this.now(),
      };
      this.projector.setLoginOperation(input.providerInstanceId, failed);
      this.journal.rejectCommand(input.commandId, failed.error!, this.now());
      this.invalidateProvider(input.providerInstanceId);
      throw error;
    }
  }

  async cancelProviderLogin(unparsed: NativeProviderAuthMutationCommand) {
    this.assertOpen();
    const input = parseNativeProviderAuthMutationCommand(unparsed);
    return this.journal.runAsyncCommand(input.commandId, 'provider.login.cancel', input, () =>
      this.cancelProviderLoginOwned(input));
  }

  private async cancelProviderLoginOwned(input: NativeProviderAuthMutationCommand) {
    this.assertOpen();
    const claim = this.journal.claimCommand(input.commandId, 'provider.login.cancel', input, this.now());
    const replay = this.replay<{ accepted: true }>(claim.receipt);
    if (replay) return replay;
    const active = this.providerLogins.get(input.providerInstanceId);
    if (!active) {
      const error = new Error('Provider has no login operation in progress.');
      this.journal.rejectCommand(input.commandId, error.message, this.now());
      throw error;
    }
    active.cancelRequested = true;
    this.journal.markCommandDispatching(input.commandId, this.now());
    try {
      await active.operation.cancel();
      this.updateLoginView(input.providerInstanceId, active, {
        ...withoutLoginError(active.view),
        state: 'cancelled',
        completedAt: this.now(),
      });
      const result = { accepted: true as const };
      this.journal.acceptCommand(input.commandId, result, this.now());
      return result;
    } catch (error) {
      this.journal.rejectCommand(input.commandId, safeMessage(error), this.now());
      throw error;
    } finally {
      this.invalidateProvider(input.providerInstanceId);
    }
  }

  async logoutProvider(unparsed: NativeProviderAuthMutationCommand) {
    this.assertOpen();
    const input = parseNativeProviderAuthMutationCommand(unparsed);
    return this.journal.runAsyncCommand(input.commandId, 'provider.logout', input, () =>
      this.logoutProviderOwned(input));
  }

  private async logoutProviderOwned(input: NativeProviderAuthMutationCommand) {
    this.assertOpen();
    const claim = this.journal.claimCommand(input.commandId, 'provider.logout', input, this.now());
    const replay = this.replay<{ accepted: true }>(claim.receipt);
    if (replay) return replay;
    let registration: NativeProviderRegistration;
    try {
      registration = this.requireProvider(input.providerInstanceId);
      const capabilities = this.requireCapabilities(input.providerInstanceId);
      if (!capabilities.authentication.logout || !registration.adapter.logout) {
        throw new Error('Provider does not support native logout.');
      }
      if (this.providerLogins.has(input.providerInstanceId)) {
        throw new Error('Cancel the provider login operation before logging out.');
      }
      if (this.journal.conversations().some((conversation) =>
        conversation.providerInstanceId === input.providerInstanceId && conversation.activeTurnId)) {
        throw new Error('Interrupt or finish active provider turns before logging out.');
      }
    } catch (error) {
      this.journal.rejectCommand(input.commandId, safeMessage(error), this.now());
      throw error;
    }

    this.journal.markCommandDispatching(input.commandId, this.now());
    try {
      await this.closeProviderSessions(input.providerInstanceId);
      const result = await registration.adapter.logout!({
        commandId: input.commandId,
        providerInstanceId: input.providerInstanceId,
      });
      this.journal.acceptCommand(input.commandId, result, this.now());
      this.projector.setLoginOperation(input.providerInstanceId, undefined);
      await this.refreshProvider(registration);
      this.invalidateProvider(input.providerInstanceId);
      return result;
    } catch (error) {
      this.journal.rejectCommand(input.commandId, safeMessage(error), this.now());
      throw error;
    }
  }

  async sendMessage(unparsed: NativeMessageSendCommand): Promise<NativeMessageSendResult> {
    this.assertOpen();
    const input = parseNativeMessageSendCommand(unparsed);
    return this.journal.runAsyncCommand(input.commandId, 'turn.send', input, () =>
      this.sendMessageOwned(input));
  }

  private async sendMessageOwned(input: NativeMessageSendCommand): Promise<NativeMessageSendResult> {
    this.assertOpen();
    const claim = this.journal.claimCommand(input.commandId, 'turn.send', input, this.now());
    const replay = this.replay<NativeMessageSendResult>(claim.receipt);
    if (replay) return replay;
    let conversation: JournalConversation;
    let capabilities: ProviderCapabilities;
    let configurationRevisionBeforeSync: string | undefined;
    try {
      conversation = this.requireConversation(input.conversationId);
      if (this.accessReconfigurations.has(conversation.conversationId)) {
        throw coordinatorError(
          'configuration_conflict',
          'Conversation access is being updated; refresh and retry.',
        );
      }
      capabilities = this.requireCapabilities(conversation.providerInstanceId);
      configurationRevisionBeforeSync = this.projector.runtimeResource(
        conversation.conversationId,
      )?.composer.revision;
      await this.synchronizeConversationHistory(conversation.conversationId, 'required-fresh');
      conversation = this.requireConversation(input.conversationId);
    } catch (error) {
      this.journal.rejectCommand(input.commandId, safeMessage(error), this.now());
      throw error;
    }
    const runtime = this.projector.runtimeResource(conversation.conversationId);
    const model = input.model;
    const effort = input.effort ?? undefined;
    const serviceTier = input.serviceTier ?? runtime?.composer.nextTurn.serviceTier ?? null;
    try {
      if (!runtime) throw coordinatorError('session_unavailable', 'Conversation runtime is unavailable.');
      if (conversation.state === 'recovering') {
        throw coordinatorError(
          'session_unavailable',
          'Conversation is recovering its native provider session; retry after recovery completes.',
        );
      }
      if (!conversation.resumable) {
        throw coordinatorError('session_unavailable', 'Conversation has no resumable native provider session.');
      }
      if (input.providerInstanceId !== conversation.providerInstanceId) {
        throw coordinatorError('configuration_conflict', 'Submitted provider does not own this conversation.');
      }
      if (input.access !== conversation.access) {
        throw coordinatorError('configuration_conflict', 'Submitted access does not match this conversation.');
      }
      if (input.configurationRevision !== runtime.composer.revision &&
          input.configurationRevision !== configurationRevisionBeforeSync) {
        throw coordinatorError('configuration_conflict', 'Composer configuration changed; refresh and retry.');
      }
      if (model !== runtime.composer.nextTurn.model || input.effort !== runtime.composer.nextTurn.effort ||
          serviceTier !== runtime.composer.nextTurn.serviceTier) {
        throw coordinatorError(
          'configuration_conflict',
          'Submitted model, effort, or speed is no longer current.',
        );
      }
      if (!this.projector.hasModel(conversation.providerInstanceId, model)) {
        throw coordinatorError(
          'configuration_conflict',
          `Model ${model} is not available from ${conversation.providerInstanceId}.`,
        );
      }
      if (model !== conversation.model && !capabilities.turns.changeModelOnExistingSession) {
        throw coordinatorError(
          'capability_unavailable',
          'Provider does not support changing model on an existing session.',
        );
      }
      if (effort !== conversation.effort && !capabilities.turns.changeEffortOnExistingSession) {
        throw coordinatorError(
          'capability_unavailable',
          'Provider does not support changing effort on an existing session.',
        );
      }
      if (this.projector.resolveServiceTier(
        conversation.providerInstanceId,
        model,
        serviceTier,
      ) !== serviceTier) {
        throw coordinatorError('configuration_conflict', 'Submitted speed is unavailable for this model.');
      }
      this.assertContentCapabilities(input.content, capabilities);
      this.journal.assertImageContentMetadata(input.content);
      if (input.delivery === 'steer' &&
          (model !== runtime.activeConfiguration.model || input.effort !== runtime.activeConfiguration.effort ||
            serviceTier !== runtime.activeConfiguration.serviceTier)) {
        throw coordinatorError(
          'configuration_conflict',
          'Model, effort, or speed cannot change in a steering message.',
        );
      }
    } catch (error) {
      this.journal.rejectCommand(input.commandId, safeMessage(error), this.now());
      throw error;
    }
    const compaction = this.journal.latestCompactionOperation(conversation.conversationId);
    const compactionRunning = compaction?.state === 'running';
    const hasQueuedWork = this.journal.queuedEntries(conversation.conversationId).length > 0;
    const laneBusy = Boolean(conversation.activeTurnId) || compactionRunning || hasQueuedWork ||
      this.journal.hasUnresolvedRootDelivery(conversation.conversationId) ||
      this.journal.hasConversationQueuePause(conversation.conversationId);
    const shouldSteer = Boolean(conversation.activeTurnId) && input.delivery === 'steer';
    if (input.delivery === 'steer' && !conversation.activeTurnId) {
      const error = coordinatorError('conversation_busy', 'There is no active turn to steer.');
      this.journal.rejectCommand(input.commandId, error.message, this.now());
      throw error;
    }
    if (shouldSteer) {
      if (!capabilities.turns.steer) {
        const error = coordinatorError('capability_unavailable', 'Provider does not support native turn steering.');
        this.journal.rejectCommand(input.commandId, error.message, this.now());
        throw error;
      }
      return this.steer(input, conversation);
    }
    const turnId = stableUuid(`turn\0${input.commandId}`);
    const result: NativeMessageSendResult = {
      accepted: true,
      commandId: input.commandId,
      turnId,
      delivery: laneBusy ? 'queued' : 'sent',
    };
    // Immediate and follow-up messages cross the same atomic durability
    // boundary. The dispatcher may claim an idle lane right away, but the RPC
    // acknowledgment never depends on the WebView remaining connected.
    this.journal.transaction(() => {
      if (!this.journal.hasOutstandingConversationStop(conversation.conversationId)) {
        this.journal.clearSettledConversationQueuePause(conversation.conversationId, this.now());
      }
      this.journal.grantImageContent({
        scope: { conversationId: conversation.conversationId, executionId: conversation.rootExecutionId },
        content: input.content,
        provenance: 'viewer-queue',
        createdAt: this.now(),
      });
      this.journal.enqueueTurn({
        commandId: input.commandId,
        conversationId: conversation.conversationId,
        turnId,
        clientMessageId: input.clientMessageId,
        content: input.content,
        model,
        ...(effort ? { effort } : {}),
        ...(serviceTier ? { serviceTier } : {}),
        access: input.access,
        now: this.now(),
      });
      this.journal.acceptCommand(input.commandId, result, this.now());
    });
    this.invalidateConversation(conversation.conversationId);
    if (laneBusy) void this.dispatchNext(conversation.conversationId);
    else await this.dispatchNext(conversation.conversationId);
    return result;
  }

  async interruptTurn(unparsed: NativeTurnMutationCommand) {
    this.assertOpen();
    const input = parseNativeTurnMutationCommand(unparsed);
    return this.journal.runAsyncCommand(input.commandId, 'turn.interrupt', input, () =>
      this.interruptTurnOwned(input));
  }

  async interruptConversation(unparsed: NativeConversationInterruptCommand) {
    this.assertOpen();
    const input = parseNativeConversationInterruptCommand(unparsed);
    const current = this.requireConversation(input.conversationId);
    if (current.activeTurnId &&
        !this.requireCapabilities(current.providerInstanceId).turns.interrupt) {
      throw coordinatorError('capability_unavailable', 'Provider does not support native turn interruption.');
    }
    return this.journal.runAsyncCommand(input.commandId, 'conversation.interrupt', input, async () => {
      const claim = this.journal.claimCommand(input.commandId, 'conversation.interrupt', input, this.now());
      const replay = this.replay<{ accepted: true; intentId: string }>(claim.receipt);
      if (replay) return replay;
      const conversation = this.requireConversation(input.conversationId);
      const existing = this.journal.outstandingStopIntent(input.conversationId, null);
      const intentId = typeof existing?.intent_id === 'string'
        ? existing.intent_id : stableUuid(`conversation-stop\0${input.conversationId}\0${input.commandId}`);
      this.journal.transaction(() => {
        this.journal.createStopIntent({
          intentId,
          conversationId: input.conversationId,
          rootExecutionId: conversation.rootExecutionId,
          scopeExecutionId: null,
          queuePaused: true,
          now: this.now(),
        });
        if (!existing) this.captureStopTargets(intentId, conversation, null);
        this.journal.markCommandDispatching(input.commandId, this.now());
      });
      const result = { accepted: true as const, intentId };
      this.journal.acceptCommand(input.commandId, result, this.now());
      this.retryStopTargets(intentId);
      await this.processStopIntent(intentId);
      this.invalidateConversation(input.conversationId);
      return result;
    });
  }

  private captureStopTargets(
    intentId: string,
    conversation: JournalConversation,
    scopeExecutionId: string | null,
  ) {
    const executions = this.journal.executionsForConversation(conversation.conversationId);
    const byId = new Map(executions.map((execution) => [execution.executionId, execution]));
    const belongs = (execution: JournalExecution) => {
      if (!scopeExecutionId) return true;
      let candidate: JournalExecution | undefined = execution;
      const visited = new Set<string>();
      while (candidate && !visited.has(candidate.executionId)) {
        if (candidate.executionId === scopeExecutionId) return true;
        visited.add(candidate.executionId);
        candidate = candidate.parentExecutionId ? byId.get(candidate.parentExecutionId) : undefined;
      }
      return false;
    };
    for (const execution of executions.filter(belongs)) {
      const active = this.journal.turnsForExecution(execution.executionId)
        .filter(({ state }) => state === 'running' || state === 'recovering').at(-1);
      if (!active) continue;
      this.journal.addStopTarget({
        intentId,
        executionId: execution.executionId,
        assignmentTurnId: active.turnId,
        ...(active.nativeTurnId ? { nativeTurnId: active.nativeTurnId } : {}),
        now: this.now(),
      });
    }
  }

  private processStopIntent(intentId: string) {
    if (this.closed) return Promise.resolve();
    const existing = this.stopJobs.get(intentId);
    if (existing) return existing;
    const job = this.processStopIntentOwned(intentId).finally(() => {
      if (this.stopJobs.get(intentId) === job) this.stopJobs.delete(intentId);
      if (!this.closed) this.invalidateStopIntent(intentId);
    });
    this.stopJobs.set(intentId, job);
    return job;
  }

  private invalidateStopIntent(intentId: string) {
    const intent = this.journal.outstandingStopIntents().find(({ intent_id }) => intent_id === intentId);
    const targets = this.journal.stopTargets(intentId);
    const conversationId = typeof intent?.conversation_id === 'string' ? intent.conversation_id
      : targets.length ? this.journal.execution(String(targets[0]!.execution_id))?.conversationId : undefined;
    if (!conversationId) return;
    this.invalidateConversation(conversationId);
    for (const executionId of new Set(targets.map(({ execution_id }) => String(execution_id)))) {
      this.invalidateConversation(conversationId, executionId);
    }
  }

  private retryStopTargets(intentId: string) {
    for (const target of this.journal.stopTargets(intentId)) {
      if (!target.error && target.state !== 'failed') continue;
      const executionId = String(target.execution_id), turnId = String(target.assignment_turn_id);
      const key = `${intentId}\0${executionId}\0${turnId}`;
      this.stopReconcileAttempts.delete(key);
      this.journal.updateStopTarget(intentId, executionId, turnId,
        target.state === 'accepted' ? 'accepted' : 'pending', null, this.now());
    }
  }

  private async processStopIntentOwned(intentId: string) {
    const intent = this.journal.outstandingStopIntents().find(({ intent_id }) => intent_id === intentId);
    if (!intent || typeof intent.conversation_id !== 'string') return;
    const conversation = this.requireConversation(intent.conversation_id);
    if (this.journal.stopTargets(intentId).length === 0 && intent.queue_paused === 1) {
      this.captureStopTargets(intentId, conversation, null);
    }
    this.captureLateStopDescendants(intentId, conversation);
    const targets = this.journal.stopTargets(intentId);
    for (let offset = 0; offset < targets.length; offset += 4) {
      await Promise.allSettled(targets.slice(offset, offset + 4).map(async (target) => {
      const executionId = String(target.execution_id);
      const turnId = String(target.assignment_turn_id);
      const turn = this.journal.turn(turnId);
      if (!turn || turn.executionId !== executionId) {
        this.journal.updateStopTarget(intentId, executionId, turnId, 'failed',
          'Stop target assignment is unavailable.', this.now());
        return;
      }
      if (turn.outcome && turn.outcome !== 'recovery_failed') {
        this.journal.updateStopTarget(intentId, executionId, turnId, 'terminal', null, this.now());
        return;
      }
      if (target.state === 'accepted') {
        if (!target.error) this.scheduleStoppedTargetReconciliation(intentId, executionId, turnId);
        return;
      }
      if (target.state === 'failed') return;
      // A later assignment fences this old target. Its eventual terminal is
      // still observed, but Stop must never be redirected to the newer turn.
      const newerActive = this.journal.turnsForExecution(executionId).some((candidate) =>
        candidate.turnId !== turnId &&
        (candidate.state === 'running' || candidate.state === 'recovering'));
      if (newerActive) return;
      try {
        const execution = this.journal.execution(executionId);
        if (!execution) throw new Error('Stop target execution is unavailable.');
        if (execution.ownership === 'root') {
          const session = await this.ensureSession(conversation);
          await session.interrupt({
            commandId: stableUuid(`stop-target\0${intentId}\0${executionId}\0${turnId}\0${target.updated_at}`),
            turnId,
          });
        } else if (execution.ownership === 'federated') {
          await this.interruptFederatedExecution(
            stableUuid(`stop-target\0${intentId}\0${executionId}\0${turnId}\0${target.updated_at}`), executionId);
        } else {
          const handle = this.journal.nativeChildHandle(executionId);
          if (!handle) throw new Error('Native child handle is unavailable.');
          const session = await this.ensureSession(conversation);
          if (!session.interruptChild) throw new Error('Native child interruption is unavailable.');
          await session.interruptChild({
            commandId: stableUuid(`stop-target\0${intentId}\0${executionId}\0${turnId}\0${target.updated_at}`),
            childExecutionId: executionId,
            nativeSessionId: handle.nativeSessionId,
            ...(typeof target.native_turn_id === 'string'
              ? { expectedNativeTurnId: target.native_turn_id } : {}),
          });
        }
        this.journal.updateStopTarget(intentId, executionId, turnId, 'accepted', null, this.now());
        this.scheduleStoppedTargetReconciliation(intentId, executionId, turnId);
      } catch (error) {
        this.journal.updateStopTarget(
          intentId, executionId, turnId, 'failed', safeMessage(error), this.now(),
        );
      }
      }));
    }
    for (const target of this.journal.stopTargets(intentId)) {
      const turn = this.journal.turn(String(target.assignment_turn_id));
      if (turn?.outcome && turn.outcome !== 'recovery_failed') this.journal.updateStopTarget(intentId, String(target.execution_id),
        String(target.assignment_turn_id), 'terminal', null, this.now());
    }
    if (this.journal.stopTargets(intentId).length === 0 &&
        (this.dispatchingConversations.has(conversation.conversationId) ||
          this.journal.hasUnresolvedRootDelivery(conversation.conversationId))) return;
    this.journal.settleStopIntent(intentId, this.now());
  }

  private scheduleStoppedTargetReconciliation(intentId: string, executionId: string, turnId: string) {
    if (this.closed) return;
    const key = `${intentId}\0${executionId}\0${turnId}`;
    if (this.stopReconcileTimers.has(key)) return;
    const attempt = this.stopReconcileAttempts.get(key) ?? 0;
    if (attempt >= 4) {
      this.journal.updateStopTarget(intentId, executionId, turnId, 'accepted',
        'Stop was accepted, but terminal status could not be verified.', this.now());
      this.invalidateStopIntent(intentId);
      return;
    }
    this.stopReconcileAttempts.set(key, attempt + 1);
    const timer = setTimeout(() => void (async () => {
      this.stopReconcileTimers.delete(key);
      if (this.closed) return;
      try {
        const execution = this.journal.execution(executionId);
        if (!execution) throw new Error('Stop target execution is unavailable.');
        if (execution.ownership === 'native') await this.synchronizeNativeChildHistory(executionId);
        else await this.reconcile(execution.conversationId, executionId);
        await this.processStopIntent(intentId);
      } catch { /* the bounded retry retains visible uncertainty */ }
      if (this.closed) return;
      const target = this.journal.stopTargets(intentId).find((candidate) =>
        candidate.execution_id === executionId && candidate.assignment_turn_id === turnId);
      if (target && target.state !== 'terminal') {
        this.scheduleStoppedTargetReconciliation(intentId, executionId, turnId);
      } else {
        this.stopReconcileAttempts.delete(key);
      }
    })().catch(() => undefined), [250, 1_000, 3_000, 5_000][attempt]!);
    this.stopReconcileTimers.set(key, timer);
    timer.unref?.();
  }

  private captureLateStopDescendants(intentId: string, conversation: JournalConversation) {
    const targets = this.journal.stopTargets(intentId);
    const capturedAssignments = new Set(targets.map(({ assignment_turn_id }) => String(assignment_turn_id)));
    const capturedExecutions = new Set(targets.map(({ execution_id }) => String(execution_id)));
    let changed = true;
    while (changed) {
      changed = false;
      for (const execution of this.journal.executionsForConversation(conversation.conversationId)) {
        if (capturedExecutions.has(execution.executionId) || !execution.rootTurnId ||
            !capturedAssignments.has(execution.rootTurnId)) continue;
        const active = this.journal.turnsForExecution(execution.executionId)
          .filter(({ state }) => state === 'running' || state === 'recovering').at(-1);
        if (!active) continue;
        this.journal.addStopTarget({
          intentId, executionId: execution.executionId, assignmentTurnId: active.turnId,
          ...(active.nativeTurnId ? { nativeTurnId: active.nativeTurnId } : {}), now: this.now(),
        });
        capturedExecutions.add(execution.executionId);
        capturedAssignments.add(active.turnId);
        changed = true;
      }
    }
  }

  private async interruptTurnOwned(input: NativeTurnMutationCommand) {
    this.assertOpen();
    const claim = this.journal.claimCommand(input.commandId, 'turn.interrupt', input, this.now());
    const replay = this.replay<{ accepted: true }>(claim.receipt);
    if (replay) return replay;
    try {
      const conversation = this.requireConversation(input.conversationId);
      if (conversation.activeTurnId !== input.turnId) throw new Error('Turn is not active.');
      if (!this.requireCapabilities(conversation.providerInstanceId).turns.interrupt) {
        throw coordinatorError('capability_unavailable', 'Provider does not support native turn interruption.');
      }
      const existing = this.journal.outstandingStopIntent(input.conversationId, null);
      const intentId = typeof existing?.intent_id === 'string' ? existing.intent_id
        : stableUuid(`turn-stop\0${input.conversationId}\0${input.turnId}\0${input.commandId}`);
      this.journal.transaction(() => {
        this.journal.createStopIntent({ intentId, conversationId: input.conversationId,
          rootExecutionId: conversation.rootExecutionId, scopeExecutionId: null,
          queuePaused: true, now: this.now() });
        if (!existing) this.captureStopTargets(intentId, conversation, null);
        this.journal.markCommandDispatching(input.commandId, this.now());
      });
      const result = { accepted: true as const };
      this.journal.acceptCommand(input.commandId, result, this.now());
      this.retryStopTargets(intentId);
      await this.processStopIntent(intentId);
      return result;
    } catch (error) {
      this.journal.rejectCommand(input.commandId, safeMessage(error), this.now());
      throw error;
    }
  }

  async interruptExecution(unparsed: NativeExecutionMutationCommand) {
    this.assertOpen();
    const input = parseNativeExecutionMutationCommand(unparsed);
    const execution = this.journal.execution(input.executionId);
    if (!execution || execution.conversationId !== input.conversationId || execution.ownership === 'root') {
      throw new Error('Child execution does not exist in this conversation.');
    }
    return this.journal.runAsyncCommand(input.commandId, 'execution.interrupt', input, () =>
      this.interruptExecutionOwned(input, execution));
  }

  private async interruptExecutionOwned(
    input: NativeExecutionMutationCommand,
    execution: NonNullable<ReturnType<NativeAgentJournal['execution']>>,
  ) {
    const claim = this.journal.claimCommand(input.commandId, 'execution.interrupt', input, this.now());
    const replay = this.replay<{ accepted: true }>(claim.receipt);
    if (replay) return replay;
    try {
      if (execution.state !== 'running' && execution.state !== 'recovering') {
        throw new Error('Child execution is not running.');
      }
      const conversation = this.requireConversation(input.conversationId);
      const existing = this.journal.outstandingStopIntent(input.conversationId, execution.executionId);
      const intentId = typeof existing?.intent_id === 'string'
        ? existing.intent_id
        : stableUuid(`execution-stop\0${input.conversationId}\0${execution.executionId}\0${input.commandId}`);
      this.journal.transaction(() => {
        this.journal.createStopIntent({
          intentId,
          conversationId: input.conversationId,
          rootExecutionId: conversation.rootExecutionId,
          scopeExecutionId: execution.executionId,
          queuePaused: false,
          now: this.now(),
        });
        if (!existing) this.captureStopTargets(intentId, conversation, execution.executionId);
        this.journal.markCommandDispatching(input.commandId, this.now());
      });
      const result = { accepted: true as const };
      this.journal.acceptCommand(input.commandId, result, this.now());
      this.retryStopTargets(intentId);
      await this.processStopIntent(intentId);
      this.invalidateConversation(input.conversationId, conversation.rootExecutionId);
      return result;
    } catch (error) {
      this.journal.rejectCommand(input.commandId, safeMessage(error), this.now());
      throw error;
    }
  }

  removeQueuedMessage(unparsed: NativeTurnMutationCommand) {
    this.assertOpen();
    const input = parseNativeTurnMutationCommand(unparsed);
    const claim = this.journal.claimCommand(input.commandId, 'queue.remove', input, this.now());
    const replay = this.replay<{ accepted: true; removed: boolean }>(claim.receipt);
    if (replay) return replay;
    const result = this.journal.transaction(() => {
      const removed = this.journal.removeQueuedTurnById(input.conversationId, input.turnId, this.now())
        || this.journal.removeQueuedCompaction(input.conversationId, input.turnId, this.now());
      const accepted = { accepted: true as const, removed };
      this.journal.acceptCommand(input.commandId, accepted, this.now());
      return accepted;
    });
    this.invalidateConversation(input.conversationId);
    void this.dispatchNext(input.conversationId);
    return result;
  }

  renameConversation(unparsed: NativeConversationRenameCommand) {
    this.assertOpen();
    const input = parseNativeConversationRenameCommand(unparsed);
    const claim = this.journal.claimCommand(input.commandId, 'conversation.rename', input, this.now());
    const replay = this.replay<{ accepted: true; metadataRevision: number }>(claim.receipt);
    if (replay) return replay;
    try {
      let result!: { accepted: true; metadataRevision: number };
      this.journal.transaction(() => {
        const updated = this.journal.renameConversation(
          input.conversationId,
          input.expectedMetadataRevision,
          input.title,
          this.now(),
        );
        result = { accepted: true, metadataRevision: updated.metadataRevision };
        this.journal.acceptCommand(input.commandId, result, this.now());
      });
      this.invalidateConversation(input.conversationId);
      return result;
    } catch (error) {
      this.journal.rejectCommand(input.commandId, safeMessage(error), this.now());
      throw error;
    }
  }

  setConversationArchived(unparsed: NativeConversationArchiveSetCommand) {
    this.assertOpen();
    const input = parseNativeConversationArchiveSetCommand(unparsed);
    const claim = this.journal.claimCommand(input.commandId, 'conversation.archive.set', input, this.now());
    const replay = this.replay<{ accepted: true }>(claim.receipt);
    if (replay) return replay;
    try {
      const result = { accepted: true as const };
      this.journal.transaction(() => {
        this.journal.setConversationArchived(
          input.conversationId,
          input.expectedMetadataRevision,
          input.archived,
          this.now(),
        );
        this.journal.acceptCommand(input.commandId, result, this.now());
      });
      this.invalidateConversation(input.conversationId);
      return result;
    } catch (error) {
      this.journal.rejectCommand(input.commandId, safeMessage(error), this.now());
      throw error;
    }
  }

  async activateConversationStrand(unparsed: NativeConversationStrandActivateCommand) {
    this.assertOpen();
    const input = parseNativeConversationStrandActivateCommand(unparsed);
    return this.journal.runAsyncCommand(input.commandId, 'conversation.strand.activate', input, () =>
      this.activateConversationStrandOwned(input));
  }

  private async activateConversationStrandOwned(input: NativeConversationStrandActivateCommand) {
    this.assertOpen();
    const claim = this.journal.claimCommand(input.commandId, 'conversation.strand.activate', input, this.now());
    const replay = this.replay<{ accepted: true; strandId: string; headRevision: number }>(claim.receipt);
    if (replay) return replay;
    const destinationStrandId = stableUuid(`restored-strand\0${input.commandId}`);
    const executionId = stableUuid(`restored-execution\0${input.commandId}`);
    const branchOperationId = stableUuid(`restore-operation\0${input.commandId}`);
    let branchOperationCreated = false;
    try {
      const conversation = this.requireConversation(input.conversationId);
      this.assertRootDeliveryAvailable(conversation.conversationId);
      const head = this.journal.conversationHead(input.conversationId);
      if (!head || head.revision !== input.expectedHeadRevision) {
        throw coordinatorError('configuration_conflict', 'Conversation history changed; refresh and retry.');
      }
      if (head.strandId === input.strandId) {
        const result = { accepted: true as const, strandId: head.strandId, headRevision: head.revision };
        this.journal.acceptCommand(input.commandId, result, this.now());
        return result;
      }
      if (conversation.state !== 'idle' || conversation.activeTurnId ||
          this.journal.queuedEntries(conversation.conversationId).length > 0) {
        throw coordinatorError('configuration_conflict', 'Wait for the conversation to become idle.');
      }
      const sourceStrand = this.journal.strand(input.strandId);
      if (!sourceStrand || sourceStrand.conversationId !== conversation.conversationId ||
          sourceStrand.state !== 'ready') {
        throw coordinatorError('configuration_conflict', 'The selected version is unavailable.');
      }
      const boundary = this.journal.strandPath(sourceStrand.strandId).at(-1);
      if (!boundary) {
        throw coordinatorError('capability_unavailable', 'An empty history version cannot be restored yet.');
      }
      const turn = this.journal.turn(boundary.turnId);
      if (!turn) throw new Error('The version boundary turn is missing.');
      const binding = this.journal.nativeTurnBinding(turn.executionId, turn.turnId);
      if (!binding?.nativeTurnId || binding.bindingState !== 'authoritative') {
        throw coordinatorError('capability_unavailable', 'This version has no authoritative native branch point.');
      }
      const sourceExecution = this.journal.execution(binding.nativeSessionExecutionId);
      if (!sourceExecution) throw new Error('The version native execution is missing.');
      const sourceSession = await this.ensureExecutionSession(sourceExecution);
      if (!sourceSession.fork) throw coordinatorError('capability_unavailable', 'Provider cannot restore versions.');
      this.assertRootDeliveryAvailable(conversation.conversationId);
      this.journal.createBranchOperation({
        operationId: branchOperationId,
        commandId: input.commandId,
        mode: 'restore',
        sourceConversationId: conversation.conversationId,
        sourceStrandId: sourceStrand.strandId,
        sourcePathEntryId: boundary.pathEntryId,
        expectedHeadRevision: input.expectedHeadRevision,
        destinationConversationId: conversation.conversationId,
        destinationStrandId,
        destinationExecutionId: executionId,
        now: this.now(),
      });
      branchOperationCreated = true;
      this.journal.updateBranchOperation(branchOperationId, 'native-forking', this.now());
      this.journal.markCommandDispatching(input.commandId, this.now());
      const nativeFork = await sourceSession.fork({
        commandId: `${input.commandId}:fork`,
        destinationSessionId: stableUuid(`restored-native-session\0${input.commandId}`),
        throughNativeTurnId: binding.nativeTurnId,
        ...(binding.branchCursor === null ? {} : {
          branchCursor: binding.branchCursor as import('../../../shared/provider-runtime.ts').JsonValue,
        }),
      });
      this.journal.updateBranchOperation(
        branchOperationId,
        'native-prepared',
        this.now(),
        { provider: nativeFork.provider, sessionId: nativeFork.sessionId },
      );
      this.journal.transaction(() => {
        this.journal.createConversationStrand({
          strandId: destinationStrandId,
          conversationId: conversation.conversationId,
          sourceStrandId: sourceStrand.strandId,
          sourcePathEntryId: boundary.pathEntryId,
          cutoffKind: 'restore',
          reason: 'restore',
          rootExecutionId: executionId,
          provider: conversation.provider,
          providerInstanceId: conversation.providerInstanceId,
          model: conversation.model,
          ...(conversation.effort ? { effort: conversation.effort } : {}),
          ...(conversation.serviceTier ? { serviceTier: conversation.serviceTier } : {}),
          access: conversation.access,
          title: conversation.title,
          now: this.now(),
        });
        this.journal.copyStrandPrefix({
          sourceStrandId: sourceStrand.strandId,
          destinationStrandId,
          boundaryPathEntryId: boundary.pathEntryId,
          includeBoundary: true,
        });
        this.journal.updateBranchOperation(branchOperationId, 'prefix-validated', this.now());
      });
      const registration = this.requireReadyProvider(conversation.providerInstanceId);
      await this.openAttachedSession(conversation.conversationId, executionId, () =>
        this.openExecutionSession({
          conversation,
          executionId,
          registration,
          mode: 'attach',
          nativeSession: nativeFork,
          model: conversation.model,
          effort: conversation.effort,
          serviceTier: conversation.serviceTier ?? undefined,
          access: conversation.access,
        }));
      let result!: { accepted: true; strandId: string; headRevision: number };
      this.journal.transaction(() => {
        this.journal.markStrandReady(destinationStrandId, this.now());
        this.journal.activateConversationStrand({
          conversationId: conversation.conversationId,
          strandId: destinationStrandId,
          expectedRevision: input.expectedHeadRevision,
          now: this.now(),
        });
        const nextHead = this.journal.conversationHead(conversation.conversationId)!;
        result = {
          accepted: true,
          strandId: nextHead.strandId,
          headRevision: nextHead.revision,
        };
        this.journal.updateBranchOperation(branchOperationId, 'activated', this.now());
        this.journal.acceptCommand(input.commandId, result, this.now());
      });
      this.invalidateConversation(conversation.conversationId, executionId);
      return result;
    } catch (error) {
      this.journal.rejectCommand(input.commandId, safeMessage(error), this.now());
      if (branchOperationCreated) {
        this.journal.updateBranchOperation(branchOperationId, 'failed', this.now(), {
          code: 'restore_activation_failed',
          message: safeMessage(error),
        });
      }
      this.journal.failStrand(destinationStrandId, this.now());
      throw error;
    }
  }

  setConversationPreference(unparsed: NativeComposerPreferenceSetCommand) {
    this.assertOpen();
    const input = parseNativeComposerPreferenceSetCommand(unparsed);
    const claim = this.journal.claimCommand(
      input.commandId,
      'composer.conversation-preference.set',
      input,
      this.now(),
    );
    const replay = this.replay<{ accepted: true; revision: string }>(claim.receipt);
    if (replay) return replay;
    try {
      const conversation = this.requireConversation(input.conversationId);
      const runtime = this.projector.runtimeResource(input.conversationId);
      if (!runtime) throw coordinatorError('session_unavailable', 'Conversation runtime is unavailable.');
      if (runtime.composer.revision !== input.expectedRevision) {
        throw coordinatorError('configuration_conflict', 'Composer configuration changed; refresh and retry.');
      }
      const model = this.projector.resolveModel(conversation.providerInstanceId, input.model);
      if (!model || model.id !== input.model) {
        throw coordinatorError('configuration_conflict', 'Selected model is unavailable.');
      }
      const effort = repairRequestedEffort(model, input.effort);
      const requestedServiceTier = input.serviceTier !== undefined
        ? input.serviceTier
        : model.id === runtime.composer.nextTurn.model
          ? runtime.composer.nextTurn.serviceTier
          : null;
      const serviceTier = this.projector.resolveServiceTier(
        conversation.providerInstanceId,
        model.id,
        requestedServiceTier,
      );
      if (input.serviceTier !== undefined && serviceTier !== input.serviceTier) {
        throw coordinatorError('configuration_conflict', 'Selected speed is unavailable for this model.');
      }
      if (input.model !== runtime.composer.nextTurn.model && !runtime.composer.editable.model) {
        throw coordinatorError('capability_unavailable', 'Model is locked for this native session.');
      }
      if (effort !== runtime.composer.nextTurn.effort && !runtime.composer.editable.effort) {
        throw coordinatorError('capability_unavailable', 'Effort is locked for this native session.');
      }
      this.journal.transaction(() => {
        this.journal.setComposerPreference({
          scope: 'conversation',
          scopeId: conversation.conversationId,
          providerInstanceId: conversation.providerInstanceId,
          model: model.id,
          effort,
          serviceTier,
          now: this.now(),
        });
        this.journal.setComposerPreference({
          scope: 'provider',
          scopeId: conversation.providerInstanceId,
          providerInstanceId: conversation.providerInstanceId,
          model: model.id,
          effort,
          serviceTier,
          now: this.now(),
        });
      });
      const revision = this.projector.runtimeResource(input.conversationId)!.composer.revision;
      const result = { accepted: true as const, revision };
      this.journal.acceptCommand(input.commandId, result, this.now());
      this.invalidateConversation(input.conversationId);
      this.invalidateProvider(conversation.providerInstanceId);
      return result;
    } catch (error) {
      this.journal.rejectCommand(input.commandId, safeMessage(error), this.now());
      throw error;
    }
  }

  async setConversationAccess(unparsed: NativeConversationAccessSetCommand) {
    this.assertOpen();
    const input = parseNativeConversationAccessSetCommand(unparsed);
    return this.journal.runAsyncCommand(
      input.commandId,
      'composer.conversation-access.set',
      input,
      () => this.setConversationAccessOwned(input),
    );
  }

  private async setConversationAccessOwned(input: NativeConversationAccessSetCommand) {
    this.assertOpen();
    const claim = this.journal.claimCommand(
      input.commandId,
      'composer.conversation-access.set',
      input,
      this.now(),
    );
    const replay = this.replay<{ accepted: true; revision: string }>(claim.receipt);
    if (replay) return replay;
    let conversation: JournalConversation;
    try {
      conversation = this.requireConversation(input.conversationId);
      this.assertRootDeliveryAvailable(conversation.conversationId);
      const runtime = this.projector.runtimeResource(input.conversationId);
      if (!runtime) throw coordinatorError('session_unavailable', 'Conversation runtime is unavailable.');
      if (runtime.composer.revision !== input.expectedRevision) {
        throw coordinatorError('configuration_conflict', 'Composer configuration changed; refresh and retry.');
      }
      if (!runtime.capabilities.access.presets.includes(input.access)) {
        throw coordinatorError('capability_unavailable', `Provider does not support ${input.access} access.`);
      }
      if (input.access !== conversation.access && !runtime.composer.editable.access) {
        throw coordinatorError(
          'capability_unavailable',
          'Access can only change while this resumable native session is idle.',
        );
      }
    } catch (error) {
      this.journal.rejectCommand(input.commandId, safeMessage(error), this.now());
      throw error;
    }

    if (input.access === conversation.access) {
      const result = { accepted: true as const, revision: input.expectedRevision };
      this.journal.acceptCommand(input.commandId, result, this.now());
      return result;
    }

    this.accessReconfigurations.add(conversation.conversationId);
    try {
      this.journal.updateConversationAccess(
        conversation.conversationId,
        input.access,
        this.now(),
      );
      const opening = this.openingSessions.get(conversation.rootExecutionId);
      const attached = this.sessions.get(conversation.rootExecutionId);
      if (attached) await this.detachAndCloseSession(conversation.rootExecutionId, attached);
      if (opening) {
        const opened = await opening.catch(() => undefined);
        if (opened) await this.detachAndCloseSession(conversation.rootExecutionId, opened);
      }
      const revision = this.projector.runtimeResource(input.conversationId)!.composer.revision;
      const result = { accepted: true as const, revision };
      this.journal.acceptCommand(input.commandId, result, this.now());
      this.invalidateConversation(input.conversationId);
      return result;
    } catch (error) {
      this.journal.rejectCommand(input.commandId, safeMessage(error), this.now());
      throw error;
    } finally {
      this.accessReconfigurations.delete(conversation.conversationId);
    }
  }

  setProviderPreference(unparsed: NativeProviderPreferenceSetCommand) {
    this.assertOpen();
    const input = parseNativeProviderPreferenceSetCommand(unparsed);
    const claim = this.journal.claimCommand(
      input.commandId,
      'composer.provider-preference.set',
      input,
      this.now(),
    );
    const replay = this.replay<{ accepted: true; revision: string }>(claim.receipt);
    if (replay) return replay;
    try {
      this.requireReadyProvider(input.providerInstanceId);
      const providers = this.projector.providersResource();
      if (providers.preferenceRevision !== input.expectedProvidersRevision) {
        throw coordinatorError('configuration_conflict', 'Provider preference changed; refresh and retry.');
      }
      const model = this.projector.resolveModel(input.providerInstanceId, input.model);
      if (!model || model.id !== input.model) {
        throw coordinatorError('configuration_conflict', 'Selected model is unavailable.');
      }
      const effort = repairRequestedEffort(model, input.effort);
      const sticky = providers.providers.find(({ providerInstanceId }) =>
        providerInstanceId === input.providerInstanceId)?.stickyPreference;
      const requestedServiceTier = input.serviceTier !== undefined
        ? input.serviceTier
        : sticky?.model === model.id
          ? sticky.serviceTier ?? null
          : null;
      const serviceTier = this.projector.resolveServiceTier(
        input.providerInstanceId,
        model.id,
        requestedServiceTier,
      );
      if (input.serviceTier !== undefined && serviceTier !== input.serviceTier) {
        throw coordinatorError('configuration_conflict', 'Selected speed is unavailable for this model.');
      }
      this.journal.transaction(() => {
        this.journal.setComposerPreference({
          scope: 'provider',
          scopeId: input.providerInstanceId,
          providerInstanceId: input.providerInstanceId,
          model: model.id,
          effort,
          serviceTier,
          now: this.now(),
        });
        this.journal.setComposerPreference({
          scope: 'default-provider',
          scopeId: 'default',
          providerInstanceId: input.providerInstanceId,
          model: null,
          effort: null,
          serviceTier: null,
          now: this.now(),
        });
      });
      const revision = this.projector.providersResource().preferenceRevision;
      const result = { accepted: true as const, revision };
      this.journal.acceptCommand(input.commandId, result, this.now());
      this.invalidateProvider(input.providerInstanceId);
      return result;
    } catch (error) {
      this.journal.rejectCommand(input.commandId, safeMessage(error), this.now());
      throw error;
    }
  }

  async compactConversation(
    unparsed: NativeCompactConversationCommand,
  ): Promise<NativeCompactConversationResult> {
    this.assertOpen();
    const input = parseNativeCompactConversationCommand(unparsed);
    return this.journal.runAsyncCommand(input.commandId, 'conversation.compact', input, () =>
      this.compactConversationOwned(input));
  }

  private async compactConversationOwned(
    input: NativeCompactConversationCommand,
  ): Promise<NativeCompactConversationResult> {
    this.assertOpen();
    const claim = this.journal.claimCommand(input.commandId, 'conversation.compact', input, this.now());
    const replay = this.replay<NativeCompactConversationResult>(claim.receipt);
    if (replay) return replay;
    let conversation: JournalConversation;
    let session: ProviderSession;
    try {
      conversation = this.requireConversation(input.conversationId);
      this.assertRootDeliveryAvailable(conversation.conversationId);
      await this.synchronizeConversationHistory(conversation.conversationId, 'required-fresh');
      conversation = this.requireConversation(input.conversationId);
      const capabilities = this.requireCapabilities(conversation.providerInstanceId);
      if (!capabilities.compaction.manualNative) {
        throw coordinatorError('capability_unavailable', 'Provider does not support native manual compaction.');
      }
      if (!conversation.resumable) {
        throw coordinatorError('session_unavailable', 'Conversation has no resumable native provider session.');
      }
      const current = this.journal.latestCompactionOperation(conversation.conversationId);
      if (current?.state === 'queued' || current?.state === 'running') {
        throw coordinatorError('operation_in_progress', 'A compaction operation is already pending.');
      }
      session = await this.ensureSession(conversation);
      if (!session.compact) {
        throw coordinatorError('native_command_unavailable', 'Native Compact is unavailable in this session.');
      }
      conversation = this.requireConversation(input.conversationId);
    } catch (error) {
      this.journal.rejectCommand(input.commandId, safeMessage(error), this.now());
      throw error;
    }

    const operationId = stableUuid(`compaction\0${input.commandId}`);
    const queueOccupied = Boolean(conversation.activeTurnId)
      || conversation.state === 'recovering'
      || this.journal.queuedEntries(conversation.conversationId).length > 0;
    const delivery = queueOccupied ? 'queued' as const : 'sent' as const;
    const result = { accepted: true as const, operationId, delivery };
    this.journal.transaction(() => {
      this.journal.createManualCompaction({
        operationId,
        commandId: input.commandId,
        conversationId: conversation.conversationId,
        state: queueOccupied ? 'queued' : 'running',
        now: this.now(),
      });
      if (queueOccupied) this.journal.acceptCommand(input.commandId, result, this.now());
      else this.journal.markCommandDispatching(input.commandId, this.now());
    });
    this.invalidateConversation(conversation.conversationId);
    if (queueOccupied) return result;

    try {
      this.assertRootDeliveryAvailable(conversation.conversationId);
      await this.dispatchCompaction(conversation, session, operationId);
      this.journal.acceptCommand(input.commandId, result, this.now());
      return result;
    } catch (error) {
      this.journal.rejectCommand(input.commandId, safeMessage(error), this.now());
      throw error;
    } finally {
      this.invalidateConversation(conversation.conversationId);
    }
  }

  async branchConversation(unparsed: NativeBranchCommand) {
    this.assertOpen();
    const input = parseNativeBranchCommand(unparsed);
    return this.journal.runAsyncCommand(input.commandId, `conversation.${input.mode}`, input, () =>
      this.branchConversationOwned(input));
  }

  private async branchConversationOwned(input: NativeBranchCommand) {
    this.assertOpen();
    const claim = this.journal.claimCommand(input.commandId, `conversation.${input.mode}`, input, this.now());
    const replay = this.replay<NativeConversationBranchResult>(claim.receipt);
    if (replay) return replay;
    const conversationId = input.mode === 'edit'
      ? input.sourceConversationId
      : stableUuid(`branch-conversation\0${input.commandId}`);
    const strandId = stableUuid(`branch-strand\0${input.commandId}`);
    const executionId = stableUuid(`branch-execution\0${input.commandId}`);
    const turnId = stableUuid(`branch-turn\0${input.commandId}`);
    const branchOperationId = stableUuid(`branch-operation\0${input.commandId}`);
    let source: JournalConversation;
    let sourceTurn: NonNullable<ReturnType<NativeAgentJournal['turn']>>;
    let sourceBinding: NonNullable<ReturnType<NativeAgentJournal['nativeTurnBinding']>>;
    let sourceSession: ProviderSession;
    let branchModel: ProviderModelDescriptor;
    let branchEffort: string | undefined;
    let branchServiceTier: string | undefined;
    let branchTurnAccepted = false;
    let branchOperationCreated = false;
    let configurationRevisionBeforeSync: string | undefined;
    try {
      source = this.requireConversation(input.sourceConversationId);
      this.assertRootDeliveryAvailable(source.conversationId);
      configurationRevisionBeforeSync = this.projector.runtimeResource(
        source.conversationId,
      )?.composer.revision;
      await this.synchronizeConversationHistory(source.conversationId, 'required-fresh');
      source = this.requireConversation(input.sourceConversationId);
      const head = this.journal.conversationHead(source.conversationId);
      if (!head || head.strandId !== input.sourceStrandId || head.revision !== input.expectedHeadRevision) {
        throw coordinatorError('configuration_conflict', 'Conversation history changed; refresh and retry.');
      }
      const sourcePath = this.journal.pathEntry(input.sourcePathEntryId);
      if (!sourcePath || sourcePath.strandId !== head.strandId) {
        throw coordinatorError('configuration_conflict', 'The selected message is not on the active history.');
      }
      const resolvedTurn = this.journal.turn(sourcePath.turnId);
      if (!resolvedTurn) {
        throw new Error('Source history entry has no logical turn.');
      }
      sourceTurn = resolvedTurn;
      const resolvedBinding = this.journal.nativeTurnBinding(sourceTurn.executionId, sourceTurn.turnId);
      if (!resolvedBinding || !resolvedBinding.nativeTurnId ||
          resolvedBinding.bindingState !== 'authoritative') {
        throw coordinatorError(
          'capability_unavailable',
          'This older message does not have an authoritative native branch point.',
        );
      }
      sourceBinding = resolvedBinding;
      const runtime = this.projector.runtimeResource(source.conversationId);
      if (!runtime) throw coordinatorError('session_unavailable', 'Conversation runtime is unavailable.');
      const requestedServiceTier = input.serviceTier ?? runtime.composer.nextTurn.serviceTier;
      const branching = runtime.capabilities.session.contextBranching;
      if (!runtime.capabilities.session.forkNative ||
          (branching && branching.strategy !== 'native')) {
        throw coordinatorError('capability_unavailable', 'Provider does not support native fork semantics.');
      }
      if (source.state !== 'idle' || source.activeTurnId ||
          this.journal.queuedEntries(source.conversationId).length > 0) {
        throw coordinatorError('configuration_conflict', 'Wait for the conversation to become idle before branching.');
      }
      if (this.journal.childExecutions(source.rootExecutionId).some((execution) =>
        execution.state === 'running' || execution.state === 'recovering')) {
        throw coordinatorError('configuration_conflict', 'Wait for active subagents to finish before branching.');
      }
      if (input.providerInstanceId !== source.providerInstanceId || input.access !== source.access) {
        throw coordinatorError('configuration_conflict', 'Submitted branch configuration has the wrong provider or access.');
      }
      if (input.configurationRevision !== runtime.composer.revision &&
          input.configurationRevision !== configurationRevisionBeforeSync) {
        throw coordinatorError('configuration_conflict', 'Composer configuration changed; refresh and retry.');
      }
      if (input.model !== runtime.composer.nextTurn.model || input.effort !== runtime.composer.nextTurn.effort ||
          requestedServiceTier !== runtime.composer.nextTurn.serviceTier) {
        throw coordinatorError(
          'configuration_conflict',
          'Submitted model, effort, or speed is no longer current.',
        );
      }
      const resolvedModel = this.projector.resolveModel(source.providerInstanceId, input.model);
      if (!resolvedModel || resolvedModel.id !== input.model) {
        throw coordinatorError('configuration_conflict', 'Selected model is unavailable.');
      }
      branchModel = resolvedModel;
      branchEffort = repairRequestedEffort(resolvedModel, input.effort) ?? undefined;
      const resolvedServiceTier = this.projector.resolveServiceTier(
        source.providerInstanceId,
        resolvedModel.id,
        requestedServiceTier,
      );
      if (resolvedServiceTier !== requestedServiceTier) {
        throw coordinatorError('configuration_conflict', 'Selected speed is unavailable for this model.');
      }
      branchServiceTier = resolvedServiceTier ?? undefined;
      this.assertContentCapabilities(input.content, this.requireCapabilities(source.providerInstanceId));
      this.journal.assertImageContentMetadata(input.content);
      this.assertRootDeliveryAvailable(source.conversationId);
      this.journal.createBranchOperation({
        operationId: branchOperationId,
        commandId: input.commandId,
        mode: input.mode,
        sourceConversationId: source.conversationId,
        sourceStrandId: input.sourceStrandId,
        sourcePathEntryId: input.sourcePathEntryId,
        expectedHeadRevision: input.expectedHeadRevision,
        destinationConversationId: conversationId,
        destinationStrandId: strandId,
        destinationExecutionId: executionId,
        now: this.now(),
      });
      branchOperationCreated = true;
      this.journal.updateBranchOperation(branchOperationId, 'native-forking', this.now());
      this.journal.markCommandDispatching(input.commandId, this.now());
      const sourceExecution = this.journal.execution(sourceBinding.nativeSessionExecutionId);
      if (!sourceExecution) throw new Error('Native branch execution is missing.');
      sourceSession = await this.ensureExecutionSession(sourceExecution);
      if (!sourceSession.fork) {
        throw coordinatorError('capability_unavailable', 'Provider does not support native fork semantics.');
      }
    } catch (error) {
      this.journal.rejectCommand(input.commandId, safeMessage(error), this.now());
      if (branchOperationCreated) {
        this.journal.updateBranchOperation(branchOperationId, 'failed', this.now(), {
          code: 'branch_preparation_failed',
          message: safeMessage(error),
        });
      }
      throw error;
    }
    let nativeFork;
    try {
      this.assertRootDeliveryAvailable(source.conversationId);
      nativeFork = await sourceSession.fork!({
        commandId: `${input.commandId}:fork`,
        destinationSessionId: stableUuid(`branch-native-session\0${input.commandId}`),
        ...(sourceBinding.branchCursor === null ? {} : {
          branchCursor: sourceBinding.branchCursor as import('../../../shared/provider-runtime.ts').JsonValue,
        }),
        ...(input.mode === 'edit'
          ? { beforeNativeTurnId: sourceBinding.nativeTurnId! }
          : { throughNativeTurnId: sourceBinding.nativeTurnId! }),
      });
      this.journal.updateBranchOperation(
        branchOperationId,
        'native-prepared',
        this.now(),
        { provider: nativeFork.provider, sessionId: nativeFork.sessionId },
      );
    } catch (error) {
      this.journal.rejectCommand(input.commandId, safeMessage(error), this.now());
      this.journal.updateBranchOperation(branchOperationId, 'failed', this.now(), {
        code: 'native_fork_failed',
        message: safeMessage(error),
      });
      throw error;
    }

    try {
      const registration = this.requireReadyProvider(source.providerInstanceId);
      this.journal.transaction(() => {
        if (input.mode === 'edit') {
          this.journal.createConversationStrand({
            strandId,
            conversationId,
            sourceStrandId: input.sourceStrandId,
            sourcePathEntryId: input.sourcePathEntryId,
            cutoffKind: 'before',
            reason: 'edit',
            rootExecutionId: executionId,
            provider: source.provider,
            providerInstanceId: source.providerInstanceId,
            model: branchModel.id,
            ...(branchEffort ? { effort: branchEffort } : {}),
            ...(branchServiceTier ? { serviceTier: branchServiceTier } : {}),
            access: source.access,
            title: source.title,
            now: this.now(),
          });
        } else {
          this.journal.createConversation({
            conversationId,
            rootExecutionId: executionId,
            strandId,
            provider: source.provider,
            providerInstanceId: source.providerInstanceId,
            // Fork lineage remains durable in parentConversationId and the
            // branch operation. The history UI derives identity from the new
            // prompt instead of exposing storage topology in the title.
            title: 'New chat',
            cwd: source.cwd,
            model: branchModel.id,
            ...(branchEffort ? { effort: branchEffort } : {}),
            ...(branchServiceTier ? { serviceTier: branchServiceTier } : {}),
            access: source.access,
            parentConversationId: source.conversationId,
            rootConversationId: source.rootConversationId,
            forkedFromPathEntryId: input.sourcePathEntryId,
            strandState: 'preparing',
            now: this.now(),
          });
        }
        this.journal.copyStrandPrefix({
          sourceStrandId: input.sourceStrandId,
          destinationStrandId: strandId,
          boundaryPathEntryId: input.sourcePathEntryId,
          includeBoundary: input.mode === 'fork',
        });
        this.journal.setComposerPreference({
          scope: 'conversation',
          scopeId: conversationId,
          providerInstanceId: source.providerInstanceId,
          model: branchModel.id,
          effort: branchEffort ?? null,
          serviceTier: branchServiceTier ?? null,
          now: this.now(),
        });
        this.journal.setComposerPreference({
          scope: 'provider',
          scopeId: source.providerInstanceId,
          providerInstanceId: source.providerInstanceId,
          model: branchModel.id,
          effort: branchEffort ?? null,
          serviceTier: branchServiceTier ?? null,
          now: this.now(),
        });
        this.journal.grantImageContent({
          scope: { conversationId, executionId },
          content: input.content,
          provenance: 'viewer-message',
          createdAt: this.now(),
        });
        this.journal.updateBranchOperation(branchOperationId, 'prefix-validated', this.now());
      });
      const destinationConversation = this.journal.conversation(conversationId)!;
      const session = await this.openAttachedSession(conversationId, executionId, () =>
        this.openExecutionSession({
          conversation: destinationConversation,
          executionId,
          registration,
          mode: 'attach',
          nativeSession: nativeFork,
          model: branchModel.id,
          effort: branchEffort,
          serviceTier: branchServiceTier,
          access: source.access,
        }));
      this.journal.createTurn({
        turnId,
        conversationId,
        executionId,
        clientMessageId: input.clientMessageId,
        commandId: input.commandId,
        content: input.content,
        model: branchModel.id,
        ...(branchEffort ? { effort: branchEffort } : {}),
        ...(branchServiceTier ? { serviceTier: branchServiceTier } : {}),
        state: 'running',
        now: this.now(),
      });
      this.journal.updateBranchOperation(branchOperationId, 'turn-dispatching', this.now());
      requireLegacyAcceptance(await session.startTurn({
        commandId: `${input.commandId}:turn`,
        conversationId,
        executionId,
        turnId,
        content: input.content,
        model: branchModel.id,
        ...(branchEffort ? { effort: branchEffort } : {}),
        ...(branchServiceTier ? { serviceTier: branchServiceTier } : {}),
      }, { markPossiblySent: () => undefined }));
      branchTurnAccepted = true;
      this.journal.updateBranchOperation(branchOperationId, 'accepted', this.now());
      let result!: NativeConversationBranchResult;
      this.journal.transaction(() => {
        this.journal.markStrandReady(strandId, this.now());
        if (input.mode === 'edit') {
          this.journal.activateConversationStrand({
            conversationId,
            strandId,
            expectedRevision: input.expectedHeadRevision,
            now: this.now(),
          });
        }
        const nextHead = this.journal.conversationHead(conversationId)!;
        result = {
          accepted: true,
          conversationId,
          strandId: nextHead.strandId,
          headRevision: nextHead.revision,
          turnId,
        };
        this.journal.updateBranchOperation(branchOperationId, 'activated', this.now());
        this.journal.acceptCommand(input.commandId, result, this.now());
      });
      this.invalidateConversation(conversationId);
      this.invalidateProvider(source.providerInstanceId);
      return result;
    } catch (error) {
      const failure = {
        code: branchTurnAccepted ? 'branch_delivery_unknown' : 'branch_activation_failed',
        message: safeMessage(error),
      };
      if (branchTurnAccepted) {
        this.journal.failCommandRecovery(
          input.commandId,
          'The provider accepted the branch turn, but Remux could not activate its strand. ' +
            'The hidden destination will not be retried automatically.',
          this.now(),
        );
      } else {
        this.journal.rejectCommand(input.commandId, safeMessage(error), this.now());
      }
      this.journal.updateBranchOperation(
        branchOperationId,
        branchTurnAccepted ? 'delivery-unknown' : 'failed',
        this.now(),
        failure,
      );
      this.journal.failStrand(strandId, this.now());
      if (input.mode === 'fork') {
        const failed = this.journal.conversation(conversationId);
        if (failed) this.journal.setConversationArchived(
          conversationId,
          failed.metadataRevision,
          true,
          this.now(),
        );
      }
      this.invalidateConversation(conversationId);
      throw error;
    }
  }

  async spawnFederatedAgent(input: FederatedSpawnInput): Promise<{ accepted: true; executionId: string }> {
    this.assertOpen();
    this.assertFederationReady();
    return this.journal.runAsyncCommand(input.commandId, 'federation.spawn', input, () =>
      this.spawnFederatedAgentOwned(input));
  }

  private async spawnFederatedAgentOwned(
    input: FederatedSpawnInput,
  ): Promise<{ accepted: true; executionId: string }> {
    this.assertOpen();
    const existing = this.checkoutOwner.settledOrUnresolved(
      input.commandId, 'federation.spawn', input);
    if (existing) {
      const replay = this.replay<{ accepted: true; executionId: string }>(existing);
      if (replay) return replay;
      throw new FederationCommandInProgressError(input.commandId);
    }
    const initialConversation = this.requireConversation(input.parentConversationId);
    let checkout: { checkoutKey: string; launchCwd: string };
    try {
      checkout = await this.checkoutOwner.resolveNew(
        input.commandId, 'federation.spawn', input, initialConversation.cwd, this.now());
    } catch (error) {
      if (error instanceof FederationCommandSettledError) {
        const replay = this.replay<{ accepted: true; executionId: string }>(error.receipt);
        if (replay) return replay;
      }
      throw error;
    }
    const executionId = stableUuid(`federated-execution\0${input.commandId}`);
    const turnId = stableUuid(`federated-turn\0${input.commandId}`);
    const title = boundedSummary(input.task, 96) || 'Federated agent';
    const content: readonly UserContentPart[] = [
      { type: 'text', text: input.task.trim() }, ...(input.attachments ?? []),
    ];
    let conversation!: JournalConversation;
    let parent!: NonNullable<ReturnType<NativeAgentJournal['execution']>>;
    let target!: NativeProviderRegistration;
    let model!: NonNullable<ReturnType<NativeAgentProjector['resolveModel']>>;
    let serviceTier: string | undefined;
    const admitted = this.checkoutOwner.claimAndReserve({
      commandId: input.commandId, kind: 'federation.spawn', request: input,
      executionId, expectedTurnId: turnId, checkout, access: input.access,
      scheduling: input.scheduling, now: this.now(),
      validateAndCreate: () => {
        conversation = this.requireConversation(input.parentConversationId);
        parent = this.journal.execution(input.parentExecutionId)!;
        if (!parent || parent.conversationId !== conversation.conversationId) {
          throw new Error('Federation parent execution is unavailable.');
        }
        if (parent.providerInstanceId === input.targetProviderInstanceId) {
          throw new Error('use_native_collaboration: same-provider delegation stays in the native harness.');
        }
        target = this.requireReadyProvider(input.targetProviderInstanceId);
        if (target.provider === parent.provider) {
          throw new Error('use_native_collaboration: Version 1 federation requires a different provider kind.');
        }
        if (input.depth !== parent.federationDepth + 1 || input.depth > 2) {
          throw new Error('Federation depth limit exceeded.');
        }
        if (input.access === 'workspace-write' && input.scheduling !== 'foreground') {
          throw new Error('Federated workspace writers must use foreground scheduling.');
        }
        if (!accessWithin(input.access, parent.access ?? conversation.access)) {
          throw new Error('Federation cannot widen the parent access ceiling.');
        }
        const rootTurn = this.journal.turn(input.rootTurnId);
        if (!rootTurn || rootTurn.conversationId !== conversation.conversationId ||
            (rootTurn.state !== 'running' && rootTurn.state !== 'recovering')) {
          throw new Error('Federation is only available while the owning root turn is active.');
        }
        const federated = this.journal.executionsForConversation(conversation.conversationId)
          .filter((candidate) => candidate.ownership === 'federated' &&
            candidate.rootTurnId === input.rootTurnId);
        if (federated.length >= 16) throw new Error('Federated execution limit exceeded for this root turn.');
        const unresolved = federated.filter((candidate) => {
          const row = this.journal.database.prepare(`SELECT state FROM federation_checkout_reservations
            WHERE execution_id=? AND state IN ('held','unknown')`).get(candidate.executionId);
          return candidate.state === 'running' || candidate.state === 'recovering' || Boolean(row);
        });
        if (unresolved.length >= 4) throw new Error('Active federated child limit exceeded for this root turn.');
        const resolved = this.projector.resolveModel(input.targetProviderInstanceId, input.model);
        if (!resolved || (input.model && resolved.id !== input.model)) {
          throw new Error(`Requested federation model is unavailable from ${input.targetProviderInstanceId}.`);
        }
        if (input.effort && !resolved.supportedEffort.includes(input.effort)) {
          throw new Error(`Effort ${input.effort} is unavailable for federation model ${resolved.id}.`);
        }
        model = resolved;
        serviceTier = this.projector.resolveServiceTier(target.providerInstanceId, resolved.id, null) ?? undefined;
        this.journal.assertImageContentAuthorized({ conversationId: conversation.conversationId,
          executionId: parent.executionId }, content);
        this.journal.createFederatedExecution({
          executionId, conversationId: conversation.conversationId,
          parentExecutionId: parent.executionId, rootTurnId: input.rootTurnId,
          provider: target.provider, providerInstanceId: target.providerInstanceId,
          model: model.id, ...(input.effort ? { effort: input.effort } : {}),
          ...(serviceTier ? { serviceTier } : {}), checkoutKey: checkout.checkoutKey,
          access: input.access, scheduling: input.scheduling, depth: input.depth, title, now: this.now(),
        });
        this.journal.markCommandDispatching(input.commandId, this.now());
        this.journal.grantImageContent({ scope: { conversationId: conversation.conversationId, executionId },
          content, provenance: 'federation-delegation', sourceExecutionId: parent.executionId,
          createdAt: this.now() });
        this.appendFederationEvent(parent, input.rootTurnId, { type: 'child.started', child: {
          executionId, ownership: 'federated', provider: target.provider,
          providerInstanceId: target.providerInstanceId, model: model.id, title,
        } }, `spawn:${executionId}`);
      },
    });
    if ('receipt' in admitted) {
      const replay = this.replay<{ accepted: true; executionId: string }>(admitted.receipt);
      if (replay) return replay;
      throw new FederationCommandInProgressError(input.commandId);
    }
    let startTurnInvoked = false;
    try {
      const session = await this.openAttachedSession(conversation.conversationId, executionId, () =>
        this.openExecutionSession({ conversation, executionId, registration: target, mode: 'create',
          model: model.id, effort: input.effort, serviceTier, access: input.access,
          launchCwd: checkout.launchCwd }));
      this.journal.createTurn({ turnId, conversationId: conversation.conversationId, executionId,
        clientMessageId: stableUuid(`federated-message\0${input.commandId}`), commandId: input.commandId,
        content, model: model.id, ...(input.effort ? { effort: input.effort } : {}),
        ...(serviceTier ? { serviceTier } : {}), state: 'running', now: this.now() });
      startTurnInvoked = true;
      requireLegacyAcceptance(await session.startTurn({ commandId: input.commandId, conversationId: conversation.conversationId,
        executionId, turnId, content, model: model.id,
        ...(input.effort ? { effort: input.effort } : {}),
        ...(serviceTier ? { serviceTier } : {}) }, { markPossiblySent: () => undefined }));
      const result = { accepted: true as const, executionId };
      this.journal.acceptCommand(input.commandId, result, this.now());
      this.invalidateConversation(conversation.conversationId, executionId, turnId);
      return result;
    } catch (error) {
      if (startTurnInvoked) this.checkoutOwner.dispatchUnknown(executionId, input.commandId, turnId, this.now());
      const message = safeMessage(error);
      if (startTurnInvoked) this.journal.rejectCommand(input.commandId, message, this.now());
      else this.checkoutOwner.beforeDispatchFailure(
        executionId, input.commandId, turnId, message, this.now());
      this.journal.failExecution(executionId, message, this.now());
      this.appendFederationEvent(parent, input.rootTurnId,
        { type: 'child.summary', childExecutionId: executionId, summary: message },
        `spawn-failed-summary:${executionId}`);
      this.appendFederationEvent(parent, input.rootTurnId,
        { type: 'child.completed', childExecutionId: executionId, outcome: 'failed' },
        `spawn-failed:${executionId}`);
      throw error;
    }
  }

  async sendFederatedMessage(input: FederatedFollowUpInput) {
    this.assertOpen();
    this.assertFederationReady();
    return this.journal.runAsyncCommand(input.commandId, 'federation.send', input, () =>
      this.sendFederatedMessageOwned(input));
  }

  private async sendFederatedMessageOwned(input: FederatedFollowUpInput) {
    this.assertOpen();
    const existing = this.checkoutOwner.settledOrUnresolved(input.commandId, 'federation.send', input);
    if (existing) {
      const replay = this.replay<{ accepted: true; executionId: string; turnId: string }>(existing);
      if (replay) return replay;
      throw new FederationCommandInProgressError(input.commandId);
    }
    let execution = this.requireFederatedExecution(input.executionId);
    let conversation = this.requireConversation(execution.conversationId);
    let checkout: { checkoutKey: string; launchCwd: string };
    try {
      checkout = await this.checkoutOwner.resolveNew(
        input.commandId, 'federation.send', input, conversation.cwd, this.now());
    } catch (error) {
      if (error instanceof FederationCommandSettledError) {
        const replay = this.replay<{ accepted: true; executionId: string; turnId: string }>(error.receipt);
        if (replay) return replay;
      }
      throw error;
    }
    const turnId = stableUuid(`federated-follow-up-turn\0${input.commandId}`);
    const content: readonly UserContentPart[] = [{ type: 'text', text: input.message }];
    const admitted = this.checkoutOwner.claimAndReserve({
      commandId: input.commandId, kind: 'federation.send', request: input,
      executionId: input.executionId, expectedTurnId: turnId, checkout,
      access: execution.access ?? 'read-only',
      scheduling: execution.federationScheduling ?? 'background', now: this.now(),
      validateAndCreate: () => {
        execution = this.requireFederatedExecution(input.executionId);
        conversation = this.requireConversation(execution.conversationId);
        if (!execution.checkoutKey || execution.checkoutKey !== checkout.checkoutKey) {
          throw new Error('Federated checkout is unavailable or changed.');
        }
        if (!execution.parentExecutionId || !execution.rootTurnId ||
            this.journal.execution(execution.parentExecutionId)?.conversationId !== conversation.conversationId ||
            this.journal.turn(execution.rootTurnId)?.conversationId !== conversation.conversationId) {
          throw new Error('Federated execution ownership is invalid.');
        }
        if (this.journal.nativeSessionState(execution.executionId) === 'closed') {
          throw new Error('Federated child is closed and cannot receive follow-ups.');
        }
        if (this.executionResult(execution.executionId).status === 'running') {
          throw new Error('Federated child is already running.');
        }
        const activeForRoot = this.journal.executionsForConversation(conversation.conversationId)
          .filter((candidate) => candidate.ownership === 'federated' &&
            candidate.rootTurnId === execution.rootTurnId && candidate.executionId !== execution.executionId)
          .filter((candidate) => {
            const reservation = this.journal.database.prepare(`SELECT 1 FROM federation_checkout_reservations
              WHERE execution_id=? AND state IN ('held','unknown')`).get(candidate.executionId);
            return candidate.state === 'running' || candidate.state === 'recovering' || Boolean(reservation);
          });
        if (activeForRoot.length >= 4) {
          throw new Error('Active federated child limit exceeded for this root turn.');
        }
        this.journal.createTurn({ turnId, conversationId: conversation.conversationId,
          executionId: execution.executionId,
          clientMessageId: stableUuid(`federated-follow-up-message\0${input.commandId}`),
          commandId: input.commandId, content, model: execution.model ?? conversation.model,
          ...(execution.effort ? { effort: execution.effort } : {}),
          ...(execution.serviceTier ? { serviceTier: execution.serviceTier } : {}),
          state: 'running', now: this.now() });
        this.journal.markCommandDispatching(input.commandId, this.now());
      },
    });
    if ('receipt' in admitted) {
      const replay = this.replay<{ accepted: true; executionId: string; turnId: string }>(admitted.receipt);
      if (replay) return replay;
      throw new FederationCommandInProgressError(input.commandId);
    }
    let startTurnInvoked = false;
    try {
      const session = await this.ensureExecutionSession(execution, checkout.launchCwd);
      startTurnInvoked = true;
      requireLegacyAcceptance(await session.startTurn({ commandId: input.commandId, conversationId: conversation.conversationId,
        executionId: execution.executionId, turnId, content,
        ...(execution.model ? { model: execution.model } : {}),
        ...(execution.effort ? { effort: execution.effort } : {}),
        ...(execution.serviceTier ? { serviceTier: execution.serviceTier } : {}) },
      { markPossiblySent: () => undefined }));
      this.appendFederationEvent(this.journal.execution(execution.parentExecutionId!)!, execution.rootTurnId!,
        { type: 'child.status', childExecutionId: execution.executionId, state: 'running' },
        `follow-up:${turnId}`);
      const result = { accepted: true as const, executionId: execution.executionId, turnId };
      this.journal.acceptCommand(input.commandId, result, this.now());
      this.invalidateConversation(conversation.conversationId, execution.executionId, turnId);
      return result;
    } catch (error) {
      if (startTurnInvoked) this.checkoutOwner.dispatchUnknown(
        execution.executionId, input.commandId, turnId, this.now());
      else this.checkoutOwner.beforeDispatchFailure(
        execution.executionId, input.commandId, turnId, safeMessage(error), this.now());
      if (startTurnInvoked) this.journal.rejectCommand(input.commandId, safeMessage(error), this.now());
      this.journal.failTurnDispatch(turnId, safeMessage(error), this.now());
      this.finalizeFederatedExecution(execution.executionId);
      throw error;
    }
  }

  waitForFederatedExecution(executionId: string, signal?: AbortSignal): Promise<FederatedExecutionResult> {
    const current = this.executionResult(executionId);
    if (current.status !== 'running') return Promise.resolve(current);
    return new Promise((resolve, reject) => {
      const waiters = this.executionWaiters.get(executionId) ?? new Set();
      const complete = (result: FederatedExecutionResult) => {
        signal?.removeEventListener('abort', aborted);
        resolve(result);
      };
      const aborted = () => {
        waiters.delete(complete);
        if (waiters.size === 0) this.executionWaiters.delete(executionId);
        reject(new Error('Federation wait was cancelled.'));
      };
      waiters.add(complete);
      this.executionWaiters.set(executionId, waiters);
      if (signal) {
        if (signal.aborted) aborted();
        else signal.addEventListener('abort', aborted, { once: true });
      }
      // Terminal projection can land between the initial state read and waiter
      // registration. Recheck after registration so that edge cannot lose the
      // only completion wakeup and leave an MCP wait hanging forever.
      const afterRegistration = this.executionResult(executionId);
      if (afterRegistration.status !== 'running') {
        waiters.delete(complete);
        if (waiters.size === 0) this.executionWaiters.delete(executionId);
        complete(afterRegistration);
      }
    });
  }

  async interruptFederatedExecution(commandId: string, executionId: string) {
    this.assertOpen();
    this.assertFederationReady();
    const input = { executionId };
    return this.journal.runAsyncCommand(commandId, 'federation.interrupt', input, () =>
      this.interruptFederatedExecutionOwned(commandId, executionId));
  }

  private async interruptFederatedExecutionOwned(commandId: string, executionId: string) {
    const claim = this.journal.claimCommand(commandId, 'federation.interrupt', { executionId }, this.now());
    const replay = this.replay<{ accepted: true }>(claim.receipt);
    if (replay) return replay;
    const execution = this.requireFederatedExecution(executionId);
    const turn = this.journal.turnsForExecution(executionId)
      .filter((candidate) =>
        (candidate.state === 'running' || candidate.state === 'recovering'))
      .at(-1);
    if (!turn) {
      const result = { accepted: true as const };
      this.journal.acceptCommand(commandId, result, this.now());
      return result;
    }
    this.journal.markCommandDispatching(commandId, this.now());
    try {
      const session = await this.ensureExecutionSession(execution);
      const result = await session.interrupt({ commandId, turnId: turn.turnId });
      this.journal.acceptCommand(commandId, result, this.now());
      return result;
    } catch (error) {
      this.journal.rejectCommand(commandId, safeMessage(error), this.now());
      throw error;
    }
  }

  async closeFederatedExecution(commandId: string, executionId: string) {
    this.assertOpen();
    this.assertFederationReady();
    const input = { executionId };
    return this.journal.runAsyncCommand(commandId, 'federation.close', input, () =>
      this.closeFederatedExecutionOwned(commandId, executionId));
  }

  private async closeFederatedExecutionOwned(commandId: string, executionId: string) {
    const claim = this.journal.claimCommand(commandId, 'federation.close', { executionId }, this.now());
    const replay = this.replay<{ closed: true }>(claim.receipt);
    if (replay) return replay;
    this.requireFederatedExecution(executionId);
    this.journal.markCommandDispatching(commandId, this.now());
    try {
      if (this.executionResult(executionId).status === 'running') {
        await this.interruptFederatedExecution(
          stableUuid(`close-interrupt\0${commandId}\0${executionId}`),
          executionId,
        );
      }
      const session = this.sessions.get(executionId);
      const consumer = this.consumers.get(executionId);
      this.sessions.delete(executionId);
      await session?.close();
      await consumer?.catch(() => undefined);
      this.federationBindings.get(executionId)?.revoke?.();
      this.federationBindings.delete(executionId);
      this.journal.closeFederatedExecution(executionId, this.now());
      this.finalizeFederatedExecution(executionId);
      const result = { closed: true as const };
      this.journal.acceptCommand(commandId, result, this.now());
      return result;
    } catch (error) {
      this.journal.rejectCommand(commandId, safeMessage(error), this.now());
      throw error;
    }
  }

  async reconcile(conversationId: string, expectedRootExecutionId?: string) {
    const conversation = this.requireConversation(conversationId);
    const executionId = expectedRootExecutionId ?? conversation.rootExecutionId;
    const execution = this.journal.execution(executionId);
    if (!execution || execution.conversationId !== conversationId) return;
    const session = this.sessions.get(executionId) ?? (executionId === conversation.rootExecutionId
      ? await this.ensureSession(conversation)
      : await this.ensureExecutionSession(execution));
    const snapshot = await session.snapshot({ commandId: `reconcile:${stableUuid(`${conversationId}\0${this.now()}`)}` });
    const prepared = await this.prepareProviderEvents(conversationId, snapshot.events);
    if (snapshot.authority === 'session-local') this.journal.appendProviderEvents(prepared);
    else this.journal.replaceSnapshot(prepared, snapshot.coverage);
    this.observePersistedTerminals(prepared, snapshot.authority);
    // Snapshot lifecycle envelopes are replay-stable and can already exist in
    // the event log. Reassert the authoritative running state even when event
    // deduplication correctly suppresses their reducer side effects.
    if (snapshot.state === 'running') {
      this.journal.confirmExecutionRunning(executionId, this.now());
    }
    await this.sealTerminalOutputs(conversationId, executionId);
    const refreshed = this.requireConversation(conversationId);
    if (refreshed.rootExecutionId === executionId) {
      this.journal.markConversationHistorySynced(
        conversationId,
        this.now(),
        snapshot.historyRevision,
      );
    }
    const activeTurn = refreshed.activeTurnId
      ? this.journal.turn(refreshed.activeTurnId)
      : undefined;
    if (snapshot.state === 'idle' && refreshed.rootExecutionId === executionId &&
        activeTurn?.executionId === executionId) {
      this.journal.failRecovery(
        conversationId,
        snapshot.authority === 'session-local'
          ? 'Native provider resumed without the durable binding needed to recover the accepted turn.'
          : 'Native provider is idle but the accepted turn is absent from its authoritative snapshot.',
        this.now(),
        executionId,
      );
      this.journal.markQueuedTurnDeliveryUnknown(activeTurn.turnId);
    }
    for (const turn of this.journal.turnsForExecution(executionId)) {
      if ((turn.state === 'completed' || turn.state === 'failed' || turn.state === 'interrupted') &&
          turn.outcome !== 'recovery_failed') {
        this.journal.acknowledgeQueuedTurnDispatch(turn.turnId);
      }
    }
    this.invalidateConversation(conversationId);
    const current = this.requireConversation(conversationId);
    if (current.rootExecutionId === executionId && !current.activeTurnId) {
      void this.dispatchNext(conversationId);
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.sessionSweep);
    clearInterval(this.queueSweep);
    for (const timer of this.stopReconcileTimers.values()) clearTimeout(timer);
    this.stopReconcileTimers.clear();
    for (const job of this.hydrationJobs.values()) {
      job.controller.abort(new Error('Native Agent coordinator is closing.'));
    }
    const sessions = [...this.sessions.values()];
    const openingSessions = [...this.openingSessions.values()];
    const hydrationJobs = [...this.hydrationJobs.values()].map(({ promise }) => promise);
    const logins = [...this.providerLogins.values()];
    const providerRefreshes = [...this.providerRefreshes.values()];
    const accountUsageRefreshes = [...this.accountUsageRefreshes.values()];
    this.sessions.clear();
    this.sessionLastUsedAt.clear();
    this.providerLogins.clear();
    this.providerRefreshes.clear();
    this.providerLastProbedAt.clear();
    this.accountUsageRefreshes.clear();
    this.accountUsageLastRefreshedAt.clear();
    this.contextLastRefreshedAt.clear();
    this.accessReconfigurations.clear();
    for (const binding of this.federationBindings.values()) binding.revoke?.();
    this.federationBindings.clear();
    await Promise.allSettled([
      ...sessions.map((session) => session.close()),
      ...openingSessions,
      ...hydrationJobs,
      ...this.childReconciliationJobs.values(),
      ...this.stopJobs.values(),
      ...providerRefreshes,
      ...accountUsageRefreshes,
      ...logins.map(({ operation }) => operation.close()),
    ]);
    await Promise.allSettled(this.consumers.values());
    await Promise.allSettled(this.loginConsumers);
    this.consumers.clear();
    this.loginConsumers.clear();
    this.automaticRecoveryAttempts.clear();
    this.automaticRecoveryProbation.clear();
    this.hydrationJobs.clear();
  }

  private async consumeProviderLogin(providerInstanceId: string, active: ActiveProviderLogin) {
    let terminal = false;
    try {
      for await (const event of active.operation.events) {
        if (this.providerLogins.get(providerInstanceId) !== active) return;
        if (event.type === 'prompt') {
          this.updateLoginView(providerInstanceId, active, {
            ...active.view,
            state: 'waiting',
            verificationUri: event.verificationUri,
            ...(event.userCode ? { userCode: event.userCode } : {}),
          });
        } else {
          terminal = true;
          if (active.cancelRequested) {
            this.updateLoginView(providerInstanceId, active, {
              ...withoutLoginError(active.view),
              state: 'cancelled',
              completedAt: this.now(),
            });
          } else if (event.success) {
            this.updateLoginView(providerInstanceId, active, {
              ...withoutLoginError(active.view),
              state: 'completed',
              completedAt: this.now(),
            });
            await this.refreshProvider(this.requireProvider(providerInstanceId));
          } else {
            this.updateLoginView(providerInstanceId, active, {
              ...active.view,
              state: 'failed',
              error: event.error,
              completedAt: this.now(),
            });
          }
        }
        this.invalidateProvider(providerInstanceId);
      }
      if (!terminal && !this.closed && this.providerLogins.get(providerInstanceId) === active) {
        this.updateLoginView(providerInstanceId, active, {
          ...active.view,
          state: 'failed',
          error: 'Provider login stream ended before reporting a result.',
          completedAt: this.now(),
        });
        this.invalidateProvider(providerInstanceId);
      }
    } catch (error) {
      if (!this.closed && this.providerLogins.get(providerInstanceId) === active) {
        this.updateLoginView(providerInstanceId, active, {
          ...active.view,
          state: active.cancelRequested ? 'cancelled' : 'failed',
          ...(active.cancelRequested ? {} : { error: safeMessage(error) }),
          completedAt: this.now(),
        });
        this.invalidateProvider(providerInstanceId);
      }
    } finally {
      if (this.providerLogins.get(providerInstanceId) === active) {
        this.providerLogins.delete(providerInstanceId);
      }
      await active.operation.close().catch(() => undefined);
    }
  }

  private updateLoginView(
    providerInstanceId: string,
    active: ActiveProviderLogin,
    view: ProviderLoginOperationView,
  ) {
    active.view = view;
    this.projector.setLoginOperation(providerInstanceId, view);
  }

  private async refreshProvider(registration: NativeProviderRegistration) {
    const probe = await this.measure(
      'provider.probe',
      { providerInstanceId: registration.providerInstanceId },
      () => registration.adapter.probe(registration.providerInstanceId),
    );
    this.providerLastProbedAt.set(registration.providerInstanceId, this.now());
    this.journal.upsertProviderInstance({
      providerInstanceId: registration.providerInstanceId,
      provider: registration.provider,
      label: registration.label,
      probe,
      now: this.now(),
    });
    const models = probe.state === 'ready'
      ? await this.measure(
          'provider.models',
          { providerInstanceId: registration.providerInstanceId },
          () => registration.adapter.listModels(registration.providerInstanceId),
        ).catch(() => [])
      : [];
    this.projector.setModels(registration.providerInstanceId, models);
    if (probe.state === 'ready') {
      await this.discoverProviderHistory(registration, probe.capabilities);
      for (const conversation of this.journal.conversations()
        .filter(({ providerInstanceId }) => providerInstanceId === registration.providerInstanceId)) {
        this.journal.releaseBlockedMessages(conversation.conversationId);
        void this.dispatchNext(conversation.conversationId);
      }
    }
  }

  private wakeDurableQueues() {
    if (this.closed || !this.initialized) return;
    const providerInstanceIds = new Set<string>();
    for (const conversationId of this.journal.conversationsWithQueuedWork()) {
      const conversation = this.journal.conversation(conversationId);
      if (!conversation) continue;
      providerInstanceIds.add(conversation.providerInstanceId);
      void this.dispatchNext(conversationId);
    }
    if (providerInstanceIds.size > 0) {
      this.scheduleUnavailableProviderRefreshes(providerInstanceIds);
    }
  }

  private scheduleUnavailableProviderRefreshes(providerFilter?: ReadonlySet<string>) {
    const now = this.now();
    for (const instance of this.journal.listProviderInstances()) {
      if (providerFilter && !providerFilter.has(instance.providerInstanceId)) continue;
      if (instance.probe.state === 'ready' || this.providerLogins.has(instance.providerInstanceId)) continue;
      if (this.providerRefreshes.has(instance.providerInstanceId)) continue;
      const lastProbe = this.providerLastProbedAt.get(instance.providerInstanceId) ?? 0;
      if (now - lastProbe < UNAVAILABLE_PROVIDER_REPROBE_INTERVAL_MS) continue;
      const registration = this.providers.get(instance.providerInstanceId);
      if (!registration) continue;
      let refresh: Promise<void>;
      refresh = this.refreshProvider(registration)
        .then(() => this.invalidateProvider(instance.providerInstanceId))
        .catch(() => undefined)
        .finally(() => {
          if (this.providerRefreshes.get(instance.providerInstanceId) === refresh) {
            this.providerRefreshes.delete(instance.providerInstanceId);
          }
        });
      this.providerRefreshes.set(instance.providerInstanceId, refresh);
    }
  }

  private scheduleAccountUsageRefreshes() {
    const now = this.now();
    for (const instance of this.journal.listProviderInstances()) {
      if (instance.probe.state !== 'ready') continue;
      const registration = this.providers.get(instance.providerInstanceId);
      if (!registration?.adapter.readAccountUsage) continue;
      if (this.accountUsageRefreshes.has(instance.providerInstanceId)) continue;
      const lastRefresh = this.accountUsageLastRefreshedAt.get(instance.providerInstanceId) ?? 0;
      if (now - lastRefresh < ACCOUNT_USAGE_REFRESH_INTERVAL_MS) continue;
      this.accountUsageLastRefreshedAt.set(instance.providerInstanceId, now);
      let refresh: Promise<void>;
      refresh = this.measure(
        'provider.account-usage',
        { providerInstanceId: instance.providerInstanceId },
        () => registration.adapter.readAccountUsage!(instance.providerInstanceId),
      ).then((usage) => {
        if (!usage || this.closed) return;
        this.appendAccountUsage(instance.provider, instance.providerInstanceId, usage);
        this.onResourcesInvalidated([NATIVE_AGENT_RESOURCE_KEYS.providers]);
      }).catch(() => undefined).finally(() => {
        if (this.accountUsageRefreshes.get(instance.providerInstanceId) === refresh) {
          this.accountUsageRefreshes.delete(instance.providerInstanceId);
        }
      });
      this.accountUsageRefreshes.set(instance.providerInstanceId, refresh);
    }
  }

  private appendAccountUsage(
    provider: ProviderKind,
    providerInstanceId: string,
    usage: ProviderAccountUsage,
  ) {
    this.journal.appendProviderEvent(parseProviderEventEnvelope({
      contractVersion: PROVIDER_RUNTIME_CONTRACT_VERSION,
      eventId: `account-usage-read-${hashJson({ providerInstanceId, usage })}`,
      provider,
      scope: { kind: 'account', providerInstanceId },
      native: { kind: 'account/usage/read' },
      observedAt: usage.observedAt,
      event: { type: 'account.usage-updated', usage },
    }));
  }

  private scheduleFocusedContextRefresh(conversationId: string) {
    const conversation = this.journal.conversation(conversationId);
    if (!conversation || conversation.provider !== 'codex' || !conversation.resumable) return;
    if (this.sessions.has(conversation.rootExecutionId) ||
        this.openingSessions.has(conversation.rootExecutionId)) return;
    const now = this.now();
    const lastRefresh = this.contextLastRefreshedAt.get(conversation.rootExecutionId) ?? 0;
    if (now - lastRefresh < CONTEXT_REFRESH_INTERVAL_MS) return;
    this.contextLastRefreshedAt.set(conversation.rootExecutionId, now);
    void this.ensureSession(conversation).catch(() => {
      this.contextLastRefreshedAt.delete(conversation.rootExecutionId);
    });
  }

  private async discoverProviderHistory(
    registration: NativeProviderRegistration,
    capabilities: ProviderCapabilities | undefined,
  ) {
    if (!capabilities?.session.discoverHistory || !registration.adapter.discoverSessions) return;
    const model = this.projector.resolveModel(registration.providerInstanceId);
    if (!model) return;
    const discovered = await this.measure(
      'provider.history-index',
      { providerInstanceId: registration.providerInstanceId },
      () => registration.adapter.discoverSessions!({
        providerInstanceId: registration.providerInstanceId,
        limit: 100,
      }),
    ).catch(() => []);
    for (const summary of discovered) {
      if (summary.nativeSession.provider !== registration.provider ||
          summary.nativeSession.providerInstanceId !== registration.providerInstanceId ||
          !summary.nativeSession.sessionId.trim()) continue;
      const observedAt = this.now();
      const updatedAt = summary.updatedAt;
      const createdAt = Math.min(
        summary.createdAt ?? updatedAt ?? observedAt,
        updatedAt ?? observedAt,
      );
      const preview = (summary.preview ?? '').slice(0, 4_000);
      const title = (summary.title ?? preview.split('\n')[0] ?? '').trim().slice(0, 512) || 'Untitled chat';
      const sessionKey = `${registration.providerInstanceId}\0${summary.nativeSession.sessionId}`;
      const historyRevision = summary.historyRevision
        ?? (summary.updatedAt === undefined ? undefined : `updated-at:${updatedAt}`);
      this.journal.importDiscoveredConversation({
        conversationId: stableUuid(`discovered-conversation\0${sessionKey}`),
        rootExecutionId: stableUuid(`discovered-execution\0${sessionKey}`),
        nativeSession: summary.nativeSession,
        adapterVersion: capabilities.adapterVersion,
        title,
        preview,
        cwd: summary.cwd?.trim() || process.cwd(),
        model: model.id,
        ...(model.supportedEffort[0] ? { effort: model.supportedEffort[0] } : {}),
        ...(this.projector.resolveServiceTier(
          registration.providerInstanceId,
          model.id,
          null,
        ) ? {
          serviceTier: this.projector.resolveServiceTier(
            registration.providerInstanceId,
            model.id,
            null,
          )!,
        } : {}),
        access: 'workspace-write',
        ...(historyRevision ? { historyRevision } : {}),
        createdAt,
        observedAt,
        ...(updatedAt === undefined ? {} : { updatedAt }),
      });
    }
  }

  private async synchronizeConversationHistory(
    conversationId: string,
    policy: HistorySyncPolicy,
    signal?: AbortSignal,
  ) {
    const conversation = this.journal.conversation(conversationId);
    if (!conversation) return;
    if (!conversation.resumable || !this.historySynchronizationRequired(conversation, policy)) return;
    throwIfAborted(signal);
    let job = this.hydrationJobs.get(conversation.rootExecutionId);
    if (!job) {
      const controller = new AbortController();
      job = {
        conversationId,
        executionId: conversation.rootExecutionId,
        controller,
        promise: Promise.resolve(),
        waiters: 0,
        settled: false,
      };
      const current = job;
      current.promise = Promise.resolve()
        .then(() => this.runHistorySynchronization(conversation, policy, current.controller.signal))
        .finally(() => {
          current.settled = true;
          if (this.hydrationJobs.get(current.executionId) === current) {
            this.hydrationJobs.delete(current.executionId);
          }
        });
      this.hydrationJobs.set(current.executionId, current);
    }
    job.waiters += 1;
    try {
      await abortable(job.promise, signal);
    } finally {
      job.waiters -= 1;
      if (job.waiters === 0 && !job.settled) {
        job.controller.abort(new Error('No transcript reader is waiting for native history.'));
      }
    }
  }

  private async synchronizeNativeChildHistory(executionId: string, signal?: AbortSignal) {
    if (this.closed) return;
    const existing = this.childReconciliationJobs.get(executionId);
    if (existing) return abortable(existing, signal);
    const job = Promise.resolve().then(() => this.synchronizeNativeChildHistoryOwned(executionId))
      .finally(() => {
        if (this.childReconciliationJobs.get(executionId) === job) this.childReconciliationJobs.delete(executionId);
      });
    this.childReconciliationJobs.set(executionId, job);
    return abortable(job, signal);
  }

  private async synchronizeNativeChildHistoryOwned(executionId: string) {
    if (this.closed) return;
    const execution = this.journal.execution(executionId);
    if (!execution || execution.ownership !== 'native') return;
    const unfinished = execution.state === 'running' || execution.state === 'recovering' ||
      this.journal.turnsForExecution(executionId).some((turn) =>
        turn.state === 'running' || turn.state === 'recovering');
    if (!unfinished && this.journal.turnsForExecution(executionId).length > 0) return;
    const capabilities = this.requireCapabilities(execution.providerInstanceId);
    if (capabilities.collaboration.childTranscript === 'none') return;
    const handle = this.journal.nativeChildHandle(executionId);
    const conversation = this.journal.conversation(execution.conversationId);
    if (!handle || !conversation) return;
    if (unfinished) this.journal.markExecutionRecovering(executionId, this.now());
    this.journal.setExecutionLifecycleError(executionId, null, this.now());
    this.invalidateConversation(execution.conversationId, executionId);
    try {
      const session = await this.ensureSession(conversation);
      if (!session.snapshotChild) throw new Error('Native child reconciliation is unavailable.');
      const snapshot = await session.snapshotChild({
      commandId: stableUuid(`child-snapshot\0${executionId}\0${this.now()}`),
      childExecutionId: executionId,
      nativeSessionId: handle.nativeSessionId,
      });
      if (this.closed) return;
      this.journal.replaceSnapshot(snapshot.events, snapshot.coverage);
      this.observePersistedTerminals(snapshot.events, snapshot.authority);
      if (snapshot.state === 'running') this.journal.confirmExecutionRunning(executionId, this.now());
      this.journal.setExecutionLifecycleError(executionId, null, this.now());
      this.invalidateConversation(execution.conversationId, executionId);
    } catch (error) {
      this.journal.setExecutionLifecycleError(executionId, safeMessage(error), this.now());
      this.invalidateConversation(execution.conversationId, executionId);
      throw error;
    }
  }

  private historySynchronizationRequired(
    conversation: JournalConversation,
    policy: HistorySyncPolicy,
  ) {
    // Once a Remux turn owns the native lane, its event stream is the current
    // source of truth. Snapshot reconciliation resumes when that lane is idle.
    if (conversation.activeTurnId && conversation.history.state === 'ready') return false;
    if (conversation.history.state === 'indexed') return true;
    if (conversation.history.state === 'failed') return policy !== 'if-stale';
    if (conversation.history.state === 'loading') return true;
    if (conversation.history.nativeRevision &&
        conversation.history.nativeRevision !== conversation.history.syncedRevision) return true;
    const lastSyncedAt = conversation.history.lastSyncedAt;
    if (lastSyncedAt === undefined) return true;
    if (policy === 'initial') return false;
    if (policy === 'required-fresh') {
      return this.journal.turns(conversation.conversationId).length > 0;
    }
    return this.now() - lastSyncedAt >= HISTORY_REVALIDATE_INTERVAL_MS;
  }

  private async runHistorySynchronization(
    conversation: JournalConversation,
    policy: HistorySyncPolicy,
    signal: AbortSignal,
  ) {
    const existingSession = this.sessions.get(conversation.rootExecutionId);
    let session: ProviderSession | undefined;
    this.journal.setConversationHistoryState(conversation.conversationId, 'loading');
    this.invalidateConversation(conversation.conversationId, conversation.rootExecutionId);
    try {
      session = await this.measure(
        'history.session',
        {
          providerInstanceId: conversation.providerInstanceId,
          conversationId: conversation.conversationId,
          executionId: conversation.rootExecutionId,
        },
        () => this.ensureSession(conversation),
      );
      throwIfAborted(signal);
      const current = this.requireConversation(conversation.conversationId);
      const knownDirty = Boolean(
        current.history.nativeRevision &&
        current.history.nativeRevision !== current.history.syncedRevision,
      );
      if (
        policy === 'required-fresh' &&
        conversation.history.state === 'ready' &&
        !knownDirty &&
        current.history.lastSyncedAt !== undefined &&
        !session.readHistoryRevision &&
        this.now() - current.history.lastSyncedAt < HISTORY_REVALIDATE_INTERVAL_MS
      ) {
        // Adapters that cannot expose a cheap source revision still get a
        // bounded safety window. Initial/stale/failed history always takes a
        // full snapshot; consecutive local mutations do not reread a large
        // transcript that Remux has just observed through the live stream.
        this.journal.markConversationHistorySynced(conversation.conversationId, this.now());
        return;
      }
      let observedRevision: string | undefined;
      if (!knownDirty && current.history.lastSyncedAt !== undefined && session.readHistoryRevision) {
        observedRevision = await this.measure(
          'history.revision',
          {
            providerInstanceId: conversation.providerInstanceId,
            conversationId: conversation.conversationId,
            executionId: conversation.rootExecutionId,
            policy,
          },
          () => abortable(session!.readHistoryRevision!(), signal),
        ) ?? undefined;
        throwIfAborted(signal);
        if (observedRevision) {
          this.journal.observeConversationHistoryRevision(
            conversation.conversationId,
            observedRevision,
          );
          const refreshed = this.requireConversation(conversation.conversationId);
          if (refreshed.history.syncedRevision === observedRevision) {
            this.journal.markConversationHistorySynced(
              conversation.conversationId,
              this.now(),
              observedRevision,
            );
            return;
          }
        }
      }
      const snapshot = await this.measure(
        'history.snapshot',
        {
          providerInstanceId: conversation.providerInstanceId,
          conversationId: conversation.conversationId,
          executionId: conversation.rootExecutionId,
        },
        () => abortable(session!.snapshot({
          commandId: `history-read:${stableUuid(`${conversation.conversationId}\0${this.now()}`)}`,
        }), signal),
      );
      throwIfAborted(signal);
      const preparedSnapshotEvents = await this.prepareProviderEvents(
        conversation.conversationId,
        snapshot.events,
      );
      this.measureSync(
        'history.journal',
        {
          providerInstanceId: conversation.providerInstanceId,
          conversationId: conversation.conversationId,
          executionId: conversation.rootExecutionId,
          eventCount: snapshot.events.length,
        },
        () => snapshot.authority === 'session-local'
          ? this.journal.appendProviderEvents(preparedSnapshotEvents).length
          : this.journal.replaceSnapshot(preparedSnapshotEvents, snapshot.coverage),
      );
      this.observePersistedTerminals(preparedSnapshotEvents, snapshot.authority);
      await this.measure(
        'history.artifacts',
        {
          providerInstanceId: conversation.providerInstanceId,
          conversationId: conversation.conversationId,
          executionId: conversation.rootExecutionId,
          eventCount: snapshot.events.length,
        },
        () => this.sealTerminalOutputs(conversation.conversationId),
      );
      this.journal.markConversationHistorySynced(
        conversation.conversationId,
        this.now(),
        snapshot.historyRevision ?? observedRevision,
      );
    } catch (error) {
      if (isAbortError(error) || signal.aborted || this.closed) {
        if (!this.closed) {
          this.journal.setConversationHistoryState(conversation.conversationId, 'indexed');
        }
        throw abortError(signal.reason ?? error);
      }
      this.journal.setConversationHistoryState(
        conversation.conversationId,
        'failed',
        safeMessage(error),
      );
      throw error;
    } finally {
      if (session && !existingSession && policy !== 'required-fresh') {
        await this.releasePassiveHistorySession(conversation, session);
      }
      if (!this.closed) {
        this.invalidateConversation(conversation.conversationId, conversation.rootExecutionId);
      }
    }
  }

  private async closeProviderSessions(providerInstanceId: string) {
    const closing: ProviderSession[] = [];
    for (const [executionId, session] of this.sessions) {
      if (this.journal.execution(executionId)?.providerInstanceId !== providerInstanceId) continue;
      this.sessions.delete(executionId);
      this.sessionLastUsedAt.delete(executionId);
      this.federationBindings.get(executionId)?.revoke?.();
      this.federationBindings.delete(executionId);
      closing.push(session);
    }
    await Promise.allSettled(closing.map((session) => session.close()));
  }

  private async recoverAcceptedDeliveryStages() {
    let cursor = '';
    while (true) {
      const rows = this.journal.database.prepare(`SELECT attempt_id,execution_id FROM delivery_attempts a
        WHERE state='accepted' AND attempt_id>? AND EXISTS(
          SELECT 1 FROM delivery_attempt_staging s WHERE s.attempt_id=a.attempt_id)
        ORDER BY attempt_id LIMIT 256`).all(cursor) as Array<{ attempt_id: string; execution_id: string }>;
      if (rows.length === 0) break;
      for (const { attempt_id: attemptId, execution_id: executionId } of rows) {
      const attempt = this.deliveryOwner.acceptedWithStage(executionId);
      if (!attempt || attempt.attemptId !== attemptId) continue;
      const source = this.deliveryOwner.staged(attempt.attemptId);
      const prepared = await this.prepareStagedProviderEvents(attempt.conversationId, source);
      let inserted: readonly ProviderEventEnvelope[] = [];
      this.deliveryOwner.drainAccepted(
        attempt.attemptId,
        prepared.staged,
        prepared.sourceObservationIds,
        (events) => { inserted = this.journal.appendProviderEvents(events); },
      );
      await this.applyProviderEventEffects(attempt.conversationId, executionId, inserted);
      if (!this.journal.hasUnresolvedRootDelivery(attempt.conversationId)) {
        queueMicrotask(() => void this.dispatchNext(attempt.conversationId));
      }
      }
      cursor = rows.at(-1)!.attempt_id;
    }
  }

  private async reconcileRootDeliveryAttempts() {
    let cursorCreatedAt = -1;
    let cursorAttemptId = '';
    while (true) {
      const rows = this.journal.database.prepare(`SELECT attempt_id,created_at FROM delivery_attempts
        WHERE kind='root-turn' AND state='unknown'
          AND (created_at>? OR (created_at=? AND attempt_id>?))
        ORDER BY created_at,attempt_id LIMIT 256`).all(
          cursorCreatedAt, cursorCreatedAt, cursorAttemptId,
        ) as Array<{ attempt_id: string; created_at: number }>;
      if (rows.length === 0) break;
      for (const { attempt_id: attemptId } of rows) {
      const attempt = this.deliveryOwner.get(attemptId);
      if (!attempt) continue;
      const registration = this.providers.get(attempt.providerInstanceId);
      if (!attempt.acceptanceEvidence && !registration?.adapter.readTurnPresence) continue;
      const conversation = this.journal.conversation(attempt.conversationId);
      if (!conversation) continue;
      let inserted: readonly ProviderEventEnvelope[] = [];
      const result = await this.deliveryOwner.reconcile(
        attemptId,
        attempt.acceptanceEvidence
          ? async () => ({ presence: 'unknown' as const, reason: 'Durable positive evidence already exists.' })
          : () => registration!.adapter.readTurnPresence!({
              providerInstanceId: attempt.providerInstanceId,
              cwd: conversation.cwd,
              nativeSessionId: attempt.nativeSessionId,
              nativeClientMessageId: attempt.nativeClientMessageId!,
            }),
        (accepted, staged) => {
          const admitted = this.journal.admitQueuedTurn(
            accepted.intendedTurnId!,
            this.now(),
            accepted.nativeTurnId,
          );
          if (!admitted && !this.journal.turn(accepted.intendedTurnId!)) {
            throw new Error('Queued message disappeared before recovered acceptance was admitted.');
          }
          inserted = this.journal.appendProviderEvents(staged.map(({ envelope }) => envelope));
          return admitted;
        },
        (staged) => this.prepareStagedProviderEvents(attempt.conversationId, staged),
      );
      if (result.outcome === 'accepted') {
        await this.applyProviderEventEffects(attempt.conversationId, attempt.executionId, inserted);
      }
      }
      const last = rows.at(-1)!;
      cursorCreatedAt = last.created_at;
      cursorAttemptId = last.attempt_id;
    }
  }

  private async steer(input: NativeMessageSendCommand, conversation: JournalConversation) {
    const activeTurnId = conversation.activeTurnId!;
    this.journal.transaction(() => {
      this.journal.grantImageContent({
        scope: { conversationId: conversation.conversationId, executionId: conversation.rootExecutionId },
        content: input.content,
        provenance: 'viewer-message',
        sourceTurnId: activeTurnId,
        createdAt: this.now(),
      });
      this.journal.markCommandDispatching(input.commandId, this.now());
    });
    try {
      const session = await this.ensureSession(conversation);
      await session.steer!({
        commandId: input.commandId,
        turnId: activeTurnId,
        content: input.content,
      });
      const result: NativeMessageSendResult = {
        accepted: true,
        commandId: input.commandId,
        turnId: activeTurnId,
        delivery: 'steered',
      };
      this.journal.acceptCommand(input.commandId, result, this.now());
      return result;
    } catch (error) {
      this.journal.rejectCommand(input.commandId, safeMessage(error), this.now());
      throw error;
    }
  }

  private async dispatchCompaction(
    conversation: JournalConversation,
    session: ProviderSession,
    operationId: string,
  ) {
    if (!session.compact) {
      const error = coordinatorError('native_command_unavailable', 'Native Compact is unavailable in this session.');
      this.appendCoordinatorCompactionEvent(conversation, {
        type: 'context.compaction.failed',
        trigger: 'manual',
        operationId,
        error: { code: error.errorCode, message: error.message },
      }, `failed:${operationId}`);
      throw error;
    }
    this.appendCoordinatorCompactionEvent(conversation, {
      type: 'context.compaction.started',
      trigger: 'manual',
      operationId,
      beforeTokens: this.journal.latestUsage(conversation.conversationId)?.context?.usedTokens ?? null,
    }, `started:${operationId}`);
    try {
      const acceptance = await session.compact({
        commandId: operationId,
        conversationId: conversation.conversationId,
        executionId: conversation.rootExecutionId,
      });
      if (acceptance.nativeOperationId) {
        this.journal.setCompactionNativeOperationId(operationId, acceptance.nativeOperationId, this.now());
      }
    } catch (error) {
      const displayError = {
        code: error instanceof NativeCoordinatorError ? error.errorCode : 'native_command_failed',
        message: safeMessage(error),
        retryable: true,
      };
      this.appendCoordinatorCompactionEvent(conversation, {
        type: 'context.compaction.failed',
        trigger: 'manual',
        operationId,
        error: displayError,
      }, `failed:${operationId}`);
      throw error;
    }
  }

  private appendCoordinatorCompactionEvent(
    conversation: JournalConversation,
    event: Extract<ProviderEvent, { type: `context.compaction.${string}` }>,
    identity: string,
  ) {
    const nativeSession = this.journal.nativeSession(conversation.rootExecutionId);
    if (!nativeSession) {
      throw new Error('Conversation native session reference is missing.');
    }
    this.journal.appendProviderEvent(parseProviderEventEnvelope({
      contractVersion: PROVIDER_RUNTIME_CONTRACT_VERSION,
      eventId: stableUuid(`coordinator-compaction\0${identity}`),
      provider: conversation.provider,
      scope: {
        kind: 'conversation',
        providerInstanceId: conversation.providerInstanceId,
        conversationId: conversation.conversationId,
        executionId: conversation.rootExecutionId,
      },
      native: {
        sessionId: nativeSession.sessionId,
        kind: `remux/${event.type}`,
      },
      observedAt: this.now(),
      event,
    }));
  }

  private async dispatchNext(conversationId: string) {
    if (this.closed || !this.initialized) return;
    if (this.dispatchingConversations.has(conversationId)) {
      this.pendingDispatchConversations.add(conversationId);
      return;
    }
    this.dispatchingConversations.add(conversationId);
    try {
      const conversation = this.requireConversation(conversationId);
      if (conversation.activeTurnId) return;
      if (this.journal.hasConversationQueuePause(conversationId)) return;
      const compaction = this.journal.latestCompactionOperation(conversationId);
      if (compaction?.state === 'running') return;
      const provider = this.journal.providerInstance(conversation.providerInstanceId);
      if (provider?.probe.state !== 'ready') {
        if (this.journal.blockQueuedMessages(conversationId) > 0) {
          this.invalidateConversation(conversationId);
        }
        return;
      }
      if (this.journal.hasUnresolvedRootDelivery(conversationId)) return;
      this.journal.releaseBlockedMessages(conversationId);
      const queued = this.journal.claimNext(conversationId, this.now());
      if (!queued) return;
      if (queued.kind === 'compact') {
        try {
          const refreshed = this.requireConversation(conversationId);
          const session = await this.ensureSession(refreshed);
          await this.dispatchCompaction(refreshed, session, queued.operationId);
        } catch (error) {
          this.journal.failCompaction(queued.operationId, {
            code: error instanceof NativeCoordinatorError ? error.errorCode : 'native_command_failed',
            message: safeMessage(error),
            retryable: true,
          }, this.now());
          queueMicrotask(() => void this.dispatchNext(conversationId));
        } finally {
          this.invalidateConversation(conversationId);
        }
        return;
      }
      let deliveryAccepted = false;
      try {
        const refreshed = this.requireConversation(conversationId);
        const session = await this.ensureSession(refreshed);
        const nativeSession = session.nativeSession;
        const nativeClientMessageId = refreshed.provider === 'claude-code'
          ? stableUuid(`claude-user\0${queued.commandId}`) : queued.turnId;
        const attempt = this.journal.transaction(() => this.deliveryOwner.prepare({
          commandId: queued.commandId, kind: 'root-turn', provider: refreshed.provider,
          providerInstanceId: refreshed.providerInstanceId, conversationId,
          executionId: refreshed.rootExecutionId, intendedTurnId: queued.turnId,
          clientMessageId: queued.clientMessageId, nativeClientMessageId,
          recoveryPayload: { turnId: queued.turnId, clientMessageId: queued.clientMessageId,
            nativeClientMessageId, content: queued.content, model: queued.model,
            ...(queued.effort ? { effort: queued.effort } : {}),
            ...(queued.serviceTier ? { serviceTier: queued.serviceTier } : {}), access: queued.access },
          nativeSessionId: nativeSession.sessionId, ownerInstanceId: this.deliveryOwnerInstanceId,
          now: this.now(),
        }));
        let admittedEvents: readonly ProviderEventEnvelope[] = [];
        const outcome = await this.deliveryOwner.dispatch(attempt.attemptId, (boundary) =>
          session.startTurn({
            commandId: queued.commandId,
            conversationId,
            turnId: queued.turnId,
            executionId: refreshed.rootExecutionId,
            content: queued.content,
            model: queued.model,
            ...(queued.effort ? { effort: queued.effort } : {}),
            ...(queued.serviceTier ? { serviceTier: queued.serviceTier } : {}),
          }, boundary), (accepted, staged) => {
            const admitted = this.journal.admitQueuedTurn(queued.turnId, this.now(), accepted.nativeTurnId);
            if (!admitted && !this.journal.turn(queued.turnId)) throw new Error('Queued message disappeared before provider acceptance was admitted.');
            admittedEvents = this.journal.appendProviderEvents(staged.map(({ envelope }) => envelope));
            return admitted;
          }, (staged) => this.prepareStagedProviderEvents(conversationId, staged));
        if (outcome.outcome !== 'accepted') throw new Error(`Provider delivery ${outcome.outcome}.`);
        deliveryAccepted = true;
        await this.applyProviderEventEffects(conversationId, refreshed.rootExecutionId, admittedEvents);
      } catch (error) {
        // Once native dispatch begins, a transport failure may have happened
        // after provider acceptance. Keep an explicit blocking record instead
        // of silently retrying a coding action or advancing the FIFO.
        if (!deliveryAccepted) this.journal.markQueuedTurnDeliveryUnknown(queued.turnId);
        if (!deliveryAccepted && this.journal.turn(queued.turnId)) {
          this.journal.failTurnDispatch(queued.turnId, safeMessage(error), this.now());
        }
      } finally {
        this.invalidateConversation(conversationId);
      }
    } finally {
      this.dispatchingConversations.delete(conversationId);
      for (const intent of this.journal.outstandingStopIntents()) {
        if (intent.conversation_id === conversationId && typeof intent.intent_id === 'string') {
          void this.processStopIntent(intent.intent_id);
        }
      }
      if (this.pendingDispatchConversations.delete(conversationId)) {
        queueMicrotask(() => void this.dispatchNext(conversationId));
      }
    }
  }

  private async recoverConversation(conversation: JournalConversation) {
    // Delivery recovery owns this lane until an ownership-free positive read
    // proves native acceptance. Opening or resuming a writer here would cross
    // the same root boundary a second time merely to inspect it.
    if (this.journal.hasUnresolvedRootDelivery(conversation.conversationId)) return;
    const executionId = conversation.rootExecutionId;
    if (!this.journal.markConversationRecovering(
      conversation.conversationId,
      undefined,
      this.now(),
      executionId,
    )) return;
    try {
      const registration = this.requireReadyProvider(conversation.providerInstanceId);
      const nativeSession = this.journal.nativeSession(executionId);
      if (!nativeSession) throw new Error('Conversation has no native session reference.');
      const mode = this.recoveryMode(registration, executionId);
      await this.openAttachedSession(
        conversation.conversationId,
        executionId,
        () => this.openSession(
          conversation,
          registration,
          mode,
          mode === 'resume' ? nativeSession : undefined,
        ),
      );
      await this.reconcile(conversation.conversationId, executionId);
      if (this.journal.conversation(conversation.conversationId)?.rootExecutionId === executionId) {
        this.terminateAmbiguousCompaction(conversation.conversationId);
      }
    } catch (error) {
      if (this.journal.conversation(conversation.conversationId)?.rootExecutionId === executionId) {
        this.terminateAmbiguousCompaction(conversation.conversationId, safeMessage(error));
      }
      this.journal.failRecovery(
        conversation.conversationId,
        safeMessage(error),
        this.now(),
        executionId,
      );
      if (conversation.activeTurnId) {
        this.journal.markQueuedTurnDeliveryUnknown(conversation.activeTurnId);
      }
      this.invalidateConversation(conversation.conversationId);
    }
  }

  private terminateAmbiguousCompaction(conversationId: string, recoveryError?: string) {
    const marked = this.journal.markRunningCompactionDeliveryUnknown(conversationId, {
      code: 'compaction_delivery_unknown',
      message: recoveryError
        ? `The provider stream was lost during native compaction and recovery could not prove its outcome: ${recoveryError}`
        : 'The provider stream was lost during native compaction and its authoritative snapshot did not prove completion.',
      retryable: true,
    }, this.now());
    if (!marked) return;
    this.invalidateConversation(conversationId);
    queueMicrotask(() => void this.dispatchNext(conversationId));
  }

  private async recoverFederatedExecution(execution: JournalExecution) {
    this.journal.markExecutionRecovering(execution.executionId, this.now());
    try {
      const session = await this.ensureExecutionSession(execution);
      const snapshot = await session.snapshot({
        commandId: `reconcile:${stableUuid(`${execution.executionId}\0${this.now()}`)}`,
      });
      const prepared = await this.prepareProviderEvents(execution.conversationId, snapshot.events);
      if (snapshot.authority === 'session-local') this.journal.appendProviderEvents(prepared);
      else this.journal.replaceSnapshot(prepared, snapshot.coverage);
      this.observePersistedTerminals(prepared, snapshot.authority);
      if (snapshot.state === 'running') {
        this.journal.confirmExecutionRunning(execution.executionId, this.now());
      }
      await this.sealTerminalOutputs(execution.conversationId, execution.executionId);
      const refreshed = this.requireFederatedExecution(execution.executionId);
      const activeTurn = this.activeExecutionTurn(execution.executionId);
      if (snapshot.state === 'idle' && activeTurn) {
        throw new Error(
          snapshot.authority === 'session-local'
            ? 'Native provider resumed without the durable binding needed to recover the accepted federated turn.'
            : 'Native provider is idle but the accepted federated turn is absent from its authoritative snapshot.',
        );
      }
      if (refreshed.state !== 'running' && refreshed.state !== 'recovering') {
        this.finalizeFederatedExecution(refreshed.executionId);
      }
      this.invalidateConversation(refreshed.conversationId, refreshed.executionId, activeTurn?.turnId);
    } catch (error) {
      this.journal.failExecution(execution.executionId, safeMessage(error), this.now());
      this.finalizeFederatedExecution(execution.executionId);
      this.invalidateConversation(execution.conversationId, execution.executionId);
    }
  }

  private async ensureSession(conversation: JournalConversation) {
    if (!conversation.resumable) throw new Error('Conversation has no resumable native session.');
    const existing = this.sessions.get(conversation.rootExecutionId);
    if (existing) {
      this.touchSession(conversation.rootExecutionId);
      return existing;
    }
    const nativeSession = this.journal.nativeSession(conversation.rootExecutionId);
    if (!nativeSession) throw new Error('Conversation native session reference is missing.');
    const registration = this.requireReadyProvider(conversation.providerInstanceId);
    const mode = this.recoveryMode(registration, conversation.rootExecutionId);
    return this.openAttachedSession(
      conversation.conversationId,
      conversation.rootExecutionId,
      () => this.openSession(
        conversation,
        registration,
        mode,
        mode === 'resume' ? nativeSession : undefined,
      ),
    );
  }

  private async ensureExecutionSession(execution: JournalExecution, launchCwd?: string) {
    const existing = this.sessions.get(execution.executionId);
    if (existing) {
      this.touchSession(execution.executionId);
      return existing;
    }
    if (this.journal.nativeSessionState(execution.executionId) === 'closed') {
      throw new Error('Federated child is closed and cannot be resumed.');
    }
    const nativeSession = this.journal.nativeSession(execution.executionId);
    if (!nativeSession) throw new Error('Federated execution has no resumable native session.');
    const conversation = this.requireConversation(execution.conversationId);
    const registration = this.requireReadyProvider(execution.providerInstanceId);
    const mode = this.recoveryMode(registration, execution.executionId);
    return this.openAttachedSession(conversation.conversationId, execution.executionId, () =>
      this.openExecutionSession({
        conversation,
        executionId: execution.executionId,
        registration,
        mode,
        ...(mode === 'resume' ? { nativeSession } : {}),
        model: execution.model ?? conversation.model,
        effort: execution.effort,
        serviceTier: execution.serviceTier ?? conversation.serviceTier ?? undefined,
        access: execution.access ?? conversation.access,
        ...(launchCwd ? { launchCwd } : {}),
      }));
  }

  /**
   * Claude accepts a caller-selected UUID before its first prompt, but that ID
   * is not resumable until Claude emits system/init and persists the transcript.
   * Recreate only that unmaterialized shell; every authoritative native session
   * still follows the provider resume path.
   */
  private recoveryMode(
    registration: NativeProviderRegistration,
    executionId: string,
  ): 'create' | 'resume' {
    return registration.provider === 'claude-code' &&
      !this.journal.nativeSessionMaterialized(executionId)
      ? 'create'
      : 'resume';
  }

  private async openSession(
    conversation: JournalConversation,
    registration: NativeProviderRegistration,
    mode: 'create' | 'resume' | 'attach',
    nativeSession = mode === 'create'
      ? undefined
      : this.journal.nativeSession(conversation.rootExecutionId),
  ) {
    return this.openExecutionSession({
      conversation,
      executionId: conversation.rootExecutionId,
      registration,
      mode,
      ...(nativeSession ? { nativeSession } : {}),
      model: conversation.model,
      effort: conversation.effort,
      serviceTier: conversation.serviceTier ?? undefined,
      access: conversation.access,
    });
  }

  private async openExecutionSession(input: {
    conversation: JournalConversation;
    executionId: string;
    registration: NativeProviderRegistration;
    mode: 'create' | 'resume' | 'attach';
    nativeSession?: NativeSessionRef;
    model: string;
    effort?: string;
    serviceTier?: string;
    access: ProviderAccess;
    launchCwd?: string;
  }) {
    if (!this.checkoutReconciled) {
      throw new Error('Federation credentials are unavailable until checkout reconciliation completes.');
    }
    const binding = await this.federationForSession?.({
      conversationId: input.conversation.conversationId,
      executionId: input.executionId,
      providerInstanceId: input.registration.providerInstanceId,
    });
    try {
      const execution = this.journal.execution(input.executionId);
      const nativeTurnBindings = this.journal.turnsForExecution(input.executionId)
        .filter((turn) => turn.nativeTurnId &&
          (execution?.ownership !== 'root' || !execution.strandId || turn.pathEntryId))
        .map((turn) => {
          const binding = this.journal.nativeTurnBinding(input.executionId, turn.turnId);
          return {
            turnId: turn.turnId,
            nativeTurnId: turn.nativeTurnId!,
            nextBlockOrdinal: this.journal.nextTurnBlockOrdinal(turn.turnId),
            ...(binding?.branchCursor === null || binding?.branchCursor === undefined ? {} : {
              branchCursor: binding.branchCursor as import('../../../shared/provider-runtime.ts').JsonValue,
            }),
          };
        });
      const inheritedNativeTurnIds = execution?.strandId
        ? [...new Set(this.journal.turnsForStrand(execution.strandId)
          .filter((turn) => turn.executionId !== input.executionId && turn.nativeTurnId)
          .map((turn) => turn.nativeTurnId!))]
        : [];
      const activeTurnBinding = this.journal.turnsForExecution(input.executionId)
        .filter((turn) => turn.nativeTurnId &&
          (turn.state === 'running' || turn.state === 'recovering'))
        .map((turn) => ({ turnId: turn.turnId, nativeTurnId: turn.nativeTurnId! }))
        .at(-1);
      const nativeChildBindings = input.nativeSession
        ? this.journal.nativeChildBindings(input.executionId, input.nativeSession.sessionId)
        : [];
      const session = await this.measure(
        'session.open',
        {
          providerInstanceId: input.registration.providerInstanceId,
          conversationId: input.conversation.conversationId,
          executionId: input.executionId,
        },
        () => input.registration.adapter.openSession({
          commandId: `session-open:${input.executionId}:${input.mode}`,
          providerInstanceId: input.registration.providerInstanceId,
          conversationId: input.conversation.conversationId,
          executionId: input.executionId,
          mode: input.mode,
          ...(input.nativeSession ? { nativeSession: input.nativeSession } : {}),
          cwd: input.launchCwd ?? input.conversation.cwd,
          model: input.model,
          ...(input.effort ? { effort: input.effort } : {}),
          ...(input.serviceTier ? { serviceTier: input.serviceTier } : {}),
          access: input.access,
          developerInstructions: developerInstructionsForExecution(
            this.journal.execution(input.executionId),
          ),
          ...(input.mode !== 'create' && nativeTurnBindings.length > 0
            ? { nativeTurnBindings }
            : {}),
          ...(input.mode !== 'create' && nativeChildBindings.length > 0
            ? { nativeChildBindings }
            : {}),
          ...(input.mode !== 'create' && inheritedNativeTurnIds.length > 0
            ? { inheritedNativeTurnIds }
            : {}),
          ...(input.mode !== 'create' && activeTurnBinding ? { activeTurnBinding } : {}),
          ...(binding ? {
            federation: {
              endpoint: binding.endpoint,
              authorizationHeader: binding.authorizationHeader,
            },
          } : {}),
        }),
      );
      const capabilities = this.requireCapabilities(input.registration.providerInstanceId);
      this.journal.bindNativeSession({
        executionId: input.executionId,
        nativeSession: session.nativeSession,
        adapterVersion: capabilities.adapterVersion,
        now: this.now(),
      });
      binding?.bindNativeSession?.(session.nativeSession);
      const previous = this.federationBindings.get(input.executionId);
      previous?.revoke?.();
      if (binding) {
        this.federationBindings.set(input.executionId, {
          ...(binding.touch ? { touch: binding.touch } : {}),
          ...(binding.revoke ? { revoke: binding.revoke } : {}),
        });
      }
      return session;
    } catch (error) {
      binding?.revoke?.();
      throw error;
    }
  }

  private attachSession(conversationId: string, executionId: string, session: ProviderSession) {
    const previous = this.sessions.get(executionId);
    if (previous && previous !== session) void previous.close();
    this.sessions.set(executionId, session);
    this.touchSession(executionId);
    let consumer: Promise<void>;
    consumer = this.consumeEvents(conversationId, executionId, session).finally(async () => {
      const ownsSession = this.sessions.get(executionId) === session;
      if (ownsSession) {
        this.sessions.delete(executionId);
        this.sessionLastUsedAt.delete(executionId);
      }
      if (this.consumers.get(executionId) === consumer) this.consumers.delete(executionId);
      if (!ownsSession || this.closed) return;
      this.federationBindings.get(executionId)?.revoke?.();
      this.federationBindings.delete(executionId);
      await session.close().catch(() => undefined);
      if (this.closed) return;
      await this.recoverAfterStreamLoss(conversationId, executionId);
    });
    this.consumers.set(executionId, consumer);
    void this.evictIdleSessions();
  }

  private async recoverAfterStreamLoss(conversationId: string, executionId: string) {
    const conversation = this.journal.conversation(conversationId);
    const execution = this.journal.execution(executionId);
    const isRoot = conversation?.rootExecutionId === executionId;
    const isFederated = execution?.ownership === 'federated';
    if ((isRoot && conversation.state !== 'recovering') ||
        (isFederated && execution.state !== 'recovering') ||
        (!isRoot && !isFederated)) return;

    const attempts = (this.automaticRecoveryAttempts.get(executionId) ?? 0) + 1;
    if (attempts > MAX_AUTOMATIC_STREAM_RECOVERIES) {
      this.automaticRecoveryAttempts.delete(executionId);
      if (isRoot) {
        this.journal.failRecovery(
          conversationId,
          REPEATED_STREAM_LOSS_MESSAGE,
          this.now(),
          executionId,
        );
      } else {
        this.journal.failExecution(executionId, REPEATED_STREAM_LOSS_MESSAGE, this.now());
        this.finalizeFederatedExecution(executionId);
      }
      this.invalidateConversation(conversationId, executionId);
      return;
    }

    this.automaticRecoveryAttempts.set(executionId, attempts);
    this.automaticRecoveryProbation.add(executionId);
    try {
      if (isRoot) await this.recoverConversation(conversation);
      else if (execution) await this.recoverFederatedExecution(execution);
    } finally {
      this.automaticRecoveryProbation.delete(executionId);
      const refreshed = this.journal.execution(executionId);
      if (!refreshed || ['completed', 'failed', 'interrupted'].includes(refreshed.state)) {
        this.automaticRecoveryAttempts.delete(executionId);
      }
    }
  }

  private async openAttachedSession(
    conversationId: string,
    executionId: string,
    open: () => Promise<ProviderSession>,
  ) {
    const existing = this.sessions.get(executionId);
    if (existing) {
      this.touchSession(executionId);
      return existing;
    }
    const conversation = this.journal.conversation(conversationId);
    if (conversation?.rootExecutionId === executionId &&
        this.journal.hasUnresolvedRootDelivery(conversationId)) {
      throw new Error('Native writer opening is fenced by unresolved root delivery.');
    }
    const pending = this.openingSessions.get(executionId);
    if (pending) {
      const session = await pending;
      this.touchSession(executionId);
      return session;
    }
    const opening = (async () => {
      const session = await open();
      if (this.closed) {
        await session.close().catch(() => undefined);
        throw new Error('Native Agent coordinator is closed.');
      }
      this.attachSession(conversationId, executionId, session);
      return session;
    })();
    this.openingSessions.set(executionId, opening);
    try {
      return await opening;
    } finally {
      if (this.openingSessions.get(executionId) === opening) this.openingSessions.delete(executionId);
    }
  }

  private touchSession(executionId: string) {
    this.sessionLastUsedAt.set(executionId, this.now());
  }

  private async releasePassiveHistorySession(
    conversation: JournalConversation,
    session: ProviderSession,
  ) {
    const refreshed = this.journal.conversation(conversation.conversationId);
    const compaction = this.journal.latestCompactionOperation(conversation.conversationId);
    if (!refreshed || refreshed.activeTurnId ||
        this.journal.queuedEntries(conversation.conversationId).length > 0 ||
        compaction?.state === 'running') return;
    await this.detachAndCloseSession(conversation.rootExecutionId, session);
  }

  private async evictIdleSessions() {
    if (this.closed || this.sessions.size === 0) return;
    const now = this.now();
    const candidates = [...this.sessions.entries()].flatMap(([executionId, session]) => {
      if (this.hydrationJobs.has(executionId) || this.openingSessions.has(executionId)) return [];
      const execution = this.journal.execution(executionId);
      if (!execution || execution.state === 'running' || execution.state === 'recovering') return [];
      const conversation = this.journal.conversation(execution.conversationId);
      if (!conversation || conversation.activeTurnId) return [];
      if (executionId === conversation.rootExecutionId &&
          this.journal.queuedEntries(conversation.conversationId).length > 0) return [];
      const lastUsedAt = this.sessionLastUsedAt.get(executionId) ?? now;
      return [{ executionId, session, lastUsedAt }];
    }).sort((left, right) => left.lastUsedAt - right.lastUsedAt);
    const overLimit = Math.max(0, this.sessions.size - MAX_IDLE_PROVIDER_SESSIONS);
    const selected = new Map<string, ProviderSession>();
    for (const candidate of candidates.slice(0, overLimit)) {
      selected.set(candidate.executionId, candidate.session);
    }
    for (const candidate of candidates) {
      if (now - candidate.lastUsedAt >= IDLE_PROVIDER_SESSION_TTL_MS) {
        selected.set(candidate.executionId, candidate.session);
      }
    }
    await Promise.allSettled([...selected].map(([executionId, session]) =>
      this.detachAndCloseSession(executionId, session)));
  }

  private async detachAndCloseSession(executionId: string, session: ProviderSession) {
    if (this.sessions.get(executionId) !== session) return;
    this.sessions.delete(executionId);
    this.sessionLastUsedAt.delete(executionId);
    this.federationBindings.get(executionId)?.revoke?.();
    this.federationBindings.delete(executionId);
    await session.close().catch(() => undefined);
  }

  private async consumeEvents(conversationId: string, executionId: string, session: ProviderSession) {
    try {
      for await (const event of session.events) {
        if (isStreamingTextRevision(event)) {
          // Provider SDKs frequently deliver one delta per task. Give the rest of
          // that burst a tiny window to arrive so SQLite persists a display
          // checkpoint, not a transaction for every token. The viewer paints at
          // a coarser cadence, so this does not add a visible frame of latency.
          await new Promise<void>((resolve) => setTimeout(resolve, PROVIDER_TEXT_CHECKPOINT_MS));
        }
        const events = [
          event,
          ...drainBufferedProviderEvents(session.events, MAX_PROVIDER_EVENT_BATCH - 1),
        ];
        await this.consumeEventBatchResilient(
          conversationId,
          executionId,
          coalesceStreamingTextCheckpoints(events),
        );
      }
      if (!this.closed && this.sessions.get(executionId) === session) {
        const error = 'Native provider event stream ended before the session was closed.';
        this.publishDiagnostic('session.events', Date.now(), 'failed', {
          conversationId,
          executionId,
          error,
        });
        if (this.journal.conversation(conversationId)?.rootExecutionId === executionId) {
          this.journal.markConversationRecovering(
            conversationId,
            error,
            this.now(),
            executionId,
          );
        } else {
          this.journal.markExecutionRecovering(executionId, this.now());
        }
        this.invalidateConversation(conversationId, executionId);
      }
    } catch (error) {
      if (!this.closed && this.sessions.get(executionId) === session) {
        this.publishDiagnostic('session.events', Date.now(), 'failed', {
          conversationId,
          executionId,
          error: safeMessage(error),
        });
        if (this.journal.conversation(conversationId)?.rootExecutionId === executionId) {
          this.journal.markConversationRecovering(
            conversationId,
            safeMessage(error),
            this.now(),
            executionId,
          );
        } else {
          this.journal.markExecutionRecovering(executionId, this.now());
        }
        this.invalidateConversation(conversationId, executionId);
      }
    }
  }

  private async consumeEventBatchResilient(
    conversationId: string,
    executionId: string,
    events: readonly ProviderEventEnvelope[],
  ): Promise<void> {
    try {
      await this.consumeEventBatch(conversationId, executionId, events);
    } catch (error) {
      if (events.length > 1) {
        const midpoint = Math.floor(events.length / 2);
        await this.consumeEventBatchResilient(
          conversationId,
          executionId,
          events.slice(0, midpoint),
        );
        await this.consumeEventBatchResilient(
          conversationId,
          executionId,
          events.slice(midpoint),
        );
        return;
      }
      const event = events[0];
      this.publishDiagnostic('session.event-ingest', Date.now(), 'failed', {
        conversationId,
        executionId,
        eventId: event?.eventId,
        eventType: event?.event.type,
        nativeKind: event?.native.kind,
        error: safeMessage(error),
      });
    }
  }

  private async consumeEventBatch(
    conversationId: string,
    executionId: string,
    events: readonly ProviderEventEnvelope[],
  ): Promise<void> {
    this.touchSession(executionId);
    const acceptedSuffix = this.deliveryOwner.acceptedWithStage(executionId);
    if (acceptedSuffix) {
      const declaredChildren = new Set(events.flatMap((event) => {
        if (event.scope.kind !== 'turn' || event.scope.executionId !== acceptedSuffix.executionId ||
            event.scope.turnId !== acceptedSuffix.intendedTurnId ||
            (event.event.type !== 'turn.block.started' && event.event.type !== 'turn.block.revised' &&
              event.event.type !== 'turn.block.completed')) return [];
        const payload = event.event.block.payload;
        return payload.kind === 'native-child' ? [payload.child.executionId] : [];
      }));
      const dependent = events.filter((event) => event.scope.kind !== 'account' &&
        event.scope.conversationId === acceptedSuffix.conversationId &&
        ((event.scope.executionId === acceptedSuffix.executionId &&
          (event.scope.kind !== 'turn' || event.scope.turnId === acceptedSuffix.intendedTurnId)) ||
          declaredChildren.has(event.scope.executionId) ||
          this.deliveryOwner.ownsObservation(acceptedSuffix.attemptId, event)));
      for (const event of dependent) this.deliveryOwner.observe(acceptedSuffix.attemptId, event);
      events = events.filter((event) => !dependent.includes(event));
      const source = this.deliveryOwner.staged(acceptedSuffix.attemptId);
      const prepared = await this.prepareStagedProviderEvents(conversationId, source);
      let inserted: readonly ProviderEventEnvelope[] = [];
      this.deliveryOwner.drainAccepted(
        acceptedSuffix.attemptId,
        prepared.staged,
        prepared.sourceObservationIds,
        (suffix) => { inserted = this.journal.appendProviderEvents(suffix); },
      );
      await this.applyProviderEventEffects(conversationId, executionId, inserted);
      if (!this.journal.hasUnresolvedRootDelivery(conversationId)) {
        queueMicrotask(() => void this.dispatchNext(conversationId));
      }
      if (events.length === 0) return;
    }
    const unresolved = this.deliveryOwner.unresolvedLane(conversationId);
    if (unresolved?.kind === 'root-turn' && unresolved.executionId === executionId) {
      const declaredChildren = new Set(events.flatMap((event) => {
        if (event.scope.kind !== 'turn' || event.scope.turnId !== unresolved.intendedTurnId ||
            (event.event.type !== 'turn.block.started' && event.event.type !== 'turn.block.revised' &&
              event.event.type !== 'turn.block.completed')) return [];
        const payload = event.event.block.payload;
        return payload.kind === 'native-child' ? [payload.child.executionId] : [];
      }));
      const dependent = events.filter((event) => event.scope.kind !== 'account' &&
        ((event.scope.executionId === unresolved.executionId &&
          (event.scope.kind !== 'turn' || event.scope.turnId === unresolved.intendedTurnId)) ||
          declaredChildren.has(event.scope.executionId) ||
          this.deliveryOwner.ownsObservation(unresolved.attemptId, event)));
      for (const event of dependent) this.deliveryOwner.observe(unresolved.attemptId, event);
      const session = this.sessions.get(executionId);
      if (session?.readTurnPresence && unresolved.nativeClientMessageId) {
        let admittedEvents: readonly ProviderEventEnvelope[] = [];
        const result = await this.deliveryOwner.reconcile(
          unresolved.attemptId,
          () => session.readTurnPresence!(unresolved.nativeClientMessageId!),
          (accepted, staged) => {
            const admitted = this.journal.admitQueuedTurn(
              accepted.intendedTurnId!,
              this.now(),
              accepted.nativeTurnId,
            );
            if (!admitted && !this.journal.turn(accepted.intendedTurnId!)) {
              throw new Error('Queued message disappeared before late acceptance was admitted.');
            }
            admittedEvents = this.journal.appendProviderEvents(staged.map(({ envelope }) => envelope));
            return admitted;
          },
          (staged) => this.prepareStagedProviderEvents(conversationId, staged),
        );
        if (result.outcome === 'accepted') {
          await this.applyProviderEventEffects(conversationId, executionId, admittedEvents);
          this.invalidateConversation(conversationId, executionId);
        }
      }
      events = events.filter((event) => !dependent.includes(event));
      if (events.length === 0) return;
    }
    const declaredNativeChildren = new Set(events.flatMap((event) => {
      if (event.scope.kind !== 'turn' || event.scope.executionId !== executionId ||
          (event.event.type !== 'turn.block.started' &&
            event.event.type !== 'turn.block.revised' &&
            event.event.type !== 'turn.block.completed')) return [];
      const payload = event.event.block.payload;
      return payload.kind === 'native-child' ? [payload.child.executionId] : [];
    }));
    for (const event of events) {
      if (event.scope.kind === 'account') {
        if (!this.providers.has(event.scope.providerInstanceId)) {
          throw new Error('Provider emitted an account event for another provider instance.');
        }
        continue;
      }
      if (event.scope.conversationId !== conversationId) {
        throw new Error('Provider emitted an event for another conversation.');
      }
      if (event.scope.executionId !== executionId) {
        const child = this.journal.execution(event.scope.executionId);
        const permittedNativeChild = declaredNativeChildren.has(event.scope.executionId) || (
          child?.ownership === 'native' &&
          child.parentExecutionId === executionId &&
          child.providerInstanceId === event.scope.providerInstanceId
        );
        if (!permittedNativeChild) {
          throw new Error('Provider emitted an event for another execution.');
        }
      }
    }
    const safeEvents = (await this.prepareProviderEvents(conversationId, events)).map((event) => {
      if (event.event.type !== 'context.compaction.completed' ||
          event.event.trigger !== 'automatic' || event.scope.kind === 'account') return event;
      const running = this.journal.latestCompactionOperation(conversationId);
      const conversation = this.requireConversation(conversationId);
      if (running?.state !== 'running' || running.trigger !== 'manual' ||
          event.scope.executionId !== conversation.rootExecutionId) return event;
      // Modern Codex snapshots identify the native context-compaction item,
      // not the Remux command that initiated it. While exactly one manual
      // operation owns the root lane, that boundary is authoritative proof of
      // its completion. Rebind it before persistence so recovery produces one
      // lifecycle instead of a second synthetic automatic operation.
      return parseProviderEventEnvelope({
        ...event,
        event: {
          ...event.event,
          trigger: 'manual',
          operationId: running.operationId,
        },
      });
    });
    this.federationBindings.get(executionId)?.touch?.();
    const inserted = this.journal.appendProviderEvents(safeEvents);
    await this.applyProviderEventEffects(conversationId, executionId, inserted);
  }

  private async applyProviderEventEffects(
    conversationId: string,
    executionId: string,
    inserted: readonly ProviderEventEnvelope[],
  ) {
    let accountResourcesChanged = false;
    let rootTurnCompleted = false;
    const changedTurnsByExecution = new Map<string, Set<string>>();
    for (const event of inserted) {
      this.checkoutOwner.terminal(event, 'live-provider', this.now());
      if (event.event.type === 'turn.completed' ||
          (event.event.type === 'session.health' && event.event.state === 'ready' &&
            !this.automaticRecoveryProbation.has(executionId))) {
        this.automaticRecoveryAttempts.delete(executionId);
      }
      if (event.event.type === 'turn.completed' && event.scope.kind === 'turn') {
        this.journal.acknowledgeQueuedTurnDispatch(event.scope.turnId);
        await this.sealTerminalOutput(event.scope.turnId);
        const conversation = this.requireConversation(conversationId);
        if (conversation.rootExecutionId === executionId) {
          rootTurnCompleted = true;
          this.onTerminalTurn({
            conversationId,
            turnId: event.scope.turnId,
            outcome: event.event.outcome,
          });
          if (!this.deliveryOwner.acceptedWithStage(executionId)) {
            queueMicrotask(() => void this.dispatchNext(conversationId));
          }
        } else if (this.journal.execution(executionId)?.ownership === 'federated') {
          this.finalizeFederatedExecution(executionId);
        }
      }
      if (event.event.type === 'context.compaction.completed') {
        if (event.event.trigger === 'automatic') {
          this.journal.satisfyQueuedCompactionsAfterAutomatic(
            conversationId,
            event.event.beforeTokens,
            event.event.afterTokens,
            this.now(),
          );
        }
        if (!this.deliveryOwner.acceptedWithStage(executionId)) {
          queueMicrotask(() => void this.dispatchNext(conversationId));
        }
      } else if (event.event.type === 'context.compaction.failed') {
        queueMicrotask(() => void this.dispatchNext(conversationId));
      }
      if (event.scope.kind === 'account') {
        accountResourcesChanged = true;
      } else {
        const turns = changedTurnsByExecution.get(event.scope.executionId) ?? new Set<string>();
        turns.add(event.scope.kind === 'turn' ? event.scope.turnId : '');
        changedTurnsByExecution.set(event.scope.executionId, turns);
      }
    }
    if (rootTurnCompleted) {
      await this.checkpointLiveHistoryRevision(conversationId, executionId);
    }
    if (accountResourcesChanged) {
      this.onResourcesInvalidated([NATIVE_AGENT_RESOURCE_KEYS.providers]);
    }
    for (const [changedExecutionId, changedTurnIds] of changedTurnsByExecution) {
      const turnIds = [...changedTurnIds].filter(Boolean);
      this.invalidateConversation(
        conversationId,
        changedExecutionId,
        changedTurnIds.has('') || turnIds.length !== 1 ? undefined : turnIds[0],
      );
    }
    if (inserted.length > 0) {
      for (const intent of this.journal.outstandingStopIntents()) {
        if (intent.conversation_id === conversationId && typeof intent.intent_id === 'string') {
          void this.processStopIntent(intent.intent_id);
        }
      }
    }
  }

  private async checkpointLiveHistoryRevision(conversationId: string, executionId: string) {
    const session = this.sessions.get(executionId);
    if (!session?.readHistoryRevision) return;
    try {
      const revision = await session.readHistoryRevision();
      const conversation = this.journal.conversation(conversationId);
      if (!revision || conversation?.rootExecutionId !== executionId) return;
      this.journal.markConversationHistorySynced(conversationId, this.now(), revision);
    } catch {
      // Revision reads are an optimization. A later required-fresh mutation
      // or stale transcript refresh will retry and fall back to a snapshot.
    }
  }

  private async prepareProviderEvents(
    conversationId: string,
    events: readonly ProviderEventEnvelope[],
  ) {
    const cwd = this.requireConversation(conversationId).cwd;
    const prepared: ProviderEventEnvelope[] = [];
    for (const event of events) {
      const normalized = normalizeProviderFileChange(event, cwd);
      if (!normalized) continue;
      if (normalized.event.type !== 'turn.file-changed' || !normalized.event.change.diff) {
        prepared.push(normalized);
        continue;
      }
      const { diff, ...displayChange } = normalized.event.change;
      let diffArtifactId = displayChange.diffArtifactId;
      if (this.sealFileDiff) {
        const eventScope = normalized.scope;
        if (eventScope.kind === 'account') {
          prepared.push(normalized);
          continue;
        }
        diffArtifactId = (await this.sealFileDiff({
          conversationId: eventScope.conversationId,
          executionId: eventScope.executionId,
          ...(eventScope.kind === 'turn' ? { turnId: eventScope.turnId } : {}),
          diff,
        })).artifactId;
      }
      prepared.push(parseProviderEventEnvelope({
        ...normalized,
        event: {
          ...normalized.event,
          change: {
            ...displayChange,
            ...(diffArtifactId ? { diffArtifactId } : {}),
          },
        },
      }));
    }
    return prepared;
  }

  private async prepareStagedProviderEvents(
    conversationId: string,
    source: readonly StagedProviderEnvelope[],
  ) {
    const staged: StagedProviderEnvelope[] = [];
    const sourceObservationIds: string[] = [];
    for (const item of source) {
      let prepared: readonly ProviderEventEnvelope[];
      try {
        prepared = await this.prepareProviderEvents(conversationId, [item.envelope]);
      } catch {
        // Stop at the first source envelope that cannot yet be transformed.
        // The owner admits only the completed prefix and retains this envelope
        // and every later envelope durably for an ordered retry.
        break;
      }
      sourceObservationIds.push(item.observationId);
      for (const envelope of prepared) {
        if (envelope.eventId !== item.observationId) {
          throw new Error('Prepared provider event changed its durable observation identity.');
        }
        staged.push({ ...item, envelope });
      }
    }
    return { staged, sourceObservationIds };
  }

  private async sealTerminalOutputs(conversationId: string, executionId?: string) {
    if (!this.sealTurnOutput) return;
    const turns = (executionId
      ? this.journal.turnsForExecution(executionId)
      : this.journal.turns(conversationId)).filter((turn) => turn.outcome !== undefined);
    const events = executionId
      ? this.journal.eventsForExecution(executionId)
      : this.journal.eventsForConversation(conversationId);
    const eventsByTurn = new Map<string, ProviderEventEnvelope[]>();
    for (const event of events) {
      if (event.scope.kind !== 'turn') continue;
      const grouped = eventsByTurn.get(event.scope.turnId) ?? [];
      grouped.push(event);
      eventsByTurn.set(event.scope.turnId, grouped);
    }
    for (const turn of turns) {
      const text = terminalAssistantText(eventsByTurn.get(turn.turnId) ?? [], turn.turnId);
      await this.sealTurnOutput({ turnId: turn.turnId, text }).catch(() => undefined);
    }
  }

  private async sealTerminalOutput(turnId: string) {
    if (!this.sealTurnOutput) return;
    const turn = this.journal.turn(turnId);
    if (!turn) return;
    const text = terminalAssistantText(this.journal.eventsForTurn(turnId), turnId);
    await this.sealTurnOutput({ turnId, text }).catch(() => undefined);
  }

  private appendFederationEvent(
    parent: JournalExecution,
    rootTurnId: string,
    legacyEvent: ProviderEvent | ({ type: string } & Record<string, unknown>),
    identity: string,
  ) {
    const nativeSession = this.journal.nativeSession(parent.executionId);
    const legacyRecord = legacyEvent as Record<string, unknown>;
    const childRecord = legacyRecord.child && typeof legacyRecord.child === 'object'
      && !Array.isArray(legacyRecord.child)
      ? legacyRecord.child as Record<string, unknown>
      : undefined;
    const childExecutionId = typeof legacyRecord.childExecutionId === 'string'
      ? legacyRecord.childExecutionId
      : childRecord?.executionId;
    if (typeof childExecutionId !== 'string') {
      throw new Error('Federation event is missing its child execution ID.');
    }
    const child = this.journal.execution(childExecutionId);
    const blockId = `federation-block-${childExecutionId}`;
    const existing = this.journal.orderedPasses(rootTurnId)
      .flatMap(({ blocks }) => blocks)
      .find((block) => block.blockId === blockId);
    const revision = Math.max(
      this.federationBlockRevision.get(blockId) ?? 0,
      existing?.revision ?? -1,
    ) + (legacyEvent.type === 'child.started' && !existing ? 0 : 1);
    this.federationBlockRevision.set(blockId, revision);
    const passOrdinal = this.journal.orderedPasses(rootTurnId)
      .reduce((maximum, pass) => Math.max(maximum, pass.ordinal), -1) + (existing ? 0 : 1);
    const structure = existing ? {
      passId: existing.passId,
      blockId,
      passOrdinal: this.journal.orderedPasses(rootTurnId)
        .find(({ passId }) => passId === existing.passId)?.ordinal ?? 0,
      blockOrdinal: existing.ordinal,
    } : {
      passId: `federation-pass-${rootTurnId}-${childExecutionId}`,
      blockId,
      passOrdinal,
      blockOrdinal: 0,
    };
    const outcome = legacyEvent.type === 'child.completed'
      ? legacyRecord.outcome as 'completed' | 'failed' | 'interrupted' | 'recovery_failed'
      : child?.outcome;
    const executionState = legacyEvent.type === 'child.status'
      ? legacyRecord.state as JournalExecution['state']
      : legacyEvent.type === 'child.completed'
        ? outcome === 'completed' ? 'idle' : outcome === 'interrupted' ? 'interrupted' : 'failed'
        : child?.state ?? 'running';
    const payload = {
      kind: 'federated-child' as const,
      child: {
        executionId: childExecutionId,
        ownership: 'federated' as const,
        provider: child?.provider ?? parent.provider,
        providerInstanceId: child?.providerInstanceId ?? parent.providerInstanceId,
        ...(child?.model ? { model: child.model } : {}),
        ...(child?.title ? { title: child.title } : {}),
      },
      executionState,
      ...(outcome ? { outcome } : {}),
      ...(legacyEvent.type === 'child.summary' && typeof legacyRecord.summary === 'string'
        ? { summary: legacyRecord.summary }
        : child?.summary ? { summary: child.summary } : {}),
    };
    const blockState = legacyEvent.type === 'child.started' ? 'running' as const
      : legacyEvent.type === 'child.completed'
        ? outcome === 'completed' ? 'completed' as const
          : outcome === 'interrupted' ? 'interrupted' as const : 'failed' as const
        : 'running' as const;
    const block = { kind: 'federated-child' as const, state: blockState, payload };
    const event: ProviderEvent = legacyEvent.type === 'child.started' && !existing
      ? { type: 'turn.block.started', structure, block }
      : legacyEvent.type === 'child.completed'
        ? { type: 'turn.block.completed', structure, revision, contentHash: hashJson(block), block }
        : { type: 'turn.block.revised', structure, revision, contentHash: hashJson(block), block };
    const envelope = parseProviderEventEnvelope({
      contractVersion: PROVIDER_RUNTIME_CONTRACT_VERSION,
      eventId: stableUuid(`federation-event\0${identity}`),
      provider: parent.provider,
      scope: {
        kind: 'turn',
        providerInstanceId: parent.providerInstanceId,
        conversationId: parent.conversationId,
        executionId: parent.executionId,
        turnId: rootTurnId,
      },
      native: {
        sessionId: nativeSession?.sessionId ?? `remux-${parent.executionId}`,
        kind: `remux/federation/${event.type}`,
      },
      observedAt: this.now(),
      event,
    });
    if (!this.journal.appendProviderEvent(envelope)) return;
    this.invalidateConversation(parent.conversationId, parent.executionId, rootTurnId);
  }

  private finalizeFederatedExecution(executionId: string) {
    const execution = this.requireFederatedExecution(executionId);
    const parent = execution.parentExecutionId
      ? this.journal.execution(execution.parentExecutionId)
      : undefined;
    const rootTurnId = execution.rootTurnId;
    const summary = summarizeExecution(
      this.journal.eventsForExecution(executionId),
      execution.summary,
    );
    if (parent && rootTurnId) {
      if (summary) {
        this.appendFederationEvent(parent, rootTurnId, {
          type: 'child.summary',
          childExecutionId: executionId,
          summary,
        }, `summary:${executionId}:${execution.updatedAt}`);
      }
      const result = this.executionResult(executionId);
      if (result.status !== 'running') {
        this.appendFederationEvent(parent, rootTurnId, {
          type: 'child.completed',
          childExecutionId: executionId,
          outcome: result.status === 'completed' ? 'completed' : result.status,
        }, `completed:${executionId}:${execution.completedAt ?? execution.updatedAt}`);
      }
    }
    const result = this.executionResult(executionId);
    if (result.status === 'running') return;
    const waiters = this.executionWaiters.get(executionId);
    this.executionWaiters.delete(executionId);
    for (const resolve of waiters ?? []) resolve(result);
  }

  private executionResult(executionId: string): FederatedExecutionResult {
    const execution = this.requireFederatedExecution(executionId);
    const hasActiveTurn = Boolean(this.activeExecutionTurn(executionId));
    const status = hasActiveTurn || execution.state === 'running' || execution.state === 'recovering'
      ? 'running'
      : execution.outcome === 'completed' ? 'completed'
        : execution.outcome === 'interrupted' ? 'interrupted' : 'failed';
    const latestTurn = this.journal.turnsForExecution(executionId).at(-1);
    const events = latestTurn
      ? this.journal.eventsForExecution(executionId).filter((event) =>
          event.scope.kind === 'turn' && event.scope.turnId === latestTurn.turnId)
      : [];
    const finalText = latestTurn
      ? terminalAssistantText(events, latestTurn.turnId)
      : '';
    const finalPreview = boundedUtf8Preview(finalText, NATIVE_ASSISTANT_PREVIEW_BYTES);
    const artifact = latestTurn?.assistantArtifactId
      ? this.journal.artifact(latestTurn.assistantArtifactId)
      : undefined;
    const finalBytes = Buffer.byteLength(finalText, 'utf8');
    const finalAnswer = status === 'running' || !latestTurn
      ? undefined
      : finalBytes <= NATIVE_ASSISTANT_PREVIEW_BYTES
        ? { kind: 'inline' as const, text: finalText }
        : artifact
          ? {
              kind: 'artifact' as const,
              preview: finalPreview.text,
              artifact: {
                uri: federatedResultUri(executionId, latestTurn.turnId),
                mimeType: artifact.mediaType,
                byteLength: artifact.byteLength,
                sha256: artifact.sha256,
              },
            }
          : {
              kind: 'unavailable' as const,
              preview: finalPreview.text,
              error: 'The complete child answer could not be sealed into artifact storage.',
            };
    const changedFiles = changedFilesForTurn(events);
    return {
      executionId,
      status,
      provider: execution.provider,
      providerInstanceId: execution.providerInstanceId,
      ...(execution.model ? { model: execution.model } : {}),
      ...(execution.summary ? { summary: execution.summary } : {}),
      ...(latestTurn ? { turnId: latestTurn.turnId } : {}),
      ...(finalAnswer ? { finalAnswer } : {}),
      ...changedFiles,
    };
  }

  private requireFederatedExecution(executionId: string) {
    const execution = this.journal.execution(executionId);
    if (!execution || execution.ownership !== 'federated') {
      throw new Error(`Federated execution ${executionId} does not exist.`);
    }
    return execution;
  }

  private assertFederationReady() {
    if (!this.initialized) throw new Error('Federation is temporarily unavailable during initialization.');
  }

  private observePersistedTerminals(
    events: readonly ProviderEventEnvelope[],
    authority: 'authoritative' | 'session-local' | undefined,
  ) {
    if (authority !== 'authoritative') return;
    for (const event of events) {
      this.checkoutOwner.terminal(event, 'authoritative-snapshot', this.now());
    }
  }

  private activeExecutionTurn(executionId: string) {
    const execution = this.journal.execution(executionId);
    if (!execution) return undefined;
    return this.journal.turnsForExecution(executionId)
      .filter((turn) =>
        (turn.state === 'running' || turn.state === 'recovering'))
      .at(-1);
  }

  private requireReadyProvider(providerInstanceId: string) {
    const registration = this.requireProvider(providerInstanceId);
    const instance = this.journal.providerInstance(providerInstanceId);
    if (instance?.probe.state !== 'ready' || !instance.probe.capabilities) {
      throw new Error(instance?.probe.message ?? `Provider ${providerInstanceId} is unavailable.`);
    }
    return registration;
  }

  private requireProvider(providerInstanceId: string) {
    const registration = this.providers.get(providerInstanceId);
    if (!registration) throw new Error(`Provider instance ${providerInstanceId} is not configured.`);
    return registration;
  }

  private requireCapabilities(providerInstanceId: string): ProviderCapabilities {
    const capabilities = this.journal.providerInstance(providerInstanceId)?.probe.capabilities;
    if (!capabilities) throw new Error(`Provider ${providerInstanceId} has no negotiated capabilities.`);
    return capabilities;
  }

  private requireConversation(conversationId: string) {
    const conversation = this.journal.conversation(conversationId);
    if (!conversation) throw new Error(`Conversation ${conversationId} does not exist.`);
    return conversation;
  }

  private assertRootDeliveryAvailable(conversationId: string) {
    if (this.journal.hasUnresolvedRootDelivery(conversationId)) {
      throw coordinatorError('operation_in_progress',
        'The previous native message delivery is unresolved; provider writer controls remain fenced.');
    }
  }

  private assertContentCapabilities(
    content: readonly UserContentPart[],
    capabilities: ProviderCapabilities,
  ) {
    if (!capabilities.content.images && content.some(({ type }) => type === 'image-artifact')) {
      throw coordinatorError('capability_unavailable', 'Provider does not support image attachments.');
    }
    if (!capabilities.content.fileReferences && content.some(({ type }) => type === 'file-reference')) {
      throw coordinatorError('capability_unavailable', 'Provider does not support file references.');
    }
  }

  private replay<T>(receipt: ReturnType<NativeAgentJournal['claimCommand']>['receipt']): T | undefined {
    if (receipt.state === 'accepted') return structuredClone(receipt.result) as T;
    if (receipt.state === 'rejected' || receipt.state === 'recovery_failed') {
      throw new Error(receipt.errorMessage ?? `Command ${receipt.commandId} was rejected.`);
    }
    if (receipt.state === 'dispatching') {
      throw new Error(`Command ${receipt.commandId} has an ambiguous provider dispatch and will not be retried.`);
    }
    return undefined;
  }

  private invalidateGlobal() {
    const keys: NativeAgentResourceKey[] = [
      'agent/providers',
      'agent/conversations',
      ...this.journal.listProviderInstances().map(({ providerInstanceId }) =>
        `agent/models:${providerInstanceId}` as const),
    ];
    this.onResourcesInvalidated(keys);
  }

  private invalidateProvider(providerInstanceId: string) {
    this.onResourcesInvalidated([
      NATIVE_AGENT_RESOURCE_KEYS.providers,
      `agent/models:${providerInstanceId}`,
    ]);
  }

  private invalidateConversation(conversationId: string, executionId?: string, turnId?: string) {
    const keys: NativeAgentResourceKey[] = [
      'agent/conversations',
      `agent/conversation:${conversationId}`,
      `agent/conversation-versions:${conversationId}`,
      `agent/runtime:${conversationId}`,
      `agent/queue:${conversationId}`,
      `agent/transcript:${conversationId}:tail-24`,
    ];
    if (executionId) {
      keys.push(agentExecutionResourceKey(executionId));
      keys.push(agentExecutionTranscriptResourceKey(executionId));
    }
    if (turnId) keys.push(`agent/turn:${turnId}`);
    this.onResourcesInvalidated(keys);
  }

  private async measure<T>(
    stage: string,
    fields: Omit<NativeCoordinatorDiagnostic, 'stage' | 'durationMs' | 'status' |
      'activeSessions' | 'pendingHydrations'>,
    work: () => Promise<T>,
  ) {
    const startedAt = Date.now();
    try {
      const result = await work();
      this.publishDiagnostic(stage, startedAt, 'completed', fields);
      return result;
    } catch (error) {
      this.publishDiagnostic(
        stage,
        startedAt,
        isAbortError(error) ? 'cancelled' : 'failed',
        { ...fields, error: safeMessage(error) },
      );
      throw error;
    }
  }

  private measureSync<T>(
    stage: string,
    fields: Omit<NativeCoordinatorDiagnostic, 'stage' | 'durationMs' | 'status' |
      'activeSessions' | 'pendingHydrations'>,
    work: () => T,
  ) {
    const startedAt = Date.now();
    try {
      const result = work();
      this.publishDiagnostic(stage, startedAt, 'completed', fields);
      return result;
    } catch (error) {
      this.publishDiagnostic(stage, startedAt, 'failed', { ...fields, error: safeMessage(error) });
      throw error;
    }
  }

  private publishDiagnostic(
    stage: string,
    startedAt: number,
    status: NativeCoordinatorDiagnostic['status'],
    fields: Omit<NativeCoordinatorDiagnostic, 'stage' | 'durationMs' | 'status' |
      'activeSessions' | 'pendingHydrations'>,
  ) {
    try {
      this.onDiagnostic?.({
        stage,
        durationMs: Math.max(0, Date.now() - startedAt),
        status,
        ...fields,
        activeSessions: this.sessions.size,
        pendingHydrations: this.hydrationJobs.size,
      });
    } catch {
      // Diagnostics can never change provider or journal behavior.
    }
  }

  private assertOpen() {
    if (this.closed) throw new Error('Native Agent coordinator is closed.');
  }
}

function drainBufferedProviderEvents(
  events: AsyncIterable<ProviderEventEnvelope>,
  limit: number,
) {
  const batchable = events as AsyncIterable<ProviderEventEnvelope> & {
    drainBuffered?: (limit: number) => ProviderEventEnvelope[];
  };
  return batchable.drainBuffered?.(limit) ?? [];
}

function isStreamingTextRevision(envelope: ProviderEventEnvelope) {
  if (envelope.event.type !== 'turn.block.revised') return false;
  const kind = envelope.event.block.payload.kind;
  return kind === 'reasoning-summary' || kind === 'commentary' || kind === 'final-message';
}

/**
 * Keep the newest cumulative snapshot for each text block inside a provider
 * burst. Structural events and completed snapshots retain their exact order.
 */
function coalesceStreamingTextCheckpoints(events: readonly ProviderEventEnvelope[]) {
  const superseded = new Set<number>();
  const latestByBlock = new Map<string, number>();
  for (const [index, envelope] of events.entries()) {
    if (!isStreamingTextRevision(envelope)) continue;
    const blockKey = envelope.event.type === 'turn.block.revised'
      ? `${envelope.scope.kind === 'turn' ? envelope.scope.turnId : 'unknown-turn'}\0${envelope.event.structure.blockId}`
      : '';
    const previous = latestByBlock.get(blockKey);
    if (previous !== undefined) superseded.add(previous);
    latestByBlock.set(blockKey, index);
  }
  return events.filter((_, index) => !superseded.has(index));
}

function stableUuid(value: string) {
  const hex = createHash('sha256').update(value).digest('hex').slice(0, 32).split('');
  hex[12] = '4';
  hex[16] = ['8', '9', 'a', 'b'][Number.parseInt(hex[16]!, 16) % 4]!;
  return `${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex.slice(12, 16).join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20).join('')}`;
}

function hashJson(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function safeMessage(error: unknown) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/Bearer\s+\S+/giu, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, '[redacted]')
    .slice(0, 1_000);
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortError(signal.reason));
    signal.addEventListener('abort', abort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

function throwIfAborted(signal?: AbortSignal): asserts signal is AbortSignal | undefined {
  if (signal?.aborted) throw abortError(signal.reason);
}

function abortError(reason?: unknown) {
  const error = new Error(reason instanceof Error ? reason.message : 'Operation was cancelled.');
  error.name = 'AbortError';
  return error;
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === 'AbortError';
}

function accessWithin(requested: ProviderAccess, ceiling: ProviderAccess) {
  const rank: Record<ProviderAccess, number> = {
    'read-only': 0,
    'workspace-write': 1,
    'full-access': 2,
  };
  return rank[requested] <= rank[ceiling];
}

function boundedSummary(value: string, maxLength = 4_000) {
  const normalized = value.replace(/\s+/gu, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function summarizeExecution(events: readonly ProviderEventEnvelope[], fallback?: string) {
  let final = '';
  let commentary = '';
  for (const { event } of events) {
    if (event.type !== 'turn.block.started' &&
        event.type !== 'turn.block.revised' &&
        event.type !== 'turn.block.completed') continue;
    if (event.block.payload.kind === 'final-message') final = event.block.payload.text;
    else if (event.block.payload.kind === 'commentary') commentary = event.block.payload.text;
  }
  return boundedSummary(final || fallback || commentary);
}

function developerInstructionsForExecution(execution: JournalExecution | undefined) {
  if (!execution || execution.ownership !== 'federated') return BASE_DEVELOPER_INSTRUCTIONS;
  const access = execution.access ?? 'read-only';
  const accessInstruction = access === 'read-only'
    ? 'This federated child is read-only. Do not modify files or perform mutating operations.'
    : access === 'workspace-write'
      ? 'This federated child has workspace-write access. Do not exceed that access policy.'
      : 'This federated child has full-access permission. Do not exceed that access policy.';
  return [...BASE_DEVELOPER_INSTRUCTIONS, accessInstruction];
}

export function federatedResultUri(executionId: string, turnId: string) {
  return `remux-federation://result/${encodeURIComponent(executionId)}/${encodeURIComponent(turnId)}`;
}

function changedFilesForTurn(events: readonly ProviderEventEnvelope[]): {
  changedFiles: readonly FileChangeDisplay[];
  changedFilesTruncated: number;
} {
  const changes = new Map<string, FileChangeDisplay>();
  for (const envelope of events) {
    if (envelope.event.type !== 'turn.file-changed') continue;
    const previous = changes.get(envelope.event.change.path);
    const change = {
      ...previous,
      ...structuredClone(envelope.event.change),
      ...(!envelope.event.change.diffArtifactId && previous?.diffArtifactId
        ? { diffArtifactId: previous.diffArtifactId }
        : {}),
    };
    changes.delete(change.path);
    changes.set(change.path, change);
  }
  const ordered = [...changes.values()];
  return {
    // Map reinsertion keeps the existing latest-update order. Retain its first
    // 500 entries so ordinary results preserve their historical ordering.
    changedFiles: ordered.slice(0, 500),
    changedFilesTruncated: Math.max(0, ordered.length - 500),
  };
}

function normalizeProviderFileChange(
  envelope: ProviderEventEnvelope,
  cwd: string,
): ProviderEventEnvelope | undefined {
  if (envelope.event.type !== 'turn.file-changed') return envelope;
  const path = workspaceRelativePath(cwd, envelope.event.change.path);
  if (!path) return undefined;
  const oldPath = envelope.event.change.oldPath === undefined
    ? undefined
    : workspaceRelativePath(cwd, envelope.event.change.oldPath);
  if (envelope.event.change.oldPath !== undefined && !oldPath) return undefined;
  return {
    ...envelope,
    event: {
      type: 'turn.file-changed',
      change: {
        ...envelope.event.change,
        path,
        ...(oldPath ? { oldPath } : {}),
      },
      ...(envelope.event.blockId ? { blockId: envelope.event.blockId } : {}),
    },
  };
}

function workspaceRelativePath(cwd: string, path: string) {
  const absolutePath = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
  const relativePath = relative(resolve(cwd), absolutePath);
  if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${sep}`) ||
      isAbsolute(relativePath)) return undefined;
  return relativePath;
}

function withoutLoginError(view: ProviderLoginOperationView) {
  const { error: _error, ...rest } = view;
  return rest;
}

export class NativeCoordinatorError extends Error {
  readonly errorCode: string;

  constructor(errorCode: string, message: string) {
    super(message);
    this.name = 'NativeCoordinatorError';
    this.errorCode = errorCode;
  }
}

function coordinatorError(code: string, message: string) {
  return new NativeCoordinatorError(code, message);
}

function repairRequestedEffort(model: ProviderModelDescriptor | undefined, requested: string | null) {
  if (!model || model.supportedEffort.length === 0) return null;
  if (requested && model.supportedEffort.includes(requested)) return requested;
  for (const fallback of ['high', 'medium', 'low', 'off']) {
    if (model.supportedEffort.includes(fallback)) return fallback;
  }
  return model.supportedEffort[0] ?? null;
}
