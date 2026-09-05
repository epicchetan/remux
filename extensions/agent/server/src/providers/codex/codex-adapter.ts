import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { basename } from 'node:path';

import {
  PROVIDER_RUNTIME_CONTRACT_VERSION,
  parseCompactProviderSessionInput,
  parseDiscoverProviderSessionsInput,
  parseInterruptProviderChildInput,
  parseInterruptProviderTurnInput,
  parseNativeForkRequest,
  parseOpenProviderSessionInput,
  parseProviderLoginStartInput,
  parseProviderLogoutInput,
  parseProviderEventEnvelope,
  parseProviderSnapshot,
  parseProviderSnapshotRequest,
  parseStartProviderTurnInput,
  parseSteerProviderTurnInput,
  type DiscoverProviderSessionsInput,
  type CompactProviderSessionInput,
  type NativeForkRequest,
  type NativeSessionRef,
  type NativeSessionSummary,
  type OpenProviderSessionInput,
  type ProviderAccess,
  type ProviderAccountUsage,
  type ProviderCapabilities,
  type ProviderEvent,
  type ProviderEventEnvelope,
  type ProviderModelDescriptor,
  type ProviderLoginEvent,
  type ProviderLoginStartInput,
  type ProviderLogoutInput,
  type ProviderProbe,
  type ProviderSnapshot,
  type ProviderSnapshotRequest,
  type StartProviderTurnInput,
  type SteerProviderTurnInput,
  type InterruptProviderTurnInput,
  type InterruptProviderChildInput,
  type UserContentPart,
} from '../../../../shared/provider-runtime.ts';
import type {
  ProviderAdapter,
  ProviderCommandAcceptance,
  ProviderLoginOperation,
  ProviderRuntimeStatus,
  ProviderSession,
} from '../../provider-adapter.ts';
import { AsyncEventStream, ProviderEventStream } from '../../provider-adapter.ts';
import {
  NativeSessionOwnershipRegistry,
  type NativeSessionLease,
} from '../../native-runtime/native-session-ownership.ts';
import {
  type CodexAppServerConnection,
  type CodexAppServerConnectionFactory,
  type CodexConnectionHandlers,
  type CodexServerNotification,
  type CodexServerRequest,
} from './codex-app-server-process.ts';
import { CodexRuntimeHost, type CodexRuntimeStatus } from './codex-runtime-host.ts';
import {
  CodexEventMapper,
  codexStableChildExecutionId,
  codexStableNativeTurnId,
  normalizeCodexAccountUsage,
} from './codex-event-mapper.ts';
import {
  FEDERATION_SERVER_NAME,
  FEDERATION_TOOL_TIMEOUT_MS,
} from '../../federation/constants.ts';

const ADAPTER_VERSION = 'remux-codex-app-server-v1';
const DEFAULT_INSTANCE_ID = 'codex-local';
const RESTORED_USAGE_TAIL_BYTES = 2 * 1024 * 1024;
const CODEX_SNAPSHOT_COVERAGE = {
  turnBlocks: {
    // thread/read is authoritative for native text/control items, but Codex can
    // omit completed command, web, and child activity retained by its rollout.
    completeKinds: [
      'reasoning-summary',
      'commentary',
      'final-message',
      'compatibility-notice',
    ],
  },
} as const satisfies NonNullable<ProviderSnapshot['coverage']>;

export type ResolvedCodexImage =
  | { type: 'image'; url: string }
  | { type: 'localImage'; path: string };

export type CodexNativeAdapterOptions = {
  binaryPath?: string;
  providerInstanceId?: string;
  environment?: Readonly<Record<string, string | undefined>>;
  appServerArgs?: readonly string[];
  createConnection?: CodexAppServerConnectionFactory;
  runtimeHost?: Pick<CodexRuntimeHost, 'connectionFactory' | 'readStatus'>;
  ownership?: NativeSessionOwnershipRegistry;
  resolveImageArtifact?: (artifactId: string, mimeType: string) => Promise<ResolvedCodexImage>;
  importHistoricalImage?: (dataUrl: string) => Promise<{
    artifactId: string;
    mimeType: string;
    byteLength: number;
  }>;
  now?: () => number;
};

export class CodexNativeAdapter implements ProviderAdapter {
  private readonly binaryPath: string;
  private readonly providerInstanceId: string;
  private readonly environment?: Readonly<Record<string, string | undefined>>;
  private readonly appServerArgs: readonly string[];
  private readonly createConnection: CodexAppServerConnectionFactory;
  private readonly runtimeHost?: Pick<CodexRuntimeHost, 'connectionFactory' | 'readStatus'>;
  private readonly ownership: NativeSessionOwnershipRegistry;
  private readonly resolveImageArtifact?: CodexNativeAdapterOptions['resolveImageArtifact'];
  private readonly importHistoricalImage?: CodexNativeAdapterOptions['importHistoricalImage'];
  private readonly now: () => number;

  constructor(options: CodexNativeAdapterOptions = {}) {
    this.binaryPath = options.binaryPath ?? 'codex';
    this.providerInstanceId = options.providerInstanceId ?? DEFAULT_INSTANCE_ID;
    this.environment = options.environment;
    this.appServerArgs = options.appServerArgs ?? [];
    this.now = options.now ?? Date.now;
    this.runtimeHost = options.createConnection
      ? options.runtimeHost
      : options.runtimeHost ?? new CodexRuntimeHost({
          binaryPath: this.binaryPath,
          environment: this.environment,
        });
    this.createConnection = options.createConnection ?? this.runtimeHost!.connectionFactory;
    this.ownership = options.ownership ?? new NativeSessionOwnershipRegistry(this.now);
    this.resolveImageArtifact = options.resolveImageArtifact;
    this.importHistoricalImage = options.importHistoricalImage;
  }

  async readRuntimeStatus(providerInstanceId: string): Promise<ProviderRuntimeStatus> {
    this.assertInstance(providerInstanceId);
    const status: CodexRuntimeStatus | null = await (this.runtimeHost?.readStatus() ?? Promise.resolve(null));
    const activeSessions = this.ownership.snapshot().filter((entry) =>
      entry.provider === 'codex' && entry.providerInstanceId === providerInstanceId).length;
    return {
      topology: 'shared-daemon',
      runtimeState: status?.state ?? 'unknown',
      configuredExecutable: this.binaryPath,
      resolvedExecutable: status?.managedCodexPath ?? null,
      installedVersion: status?.installedVersion ?? null,
      runningVersion: status?.runningVersion ?? null,
      adapterVersion: ADAPTER_VERSION,
      sdkVersion: null,
      restartRequired: status?.restartRequired ?? false,
      activeSessions,
      lastError: status?.lastError ?? null,
    };
  }

