import { createHash, randomUUID } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

import {
  query as claudeQuery,
  type AccountInfo as ClaudeAccountInfo,
  type HookCallback,
  type ModelInfo as ClaudeModelInfo,
  type Options as ClaudeQueryOptions,
  type Query as ClaudeQuery,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';

import {
  PROVIDER_RUNTIME_CONTRACT_VERSION,
  PROVIDER_RUNTIME_LIMITS,
  ProviderContractError,
  parseCompactProviderSessionInput,
  parseInterruptProviderChildInput,
  parseInterruptProviderTurnInput,
  parseNativeForkRequest,
  parseOpenProviderSessionInput,
  parseProviderEventEnvelope,
  parseProviderLogoutInput,
  parseProviderSnapshot,
  parseProviderSnapshotRequest,
  parseStartProviderTurnInput,
  type InterruptProviderTurnInput,
  type InterruptProviderChildInput,
  type ChildExecutionDisplay,
  type CompactProviderSessionInput,
  type JsonValue,
  type NativeForkRequest,
  type NativeSessionRef,
  type OpenProviderSessionInput,
  type ProviderAccess,
  type ProviderAccountUsage,
  type ProviderCapabilities,
  type ProviderEvent,
  type ProviderEventEnvelope,
  type ProviderModelDescriptor,
  type ProviderProbe,
  type ProviderSnapshot,
  type ProviderSnapshotRequest,
  type StartProviderTurnInput,
  type TurnBlockKind,
  type TurnBlockPayload,
  type TurnBlockSnapshot,
  type TurnStructure,
  type UserContentPart,
  type UsageDisplay,
} from '../../../../shared/provider-runtime.ts';
import type {
  ProviderAdapter,
  ProviderCommandAcceptance,
  ProviderRuntimeStatus,
  ProviderSession,
} from '../../provider-adapter.ts';
import { ProviderEventStream } from '../../provider-adapter.ts';
import type { DispatchBoundary, ProviderDispatchResult } from '../../native-runtime/delivery-contract.ts';
import {
  NativeSessionOwnershipRegistry,
  type NativeSessionLease,
} from '../../native-runtime/native-session-ownership.ts';
import {
  FEDERATION_SERVER_NAME,
  FEDERATION_TOOLS,
  FEDERATION_TOOL_TIMEOUT_MS,
} from '../../federation/constants.ts';
import { fitJsonPreview as jsonPreview } from '../preview.ts';
import { fitDisplayText, fitProviderEventDisplay } from '../display-fitting.ts';
import { ClaudeContextUsage, claudeCompactWindow, DEFAULT_CLAUDE_COMPACT_WINDOW } from './claude-context-usage.ts';

const execFile = promisify(execFileCallback);
const ADAPTER_VERSION = 'remux-claude-agent-sdk-v1';
const CLAUDE_AGENT_SDK_VERSION = '0.3.258';
const DEFAULT_INSTANCE_ID = 'claude-local';
const DEFAULT_BINARY = 'claude';
const FEDERATION_ALLOWED_TOOLS = FEDERATION_TOOLS
  .map((tool) => `mcp__${FEDERATION_SERVER_NAME}__${tool}`);
const PROBE_TIMEOUT_MS = 15_000;
const COMPACTION_STATUS_REPLAY_LIMIT = 1_024;
const COMPACTION_FAILURE_FALLBACK = 'Claude Code reported that context compaction failed.';

const CLAUDE_API_KEY_SOURCES = new Set([
  'ANTHROPIC_API_KEY',
  'apiKeyHelper',
  '/login managed key',
]);
const CLAUDE_AUTH_SOURCE_LABELS = new Set([
  ...CLAUDE_API_KEY_SOURCES,
  'none',
  'oauth',
  'user',
  'project',
  'org',
  'temporary',
]);
const CLAUDE_API_PROVIDER_LABELS = new Set([
  'firstParty',
  'bedrock',
  'vertex',
  'foundry',
  'anthropicAws',
  'anthropicGoogleCloud',
  'mantle',
  'gateway',
]);

type ClaudeQueryFactory = (input: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: ClaudeQueryOptions;
}) => ClaudeQuery;

type ClaudeAuthStatus = {
  loggedIn?: boolean;
  authMethod?: string;
  apiProvider?: string;
  subscriptionType?: string;
};

type ClaudeSubscriptionAuth = {
  apiProvider: 'firstParty';
};

class ClaudeProviderAuthError extends Error {
  readonly code = 'provider_auth';

  constructor(message: string) {
    super(message);
    this.name = 'ClaudeProviderAuthError';
  }
}

type ClaudeBranchCursor = {
  version: 1;
  promptUuid: string;
  previousChainEntryUuid: string | null;
  lastChainEntryUuid: string;
};

type MapperEvent = ProviderEvent | ({ type: string } & Record<string, unknown>);

type ClaudeBlockState = {
  structure: TurnStructure;
  block: TurnBlockSnapshot;
  revision: number;
};

type ClaudeAssistantBlockKind = 'reasoning-summary' | 'final-message';

type ClaudeAssistantBlockRef = {
  kind: ClaudeAssistantBlockKind;
  itemId: string;
  blockIndex: number;
};

type ClaudeToolState = {
  name: string;
  input?: unknown;
  inputHash?: string;
  partialInputJson?: string;
  childExecutionId?: string;
  fileChanges?: readonly ClaudeFileChange[];
};

export type ClaudeNativeAdapterOptions = {
  binaryPath?: string;
  providerInstanceId?: string;
  environment?: Readonly<Record<string, string | undefined>>;
  createQuery?: ClaudeQueryFactory;
  runCli?: (args: readonly string[]) => Promise<string>;
  resolveImageArtifact?: (
    scope: { conversationId: string; executionId: string },
    artifactId: string,
    mimeType: string,
  ) => Promise<{ path: string }>;
  now?: () => number;
  acceptanceTimeoutMs?: number;
  ownership?: NativeSessionOwnershipRegistry;
};

/**
 * Native Claude Code adapter. The official Agent SDK operates the installed
 * Claude Code harness; Remux translates its stream but never reconstructs its
 * prompt, tool loop, settings, skills, or native Task agents.
 */
export class ClaudeNativeAdapter implements ProviderAdapter {
  private readonly binaryPath: string;
  private readonly providerInstanceId: string;
  private readonly environment?: Readonly<Record<string, string | undefined>>;
  private readonly createQuery: ClaudeQueryFactory;
  private readonly runCli: (args: readonly string[]) => Promise<string>;
  private readonly resolveImageArtifact?: ClaudeNativeAdapterOptions['resolveImageArtifact'];
  private readonly now: () => number;
  private readonly ownership: NativeSessionOwnershipRegistry;
  private readonly acceptanceTimeoutMs: number;
  private providerVersion = 'unknown';

  constructor(options: ClaudeNativeAdapterOptions = {}) {
    this.binaryPath = options.binaryPath ?? DEFAULT_BINARY;
    this.providerInstanceId = options.providerInstanceId ?? DEFAULT_INSTANCE_ID;
    this.environment = options.environment;
    this.createQuery = options.createQuery ?? claudeQuery;
    this.resolveImageArtifact = options.resolveImageArtifact;
    this.now = options.now ?? Date.now;
    this.acceptanceTimeoutMs = options.acceptanceTimeoutMs ?? 30_000;
    this.ownership = options.ownership ?? new NativeSessionOwnershipRegistry(this.now);
    this.runCli = options.runCli ?? (async (args) => {
      try {
        const result = await execFile(this.binaryPath, [...args], {
          env: subscriptionEnvironment(this.environment),
          maxBuffer: 1024 * 1024,
          timeout: PROBE_TIMEOUT_MS,
        });
        return result.stdout;
      } catch (error) {
        const stdout = objectValue(error)?.stdout;
        if (typeof stdout === 'string' && stdout.trim()) return stdout;
        throw error;
      }
    });
  }

  async probe(providerInstanceId: string): Promise<ProviderProbe> {
    if (providerInstanceId !== this.providerInstanceId) {
      return {
        state: 'missing',
        displayLabel: 'Claude',
        diagnosticCode: 'claude_instance_missing',
        message: `Claude provider instance ${JSON.stringify(providerInstanceId)} is not configured.`,
      };
    }
    try {
      this.providerVersion = parseVersion(await this.runCli(['--version'])) ?? 'unknown';
      const status = JSON.parse(await this.runCli(['auth', 'status', '--json'])) as ClaudeAuthStatus;
      if (status.loggedIn !== true) {
        return {
          state: 'signed-out',
          displayLabel: 'Claude',
          diagnosticCode: 'claude_signed_out',
          message: 'This Remux host\'s Claude CLI reports that its native subscription session is signed out. Run `claude auth login --claudeai` on the host, then reload this view.',
          capabilities: claudeCapabilities(this.providerVersion, false),
        };
      }
      if (isApiKeyAuth(status)) {
        return {
          state: 'incompatible',
          displayLabel: 'Claude',
          diagnosticCode: 'claude_subscription_required',
          message: 'Claude is authenticated with an API key. Remux Agent requires the native Claude subscription session.',
          capabilities: claudeCapabilities(this.providerVersion, false),
        };
      }
      if (!isNativeSubscriptionAuth(status)) {
        return {
          state: 'incompatible',
          displayLabel: 'Claude',
          diagnosticCode: 'claude_subscription_required',
          message: 'Claude authentication could not be verified as a native Claude subscription session.',
          capabilities: claudeCapabilities(this.providerVersion, false),
        };
      }
      const manualCompact = await this.supportsNativeCompact().catch(() => false);
      return {
        state: 'ready',
        displayLabel: 'Claude',
        capabilities: claudeCapabilities(this.providerVersion, manualCompact),
      };
    } catch (error) {
      const message = safeMessage(error);
      if (isMissingExecutable(error)) {
        return {
          state: 'missing',
          displayLabel: 'Claude',
          diagnosticCode: 'claude_missing',
          message: 'The installed Claude Code executable was not found.',
        };
      }
      return {
        state: 'error',
        displayLabel: 'Claude',
        diagnosticCode: 'claude_probe_failed',
        message,
      };
    }
  }

  async readRuntimeStatus(providerInstanceId: string): Promise<ProviderRuntimeStatus> {
    this.assertInstance(providerInstanceId);
    const activeSessions = this.ownership.snapshot().filter((entry) =>
      entry.provider === 'claude-code' && entry.providerInstanceId === providerInstanceId).length;
    const version = this.providerVersion === 'unknown' ? null : this.providerVersion;
    return {
      topology: 'session-process',
      runtimeState: activeSessions > 0 ? 'running' : 'idle',
      configuredExecutable: this.binaryPath,
      resolvedExecutable: null,
      installedVersion: version,
      runningVersion: activeSessions > 0 ? version : null,
      adapterVersion: ADAPTER_VERSION,
      sdkVersion: CLAUDE_AGENT_SDK_VERSION,
      restartRequired: false,
      activeSessions,
      lastError: null,
    };
  }

  async listModels(providerInstanceId: string): Promise<readonly ProviderModelDescriptor[]> {
    this.assertInstance(providerInstanceId);
    const input = new ClaudeInputQueue();
    const query = this.createQuery({
      prompt: input,
      options: probeQueryOptions(this.binaryPath, this.environment),
    });
    try {
      const models = await query.supportedModels();
      return models.map(mapClaudeModel);
    } finally {
      input.close();
      query.close();
    }
  }

  async readAccountUsage(providerInstanceId: string): Promise<ProviderAccountUsage | null> {
    this.assertInstance(providerInstanceId);
    const input = new ClaudeInputQueue();
    const query = this.createQuery({
      prompt: input,
      options: probeQueryOptions(this.binaryPath, this.environment),
    });
    try {
      const usage = await query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET();
      return normalizeClaudeAccountUsage(usage, this.now());
    } finally {
      input.close();
      query.close();
    }
  }

  async logout(unparsed: { commandId: string; providerInstanceId: string }) {
    const input = parseProviderLogoutInput(unparsed);
    this.assertInstance(input.providerInstanceId);
    await this.runCli(['auth', 'logout']);
    return { accepted: true as const };
  }

