import { createHash, randomUUID } from 'node:crypto';

import {
  PROVIDER_RUNTIME_CONTRACT_VERSION,
  parseCompactProviderSessionInput,
  parseInterruptProviderChildInput,
  parseNativeForkRequest,
  parseOpenProviderSessionInput,
  parseProviderEventEnvelope,
  parseStartProviderTurnInput,
  type CompactProviderSessionInput,
  type InterruptProviderTurnInput,
  type InterruptProviderChildInput,
  type NativeSessionRef,
  type NativeForkRequest,
  type OpenProviderSessionInput,
  type ProviderCapabilities,
  type ProviderEvent,
  type ProviderEventEnvelope,
  type ProviderFileChange,
  type ProviderModelDescriptor,
  type ProviderProbe,
  type ProviderKind,
  type ProviderSnapshot,
  type ProviderSnapshotRequest,
  type StartProviderTurnInput,
  type TurnBlockPayload,
} from '../../shared/provider-runtime.ts';
import type {
  ProviderAdapter,
  ProviderCommandAcceptance,
  ProviderSession,
} from './provider-adapter.ts';
import { ProviderEventStream } from './provider-adapter.ts';
import type { CompactDispatchContext, DispatchBoundary,
  ProviderDispatchResult } from './native-runtime/delivery-contract.ts';

