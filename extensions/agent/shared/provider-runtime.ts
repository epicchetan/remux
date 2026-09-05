/**
 * Provider-native Agent runtime contract.
 *
 * This module is intentionally independent from Codex App Server, the Claude
 * Agent SDK, and any provider implementation. Provider adapters validate their
 * output here before the coordinator can persist or project it.
 */

export const PROVIDER_RUNTIME_CONTRACT_VERSION = 4 as const;
const LEGACY_PROVIDER_RUNTIME_CONTRACT_VERSIONS = [2, 3] as const;
export const PROVIDER_RUNTIME_LIMITS = {
  eventBytes: 256 * 1024,
  finalEventBytes: 32 * 1024 * 1024,
  finalTextChars: 8 * 1024 * 1024,
  messageChars: 256 * 1024,
  previewBytes: 32 * 1024,
  snapshotBytes: 64 * 1024 * 1024,
  stringChars: 8 * 1024,
  contentParts: 32,
  snapshotEvents: 20_000,
} as const;

export type ProviderKind = 'codex' | 'claude-code' | 'fixture';
export type ProviderAccess = 'read-only' | 'workspace-write' | 'full-access';
export type ProviderAuthKind = 'native-subscription' | 'api-key' | 'external';
export type ProviderProbeState = 'ready' | 'signed-out' | 'missing' | 'incompatible' | 'error';
export type ProviderTurnOutcome = 'completed' | 'failed' | 'interrupted' | 'recovery_failed';
export type ProviderExecutionState = 'running' | 'recovering' | 'idle' | 'failed' | 'interrupted';
export type ChildExecutionOwnership = 'native' | 'federated';

export type ProviderCapabilities = {
  protocolVersion: typeof PROVIDER_RUNTIME_CONTRACT_VERSION;
  provider: ProviderKind;
  providerVersion: string;
  adapterVersion: string;
  auth: ProviderAuthKind;
  authentication: {
    login: 'none' | 'device-code' | 'browser';
    logout: boolean;
  };
  session: {
    create: true;
    resume: boolean;
    discoverHistory: boolean;
    readSnapshot: boolean;
    forkNative: boolean;
    contextBranching?: {
      strategy: 'native' | 'visible-replay' | 'none';
      boundary: 'turn';
      sameProviderInstanceOnly: boolean;
      workspace: 'shared-current';
      whileBackgroundChildrenRun: boolean;
    };
    rollbackNative: boolean;
  };
  turns: {
    interrupt: boolean;
    steer: boolean;
    queue: boolean;
    changeModelOnExistingSession: boolean;
    changeEffortOnExistingSession: boolean;
  };
  content: {
    images: boolean;
    fileReferences: boolean;
    reasoning: boolean;
    diffs: boolean;
    webActivity: boolean;
  };
  collaboration: {
    nativeSubagents: boolean;
    childTranscript: 'none' | 'summary' | 'full';
    childSteer: boolean;
    childInterrupt: boolean;
  };
  interaction: {
    blockingApprovals: false;
    structuredUserInput: false;
  };
  access: {
    presets: readonly ProviderAccess[];
    defaultPreset: 'workspace-write';
  };
  usage: {
    turn: boolean;
    cumulative: boolean;
    context: 'none' | 'derived' | 'provider';
    plan: 'none' | 'push' | 'read-and-push';
    estimatedCost: boolean;
  };
  compaction: {
    automaticNative: boolean;
    manualNative: boolean;
  };
};

export type ProviderProbe = {
  state: ProviderProbeState;
  displayLabel?: string;
  diagnosticCode?: string;
  message?: string;
  capabilities?: ProviderCapabilities;
};

export type ProviderLoginStartInput = {
  commandId: string;
  providerInstanceId: string;
  mode: 'device-code' | 'browser';
};

export type ProviderLoginEvent =
  | {
      type: 'prompt';
      loginId: string;
      verificationUri: string;
      userCode?: string;
    }
  | { type: 'completed'; success: true }
  | { type: 'completed'; success: false; error: string };

export type ProviderLogoutInput = {
  commandId: string;
  providerInstanceId: string;
};

export type NativeSessionRef = {
  provider: ProviderKind;
  providerInstanceId: string;
  sessionId: string;
  /** Provider-private and server-only. Never include this in a viewer resource. */
  resumeCursor?: JsonValue;
};

export type ProviderModelDescriptor = {
  id: string;
  name: string;
  provider: ProviderKind;
  supportedEffort: readonly string[];
  contextWindow?: number;
  isDefault?: boolean;
};

export type NativeSessionSummary = {
  nativeSession: NativeSessionRef;
  title?: string;
  preview?: string;
  cwd?: string;
  /** Opaque provider revision used to avoid reparsing an unchanged transcript. */
  historyRevision?: string;
  createdAt?: number;
  updatedAt?: number;
};

export type UserContentPart =
  | { type: 'text'; text: string }
  | {
      type: 'image-artifact';
      artifactId: string;
      mimeType: string;
      name?: string;
      byteLength?: number;
    }
  | { type: 'file-reference'; path: string };

export type FederationSessionConfig = {
  endpoint: string;
  authorizationHeader: string;
};

export type NativeTurnBinding = {
  turnId: string;
  nativeTurnId: string;
  /** First unoccupied canonical block ordinal when a live session resumes. */
  nextBlockOrdinal?: number;
  /** Provider-private branch cursor, persisted server-side only. */
  branchCursor?: JsonValue;
};

export type OpenProviderSessionInput = {
  commandId: string;
  providerInstanceId: string;
  conversationId: string;
  executionId: string;
  mode: 'create' | 'resume' | 'attach';
  nativeSession?: NativeSessionRef;
  cwd: string;
  model: string;
  effort?: string;
  access: ProviderAccess;
  developerInstructions: readonly string[];
  federation?: FederationSessionConfig;
  /** Durable server-only identity bindings used to reconcile a resumed native snapshot. */
  nativeTurnBindings?: readonly NativeTurnBinding[];
  /**
   * Native turns inherited from an ancestor strand. They already exist in the
   * canonical Remux path and must not be imported as turns owned by this
   * execution when a provider returns the fork's complete native transcript.
   */
  inheritedNativeTurnIds?: readonly string[];
  /** The accepted non-terminal turn, when this process is recovering an interrupted session. */
  activeTurnBinding?: NativeTurnBinding;
};

export type StartProviderTurnInput = {
  commandId: string;
  conversationId: string;
  turnId: string;
  executionId: string;
  content: readonly UserContentPart[];
  model?: string;
  effort?: string;
};

export type SteerProviderTurnInput = {
  commandId: string;
  turnId: string;
  content: readonly UserContentPart[];
};

export type InterruptProviderTurnInput = {
  commandId: string;
  turnId: string;
};

export type InterruptProviderChildInput = {
  commandId: string;
  childExecutionId: string;
  nativeSessionId: string;
};

export type CompactProviderSessionInput = {
  commandId: string;
  conversationId: string;
  executionId: string;
};

export type ProviderSnapshotRequest = {
  commandId: string;
  afterNativeSequence?: number;
};

export type NativeForkRequest = {
  commandId: string;
  /** Fork with this native turn as the last turn in the new session. */
  throughNativeTurnId?: string;
  /** Fork immediately before this native turn, used by edit-and-regenerate. */
  beforeNativeTurnId?: string;
  /** Opaque cursor authored and parsed by the same provider adapter. */
  branchCursor?: JsonValue;
  /** Caller-minted destination identity when the provider supports it. */
  destinationSessionId?: string;
};

export type NativeRollbackRequest = {
  commandId: string;
  nativeTurnId: string;
};

export type DiscoverProviderSessionsInput = {
  providerInstanceId: string;
  cwd?: string;
  limit?: number;
  cursor?: string;
};

export type DisplayError = {
  code: string;
  message: string;
  retryable?: boolean;
};

export type ToolDisplay = {
  callId: string;
  name: string;
  category?: 'shell' | 'file' | 'search' | 'web' | 'mcp' | 'collaboration' | 'other';
  title?: string;
};

export type FileChangeDisplay = {
  path: string;
  kind: 'add' | 'delete' | 'update' | 'move';
  oldPath?: string;
  diffArtifactId?: string;
};

/** Provider-edge shape. The coordinator seals `diff` before journaling it. */
export type ProviderFileChange = FileChangeDisplay & {
  diff?: string;
};

export type WebActivityDisplay = {
  kind: 'search' | 'open' | 'other';
  title?: string;
  url?: string;
  query?: string;
};

export type TokenUsageBreakdown = {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteInputTokens: number | null;
  outputTokens: number | null;
  reasoningOutputTokens: number | null;
  totalTokens: number | null;
};

export type ContextUsageSnapshot = {
  usedTokens: number;
  windowTokens: number;
  percent: number;
  measurement: 'provider' | 'derived';
  freshness: 'live' | 'cached';
  observedAt: number;
  turnId: string | null;
};

export type CumulativeUsage = {
  tokens: TokenUsageBreakdown;
  scope: 'native-conversation' | 'runtime-epoch';
  epochId: string;
};

export type EstimatedCost = {
  usd: number;
  scope: 'runtime-epoch';
  epochId: string;
};

export type UsageDisplay = {
  turn: TokenUsageBreakdown | null;
  cumulative: CumulativeUsage | null;
  context: ContextUsageSnapshot | null;
  estimatedCost: EstimatedCost | null;
};

export type AccountUsageWindow = {
  id: string;
  label: string;
  kind: 'rolling' | 'weekly' | 'model' | 'extra';
  model: string | null;
  usedPercent: number;
  resetsAt: number | null;
};

export type ProviderAccountUsage = {
  availability: 'available' | 'not-applicable' | 'unknown';
  windows: readonly AccountUsageWindow[];
  source: 'provider-push' | 'provider-read';
  freshness: 'live' | 'cached';
  observedAt: number;
};

export type ChildExecutionDisplay = {
  executionId: string;
  ownership: ChildExecutionOwnership;
  provider: ProviderKind;
  providerInstanceId?: string;
  model?: string;
  title?: string;
  nativeSessionId?: string;
  transcriptAvailable?: boolean;
};