  async openSession(unparsed: OpenProviderSessionInput): Promise<ClaudeProviderSession> {
    const input = parseOpenProviderSessionInput(unparsed);
    this.assertInstance(input.providerInstanceId);
    if (input.nativeSession && input.nativeSession.provider !== 'claude-code') {
      throw new Error(`Claude adapter cannot open ${input.nativeSession.provider} sessions.`);
    }
    const sessionId = input.nativeSession?.sessionId ?? randomUUID();
    const lease = this.ownership.acquire({
      provider: 'claude-code',
      providerInstanceId: input.providerInstanceId,
      sessionId,
      executionId: input.executionId,
    });
    const prompt = new ClaudeInputQueue();
    const diagnostics: string[] = [];
    let session: ClaudeProviderSession | undefined;
    const options = sessionQueryOptions({
      input,
      sessionId,
      binaryPath: this.binaryPath,
      environment: this.environment,
      onFileChanged: (change) => session?.recordFileChange(change),
      onStderr: (chunk) => recordClaudeDiagnostic(diagnostics, chunk),
    });
    let query: ClaudeQuery | undefined;
    try {
      query = this.createQuery({ prompt, options });
      const auth = requireClaudeSubscription(await query.accountInfo());
      session = new ClaudeProviderSession({
        input,
        sessionId,
        prompt,
        query,
        auth,
        resolveImageArtifact: this.resolveImageArtifact,
        diagnostics,
        now: this.now,
        acceptanceTimeoutMs: this.acceptanceTimeoutMs,
        lease,
        compactWindow: claudeCompactWindow(options.env ?? {}),
        forkNative: (request) => this.materializeFork(input, sessionId, request),
      });
      session.start(input.mode !== 'create');
      return session;
    } catch (error) {
      prompt.close();
      query?.close();
      lease.release();
      throw error;
    }
  }

  private async materializeFork(
    sourceInput: OpenProviderSessionInput,
    sourceSessionId: string,
    request: NativeForkRequest,
  ): Promise<NativeSessionRef> {
    const cursor = claudeBranchCursor(request.branchCursor);
    if (!cursor) throw new Error('Claude native fork requires an authoritative chain cursor.');
    const destinationSessionId = request.destinationSessionId ?? randomUUID();
    const before = Boolean(request.beforeNativeTurnId);
    const resumeSessionAt = before
      ? cursor.previousChainEntryUuid
      : cursor.lastChainEntryUuid;
    const prompt = new ClaudeInputQueue();
    const diagnostics: string[] = [];
    const forkInput: OpenProviderSessionInput = {
      ...sourceInput,
      commandId: request.commandId,
      mode: 'resume',
      nativeSession: {
        provider: 'claude-code',
        providerInstanceId: sourceInput.providerInstanceId,
        sessionId: sourceSessionId,
      },
    };
    const base = sessionQueryOptions({
      input: forkInput,
      sessionId: sourceSessionId,
      binaryPath: this.binaryPath,
      environment: this.environment,
      onFileChanged: () => undefined,
      onStderr: (chunk) => recordClaudeDiagnostic(diagnostics, chunk),
    });
    const query = this.createQuery({
      prompt,
      options: resumeSessionAt
        ? {
            ...base,
            resume: sourceSessionId,
            forkSession: true,
            sessionId: destinationSessionId,
            resumeSessionAt,
            ...(before ? { resumeDropsTurn: cursor.promptUuid } : {}),
          }
        : {
            ...base,
            resume: undefined,
            forkSession: undefined,
            resumeSessionAt: undefined,
            resumeDropsTurn: undefined,
            sessionId: destinationSessionId,
          },
    });
    try {
      const auth = requireClaudeSubscription(await query.accountInfo());
      let materialized = false;
      for await (const message of query) {
        const record = message as unknown as Record<string, unknown>;
        if (record.type === 'system' && record.subtype === 'init') {
          requireClaudeInitSubscription(record.apiKeySource, auth);
          materialized = true;
          break;
        }
        if (record.type === 'result' && record.subtype !== 'success') {
          const errors = Array.isArray(record.errors)
            ? record.errors.filter((entry): entry is string => typeof entry === 'string')
            : [];
          throw new Error(errors.join('\n') || 'Claude rejected the native fork.');
        }
      }
      if (!materialized) {
        throw new Error(diagnostics.at(-1) ?? 'Claude ended before the forked session materialized.');
      }
    } finally {
      prompt.close();
      query.close();
    }
    return {
      provider: 'claude-code',
      providerInstanceId: sourceInput.providerInstanceId,
      sessionId: destinationSessionId,
      resumeCursor: { sessionId: destinationSessionId },
    };
  }

  private assertInstance(providerInstanceId: string) {
    if (providerInstanceId !== this.providerInstanceId) {
      throw new Error(`Unknown Claude provider instance ${JSON.stringify(providerInstanceId)}.`);
    }
  }

  private async supportsNativeCompact() {
    const input = new ClaudeInputQueue();
    const query = this.createQuery({
      prompt: input,
      options: probeQueryOptions(this.binaryPath, this.environment),
    });
    try {
      const commands = await query.supportedCommands();
      return commands.some(({ name, aliases }) => name === 'compact' || aliases?.includes('compact'));
    } finally {
      input.close();
      query.close();
    }
  }
}

type ClaudeProviderSessionOptions = {
  compactWindow?: number;
  input: OpenProviderSessionInput;
  sessionId: string;
  prompt: ClaudeInputQueue;
  query: ClaudeQuery;
  auth: ClaudeSubscriptionAuth;
  resolveImageArtifact?: ClaudeNativeAdapterOptions['resolveImageArtifact'];
  diagnostics: string[];
  now: () => number;
  acceptanceTimeoutMs: number;
  forkNative?: (request: NativeForkRequest) => Promise<NativeSessionRef>;
  lease: NativeSessionLease;
};

export class ClaudeProviderSession implements ProviderSession {
  readonly events = new ProviderEventStream();
  readonly nativeSession: NativeSessionRef;

  private readonly openedWith: OpenProviderSessionInput;
  private readonly prompt: ClaudeInputQueue;
  private readonly query: ClaudeQuery;
  private readonly auth: ClaudeSubscriptionAuth;
  private readonly contextUsage: ClaudeContextUsage;
  private latestUsage: UsageDisplay = { turn: null, cumulative: null, context: null, estimatedCost: null };
  private readonly resolveImageArtifact?: ClaudeNativeAdapterOptions['resolveImageArtifact'];
  private readonly diagnostics: string[];
  private readonly now: () => number;
  private readonly forkNative: (request: NativeForkRequest) => Promise<NativeSessionRef>;
  private readonly lease: NativeSessionLease;
  private readonly receipts = new Map<
    string,
    { hash: string; result: Promise<ProviderCommandAcceptance | ProviderDispatchResult> }
  >();
  private readonly eventLog: ProviderEventEnvelope[] = [];
  private readonly tools = new Map<string, ClaudeToolState>();
  private readonly toolByMessageBlock = new Map<string, string>();
  private readonly assistantBlocksByMessage = new Map<string, ClaudeAssistantBlockRef[]>();
  private readonly childByTask = new Map<string, string>();
  private readonly backgroundToolByTask = new Map<string, string>();
  private readonly blocks = new Map<string, ClaudeBlockState>();
  private readonly toolBlockKey = new Map<string, string>();
  private readonly childBlockKey = new Map<string, string>();
  private readonly passOrdinals = new Map<string, number>();
  private readonly accountWindows = new Map<string, {
    id: string;
    label: string;
    kind: 'rolling' | 'weekly' | 'model' | 'extra';
    model: string | null;
    usedPercent: number;
    resetsAt: number | null;
  }>();
  private fileChangeSequence = 0;
  private sequence = 0;
  private currentEnvelopeUuid: string | undefined;
  private currentMessageId: string | undefined;
  private lastAssistantMessageId: string | undefined;
  private state: ProviderSnapshot['state'] = 'idle';
  private activeTurn: {
    turnId: string;
    nativeTurnId: string;
    assistantText: string;
    promptUuid?: string;
    previousChainEntryUuid?: string;
    lastChainEntryUuid?: string;
  } | undefined;
  private lastChainEntryUuid: string | undefined;
  private interruptRequested = false;
  private consumeTask: Promise<void> | undefined;
  private manualCompactionOperationId: string | undefined;
  private readonly settledCompactionStatuses = new Set<string>();
  private recoveringAcceptedTurn = false;
  private readonly processGeneration = randomUUID();
  private rootAcceptance?: { promptUuid: string; resolve: (result: ProviderDispatchResult) => void;
    timeout: ReturnType<typeof setTimeout> };
  private readonly processingEvidence = new Map<string, import('../../native-runtime/delivery-contract.ts').ProviderAcceptanceEvidence>();
  private readonly acceptanceTimeoutMs: number;
  private closed = false;

  constructor(options: ClaudeProviderSessionOptions) {
    this.openedWith = options.input;
    this.prompt = options.prompt;
    this.query = options.query;
    this.auth = options.auth;
    this.contextUsage = new ClaudeContextUsage(options.compactWindow);
    this.resolveImageArtifact = options.resolveImageArtifact;
    this.diagnostics = options.diagnostics;
    this.now = options.now;
    this.acceptanceTimeoutMs = options.acceptanceTimeoutMs;
    this.forkNative = options.forkNative ?? (async () => {
      throw new Error('Claude native fork is unavailable for this session.');
    });
    this.lease = options.lease;
    this.nativeSession = {
      provider: 'claude-code',
      providerInstanceId: options.input.providerInstanceId,
      sessionId: options.sessionId,
      resumeCursor: { sessionId: options.sessionId },
    };
    if (options.input.activeTurnBinding) {
      this.activeTurn = {
        ...options.input.activeTurnBinding,
        assistantText: '',
      };
      this.recoveringAcceptedTurn = true;
      this.state = 'running';
    }
    const lastCursor = options.input.nativeTurnBindings
      ?.map(({ branchCursor }) => claudeBranchCursor(branchCursor))
      .filter((cursor): cursor is ClaudeBranchCursor => Boolean(cursor))
      .at(-1);
    this.lastChainEntryUuid = lastCursor?.lastChainEntryUuid;
  }

  start(resumed: boolean) {
    this.emit({ type: 'session.bound', resumed }, 'session/bound');
    if (this.recoveringAcceptedTurn) {
      this.emit({
        type: 'session.health',
        state: 'recovering',
        message: 'Reattaching to the Claude Code session after its event stream ended.',
      }, 'session/recovering');
      // A resumed Claude Code process restores the durable conversation, not
      // the model invocation owned by the process that disappeared. Waiting
      // for a result here leaves the accepted Remux turn permanently active:
      // the resumed CLI is idle until it receives a new user message. Do not
      // replay the prompt or synthesize a continuation. Close only the lost
      // turn and leave the resumed native session ready for a real follow-up.
      this.failRecoveredTurn(
        'Claude Code resumed the native session, but its previous process ended before this turn produced a terminal result. Claude cannot restore an in-flight model invocation without rerunning the prompt; send a follow-up to continue.',
      );
    }
    this.consumeTask = this.consume();
  }

  async startTurn(unparsed: StartProviderTurnInput, boundary?: DispatchBoundary): Promise<ProviderDispatchResult> {
    this.assertOpen();
    const input = parseStartProviderTurnInput(unparsed);
    if (input.conversationId !== this.openedWith.conversationId ||
        input.executionId !== this.openedWith.executionId) {
      throw new Error('Claude turn does not match the opened provider session.');
    }
    return this.onceCommand(input.commandId, input, async () => {
      if (this.activeTurn) throw new Error('Claude provider session already has an active turn.');
      const content = await mapClaudeUserContent(input.content, this.resolveImageArtifact
        ? (artifactId, mimeType) => this.resolveImageArtifact!({
            conversationId: this.openedWith.conversationId,
            executionId: this.openedWith.executionId,
          }, artifactId, mimeType)
        : undefined);
      await this.prepareTurnConfiguration(input);
      this.assertOpen();
      if (this.activeTurn) throw new Error('Claude provider session already has an active turn.');

      const nativeTurnId = stableUuid(`claude-turn\0${this.nativeSession.sessionId}\0${input.commandId}`);
      const promptUuid = stableUuid(`claude-user\0${input.commandId}`);
      this.activeTurn = {
        turnId: input.turnId,
        nativeTurnId,
        assistantText: '',
        promptUuid,
        ...(this.lastChainEntryUuid
          ? { previousChainEntryUuid: this.lastChainEntryUuid }
          : {}),
        lastChainEntryUuid: promptUuid,
      };
      this.currentMessageId = undefined;
      this.lastAssistantMessageId = undefined;
      this.contextUsage.startTurn();
      this.latestUsage = { ...this.latestUsage, turn: null, context: null };
      this.interruptRequested = false;
      this.state = 'running';
      let acceptance: Promise<ProviderDispatchResult>;
      try {
        acceptance = new Promise<ProviderDispatchResult>((resolve) => {
          const timeout = setTimeout(() => resolve({ accepted: false, outcome: 'unknown',
            crossing: { phase: 'possibly-sent', detail: 'response-lost' },
            error: { code: 'claude_acceptance_timeout', message: 'Claude did not provide correlated processing evidence before the delivery timeout.', retryable: true } }), this.acceptanceTimeoutMs);
          timeout.unref?.();
          this.rootAcceptance = { promptUuid, resolve, timeout };
        });
        boundary?.markPossiblySent(this.nativeSession.sessionId, this.processGeneration);
        this.prompt.push({
          type: 'user',
          message: { role: 'user', content },
          parent_tool_use_id: null,
          uuid: promptUuid as `${string}-${string}-${string}-${string}-${string}`,
        });
      } catch (error) {
        if (this.rootAcceptance) clearTimeout(this.rootAcceptance.timeout);
        this.rootAcceptance = undefined;
        this.activeTurn = undefined;
        this.state = 'idle';
        return boundary
          ? { accepted: false, outcome: 'unknown', crossing: { phase: 'possibly-sent', detail: 'stdin-yielded' }, error: { code: 'claude_prompt_failed', message: error instanceof Error ? error.message : String(error) } }
          : { accepted: false, outcome: 'rejected', crossing: { phase: 'not-sent', detail: 'preparation' }, error: { code: 'claude_prompt_failed', message: error instanceof Error ? error.message : String(error) } };
      }
      this.emit({ type: 'user.message', content: input.content }, 'user/message', input.turnId, nativeTurnId);
      this.emit({ type: 'turn.started' }, 'turn/started', input.turnId, nativeTurnId);
      this.emit({ type: 'turn.status', state: 'running' }, 'turn/status', input.turnId, nativeTurnId);
      return acceptance;
    }) as Promise<ProviderDispatchResult>;
  }