  async probe(providerInstanceId: string): Promise<ProviderProbe> {
    if (!this.matchesInstance(providerInstanceId)) return missingInstance(providerInstanceId);
    let connection: CodexAppServerConnection | undefined;
    try {
      const opened = await this.openConnection(process.cwd());
      connection = opened.connection;
      const account = object(await connection.request('account/read', {}));
      const version = versionFromInitialize(opened.initialize);
      if (!account?.account && account?.requiresOpenaiAuth === true) {
        return {
          state: 'signed-out',
          displayLabel: 'Codex',
          diagnosticCode: 'codex_signed_out',
          message: 'Codex is installed but its native subscription session is signed out.',
          capabilities: codexCapabilities(version),
        };
      }
      return {
        state: 'ready',
        displayLabel: 'Codex',
        capabilities: codexCapabilities(version),
      };
    } catch (error) {
      return classifyProbeError(error);
    } finally {
      await connection?.close().catch(() => undefined);
    }
  }

  async listModels(providerInstanceId: string): Promise<readonly ProviderModelDescriptor[]> {
    this.assertInstance(providerInstanceId);
    let connection: CodexAppServerConnection | undefined;
    try {
      const opened = await this.openConnection(process.cwd());
      connection = opened.connection;
      const models: ProviderModelDescriptor[] = [];
      let cursor: string | undefined;
      do {
        const response = object(await connection.request('model/list', cursor ? { cursor } : {}));
        const data = Array.isArray(response?.data) ? response.data : [];
        for (const value of data) {
          const model = object(value);
          const id = nonempty(model?.model) ?? nonempty(model?.id);
          if (!model || !id || model.hidden === true) continue;
          const effort = Array.isArray(model.supportedReasoningEfforts)
            ? model.supportedReasoningEfforts.flatMap((entry) => {
                const option = object(entry);
                const value = nonempty(option?.reasoningEffort) ?? nonempty(option?.effort);
                return value ? [value] : [];
              })
            : [];
          models.push({
            id,
            name: nonempty(model.displayName) ?? id,
            provider: 'codex',
            supportedEffort: effort,
            ...(model.isDefault === true ? { isDefault: true } : {}),
          });
        }
        cursor = nonempty(response?.nextCursor);
      } while (cursor);
      return models;
    } finally {
      await connection?.close().catch(() => undefined);
    }
  }

  async readAccountUsage(providerInstanceId: string): Promise<ProviderAccountUsage | null> {
    this.assertInstance(providerInstanceId);
    let connection: CodexAppServerConnection | undefined;
    try {
      const opened = await this.openConnection(process.cwd());
      connection = opened.connection;
      const response = await connection.request('account/rateLimits/read', undefined);
      return normalizeCodexAccountUsage(response, 'provider-read', this.now());
    } finally {
      await connection?.close().catch(() => undefined);
    }
  }

  async discoverSessions(input: DiscoverProviderSessionsInput): Promise<readonly NativeSessionSummary[]> {
    input = parseDiscoverProviderSessionsInput(input);
    this.assertInstance(input.providerInstanceId);
    let connection: CodexAppServerConnection | undefined;
    try {
      const opened = await this.openConnection(input.cwd ?? process.cwd());
      connection = opened.connection;
      const response = object(await connection.request('thread/list', {
        ...(input.cursor ? { cursor: input.cursor } : {}),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
        ...(input.cwd ? { cwd: input.cwd } : {}),
        sortKey: 'updated_at',
        sortDirection: 'desc',
      }));
      return (Array.isArray(response?.data) ? response.data : []).flatMap((value) => {
        const thread = object(value);
        const sessionId = nonempty(thread?.id);
        if (!thread || !sessionId || nonempty(thread.parentThreadId) || thread.ephemeral === true) return [];
        const historyRevision = codexHistoryRevision(thread);
        return [{
          nativeSession: {
            provider: 'codex' as const,
            providerInstanceId: input.providerInstanceId,
            sessionId,
            resumeCursor: { threadId: sessionId },
          },
          ...(nonempty(thread.name) ? { title: nonempty(thread.name)! } : {}),
          ...(nonempty(thread.preview) ? { preview: nonempty(thread.preview)! } : {}),
          ...(nonempty(thread.cwd) ? { cwd: nonempty(thread.cwd)! } : {}),
          ...(historyRevision ? { historyRevision } : {}),
          ...(unixSeconds(thread.createdAt) === undefined
            ? {}
            : { createdAt: unixSeconds(thread.createdAt)! }),
          ...(unixSeconds(thread.updatedAt) === undefined
            ? {}
            : { updatedAt: unixSeconds(thread.updatedAt)! }),
        }];
      });
    } finally {
      await connection?.close().catch(() => undefined);
    }
  }

  async startLogin(unparsed: ProviderLoginStartInput): Promise<ProviderLoginOperation> {
    const input = parseProviderLoginStartInput(unparsed);
    this.assertInstance(input.providerInstanceId);
    let operation: CodexLoginOperation | undefined;
    const pending: CodexServerNotification[] = [];
    let earlyExit: Error | undefined;
    let connection: CodexAppServerConnection | undefined;
    try {
      connection = await this.createConnection({
        binaryPath: this.binaryPath,
        cwd: process.cwd(),
        args: this.appServerArgs,
        environment: this.environment ? { ...process.env, ...this.environment } : process.env,
        handlers: {
          onNotification: (notification) => {
            if (operation) operation.handleNotification(notification);
            else pending.push(notification);
          },
          onServerRequest: rejectInteractiveServerRequest,
          onExit: (error) => {
            if (operation) operation.handleExit(error);
            else earlyExit = error;
          },
        },
      });
      await initialize(connection);
      const response = object(await connection.request('account/login/start', input.mode === 'device-code'
        ? { type: 'chatgptDeviceCode' }
        : { type: 'chatgpt', useHostedLoginSuccessPage: true }));
      const loginId = nonempty(response?.loginId);
      const verificationUri = nonempty(response?.verificationUrl) ?? nonempty(response?.authUrl);
      if (!loginId || !verificationUri) {
        throw new Error('Codex login response did not include its login ID and verification URL.');
      }
      operation = new CodexLoginOperation({
        connection,
        loginId,
        prompt: {
          type: 'prompt',
          loginId,
          verificationUri,
          ...(nonempty(response?.userCode) ? { userCode: nonempty(response?.userCode)! } : {}),
        },
      });
      if (earlyExit) operation.handleExit(earlyExit);
      else for (const notification of pending) operation.handleNotification(notification);
      return operation;
    } catch (error) {
      await connection?.close().catch(() => undefined);
      throw error;
    }
  }