export type ProviderEventScope =
  | {
      kind: 'account';
      providerInstanceId: string;
    }
  | {
      kind: 'conversation';
      providerInstanceId: string;
      conversationId: string;
      executionId: string;
    }
  | {
      kind: 'turn';
      providerInstanceId: string;
      conversationId: string;
      executionId: string;
      turnId: string;
    }
  | {
      kind: 'execution';
      providerInstanceId: string;
      conversationId: string;
      executionId: string;
      parentExecutionId?: string;
      rootTurnId?: string;
    };

export type NativePosition =
  | { kind: 'native-sequence'; sequence: number; subIndex: number }
  | { kind: 'message-block'; messageId: string; blockIndex: number; subIndex: number }
  | { kind: 'snapshot-index'; itemIndex: number; subIndex: number };

/**
 * Stable semantic identity supplied by a provider adapter. Unlike item and
 * session IDs, this identity must survive snapshot replay and session resume.
 */
export type NativeProviderSubject = {
  kind: string;
  key: string;
};

/** Structural neighbours in an authoritative provider snapshot. */
export type NativeTimelineBoundary = {
  previousTurnId?: string;
  nextTurnId?: string;
};

export type TurnStructure = {
  passId: string;
  blockId: string;
  passOrdinal: number;
  blockOrdinal: number;
};

export type TurnBlockKind =
  | 'reasoning-summary'
  | 'commentary'
  | 'tool'
  | 'native-child'
  | 'federated-child'
  | 'web'
  | 'final-message'
  | 'compatibility-notice';

export const PROVIDER_TURN_BLOCK_KINDS = [
  'reasoning-summary',
  'commentary',
  'tool',
  'native-child',
  'federated-child',
  'web',
  'final-message',
  'compatibility-notice',
] as const satisfies readonly TurnBlockKind[];

export type ProviderSnapshotCoverage = {
  turnBlocks: {
    /**
     * Block kinds for which absence from the snapshot proves native absence.
     * Journaled blocks of every omitted kind survive snapshot reconciliation.
     */
    completeKinds: readonly TurnBlockKind[];
  };
};

export type TurnBlockState = 'streaming' | 'running' | 'completed' | 'failed' | 'interrupted';

export type TurnBlockPayload =
  | { kind: 'reasoning-summary'; text: string; parts?: readonly string[] }
  | { kind: 'commentary'; text: string }
  | { kind: 'final-message'; text: string }
  | {
      kind: 'tool';
      tool: ToolDisplay;
      inputPreview?: JsonValue;
      outputPreview?: JsonValue;
      detailRef?: string;
    }
  | {
      kind: 'native-child' | 'federated-child';
      child: ChildExecutionDisplay;
      executionState: ProviderExecutionState;
      outcome?: ProviderTurnOutcome;
      summary?: string;
    }
  | { kind: 'web'; activity: WebActivityDisplay }
  | { kind: 'compatibility-notice'; code: string; message: string };

export type TurnBlockSnapshot = {
  kind: TurnBlockKind;
  state: TurnBlockState;
  payload: TurnBlockPayload;
};

export type ProviderEvent =
  | { type: 'session.bound'; resumed: boolean }
  | { type: 'session.materialized' }
  | { type: 'session.health'; state: 'ready' | 'recovering' | 'lost'; message?: string }
  | { type: 'turn.started' }
  | { type: 'turn.status'; state: 'running' | 'recovering' | 'idle' }
  | { type: 'turn.completed'; outcome: ProviderTurnOutcome; error?: DisplayError }
  | { type: 'user.message'; content: readonly UserContentPart[] }
  | {
      type: 'turn.block.started';
      structure: TurnStructure;
      block: TurnBlockSnapshot;
    }
  | {
      type: 'turn.block.revised';
      structure: TurnStructure;
      revision: number;
      contentHash: string;
      block: TurnBlockSnapshot;
    }
  | {
      type: 'turn.block.completed';
      structure: TurnStructure;
      revision: number;
      contentHash: string;
      block: TurnBlockSnapshot;
    }
  | { type: 'turn.file-changed'; change: ProviderFileChange; blockId?: string }
  | { type: 'turn.usage-updated'; usage: UsageDisplay }
  | { type: 'turn.branch-point'; cursor: JsonValue; cursorVersion: number }
  | {
      type: 'context.compaction.started';
      trigger: 'manual' | 'automatic';
      operationId: string;
      beforeTokens: number | null;
    }
  | {
      type: 'context.compaction.completed';
      trigger: 'manual' | 'automatic';
      operationId: string;
      beforeTokens: number | null;
      afterTokens: number | null;
    }
  | {
      type: 'context.compaction.failed';
      trigger: 'manual' | 'automatic';
      operationId: string;
      error: DisplayError;
    }
  | { type: 'account.usage-updated'; usage: ProviderAccountUsage }
  | { type: 'execution.started'; child: ChildExecutionDisplay }
  | { type: 'execution.status'; childExecutionId: string; state: ProviderExecutionState }
  | { type: 'execution.summary'; childExecutionId: string; summary: string }
  | { type: 'execution.completed'; childExecutionId: string; outcome: ProviderTurnOutcome }
  | { type: 'compatibility.notice'; code: string; message: string };

export type ProviderEventEnvelope = {
  contractVersion: typeof PROVIDER_RUNTIME_CONTRACT_VERSION;
  eventId: string;
  provider: ProviderKind;
  scope: ProviderEventScope;
  native: {
    sessionId?: string;
    turnId?: string;
    messageId?: string;
    itemId?: string;
    toolCallId?: string;
    position?: NativePosition;
    subject?: NativeProviderSubject;
    timeline?: NativeTimelineBoundary;
    kind: string;
  };
  observedAt: number;
  event: ProviderEvent;
  rawArtifactRef?: string;
};

export type ProviderSnapshot = {
  contractVersion: typeof PROVIDER_RUNTIME_CONTRACT_VERSION;
  nativeSession: NativeSessionRef;
  state: 'running' | 'idle' | 'lost';
  /**
   * `authoritative` snapshots can prove native absence during reconciliation.
   * `session-local` snapshots contain only events observed by this adapter process.
   */
  authority?: 'authoritative' | 'session-local';
  coverage?: ProviderSnapshotCoverage;
  /** Opaque revision of the native history represented by this snapshot. */
  historyRevision?: string;
  events: readonly ProviderEventEnvelope[];
  nextNativeSequence?: number;
};

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export class ProviderContractError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = 'ProviderContractError';
    this.path = path;
  }
}

export function parseProviderCapabilities(value: unknown): ProviderCapabilities {
  assertEncodedSize(value, PROVIDER_RUNTIME_LIMITS.eventBytes, '$');
  const record = strictRecord(value, '$', [
    'protocolVersion', 'provider', 'providerVersion', 'adapterVersion', 'auth',
    'authentication', 'session', 'turns', 'content', 'collaboration', 'interaction',
    'access', 'usage', 'compaction',
  ]);
  providerRuntimeContractVersion(record.protocolVersion, '$.protocolVersion');
  const provider = providerKind(record.provider, '$.provider');
  const session = strictRecord(record.session, '$.session', [
    'create', 'resume', 'discoverHistory', 'readSnapshot', 'forkNative', 'rollbackNative',
    'contextBranching',
  ], ['contextBranching']);
  const authentication = strictRecord(record.authentication, '$.authentication', [
    'login', 'logout',
  ]);
  exactLiteral(session.create, true, '$.session.create');
  const turns = strictRecord(record.turns, '$.turns', [
    'interrupt', 'steer', 'queue', 'changeModelOnExistingSession',
    'changeEffortOnExistingSession',
  ]);
  const content = strictRecord(record.content, '$.content', [
    'images', 'fileReferences', 'reasoning', 'diffs', 'webActivity',
  ]);
  const collaboration = strictRecord(record.collaboration, '$.collaboration', [
    'nativeSubagents', 'childTranscript', 'childSteer', 'childInterrupt',
  ]);
  const interaction = strictRecord(record.interaction, '$.interaction', [
    'blockingApprovals', 'structuredUserInput',
  ]);
  const access = strictRecord(record.access, '$.access', ['presets', 'defaultPreset']);
  const accessPresets = array(access.presets, '$.access.presets');
  if (accessPresets.length === 0 || accessPresets.length > 3) {
    throw new ProviderContractError('$.access.presets', 'must contain 1-3 access presets');
  }
  const parsedPresets = accessPresets.map((preset, index) => oneOf(
    preset,
    ['read-only', 'workspace-write', 'full-access'],
    `$.access.presets[${index}]`,
  ));
  if (new Set(parsedPresets).size !== parsedPresets.length) {
    throw new ProviderContractError('$.access.presets', 'must not contain duplicates');
  }
  if (!parsedPresets.includes('workspace-write')) {
    throw new ProviderContractError('$.access.presets', 'must include workspace-write');
  }
  exactLiteral(access.defaultPreset, 'workspace-write', '$.access.defaultPreset');
  const usage = strictRecord(record.usage, '$.usage', [
    'turn', 'cumulative', 'context', 'plan', 'estimatedCost',
  ]);
  const compaction = strictRecord(record.compaction, '$.compaction', [
    'automaticNative', 'manualNative',
  ]);
  exactLiteral(interaction.blockingApprovals, false, '$.interaction.blockingApprovals');
  exactLiteral(interaction.structuredUserInput, false, '$.interaction.structuredUserInput');
  return {
    protocolVersion: PROVIDER_RUNTIME_CONTRACT_VERSION,
    provider,
    providerVersion: boundedString(record.providerVersion, '$.providerVersion'),
    adapterVersion: boundedString(record.adapterVersion, '$.adapterVersion'),
    auth: oneOf(record.auth, ['native-subscription', 'api-key', 'external'], '$.auth'),
    authentication: {
      login: oneOf(authentication.login, ['none', 'device-code', 'browser'], '$.authentication.login'),
      logout: bool(authentication.logout, '$.authentication.logout'),
    },
    session: {
      create: true,
      resume: bool(session.resume, '$.session.resume'),
      discoverHistory: bool(session.discoverHistory, '$.session.discoverHistory'),
      readSnapshot: bool(session.readSnapshot, '$.session.readSnapshot'),
      forkNative: bool(session.forkNative, '$.session.forkNative'),
      rollbackNative: bool(session.rollbackNative, '$.session.rollbackNative'),
      ...(session.contextBranching === undefined ? {} : {
        contextBranching: parseContextBranching(
          session.contextBranching,
          '$.session.contextBranching',
        ),
      }),
    },
    turns: {
      interrupt: bool(turns.interrupt, '$.turns.interrupt'),
      steer: bool(turns.steer, '$.turns.steer'),
      queue: bool(turns.queue, '$.turns.queue'),
      changeModelOnExistingSession: bool(
        turns.changeModelOnExistingSession,
        '$.turns.changeModelOnExistingSession',
      ),
      changeEffortOnExistingSession: bool(
        turns.changeEffortOnExistingSession,
        '$.turns.changeEffortOnExistingSession',
      ),
    },
    content: {
      images: bool(content.images, '$.content.images'),
      fileReferences: bool(content.fileReferences, '$.content.fileReferences'),
      reasoning: bool(content.reasoning, '$.content.reasoning'),
      diffs: bool(content.diffs, '$.content.diffs'),
      webActivity: bool(content.webActivity, '$.content.webActivity'),
    },
    collaboration: {
      nativeSubagents: bool(collaboration.nativeSubagents, '$.collaboration.nativeSubagents'),
      childTranscript: oneOf(
        collaboration.childTranscript,
        ['none', 'summary', 'full'],
        '$.collaboration.childTranscript',
      ),
      childSteer: bool(collaboration.childSteer, '$.collaboration.childSteer'),
      childInterrupt: bool(collaboration.childInterrupt, '$.collaboration.childInterrupt'),
    },
    interaction: { blockingApprovals: false, structuredUserInput: false },
    access: {
      presets: parsedPresets,
      defaultPreset: 'workspace-write',
    },
    usage: {
      turn: bool(usage.turn, '$.usage.turn'),
      cumulative: bool(usage.cumulative, '$.usage.cumulative'),
      context: oneOf(usage.context, ['none', 'derived', 'provider'], '$.usage.context'),
      plan: oneOf(usage.plan, ['none', 'push', 'read-and-push'], '$.usage.plan'),
      estimatedCost: bool(usage.estimatedCost, '$.usage.estimatedCost'),
    },
    compaction: {
      automaticNative: bool(compaction.automaticNative, '$.compaction.automaticNative'),
      manualNative: bool(compaction.manualNative, '$.compaction.manualNative'),
    },
  };
}