  async interrupt(unparsed: InterruptProviderTurnInput): Promise<ProviderCommandAcceptance> {
    this.assertOpen();
    const input = parseInterruptProviderTurnInput(unparsed);
    return this.onceCommand(input.commandId, input, async () => {
      if (this.activeTurn?.turnId !== input.turnId) throw new Error('Claude turn is not active.');
      this.interruptRequested = true;
      await this.query.interrupt();
      return { accepted: true };
    });
  }

  async readTurnPresence(nativeClientMessageId: string) {
    const evidence = this.processingEvidence.get(nativeClientMessageId);
    return evidence
      ? { presence: 'present' as const, evidence }
      : { presence: 'unknown' as const, reason: 'Claude history does not prove root processing.' };
  }

  async interruptChild(unparsed: InterruptProviderChildInput): Promise<ProviderCommandAcceptance> {
    this.assertOpen();
    const input = parseInterruptProviderChildInput(unparsed);
    const expectedExecutionId = stableUuid(
      `claude-child\0${this.nativeSession.sessionId}\0${input.nativeSessionId}`,
    );
    if (input.childExecutionId !== expectedExecutionId ||
        this.childByTask.get(input.nativeSessionId) !== input.childExecutionId) {
      throw new Error('Claude child interruption does not match an active task in this session.');
    }
    return this.onceCommand(input.commandId, input, async () => {
      await this.query.stopTask(input.nativeSessionId);
      return { accepted: true };
    });
  }

  async compact(unparsed: CompactProviderSessionInput): Promise<ProviderCommandAcceptance & {
    nativeOperationId?: string;
  }> {
    this.assertOpen();
    const input = parseCompactProviderSessionInput(unparsed);
    if (input.conversationId !== this.openedWith.conversationId ||
        input.executionId !== this.openedWith.executionId) {
      throw new Error('Claude compact request does not match the opened provider session.');
    }
    return this.onceCommand(input.commandId, input, async () => {
      if (this.activeTurn) throw new Error('Claude provider session is busy.');
      const commands = await this.query.supportedCommands();
      if (!commands.some(({ name, aliases }) => name === 'compact' || aliases?.includes('compact'))) {
        throw new Error('Claude Code did not advertise the native /compact command.');
      }
      this.manualCompactionOperationId = input.commandId;
      this.prompt.push({
        type: 'user',
        message: { role: 'user', content: '/compact' },
        parent_tool_use_id: null,
        uuid: stableUuid(`claude-compact\0${input.commandId}`) as `${string}-${string}-${string}-${string}-${string}`,
      });
      return { accepted: true, nativeOperationId: input.commandId };
    });
  }

  async snapshot(unparsed: ProviderSnapshotRequest): Promise<ProviderSnapshot> {
    const input = parseProviderSnapshotRequest(unparsed);
    return parseProviderSnapshot({
      contractVersion: PROVIDER_RUNTIME_CONTRACT_VERSION,
      nativeSession: structuredClone(this.nativeSession),
      state: this.state,
      authority: 'session-local',
      events: structuredClone(input.afterNativeSequence === undefined
        ? this.eventLog
        : this.eventLog.filter(({ native }) =>
            native.position?.kind === 'native-sequence'
              && native.position.sequence > input.afterNativeSequence!)),
      nextNativeSequence: this.sequence + 1,
    });
  }

  async fork(unparsed: NativeForkRequest): Promise<NativeSessionRef> {
    const input = parseNativeForkRequest(unparsed);
    return this.forkNative(input);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    if (this.rootAcceptance) {
      clearTimeout(this.rootAcceptance.timeout);
      this.rootAcceptance.resolve({ accepted: false, outcome: 'unknown',
        crossing: { phase: 'possibly-sent', detail: 'response-lost' },
        error: { code: 'claude_session_closed', message: 'Claude session closed before correlated processing evidence.', retryable: true } });
      this.rootAcceptance = undefined;
    }
    try {
      this.prompt.close();
      this.query.close();
      await this.consumeTask?.catch(() => undefined);
      this.events.close();
    } finally {
      this.lease.release();
    }
  }

  recordFileChange(change: ClaudeFileChange) {
    const active = this.activeTurn;
    if (!active) return;
    this.emit(
      { type: 'file.changed', change },
      'hook/file_changed',
      active.turnId,
      active.nativeTurnId,
      `file-change-${++this.fileChangeSequence}`,
    );
  }

  private async consume() {
    try {
      for await (const message of this.query) {
        try {
          await this.handleMessage(message);
        } catch (error) {
          if (!(error instanceof ProviderContractError)) throw error;
          this.reportProjectionError(
            stringValue(message.type) ?? 'unknown',
            error,
          );
        }
      }
      if (!this.closed) {
        this.resolvePendingAcceptance('claude_stream_ended',
          'Claude event stream ended before correlated processing evidence.');
        this.state = 'lost';
        const diagnostic = this.diagnostics.at(-1);
        this.emit({
          type: 'session.health',
          state: 'lost',
          message: diagnostic
            ? `Claude Code event stream ended unexpectedly. Last diagnostic: ${diagnostic}`
            : 'Claude Code event stream ended unexpectedly.',
        }, 'session/lost');
        this.events.close();
      }
    } catch (error) {
      if (this.closed) return;
      this.resolvePendingAcceptance('claude_stream_failed',
        'Claude event stream failed before correlated processing evidence.');
      if (error instanceof ClaudeProviderAuthError) {
        // This runs inside consumeTask, so close only the native transport
        // here. Public close() remains the lease owner and may safely await
        // consumeTask after this catch returns.
        this.prompt.close();
        this.query.close();
      }
      this.state = 'lost';
      const diagnostic = this.diagnostics.at(-1);
      const message = diagnostic
        ? `${safeMessage(error)} Last Claude diagnostic: ${diagnostic}`
        : safeMessage(error);
      this.emit({ type: 'session.health', state: 'lost', message }, 'session/lost');
      this.events.fail(error);
    }
  }

  private reportProjectionError(nativeKind: string, error: unknown) {
    const message = safeMessage(error);
    recordClaudeDiagnostic(this.diagnostics, `Projection ignored ${nativeKind}: ${message}`);
    try {
      process.stderr.write(`[agent-runtime] ${JSON.stringify({
        stage: 'provider.event-projection',
        status: 'failed',
        provider: 'claude-code',
        providerInstanceId: this.nativeSession.providerInstanceId,
        nativeSessionId: this.nativeSession.sessionId,
        nativeKind,
        error: message,
      })}\n`);
    } catch {
      // Projection diagnostics can never affect the provider session.
    }
  }

  private async handleMessage(message: SDKMessage) {
    const record = message as unknown as Record<string, unknown>;
    const sessionId = stringValue(record.session_id);
    if (sessionId && sessionId !== this.nativeSession.sessionId) {
      throw new Error('Claude emitted a different native session ID than requested.');
    }
    this.currentEnvelopeUuid = stringValue(record.uuid);
    const correlatedUserUuid = stringValue(record.user_message_uuid);
    const streamType = stringValue(objectValue(record.event)?.type);
    const partialKinds = new Set(['message_start', 'message_delta', 'message_stop',
      'content_block_start', 'content_block_delta', 'content_block_stop']);
    const exactRootOutput =
      ((record.type === 'assistant' || record.type === 'stream_event') &&
        record.parent_tool_use_id === null) ||
      (record.type === 'result' && record.subtype === 'success');
    const exactOutputKind = record.type === 'assistant' ||
      (record.type === 'stream_event' && streamType !== undefined && partialKinds.has(streamType)) ||
      (record.type === 'result' && record.subtype === 'success');
    if (this.rootAcceptance && sessionId === this.nativeSession.sessionId &&
        correlatedUserUuid === this.rootAcceptance.promptUuid && this.currentEnvelopeUuid &&
        exactRootOutput && exactOutputKind) {
      const pending = this.rootAcceptance;
      this.rootAcceptance = undefined;
      clearTimeout(pending.timeout);
      const evidence = {
        kind: 'claude-root-processing', sessionId: this.nativeSession.sessionId,
        userMessageUuid: correlatedUserUuid, observationUuid: this.currentEnvelopeUuid,
      } as const;
      this.processingEvidence.set(correlatedUserUuid, evidence);
      while (this.processingEvidence.size > 32) {
        this.processingEvidence.delete(this.processingEvidence.keys().next().value!);
      }
      pending.resolve({ accepted: true, outcome: 'accepted', evidence, nativeTurnId: this.activeTurn?.nativeTurnId });
    }
    if (record.type === 'system') this.handleSystemMessage(record);
    else if (record.type === 'stream_event') await this.handleStreamEvent(record);
    else if (record.type === 'assistant') await this.handleAssistantMessage(record);
    else if (record.type === 'user') await this.handleUserMessage(record);
    else if (record.type === 'tool_progress') this.handleToolProgress(record);
    else if (record.type === 'result') this.handleResult(record);
    else if (record.type === 'rate_limit_event') this.handleRateLimitEvent(record);
    if (this.activeTurn && this.currentEnvelopeUuid && !record.parent_tool_use_id &&
        (record.type === 'system' || record.type === 'assistant' || record.type === 'user')) {
      this.activeTurn.lastChainEntryUuid = this.currentEnvelopeUuid;
      this.lastChainEntryUuid = this.currentEnvelopeUuid;
    }
  }

  private resolvePendingAcceptance(code: string, message: string) {
    if (!this.rootAcceptance) return;
    const pending = this.rootAcceptance;
    this.rootAcceptance = undefined;
    clearTimeout(pending.timeout);
    pending.resolve({ accepted: false, outcome: 'unknown',
      crossing: { phase: 'possibly-sent', detail: 'response-lost' },
      error: { code, message, retryable: true } });
  }