  async logout(unparsed: ProviderLogoutInput): Promise<{ accepted: true }> {
    const input = parseProviderLogoutInput(unparsed);
    this.assertInstance(input.providerInstanceId);
    let connection: CodexAppServerConnection | undefined;
    try {
      const opened = await this.openConnection(process.cwd());
      connection = opened.connection;
      await connection.request('account/logout', undefined);
      return { accepted: true };
    } finally {
      await connection?.close().catch(() => undefined);
    }
  }

  async openSession(unparsed: OpenProviderSessionInput): Promise<CodexProviderSession> {
    const input = parseOpenProviderSessionInput(unparsed);
    this.assertInstance(input.providerInstanceId);
    if (input.nativeSession && input.nativeSession.provider !== 'codex') {
      throw new Error(`Codex adapter cannot open ${input.nativeSession.provider} sessions.`);
    }

    const pendingNotifications: CodexServerNotification[] = [];
    let session: CodexProviderSession | undefined;
    let earlyExit: Error | undefined;
    const handlers: CodexConnectionHandlers = {
      onNotification: (notification) => {
        if (session) session.handleNotification(notification);
        else pendingNotifications.push(notification);
      },
      onServerRequest: (request) => session
        ? session.handleServerRequest(request)
        : rejectInteractiveServerRequest(request),
      onExit: (error) => {
        if (session) session.handleExit(error);
        else earlyExit = error;
      },
    };

    const launch = codexLaunch(this.environment, this.appServerArgs);
    let connection: CodexAppServerConnection | undefined;
    let lease: NativeSessionLease | undefined;
    try {
      if (input.nativeSession) {
        lease = this.ownership.acquire({
          provider: 'codex',
          providerInstanceId: input.providerInstanceId,
          sessionId: input.nativeSession.sessionId,
          executionId: input.executionId,
        });
      }
      connection = await this.createConnection({
        binaryPath: this.binaryPath,
        cwd: input.cwd,
        args: launch.args,
        environment: launch.environment,
        handlers,
      });
      await initialize(connection);
      const accountUsage = await connection.request('account/rateLimits/read', undefined)
        .catch(() => undefined);
      const openParams = threadConfiguration(input);
      const response = object(await connection.request(
        input.mode === 'create' ? 'thread/start' : 'thread/resume',
        input.mode === 'create'
          ? openParams
          : { threadId: input.nativeSession!.sessionId, ...openParams, excludeTurns: true },
      ));
      const thread = object(response?.thread);
      const nativeSessionId = nonempty(thread?.id);
      if (!nativeSessionId) throw new Error('Codex thread open response did not include thread.id.');
      if (input.mode !== 'create' && nativeSessionId !== input.nativeSession!.sessionId) {
        throw new Error('Codex resumed a different native thread than requested.');
      }
      lease ??= this.ownership.acquire({
        provider: 'codex',
        providerInstanceId: input.providerInstanceId,
        sessionId: nativeSessionId,
        executionId: input.executionId,
      });
      session = new CodexProviderSession({
        input,
        connection,
        nativeSessionId,
        resolveImageArtifact: this.resolveImageArtifact,
        importHistoricalImage: this.importHistoricalImage,
        now: this.now,
        lease,
      });
      if (input.mode !== 'create') {
        const restoredUsage = await readPersistedCodexUsage(nonempty(thread?.path)).catch(() => undefined);
        if (restoredUsage) session.observeRestoredUsage(restoredUsage);
      }
      if (earlyExit) session.handleExit(earlyExit);
      else {
        session.bind(input.mode !== 'create');
        if (accountUsage !== undefined) session.observeAccountUsage(accountUsage);
        for (const notification of pendingNotifications) session.handleNotification(notification);
      }
      return session;
    } catch (error) {
      await connection?.close().catch(() => undefined);
      lease?.release();
      throw error;
    }
  }

  private async openConnection(cwd: string) {
    let exitError: Error | undefined;
    const connection = await this.createConnection({
      binaryPath: this.binaryPath,
      cwd,
      args: this.appServerArgs,
      environment: this.environment ? { ...process.env, ...this.environment } : process.env,
      handlers: {
        onNotification: () => undefined,
        onServerRequest: rejectInteractiveServerRequest,
        onExit: (error) => { exitError = error; },
      },
    });
    const initialized = await initialize(connection);
    if (exitError) throw exitError;
    return { connection, initialize: initialized };
  }

  private matchesInstance(value: string) {
    return value === this.providerInstanceId;
  }

  private assertInstance(value: string) {
    if (!this.matchesInstance(value)) {
      throw new Error(`Unknown Codex provider instance ${JSON.stringify(value)}.`);
    }
  }
}

class CodexLoginOperation implements ProviderLoginOperation {
  readonly loginId: string;
  readonly events: AsyncEventStream<ProviderLoginEvent>;
  private readonly connection: CodexAppServerConnection;
  private completed = false;

  constructor(options: {
    connection: CodexAppServerConnection;
    loginId: string;
    prompt: ProviderLoginEvent;
  }) {
    this.connection = options.connection;
    this.loginId = options.loginId;
    this.events = new AsyncEventStream<ProviderLoginEvent>();
    this.events.emit(options.prompt);
  }

  async cancel() {
    if (this.completed) return;
    await this.connection.request('account/login/cancel', { loginId: this.loginId });
    this.completed = true;
    this.events.emit({ type: 'completed', success: false, error: 'Sign-in canceled.' });
    this.events.close();
    await this.connection.close();
  }

  async close() {
    if (!this.completed) {
      this.completed = true;
      this.events.close();
    }
    await this.connection.close();
  }