function parseContextBranching(
  value: unknown,
  path: string,
): NonNullable<ProviderCapabilities['session']['contextBranching']> {
  const record = strictRecord(value, path, [
    'strategy', 'boundary', 'sameProviderInstanceOnly', 'workspace',
    'whileBackgroundChildrenRun',
  ]);
  return {
    strategy: oneOf(record.strategy, ['native', 'visible-replay', 'none'], `${path}.strategy`),
    boundary: oneOf(record.boundary, ['turn'], `${path}.boundary`),
    sameProviderInstanceOnly: bool(
      record.sameProviderInstanceOnly,
      `${path}.sameProviderInstanceOnly`,
    ),
    workspace: oneOf(record.workspace, ['shared-current'], `${path}.workspace`),
    whileBackgroundChildrenRun: bool(
      record.whileBackgroundChildrenRun,
      `${path}.whileBackgroundChildrenRun`,
    ),
  };
}

export function parseOpenProviderSessionInput(value: unknown): OpenProviderSessionInput {
  assertEncodedSize(value, PROVIDER_RUNTIME_LIMITS.eventBytes, '$');
  const record = strictRecord(value, '$', [
    'commandId', 'providerInstanceId', 'conversationId', 'executionId', 'mode', 'nativeSession', 'cwd',
    'model', 'effort', 'access', 'developerInstructions', 'federation', 'nativeTurnBindings',
    'inheritedNativeTurnIds', 'activeTurnBinding',
  ], [
    'nativeSession', 'effort', 'federation', 'nativeTurnBindings',
    'inheritedNativeTurnIds', 'activeTurnBinding',
  ]);
  const mode = oneOf(record.mode, ['create', 'resume', 'attach'], '$.mode');
  const nativeSession = record.nativeSession === undefined
    ? undefined
    : parseNativeSessionRef(record.nativeSession, '$.nativeSession');
  if (mode !== 'create' && !nativeSession) {
    throw new ProviderContractError('$.nativeSession', `${mode} requires a native session`);
  }
  if (mode === 'create' && nativeSession) {
    throw new ProviderContractError('$.nativeSession', 'create cannot include a native session');
  }
  const providerInstanceId = identifier(record.providerInstanceId, '$.providerInstanceId');
  if (nativeSession && nativeSession.providerInstanceId !== providerInstanceId) {
    throw new ProviderContractError(
      '$.nativeSession.providerInstanceId',
      'must match the requested provider instance',
    );
  }
  const instructions = array(record.developerInstructions, '$.developerInstructions');
  if (instructions.length > 16) {
    throw new ProviderContractError('$.developerInstructions', 'contains too many entries');
  }
  const federation = record.federation === undefined
    ? undefined
    : parseFederationSession(record.federation, '$.federation');
  const bindings = record.nativeTurnBindings === undefined
    ? []
    : array(record.nativeTurnBindings, '$.nativeTurnBindings');
  if (bindings.length > PROVIDER_RUNTIME_LIMITS.snapshotEvents) {
    throw new ProviderContractError('$.nativeTurnBindings', 'contains too many entries');
  }
  const seenTurnIds = new Set<string>();
  const seenNativeTurnIds = new Set<string>();
  const nativeTurnBindings = bindings.map((value, index) => {
    const binding = strictRecord(
      value,
      `$.nativeTurnBindings[${index}]`,
      ['turnId', 'nativeTurnId', 'nextBlockOrdinal', 'branchCursor'],
      ['nextBlockOrdinal', 'branchCursor'],
    );
    const turnId = identifier(binding.turnId, `$.nativeTurnBindings[${index}].turnId`);
    const nativeTurnId = identifier(
      binding.nativeTurnId,
      `$.nativeTurnBindings[${index}].nativeTurnId`,
    );
    if (seenTurnIds.has(turnId) || seenNativeTurnIds.has(nativeTurnId)) {
      throw new ProviderContractError(
        `$.nativeTurnBindings[${index}]`,
        'must not duplicate either turn identity',
      );
    }
    seenTurnIds.add(turnId);
    seenNativeTurnIds.add(nativeTurnId);
    return {
      turnId,
      nativeTurnId,
      ...(binding.nextBlockOrdinal === undefined
        ? {}
        : { nextBlockOrdinal: nonnegativeInteger(
            binding.nextBlockOrdinal,
            `$.nativeTurnBindings[${index}].nextBlockOrdinal`,
          ) }),
      ...(binding.branchCursor === undefined
        ? {}
        : { branchCursor: jsonValue(binding.branchCursor, `$.nativeTurnBindings[${index}].branchCursor`) }),
    };
  });
  const activeTurnBinding = record.activeTurnBinding === undefined
    ? undefined
    : parseNativeTurnBinding(record.activeTurnBinding, '$.activeTurnBinding');
  const inheritedIds = record.inheritedNativeTurnIds === undefined
    ? []
    : array(record.inheritedNativeTurnIds, '$.inheritedNativeTurnIds');
  if (inheritedIds.length > PROVIDER_RUNTIME_LIMITS.snapshotEvents) {
    throw new ProviderContractError('$.inheritedNativeTurnIds', 'contains too many entries');
  }
  const inheritedNativeTurnIds = inheritedIds.map((value, index) =>
    identifier(value, `$.inheritedNativeTurnIds[${index}]`));
  const uniqueInheritedNativeTurnIds = new Set(inheritedNativeTurnIds);
  if (uniqueInheritedNativeTurnIds.size !== inheritedNativeTurnIds.length) {
    throw new ProviderContractError('$.inheritedNativeTurnIds', 'must not contain duplicates');
  }
  for (const nativeTurnId of inheritedNativeTurnIds) {
    if (seenNativeTurnIds.has(nativeTurnId)) {
      throw new ProviderContractError(
        '$.inheritedNativeTurnIds',
        'must not overlap native turn bindings owned by this execution',
      );
    }
  }
  if (activeTurnBinding && mode === 'create') {
    throw new ProviderContractError('$.activeTurnBinding', 'create cannot recover an active turn');
  }
  if (activeTurnBinding && !nativeTurnBindings.some((binding) =>
    binding.turnId === activeTurnBinding.turnId &&
    binding.nativeTurnId === activeTurnBinding.nativeTurnId)) {
    throw new ProviderContractError(
      '$.activeTurnBinding',
      'must match a durable native turn binding when bindings are supplied',
    );
  }
  return {
    commandId: identifier(record.commandId, '$.commandId'),
    providerInstanceId,
    conversationId: identifier(record.conversationId, '$.conversationId'),
    executionId: identifier(record.executionId, '$.executionId'),
    mode,
    ...(nativeSession ? { nativeSession } : {}),
    cwd: boundedString(record.cwd, '$.cwd', 32 * 1024),
    model: boundedString(record.model, '$.model'),
    ...(record.effort === undefined
      ? {}
      : { effort: boundedString(record.effort, '$.effort') }),
    access: oneOf(record.access, ['read-only', 'workspace-write', 'full-access'], '$.access'),
    developerInstructions: instructions.map((entry, index) =>
      boundedString(entry, `$.developerInstructions[${index}]`, 32 * 1024)),
    ...(federation ? { federation } : {}),
    ...(nativeTurnBindings.length > 0 ? { nativeTurnBindings } : {}),
    ...(inheritedNativeTurnIds.length > 0 ? { inheritedNativeTurnIds } : {}),
    ...(activeTurnBinding ? { activeTurnBinding } : {}),
  };
}