  private handleSystemMessage(message: Record<string, unknown>) {
    const subtype = stringValue(message.subtype);
    if (subtype === 'init') {
      requireClaudeInitSubscription(message.apiKeySource, this.auth);
      this.emit({ type: 'session.materialized' }, 'session/materialized');
      this.emit({
        type: 'session.health',
        state: this.recoveringAcceptedTurn ? 'recovering' : 'ready',
        ...(this.recoveringAcceptedTurn
          ? { message: 'Claude Code resumed the session; verifying the interrupted turn.' }
          : {}),
      }, 'system/init');
      return;
    }
    if (subtype === 'status' && message.compact_result === 'failed') {
      if (message.parent_tool_use_id) return;
      // SDK status UUIDs are the only replay identity. A malformed UUID-less
      // status is a distinct observation because its content cannot prove replay.
      const statusIdentity = this.currentEnvelopeUuid ?? `missing-uuid-observation:${this.sequence + 1}`;
      if (this.settledCompactionStatuses.has(statusIdentity)) return;
      this.rememberSettledCompactionStatus(statusIdentity);
      const operationId = this.manualCompactionOperationId
        ?? `claude-auto-compact-${hashJson({
          sessionId: this.nativeSession.sessionId,
          statusIdentity,
        }).slice(0, 24)}`;
      this.emit({
        type: 'context.compaction.failed',
        trigger: this.manualCompactionOperationId ? 'manual' : 'automatic',
        operationId,
        error: {
          code: 'claude_compaction_failed',
          message: fitContractString(
            stringValue(message.compact_error) ?? COMPACTION_FAILURE_FALLBACK,
            PROVIDER_RUNTIME_LIMITS.stringChars,
          ),
          retryable: true,
        },
      }, 'system/status/compact-failed');
      this.manualCompactionOperationId = undefined;
      return;
    }
    if (subtype === 'compact_boundary') {
      if (message.parent_tool_use_id) return;
      this.contextUsage.compact();
      this.emitContextUsage('system/context-invalidated');
      const metadata = objectValue(message.compact_metadata);
      const trigger = metadata?.trigger === 'manual' ? 'manual' : 'automatic';
      const operationId = trigger === 'manual' && this.manualCompactionOperationId
        ? this.manualCompactionOperationId
        : `claude-compact-${hashJson({
            sessionId: this.nativeSession.sessionId,
            messageId: this.currentEnvelopeUuid,
          }).slice(0, 24)}`;
      this.emit({
        type: 'context.compaction.completed',
        trigger,
        operationId,
        beforeTokens: nonnegativeInteger(metadata?.pre_tokens) ?? null,
        afterTokens: nonnegativeInteger(metadata?.post_tokens) ?? null,
      }, 'system/compact_boundary');
      this.manualCompactionOperationId = undefined;
      return;
    }
    const active = this.activeTurn;
    if (!active) return;
    const taskId = stringValue(message.task_id);
    if (!taskId) return;
    const toolUseId = stringValue(message.tool_use_id)
      ?? this.backgroundToolByTask.get(taskId);
    const linkedTool = toolUseId ? this.tools.get(toolUseId) : undefined;
    if ((linkedTool && !isClaudeChildTool(linkedTool.name)) ||
        this.backgroundToolByTask.has(taskId)) {
      // Claude uses task lifecycle messages for both native subagents and
      // run_in_background tools. The Bash call already owns the visible
      // command row; projecting its task as a child creates a duplicate row
      // and falsely advertises a subagent. Keep only enough identity to
      // suppress the later progress/notification messages.
      if (toolUseId) this.backgroundToolByTask.set(taskId, toolUseId);
      return;
    }
    const childExecutionId = this.childByTask.get(taskId)
      ?? stableUuid(`claude-child\0${this.nativeSession.sessionId}\0${taskId}`);
    if (subtype === 'task_started') {
      this.childByTask.set(taskId, childExecutionId);
      if (toolUseId) {
        const tool = this.tools.get(toolUseId);
        if (tool) this.tools.set(toolUseId, { ...tool, childExecutionId });
      }
      this.emit({
        type: 'child.started',
        child: {
          executionId: childExecutionId,
          ownership: 'native',
          provider: 'claude-code',
          providerInstanceId: this.openedWith.providerInstanceId,
          model: this.openedWith.model,
          title: stringValue(message.description) ?? stringValue(message.subagent_type) ?? 'Claude subagent',
          nativeSessionId: taskId,
        },
      }, 'task/started', active.turnId, active.nativeTurnId, taskId);
      return;
    }
    if (subtype === 'task_progress') {
      this.emit({ type: 'child.status', childExecutionId, state: 'running' },
        'task/progress', active.turnId, active.nativeTurnId, taskId);
      const summary = stringValue(message.summary) ?? stringValue(message.description);
      if (summary) this.emit({ type: 'child.summary', childExecutionId, summary },
        'task/summary', active.turnId, active.nativeTurnId, taskId);
      return;
    }
    if (subtype === 'task_updated') {
      const patch = objectValue(message.patch);
      const status = stringValue(patch?.status);
      if (status && ['completed', 'failed', 'killed'].includes(status)) {
        this.emit({
          type: 'child.completed',
          childExecutionId,
          outcome: status === 'completed' ? 'completed' : status === 'killed' ? 'interrupted' : 'failed',
        }, 'task/completed', active.turnId, active.nativeTurnId, taskId);
      }
      return;
    }
    if (subtype === 'task_notification') {
      const summary = stringValue(message.summary);
      if (summary) this.emit({ type: 'child.summary', childExecutionId, summary },
        'task/summary', active.turnId, active.nativeTurnId, taskId);
      const status = stringValue(message.status);
      this.emit({
        type: 'child.completed',
        childExecutionId,
        outcome: status === 'completed' ? 'completed' : status === 'stopped' ? 'interrupted' : 'failed',
      }, 'task/notification', active.turnId, active.nativeTurnId, taskId);
    }
  }

  private rememberSettledCompactionStatus(identity: string) {
    this.settledCompactionStatuses.add(identity);
    if (this.settledCompactionStatuses.size <= COMPACTION_STATUS_REPLAY_LIMIT) return;
    const oldest = this.settledCompactionStatuses.values().next().value;
    if (oldest) this.settledCompactionStatuses.delete(oldest);
  }

  private async handleStreamEvent(message: Record<string, unknown>) {
    const active = this.activeTurn;
    if (!active || message.parent_tool_use_id) return;
    const event = objectValue(message.event);
    // A resumed Agent SDK process performs an internal handshake. It cannot
    // replay the model invocation that belonged to the process which died, so
    // none of that handshake may be projected as output of the accepted turn.
    if (this.recoveringAcceptedTurn) return;
    if (event?.type === 'message_start') {
      const body = objectValue(event.message);
      const nativeMessageId = stringValue(body?.id);
      if (nativeMessageId) {
        this.currentMessageId = nativeMessageId;
        this.lastAssistantMessageId = nativeMessageId;
        if (!this.assistantBlocksByMessage.has(nativeMessageId)) {
          this.assistantBlocksByMessage.set(nativeMessageId, []);
        }
        active.assistantText = '';
      }
      if (body && this.contextUsage.observe(body, this.now())) this.emitContextUsage('stream/context-usage');
      return;
    }
    if (event?.type === 'message_stop') {
      this.currentMessageId = undefined;
      return;
    }
    const blockIndex = numberValue(event?.index);
    if (event?.type === 'content_block_start') {
      const block = objectValue(event.content_block);
      if (block?.type === 'tool_use') {
        const callId = stringValue(block.id);
        const name = stringValue(block.name);
        if (!callId || !name) return;
        const fileChanges = await captureClaudeFileToolChanges(this.openedWith.cwd, name, block.input);
        this.tools.set(callId, {
          name,
          ...(block.input === undefined ? {} : {
            input: block.input,
            inputHash: hashJson(block.input),
          }),
          ...(fileChanges.length > 0 ? { fileChanges } : {}),
        });
        if (blockIndex !== undefined && this.currentMessageId) {
          this.toolByMessageBlock.set(this.messageBlockKey(this.currentMessageId, blockIndex), callId);
        }
        this.emit({
          type: 'tool.started',
          tool: { callId, name, category: toolCategory(name), title: toolTitle(name, block.input) },
          ...(block.input === undefined ? {} : { inputPreview: jsonPreview(block.input) }),
        }, 'stream/tool_start', active.turnId, active.nativeTurnId, callId, blockIndex);
      } else if (block?.type === 'thinking') {
        const blockRef = this.streamedAssistantBlock('reasoning-summary', blockIndex);
        const thinking = stringValue(block.thinking);
        if (thinking) this.emit({ type: 'assistant.reasoning', delta: thinking }, 'stream/thinking_start',
          active.turnId, active.nativeTurnId, blockRef?.itemId, blockRef?.blockIndex);
      } else if (block?.type === 'text') {
        const blockRef = this.streamedAssistantBlock('final-message', blockIndex);
        const text = stringValue(block.text);
        if (text) {
          active.assistantText += text;
          this.emit({ type: 'assistant.text', phase: 'final', delta: text }, 'stream/text_start',
            active.turnId, active.nativeTurnId, blockRef?.itemId, blockRef?.blockIndex);
        }
      }
      return;
    }
    if (event?.type === 'content_block_stop') {
      const messageId = this.currentMessageId ?? this.lastAssistantMessageId;
      const callId = messageId && blockIndex !== undefined
        ? this.toolByMessageBlock.get(this.messageBlockKey(messageId, blockIndex))
        : undefined;
      if (callId) await this.finalizeToolInput(callId, blockIndex);
      const blockRef = this.assistantBlockAt(messageId, blockIndex);
      this.completeBlock(
        active.turnId,
        active.nativeTurnId,
        blockRef?.itemId,
        blockRef?.blockIndex,
      );
      return;
    }
    if (event?.type !== 'content_block_delta') return;
    const delta = objectValue(event.delta);
    if (delta?.type === 'input_json_delta') {
      const messageId = this.currentMessageId ?? this.lastAssistantMessageId;
      const callId = messageId && blockIndex !== undefined
        ? this.toolByMessageBlock.get(this.messageBlockKey(messageId, blockIndex))
        : undefined;
      const partialJson = stringValue(delta.partial_json);
      if (callId && partialJson) {
        const tool = this.tools.get(callId);
        if (tool) {
          tool.partialInputJson = `${tool.partialInputJson ?? ''}${partialJson}`;
          this.tools.set(callId, tool);
          await this.finalizeToolInput(callId, blockIndex, false);
        }
      }
      return;
    }
    const text = stringValue(delta?.text) ?? stringValue(delta?.thinking);
    if (!text) return;
    if (delta?.type === 'thinking_delta' || 'thinking' in (delta ?? {})) {
      const blockRef = this.streamedAssistantBlock('reasoning-summary', blockIndex);
      this.emit({ type: 'assistant.reasoning', delta: text },
        'stream/thinking', active.turnId, active.nativeTurnId,
        blockRef?.itemId, blockRef?.blockIndex);
    } else {
      const blockRef = this.streamedAssistantBlock('final-message', blockIndex);
      active.assistantText += text;
      this.emit({ type: 'assistant.text', phase: 'final', delta: text },
        'stream/text', active.turnId, active.nativeTurnId,
        blockRef?.itemId, blockRef?.blockIndex);
    }
  }

  private async handleAssistantMessage(message: Record<string, unknown>) {
    const active = this.activeTurn;
    if (!active || this.recoveringAcceptedTurn) return;
    const body = objectValue(message.message);
    const content = Array.isArray(body?.content) ? body.content : [];
    const nativeMessageId = stringValue(body?.id);
    const previousMessageId = this.currentMessageId;
    if (nativeMessageId) {
      this.currentMessageId = nativeMessageId;
      this.lastAssistantMessageId = nativeMessageId;
    }
    if (!message.parent_tool_use_id && body && this.contextUsage.observe(body, this.now())) {
      this.emitContextUsage('assistant/context-usage');
    }
    const semanticOrdinals = new Map<ClaudeAssistantBlockKind, number>();
    const assistantTexts: string[] = [];
    for (const [blockIndex, blockValue] of content.entries()) {
      const block = objectValue(blockValue);
      if (!block) continue;
      if (block.type === 'thinking') {
        const blockRef = this.snapshotAssistantBlock(
          'reasoning-summary',
          semanticOrdinals.get('reasoning-summary') ?? 0,
          blockIndex,
        );
        semanticOrdinals.set('reasoning-summary', (semanticOrdinals.get('reasoning-summary') ?? 0) + 1);
        const thinking = stringValue(block.thinking);
        if (thinking) this.emit({ type: 'assistant.reasoning', summary: thinking },
          'assistant/thinking', active.turnId, active.nativeTurnId,
          blockRef.itemId, blockRef.blockIndex);
      } else if (block.type === 'text') {
        const blockRef = this.snapshotAssistantBlock(
          'final-message',
          semanticOrdinals.get('final-message') ?? 0,
          blockIndex,
        );
        semanticOrdinals.set('final-message', (semanticOrdinals.get('final-message') ?? 0) + 1);
        const text = stringValue(block.text);
        if (text) {
          assistantTexts.push(text);
          this.emit({ type: 'assistant.text', phase: 'final', text },
            'assistant/text', active.turnId, active.nativeTurnId,
            blockRef.itemId, blockRef.blockIndex);
        }
      } else if (block.type === 'tool_use') {
        const callId = stringValue(block.id);
        const name = stringValue(block.name);
        if (!callId || !name) continue;
        const fileChanges = await captureClaudeFileToolChanges(this.openedWith.cwd, name, block.input);
        const existing = this.tools.get(callId);
        if (existing) {
          const next = {
            ...existing,
            name,
            input: block.input,
            inputHash: hashJson(block.input),
            ...(fileChanges.length > 0 && !(existing.fileChanges?.length) ? { fileChanges } : {}),
          };
          this.tools.set(callId, next);
          this.emit({
            type: 'tool.updated',
            toolCallId: callId,
            tool: { callId, name, category: toolCategory(name), title: toolTitle(name, block.input) },
            ...(block.input === undefined ? {} : { inputPreview: jsonPreview(block.input) }),
          }, 'assistant/tool_use_snapshot', active.turnId, active.nativeTurnId, callId, blockIndex);
          continue;
        }
        this.tools.set(callId, {
          name,
          ...(block.input === undefined ? {} : {
            input: block.input,
            inputHash: hashJson(block.input),
          }),
          ...(fileChanges.length > 0 ? { fileChanges } : {}),
        });
        this.emit({
          type: 'tool.started',
          tool: { callId, name, category: toolCategory(name), title: toolTitle(name, block.input) },
          ...(block.input === undefined ? {} : { inputPreview: jsonPreview(block.input) }),
        }, 'assistant/tool_use', active.turnId, active.nativeTurnId, callId, blockIndex);
      }
    }
    if (assistantTexts.length > 0) active.assistantText = assistantTexts.join('');
    this.currentMessageId = previousMessageId;
  }