  handleNotification(notification: CodexServerNotification) {
    if (this.completed || notification.method !== 'account/login/completed') return;
    const params = object(notification.params);
    const loginId = nonempty(params?.loginId);
    if (loginId && loginId !== this.loginId) return;
    this.completed = true;
    this.events.emit(params?.success === true
      ? { type: 'completed', success: true }
      : {
          type: 'completed',
          success: false,
          error: nonempty(params?.error) ?? 'Codex sign-in failed.',
        });
    this.events.close();
    void this.connection.close();
  }

  handleExit(error: Error) {
    if (this.completed) return;
    this.completed = true;
    this.events.fail(error);
  }
}

type CodexProviderSessionOptions = {
  input: OpenProviderSessionInput;
  connection: CodexAppServerConnection;
  nativeSessionId: string;
  resolveImageArtifact?: CodexNativeAdapterOptions['resolveImageArtifact'];
  importHistoricalImage?: CodexNativeAdapterOptions['importHistoricalImage'];
  now: () => number;
  lease: NativeSessionLease;
};

export class CodexProviderSession implements ProviderSession {
  readonly events = new ProviderEventStream();
  readonly nativeSession: NativeSessionRef;

  private readonly openedWith: OpenProviderSessionInput;
  private readonly connection: CodexAppServerConnection;
  private readonly mapper: CodexEventMapper;
  private readonly resolveImageArtifact?: CodexNativeAdapterOptions['resolveImageArtifact'];
  private readonly importHistoricalImage?: CodexNativeAdapterOptions['importHistoricalImage'];
  private readonly now: () => number;
  private readonly lease: NativeSessionLease;
  private readonly receipts = new Map<string, { hash: string; result: Promise<unknown> }>();
  private readonly eventLog = new Map<string, ProviderEventEnvelope>();
  private readonly nativeTurnByRemux = new Map<string, string>();
  private readonly completedNativeTurns = new Set<string>();
  private readonly childThreadIds = new Set<string>();
  private readonly forkThreadIds = new Set<string>();
  private readonly activeChildTurnByThread = new Map<string, string>();
  private readonly childMappers = new Map<string, CodexEventMapper>();
  private pendingForkNotifications: CodexServerNotification[] | undefined;
  private mutationTail: Promise<unknown> = Promise.resolve();
  private activeTurn: { remuxTurnId: string; nativeTurnId?: string } | undefined;
  private restoredUsage: unknown;
  private lost = false;
  private closed = false;

  constructor(options: CodexProviderSessionOptions) {
    this.openedWith = options.input;
    this.connection = options.connection;
    this.resolveImageArtifact = options.resolveImageArtifact;
    this.importHistoricalImage = options.importHistoricalImage;
    this.now = options.now;
    this.lease = options.lease;
    this.nativeSession = {
      provider: 'codex',
      providerInstanceId: options.input.providerInstanceId,
      sessionId: options.nativeSessionId,
      resumeCursor: { threadId: options.nativeSessionId },
    };
    this.mapper = new CodexEventMapper({
      providerInstanceId: options.input.providerInstanceId,
      conversationId: options.input.conversationId,
      executionId: options.input.executionId,
      nativeSessionId: options.nativeSessionId,
      inheritedNativeTurnIds: options.input.inheritedNativeTurnIds,
      observedAt: options.now,
    });
    for (const binding of options.input.nativeTurnBindings ?? []) {
      this.mapper.bindTurn(binding.turnId, binding.nativeTurnId, binding.nextBlockOrdinal);
      this.nativeTurnByRemux.set(binding.turnId, binding.nativeTurnId);
    }
  }

  bind(resumed: boolean) {
    this.emitSynthetic({ type: 'session.bound', resumed }, 'session/bound');
    this.emitSynthetic({ type: 'session.materialized' }, 'session/materialized');
    this.emitSynthetic({ type: 'session.health', state: 'ready' }, 'session/health/ready');
  }

  async startTurn(unparsed: StartProviderTurnInput): Promise<ProviderCommandAcceptance> {
    const input = parseStartProviderTurnInput(unparsed);
    this.assertTurnScope(input);
    return this.onceCommand(input.commandId, input, async () => this.mutate(async () => {
      this.assertOpen();
      if (this.activeTurn) throw new Error('Codex provider session already has an active turn.');
      const providerInput = await mapUserContent(input.content, this.resolveImageArtifact);
      this.activeTurn = { remuxTurnId: input.turnId };
      this.mapper.expectTurn(input.turnId);
      try {
        const response = object(await this.connection.request('turn/start', {
          threadId: this.nativeSession.sessionId,
          clientUserMessageId: input.turnId,
          input: providerInput,
          approvalPolicy: 'never',
          ...(input.model ? { model: input.model } : {}),
          ...(input.effort ? { effort: input.effort } : {}),
        }));
        const turn = object(response?.turn);
        const nativeTurnId = nonempty(turn?.id);
        if (!nativeTurnId) throw new Error('Codex turn/start response did not include turn.id.');
        this.mapper.bindTurn(input.turnId, nativeTurnId);
        this.nativeTurnByRemux.set(input.turnId, nativeTurnId);
        if (!this.completedNativeTurns.has(nativeTurnId)) {
          this.activeTurn = { remuxTurnId: input.turnId, nativeTurnId };
        }
        return { accepted: true, nativeTurnId } as const;
      } catch (error) {
        this.activeTurn = undefined;
        throw error;
      }
    })) as Promise<ProviderCommandAcceptance>;
  }

  async steer(unparsed: SteerProviderTurnInput): Promise<ProviderCommandAcceptance> {
    const input = parseSteerProviderTurnInput(unparsed);
    return this.onceCommand(input.commandId, input, async () => this.mutate(async () => {
      this.assertOpen();
      const nativeTurnId = this.activeTurn?.remuxTurnId === input.turnId
        ? this.activeTurn.nativeTurnId
        : undefined;
      if (!nativeTurnId) throw new Error('Cannot steer a turn before Codex has bound its native turn ID.');
      const providerInput = await mapUserContent(input.content, this.resolveImageArtifact);
      await this.connection.request('turn/steer', {
        threadId: this.nativeSession.sessionId,
        expectedTurnId: nativeTurnId,
        input: providerInput,
      });
      return { accepted: true } as const;
    })) as Promise<ProviderCommandAcceptance>;
  }