function parseNativeTurnBinding(value: unknown, path: string): NativeTurnBinding {
  const binding = strictRecord(value, path, [
    'turnId', 'nativeTurnId', 'nextBlockOrdinal', 'branchCursor',
  ], ['nextBlockOrdinal', 'branchCursor']);
  return {
    turnId: identifier(binding.turnId, `${path}.turnId`),
    nativeTurnId: identifier(binding.nativeTurnId, `${path}.nativeTurnId`),
    ...(binding.nextBlockOrdinal === undefined
      ? {}
      : { nextBlockOrdinal: nonnegativeInteger(
          binding.nextBlockOrdinal,
          `${path}.nextBlockOrdinal`,
        ) }),
    ...(binding.branchCursor === undefined
      ? {}
      : { branchCursor: jsonValue(binding.branchCursor, `${path}.branchCursor`) }),
  };
}

export function parseStartProviderTurnInput(value: unknown): StartProviderTurnInput {
  assertEncodedSize(value, PROVIDER_RUNTIME_LIMITS.eventBytes, '$');
  const record = strictRecord(value, '$', [
    'commandId', 'conversationId', 'turnId', 'executionId', 'content', 'model', 'effort',
  ], ['model', 'effort']);
  const content = parseUserContentParts(record.content);
  return {
    commandId: identifier(record.commandId, '$.commandId'),
    conversationId: identifier(record.conversationId, '$.conversationId'),
    turnId: identifier(record.turnId, '$.turnId'),
    executionId: identifier(record.executionId, '$.executionId'),
    content,
    ...(record.model === undefined ? {} : { model: boundedString(record.model, '$.model') }),
    ...(record.effort === undefined ? {} : { effort: boundedString(record.effort, '$.effort') }),
  };
}

export function parseSteerProviderTurnInput(value: unknown): SteerProviderTurnInput {
  assertEncodedSize(value, PROVIDER_RUNTIME_LIMITS.eventBytes, '$');
  const record = strictRecord(value, '$', ['commandId', 'turnId', 'content']);
  const content = parseUserContentParts(record.content);
  return {
    commandId: identifier(record.commandId, '$.commandId'),
    turnId: identifier(record.turnId, '$.turnId'),
    content,
  };
}

export function parseUserContentParts(value: unknown, path = '$.content'): readonly UserContentPart[] {
  const content = array(value, path);
  if (content.length === 0 || content.length > PROVIDER_RUNTIME_LIMITS.contentParts) {
    throw new ProviderContractError(
      path,
      `must contain 1-${PROVIDER_RUNTIME_LIMITS.contentParts} parts`,
    );
  }
  return content.map((part, index) => parseContentPart(part, index, path));
}

export function parseInterruptProviderTurnInput(value: unknown): InterruptProviderTurnInput {
  assertEncodedSize(value, PROVIDER_RUNTIME_LIMITS.eventBytes, '$');
  const record = strictRecord(value, '$', ['commandId', 'turnId']);
  return {
    commandId: identifier(record.commandId, '$.commandId'),
    turnId: identifier(record.turnId, '$.turnId'),
  };
}

export function parseInterruptProviderChildInput(value: unknown): InterruptProviderChildInput {
  const record = strictRecord(value, '$', [
    'commandId', 'childExecutionId', 'nativeSessionId',
  ]);
  return {
    commandId: identifier(record.commandId, '$.commandId'),
    childExecutionId: identifier(record.childExecutionId, '$.childExecutionId'),
    nativeSessionId: identifier(record.nativeSessionId, '$.nativeSessionId'),
  };
}

export function parseCompactProviderSessionInput(value: unknown): CompactProviderSessionInput {
  assertEncodedSize(value, PROVIDER_RUNTIME_LIMITS.eventBytes, '$');
  const record = strictRecord(value, '$', ['commandId', 'conversationId', 'executionId']);
  return {
    commandId: identifier(record.commandId, '$.commandId'),
    conversationId: identifier(record.conversationId, '$.conversationId'),
    executionId: identifier(record.executionId, '$.executionId'),
  };
}

export function parseProviderSnapshotRequest(value: unknown): ProviderSnapshotRequest {
  assertEncodedSize(value, PROVIDER_RUNTIME_LIMITS.eventBytes, '$');
  const record = strictRecord(value, '$', ['commandId', 'afterNativeSequence'], [
    'afterNativeSequence',
  ]);
  return {
    commandId: identifier(record.commandId, '$.commandId'),
    ...(record.afterNativeSequence === undefined
      ? {}
      : { afterNativeSequence: nonnegativeInteger(record.afterNativeSequence, '$.afterNativeSequence') }),
  };
}

export function parseNativeForkRequest(value: unknown): NativeForkRequest {
  assertEncodedSize(value, PROVIDER_RUNTIME_LIMITS.eventBytes, '$');
  const record = strictRecord(value, '$', [
    'commandId', 'throughNativeTurnId', 'beforeNativeTurnId', 'branchCursor',
    'destinationSessionId',
  ], ['throughNativeTurnId', 'beforeNativeTurnId', 'branchCursor', 'destinationSessionId']);
  if (record.throughNativeTurnId !== undefined && record.beforeNativeTurnId !== undefined) {
    throw new ProviderContractError(
      '$',
      'fork accepts at most one of throughNativeTurnId or beforeNativeTurnId',
    );
  }
  return {
    commandId: identifier(record.commandId, '$.commandId'),
    ...(record.throughNativeTurnId === undefined
      ? {}
      : { throughNativeTurnId: identifier(record.throughNativeTurnId, '$.throughNativeTurnId') }),
    ...(record.beforeNativeTurnId === undefined
      ? {}
      : { beforeNativeTurnId: identifier(record.beforeNativeTurnId, '$.beforeNativeTurnId') }),
    ...(record.branchCursor === undefined
      ? {}
      : { branchCursor: jsonValue(record.branchCursor, '$.branchCursor') }),
    ...(record.destinationSessionId === undefined
      ? {}
      : { destinationSessionId: identifier(record.destinationSessionId, '$.destinationSessionId') }),
  };
}

export function parseNativeRollbackRequest(value: unknown): NativeRollbackRequest {
  assertEncodedSize(value, PROVIDER_RUNTIME_LIMITS.eventBytes, '$');
  const record = strictRecord(value, '$', ['commandId', 'nativeTurnId']);
  return {
    commandId: identifier(record.commandId, '$.commandId'),
    nativeTurnId: identifier(record.nativeTurnId, '$.nativeTurnId'),
  };
}

export function parseDiscoverProviderSessionsInput(value: unknown): DiscoverProviderSessionsInput {
  assertEncodedSize(value, PROVIDER_RUNTIME_LIMITS.eventBytes, '$');
  const record = strictRecord(value, '$', [
    'providerInstanceId', 'cwd', 'limit', 'cursor',
  ], ['cwd', 'limit', 'cursor']);
  const limit = record.limit === undefined ? undefined : nonnegativeInteger(record.limit, '$.limit');
  if (limit !== undefined && (limit < 1 || limit > 200)) {
    throw new ProviderContractError('$.limit', 'must be between 1 and 200');
  }
  return {
    providerInstanceId: identifier(record.providerInstanceId, '$.providerInstanceId'),
    ...(record.cwd === undefined ? {} : { cwd: boundedString(record.cwd, '$.cwd', 32 * 1024) }),
    ...(limit === undefined ? {} : { limit }),
    ...(record.cursor === undefined
      ? {}
      : { cursor: boundedString(record.cursor, '$.cursor', 16 * 1024) }),
  };
}

export function parseProviderLoginStartInput(value: unknown): ProviderLoginStartInput {
  assertEncodedSize(value, PROVIDER_RUNTIME_LIMITS.eventBytes, '$');
  const record = strictRecord(value, '$', ['commandId', 'providerInstanceId', 'mode']);
  return {
    commandId: identifier(record.commandId, '$.commandId'),
    providerInstanceId: identifier(record.providerInstanceId, '$.providerInstanceId'),
    mode: oneOf(record.mode, ['device-code', 'browser'], '$.mode'),
  };
}

export function parseProviderLogoutInput(value: unknown): ProviderLogoutInput {
  assertEncodedSize(value, PROVIDER_RUNTIME_LIMITS.eventBytes, '$');
  const record = strictRecord(value, '$', ['commandId', 'providerInstanceId']);
  return {
    commandId: identifier(record.commandId, '$.commandId'),
    providerInstanceId: identifier(record.providerInstanceId, '$.providerInstanceId'),
  };
}

export function parseProviderEventEnvelope(value: unknown): ProviderEventEnvelope {
  assertEncodedSize(value, providerEventEnvelopeByteLimit(value), '$');
  const record = strictRecord(value, '$', [
    'contractVersion', 'eventId', 'provider', 'scope', 'native', 'observedAt', 'event',
    'rawArtifactRef',
  ], ['rawArtifactRef']);
  providerRuntimeContractVersion(record.contractVersion, '$.contractVersion');
  const native = strictRecord(record.native, '$.native', [
    'sessionId', 'turnId', 'messageId', 'itemId', 'toolCallId', 'position',
    'subject', 'timeline', 'kind',
  ], [
    'sessionId', 'turnId', 'messageId', 'itemId', 'toolCallId', 'position',
    'subject', 'timeline',
  ]);
  const event = parseProviderEvent(record.event, '$.event');
  const scope = parseProviderEventScope(record.scope, '$.scope');
  assertEventScope(event, scope);
  const envelope: ProviderEventEnvelope = {
    contractVersion: PROVIDER_RUNTIME_CONTRACT_VERSION,
    eventId: identifier(record.eventId, '$.eventId'),
    provider: providerKind(record.provider, '$.provider'),
    scope,
    native: {
      ...(native.sessionId === undefined
        ? {}
        : { sessionId: identifier(native.sessionId, '$.native.sessionId') }),
      ...(native.turnId === undefined ? {} : { turnId: identifier(native.turnId, '$.native.turnId') }),
      ...(native.messageId === undefined
        ? {}
        : { messageId: identifier(native.messageId, '$.native.messageId') }),
      ...(native.itemId === undefined ? {} : { itemId: identifier(native.itemId, '$.native.itemId') }),
      ...(native.toolCallId === undefined
        ? {}
        : { toolCallId: identifier(native.toolCallId, '$.native.toolCallId') }),
      ...(native.position === undefined
        ? {}
        : { position: parseNativePosition(native.position, '$.native.position') }),
      ...(native.subject === undefined
        ? {}
        : { subject: parseNativeProviderSubject(native.subject, '$.native.subject') }),
      ...(native.timeline === undefined
        ? {}
        : { timeline: parseNativeTimelineBoundary(native.timeline, '$.native.timeline') }),
      kind: boundedString(native.kind, '$.native.kind'),
    },
    observedAt: nonnegativeInteger(record.observedAt, '$.observedAt'),
    event,
    ...(record.rawArtifactRef === undefined
      ? {}
      : { rawArtifactRef: identifier(record.rawArtifactRef, '$.rawArtifactRef') }),
  };
  if (scope.kind !== 'account' && !envelope.native.sessionId) {
    throw new ProviderContractError('$.native.sessionId', 'is required outside account scope');
  }
  return envelope;
}