  private streamedAssistantBlock(
    kind: ClaudeAssistantBlockKind,
    blockIndex: number | undefined,
  ): ClaudeAssistantBlockRef | undefined {
    if (blockIndex === undefined) return undefined;
    const messageId = this.currentMessageId ?? this.lastAssistantMessageId;
    if (!messageId) return { kind, itemId: `content-${blockIndex}`, blockIndex };
    const blocks = this.assistantBlocksByMessage.get(messageId) ?? [];
    const existing = blocks.find((block) => block.blockIndex === blockIndex);
    if (existing) return existing;
    const block = { kind, itemId: `content-${blockIndex}`, blockIndex };
    blocks.push(block);
    blocks.sort((left, right) => left.blockIndex - right.blockIndex);
    this.assistantBlocksByMessage.set(messageId, blocks);
    return block;
  }

  private snapshotAssistantBlock(
    kind: ClaudeAssistantBlockKind,
    semanticOrdinal: number,
    snapshotBlockIndex: number,
  ): ClaudeAssistantBlockRef {
    const messageId = this.currentMessageId ?? this.lastAssistantMessageId;
    const streamed = messageId
      ? (this.assistantBlocksByMessage.get(messageId) ?? []).filter((block) => block.kind === kind)
      : [];
    const existing = streamed[semanticOrdinal];
    if (existing) return existing;
    const block = {
      kind,
      itemId: `snapshot-${kind}-${semanticOrdinal}`,
      blockIndex: snapshotBlockIndex,
    };
    if (messageId) {
      const blocks = this.assistantBlocksByMessage.get(messageId) ?? [];
      blocks.push(block);
      this.assistantBlocksByMessage.set(messageId, blocks);
    }
    return block;
  }

  private assistantBlockAt(
    messageId: string | undefined,
    blockIndex: number | undefined,
  ): ClaudeAssistantBlockRef | undefined {
    if (!messageId || blockIndex === undefined) return undefined;
    return (this.assistantBlocksByMessage.get(messageId) ?? [])
      .find((block) => block.blockIndex === blockIndex);
  }

  private messageBlockKey(messageId: string, blockIndex: number) {
    return `${messageId}\0${blockIndex}`;
  }

  private async finalizeToolInput(
    callId: string,
    blockIndex: number | undefined,
    requireComplete = true,
  ) {
    const active = this.activeTurn;
    const tool = this.tools.get(callId);
    if (!active || !tool?.partialInputJson) return;
    let input: unknown;
    try {
      input = JSON.parse(tool.partialInputJson);
    } catch {
      if (requireComplete) tool.partialInputJson = undefined;
      return;
    }
    const inputHash = hashJson(input);
    if (tool.inputHash === inputHash) return;
    const fileChanges = tool.fileChanges?.length
      ? tool.fileChanges
      : await captureClaudeFileToolChanges(this.openedWith.cwd, tool.name, input);
    this.tools.set(callId, {
      ...tool,
      input,
      inputHash,
      partialInputJson: undefined,
      ...(fileChanges.length > 0 ? { fileChanges } : {}),
    });
    this.emit({
      type: 'tool.updated',
      toolCallId: callId,
      tool: {
        callId,
        name: tool.name,
        category: toolCategory(tool.name),
        title: toolTitle(tool.name, input),
      },
      inputPreview: jsonPreview(input),
    }, 'stream/tool_input', active.turnId, active.nativeTurnId, callId, blockIndex);
  }

  private async handleUserMessage(message: Record<string, unknown>) {
    const active = this.activeTurn;
    if (!active || this.recoveringAcceptedTurn) return;
    const body = objectValue(message.message);
    const content = Array.isArray(body?.content) ? body.content : [];
    for (const blockValue of content) {
      const block = objectValue(blockValue);
      if (block?.type !== 'tool_result') continue;
      const callId = stringValue(block.tool_use_id);
      if (!callId || !this.tools.has(callId)) continue;
      const tool = this.tools.get(callId)!;
      this.emit({
        type: 'tool.updated',
        toolCallId: callId,
        outputPreview: jsonPreview(block.content),
      }, 'user/tool_result', active.turnId, active.nativeTurnId, callId);
      if (block.is_error !== true) {
        for (const [index, change] of (tool.fileChanges ?? []).entries()) {
          const completedChange = await completeClaudeFileChange(this.openedWith.cwd, change);
          this.emit(
            { type: 'file.changed', change: completedChange },
            'user/tool_file_changed',
            active.turnId,
            active.nativeTurnId,
            `${callId}:file-change:${index}`,
          );
        }
      }
      this.emit({
        type: 'tool.completed',
        toolCallId: callId,
        outcome: block.is_error === true ? 'failed' : 'completed',
      }, 'user/tool_result_completed', active.turnId, active.nativeTurnId, callId);
    }
  }

  private handleToolProgress(message: Record<string, unknown>) {
    const active = this.activeTurn;
    const callId = stringValue(message.tool_use_id);
    if (!active || !callId || !this.tools.has(callId)) return;
    this.emit({
      type: 'tool.updated',
      toolCallId: callId,
      outputPreview: {
        elapsedSeconds: numberValue(message.elapsed_time_seconds) ?? 0,
        ...(message.heartbeat === true ? { heartbeat: true } : {}),
      },
    }, 'tool/progress', active.turnId, active.nativeTurnId, callId);
  }

  private emitContextUsage(nativeKind: string) {
    const active = this.activeTurn;
    if (!active) return;
    this.latestUsage = { ...this.latestUsage, context: this.contextUsage.snapshot(active.turnId) };
    this.emit({ type: 'usage.updated', usage: this.latestUsage },
      nativeKind, active.turnId, active.nativeTurnId);
  }

  private handleResult(message: Record<string, unknown>) {
    const active = this.activeTurn;
    if (!active) return;
    if (this.recoveringAcceptedTurn) {
      const numTurns = nonnegativeInteger(message.num_turns);
      this.failRecoveredTurn(numTurns === 0
        ? 'Claude Code resumed the native session, but its previous process ended before this turn produced a terminal result. Claude cannot restore an in-flight model invocation without rerunning the prompt; send a follow-up to continue.'
        : 'Claude Code resumed the native session without authoritative terminal evidence for the interrupted turn. Send a follow-up to continue.');
      return;
    }
    const finalText = stringValue(message.result);
    if (finalText && active.assistantText.length === 0) this.emit({ type: 'assistant.text', phase: 'final', text: finalText },
      'result/text', active.turnId, active.nativeTurnId);
    const usage = objectValue(message.usage);
    if (usage) {
      const inputTokens = nonnegativeInteger(usage.input_tokens);
      const outputTokens = nonnegativeInteger(usage.output_tokens);
      const cacheRead = nonnegativeInteger(usage.cache_read_input_tokens);
      const cacheCreate = nonnegativeInteger(usage.cache_creation_input_tokens);
      const modelUsage = objectValue(message.modelUsage);
      const modelSamples = Object.values(modelUsage ?? {}).flatMap((value) => {
        const sample = objectValue(value);
        return sample ? [sample] : [];
      });
      const cumulative = aggregateClaudeModelUsage(modelSamples);
      this.contextUsage.updateWindows(modelUsage);
      this.latestUsage = {
        turn: {
          inputTokens: inputTokens ?? null,
          cachedInputTokens: cacheRead ?? null,
          cacheWriteInputTokens: cacheCreate ?? null,
          outputTokens: outputTokens ?? null,
          reasoningOutputTokens: null,
          // Claude does not report an authoritative total for this shape.
          // Cached/thinking accounting differs from a naive input + output
          // sum, so preserve unknown rather than inventing a provider total.
          totalTokens: null,
        },
        cumulative: cumulative ? {
          tokens: cumulative,
          scope: 'runtime-epoch',
          epochId: this.nativeSession.sessionId,
        } : null,
        context: this.contextUsage.snapshot(active.turnId),
        estimatedCost: nonnegativeNumber(message.total_cost_usd) === undefined ? null : {
          usd: nonnegativeNumber(message.total_cost_usd)!,
          scope: 'runtime-epoch',
          epochId: this.nativeSession.sessionId,
        },
      };
      // Version the native kind so persisted readings from the old accumulated
      // calculation can be invalidated without rewriting historical events.
      this.emit({ type: 'usage.updated', usage: this.latestUsage },
        'result/usage-v2', active.turnId, active.nativeTurnId);
    }
    const isError = message.is_error === true || message.subtype !== 'success';
    const outcome = this.interruptRequested ? 'interrupted' : isError ? 'failed' : 'completed';
    const errors = Array.isArray(message.errors)
      ? message.errors.filter((value): value is string => typeof value === 'string')
      : [];
    if (active.promptUuid && active.lastChainEntryUuid) {
      this.emit({
        type: 'turn.branch-point',
        cursorVersion: 1,
        cursor: {
          version: 1,
          promptUuid: active.promptUuid,
          previousChainEntryUuid: active.previousChainEntryUuid ?? null,
          lastChainEntryUuid: active.lastChainEntryUuid,
        },
      }, 'result/branch_point', active.turnId, active.nativeTurnId);
    }
    this.emit({
      type: 'turn.completed',
      outcome,
      ...(outcome === 'failed'
        ? { error: { code: 'claude_turn_failed', message: errors.join('\n') || finalText || 'Claude Code turn failed.' } }
        : {}),
    }, 'result/completed', active.turnId, active.nativeTurnId);
    this.activeTurn = undefined;
    this.interruptRequested = false;
    this.state = 'idle';
  }

  private failRecoveredTurn(message: string) {
    const active = this.activeTurn;
    if (!active || !this.recoveringAcceptedTurn) return;
    this.emit({
      type: 'turn.completed',
      outcome: 'recovery_failed',
      error: {
        code: 'claude_inflight_turn_not_resumable',
        message,
        retryable: true,
      },
    }, 'resume/turn_unrecoverable', active.turnId, active.nativeTurnId);
    this.activeTurn = undefined;
    this.recoveringAcceptedTurn = false;
    this.interruptRequested = false;
    this.state = 'idle';
    this.emit({ type: 'session.health', state: 'ready' }, 'resume/ready');
  }

  private handleRateLimitEvent(message: Record<string, unknown>) {
    const info = objectValue(message.rate_limit_info);
    const id = stringValue(info?.rateLimitType);
    const utilization = nonnegativeNumber(info?.utilization);
    if (!id || utilization === undefined) return;
    const model = id.endsWith('_opus') ? 'opus' : id.endsWith('_sonnet') ? 'sonnet' : null;
    this.accountWindows.set(id, {
      id,
      label: id === 'five_hour' ? '5 hour'
        : id === 'seven_day' ? 'Weekly'
          : id === 'seven_day_opus' ? 'Weekly Opus'
            : id === 'seven_day_sonnet' ? 'Weekly Sonnet'
              : id.replaceAll('_', ' '),
      kind: id === 'five_hour' ? 'rolling' : id.startsWith('seven_day_') ? 'model'
        : id === 'seven_day' ? 'weekly' : 'extra',
      model,
      usedPercent: Math.min(100, utilization <= 1 ? utilization * 100 : utilization),
      resetsAt: normalizeTimestamp(info?.resetsAt),
    });
    const observedAt = this.now();
    this.emit({
      type: 'account.usage-updated',
      usage: {
        availability: 'available',
        windows: [...this.accountWindows.values()],
        source: 'provider-push',
        freshness: 'live',
        observedAt,
      },
    }, 'account/rate_limit');
  }