const FIXTURE_CAPABILITIES: ProviderCapabilities = {
  protocolVersion: PROVIDER_RUNTIME_CONTRACT_VERSION,
  provider: 'fixture',
  providerVersion: 'native-fixture-1',
  adapterVersion: 'provider-runtime-v1',
  auth: 'external',
  authentication: { login: 'none', logout: false },
  session: {
    create: true,
    resume: true,
    discoverHistory: false,
    readSnapshot: true,
    forkNative: false,
    rollbackNative: false,
  },
  turns: {
    interrupt: true,
    steer: false,
    queue: true,
    changeModelOnExistingSession: false,
    changeEffortOnExistingSession: false,
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
  interaction: {
    blockingApprovals: false,
    structuredUserInput: false,
  },
  access: {
    presets: ['read-only', 'workspace-write', 'full-access'],
    defaultPreset: 'workspace-write',
  },
  usage: { turn: false, cumulative: false, context: 'none', plan: 'none', estimatedCost: false },
  compaction: { automaticNative: false, manualNative: false },
};

const FIXTURE_MODELS: readonly ProviderModelDescriptor[] = [{
  id: 'fixture-native-v1',
  name: 'Native Fixture v1',
  provider: 'fixture',
  supportedEffort: ['low', 'medium', 'high'],
  contextWindow: 100_000,
  isDefault: true,
}];

export type NativeFixtureScenario = {
  emitNativeChild?: boolean;
  nativeChildCompletionDelayMs?: number;
  failTurn?: boolean;
  delayMs?: number;
  provider?: ProviderKind;
  finalText?: string;
  fileChanges?: readonly ProviderFileChange[];
  manualCompaction?: boolean;
  compactDelayMs?: number;
  snapshotDelayMs?: number;
  snapshotAuthority?: ProviderSnapshot['authority'];
  snapshotCoverage?: ProviderSnapshot['coverage'];
  historyRevision?: string | ((input: OpenProviderSessionInput) => string | null);
  snapshotEvents?: (
    input: OpenProviderSessionInput,
  ) => readonly ProviderEventEnvelope[];
  omitCompactionCompletion?: boolean;
  nativeFork?: boolean;
  /** Emits a structurally valid block whose proposed pass ordinal is occupied. */
  emitPassCollision?: boolean;
  afterTurnAccepted?: (input: StartProviderTurnInput) => void;
};

export class NativeFixtureAdapter implements ProviderAdapter {
  readonly opened: FixtureProviderSession[] = [];
  private readonly scenario: NativeFixtureScenario;
  private readonly provider: ProviderKind;

  constructor(scenario: NativeFixtureScenario = {}) {
    this.scenario = scenario;
    this.provider = scenario.provider ?? 'fixture';
  }

  async probe(providerInstanceId: string): Promise<ProviderProbe> {
    return {
      state: providerInstanceId === 'missing' ? 'missing' : 'ready',
      displayLabel: 'Native fixture provider',
      ...(providerInstanceId === 'missing'
        ? { diagnosticCode: 'fixture_missing', message: 'Fixture provider is missing.' }
        : {
            capabilities: {
              ...structuredClone(FIXTURE_CAPABILITIES),
              provider: this.provider,
              compaction: {
                automaticNative: false,
                manualNative: this.scenario.manualCompaction === true,
              },
              session: {
                ...FIXTURE_CAPABILITIES.session,
                forkNative: this.scenario.nativeFork === true,
                ...(this.scenario.nativeFork ? {
                  contextBranching: {
                    strategy: 'native' as const,
                    boundary: 'turn' as const,
                    sameProviderInstanceOnly: true,
                    workspace: 'shared-current' as const,
                    whileBackgroundChildrenRun: false,
                  },
                } : {}),
              },
            },
          }),
    };
  }

  async listModels(providerInstanceId: string) {
    return providerInstanceId === 'missing'
      ? []
      : FIXTURE_MODELS.map((model) => ({ ...structuredClone(model), provider: this.provider }));
  }

  async openSession(unparsed: OpenProviderSessionInput): Promise<FixtureProviderSession> {
    const input = parseOpenProviderSessionInput(unparsed);
    const nativeSession: NativeSessionRef = input.nativeSession ?? {
      provider: this.provider,
      providerInstanceId: input.providerInstanceId,
      sessionId: `fixture-${randomUUID()}`,
      resumeCursor: { version: 1, sequence: 0 },
    };
    if (nativeSession.provider !== this.provider) {
      throw new Error(`Fixture adapter for ${this.provider} cannot open ${nativeSession.provider} sessions.`);
    }
    const session = new FixtureProviderSession(input, nativeSession, this.scenario, this.provider);
    this.opened.push(session);
    session.bind(input.mode !== 'create');
    return session;
  }
}

export class FixtureProviderSession implements ProviderSession {
  readonly events = new ProviderEventStream();
  readonly eventLog: ProviderEventEnvelope[] = [];
  readonly nativeSession: NativeSessionRef;
  readonly readHistoryRevision?: () => Promise<string | null>;
  providerDispatchCount = 0;
  providerCompactCount = 0;
  providerSnapshotCount = 0;
  readonly dispatchLog: string[] = [];
  readonly turnInputs: StartProviderTurnInput[] = [];
  readonly childInterrupts: InterruptProviderChildInput[] = [];

  get isClosed() {
    return this.closed;
  }

  private sequence = 0;
  private readonly receipts = new Map<string, string>();
  private activeTurn: {
    turnId: string;
    controller: AbortController;
    task: Promise<void>;
  } | null = null;
  private closed = false;
  private snapshotController: AbortController | null = null;
  private readonly pendingChildCompletions = new Set<ReturnType<typeof setTimeout>>();
  private streamFailed = false;
  private state: ProviderSnapshot['state'] = 'idle';
  readonly openedWith: OpenProviderSessionInput;
  private readonly scenario: NativeFixtureScenario;
  private readonly provider: ProviderKind;

  constructor(
    openedWith: OpenProviderSessionInput,
    nativeSession: NativeSessionRef,
    scenario: NativeFixtureScenario,
    provider: ProviderKind,
  ) {
    this.openedWith = openedWith;
    this.nativeSession = structuredClone(nativeSession);
    this.scenario = scenario;
    this.provider = provider;
    if (scenario.historyRevision !== undefined) {
      this.readHistoryRevision = async () => typeof scenario.historyRevision === 'function'
        ? scenario.historyRevision(openedWith)
        : scenario.historyRevision ?? null;
    }
    if (scenario.snapshotAuthority === 'session-local' && openedWith.activeTurnBinding) {
      this.state = 'running';
    }
  }

  bind(resumed: boolean) {
    this.emit({ type: 'session.bound', resumed }, 'session/bound');
    this.emit({ type: 'session.materialized' }, 'session/materialized');
    this.emit({ type: 'session.health', state: 'ready' }, 'session/health');
  }

  async startTurn(unparsed: StartProviderTurnInput, boundary?: DispatchBoundary): Promise<ProviderDispatchResult> {
    this.assertOpen();
    const input = parseStartProviderTurnInput(unparsed);
    if (input.conversationId !== this.openedWith.conversationId) {
      throw new Error('Turn conversation does not match the opened provider session.');
    }
    if (input.executionId !== this.openedWith.executionId) {
      throw new Error('Turn execution does not match the opened provider session.');
    }
    const requestHash = hashJson(input);
    const previous = this.receipts.get(input.commandId);
    if (previous) {
      if (previous !== requestHash) throw new Error('Provider command ID was reused with different input.');
      return { accepted: true, outcome: 'accepted', evidence: this.startEvidence(input), nativeTurnId: input.turnId };
    }
    if (this.activeTurn) throw new Error('Fixture provider session already has an active turn.');
    boundary?.markPossiblySent(this.nativeSession.sessionId, 'fixture-stream-1');
    this.receipts.set(input.commandId, requestHash);
    this.providerDispatchCount += 1;
    this.dispatchLog.push(`turn:${input.turnId}`);
    this.turnInputs.push(structuredClone(input));
    const controller = new AbortController();
    const active = {
      turnId: input.turnId,
      controller,
      task: Promise.resolve(),
    };
    this.activeTurn = active;
    this.state = 'running';
    this.emit({ type: 'turn.started' }, 'turn/started', input.turnId);
    this.emit({ type: 'turn.status', state: 'running' }, 'turn/status', input.turnId);
    active.task = this.runTurn(input, controller.signal);
    this.scenario.afterTurnAccepted?.(structuredClone(input));
    return { accepted: true, outcome: 'accepted', evidence: this.startEvidence(input), nativeTurnId: input.turnId };
  }

  private startEvidence(input: StartProviderTurnInput) {
    if (this.provider === 'codex') return { kind: 'codex-turn-start-response' as const,
      threadId: this.nativeSession.sessionId, turnId: input.turnId,
      nativeClientMessageId: input.turnId };
    if (this.provider === 'claude-code') return { kind: 'claude-root-processing' as const,
      sessionId: this.nativeSession.sessionId,
      userMessageUuid: stableUuid(`claude-user\0${input.commandId}`),
      observationUuid: stableUuid(`fixture-claude-proof\0${input.commandId}`) };
    return { kind: 'fixture-correlated-acceptance' as const, sessionId: this.nativeSession.sessionId,
      commandId: input.commandId, nativeTurnId: input.turnId };
  }

  async interrupt(input: InterruptProviderTurnInput): Promise<ProviderCommandAcceptance> {
    this.assertOpen();
    const requestHash = hashJson(input);
    const previous = this.receipts.get(input.commandId);
    if (previous) {
      if (previous !== requestHash) throw new Error('Provider command ID was reused with different input.');
      return { accepted: true };
    }
    this.receipts.set(input.commandId, requestHash);
    if (this.activeTurn?.turnId === input.turnId) this.activeTurn.controller.abort();
    return { accepted: true };
  }

  async interruptChild(unparsed: InterruptProviderChildInput): Promise<ProviderCommandAcceptance> {
    this.assertOpen();
    const input = parseInterruptProviderChildInput(unparsed);
    const childExecutionId = `${this.openedWith.executionId}:native-child-1`;
    const nativeSessionId = `${this.nativeSession.sessionId}:child-1`;
    if (input.childExecutionId !== childExecutionId || input.nativeSessionId !== nativeSessionId) {
      throw new Error('Fixture child interruption does not match this session.');
    }
    const requestHash = hashJson(input);
    const previous = this.receipts.get(input.commandId);
    if (previous) {
      if (previous !== requestHash) throw new Error('Provider command ID was reused with different input.');
      return { accepted: true };
    }
    this.receipts.set(input.commandId, requestHash);
    this.childInterrupts.push(structuredClone(input));
    return { accepted: true };
  }

  async compact(unparsed: CompactProviderSessionInput,
    context: CompactDispatchContext): Promise<ProviderDispatchResult> {
    this.assertOpen();
    const input = parseCompactProviderSessionInput(unparsed);
    if (!this.scenario.manualCompaction) throw new Error('Fixture native Compact is unavailable.');
    if (input.conversationId !== this.openedWith.conversationId ||
        input.executionId !== this.openedWith.executionId) {
      throw new Error('Compact request does not match the opened fixture session.');
    }
    const requestHash = hashJson(input);
    const previous = this.receipts.get(input.commandId);
    if (previous) {
      if (previous !== requestHash) throw new Error('Provider command ID was reused with different input.');
      return { accepted: true, outcome: 'accepted', evidence: {
        kind: 'fixture-correlated-acceptance', sessionId: this.nativeSession.sessionId,
        commandId: input.commandId,
      } };
    }
    if (this.activeTurn) throw new Error('Fixture provider session is busy.');
    this.receipts.set(input.commandId, requestHash);
    this.providerCompactCount += 1;
    this.dispatchLog.push(`compact:${input.commandId}`);
    context.boundary.markPossiblySent(this.nativeSession.sessionId);
    if (this.scenario.omitCompactionCompletion) {
      return { accepted: true, outcome: 'accepted', evidence: {
        kind: 'fixture-correlated-acceptance', sessionId: this.nativeSession.sessionId,
        commandId: input.commandId,
      } };
    }
    const complete = async () => {
      if (this.scenario.compactDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, this.scenario.compactDelayMs));
      }
      this.emit({
        type: 'context.compaction.completed',
        trigger: 'manual',
        operationId: input.commandId,
        beforeTokens: 90_000,
        afterTokens: 12_000,
      }, 'context/compact/completed');
    };
    queueMicrotask(() => void complete());
    return { accepted: true, outcome: 'accepted', evidence: {
      kind: 'fixture-correlated-acceptance', sessionId: this.nativeSession.sessionId,
      commandId: input.commandId,
    } };
  }

  emitAutomaticCompaction(operationId = `fixture-auto-compact-${this.sequence + 1}`) {
    this.emit({
      type: 'context.compaction.completed',
      trigger: 'automatic',
      operationId,
      beforeTokens: 95_000,
      afterTokens: 10_000,
    }, 'context/compact/automatic');
  }

  async snapshot(_input: ProviderSnapshotRequest): Promise<ProviderSnapshot> {
    this.assertOpen();
    this.providerSnapshotCount += 1;
    const controller = new AbortController();
    this.snapshotController = controller;
    try {
      if (this.scenario.snapshotDelayMs) {
        await delay(this.scenario.snapshotDelayMs, controller.signal);
      }
      const historyRevision = await this.readHistoryRevision?.() ?? undefined;
      return {
        contractVersion: PROVIDER_RUNTIME_CONTRACT_VERSION,
        nativeSession: structuredClone(this.nativeSession),
        state: this.state,
        ...(this.scenario.snapshotAuthority
          ? { authority: this.scenario.snapshotAuthority }
          : {}),
        ...(this.scenario.snapshotCoverage
          ? { coverage: structuredClone(this.scenario.snapshotCoverage) }
          : {}),
        ...(historyRevision ? { historyRevision } : {}),
        events: structuredClone(
          this.scenario.snapshotEvents?.(this.openedWith) ?? this.eventLog,
        ),
        nextNativeSequence: this.sequence + 1,
      };
    } finally {
      if (this.snapshotController === controller) this.snapshotController = null;
    }
  }

  async fork(unparsed: NativeForkRequest): Promise<NativeSessionRef> {
    this.assertOpen();
    if (!this.scenario.nativeFork) throw new Error('Fixture native fork is unavailable.');
    const input = parseNativeForkRequest(unparsed);
    this.dispatchLog.push(`fork:${input.beforeNativeTurnId ?? input.throughNativeTurnId ?? 'empty'}`);
    const sessionId = input.destinationSessionId ?? `fixture-fork-${randomUUID()}`;
    return {
      provider: this.provider,
      providerInstanceId: this.nativeSession.providerInstanceId,
      sessionId,
      resumeCursor: { version: 1, sequence: 0 },
    };
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.snapshotController?.abort(new DOMException('Session closed.', 'AbortError'));
    this.cancelPendingChildCompletions();
    const active = this.activeTurn;
    active?.controller.abort();
    await active?.task.catch(() => undefined);
    this.activeTurn = null;
    this.events.close();
  }

  simulateTransportFailure(error = new Error('Fixture provider transport failed.')) {
    if (this.closed) return;
    this.closed = true;
    this.streamFailed = true;
    this.cancelPendingChildCompletions();
    this.activeTurn?.controller.abort(error);
    this.events.fail(error);
  }

  private async runTurn(input: StartProviderTurnInput, signal: AbortSignal) {
    try {
      await delay(this.scenario.delayMs ?? 2, signal);
      this.emit(
        blockCompleted(input.turnId, 'reasoning-1', 0, {
          kind: 'reasoning-summary', text: 'Inspecting the native fixture workspace.', truncated: false,
        }),
        'item/reasoning',
        input.turnId,
        'reasoning-1',
      );
      if (this.scenario.emitPassCollision) {
        const collision = blockCompleted(input.turnId, 'collision-1', 1, {
          kind: 'reasoning-summary', text: 'This fixture pass must be appended safely.', truncated: false,
        });
        if (collision.type === 'turn.block.completed') {
          this.emit({
            ...collision,
            structure: {
              ...collision.structure,
              passId: `fixture-colliding-pass-${input.turnId}`,
            },
          }, 'item/colliding-pass', input.turnId, 'collision-1');
        }
      }
      this.emit({
        type: 'turn.block.started',
        structure: blockStructure(input.turnId, 'fixture-tool-1', 1),
        block: {
          kind: 'tool', state: 'running', payload: {
            kind: 'tool',
            tool: { callId: 'fixture-tool-1', name: 'read', category: 'file', title: 'Read README.md' },
            inputPreview: { path: 'README.md' },
          },
        },
      }, 'item/tool/started', input.turnId, 'fixture-tool-1');
      this.emit({
        ...blockCompleted(input.turnId, 'fixture-tool-1', 1, {
          kind: 'tool',
          tool: { callId: 'fixture-tool-1', name: 'read', category: 'file', title: 'Read README.md' },
          inputPreview: { path: 'README.md' },
        }),
      }, 'item/tool/completed', input.turnId, 'fixture-tool-1');
      for (const [index, change] of (this.scenario.fileChanges ?? []).entries()) {
        this.emit(
          { type: 'turn.file-changed', change: structuredClone(change), blockId: 'fixture-tool-1' },
          'item/file/changed',
          input.turnId,
          `fixture-file-${index + 1}`,
        );
      }
      if (this.scenario.emitNativeChild) this.emitNativeChild(
        input.turnId,
        this.scenario.nativeChildCompletionDelayMs,
      );
      const text = input.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n');
      this.emit(
        {
          ...blockCompleted(input.turnId, 'assistant-final', 3, {
            kind: 'final-message',
            text: this.scenario.finalText ?? `Native fixture response for “${text}”.`,
          }),
        },
        'item/assistant/final',
        input.turnId,
        'assistant-final',
      );
      if (this.scenario.failTurn) {
        this.emit({
          type: 'turn.completed',
          outcome: 'failed',
          error: { code: 'fixture_failure', message: 'Fixture provider failed.' },
        }, 'turn/completed', input.turnId);
        this.state = 'idle';
        return;
      }
      this.emit({ type: 'turn.completed', outcome: 'completed' }, 'turn/completed', input.turnId);
      this.emit({ type: 'turn.status', state: 'idle' }, 'turn/status', input.turnId);
      this.state = 'idle';
    } catch (error) {
      if (signal.aborted) {
        if (this.streamFailed) {
          this.state = 'lost';
          return;
        }
        this.emit({ type: 'turn.completed', outcome: 'interrupted' }, 'turn/completed', input.turnId);
        this.emit({ type: 'turn.status', state: 'idle' }, 'turn/status', input.turnId);
        this.state = 'idle';
        return;
      }
      this.state = 'lost';
      this.events.fail(error);
    } finally {
      if (this.activeTurn?.turnId === input.turnId) this.activeTurn = null;
    }
  }

  private emitNativeChild(turnId: string, completionDelayMs?: number) {
    const childExecutionId = `${this.openedWith.executionId}:native-child-1`;
    this.emit({
      type: 'turn.block.started',
      structure: blockStructure(turnId, 'native-child-1', 2),
      block: {
        kind: 'native-child',
        state: 'running',
        payload: {
          kind: 'native-child',
          child: {
            executionId: childExecutionId,
            ownership: 'native',
            provider: this.provider,
            title: 'Fixture native child',
            nativeSessionId: `${this.nativeSession.sessionId}:child-1`,
          },
          executionState: 'running',
        },
      },
    }, 'child/started', turnId, 'native-child-1');
    const complete = () => this.emit({
      ...blockCompleted(turnId, 'native-child-1', 2, {
        kind: 'native-child',
        child: {
          executionId: childExecutionId,
          ownership: 'native',
          provider: this.provider,
          title: 'Fixture native child',
          nativeSessionId: `${this.nativeSession.sessionId}:child-1`,
        },
        executionState: 'idle',
        outcome: 'completed',
        summary: 'The fixture native child completed its bounded task.',
      }),
    }, 'child/completed', turnId, 'native-child-1');
    if (completionDelayMs === undefined) complete();
    else {
      const timeout = setTimeout(() => {
        this.pendingChildCompletions.delete(timeout);
        if (!this.closed) complete();
      }, completionDelayMs);
      timeout.unref();
      this.pendingChildCompletions.add(timeout);
    }
  }

  private cancelPendingChildCompletions() {
    for (const timeout of this.pendingChildCompletions) clearTimeout(timeout);
    this.pendingChildCompletions.clear();
  }

  private emit(event: ProviderEvent, nativeKind: string, turnId?: string, itemId?: string) {
    const sequence = ++this.sequence;
    const envelope = parseProviderEventEnvelope({
      contractVersion: PROVIDER_RUNTIME_CONTRACT_VERSION,
      eventId: `${this.nativeSession.sessionId}:${sequence}:${nativeKind.replaceAll('/', '-')}`,
      provider: this.provider,
      scope: turnId ? {
        kind: 'turn',
        providerInstanceId: this.nativeSession.providerInstanceId,
        conversationId: this.openedWith.conversationId,
        executionId: this.openedWith.executionId,
        turnId,
      } : {
        kind: 'conversation',
        providerInstanceId: this.nativeSession.providerInstanceId,
        conversationId: this.openedWith.conversationId,
        executionId: this.openedWith.executionId,
      },
      native: {
        sessionId: this.nativeSession.sessionId,
        ...(turnId ? { turnId } : {}),
        ...(itemId ? { itemId } : {}),
        position: { kind: 'native-sequence', sequence, subIndex: 0 },
        kind: nativeKind,
      },
      observedAt: Date.now(),
      event,
    });
    this.eventLog.push(envelope);
    this.events.emit(envelope);
  }

  private assertOpen() {
    if (this.closed) throw new Error('Fixture provider session is closed.');
  }
}

