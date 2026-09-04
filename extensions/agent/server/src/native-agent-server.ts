import {
  NATIVE_AGENT_METHODS,
  NATIVE_AGENT_PROTOCOL_VERSION,
  type NativeAgentResourceKey,
  type NativeAgentResourceReadParams,
  type NativeArtifactPutCommand,
  type NativeArtifactReadCommand,
  type NativeBranchCommand,
  type NativeCompactConversationCommand,
  type NativeComposerPreferenceSetCommand,
  type NativeConversationAccessSetCommand,
  type NativeConversationCreateCommand,
  type NativeConversationRenameCommand,
  type NativeConversationArchiveSetCommand,
  type NativeConversationStrandActivateCommand,
  type NativeMessageSendCommand,
  type NativeProviderAuthMutationCommand,
  type NativeProviderLoginStartCommand,
  type NativeProviderPreferenceSetCommand,
  type NativeTurnMutationCommand,
} from '../../shared/native-agent-protocol.ts';
import {
  NativeAgentCoordinator,
  NativeCoordinatorError,
  type NativeCoordinatorOptions,
  type NativeProviderRegistration,
} from './native-runtime/native-coordinator.ts';
import type { NativeAgentJournal } from './native-runtime/native-journal.ts';
import type { NativeAgentArtifacts } from './native-runtime/native-artifacts.ts';
import { searchAgentFiles } from './file-search.ts';

export type NativeAgentServerOptions = {
  journal: NativeAgentJournal;
  artifacts?: NativeAgentArtifacts;
  providers: readonly NativeProviderRegistration[];
  notify: (method: string, params: unknown) => void;
  now?: () => number;
  onTerminalTurn?: NativeCoordinatorOptions['onTerminalTurn'];
  federationForSession?: NativeCoordinatorOptions['federationForSession'];
  onDiagnostic?: NativeCoordinatorOptions['onDiagnostic'];
};

export type NativeAgentRequestContext = {
  signal?: AbortSignal;
};

/** JSON-RPC boundary for the provider-native runtime. */
export class NativeAgentServer {
  readonly coordinator: NativeAgentCoordinator;
  private readonly notify: (method: string, params: unknown) => void;
  private readonly artifacts?: NativeAgentArtifacts;
  private readonly journal: NativeAgentJournal;
  private readonly pendingInvalidations = new Set<NativeAgentResourceKey>();
  private invalidationScheduled = false;

  constructor(options: NativeAgentServerOptions) {
    this.notify = options.notify;
    this.artifacts = options.artifacts;
    this.journal = options.journal;
    this.coordinator = new NativeAgentCoordinator({
      journal: options.journal,
      providers: options.providers,
      ...(options.now ? { now: options.now } : {}),
      ...(options.onTerminalTurn ? { onTerminalTurn: options.onTerminalTurn } : {}),
      ...(options.federationForSession ? { federationForSession: options.federationForSession } : {}),
      ...(options.onDiagnostic ? { onDiagnostic: options.onDiagnostic } : {}),
      ...(options.artifacts ? {
        sealTurnOutput: ({ turnId, text }) => options.artifacts!.sealAssistantText(turnId, text)
          .then(() => undefined),
        sealFileDiff: ({ diff }) => options.artifacts!.sealDiffText(diff),
      } : {}),
      onResourcesInvalidated: (keys) => this.invalidate(keys),
    });
  }

  initialize() {
    return this.coordinator.initialize();
  }