  private emit(
    input: MapperEvent,
    nativeKind: string,
    turnId?: string,
    nativeTurnId?: string,
    itemId?: string,
    blockIndex?: number,
  ) {
    const sequence = this.sequence + 1;
    const nativeItemId = itemId
      ? stableUuid(`claude-item\0${this.nativeSession.sessionId}\0${itemId}`)
      : undefined;
    const normalized = this.normalizeEvent(input, turnId, nativeTurnId, itemId, blockIndex);
    const observedAt = this.now();
    const buildEnvelope = (event: ProviderEvent) => ({
      contractVersion: PROVIDER_RUNTIME_CONTRACT_VERSION,
      eventId: `claude:${hashJson({
        sessionId: this.nativeSession.sessionId,
        providerMessageId: this.currentEnvelopeUuid ?? null,
        assistantMessageId: this.currentMessageId ?? null,
        turnId: turnId ?? null,
        nativeTurnId: nativeTurnId ?? null,
        itemId: nativeItemId ?? null,
        nativeKind,
        event,
      })}`,
      provider: 'claude-code',
      scope: event.type === 'account.usage-updated' ? {
        kind: 'account',
        providerInstanceId: this.openedWith.providerInstanceId,
      } : turnId ? {
        kind: 'turn',
        providerInstanceId: this.openedWith.providerInstanceId,
        conversationId: this.openedWith.conversationId,
        executionId: this.openedWith.executionId,
        turnId,
      } : {
        kind: 'conversation',
        providerInstanceId: this.openedWith.providerInstanceId,
        conversationId: this.openedWith.conversationId,
        executionId: this.openedWith.executionId,
      },
      native: {
        sessionId: this.nativeSession.sessionId,
        ...(nativeTurnId ? { turnId: nativeTurnId } : {}),
        ...((this.currentMessageId ?? this.currentEnvelopeUuid)
          ? { messageId: this.currentMessageId ?? this.currentEnvelopeUuid! }
          : {}),
        ...(nativeItemId ? { itemId: nativeItemId } : {}),
        position: { kind: 'native-sequence', sequence, subIndex: blockIndex ?? 0 },
        kind: nativeKind,
      },
      observedAt,
      event,
    });
    const event = fitProviderEventDisplay({
      event: normalized,
      maxBytes: PROVIDER_RUNTIME_LIMITS.eventBytes,
      buildEnvelope,
      hashJson,
    });
    const envelope = parseProviderEventEnvelope(buildEnvelope(event));
    this.sequence = sequence;
    this.commitBlockEvent(envelope.event, turnId, itemId);
    this.eventLog.push(envelope);
    this.events.emit(envelope);
  }

  private normalizeEvent(
    input: MapperEvent,
    turnId?: string,
    nativeTurnId?: string,
    itemId?: string,
    blockIndex?: number,
  ): ProviderEvent {
    const event = input as Record<string, unknown> & { type: string };
    switch (event.type) {
      case 'assistant.reasoning': {
        const previous = this.findBlock(turnId, itemId, 'reasoning-summary');
        const previousText = previous?.block.payload.kind === 'reasoning-summary'
          ? previous.block.payload.text : '';
        const completed = event.summary !== undefined;
        if (!completed && previous?.block.payload.kind === 'reasoning-summary' &&
            previous.block.payload.truncated) {
          return this.blockEvent(
            turnId, nativeTurnId, itemId, blockIndex, 'reasoning-summary',
            previous.block.payload, 'streaming', false,
          );
        }
        const text = completed ? stringValue(event.summary) ?? ''
          : `${previousText}${stringValue(event.delta) ?? ''}`;
        return this.blockEvent(
          turnId, nativeTurnId, itemId, blockIndex, 'reasoning-summary', {
            kind: 'reasoning-summary',
            text,
            ...(text ? { parts: [text] } : {}),
            truncated: completed ? false : previous?.block.payload.kind === 'reasoning-summary'
              ? previous.block.payload.truncated : false,
          }, completed ? 'completed' : 'streaming', completed,
        );
      }
      case 'assistant.text': {
        const kind = event.phase === 'commentary' ? 'commentary' : 'final-message';
        const previous = this.findBlock(turnId, itemId, kind);
        const previousText = previous?.block.payload.kind === kind ? previous.block.payload.text : '';
        const completed = event.text !== undefined;
        return this.blockEvent(turnId, nativeTurnId, itemId, blockIndex, kind, {
          kind,
          text: completed ? stringValue(event.text) ?? '' : `${previousText}${stringValue(event.delta) ?? ''}`,
        }, completed ? 'completed' : 'streaming', completed);
      }
      case 'tool.started': {
        const tool = event.tool as Extract<TurnBlockPayload, { kind: 'tool' }>['tool'];
        const key = this.blockKey(turnId, itemId ?? tool.callId, 'tool');
        return this.blockEvent(turnId, nativeTurnId, itemId ?? tool.callId, blockIndex, 'tool', {
          kind: 'tool', tool,
          ...(event.inputPreview === undefined ? {} : { inputPreview: event.inputPreview as JsonValue }),
        }, 'running', false, key);
      }
      case 'tool.updated':
      case 'tool.completed': {
        const callId = stringValue(event.toolCallId) ?? itemId ?? 'unknown';
        const key = this.toolBlockKey.get(callId) ?? this.blockKey(turnId, callId, 'tool');
        const previous = this.blocks.get(key);
        const payload = previous?.block.payload.kind === 'tool' ? previous.block.payload : {
          kind: 'tool' as const,
          tool: { callId, name: this.tools.get(callId)?.name ?? 'tool', category: 'other' as const },
        };
        const completed = event.type === 'tool.completed';
        return this.blockEvent(turnId, nativeTurnId, callId, blockIndex, 'tool', {
          ...payload,
          ...(event.tool === undefined ? {} : {
            tool: event.tool as Extract<TurnBlockPayload, { kind: 'tool' }>['tool'],
          }),
          ...(event.inputPreview === undefined ? {} : { inputPreview: event.inputPreview as JsonValue }),
          ...(event.outputPreview === undefined ? {} : { outputPreview: event.outputPreview as JsonValue }),
        }, completed ? event.outcome === 'failed' ? 'failed' : 'completed' : 'running', completed, key);
      }
      case 'file.changed':
        return { type: 'turn.file-changed', change: event.change as never,
          ...(itemId ? { blockId: itemId.split(':file-change:')[0] } : {}) };
      case 'child.started': {
        const child = event.child as ChildExecutionDisplay;
        const key = this.blockKey(turnId, child.executionId, 'native-child');
        return this.blockEvent(turnId, nativeTurnId, child.executionId, blockIndex, 'native-child', {
          kind: 'native-child', child, executionState: 'running',
        }, 'running', false, key);
      }
      case 'child.status':
      case 'child.summary':
      case 'child.completed': {
        const childExecutionId = stringValue(event.childExecutionId) ?? itemId ?? 'unknown';
        const key = this.childBlockKey.get(childExecutionId)
          ?? this.blockKey(turnId, childExecutionId, 'native-child');
        const previous = this.blocks.get(key);
        const payload = previous?.block.payload.kind === 'native-child'
          ? previous.block.payload
          : {
              kind: 'native-child' as const,
              child: {
                executionId: childExecutionId,
                ownership: 'native' as const,
                provider: 'claude-code' as const,
                providerInstanceId: this.openedWith.providerInstanceId,
              },
              executionState: 'running' as const,
            };
        const completed = event.type === 'child.completed';
        const outcome = completed ? event.outcome as 'completed' | 'failed' | 'interrupted' : payload.outcome;
        const executionState = event.type === 'child.status'
          ? event.state as typeof payload.executionState
          : completed ? outcome === 'completed' ? 'idle' : outcome === 'interrupted' ? 'interrupted' : 'failed'
            : payload.executionState;
        return this.blockEvent(turnId, nativeTurnId, childExecutionId, blockIndex, 'native-child', {
          ...payload,
          executionState,
          ...(event.type === 'child.summary' && stringValue(event.summary)
            ? { summary: stringValue(event.summary)! } : {}),
          ...(outcome ? { outcome } : {}),
        }, completed
          ? outcome === 'completed' ? 'completed' : outcome === 'interrupted' ? 'interrupted' : 'failed'
          : 'running', completed, key);
      }
      case 'usage.updated':
        return { type: 'turn.usage-updated', usage: event.usage as never };
      default:
        return input as ProviderEvent;
    }
  }

  private completeBlock(
    turnId: string,
    nativeTurnId: string,
    itemId: string | undefined,
    blockIndex: number | undefined,
  ) {
    for (const kind of ['reasoning-summary', 'commentary', 'final-message'] as const) {
      const previous = this.findBlock(turnId, itemId, kind);
      if (!previous) continue;
      const block = { ...previous.block, state: 'completed' as const };
      this.emit({
        type: 'turn.block.completed',
        structure: previous.structure,
        revision: previous.revision + 1,
        contentHash: hashJson(block),
        block,
      }, 'stream/block_stop', turnId, nativeTurnId, itemId, blockIndex);
      return;
    }
  }

  private blockEvent(
    turnId: string | undefined,
    nativeTurnId: string | undefined,
    itemId: string | undefined,
    blockIndex: number | undefined,
    kind: TurnBlockKind,
    payload: TurnBlockPayload,
    state: TurnBlockSnapshot['state'],
    completed: boolean,
    explicitKey?: string,
  ): ProviderEvent {
    const key = explicitKey ?? this.blockKey(turnId, itemId, kind);
    const previous = this.blocks.get(key);
    const structure = previous?.structure ?? this.structure(turnId, nativeTurnId, itemId, kind, blockIndex);
    const revision = previous ? previous.revision + 1 : completed ? 1 : 0;
    const block = { kind, state, payload } as TurnBlockSnapshot;
    if (!previous && !completed) return { type: 'turn.block.started', structure, block };
    return completed
      ? { type: 'turn.block.completed', structure, revision, contentHash: hashJson(block), block }
      : { type: 'turn.block.revised', structure, revision, contentHash: hashJson(block), block };
  }

  private findBlock(turnId: string | undefined, itemId: string | undefined, kind: TurnBlockKind) {
    return this.blocks.get(this.blockKey(turnId, itemId, kind));
  }

  private blockKey(turnId: string | undefined, itemId: string | undefined, kind: TurnBlockKind) {
    return `${turnId ?? 'conversation'}\0${this.currentMessageId ?? this.lastAssistantMessageId ?? 'native'}\0${itemId ?? kind}\0${kind}`;
  }

  private structure(
    turnId: string | undefined,
    nativeTurnId: string | undefined,
    itemId: string | undefined,
    kind: TurnBlockKind,
    blockIndex?: number,
  ): TurnStructure {
    const messageId = this.currentMessageId ?? this.lastAssistantMessageId ??
      `${nativeTurnId ?? turnId ?? 'conversation'}:pass`;
    const passKey = `${turnId ?? 'conversation'}\0${messageId}`;
    let passOrdinal = this.passOrdinals.get(passKey);
    if (passOrdinal === undefined) {
      passOrdinal = [...this.passOrdinals.keys()]
        .filter((key) => key.startsWith(`${turnId ?? 'conversation'}\0`)).length;
    }
    // Claude's task lifecycle messages do not carry a content-block index.
    // A background command can therefore arrive beside its Bash tool at the
    // default ordinal zero. The journal requires one block per pass ordinal,
    // so retain native indices when available and allocate the next free slot
    // for synthesized/unindexed blocks (or any other native collision).
    const occupiedOrdinals = new Set([...this.blocks.values()]
      .filter(({ structure }) => structure.passId ===
        `claude-pass-${hashJson([this.nativeSession.sessionId, messageId]).slice(0, 24)}`)
      .map(({ structure }) => structure.blockOrdinal));
    let blockOrdinal = blockIndex ?? 0;
    while (occupiedOrdinals.has(blockOrdinal)) blockOrdinal += 1;
    return {
      passId: `claude-pass-${hashJson([this.nativeSession.sessionId, messageId]).slice(0, 24)}`,
      blockId: `claude-block-${hashJson([
        this.nativeSession.sessionId, turnId, messageId, itemId ?? kind, kind,
      ]).slice(0, 32)}`,
      passOrdinal,
      blockOrdinal,
    };
  }