export function parseProviderSnapshot(value: unknown): ProviderSnapshot {
  assertEncodedSize(value, PROVIDER_RUNTIME_LIMITS.snapshotBytes, '$');
  const record = strictRecord(value, '$', [
    'contractVersion', 'nativeSession', 'state', 'authority', 'coverage', 'events',
    'historyRevision', 'nextNativeSequence',
  ], ['authority', 'coverage', 'historyRevision', 'nextNativeSequence']);
  providerRuntimeContractVersion(record.contractVersion, '$.contractVersion');
  const events = array(record.events, '$.events');
  if (events.length > PROVIDER_RUNTIME_LIMITS.snapshotEvents) {
    throw new ProviderContractError('$.events', 'snapshot contains too many events');
  }
  return {
    contractVersion: PROVIDER_RUNTIME_CONTRACT_VERSION,
    nativeSession: parseNativeSessionRef(record.nativeSession, '$.nativeSession'),
    state: oneOf(record.state, ['running', 'idle', 'lost'], '$.state'),
    ...(record.authority === undefined
      ? {}
      : { authority: oneOf(record.authority, ['authoritative', 'session-local'], '$.authority') }),
    ...(record.coverage === undefined
      ? {}
      : { coverage: parseProviderSnapshotCoverage(record.coverage, '$.coverage') }),
    ...(record.historyRevision === undefined
      ? {}
      : { historyRevision: boundedString(record.historyRevision, '$.historyRevision') }),
    events: events.map((event, index) => parseProviderEventEnvelopeAt(event, `$.events[${index}]`)),
    ...(record.nextNativeSequence === undefined
      ? {}
      : { nextNativeSequence: nonnegativeInteger(record.nextNativeSequence, '$.nextNativeSequence') }),
  };
}

function parseProviderSnapshotCoverage(value: unknown, path: string): ProviderSnapshotCoverage {
  const record = strictRecord(value, path, ['turnBlocks']);
  const turnBlocks = strictRecord(record.turnBlocks, `${path}.turnBlocks`, ['completeKinds']);
  const values = array(turnBlocks.completeKinds, `${path}.turnBlocks.completeKinds`);
  const completeKinds = values.map((kind, index) => oneOf(
    kind,
    PROVIDER_TURN_BLOCK_KINDS,
    `${path}.turnBlocks.completeKinds[${index}]`,
  ));
  if (new Set(completeKinds).size !== completeKinds.length) {
    throw new ProviderContractError(`${path}.turnBlocks.completeKinds`, 'must not contain duplicates');
  }
  return { turnBlocks: { completeKinds } };
}

function parseProviderEventEnvelopeAt(value: unknown, path: string): ProviderEventEnvelope {
  try {
    return parseProviderEventEnvelope(value);
  } catch (error) {
    if (error instanceof ProviderContractError) {
      throw new ProviderContractError(`${path}${error.path.slice(1)}`, error.message.slice(error.path.length + 2));
    }
    throw error;
  }
}

function parseNativeProviderSubject(value: unknown, path: string): NativeProviderSubject {
  const record = strictRecord(value, path, ['kind', 'key']);
  return {
    kind: boundedString(record.kind, `${path}.kind`),
    key: identifier(record.key, `${path}.key`),
  };
}

function parseNativeTimelineBoundary(value: unknown, path: string): NativeTimelineBoundary {
  const record = strictRecord(value, path, [
    'previousTurnId', 'nextTurnId',
  ], ['previousTurnId', 'nextTurnId']);
  if (record.previousTurnId === undefined && record.nextTurnId === undefined) {
    throw new ProviderContractError(path, 'must include previousTurnId or nextTurnId');
  }
  return {
    ...(record.previousTurnId === undefined
      ? {}
      : { previousTurnId: identifier(record.previousTurnId, `${path}.previousTurnId`) }),
    ...(record.nextTurnId === undefined
      ? {}
      : { nextTurnId: identifier(record.nextTurnId, `${path}.nextTurnId`) }),
  };
}

function parseNativeSessionRef(value: unknown, path: string): NativeSessionRef {
  const record = strictRecord(value, path, [
    'provider', 'providerInstanceId', 'sessionId', 'resumeCursor',
  ], ['resumeCursor']);
  const resumeCursor = record.resumeCursor === undefined
    ? undefined
    : jsonValue(record.resumeCursor, `${path}.resumeCursor`);
  return {
    provider: providerKind(record.provider, `${path}.provider`),
    providerInstanceId: identifier(record.providerInstanceId, `${path}.providerInstanceId`),
    sessionId: identifier(record.sessionId, `${path}.sessionId`),
    ...(resumeCursor === undefined ? {} : { resumeCursor }),
  };
}

function parseFederationSession(value: unknown, path: string): FederationSessionConfig {
  const record = strictRecord(value, path, ['endpoint', 'authorizationHeader']);
  const endpoint = boundedString(record.endpoint, `${path}.endpoint`, 8 * 1024);
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new ProviderContractError(`${path}.endpoint`, 'must be an absolute HTTP URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ProviderContractError(`${path}.endpoint`, 'must use HTTP or HTTPS');
  }
  const authorizationHeader = boundedString(
    record.authorizationHeader,
    `${path}.authorizationHeader`,
    16 * 1024,
  );
  if (!authorizationHeader.startsWith('Bearer ') || authorizationHeader.length <= 7) {
    throw new ProviderContractError(`${path}.authorizationHeader`, 'must be a bearer credential');
  }
  return { endpoint, authorizationHeader };
}

function parseContentPart(value: unknown, index: number, basePath = '$.content'): UserContentPart {
  const path = `${basePath}[${index}]`;
  const base = strictRecord(value, path, [
    'type', 'text', 'artifactId', 'mimeType', 'name', 'byteLength', 'path',
  ], ['text', 'artifactId', 'mimeType', 'name', 'byteLength', 'path']);
  const type = oneOf(base.type, ['text', 'image-artifact', 'file-reference'], `${path}.type`);
  if (type === 'text') {
    assertExactKeys(base, path, ['type', 'text']);
    return { type, text: boundedString(base.text, `${path}.text`, PROVIDER_RUNTIME_LIMITS.messageChars) };
  }
  if (type === 'image-artifact') {
    assertExactKeys(base, path, [
      'type', 'artifactId', 'mimeType',
      ...(base.name === undefined ? [] : ['name']),
      ...(base.byteLength === undefined ? [] : ['byteLength']),
    ]);
    const mimeType = boundedString(base.mimeType, `${path}.mimeType`, 256);
    if (!mimeType.startsWith('image/')) {
      throw new ProviderContractError(`${path}.mimeType`, 'must be an image media type');
    }
    return {
      type,
      artifactId: identifier(base.artifactId, `${path}.artifactId`),
      mimeType,
      ...(base.name === undefined
        ? {}
        : { name: boundedString(base.name, `${path}.name`, 1_024) }),
      ...(base.byteLength === undefined
        ? {}
        : { byteLength: nonnegativeInteger(base.byteLength, `${path}.byteLength`) }),
    };
  }
  assertExactKeys(base, path, ['type', 'path']);
  return { type, path: boundedString(base.path, `${path}.path`, 32 * 1024) };
}