  async interrupt(unparsed: InterruptProviderTurnInput): Promise<ProviderCommandAcceptance> {
    const input = parseInterruptProviderTurnInput(unparsed);
    return this.onceCommand(input.commandId, input, async () => this.mutate(async () => {
      this.assertOpen();
      const nativeTurnId = this.activeTurn?.remuxTurnId === input.turnId
        ? this.activeTurn.nativeTurnId
        : undefined;
      if (!nativeTurnId) throw new Error('Cannot interrupt a turn before Codex has bound its native turn ID.');
      const childTurns = [...this.activeChildTurnByThread.entries()].slice(0, 32);
      await Promise.allSettled(childTurns.map(([threadId, turnId]) =>
        this.connection.request('turn/interrupt', { threadId, turnId }, 3_000)));
      await this.connection.request('turn/interrupt', {
        threadId: this.nativeSession.sessionId,
        turnId: nativeTurnId,
      });
      return { accepted: true } as const;
    })) as Promise<ProviderCommandAcceptance>;
  }

  async interruptChild(unparsed: InterruptProviderChildInput): Promise<ProviderCommandAcceptance> {
    const input = parseInterruptProviderChildInput(unparsed);
    const expectedExecutionId = codexStableChildExecutionId(
      this.openedWith.executionId,
      input.nativeSessionId,
    );
    if (input.childExecutionId !== expectedExecutionId) {
      throw new Error('Codex child interruption does not match the opened parent session.');
    }
    return this.onceCommand(input.commandId, input, async () => this.mutate(async () => {
      this.assertOpen();
      let nativeTurnId = this.activeChildTurnByThread.get(input.nativeSessionId);
      if (!nativeTurnId) {
        const response = object(await this.connection.request('thread/read', {
          threadId: input.nativeSessionId,
          includeTurns: true,
        }));
        const thread = object(response?.thread);
        const turns = Array.isArray(thread?.turns) ? thread.turns : [];
        nativeTurnId = turns.flatMap((value) => {
          const turn = object(value);
          return nonempty(turn?.status) === 'inProgress' && nonempty(turn?.id)
            ? [nonempty(turn?.id)!]
            : [];
        }).at(-1);
      }
      if (!nativeTurnId) throw new Error('Codex child has no active turn to interrupt.');
      await this.connection.request('turn/interrupt', {
        threadId: input.nativeSessionId,
        turnId: nativeTurnId,
      });
      return { accepted: true } as const;
    })) as Promise<ProviderCommandAcceptance>;
  }

  async compact(unparsed: CompactProviderSessionInput): Promise<ProviderCommandAcceptance & {
    nativeOperationId?: string;
  }> {
    const input = parseCompactProviderSessionInput(unparsed);
    if (input.conversationId !== this.openedWith.conversationId ||
        input.executionId !== this.openedWith.executionId) {
      throw new Error('Compact request does not match the opened Codex session.');
    }
    return this.onceCommand(input.commandId, input, async () => this.mutate(async () => {
      this.assertOpen();
      if (this.activeTurn) throw new Error('Codex provider session is busy.');
      this.mapper.expectManualCompaction(input.commandId);
      try {
        await this.connection.request('thread/compact/start', {
          threadId: this.nativeSession.sessionId,
        });
        return { accepted: true as const, nativeOperationId: input.commandId };
      } catch (error) {
        this.mapper.clearManualCompaction(input.commandId);
        throw error;
      }
    })) as Promise<ProviderCommandAcceptance & { nativeOperationId?: string }>;
  }

  async snapshot(unparsed: ProviderSnapshotRequest): Promise<ProviderSnapshot> {
    parseProviderSnapshotRequest(unparsed);
    this.assertOpenOrLost();
    if (this.lost) {
      return parseProviderSnapshot({
        contractVersion: PROVIDER_RUNTIME_CONTRACT_VERSION,
        nativeSession: this.nativeSession,
        state: 'lost',
        authority: 'session-local',
        events: [...this.eventLog.values()],
      });
    }
    const response = object(await this.connection.request('thread/read', {
      threadId: this.nativeSession.sessionId,
      includeTurns: true,
    }));
    const thread = object(response?.thread);
    if (!thread || nonempty(thread.id) !== this.nativeSession.sessionId) {
      throw new Error('Codex thread/read returned a different native thread.');
    }
    await materializeHistoricalImages(thread, this.importHistoricalImage);
    const authoritative = this.mapper.mapThreadSnapshot(thread);
    this.emitRestoredUsage();
    const events = new Map(this.eventLog);
    for (const event of authoritative) events.set(event.eventId, event);
    const status = nonempty(object(thread.status)?.type);
    const historyRevision = codexHistoryRevision(thread);
    return parseProviderSnapshot({
      contractVersion: PROVIDER_RUNTIME_CONTRACT_VERSION,
      nativeSession: this.nativeSession,
      state: status === 'active' ? 'running' : 'idle',
      authority: 'authoritative',
      coverage: CODEX_SNAPSHOT_COVERAGE,
      ...(historyRevision ? { historyRevision } : {}),
      events: [...events.values()],
    });
  }

  async snapshotChild(
    unparsed: ProviderSnapshotRequest & { childExecutionId: string; nativeSessionId: string },
  ): Promise<ProviderSnapshot> {
    parseProviderSnapshotRequest({
      commandId: unparsed.commandId,
      ...(unparsed.afterNativeSequence === undefined
        ? {}
        : { afterNativeSequence: unparsed.afterNativeSequence }),
    });
    this.assertOpenOrLost();
    const expectedExecutionId = codexStableChildExecutionId(
      this.openedWith.executionId,
      unparsed.nativeSessionId,
    );
    if (unparsed.childExecutionId !== expectedExecutionId) {
      throw new Error('Codex child snapshot does not match the opened parent session.');
    }
    const response = object(await this.connection.request('thread/read', {
      threadId: unparsed.nativeSessionId,
      includeTurns: true,
    }));
    const thread = object(response?.thread);
    if (!thread || nonempty(thread.id) !== unparsed.nativeSessionId) {
      throw new Error('Codex child thread/read returned a different native thread.');
    }
    await materializeHistoricalImages(thread, this.importHistoricalImage);
    const mapper = this.childMapper(unparsed.nativeSessionId);
    const events = mapper.mapThreadSnapshot(thread);
    const status = nonempty(object(thread.status)?.type);
    return parseProviderSnapshot({
      contractVersion: PROVIDER_RUNTIME_CONTRACT_VERSION,
      nativeSession: {
        provider: 'codex',
        providerInstanceId: this.nativeSession.providerInstanceId,
        sessionId: unparsed.nativeSessionId,
        resumeCursor: { threadId: unparsed.nativeSessionId },
      },
      state: status === 'active' ? 'running' : 'idle',
      authority: 'authoritative',
      coverage: CODEX_SNAPSHOT_COVERAGE,
      events,
    });
  }