  private commitBlockEvent(
    event: ProviderEvent,
    turnId: string | undefined,
    itemId: string | undefined,
  ) {
    if (event.type !== 'turn.block.started' &&
        event.type !== 'turn.block.revised' &&
        event.type !== 'turn.block.completed') return;
    const existingKey = [...this.blocks.entries()]
      .find(([, value]) => value.structure.blockId === event.structure.blockId)?.[0];
    const identity = event.block.payload.kind === 'tool'
      ? event.block.payload.tool.callId
      : event.block.payload.kind === 'native-child' || event.block.payload.kind === 'federated-child'
        ? event.block.payload.child.executionId
        : itemId;
    const key = existingKey ?? this.blockKey(turnId, identity, event.block.kind);
    const revision = event.type === 'turn.block.started' ? 0 : event.revision;
    this.blocks.set(key, {
      structure: event.structure,
      block: event.block,
      revision,
    });
    if (event.block.payload.kind === 'tool') {
      this.toolBlockKey.set(event.block.payload.tool.callId, key);
    } else if (event.block.payload.kind === 'native-child') {
      this.childBlockKey.set(event.block.payload.child.executionId, key);
    }
    const messageId = this.currentMessageId ?? this.lastAssistantMessageId ??
      `${turnId ?? 'conversation'}:pass`;
    const passKey = `${turnId ?? 'conversation'}\0${messageId}`;
    this.passOrdinals.set(passKey, event.structure.passOrdinal);
  }

  private onceCommand<T extends ProviderCommandAcceptance | ProviderDispatchResult>(
    commandId: string,
    input: unknown,
    run: () => Promise<T>,
  ) {
    const hash = hashJson(input);
    const previous = this.receipts.get(commandId);
    if (previous) {
      if (previous.hash !== hash) {
        return Promise.reject(new Error('Claude command ID was reused with different input.'));
      }
      return previous.result as Promise<T>;
    }
    const result = run();
    this.receipts.set(commandId, { hash, result });
    return result;
  }

  private async prepareTurnConfiguration(input: StartProviderTurnInput) {
    const model = input.model ?? this.openedWith.model;
    if (model) await this.query.setModel(model);
    await this.query.applyFlagSettings({
      effortLevel: input.effort === undefined ? null : claudeEffort(input.effort),
    });
  }

  private assertOpen() {
    if (this.closed) throw new Error('Claude provider session is closed.');
    if (this.state === 'lost') throw new Error('Claude provider session is unavailable.');
  }
}

class ClaudeInputQueue implements AsyncIterable<SDKUserMessage> {
  private readonly values: SDKUserMessage[] = [];
  private readonly waiters: Array<(result: IteratorResult<SDKUserMessage>) => void> = [];
  private closed = false;

  push(value: SDKUserMessage) {
    if (this.closed) throw new Error('Claude input stream is closed.');
    const waiter = this.waiters.shift();
    if (waiter) waiter({ done: false, value });
    else this.values.push(value);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    let returned = false;
    return {
      next: async () => {
        if (returned) return { done: true, value: undefined };
        const value = this.values.shift();
        if (value) return { done: false, value };
        if (this.closed) return { done: true, value: undefined };
        return new Promise((resolve) => this.waiters.push(resolve));
      },
      return: async () => {
        // Iterator teardown belongs to the SDK query consuming it. Closing the
        // shared queue here made a transport restart permanently reject later
        // turns even though the provider session itself was still open.
        returned = true;
        return { done: true, value: undefined };
      },
    };
  }
}

function claudeCapabilities(providerVersion: string, manualCompact = true): ProviderCapabilities {
  return {
    protocolVersion: PROVIDER_RUNTIME_CONTRACT_VERSION,
    provider: 'claude-code',
    providerVersion,
    adapterVersion: ADAPTER_VERSION,
    auth: 'native-subscription',
    authentication: { login: 'none', logout: true },
    session: {
      create: true,
      resume: true,
      discoverHistory: false,
      readSnapshot: true,
      forkNative: true,
      contextBranching: {
        strategy: 'native',
        boundary: 'turn',
        sameProviderInstanceOnly: true,
        workspace: 'shared-current',
        whileBackgroundChildrenRun: false,
      },
      rollbackNative: false,
    },
    turns: {
      interrupt: true,
      steer: false,
      queue: true,
      changeModelOnExistingSession: true,
      changeEffortOnExistingSession: true,
    },
    content: {
      images: true,
      fileReferences: true,
      reasoning: true,
      diffs: true,
      webActivity: true,
    },
    collaboration: {
      nativeSubagents: true,
      childTranscript: 'summary',
      childSteer: false,
      childInterrupt: true,
    },
    interaction: { blockingApprovals: false, structuredUserInput: false },
    access: {
      presets: ['read-only', 'workspace-write', 'full-access'],
      defaultPreset: 'workspace-write',
    },
    usage: {
      turn: true,
      cumulative: true,
      context: 'derived',
      plan: 'read-and-push',
      estimatedCost: true,
    },
    compaction: { automaticNative: true, manualNative: manualCompact },
  };
}

function probeQueryOptions(
  binaryPath: string,
  configuredEnvironment?: Readonly<Record<string, string | undefined>>,
): ClaudeQueryOptions {
  return {
    pathToClaudeCodeExecutable: binaryPath,
    settingSources: ['user', 'project', 'local'],
    settings: { disableAllHooks: true },
    allowedTools: [],
    tools: [],
    mcpServers: {},
    strictMcpConfig: true,
    persistSession: false,
    env: subscriptionEnvironment(configuredEnvironment),
    stderr: () => undefined,
  };
}

function sessionQueryOptions(input: {
  input: OpenProviderSessionInput;
  sessionId: string;
  binaryPath: string;
  environment?: Readonly<Record<string, string | undefined>>;
  onFileChanged: (change: ClaudeFileChange) => void;
  onStderr: (chunk: string) => void;
}): ClaudeQueryOptions {
  const instructions = input.input.developerInstructions.join('\n\n');
  const permission = permissionOptions(input.input.access, input.input.cwd);
  return {
    cwd: input.input.cwd,
    model: input.input.model,
    ...(input.input.effort ? { effort: claudeEffort(input.input.effort) } : {}),
    pathToClaudeCodeExecutable: input.binaryPath,
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      ...(instructions ? { append: instructions, snapshot: true } : {}),
    },
    settingSources: ['user', 'project', 'local'],
    settings: {
      disableAllHooks: false,
      autoCompactEnabled: true,
      autoCompactWindow: DEFAULT_CLAUDE_COMPACT_WINDOW,
      precomputeCompactionEnabled: false,
    },
    hooks: claudeSessionHooks(input.input.access, input.input.cwd, input.onFileChanged),
    tools: { type: 'preset', preset: 'claude_code' },
    includePartialMessages: true,
    forwardSubagentText: true,
    perTaskStopAffordance: true,
    persistSession: true,
    env: subscriptionEnvironment(input.environment),
    ...(input.input.mode === 'create'
      ? { sessionId: input.sessionId }
      : { resume: input.sessionId }),
    ...permission,
    ...(input.input.federation ? {
      // PreToolUse still runs for pre-approved tools. This keeps the chat-only
      // policy in the SDK's supported hook layer without a shadowed canUseTool
      // callback; the scoped credential and coordinator enforce federation.
      allowedTools: [...FEDERATION_ALLOWED_TOOLS],
      mcpServers: {
        [FEDERATION_SERVER_NAME]: {
          type: 'http',
          url: input.input.federation.endpoint,
          headers: { Authorization: input.input.federation.authorizationHeader },
          timeout: FEDERATION_TOOL_TIMEOUT_MS,
          alwaysLoad: true,
        },
      },
    } : {}),
    stderr: input.onStderr,
  };
}

function recordClaudeDiagnostic(diagnostics: string[], chunk: string) {
  const sanitized = chunk
    .replace(/Bearer\s+\S+/giu, 'Bearer [redacted]')
    .replace(/\bsk-ant-[A-Za-z0-9_-]+\b/gu, '[redacted-api-key]')
    .replace(/[\r\n]+/gu, ' ')
    .trim()
    .slice(0, 2_000);
  if (!sanitized) return;
  diagnostics.push(sanitized);
  if (diagnostics.length > 8) diagnostics.splice(0, diagnostics.length - 8);
}

function claudeBranchCursor(value: JsonValue | undefined): ClaudeBranchCursor | undefined {
  const record = objectValue(value);
  if (record?.version !== 1) return undefined;
  const promptUuid = stringValue(record.promptUuid);
  const lastChainEntryUuid = stringValue(record.lastChainEntryUuid);
  const previous = record.previousChainEntryUuid === null
    ? null
    : stringValue(record.previousChainEntryUuid);
  if (!promptUuid || !lastChainEntryUuid || previous === undefined) return undefined;
  return {
    version: 1,
    promptUuid,
    previousChainEntryUuid: previous,
    lastChainEntryUuid,
  };
}

type ClaudeFileChange = {
  path: string;
  kind: 'add' | 'delete' | 'update';
  beforeText?: string | null;
};

const CLAUDE_DIFF_FILE_BYTES = 2 * 1024 * 1024;

function claudeFileToolChanges(cwd: string, toolName: string, input: unknown): ClaudeFileChange[] {
  if (!['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(toolName)) return [];
  const record = objectValue(input);
  const path = stringValue(toolName === 'NotebookEdit' ? record?.notebook_path : record?.file_path);
  if (!path) return [];
  const absolutePath = isAbsolute(path) ? path : resolve(cwd, path);
  if (!isWithin(cwd, absolutePath)) return [];
  return [{ path: absolutePath, kind: existsSync(absolutePath) ? 'update' : 'add' }];
}

async function captureClaudeFileToolChanges(cwd: string, toolName: string, input: unknown) {
  const changes = claudeFileToolChanges(cwd, toolName, input);
  return Promise.all(changes.map(async (change): Promise<ClaudeFileChange> => ({
    ...change,
    beforeText: await readClaudeDiffText(change.path),
  })));
}

async function completeClaudeFileChange(cwd: string, change: ClaudeFileChange) {
  const { beforeText, ...display } = change;
  if (beforeText === undefined) return display;
  const afterText = await readClaudeDiffText(change.path);
  if (afterText === undefined) return display;
  const path = relative(cwd, change.path).replaceAll('\\', '/');
  const diff = unifiedFileDiff(path, beforeText, afterText);
  return diff ? { ...display, diff } : display;
}

async function readClaudeDiffText(path: string): Promise<string | null | undefined> {
  try {
    const bytes = await readFile(path);
    if (bytes.byteLength > CLAUDE_DIFF_FILE_BYTES || bytes.includes(0)) return undefined;
    return bytes.toString('utf8');
  } catch (error) {
    return objectValue(error)?.code === 'ENOENT' ? null : undefined;
  }
}

/** A bounded single-hunk unified diff for Claude's native file tools. */
function unifiedFileDiff(path: string, before: string | null, after: string | null) {
  if (before === after) return undefined;
  const oldLines = splitDiffLines(before ?? '');
  const newLines = splitDiffLines(after ?? '');
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length &&
      oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix &&
      oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]) suffix += 1;

  const context = 3;
  const oldChangedEnd = oldLines.length - suffix;
  const newChangedEnd = newLines.length - suffix;
  const oldStart = Math.max(0, prefix - context);
  const newStart = Math.max(0, prefix - context);
  const oldEnd = Math.min(oldLines.length, oldChangedEnd + context);
  const newEnd = Math.min(newLines.length, newChangedEnd + context);
  const oldCount = oldEnd - oldStart;
  const newCount = newEnd - newStart;
  const lines = [
    `--- ${before === null ? '/dev/null' : `a/${path}`}`,
    `+++ ${after === null ? '/dev/null' : `b/${path}`}`,
    `@@ -${diffRange(oldStart, oldCount)} +${diffRange(newStart, newCount)} @@`,
  ];
  for (let index = oldStart; index < prefix; index += 1) lines.push(` ${oldLines[index]}`);
  for (let index = prefix; index < oldChangedEnd; index += 1) lines.push(`-${oldLines[index]}`);
  for (let index = prefix; index < newChangedEnd; index += 1) lines.push(`+${newLines[index]}`);
  for (let index = newChangedEnd; index < newEnd; index += 1) lines.push(` ${newLines[index]}`);
  return `${lines.join('\n')}\n`;
}

function splitDiffLines(value: string) {
  const lines = value.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.map((line) => line.endsWith('\r') ? line.slice(0, -1) : line);
}

function diffRange(start: number, count: number) {
  const line = count === 0 ? start : start + 1;
  return count === 1 ? `${line}` : `${line},${count}`;
}