function parseProviderEvent(value: unknown, path: string): ProviderEvent {
  const record = recordValue(value, path);
  const type = boundedString(record.type, `${path}.type`, 128);
  switch (type) {
    case 'session.bound':
      assertExactKeys(record, path, ['type', 'resumed']);
      return { type, resumed: bool(record.resumed, `${path}.resumed`) };
    case 'session.materialized':
      assertExactKeys(record, path, ['type']);
      return { type };
    case 'session.health': {
      assertAllowedKeys(record, path, ['type', 'state', 'message']);
      return {
        type,
        state: oneOf(record.state, ['ready', 'recovering', 'lost'], `${path}.state`),
        ...(record.message === undefined ? {} : { message: boundedString(record.message, `${path}.message`) }),
      };
    }
    case 'turn.started':
      assertExactKeys(record, path, ['type']);
      return { type };
    case 'turn.status':
      assertExactKeys(record, path, ['type', 'state']);
      return { type, state: oneOf(record.state, ['running', 'recovering', 'idle'], `${path}.state`) };
    case 'turn.completed': {
      assertAllowedKeys(record, path, ['type', 'outcome', 'error']);
      return {
        type,
        outcome: oneOf(
          record.outcome,
          ['completed', 'failed', 'interrupted', 'recovery_failed'],
          `${path}.outcome`,
        ),
        ...(record.error === undefined ? {} : { error: parseDisplayError(record.error, `${path}.error`) }),
      };
    }
    case 'user.message': {
      assertExactKeys(record, path, ['type', 'content']);
      const content = array(record.content, `${path}.content`);
      if (content.length === 0 || content.length > PROVIDER_RUNTIME_LIMITS.contentParts) {
        throw new ProviderContractError(
          `${path}.content`,
          `must contain 1-${PROVIDER_RUNTIME_LIMITS.contentParts} parts`,
        );
      }
      return {
        type,
        content: content.map((entry, index) => parseContentPart(entry, index, `${path}.content`)),
      };
    }
    case 'turn.block.started':
      assertExactKeys(record, path, ['type', 'structure', 'block']);
      return {
        type,
        structure: parseTurnStructure(record.structure, `${path}.structure`),
        block: parseTurnBlockSnapshot(record.block, `${path}.block`),
      };
    case 'turn.block.revised':
    case 'turn.block.completed':
      assertExactKeys(record, path, ['type', 'structure', 'revision', 'contentHash', 'block']);
      return {
        type,
        structure: parseTurnStructure(record.structure, `${path}.structure`),
        revision: nonnegativeInteger(record.revision, `${path}.revision`),
        contentHash: sha256(record.contentHash, `${path}.contentHash`),
        block: parseTurnBlockSnapshot(record.block, `${path}.block`),
      };
    case 'turn.file-changed':
      assertAllowedKeys(record, path, ['type', 'change', 'blockId']);
      return {
        type,
        change: parseFileChange(record.change, `${path}.change`),
        ...(record.blockId === undefined ? {} : { blockId: identifier(record.blockId, `${path}.blockId`) }),
      };
    case 'turn.usage-updated':
      assertExactKeys(record, path, ['type', 'usage']);
      return { type, usage: parseUsage(record.usage, `${path}.usage`) };
    case 'turn.branch-point':
      assertExactKeys(record, path, ['type', 'cursor', 'cursorVersion']);
      return {
        type,
        cursor: jsonValue(record.cursor, `${path}.cursor`),
        cursorVersion: positiveInteger(record.cursorVersion, `${path}.cursorVersion`),
      };
    case 'context.compaction.started':
      assertExactKeys(record, path, ['type', 'trigger', 'operationId', 'beforeTokens']);
      return {
        type,
        trigger: oneOf(record.trigger, ['manual', 'automatic'], `${path}.trigger`),
        operationId: identifier(record.operationId, `${path}.operationId`),
        beforeTokens: nullableNonnegativeInteger(record.beforeTokens, `${path}.beforeTokens`),
      };
    case 'context.compaction.completed':
      assertExactKeys(record, path, ['type', 'trigger', 'operationId', 'beforeTokens', 'afterTokens']);
      return {
        type,
        trigger: oneOf(record.trigger, ['manual', 'automatic'], `${path}.trigger`),
        operationId: identifier(record.operationId, `${path}.operationId`),
        beforeTokens: nullableNonnegativeInteger(record.beforeTokens, `${path}.beforeTokens`),
        afterTokens: nullableNonnegativeInteger(record.afterTokens, `${path}.afterTokens`),
      };
    case 'context.compaction.failed':
      assertExactKeys(record, path, ['type', 'trigger', 'operationId', 'error']);
      return {
        type,
        trigger: oneOf(record.trigger, ['manual', 'automatic'], `${path}.trigger`),
        operationId: identifier(record.operationId, `${path}.operationId`),
        error: parseDisplayError(record.error, `${path}.error`),
      };
    case 'account.usage-updated':
      assertExactKeys(record, path, ['type', 'usage']);
      return { type, usage: parseProviderAccountUsage(record.usage, `${path}.usage`) };
    case 'execution.started':
      assertExactKeys(record, path, ['type', 'child']);
      return { type, child: parseChild(record.child, `${path}.child`) };
    case 'execution.status':
      assertExactKeys(record, path, ['type', 'childExecutionId', 'state']);
      return {
        type,
        childExecutionId: identifier(record.childExecutionId, `${path}.childExecutionId`),
        state: oneOf(
          record.state,
          ['running', 'recovering', 'idle', 'failed', 'interrupted'],
          `${path}.state`,
        ),
      };
    case 'execution.summary':
      assertExactKeys(record, path, ['type', 'childExecutionId', 'summary']);
      return {
        type,
        childExecutionId: identifier(record.childExecutionId, `${path}.childExecutionId`),
        summary: boundedString(record.summary, `${path}.summary`, PROVIDER_RUNTIME_LIMITS.messageChars),
      };
    case 'execution.completed':
      assertExactKeys(record, path, ['type', 'childExecutionId', 'outcome']);
      return {
        type,
        childExecutionId: identifier(record.childExecutionId, `${path}.childExecutionId`),
        outcome: oneOf(
          record.outcome,
          ['completed', 'failed', 'interrupted', 'recovery_failed'],
          `${path}.outcome`,
        ),
      };
    case 'compatibility.notice':
      assertExactKeys(record, path, ['type', 'code', 'message']);
      return {
        type,
        code: identifier(record.code, `${path}.code`),
        message: boundedString(record.message, `${path}.message`),
      };
    default:
      throw new ProviderContractError(`${path}.type`, `unsupported provider event ${JSON.stringify(type)}`);
  }
}

function parseProviderEventScope(value: unknown, path: string): ProviderEventScope {
  const record = recordValue(value, path);
  const kind = oneOf(record.kind, ['account', 'conversation', 'turn', 'execution'], `${path}.kind`);
  if (kind === 'account') {
    assertExactKeys(record, path, ['kind', 'providerInstanceId']);
    return {
      kind,
      providerInstanceId: identifier(record.providerInstanceId, `${path}.providerInstanceId`),
    };
  }
  if (kind === 'conversation') {
    assertExactKeys(record, path, ['kind', 'providerInstanceId', 'conversationId', 'executionId']);
    return {
      kind,
      providerInstanceId: identifier(record.providerInstanceId, `${path}.providerInstanceId`),
      conversationId: identifier(record.conversationId, `${path}.conversationId`),
      executionId: identifier(record.executionId, `${path}.executionId`),
    };
  }
  if (kind === 'turn') {
    assertExactKeys(record, path, [
      'kind', 'providerInstanceId', 'conversationId', 'executionId', 'turnId',
    ]);
    return {
      kind,
      providerInstanceId: identifier(record.providerInstanceId, `${path}.providerInstanceId`),
      conversationId: identifier(record.conversationId, `${path}.conversationId`),
      executionId: identifier(record.executionId, `${path}.executionId`),
      turnId: identifier(record.turnId, `${path}.turnId`),
    };
  }
  assertAllowedKeys(record, path, [
    'kind', 'providerInstanceId', 'conversationId', 'executionId', 'parentExecutionId', 'rootTurnId',
  ]);
  for (const key of ['providerInstanceId', 'conversationId', 'executionId']) {
    if (!(key in record)) throw new ProviderContractError(`${path}.${key}`, 'is required');
  }
  return {
    kind,
    providerInstanceId: identifier(record.providerInstanceId, `${path}.providerInstanceId`),
    conversationId: identifier(record.conversationId, `${path}.conversationId`),
    executionId: identifier(record.executionId, `${path}.executionId`),
    ...(record.parentExecutionId === undefined
      ? {}
      : { parentExecutionId: identifier(record.parentExecutionId, `${path}.parentExecutionId`) }),
    ...(record.rootTurnId === undefined
      ? {}
      : { rootTurnId: identifier(record.rootTurnId, `${path}.rootTurnId`) }),
  };
}

function parseNativePosition(value: unknown, path: string): NativePosition {
  const record = recordValue(value, path);
  const kind = oneOf(
    record.kind,
    ['native-sequence', 'message-block', 'snapshot-index'],
    `${path}.kind`,
  );
  if (kind === 'native-sequence') {
    assertExactKeys(record, path, ['kind', 'sequence', 'subIndex']);
    return {
      kind,
      sequence: nonnegativeInteger(record.sequence, `${path}.sequence`),
      subIndex: nonnegativeInteger(record.subIndex, `${path}.subIndex`),
    };
  }
  if (kind === 'message-block') {
    assertExactKeys(record, path, ['kind', 'messageId', 'blockIndex', 'subIndex']);
    return {
      kind,
      messageId: identifier(record.messageId, `${path}.messageId`),
      blockIndex: nonnegativeInteger(record.blockIndex, `${path}.blockIndex`),
      subIndex: nonnegativeInteger(record.subIndex, `${path}.subIndex`),
    };
  }
  assertExactKeys(record, path, ['kind', 'itemIndex', 'subIndex']);
  return {
    kind,
    itemIndex: nonnegativeInteger(record.itemIndex, `${path}.itemIndex`),
    subIndex: nonnegativeInteger(record.subIndex, `${path}.subIndex`),
  };
}

function parseTurnStructure(value: unknown, path: string): TurnStructure {
  const record = strictRecord(value, path, [
    'passId', 'blockId', 'passOrdinal', 'blockOrdinal',
  ]);
  return {
    passId: identifier(record.passId, `${path}.passId`),
    blockId: identifier(record.blockId, `${path}.blockId`),
    passOrdinal: nonnegativeInteger(record.passOrdinal, `${path}.passOrdinal`),
    blockOrdinal: nonnegativeInteger(record.blockOrdinal, `${path}.blockOrdinal`),
  };
}

function parseTurnBlockSnapshot(value: unknown, path: string): TurnBlockSnapshot {
  const record = strictRecord(value, path, ['kind', 'state', 'payload']);
  const kind = oneOf(record.kind, PROVIDER_TURN_BLOCK_KINDS, `${path}.kind`);
  const state = oneOf(
    record.state,
    ['streaming', 'running', 'completed', 'failed', 'interrupted'],
    `${path}.state`,
  );
  const payload = parseTurnBlockPayload(record.payload, `${path}.payload`);
  if (payload.kind !== kind) {
    throw new ProviderContractError(`${path}.payload.kind`, 'must match block kind');
  }
  return { kind, state, payload };
}