  async readHistoryRevision(): Promise<string | null> {
    this.assertOpenOrLost();
    if (this.lost) return null;
    const response = object(await this.connection.request('thread/read', {
      threadId: this.nativeSession.sessionId,
      includeTurns: false,
    }));
    const thread = object(response?.thread);
    if (!thread || nonempty(thread.id) !== this.nativeSession.sessionId) {
      throw new Error('Codex history revision read returned a different native thread.');
    }
    return codexHistoryRevision(thread) ?? null;
  }

  async fork(unparsed: NativeForkRequest): Promise<NativeSessionRef> {
    const input = parseNativeForkRequest(unparsed);
    return this.onceCommand(input.commandId, input, async () => this.mutate(async () => {
      this.assertOpen();
      this.pendingForkNotifications = [];
      try {
        const response = object(await this.connection.request('thread/fork', {
          threadId: this.nativeSession.sessionId,
          ...(input.beforeNativeTurnId ? { beforeTurnId: input.beforeNativeTurnId } : {}),
          ...(input.throughNativeTurnId ? { lastTurnId: input.throughNativeTurnId } : {}),
          deferGoalContinuation: true,
          ...threadConfiguration(this.openedWith),
          excludeTurns: true,
        }));
        const thread = object(response?.thread);
        const sessionId = nonempty(thread?.id);
        if (!sessionId || sessionId === this.nativeSession.sessionId) {
          throw new Error('Codex thread/fork did not return a new native thread ID.');
        }
        this.forkThreadIds.add(sessionId);
        const pending = this.pendingForkNotifications;
        this.pendingForkNotifications = undefined;
        for (const notification of pending ?? []) {
          if (threadIdFromNotification(notification) !== sessionId) this.handleNotification(notification);
        }
        return {
          provider: 'codex' as const,
          providerInstanceId: this.nativeSession.providerInstanceId,
          sessionId,
          resumeCursor: { threadId: sessionId },
        };
      } catch (error) {
        const pending = this.pendingForkNotifications;
        this.pendingForkNotifications = undefined;
        for (const notification of pending ?? []) this.handleNotification(notification);
        throw error;
      }
    })) as Promise<NativeSessionRef>;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.connection.close();
      this.events.close();
    } finally {
      this.lease.release();
    }
  }

  handleNotification(notification: CodexServerNotification) {
    if (this.closed) return;
    const params = object(notification.params);
    const notificationThreadId = notification.method === 'thread/started'
      ? nonempty(object(params?.thread)?.id)
      : nonempty(params?.threadId);
    if (notificationThreadId && notificationThreadId !== this.nativeSession.sessionId) {
      if (this.forkThreadIds.has(notificationThreadId)) return;
      if (this.pendingForkNotifications) {
        this.pendingForkNotifications.push(notification);
        return;
      }
    }
    if (notificationThreadId && notificationThreadId !== this.nativeSession.sessionId) {
      this.childThreadIds.add(notificationThreadId);
      if (notification.method === 'turn/started') {
        const nativeChildTurnId = nonempty(object(params?.turn)?.id);
        if (nativeChildTurnId) this.activeChildTurnByThread.set(notificationThreadId, nativeChildTurnId);
      } else if (notification.method === 'turn/completed') {
        const nativeChildTurnId = nonempty(object(params?.turn)?.id);
        if (this.activeChildTurnByThread.get(notificationThreadId) === nativeChildTurnId) {
          this.activeChildTurnByThread.delete(notificationThreadId);
        }
      }
    }
    if (notification.method === 'item/completed' || notification.method === 'item/started') {
      const item = object(params?.item);
      if (item?.type === 'subAgentActivity') {
        const childThreadId = nonempty(item.agentThreadId);
        if (childThreadId) this.childThreadIds.add(childThreadId);
      }
    }
    if (notification.method === 'turn/started'
      && notificationThreadId === this.nativeSession.sessionId) {
      const nativeTurnId = nonempty(object(params?.turn)?.id);
      if (nativeTurnId && this.activeTurn) {
        this.nativeTurnByRemux.set(this.activeTurn.remuxTurnId, nativeTurnId);
        this.activeTurn.nativeTurnId = nativeTurnId;
      }
    }
    let events: ProviderEventEnvelope[] = [];
    try {
      events = this.mapper.mapNotification(notification);
      if (notificationThreadId && notificationThreadId !== this.nativeSession.sessionId) {
        const childMapper = this.childMapper(notificationThreadId);
        if (notification.method === 'turn/started') {
          const nativeChildTurnId = nonempty(object(params?.turn)?.id);
          if (nativeChildTurnId) childMapper.expectTurn(codexStableNativeTurnId(nativeChildTurnId));
        }
        events.push(...childMapper.mapNotification(notification));
      }
    } catch (error) {
      this.reportProjectionError(notification.method, error);
    }
    for (const event of events) this.emit(event);
    if (notification.method === 'turn/completed'
      && notificationThreadId === this.nativeSession.sessionId) {
      const nativeTurnId = nonempty(object(params?.turn)?.id);
      if (nativeTurnId) {
        this.completedNativeTurns.add(nativeTurnId);
        if (this.activeTurn?.nativeTurnId === nativeTurnId) this.activeTurn = undefined;
      }
    }
  }

  private childMapper(nativeSessionId: string) {
    let mapper = this.childMappers.get(nativeSessionId);
    if (!mapper) {
      mapper = new CodexEventMapper({
        providerInstanceId: this.nativeSession.providerInstanceId,
        conversationId: this.openedWith.conversationId,
        executionId: codexStableChildExecutionId(this.openedWith.executionId, nativeSessionId),
        nativeSessionId,
        observedAt: this.now,
      });
      this.childMappers.set(nativeSessionId, mapper);
    }
    return mapper;
  }

  private reportProjectionError(nativeKind: string, error: unknown) {
    try {
      process.stderr.write(`[agent-runtime] ${JSON.stringify({
        stage: 'provider.event-projection',
        status: 'failed',
        provider: 'codex',
        providerInstanceId: this.nativeSession.providerInstanceId,
        nativeSessionId: this.nativeSession.sessionId,
        nativeKind,
        error: safeMessage(error),
      })}\n`);
    } catch {
      // Projection diagnostics can never affect the provider session.
    }
  }

  observeAccountUsage(value: unknown) {
    for (const event of this.mapper.mapAccountUsage(value, 'provider-read')) this.emit(event);
  }

  observeRestoredUsage(tokenUsage: unknown) {
    this.restoredUsage = tokenUsage;
    this.emitRestoredUsage();
  }

  private emitRestoredUsage() {
    if (this.restoredUsage === undefined) return;
    const events = this.mapper.mapNotification({
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: this.nativeSession.sessionId,
        tokenUsage: this.restoredUsage,
        remuxFreshness: 'cached',
      },
    });
    if (events.length === 0) return;
    this.restoredUsage = undefined;
    for (const event of events) this.emit(event);
  }

  async handleServerRequest(request: CodexServerRequest) {
    const response = await rejectInteractiveServerRequest(request);
    const message = request.method === 'item/tool/requestUserInput'
      ? 'Codex attempted structured user input; Remux uses ordinary chat follow-ups.'
      : `Codex requested unsupported interactive behavior (${request.method}).`;
    this.emitSynthetic({
      type: 'compatibility.notice',
      code: 'interactive_request_rejected',
      message,
    }, `server-request/${request.method}`);
    return response;
  }

  handleExit(error: Error) {
    if (this.closed || this.lost) return;
    this.lost = true;
    this.emitSynthetic({
      type: 'session.health',
      state: 'recovering',
      message: error.message,
    }, 'session/health/recovering');
    this.events.fail(error);
  }

  private assertTurnScope(input: StartProviderTurnInput) {
    if (input.conversationId !== this.openedWith.conversationId) {
      throw new Error('Turn conversation does not match the opened Codex session.');
    }
    if (input.executionId !== this.openedWith.executionId) {
      throw new Error('Turn execution does not match the opened Codex session.');
    }
  }

  private emit(event: ProviderEventEnvelope) {
    if (this.eventLog.has(event.eventId)) return;
    this.eventLog.set(event.eventId, event);
    this.events.emit(event);
  }

  private emitSynthetic(event: ProviderEvent, kind: string) {
    this.emit(parseProviderEventEnvelope({
      contractVersion: PROVIDER_RUNTIME_CONTRACT_VERSION,
      eventId: `codex-event-${digest(`${this.nativeSession.sessionId}\0${kind}\0${JSON.stringify(event)}`)}`,
      provider: 'codex',
      scope: {
        kind: 'conversation',
        providerInstanceId: this.nativeSession.providerInstanceId,
        conversationId: this.openedWith.conversationId,
        executionId: this.openedWith.executionId,
      },
      native: { sessionId: this.nativeSession.sessionId, kind },
      observedAt: this.now(),
      event,
    }));
  }

  private onceCommand<T>(commandId: string, input: unknown, run: () => Promise<T>): Promise<T> {
    const hash = digest(JSON.stringify(input));
    const previous = this.receipts.get(commandId);
    if (previous) {
      if (previous.hash !== hash) {
        return Promise.reject(new Error('Provider command ID was reused with different input.'));
      }
      return previous.result as Promise<T>;
    }
    const result = run();
    this.receipts.set(commandId, { hash, result });
    return result;
  }

  private mutate<T>(run: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(run, run);
    this.mutationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async nativeTurnBefore(targetNativeTurnId: string) {
    const response = object(await this.connection.request('thread/read', {
      threadId: this.nativeSession.sessionId,
      includeTurns: true,
    }));
    const thread = object(response?.thread);
    const turns = Array.isArray(thread?.turns) ? thread.turns : [];
    const targetIndex = turns.findIndex((value) => nonempty(object(value)?.id) === targetNativeTurnId);
    if (targetIndex < 0) throw new Error('Codex edit target is not present in the native thread.');
    if (targetIndex === 0) {
      throw new Error('Codex cannot create a native fork before the first turn.');
    }
    return nonempty(object(turns[targetIndex - 1])?.id);
  }

  private assertOpen() {
    if (this.closed) throw new Error('Codex provider session is closed.');
    if (this.lost) throw new Error('Codex provider session transport is lost.');
  }

  private assertOpenOrLost() {
    if (this.closed) throw new Error('Codex provider session is closed.');
  }
}