function claudeSessionHooks(
  access: ProviderAccess,
  cwd: string,
  onFileChanged: (change: ClaudeFileChange) => void,
) {
  const preToolUse: HookCallback = async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return { continue: true };
    const denial = toolDenial(access, cwd, input.tool_name, input.tool_input);
    return denial
      ? {
          continue: true,
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: denial,
          },
        }
      : { continue: true };
  };
  const sessionStart: HookCallback = async () => ({
    continue: true,
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      watchPaths: [cwd],
    },
  });
  const fileChanged: HookCallback = async (input) => {
    if (input.hook_event_name === 'FileChanged' && input.file_path) {
      onFileChanged({
        path: input.file_path,
        kind: input.event === 'add' ? 'add' : input.event === 'unlink' ? 'delete' : 'update',
      });
    }
    return { continue: true };
  };
  return {
    PreToolUse: [{ hooks: [preToolUse] }],
    SessionStart: [{ hooks: [sessionStart] }],
    FileChanged: [{ hooks: [fileChanged] }],
  } satisfies NonNullable<ClaudeQueryOptions['hooks']>;
}

function permissionOptions(access: ProviderAccess, cwd: string): Pick<
  ClaudeQueryOptions,
  'permissionMode' | 'allowDangerouslySkipPermissions' | 'disallowedTools' | 'sandbox'
> {
  if (access === 'full-access') {
    return {
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
    };
  }
  return {
    permissionMode: access === 'workspace-write' ? 'acceptEdits' : 'dontAsk',
    ...(access === 'workspace-write'
      ? {
          sandbox: {
            enabled: true,
            failIfUnavailable: true,
            autoAllowBashIfSandboxed: true,
            allowUnsandboxedCommands: false,
            filesystem: { allowWrite: [cwd] },
          },
        }
      : {}),
    ...(access === 'read-only'
      ? { disallowedTools: [...READ_ONLY_DENIED_TOOLS] }
      : {}),
  };
}

const READ_ONLY_DENIED_TOOLS = [
  'Bash',
  'Edit',
  'Write',
  'NotebookEdit',
  'REPL',
  'Workflow',
  'EnterWorktree',
  'ExitWorktree',
] as const;

function toolDenial(access: ProviderAccess, cwd: string, toolName: string, toolInput: unknown) {
  if (toolName === 'AskUserQuestion') {
    return 'Remux uses ordinary chat. Ask the user in your response instead of opening a questionnaire.';
  }
  if (access === 'read-only' && READ_ONLY_DENIED_TOOLS.some((denied) => denied === toolName)) {
    return 'This delegated execution is read-only.';
  }
  const input = objectValue(toolInput);
  const candidate = stringValue(input?.file_path) ?? stringValue(input?.notebook_path);
  if (access !== 'full-access' && candidate) {
    const absolutePath = isAbsolute(candidate) ? candidate : resolve(cwd, candidate);
    if (!isWithin(cwd, absolutePath)) {
      return 'The requested path is outside the Remux workspace access ceiling.';
    }
  }
  return null;
}

async function mapClaudeUserContent(
  content: readonly UserContentPart[],
  resolveImageArtifact?: (artifactId: string, mimeType: string) => Promise<{ path: string }>,
): Promise<SDKUserMessage['message']['content']> {
  const blocks: Array<Record<string, unknown>> = [];
  for (const part of content) {
    if (part.type === 'text') blocks.push({ type: 'text', text: part.text });
    else if (part.type === 'file-reference') {
      blocks.push({ type: 'text', text: `Referenced workspace path: ${part.path}` });
    } else {
      if (!resolveImageArtifact) throw new Error('Claude image artifact resolution is unavailable.');
      const resolved = await resolveImageArtifact(part.artifactId, part.mimeType);
      const data = await readFile(resolved.path, 'base64');
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: part.mimeType, data },
      });
    }
  }
  return blocks as unknown as SDKUserMessage['message']['content'];
}

function mapClaudeModel(model: ClaudeModelInfo, index: number): ProviderModelDescriptor {
  return {
    id: model.value,
    name: model.displayName || model.value,
    provider: 'claude-code',
    supportedEffort: model.supportedEffortLevels ?? (model.supportsEffort ? ['low', 'medium', 'high'] : []),
    ...(index === 0 ? { isDefault: true } : {}),
  };
}

function subscriptionEnvironment(
  configured?: Readonly<Record<string, string | undefined>>,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env, ...configured };
  delete environment.ANTHROPIC_API_KEY;
  delete environment.ANTHROPIC_AUTH_TOKEN;
  delete environment.REMUX_FEDERATION_MCP_BEARER_TOKEN;
  environment.CLAUDE_AGENT_SDK_CLIENT_APP = 'remux-agent/1';
  return environment;
}

function isApiKeyAuth(status: ClaudeAuthStatus) {
  const auth = status.authMethod?.toLowerCase().replaceAll(/[^a-z]/gu, '') ?? '';
  return auth.includes('apikey') || status.apiProvider && status.apiProvider !== 'firstParty';
}

function isNativeSubscriptionAuth(status: ClaudeAuthStatus) {
  return status.authMethod === 'claude.ai' &&
    status.apiProvider === 'firstParty' &&
    Boolean(status.subscriptionType?.trim());
}

function claudeEffort(value: string): 'low' | 'medium' | 'high' | 'xhigh' | 'max' {
  if (value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh' || value === 'max') {
    return value;
  }
  return 'medium';
}

function parseVersion(value: string) {
  return /\b(\d+\.\d+\.\d+)\b/u.exec(value)?.[1];
}

function toolCategory(name: string): 'shell' | 'file' | 'search' | 'web' | 'mcp' | 'collaboration' | 'other' {
  const normalized = name.toLowerCase();
  if (normalized === 'bash') return 'shell';
  if (['read', 'write', 'edit', 'notebookedit'].includes(normalized)) return 'file';
  if (['grep', 'glob'].includes(normalized)) return 'search';
  if (normalized.startsWith('web')) return 'web';
  if (normalized === 'agent' || normalized === 'task' || normalized.includes('workflow')) return 'collaboration';
  if (normalized.startsWith('mcp__')) return normalized.includes('remux-federation') ? 'collaboration' : 'mcp';
  return 'other';
}

function isClaudeChildTool(name: string) {
  const normalized = name.toLowerCase();
  return normalized === 'agent' || normalized === 'task';
}

function toolTitle(name: string, input: unknown) {
  const record = objectValue(input);
  return stringValue(record?.description)
    ?? stringValue(record?.file_path)
    ?? stringValue(record?.path)
    ?? stringValue(record?.query)
    ?? name;
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

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown) {
  return typeof value === 'string' && value ? value : undefined;
}

function fitContractString(value: string, limit: number) {
  return fitDisplayText({
    value,
    maxChars: limit,
    maxBytes: Number.MAX_SAFE_INTEGER,
    marker: '\n… error truncated …',
    build: (text) => text,
  }).text;
}


function numberValue(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function nonnegativeInteger(value: unknown) {
  const number = numberValue(value);
  return number !== undefined && Number.isSafeInteger(number) ? number : undefined;
}

function nonnegativeNumber(value: unknown) {
  return numberValue(value);
}

function normalizeTimestamp(value: unknown) {
  const number = nonnegativeNumber(value);
  if (number !== undefined) {
    return number < 1_000_000_000_000 ? Math.round(number * 1_000) : Math.round(number);
  }
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function normalizeClaudeAccountUsage(
  value: unknown,
  observedAt: number,
): ProviderAccountUsage {
  const response = objectValue(value);
  if (response?.rate_limits_available === false) {
    return {
      availability: 'not-applicable',
      windows: [],
      source: 'provider-read',
      freshness: 'live',
      observedAt,
    };
  }
  const limits = objectValue(response?.rate_limits);
  const windows: ProviderAccountUsage['windows'][number][] = [];
  const addWindow = (
    id: string,
    label: string,
    kind: ProviderAccountUsage['windows'][number]['kind'],
    raw: unknown,
    model: string | null = null,
  ) => {
    const window = objectValue(raw);
    const utilization = nonnegativeNumber(window?.utilization);
    if (utilization === undefined) return;
    windows.push({
      id,
      label,
      kind,
      model,
      usedPercent: Math.min(100, utilization),
      resetsAt: normalizeTimestamp(window?.resets_at),
    });
  };
  addWindow('five_hour', '5 hour', 'rolling', limits?.five_hour);
  addWindow('seven_day', 'Weekly', 'weekly', limits?.seven_day);
  addWindow('seven_day_oauth_apps', 'Weekly OAuth apps', 'extra', limits?.seven_day_oauth_apps);
  addWindow('seven_day_opus', 'Weekly Opus', 'model', limits?.seven_day_opus, 'Opus');
  addWindow('seven_day_sonnet', 'Weekly Sonnet', 'model', limits?.seven_day_sonnet, 'Sonnet');
  addWindow('extra_usage', 'Extra usage', 'extra', limits?.extra_usage);
  const modelScoped = Array.isArray(limits?.model_scoped) ? limits.model_scoped : [];
  for (const [index, raw] of modelScoped.entries()) {
    const window = objectValue(raw);
    const model = stringValue(window?.display_name);
    const utilization = nonnegativeNumber(window?.utilization);
    if (!model || utilization === undefined) continue;
    windows.push({
      id: `model:${hashJson([model, index]).slice(0, 16)}`,
      label: 'Weekly',
      kind: 'model',
      model,
      usedPercent: Math.min(100, utilization),
      resetsAt: normalizeTimestamp(window?.resets_at),
    });
  }
  return {
    availability: windows.length > 0 ? 'available' : 'unknown',
    windows,
    source: 'provider-read',
    freshness: 'live',
    observedAt,
  };
}

function aggregateClaudeModelUsage(samples: readonly Record<string, unknown>[]) {
  if (samples.length === 0) return null;
  const sum = (key: string) => samples.reduce((total, sample) =>
    total + (nonnegativeInteger(sample[key]) ?? 0), 0);
  return {
    inputTokens: sum('inputTokens'),
    cachedInputTokens: sum('cacheReadInputTokens'),
    cacheWriteInputTokens: sum('cacheCreationInputTokens'),
    outputTokens: sum('outputTokens'),
    reasoningOutputTokens: samples.some((sample) => sample.thinkingTokens !== undefined)
      ? sum('thinkingTokens') : null,
    totalTokens: null,
  };
}

function isWithin(root: string, path: string) {
  const candidate = isAbsolute(path) ? path : `${root}/${path}`;
  const relativePath = relative(root, candidate);
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}

function safeMessage(error: unknown) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/Bearer\s+\S+/giu, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, '[redacted]')
    .slice(0, 1_000);
}

function requireClaudeSubscription(account: ClaudeAccountInfo): ClaudeSubscriptionAuth {
  const source = knownAuthLabel(account.apiKeySource, CLAUDE_AUTH_SOURCE_LABELS);
  const provider = knownAuthLabel(account.apiProvider, CLAUDE_API_PROVIDER_LABELS);
  if (CLAUDE_API_KEY_SOURCES.has(account.apiKeySource ?? '')) {
    throw new ClaudeProviderAuthError(
      `Claude native subscription authentication is required; credential source ${JSON.stringify(source)} is incompatible.`,
    );
  }
  if (account.apiProvider !== 'firstParty') {
    throw new ClaudeProviderAuthError(
      `Claude native subscription authentication is required; API backend ${JSON.stringify(provider)} is incompatible.`,
    );
  }
  if (!account.subscriptionType?.trim()) {
    throw new ClaudeProviderAuthError(
      `Claude native subscription authentication could not be verified for credential source ${JSON.stringify(source)}.`,
    );
  }
  if (account.apiKeySource !== undefined &&
      account.apiKeySource !== 'none' && account.apiKeySource !== 'oauth') {
    throw new ClaudeProviderAuthError(
      `Claude native subscription authentication is required; credential source ${JSON.stringify(source)} is incompatible.`,
    );
  }
  return { apiProvider: 'firstParty' };
}

function requireClaudeInitSubscription(
  apiKeySource: unknown,
  auth: ClaudeSubscriptionAuth,
) {
  const source = typeof apiKeySource === 'string' ? apiKeySource : undefined;
  if ((source === 'none' || source === 'oauth') && auth.apiProvider === 'firstParty') return;
  throw new ClaudeProviderAuthError(
    `Claude native subscription authentication is required; credential source ${JSON.stringify(knownAuthLabel(source, CLAUDE_AUTH_SOURCE_LABELS))} is incompatible.`,
  );
}

function knownAuthLabel(value: unknown, allowed: ReadonlySet<string>) {
  if (typeof value !== 'string' || !value.trim()) return 'missing';
  return allowed.has(value) ? value : 'unknown';
}

function isMissingExecutable(error: unknown) {
  return objectValue(error)?.code === 'ENOENT' || /ENOENT|not found/iu.test(safeMessage(error));
}