function blockStructure(turnId: string, itemId: string, ordinal: number) {
  return {
    passId: `fixture-pass-${turnId}`,
    blockId: `fixture-block-${turnId}-${itemId}`,
    passOrdinal: 0,
    blockOrdinal: ordinal,
  };
}

function blockCompleted(
  turnId: string,
  itemId: string,
  ordinal: number,
  payload: TurnBlockPayload,
): ProviderEvent {
  const block = { kind: payload.kind, state: 'completed' as const, payload };
  return {
    type: 'turn.block.completed',
    structure: blockStructure(turnId, itemId, ordinal),
    revision: 1,
    contentHash: hashJson(block),
    block,
  };
}

function hashJson(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function stableUuid(value: string) {
  const hex = createHash('sha256').update(value).digest('hex').slice(0, 32).split('');
  hex[12] = '4';
  hex[16] = ['8', '9', 'a', 'b'][Number.parseInt(hex[16]!, 16) % 4]!;
  return `${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex.slice(12, 16).join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20).join('')}`;
}

function delay(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timeout = setTimeout(resolve, milliseconds);
    // Long fixture turns model background native work. They must not keep a
    // completed Node test process alive if the test has already closed every
    // coordinator that owns them.
    if (milliseconds >= 1_000) timeout.unref();
    signal.addEventListener('abort', () => {
      clearTimeout(timeout);
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
}