function parseTurnBlockPayload(value: unknown, path: string): TurnBlockPayload {
  const record = recordValue(value, path);
  const kind = oneOf(record.kind, PROVIDER_TURN_BLOCK_KINDS, `${path}.kind`);
  if (kind === 'reasoning-summary') {
    assertAllowedKeys(record, path, ['kind', 'text', 'parts']);
    if (!('text' in record)) throw new ProviderContractError(`${path}.text`, 'is required');
    const text = boundedString(record.text, `${path}.text`, PROVIDER_RUNTIME_LIMITS.messageChars);
    if (record.parts === undefined) return { kind, text };
    const values = array(record.parts, `${path}.parts`);
    if (values.length === 0 || values.length > 256) {
      throw new ProviderContractError(`${path}.parts`, 'must contain 1-256 summary parts');
    }
    const parts = values.map((part, index) => boundedString(
      part,
      `${path}.parts[${index}]`,
      PROVIDER_RUNTIME_LIMITS.messageChars,
    ));
    if (parts.join('\n') !== text) {
      throw new ProviderContractError(`${path}.parts`, 'must join to the compatibility text');
    }
    return { kind, text, parts };
  }
  if (kind === 'commentary' || kind === 'final-message') {
    assertExactKeys(record, path, ['kind', 'text']);
    return {
      kind,
      text: boundedString(
        record.text,
        `${path}.text`,
        kind === 'final-message'
          ? PROVIDER_RUNTIME_LIMITS.finalTextChars
          : PROVIDER_RUNTIME_LIMITS.messageChars,
      ),
    };
  }
  if (kind === 'tool') {
    assertAllowedKeys(record, path, [
      'kind', 'tool', 'inputPreview', 'outputPreview', 'detailRef',
    ]);
    if (!('tool' in record)) throw new ProviderContractError(`${path}.tool`, 'is required');
    return {
      kind,
      tool: parseToolDisplay(record.tool, `${path}.tool`),
      ...(record.inputPreview === undefined
        ? {}
        : { inputPreview: boundedJsonPreview(record.inputPreview, `${path}.inputPreview`) }),
      ...(record.outputPreview === undefined
        ? {}
        : { outputPreview: boundedJsonPreview(record.outputPreview, `${path}.outputPreview`) }),
      ...(record.detailRef === undefined
        ? {}
        : { detailRef: identifier(record.detailRef, `${path}.detailRef`) }),
    };
  }
  if (kind === 'native-child' || kind === 'federated-child') {
    assertAllowedKeys(record, path, [
      'kind', 'child', 'executionState', 'outcome', 'summary',
    ]);
    for (const key of ['child', 'executionState']) {
      if (!(key in record)) throw new ProviderContractError(`${path}.${key}`, 'is required');
    }
    const child = parseChild(record.child, `${path}.child`);
    if (child.ownership !== (kind === 'native-child' ? 'native' : 'federated')) {
      throw new ProviderContractError(`${path}.child.ownership`, 'must match block kind');
    }
    return {
      kind,
      child,
      executionState: oneOf(
        record.executionState,
        ['running', 'recovering', 'idle', 'failed', 'interrupted'],
        `${path}.executionState`,
      ),
      ...(record.outcome === undefined
        ? {}
        : {
            outcome: oneOf(
              record.outcome,
              ['completed', 'failed', 'interrupted', 'recovery_failed'],
              `${path}.outcome`,
            ),
          }),
      ...(record.summary === undefined
        ? {}
        : { summary: boundedString(record.summary, `${path}.summary`, PROVIDER_RUNTIME_LIMITS.messageChars) }),
    };
  }
  if (kind === 'web') {
    assertExactKeys(record, path, ['kind', 'activity']);
    return { kind, activity: parseWebActivity(record.activity, `${path}.activity`) };
  }
  assertExactKeys(record, path, ['kind', 'code', 'message']);
  return {
    kind,
    code: identifier(record.code, `${path}.code`),
    message: boundedString(record.message, `${path}.message`),
  };
}

function assertEventScope(event: ProviderEvent, scope: ProviderEventScope) {
  if (event.type === 'compatibility.notice') {
    if (scope.kind === 'account') {
      throw new ProviderContractError('$.scope.kind', 'compatibility.notice cannot use account scope');
    }
    return;
  }
  const expected = event.type === 'account.usage-updated'
    ? 'account'
    : event.type.startsWith('context.compaction.') || event.type.startsWith('session.')
      ? 'conversation'
      : event.type.startsWith('execution.')
        ? 'execution'
        : 'turn';
  if (scope.kind !== expected) {
    throw new ProviderContractError('$.scope.kind', `${event.type} requires ${expected} scope`);
  }
}

function parseDisplayError(value: unknown, path: string): DisplayError {
  const record = strictRecord(value, path, ['code', 'message', 'retryable'], ['retryable']);
  return {
    code: identifier(record.code, `${path}.code`),
    message: boundedString(record.message, `${path}.message`),
    ...(record.retryable === undefined ? {} : { retryable: bool(record.retryable, `${path}.retryable`) }),
  };
}

function parseToolDisplay(value: unknown, path: string): ToolDisplay {
  const record = strictRecord(value, path, ['callId', 'name', 'category', 'title'], ['category', 'title']);
  return {
    callId: identifier(record.callId, `${path}.callId`),
    name: boundedString(record.name, `${path}.name`),
    ...(record.category === undefined
      ? {}
      : {
          category: oneOf(
            record.category,
            ['shell', 'file', 'search', 'web', 'mcp', 'collaboration', 'other'],
            `${path}.category`,
          ),
        }),
    ...(record.title === undefined ? {} : { title: boundedString(record.title, `${path}.title`) }),
  };
}

function parseFileChange(value: unknown, path: string): ProviderFileChange {
  const record = strictRecord(value, path, ['path', 'kind', 'oldPath', 'diffArtifactId', 'diff'], [
    'oldPath', 'diffArtifactId', 'diff',
  ]);
  return {
    path: boundedString(record.path, `${path}.path`, 32 * 1024),
    kind: oneOf(record.kind, ['add', 'delete', 'update', 'move'], `${path}.kind`),
    ...(record.oldPath === undefined
      ? {}
      : { oldPath: boundedString(record.oldPath, `${path}.oldPath`, 32 * 1024) }),
    ...(record.diffArtifactId === undefined
      ? {}
      : { diffArtifactId: identifier(record.diffArtifactId, `${path}.diffArtifactId`) }),
    ...(record.diff === undefined
      ? {}
      : { diff: boundedString(record.diff, `${path}.diff`, PROVIDER_RUNTIME_LIMITS.finalTextChars) }),
  };
}

function parseWebActivity(value: unknown, path: string): WebActivityDisplay {
  const record = strictRecord(value, path, ['kind', 'title', 'url', 'query'], ['title', 'url', 'query']);
  return {
    kind: oneOf(record.kind, ['search', 'open', 'other'], `${path}.kind`),
    ...(record.title === undefined ? {} : { title: boundedString(record.title, `${path}.title`) }),
    ...(record.url === undefined ? {} : { url: boundedString(record.url, `${path}.url`, 32 * 1024) }),
    ...(record.query === undefined ? {} : { query: boundedString(record.query, `${path}.query`) }),
  };
}

function parseUsage(value: unknown, path: string): UsageDisplay {
  const record = strictRecord(value, path, ['turn', 'cumulative', 'context', 'estimatedCost']);
  return {
    turn: record.turn === null ? null : parseTokenUsage(record.turn, `${path}.turn`),
    cumulative: record.cumulative === null
      ? null
      : parseCumulativeUsage(record.cumulative, `${path}.cumulative`),
    context: record.context === null
      ? null
      : parseContextUsage(record.context, `${path}.context`),
    estimatedCost: record.estimatedCost === null
      ? null
      : parseEstimatedCost(record.estimatedCost, `${path}.estimatedCost`),
  };
}

function parseTokenUsage(value: unknown, path: string): TokenUsageBreakdown {
  const keys = [
    'inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens',
    'reasoningOutputTokens', 'totalTokens',
  ] as const;
  const record = strictRecord(value, path, keys);
  return {
    inputTokens: nullableNonnegativeInteger(record.inputTokens, `${path}.inputTokens`),
    cachedInputTokens: nullableNonnegativeInteger(record.cachedInputTokens, `${path}.cachedInputTokens`),
    cacheWriteInputTokens: nullableNonnegativeInteger(
      record.cacheWriteInputTokens,
      `${path}.cacheWriteInputTokens`,
    ),
    outputTokens: nullableNonnegativeInteger(record.outputTokens, `${path}.outputTokens`),
    reasoningOutputTokens: nullableNonnegativeInteger(
      record.reasoningOutputTokens,
      `${path}.reasoningOutputTokens`,
    ),
    totalTokens: nullableNonnegativeInteger(record.totalTokens, `${path}.totalTokens`),
  };
}

function parseCumulativeUsage(value: unknown, path: string): CumulativeUsage {
  const record = strictRecord(value, path, ['tokens', 'scope', 'epochId']);
  return {
    tokens: parseTokenUsage(record.tokens, `${path}.tokens`),
    scope: oneOf(record.scope, ['native-conversation', 'runtime-epoch'], `${path}.scope`),
    epochId: identifier(record.epochId, `${path}.epochId`),
  };
}

function parseContextUsage(value: unknown, path: string): ContextUsageSnapshot {
  const record = strictRecord(value, path, [
    'usedTokens', 'windowTokens', 'percent', 'measurement', 'freshness', 'observedAt', 'turnId',
  ]);
  const windowTokens = positiveInteger(record.windowTokens, `${path}.windowTokens`);
  return {
    usedTokens: nonnegativeInteger(record.usedTokens, `${path}.usedTokens`),
    windowTokens,
    percent: percentage(record.percent, `${path}.percent`),
    measurement: oneOf(record.measurement, ['provider', 'derived'], `${path}.measurement`),
    freshness: oneOf(record.freshness, ['live', 'cached'], `${path}.freshness`),
    observedAt: nonnegativeInteger(record.observedAt, `${path}.observedAt`),
    turnId: record.turnId === null ? null : identifier(record.turnId, `${path}.turnId`),
  };
}