async function initialize(connection: CodexAppServerConnection) {
  const response = await connection.request('initialize', {
    clientInfo: { name: 'remux_agent', title: 'Remux Agent', version: '1' },
    capabilities: { experimentalApi: true },
  });
  connection.notify('initialized', undefined);
  return response;
}

function threadConfiguration(input: OpenProviderSessionInput) {
  return {
    cwd: input.cwd,
    model: input.model,
    approvalPolicy: 'never',
    sandbox: sandboxMode(input.access),
    ...(input.federation ? {
      config: {
        [`mcp_servers.${FEDERATION_SERVER_NAME}.url`]: input.federation.endpoint,
        [`mcp_servers.${FEDERATION_SERVER_NAME}.http_headers`]: {
          Authorization: input.federation.authorizationHeader,
        },
        // The bearer already scopes this private server to the active native
        // session, caller turn, provider boundary, access ceiling, and fixed
        // tool set. Remux is chat-only, so do not surface Codex's separate MCP
        // approval prompt for these coordinator-controlled calls.
        [`mcp_servers.${FEDERATION_SERVER_NAME}.default_tools_approval_mode`]: 'approve',
        [`mcp_servers.${FEDERATION_SERVER_NAME}.tool_timeout_sec`]:
          Math.ceil(FEDERATION_TOOL_TIMEOUT_MS / 1_000),
      },
    } : {}),
    ...(input.developerInstructions.length > 0
      ? { developerInstructions: input.developerInstructions.join('\n\n') }
      : {}),
  };
}

function sandboxMode(access: ProviderAccess) {
  if (access === 'read-only') return 'read-only';
  if (access === 'workspace-write') return 'workspace-write';
  return 'danger-full-access';
}

