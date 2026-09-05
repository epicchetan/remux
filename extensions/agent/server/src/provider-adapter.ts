import type {
  CompactProviderSessionInput,
  DiscoverProviderSessionsInput,
  InterruptProviderTurnInput,
  InterruptProviderChildInput,
  NativeForkRequest,
  NativeRollbackRequest,
  NativeSessionRef,
  NativeSessionSummary,
  OpenProviderSessionInput,
  ProviderEventEnvelope,
  ProviderAccountUsage,
  ProviderModelDescriptor,
  ProviderLoginEvent,
  ProviderLoginStartInput,
  ProviderLogoutInput,
  ProviderProbe,
  ProviderSnapshot,
  ProviderSnapshotRequest,
  ProviderKind,
  ProviderProbeState,
  StartProviderTurnInput,
  SteerProviderTurnInput,
} from '../../shared/provider-runtime.ts';
import type { DispatchBoundary, ProviderDispatchResult, ProviderPresenceRead } from './native-runtime/delivery-contract.ts';

export type ProviderCommandAcceptance = { accepted: true; nativeTurnId?: string };

export type ProviderRuntimeTopology = 'shared-daemon' | 'session-process' | 'fixture';

export type ProviderRuntimeStatus = {
  topology: ProviderRuntimeTopology;
  runtimeState: 'running' | 'idle' | 'stopped' | 'starting' | 'stopping' | 'failed' | 'unknown';
  configuredExecutable: string | null;
  resolvedExecutable: string | null;
  installedVersion: string | null;
  runningVersion: string | null;
  adapterVersion: string | null;
  sdkVersion: string | null;
  restartRequired: boolean;
  activeSessions: number;
  lastError: string | null;
};

export type ProviderRuntimeView = ProviderRuntimeStatus & {
  provider: ProviderKind;
  providerInstanceId: string;
  label: string;
  readiness: ProviderProbeState;
  readinessMessage: string | null;
};

/**
 * The provider-native boundary. Implementations control a native harness;
 * they do not provide a replacement model/tool loop.
 */
export interface ProviderAdapter {
  probe(providerInstanceId: string): Promise<ProviderProbe>;
  listModels(providerInstanceId: string): Promise<readonly ProviderModelDescriptor[]>;
  /**
   * Reads account-scoped subscription usage without requiring a conversation
   * session. Implementations must return normalized provider data and may
   * return null when their native harness does not expose plan usage.
   */
  readAccountUsage?(providerInstanceId: string): Promise<ProviderAccountUsage | null>;
  readRuntimeStatus?(providerInstanceId: string): Promise<ProviderRuntimeStatus>;
  readTurnPresence?(input: { providerInstanceId: string; cwd: string;
    nativeSessionId: string; nativeClientMessageId: string }): Promise<ProviderPresenceRead>;
  discoverSessions?(
    input: DiscoverProviderSessionsInput,
  ): Promise<readonly NativeSessionSummary[]>;
  startLogin?(input: ProviderLoginStartInput): Promise<ProviderLoginOperation>;
  logout?(input: ProviderLogoutInput): Promise<{ accepted: true }>;
  openSession(input: OpenProviderSessionInput): Promise<ProviderSession>;
}

export interface ProviderLoginOperation {
  readonly loginId: string;
  readonly events: AsyncIterable<ProviderLoginEvent>;
  cancel(): Promise<void>;
  close(): Promise<void>;
}

export interface ProviderSession {
  readonly nativeSession: NativeSessionRef;
  readonly events: AsyncIterable<ProviderEventEnvelope>;

  startTurn(input: StartProviderTurnInput, boundary?: DispatchBoundary): Promise<ProviderDispatchResult>;
  readTurnPresence?(nativeClientMessageId: string): Promise<ProviderPresenceRead>;
  steer?(input: SteerProviderTurnInput): Promise<ProviderCommandAcceptance>;
  interrupt(input: InterruptProviderTurnInput): Promise<ProviderCommandAcceptance>;
  interruptChild?(input: InterruptProviderChildInput): Promise<ProviderCommandAcceptance>;
  snapshotChild?(
    input: ProviderSnapshotRequest & { childExecutionId: string; nativeSessionId: string },
  ): Promise<ProviderSnapshot>;
  compact?(input: CompactProviderSessionInput): Promise<ProviderCommandAcceptance & {
    nativeOperationId?: string;
  }>;
  /**
   * Cheap provider-native freshness probe. Returning null means the adapter
   * cannot prove that its transcript is unchanged and the coordinator must
   * take a snapshot when freshness is required.
   */
  readHistoryRevision?(): Promise<string | null>;
  snapshot(input: ProviderSnapshotRequest): Promise<ProviderSnapshot>;
  fork?(input: NativeForkRequest): Promise<NativeSessionRef>;
  rollback?(input: NativeRollbackRequest): Promise<NativeSessionRef>;
  close(): Promise<void>;
}

export class ProviderCapabilityError extends Error {
  readonly code = 'capability_unavailable';

  constructor(capability: string) {
    super(`Provider session does not support ${capability}.`);
    this.name = 'ProviderCapabilityError';
  }
}

/** A small abort-safe event stream used by fixtures and adapter translations. */
export class AsyncEventStream<T> implements AsyncIterable<T> {
  private readonly buffered: T[] = [];
  private readonly readers: Array<{
    resolve: (result: IteratorResult<T>) => void;
    reject: (reason: unknown) => void;
  }> = [];
  private terminal: { error?: unknown } | null = null;

  emit(event: T) {
    if (this.terminal) throw new Error('Cannot emit after provider event stream closed.');
    const reader = this.readers.shift();
    if (reader) reader.resolve({ done: false, value: event });
    else this.buffered.push(event);
  }

  close() {
    if (this.terminal) return;
    this.terminal = {};
    for (const reader of this.readers.splice(0)) reader.resolve({ done: true, value: undefined });
  }

  fail(error: unknown) {
    if (this.terminal) return;
    this.terminal = { error };
    for (const reader of this.readers.splice(0)) reader.reject(error);
  }

  /**
   * Drain events that are already waiting without blocking for another one.
   * The coordinator uses this to commit provider bursts in one durable SQLite
   * transaction while preserving the exact provider order.
   */
  drainBuffered(limit: number): T[] {
    if (!Number.isSafeInteger(limit) || limit < 0) {
      throw new Error('Buffered event drain limit must be a non-negative safe integer.');
    }
    return this.buffered.splice(0, Math.min(limit, this.buffered.length));
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const buffered = this.buffered.shift();
        if (buffered) return Promise.resolve({ done: false, value: buffered });
        if (this.terminal) {
          return this.terminal.error === undefined
            ? Promise.resolve({ done: true, value: undefined })
            : Promise.reject(this.terminal.error);
        }
        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.readers.push({ resolve, reject });
        });
      },
      return: async () => ({ done: true, value: undefined }),
    };
  }
}

export class ProviderEventStream extends AsyncEventStream<ProviderEventEnvelope> {}