function parseEstimatedCost(value: unknown, path: string): EstimatedCost {
  const record = strictRecord(value, path, ['usd', 'scope', 'epochId']);
  exactLiteral(record.scope, 'runtime-epoch', `${path}.scope`);
  return {
    usd: nonnegativeFinite(record.usd, `${path}.usd`),
    scope: 'runtime-epoch',
    epochId: identifier(record.epochId, `${path}.epochId`),
  };
}

function parseProviderAccountUsage(value: unknown, path: string): ProviderAccountUsage {
  const record = strictRecord(value, path, [
    'availability', 'windows', 'source', 'freshness', 'observedAt',
  ]);
  const windows = array(record.windows, `${path}.windows`);
  if (windows.length > 32) throw new ProviderContractError(`${path}.windows`, 'contains too many windows');
  const parsedWindows = windows.map((window, index) => parseAccountUsageWindow(
    window,
    `${path}.windows[${index}]`,
  ));
  if (new Set(parsedWindows.map(({ id }) => id)).size !== parsedWindows.length) {
    throw new ProviderContractError(`${path}.windows`, 'contains duplicate window IDs');
  }
  const availability = oneOf(
    record.availability,
    ['available', 'not-applicable', 'unknown'],
    `${path}.availability`,
  );
  if (availability !== 'available' && parsedWindows.length > 0) {
    throw new ProviderContractError(`${path}.windows`, 'must be empty unless usage is available');
  }
  return {
    availability,
    windows: parsedWindows,
    source: oneOf(record.source, ['provider-push', 'provider-read'], `${path}.source`),
    freshness: oneOf(record.freshness, ['live', 'cached'], `${path}.freshness`),
    observedAt: nonnegativeInteger(record.observedAt, `${path}.observedAt`),
  };
}

function parseAccountUsageWindow(value: unknown, path: string): AccountUsageWindow {
  const record = strictRecord(value, path, [
    'id', 'label', 'kind', 'model', 'usedPercent', 'resetsAt',
  ]);
  return {
    id: identifier(record.id, `${path}.id`),
    label: boundedString(record.label, `${path}.label`, 512),
    kind: oneOf(record.kind, ['rolling', 'weekly', 'model', 'extra'], `${path}.kind`),
    model: record.model === null ? null : boundedString(record.model, `${path}.model`),
    usedPercent: percentage(record.usedPercent, `${path}.usedPercent`),
    resetsAt: nullableNonnegativeInteger(record.resetsAt, `${path}.resetsAt`),
  };
}

function parseChild(value: unknown, path: string): ChildExecutionDisplay {
  const record = strictRecord(value, path, [
    'executionId', 'ownership', 'provider', 'providerInstanceId', 'model', 'title',
    'nativeSessionId', 'transcriptAvailable',
  ], ['providerInstanceId', 'model', 'title', 'nativeSessionId', 'transcriptAvailable']);
  return {
    executionId: identifier(record.executionId, `${path}.executionId`),
    ownership: oneOf(record.ownership, ['native', 'federated'], `${path}.ownership`),
    provider: providerKind(record.provider, `${path}.provider`),
    ...(record.providerInstanceId === undefined
      ? {}
      : { providerInstanceId: identifier(record.providerInstanceId, `${path}.providerInstanceId`) }),
    ...(record.model === undefined ? {} : { model: boundedString(record.model, `${path}.model`) }),
    ...(record.title === undefined ? {} : { title: boundedString(record.title, `${path}.title`) }),
    ...(record.nativeSessionId === undefined
      ? {}
      : { nativeSessionId: identifier(record.nativeSessionId, `${path}.nativeSessionId`) }),
    ...(record.transcriptAvailable === undefined
      ? {}
      : { transcriptAvailable: bool(record.transcriptAvailable, `${path}.transcriptAvailable`) }),
  };
}

function boundedJsonPreview(value: unknown, path: string): JsonValue {
  assertEncodedSize(value, PROVIDER_RUNTIME_LIMITS.previewBytes, path);
  return jsonValue(value, path);
}

function jsonValue(value: unknown, path: string, depth = 0): JsonValue {
  if (depth > 32) throw new ProviderContractError(path, 'JSON nesting exceeds 32 levels');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return boundedString(value, path, PROVIDER_RUNTIME_LIMITS.messageChars);
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if (value.length > 2_048) throw new ProviderContractError(path, 'JSON array is too large');
    return value.map((entry, index) => jsonValue(entry, `${path}[${index}]`, depth + 1));
  }
  const record = recordValue(value, path);
  const entries = Object.entries(record);
  if (entries.length > 2_048) throw new ProviderContractError(path, 'JSON object is too large');
  return Object.fromEntries(entries.map(([key, entry]) => [
    boundedString(key, `${path} key`, 512),
    jsonValue(entry, `${path}.${key}`, depth + 1),
  ]));
}

function strictRecord(
  value: unknown,
  path: string,
  keys: readonly string[],
  optional: readonly string[] = [],
) {
  const record = recordValue(value, path);
  assertAllowedKeys(record, path, keys);
  for (const key of keys) {
    if (!optional.includes(key) && !(key in record)) {
      throw new ProviderContractError(`${path}.${key}`, 'is required');
    }
  }
  return record;
}

function recordValue(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProviderContractError(path, 'must be an object');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ProviderContractError(path, 'must be a plain object');
  }
  return value as Record<string, unknown>;
}

function assertAllowedKeys(record: Record<string, unknown>, path: string, keys: readonly string[]) {
  const allowed = new Set(keys);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new ProviderContractError(`${path}.${key}`, 'is not allowed');
  }
}

function assertExactKeys(record: Record<string, unknown>, path: string, keys: readonly string[]) {
  assertAllowedKeys(record, path, keys);
  for (const key of keys) {
    if (!(key in record)) throw new ProviderContractError(`${path}.${key}`, 'is required');
  }
}

function providerKind(value: unknown, path: string): ProviderKind {
  return oneOf(value, ['codex', 'claude-code', 'fixture'], path);
}

function identifier(value: unknown, path: string) {
  const result = boundedString(value, path, 512);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/u.test(result)) {
    throw new ProviderContractError(path, 'contains unsupported identifier characters');
  }
  return result;
}

function sha256(value: unknown, path: string) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new ProviderContractError(path, 'must be a lowercase SHA-256 value');
  }
  return value;
}

function boundedString(value: unknown, path: string, limit = PROVIDER_RUNTIME_LIMITS.stringChars) {
  if (typeof value !== 'string') throw new ProviderContractError(path, 'must be a string');
  if (value.length === 0) throw new ProviderContractError(path, 'must not be empty');
  if ([...value].length > limit) throw new ProviderContractError(path, `exceeds ${limit} characters`);
  return value;
}

function providerEventEnvelopeByteLimit(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return PROVIDER_RUNTIME_LIMITS.eventBytes;
  }
  const event = (value as Record<string, unknown>).event;
  if (event && typeof event === 'object' && !Array.isArray(event)) {
    const record = event as Record<string, unknown>;
    if (record.type === 'turn.file-changed') {
      const change = record.change;
      if (change && typeof change === 'object' && !Array.isArray(change) &&
          typeof (change as Record<string, unknown>).diff === 'string') {
        return PROVIDER_RUNTIME_LIMITS.finalEventBytes;
      }
    }
    if (
      (record.type === 'turn.block.started' ||
        record.type === 'turn.block.revised' ||
        record.type === 'turn.block.completed') &&
      record.block && typeof record.block === 'object' && !Array.isArray(record.block)
    ) {
      const block = record.block as Record<string, unknown>;
      if (block.kind === 'final-message') return PROVIDER_RUNTIME_LIMITS.finalEventBytes;
    }
  }
  return PROVIDER_RUNTIME_LIMITS.eventBytes;
}

function bool(value: unknown, path: string) {
  if (typeof value !== 'boolean') throw new ProviderContractError(path, 'must be a boolean');
  return value;
}

function nonnegativeInteger(value: unknown, path: string) {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ProviderContractError(path, 'must be a nonnegative safe integer');
  }
  return value as number;
}

function nullableNonnegativeInteger(value: unknown, path: string) {
  return value === null ? null : nonnegativeInteger(value, path);
}

function positiveInteger(value: unknown, path: string) {
  const parsed = nonnegativeInteger(value, path);
  if (parsed === 0) throw new ProviderContractError(path, 'must be positive');
  return parsed;
}

function nonnegativeFinite(value: unknown, path: string) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new ProviderContractError(path, 'must be a finite nonnegative number');
  }
  return value;
}

function percentage(value: unknown, path: string) {
  const parsed = nonnegativeFinite(value, path);
  if (parsed > 100) throw new ProviderContractError(path, 'must be at most 100');
  return parsed;
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new ProviderContractError(path, 'must be an array');
  return value;
}

function exactLiteral<T extends string | number | boolean>(value: unknown, literal: T, path: string): T {
  if (value !== literal) throw new ProviderContractError(path, `must equal ${JSON.stringify(literal)}`);
  return literal;
}

function providerRuntimeContractVersion(value: unknown, path: string) {
  if (value !== PROVIDER_RUNTIME_CONTRACT_VERSION &&
      !(LEGACY_PROVIDER_RUNTIME_CONTRACT_VERSIONS as readonly unknown[]).includes(value)) {
    throw new ProviderContractError(
      path,
      `must equal ${PROVIDER_RUNTIME_CONTRACT_VERSION} or a supported legacy version ` +
        `(${LEGACY_PROVIDER_RUNTIME_CONTRACT_VERSIONS.join(', ')})`,
    );
  }
}

function oneOf<const T extends readonly string[]>(value: unknown, values: T, path: string): T[number] {
  if (typeof value !== 'string' || !values.includes(value)) {
    throw new ProviderContractError(path, `must be one of ${values.join(', ')}`);
  }
  return value as T[number];
}

function assertEncodedSize(value: unknown, limit: number, path: string) {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new ProviderContractError(path, 'must be JSON serializable');
  }
  if (encoded === undefined) throw new ProviderContractError(path, 'must be JSON serializable');
  const bytes = new TextEncoder().encode(encoded).byteLength;
  if (bytes > limit) throw new ProviderContractError(path, `encoded value exceeds ${limit} bytes`);
}