async function mapUserContent(
  content: readonly UserContentPart[],
  resolveImageArtifact?: CodexNativeAdapterOptions['resolveImageArtifact'],
) {
  const mapped: unknown[] = [];
  for (const part of content) {
    if (part.type === 'text') {
      mapped.push({ type: 'text', text: part.text, text_elements: [] });
    } else if (part.type === 'file-reference') {
      mapped.push({ type: 'mention', name: basename(part.path), path: part.path });
    } else {
      if (!resolveImageArtifact) {
        throw new Error('Codex image input requires a server-side artifact resolver.');
      }
      mapped.push(await resolveImageArtifact(part.artifactId, part.mimeType));
    }
  }
  return mapped;
}

async function materializeHistoricalImages(
  thread: Record<string, unknown>,
  importImage: CodexNativeAdapterOptions['importHistoricalImage'],
) {
  if (!importImage || !Array.isArray(thread.turns)) return;
  for (const turnValue of thread.turns) {
    const turn = object(turnValue);
    if (!turn || !Array.isArray(turn.items)) continue;
    for (const itemValue of turn.items) {
      const item = object(itemValue);
      if (item?.type !== 'userMessage' || !Array.isArray(item.content)) continue;
      for (let index = 0; index < item.content.length; index += 1) {
        const content = object(item.content[index]);
        const dataUrl = content?.type === 'image' ? nonempty(content.url) : undefined;
        if (!dataUrl?.startsWith('data:image/')) continue;
        try {
          item.content[index] = {
            type: 'remuxImageArtifact',
            ...await importImage(dataUrl),
          };
        } catch {
          // The semantic mapper emits a bounded attachment placeholder when a
          // historical provider image cannot be imported. Never re-embed its
          // potentially multi-megabyte data URL in the event contract.
        }
      }
    }
  }
}

async function readPersistedCodexUsage(path: string | undefined) {
  if (!path) return undefined;
  const file = await open(path, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size <= 0) return undefined;
    const length = Math.min(stat.size, RESTORED_USAGE_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await file.read(buffer, 0, length, stat.size - length);
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index]?.trim();
      if (!line) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      const root = object(value);
      const payload = object(root?.payload);
      const info = object(payload?.info);
      const total = object(info?.total_token_usage);
      const last = object(info?.last_token_usage);
      if (root?.type !== 'event_msg' || payload?.type !== 'token_count' || !total || !last) continue;
      return {
        total: persistedTokenBreakdown(total),
        last: persistedTokenBreakdown(last),
        modelContextWindow: storedNumber(info?.model_context_window),
      };
    }
    return undefined;
  } finally {
    await file.close();
  }
}

function persistedTokenBreakdown(value: Record<string, unknown>) {
  return {
    inputTokens: storedNumber(value.input_tokens),
    cachedInputTokens: storedNumber(value.cached_input_tokens),
    outputTokens: storedNumber(value.output_tokens),
    reasoningOutputTokens: storedNumber(value.reasoning_output_tokens),
    totalTokens: storedNumber(value.total_tokens),
  };
}

function storedNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function codexLaunch(
  configuredEnvironment: Readonly<Record<string, string | undefined>> | undefined,
  configuredArgs: readonly string[],
) {
  const environment = configuredEnvironment
    ? { ...process.env, ...configuredEnvironment }
    : { ...process.env };
  // Federation auth belongs only in thread-local MCP transport config. Strip
  // a stale ambient value as well so a host/service misconfiguration cannot
  // make it visible to model-launched shell commands.
  delete environment.REMUX_FEDERATION_MCP_BEARER_TOKEN;
  const args = [...configuredArgs];
  return { args, environment };
}

async function rejectInteractiveServerRequest(request: CodexServerRequest): Promise<unknown> {
  switch (request.method) {
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
    case 'execCommandApproval':
    case 'applyPatchApproval':
      return { decision: 'decline' };
    case 'item/tool/requestUserInput':
      return { answers: {} };
    case 'item/permissions/requestApproval':
      return { permissions: {}, scope: 'turn', strictAutoReview: true };
    case 'mcpServer/elicitation/request':
      return { action: 'decline', content: null, _meta: null };
    case 'currentTime/read':
      return { currentTimeAt: Math.floor(Date.now() / 1_000) };
    default:
      throw new Error(`Remux does not support Codex server request ${request.method}.`);
  }
}

function codexCapabilities(providerVersion: string): ProviderCapabilities {
  return {
    protocolVersion: PROVIDER_RUNTIME_CONTRACT_VERSION,
    provider: 'codex',
    providerVersion,
    adapterVersion: ADAPTER_VERSION,
    auth: 'native-subscription',
    authentication: { login: 'device-code', logout: true },
    session: {
      create: true,
      resume: true,
      discoverHistory: true,
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
      steer: true,
      queue: false,
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
      childTranscript: 'full',
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
      estimatedCost: false,
    },
    compaction: { automaticNative: true, manualNative: true },
  };
}

function versionFromInitialize(value: unknown) {
  const userAgent = nonempty(object(value)?.userAgent);
  return userAgent?.match(/\/([^\s]+)/u)?.[1] ?? 'unknown';
}

function missingInstance(providerInstanceId: string): ProviderProbe {
  return {
    state: 'missing',
    displayLabel: 'Codex',
    diagnosticCode: 'codex_instance_missing',
    message: `Codex provider instance ${JSON.stringify(providerInstanceId)} is not configured.`,
  };
}

function classifyProbeError(error: unknown): ProviderProbe {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (lower.includes('enoent') || lower.includes('not found')) {
    return {
      state: 'missing',
      displayLabel: 'Codex',
      diagnosticCode: 'codex_cli_missing',
      message: 'Codex Agent CLI is not installed or cannot be executed.',
    };
  }
  return {
    state: lower.includes('method not found') || lower.includes('initialize')
      ? 'incompatible'
      : 'error',
    displayLabel: 'Codex',
    diagnosticCode: 'codex_probe_failed',
    message,
  };
}

function safeMessage(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function nonempty(value: unknown) {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function threadIdFromNotification(notification: CodexServerNotification) {
  const params = object(notification.params);
  return notification.method === 'thread/started'
    ? nonempty(object(params?.thread)?.id)
    : nonempty(params?.threadId);
}

function unixSeconds(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value * 1_000)
    : undefined;
}

function codexHistoryRevision(thread: Record<string, unknown>) {
  const updatedAt = unixSeconds(thread.updatedAt);
  return updatedAt === undefined ? undefined : `updated-at:${updatedAt}`;
}

function digest(value: string) {
  return createHash('sha256').update(value).digest('hex');
}