  async handle(
    method: string,
    params: unknown,
    context: NativeAgentRequestContext = {},
  ): Promise<unknown> {
    params = stripHostRoutingMetadata(params);
    try {
      switch (method) {
      case NATIVE_AGENT_METHODS.resourcesRead:
        this.coordinator.prepareResourceRead(params as NativeAgentResourceReadParams);
        return this.coordinator.projector.read(params as NativeAgentResourceReadParams);
      case NATIVE_AGENT_METHODS.transcriptRead:
        await this.coordinator.prepareTranscriptRead(
          params as NativeAgentResourceReadParams,
          context.signal,
        );
        return this.coordinator.projector.read(params as NativeAgentResourceReadParams);
      case NATIVE_AGENT_METHODS.runtimesRead:
        return this.coordinator.readRuntimeStatuses();
      case NATIVE_AGENT_METHODS.providerLoginStart:
        return this.coordinator.startProviderLogin(params as NativeProviderLoginStartCommand);
      case NATIVE_AGENT_METHODS.providerLoginCancel:
        return this.coordinator.cancelProviderLogin(params as NativeProviderAuthMutationCommand);
      case NATIVE_AGENT_METHODS.providerLogout:
        return this.coordinator.logoutProvider(params as NativeProviderAuthMutationCommand);
      case NATIVE_AGENT_METHODS.artifactPut:
        if (!this.artifacts) throw new Error('Native artifact storage is unavailable.');
        return this.artifacts.put(params as NativeArtifactPutCommand);
      case NATIVE_AGENT_METHODS.artifactRead:
        if (!this.artifacts) throw new Error('Native artifact storage is unavailable.');
        return this.artifacts.read(params as NativeArtifactReadCommand);
      case NATIVE_AGENT_METHODS.filesSearch:
        return searchAgentFiles(params as Parameters<typeof searchAgentFiles>[0]);
      case NATIVE_AGENT_METHODS.conversationCreate:
        return this.coordinator.createConversation(params as NativeConversationCreateCommand);
      case NATIVE_AGENT_METHODS.messageSend:
        return this.coordinator.sendMessage(params as NativeMessageSendCommand);
      case NATIVE_AGENT_METHODS.queuedMessageRemove:
        return this.coordinator.removeQueuedMessage(params as NativeTurnMutationCommand);
      case NATIVE_AGENT_METHODS.messageEdit:
        return this.coordinator.branchConversation({
          ...(params as Omit<NativeBranchCommand, 'mode'>),
          mode: 'edit',
        });
      case NATIVE_AGENT_METHODS.messageFork:
        return this.coordinator.branchConversation({
          ...(params as Omit<NativeBranchCommand, 'mode'>),
          mode: 'fork',
        });
      case NATIVE_AGENT_METHODS.conversationRename:
        return this.coordinator.renameConversation(params as NativeConversationRenameCommand);
      case NATIVE_AGENT_METHODS.conversationArchiveSet:
        return this.coordinator.setConversationArchived(params as NativeConversationArchiveSetCommand);
      case NATIVE_AGENT_METHODS.conversationStrandActivate:
        return this.coordinator.activateConversationStrand(
          params as NativeConversationStrandActivateCommand,
        );
      case NATIVE_AGENT_METHODS.turnInterrupt:
        return this.coordinator.interruptTurn(params as NativeTurnMutationCommand);
      case NATIVE_AGENT_METHODS.conversationCompact:
        return this.coordinator.compactConversation(params as NativeCompactConversationCommand);
      case NATIVE_AGENT_METHODS.conversationPreferenceSet:
        return this.coordinator.setConversationPreference(params as NativeComposerPreferenceSetCommand);
      case NATIVE_AGENT_METHODS.conversationAccessSet:
        return this.coordinator.setConversationAccess(params as NativeConversationAccessSetCommand);
      case NATIVE_AGENT_METHODS.providerPreferenceSet:
        return this.coordinator.setProviderPreference(params as NativeProviderPreferenceSetCommand);
      default:
        throw new NativeAgentRpcError(-32601, `Method not found: ${method}`);
      }
    } catch (error) {
      if (error instanceof NativeAgentRpcError) throw error;
      throw new NativeAgentRpcError(
        -32000,
        safeRpcMessage(error),
        error instanceof NativeCoordinatorError ? { code: error.errorCode } : undefined,
      );
    }
  }

  close() {
    return this.coordinator.close();
  }

  private invalidate(keys: readonly NativeAgentResourceKey[]) {
    this.coordinator.projector.invalidate(keys);
    for (const key of keys) this.pendingInvalidations.add(key);
    if (this.invalidationScheduled) return;
    this.invalidationScheduled = true;
    queueMicrotask(() => {
      this.invalidationScheduled = false;
      const pending = [...this.pendingInvalidations];
      this.pendingInvalidations.clear();
      this.notify(NATIVE_AGENT_METHODS.resourcesInvalidated, {
        protocolVersion: NATIVE_AGENT_PROTOCOL_VERSION,
        serverGeneration: this.coordinator.projector.serverGeneration,
        basisSequence: this.journal.latestSequence(),
        keys: pending,
      });
    });
  }
}

export class NativeAgentRpcError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'NativeAgentRpcError';
    this.code = code;
    this.data = data;
  }
}

function stripHostRoutingMetadata(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const {
    _remuxOrigin: _origin,
    _remuxViewerKey: _viewerKey,
    ...params
  } = value as Record<string, unknown>;
  return params;
}

function safeRpcMessage(error: unknown) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/Bearer\s+\S+/giu, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, '[redacted]')
    .slice(0, 1_000);
}
