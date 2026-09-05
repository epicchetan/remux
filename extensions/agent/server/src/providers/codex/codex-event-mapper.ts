import { createHash } from 'node:crypto';

import {
  PROVIDER_RUNTIME_CONTRACT_VERSION,
  PROVIDER_RUNTIME_LIMITS,
  parseProviderEventEnvelope,
  type ProviderFileChange,
  type ChildExecutionDisplay,
  type ProviderEvent,
  type ProviderEventEnvelope,
  type ProviderTurnOutcome,
  type JsonValue,
  type ProviderAccountUsage,
  type AccountUsageWindow,
  type TurnBlockKind,
  type TurnBlockPayload,
  type TurnBlockSnapshot,
  type TurnStructure,
  type UserContentPart,
  type NativeTimelineBoundary,
} from '../../../../shared/provider-runtime.ts';
import type { CodexServerNotification } from './codex-app-server-process.ts';
import { fitJsonPreview, mergeJsonPreview } from '../preview.ts';
import { DISPLAY_TRUNCATION_MARKER, fitProviderEventDisplay } from '../display-fitting.ts';
import { CodexChildRegistry, type CodexChildBinding } from './codex-child-registry.ts';
import type { NativeChildBinding } from '../../../../shared/provider-runtime.ts';

type CodexMapperOptions = {
  providerInstanceId: string;
  conversationId: string;
  executionId: string;
  nativeSessionId: string;
  inheritedNativeTurnIds?: readonly string[];
  observedAt?: () => number;
  childRegistry?: CodexChildRegistry;
};

type MapperEvent = ProviderEvent | ({ type: string } & Record<string, unknown>);
type AgentMessageStreamKind = 'assistant' | 'commentary';

type BlockState = {
  structure: TurnStructure;
  block: TurnBlockSnapshot;
  revision: number;
};

export class CodexEventMapper {
  private readonly providerInstanceId: string;
  private readonly conversationId: string;
  private readonly executionId: string;
  private readonly nativeSessionId: string;
  private readonly inheritedNativeTurnIds: ReadonlySet<string>;
  private readonly observedAt: () => number;
  private readonly childRegistry: CodexChildRegistry;
  private readonly remuxTurnByNative = new Map<string, string>();
  private readonly deltaOffsets = new Map<string, number>();
  private readonly agentMessageKinds = new Map<string, AgentMessageStreamKind>();
  private readonly pendingAgentMessageDeltas = new Map<string, string>();
  private readonly blocks = new Map<string, BlockState>();
  private readonly reasoningParts = new Map<string, string[]>();
  private readonly nextOrdinalByTurn = new Map<string, number>();
  private pendingRemuxTurnId: string | null = null;
  private pendingManualCompactionId: string | null = null;
  private readonly compactionNativeTurns = new Set<string>();
  private readonly completedCompactionItems = new Set<string>();
  private readonly nativeTurnsWithCompletedCompactionItem = new Set<string>();
  private readonly compactionOrdinalByItem = new Map<string, number>();
  private readonly nextCompactionOrdinalByTurn = new Map<string, number>();
  private readonly compactionOperationByOccurrence = new Map<
    string,
    { operationId: string; trigger: 'manual' | 'automatic' }
  >();
  private readonly accountWindows = new Map<string, AccountUsageWindow>();
  private usageAnchorNativeTurnId: string | null = null;
  private liveSequence = 0;

  constructor(options: CodexMapperOptions) {
    this.providerInstanceId = options.providerInstanceId;
    this.conversationId = options.conversationId;
    this.executionId = options.executionId;
    this.nativeSessionId = options.nativeSessionId;
    this.inheritedNativeTurnIds = new Set(options.inheritedNativeTurnIds ?? []);
    this.observedAt = options.observedAt ?? Date.now;
    this.childRegistry = options.childRegistry ?? new CodexChildRegistry();
  }

  expectTurn(remuxTurnId: string) {
    this.pendingRemuxTurnId = remuxTurnId;
  }

  bindTurn(remuxTurnId: string, nativeTurnId: string, nextBlockOrdinal = 0) {
    this.remuxTurnByNative.set(nativeTurnId, remuxTurnId);
    this.nextOrdinalByTurn.set(
      nativeTurnId,
      Math.max(this.nextOrdinalByTurn.get(nativeTurnId) ?? 0, nextBlockOrdinal),
    );
    this.usageAnchorNativeTurnId = nativeTurnId;
    if (this.pendingRemuxTurnId === remuxTurnId) this.pendingRemuxTurnId = null;
  }

  restoreChildBlocks(bindings: readonly NativeChildBinding[]) {
    for (const binding of bindings) {
      const durable = binding.canonicalBlock;
      if (!durable) continue;
      if (durable.block.kind !== 'native-child' || durable.block.payload.kind !== 'native-child') continue;
      this.blocks.set(this.blockKey(binding.ownerNativeTurnId, binding.executionId, 'native-child'), {
        structure: durable.structure,
        revision: durable.revision,
        block: durable.block,
      });
    }
  }

  remuxTurnId(nativeTurnId: string) {
    return this.remuxTurnByNative.get(nativeTurnId) ?? codexStableNativeTurnId(nativeTurnId);
  }

  expectManualCompaction(operationId: string) {
    this.pendingManualCompactionId = operationId;
  }

  clearManualCompaction(operationId: string) {
    if (this.pendingManualCompactionId === operationId) this.pendingManualCompactionId = null;
  }

  mapNotification(notification: CodexServerNotification): ProviderEventEnvelope[] {
    const params = record(notification.params);
    if (!params) return [];
    if (notification.method === 'account/rateLimits/updated') {
      return [this.accountUsageEnvelope(params.rateLimits ?? params, 'provider-push')];
    }
    const notificationThreadId = threadIdFromNotification(notification.method, params);
    if (notificationThreadId && notificationThreadId !== this.nativeSessionId) {
      return this.mapChildThreadNotification(notification.method, params, notificationThreadId);
    }

    switch (notification.method) {
      case 'turn/started': {
        const turn = record(params.turn);
        const nativeTurnId = string(turn?.id);
        if (!nativeTurnId) return [];
        if (this.pendingManualCompactionId && !this.pendingRemuxTurnId) {
          this.compactionNativeTurns.add(nativeTurnId);
          return [];
        }
        if (this.compactionNativeTurns.has(nativeTurnId)) return [];
        const remuxTurnId = this.pendingRemuxTurnId ?? this.remuxTurnByNative.get(nativeTurnId);
        // A provider-created root turn has no accepted Remux command yet. Do
        // not emit turn-scoped events that cannot satisfy the journal FK; an
        // authoritative snapshot can import it once its type is known.
        if (!remuxTurnId) return [];
        this.bindTurn(remuxTurnId, nativeTurnId);
        return [
          this.snapshotEnvelope({ type: 'turn.started' }, 'turn/started', nativeTurnId),
          this.snapshotEnvelope({ type: 'turn.status', state: 'running' }, 'turn/status', nativeTurnId),
        ];
      }
      case 'turn/completed': {
        const turn = record(params.turn);
        const nativeTurnId = string(turn?.id);
        if (!nativeTurnId) return [];
        const outcome = turnOutcome(turn?.status);
        const error = record(turn?.error);
        if (this.compactionNativeTurns.has(nativeTurnId)) {
          if (outcome === 'completed' ||
              this.nativeTurnsWithCompletedCompactionItem.has(nativeTurnId)) return [];
          const operationId = this.pendingManualCompactionId;
          if (!operationId) return [];
          this.pendingManualCompactionId = null;
          return [this.compactionEnvelope({
            type: 'context.compaction.failed',
            trigger: 'manual',
            operationId,
            error: {
              code: 'codex_compaction_failed',
              message: string(error?.message) ?? `Codex compaction ${outcome}.`,
              retryable: true,
            },
          }, 'turn/compaction-failed', nativeTurnId)];
        }
        if (!this.remuxTurnByNative.has(nativeTurnId)) return [];
        const events = [
          this.snapshotEnvelope({
            type: 'turn.completed',
            outcome,
            ...(outcome === 'failed'
              ? {
                  error: {
                    code: string(error?.codexErrorInfo) ?? 'codex_turn_failed',
                    message: string(error?.message) ?? 'Codex turn failed.',
                  },
                }
              : {}),
          }, 'turn/completed', nativeTurnId),
          this.snapshotEnvelope({ type: 'turn.status', state: 'idle' }, 'turn/status', nativeTurnId),
        ];
        this.clearAgentMessageState(nativeTurnId);
        return events;
      }
      case 'item/agentMessage/delta':
        return this.mapAgentMessageDelta(params);
      case 'item/plan/delta':
        return this.mapTextDelta(params, 'commentary');
      case 'item/reasoning/summaryPartAdded':
        // The following summaryTextDelta carries the native summaryIndex. We
        // preserve that index in the canonical block rather than emitting an
        // invalid empty text block for this boundary-only notification.
        return [];
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta':
        return this.mapTextDelta(params, 'reasoning');
      case 'item/fileChange/patchUpdated': {
        const nativeTurnId = string(params.turnId);
        const itemId = string(params.itemId);
        if (!nativeTurnId || !itemId || !this.remuxTurnByNative.has(nativeTurnId) ||
            this.compactionNativeTurns.has(nativeTurnId) || !Array.isArray(params.changes)) return [];
        const changes = params.changes.flatMap(mapFileChange);
        return [
          this.snapshotEnvelope(
            fileChangeStartedEvent(itemId, changes, false),
            'item/fileChange',
            nativeTurnId,
            itemId,
          ),
          ...changes.map((change, index) =>
            this.snapshotEnvelope(
              { type: 'file.changed', change },
              `item/fileChange/patchUpdated/${index}`,
              nativeTurnId,
              itemId,
            )),
        ];
      }
      case 'item/commandExecution/outputDelta': {
        const nativeTurnId = string(params.turnId);
        const itemId = string(params.itemId);
        const delta = string(params.delta);
        if (!nativeTurnId || !itemId || !delta ||
            !this.remuxTurnByNative.has(nativeTurnId) ||
            this.compactionNativeTurns.has(nativeTurnId)) return [];
        return [this.liveEnvelope({
          type: 'tool.updated',
          toolCallId: itemId,
          outputPreview: { delta },
        }, 'item/command/outputDelta', nativeTurnId, itemId)];
      }
      case 'item/mcpToolCall/progress': {
        const nativeTurnId = string(params.turnId);
        const itemId = string(params.itemId);
        const message = string(params.message);
        if (!nativeTurnId || !itemId || !message ||
            !this.remuxTurnByNative.has(nativeTurnId) ||
            this.compactionNativeTurns.has(nativeTurnId)) return [];
        return [this.liveEnvelope({
          type: 'tool.updated',
          toolCallId: itemId,
          outputPreview: { message },
        }, 'item/mcp/progress', nativeTurnId, itemId)];
      }
      case 'item/started':
        return this.mapItem(params.item, string(params.turnId), false);
      case 'item/completed':
        return this.mapItem(params.item, string(params.turnId), true);
      case 'thread/compacted': {
        const nativeTurnId = string(params.turnId);
        if (nativeTurnId && this.nativeTurnsWithCompletedCompactionItem.has(nativeTurnId)) return [];
        // A native automatic compaction can happen inside an ordinary work
        // turn. Only unbound turns are compaction-only control turns; marking a
        // bound work turn here would suppress all of its post-compaction items
        // and its terminal event.
        if (nativeTurnId && !this.remuxTurnByNative.has(nativeTurnId)) {
          this.compactionNativeTurns.add(nativeTurnId);
        }
        const compactionTurnId = nativeTurnId ?? 'thread';
        const compactionOrdinal = this.compactionOrdinal(
          compactionTurnId,
          `thread:${string(params.id) ?? 'completed'}`,
        );
        const { operationId, trigger } = this.compactionOperation(
          compactionTurnId,
          compactionOrdinal,
          true,
        );
        this.pendingManualCompactionId = null;
        if (nativeTurnId) this.nativeTurnsWithCompletedCompactionItem.add(nativeTurnId);
        const controlTurn = !nativeTurnId || this.compactionNativeTurns.has(nativeTurnId);
        return [this.compactionEnvelope({
          type: 'context.compaction.completed',
          trigger,
          operationId,
          beforeTokens: null,
          afterTokens: null,
        }, `${controlTurn ? 'control/' : ''}thread/compacted`, nativeTurnId, undefined, undefined,
        compactionOrdinal)];
      }
      case 'thread/tokenUsage/updated': {
        const reportedNativeTurnId = string(params.turnId);
        const tokenUsage = record(params.tokenUsage);
        const last = record(tokenUsage?.last);
        const total = record(tokenUsage?.total);
        if (!total) return [];
        // App Server reports the restored context against its latest native
        // turn. That turn is commonly a context-compaction control turn, which
        // deliberately has no Remux turn row. Anchor conversation-wide usage
        // to the latest visible turn while retaining the provider's actual
        // native turn identity for deduplication and diagnostics.
        const anchorNativeTurnId = reportedNativeTurnId &&
          this.remuxTurnByNative.has(reportedNativeTurnId) &&
          !this.compactionNativeTurns.has(reportedNativeTurnId)
          ? reportedNativeTurnId
          : this.usageAnchorNativeTurnId;
        if (!anchorNativeTurnId) return [];
        const remuxTurnId = this.remuxTurnByNative.get(anchorNativeTurnId);
        if (!remuxTurnId) return [];
        const nativeTurnId = reportedNativeTurnId ?? anchorNativeTurnId;
        const windowTokens = nonnegative(params.modelContextWindow)
          ?? nonnegative(tokenUsage?.modelContextWindow);
        // Codex's `last.totalTokens` is the provider's per-turn context
        // occupancy. `inputTokens` alone omits output/reasoning tokens that
        // still participate in the next request's context.
        const usedTokens = nonnegative(last?.totalTokens)
          ?? nonnegative(last?.inputTokens);
        return [this.usageEnvelope({
          type: 'usage.updated',
          usage: {
            turn: last ? tokenBreakdown(last) : null,
            cumulative: {
              tokens: tokenBreakdown(total),
              scope: 'native-conversation',
              epochId: this.nativeSessionId,
            },
            context: usedTokens !== undefined && windowTokens !== undefined && windowTokens > 0
              ? {
                  usedTokens,
                  windowTokens,
                  percent: Math.min(100, Math.max(0, usedTokens / windowTokens * 100)),
                  measurement: 'derived',
                  freshness: params.remuxFreshness === 'cached' ? 'cached' : 'live',
                  observedAt: this.observedAt(),
                  turnId: remuxTurnId,
                }
              : null,
            estimatedCost: null,
          },
        }, nativeTurnId, remuxTurnId)];
      }
      case 'error': {
        const nativeTurnId = string(params.turnId);
        const error = record(params.error);
        if (!nativeTurnId || !this.remuxTurnByNative.has(nativeTurnId) ||
            this.compactionNativeTurns.has(nativeTurnId)) return [];
        return [this.liveEnvelope({
          type: 'compatibility.notice',
          code: params.willRetry === true ? 'codex_retrying' : 'codex_error',
          message: string(error?.message) ?? 'Codex reported an error.',
        }, 'error', nativeTurnId)];
      }
      default:
        return [];
    }
  }

  mapAccountUsage(value: unknown, source: ProviderAccountUsage['source']) {
    const response = record(value);
    if (!response) return [];
    return [this.accountUsageEnvelope(response, source)];
  }

  private accountUsageEnvelope(value: unknown, source: ProviderAccountUsage['source']) {
    const observedAt = this.observedAt();
    const next = normalizeCodexAccountUsage(value, source, observedAt);
    if (source === 'provider-read') this.accountWindows.clear();
    for (const window of next.windows) this.accountWindows.set(window.id, window);
    const usage: ProviderAccountUsage = {
      ...next,
      availability: this.accountWindows.size > 0 ? 'available' : next.availability,
      windows: [...this.accountWindows.values()],
    };
    const envelope = parseProviderEventEnvelope({
      contractVersion: PROVIDER_RUNTIME_CONTRACT_VERSION,
      eventId: `codex-account-${digest(JSON.stringify(usage))}`,
      provider: 'codex',
      scope: { kind: 'account', providerInstanceId: this.providerInstanceId },
      native: { sessionId: this.nativeSessionId, kind: 'account/rateLimits' },
      observedAt,
      event: { type: 'account.usage-updated', usage },
    });
    return envelope;
  }

  mapThreadSnapshot(threadValue: unknown): ProviderEventEnvelope[] {
    const thread = record(threadValue);
    if (!thread || string(thread.id) !== this.nativeSessionId || !Array.isArray(thread.turns)) return [];
    const envelopes: ProviderEventEnvelope[] = [];
    const snapshotTurns = thread.turns.flatMap((value) => {
      const turn = record(value);
      const nativeTurnId = string(turn?.id);
      if (!turn || !nativeTurnId) return [];
      const items = Array.isArray(turn.items) ? turn.items : [];
      const control = items.length > 0 &&
        items.every((item) => record(item)?.type === 'contextCompaction') &&
        !this.remuxTurnByNative.has(nativeTurnId);
      return [{ turn, nativeTurnId, items, control }];
    });
    const latestCompactionIdentity = snapshotTurns.flatMap(({ nativeTurnId, items }) =>
      items.flatMap((item) => {
        const candidate = record(item);
        const itemId = string(candidate?.id);
        return candidate?.type === 'contextCompaction' && itemId
          ? [`${nativeTurnId}\0${itemId}`]
          : [];
      })).at(-1);
    const visibleNativeTurn = ({ nativeTurnId, items, control }: typeof snapshotTurns[number]) =>
      !control && (items.length > 0 || this.remuxTurnByNative.has(nativeTurnId) ||
        this.inheritedNativeTurnIds.has(nativeTurnId));
    for (const [turnIndex, snapshotTurn] of snapshotTurns.entries()) {
      const { turn, nativeTurnId, items } = snapshotTurn;
      if (this.inheritedNativeTurnIds.has(nativeTurnId)) continue;
      let compactionOrdinal = 0;
      const isCompactionControlTurn = snapshotTurn.control;
      if (isCompactionControlTurn) {
        this.compactionNativeTurns.add(nativeTurnId);
        const previousTurnId = snapshotTurns.slice(0, turnIndex)
          .filter(visibleNativeTurn).at(-1)?.nativeTurnId;
        const nextTurnId = snapshotTurns.slice(turnIndex + 1)
          .find(visibleNativeTurn)?.nativeTurnId;
        const timeline = previousTurnId || nextTurnId
          ? {
              ...(previousTurnId ? { previousTurnId } : {}),
              ...(nextTurnId ? { nextTurnId } : {}),
            }
          : undefined;
        for (const [itemIndex, item] of items.entries()) {
          if (record(item)?.type === 'contextCompaction') {
            const itemId = string(record(item)?.id);
            envelopes.push(...this.mapItem(
              item,
              nativeTurnId,
              true,
              itemIndex,
              `${nativeTurnId}\0${itemId ?? ''}` === latestCompactionIdentity,
              compactionOrdinal++,
              timeline,
            ));
          }
        }
        continue;
      }
      if (items.length === 0 && !this.remuxTurnByNative.has(nativeTurnId)) continue;
      if (!this.remuxTurnByNative.has(nativeTurnId)) {
        this.bindTurn(codexStableNativeTurnId(nativeTurnId), nativeTurnId);
      }
      envelopes.push(this.snapshotEnvelope({ type: 'turn.started' }, 'turn/started', nativeTurnId));
      if (items.length > 0) {
        for (const [itemIndex, item] of items.entries()) {
          const isCompaction = record(item)?.type === 'contextCompaction';
          envelopes.push(...this.mapItem(
            item,
            nativeTurnId,
            true,
            itemIndex,
            true,
            isCompaction ? compactionOrdinal++ : undefined,
          ));
        }
      }
      const status = string(turn.status);
      if (status && status !== 'inProgress') {
        const outcome = turnOutcome(status);
        const error = record(turn.error);
        envelopes.push(this.snapshotEnvelope({
          type: 'turn.completed',
          outcome,
          ...(outcome === 'failed'
            ? { error: { code: 'codex_turn_failed', message: string(error?.message) ?? 'Codex turn failed.' } }
            : {}),
        }, 'turn/completed', nativeTurnId));
        this.clearAgentMessageState(nativeTurnId);
      } else {
        envelopes.push(this.snapshotEnvelope(
          { type: 'turn.status', state: 'running' },
          'turn/status',
          nativeTurnId,
        ));
      }
    }
    return dedupe(envelopes);
  }

  private mapAgentMessageDelta(params: Record<string, unknown>) {
    const nativeTurnId = string(params.turnId);
    const itemId = string(params.itemId);
    const delta = string(params.delta);
    if (!nativeTurnId || !itemId || !delta ||
        !this.remuxTurnByNative.has(nativeTurnId) ||
        this.compactionNativeTurns.has(nativeTurnId)) return [];
    const identity = agentMessageIdentity(nativeTurnId, itemId);
    const kind = this.agentMessageKinds.get(identity);
    if (kind) return this.mapTextDelta(params, kind);

    // Agent-message deltas omit the item's phase, so emitting an unknown one
    // as final text makes commentary briefly appear as the answer. Current
    // App Server versions send item/started first; retain a bounded fallback
    // for reordered or legacy streams and flush it once an item supplies the
    // authoritative phase.
    const pending = `${this.pendingAgentMessageDeltas.get(identity) ?? ''}${delta}`;
    if (pending.length > PROVIDER_RUNTIME_LIMITS.finalTextChars) {
      throw new Error(
        `Buffered Codex agent message exceeds ${PROVIDER_RUNTIME_LIMITS.finalTextChars} characters.`,
      );
    }
    this.pendingAgentMessageDeltas.set(identity, pending);
    return [];
  }

  private mapTextDelta(
    params: Record<string, unknown>,
    kind: 'assistant' | 'commentary' | 'reasoning',
  ) {
    const nativeTurnId = string(params.turnId);
    const itemId = string(params.itemId);
    const delta = string(params.delta);
    if (!nativeTurnId || !itemId || !delta ||
        !this.remuxTurnByNative.has(nativeTurnId) ||
        this.compactionNativeTurns.has(nativeTurnId)) return [];
    const key = `${nativeTurnId}:${itemId}:${kind}`;
    const offset = this.deltaOffsets.get(key) ?? 0;
    this.deltaOffsets.set(key, offset + delta.length);
    const event: MapperEvent = kind === 'reasoning'
      ? {
          type: 'assistant.reasoning',
          delta,
          partIndex: nonnegative(params.summaryIndex) ?? nonnegative(params.contentIndex) ?? 0,
        }
      : { type: 'assistant.text', phase: kind === 'commentary' ? 'commentary' : 'final', delta };
    return [this.envelope(
      event,
      `item/${kind}/delta`,
      nativeTurnId,
      itemId,
      `delta-${offset}`,
      ++this.liveSequence,
    )];
  }

  private mapItem(
    value: unknown,
    nativeTurnId: string | undefined,
    completed: boolean,
    itemIndex?: number,
    claimPendingManual = true,
    compactionOrdinalHint?: number,
    timeline?: NativeTimelineBoundary,
  ): ProviderEventEnvelope[] {
    const item = record(value);
    const itemId = string(item?.id);
    const type = string(item?.type);
    if (!item || !itemId || !type || !nativeTurnId) return [];
    if (type === 'contextCompaction') {
      const controlTurn = this.compactionNativeTurns.has(nativeTurnId);
      const compactionItemIdentity = `${nativeTurnId}\0${itemId}`;
      if (!completed && controlTurn) return [];
      // Live completion notifications can replay, but an authoritative
      // snapshot still has to emit its ordered marker. The journal uses that
      // marker to retain live tool activity omitted by a compacted snapshot.
      if (itemIndex === undefined && completed &&
          this.completedCompactionItems.has(compactionItemIdentity)) return [];
      const compactionOrdinal = this.compactionOrdinal(
        nativeTurnId,
        itemId,
        compactionOrdinalHint,
      );
      const { operationId, trigger } = this.compactionOperation(
        nativeTurnId,
        compactionOrdinal,
        claimPendingManual,
      );
      if (completed && trigger === 'manual' &&
          this.pendingManualCompactionId === operationId) this.pendingManualCompactionId = null;
      if (completed) {
        this.completedCompactionItems.add(compactionItemIdentity);
        this.nativeTurnsWithCompletedCompactionItem.add(nativeTurnId);
      }
      const phase = completed ? 'completed' : 'started';
      const event = completed
        ? {
            type: 'context.compaction.completed' as const,
            trigger,
            operationId,
            beforeTokens: null,
            afterTokens: null,
          }
        : {
            type: 'context.compaction.started' as const,
            trigger,
            operationId,
            beforeTokens: null,
          };
      const envelopes: ProviderEventEnvelope[] = [this.compactionEnvelope(
        event,
        `${controlTurn ? 'control' : 'item'}/contextCompaction/${phase}`,
        nativeTurnId,
        itemId,
        itemIndex,
        compactionOrdinal,
        timeline,
      )];
      if (!controlTurn && this.remuxTurnByNative.has(nativeTurnId)) {
        const marker = this.blockEvent(
          nativeTurnId,
          itemId,
          itemIndex,
          'compatibility-notice',
          {
            kind: 'compatibility-notice',
            code: 'context-compaction',
            message: completed ? 'Compacted' : 'Compacting',
          },
          completed ? 'completed' : 'running',
          completed,
        );
        envelopes.push(this.snapshotEnvelope(
          marker,
          `item/contextCompaction/${phase}/marker`,
          nativeTurnId,
          itemId,
          itemIndex,
        ));
      }
      return envelopes;
    }
    if (this.compactionNativeTurns.has(nativeTurnId) ||
        (itemIndex === undefined && !this.remuxTurnByNative.has(nativeTurnId))) return [];
    // Item lifecycle events use provider-native identity so a later thread
    // snapshot replaces/reaffirms the live projection instead of duplicating it.
    // Only textual delta events need process-local offset identities.
    const make = (event: MapperEvent, kind = `item/${type}`) =>
      this.snapshotEnvelope(event, kind, nativeTurnId, itemId, itemIndex);

    switch (type) {
      case 'userMessage': {
        const content = Array.isArray(item.content)
          ? item.content.flatMap(mapCodexUserContent)
          : [];
        return content.length > 0 ? [make({ type: 'user.message', content })] : [];
      }
      case 'agentMessage': {
        const identity = agentMessageIdentity(nativeTurnId, itemId);
        const declaredKind = agentMessageStreamKind(item.phase);
        if (declaredKind) this.agentMessageKinds.set(identity, declaredKind);
        const kind = declaredKind ?? this.agentMessageKinds.get(identity);
        const text = string(item.text);
        if (!text) {
          if (!completed && kind) return this.flushPendingAgentMessage(nativeTurnId, itemId, kind);
          if (completed) this.pendingAgentMessageDeltas.delete(identity);
          return [];
        }
        this.pendingAgentMessageDeltas.delete(identity);
        const authoritativeKind = kind ?? 'assistant';
        this.seedDeltaOffset(
          nativeTurnId,
          itemId,
          authoritativeKind,
          text.length,
        );
        return [make({
          type: 'assistant.text',
          phase: authoritativeKind === 'commentary' ? 'commentary' : 'final',
          text,
        })];
      }
      case 'plan': {
        const text = string(item.text);
        if (text) this.seedDeltaOffset(nativeTurnId, itemId, 'commentary', text.length);
        return text ? [make({ type: 'assistant.text', phase: 'commentary', text })] : [];
      }
      case 'reasoning': {
        const parts = arrayOfStrings(item.summary);
        const summary = parts.join('\n');
        return summary ? [make({ type: 'assistant.reasoning', summary, parts })] : [];
      }
      case 'commandExecution': {
        const status = string(item.status);
        const command = string(item.command);
        const cwd = string(item.cwd);
        const aggregatedOutput = string(item.aggregatedOutput);
        const commandActions = Array.isArray(item.commandActions)
          ? fitJsonPreview(item.commandActions)
          : [];
        const started = make({
          type: 'tool.started',
          tool: {
            callId: itemId,
            name: 'shell',
            category: 'shell',
            title: displayShellCommand(command ?? '') || 'Run command',
          },
          inputPreview: {
            ...(command ? { command } : {}),
            ...(cwd ? { cwd } : {}),
            commandActions,
          },
        });
        if (!completed && status === 'inProgress') return [started];
        const events = [started];
        if (aggregatedOutput) {
          events.push(make({
            type: 'tool.updated',
            toolCallId: itemId,
            outputPreview: { delta: aggregatedOutput },
            // A completed item is the provider's authoritative aggregate. It
            // replaces the live delta accumulator rather than appending the
            // same output a second time during snapshot reconciliation.
            replaceOutputPreview: true,
          }, `item/${type}/output`));
        }
        events.push(make({
          type: 'tool.completed',
          toolCallId: itemId,
          outcome: status === 'failed' || status === 'declined' ? 'failed' : 'completed',
        }, `item/${type}/completed`));
        return events;
      }
      case 'fileChange': {
        const changes = Array.isArray(item.changes)
          ? item.changes.flatMap((change) => mapFileChange(change))
          : [];
        const started = make(fileChangeStartedEvent(itemId, changes, completed));
        const events = [
          started,
          ...changes.map((change, index) =>
            this.snapshotEnvelope(
              { type: 'file.changed', change },
              `item/${type}/${index}`,
              nativeTurnId,
              itemId,
              itemIndex,
            )),
        ];
        if (completed) events.push(make({
          type: 'tool.completed',
          toolCallId: itemId,
          outcome: string(item.status) === 'failed' || string(item.status) === 'declined'
            ? 'failed'
            : 'completed',
        }, `item/${type}/completed`));
        return events;
      }
      case 'mcpToolCall':
      case 'dynamicToolCall': {
        const name = string(item.tool) ?? type;
        const status = string(item.status);
        const started = make({
          type: 'tool.started',
          tool: { callId: itemId, name, category: 'mcp', title: name },
          inputPreview: fitJsonPreview(item.arguments),
        });
        if (!completed && status === 'inProgress') return [started];
        return [started, make({
          type: 'tool.completed',
          toolCallId: itemId,
          outcome: status === 'failed' || item.success === false ? 'failed' : 'completed',
        }, `item/${type}/completed`)];
      }
      case 'webSearch':
        return [make({
          type: 'web.activity',
          activity: {
            kind: 'search',
            ...(string(item.query) ? { query: string(item.query)! } : {}),
          },
        })];
      case 'collabAgentToolCall':
        return this.mapCollabItem(item, nativeTurnId, itemIndex);
      case 'subAgentActivity':
        return this.mapSubAgentActivity(item, nativeTurnId, itemId, itemIndex);
      default:
        return [];
    }
  }

  private mapCollabItem(
    item: Record<string, unknown>,
    nativeTurnId: string,
    itemIndex?: number,
  ) {
    const tool = string(item.tool);
    if (tool !== 'spawn_agent' && tool !== 'spawnAgent') return [];
    const receiverIds = arrayOfStrings(item.receiverThreadIds);
    const envelopes: ProviderEventEnvelope[] = [];
    for (const childThreadId of receiverIds) {
      const binding = this.bindChild(childThreadId, nativeTurnId);
      if (binding.outcome) continue;
      const childExecutionId = binding.executionId;
      const event: MapperEvent = {
        type: 'child.started',
        child: {
          executionId: childExecutionId,
          ownership: 'native',
          provider: 'codex',
          providerInstanceId: this.providerInstanceId,
          ...(string(item.model) ? { model: string(item.model)! } : {}),
          title: string(item.prompt) ?? `Codex ${string(item.tool) ?? 'subagent'}`,
          nativeSessionId: childThreadId,
          transcriptAvailable: true,
        },
      };
      envelopes.push(this.snapshotEnvelope(
        event,
        'child/started',
        binding.ownerNativeTurnId,
        childExecutionId,
        itemIndex,
      ));
      const states = record(item.agentsStates);
      const state = record(states?.[childThreadId]);
      const status = string(state?.status);
      if (status) {
        const mapped = childStatus(status);
        const terminalOutcome = mapped === 'idle' ? 'completed' as const
          : mapped === 'interrupted' ? 'interrupted' as const
            : mapped === 'failed' ? 'failed' as const : undefined;
        if (terminalOutcome && !this.childRegistry.settleCachedOutcome(childThreadId, terminalOutcome)) {
          continue;
        }
        const statusEvent: MapperEvent = {
          type: 'child.status',
          childExecutionId,
          state: mapped,
        };
        envelopes.push(this.snapshotEnvelope(
          statusEvent,
          'child/status',
          binding.ownerNativeTurnId,
          childExecutionId,
          itemIndex,
        ));
        if (mapped !== 'running' && mapped !== 'recovering') {
          const completedEvent: MapperEvent = {
            type: 'child.completed',
            childExecutionId,
            outcome: mapped === 'idle' ? 'completed' : mapped,
          };
          envelopes.push(this.snapshotEnvelope(
            completedEvent,
            'child/completed',
            binding.ownerNativeTurnId,
            childExecutionId,
            itemIndex,
          ));
        }
      }
    }
    return envelopes;
  }

  private mapSubAgentActivity(
    item: Record<string, unknown>,
    nativeTurnId: string,
    itemId: string,
    itemIndex?: number,
  ) {
    const childThreadId = string(item.agentThreadId);
    if (!childThreadId) return [];
    const kind = string(item.kind);
    // Interactions are messages between already-related agents. They never
    // prove a new parent/child edge (notably a child's message to its parent).
    if (kind === 'interacted') return [];
    const binding = kind === 'started'
      ? this.bindChild(childThreadId, nativeTurnId)
      : this.childRegistry.get(childThreadId);
    if (!binding || binding.parentExecutionId !== this.executionId) return [];
    if (kind === 'started' && binding.outcome) return [];
    const childExecutionId = binding.executionId;
    const terminalOutcome = kind === 'completed' ? 'completed' as const
      : kind === 'interrupted' ? 'interrupted' as const : undefined;
    if (terminalOutcome) {
      const nativeChildTurnId = itemId.startsWith('subagent-completed-')
        ? itemId.slice('subagent-completed-'.length) : undefined;
      if (!nativeChildTurnId ||
          !this.childRegistry.completeAttempt(childThreadId, nativeChildTurnId, terminalOutcome)) return [];
    }
    const event: MapperEvent = kind === 'started'
      ? {
          type: 'child.started',
          child: {
            executionId: childExecutionId,
            ownership: 'native',
            provider: 'codex',
            providerInstanceId: this.providerInstanceId,
            title: string(item.agentPath) ?? 'Codex subagent',
            nativeSessionId: childThreadId,
            transcriptAvailable: true,
          },
        }
      : {
          type: kind === 'completed' || kind === 'interrupted'
            ? 'child.completed' : 'child.status',
          childExecutionId,
          ...(kind === 'completed' ? { outcome: 'completed' as const }
            : kind === 'interrupted' ? { outcome: 'interrupted' as const }
              : { state: 'running' as const }),
        };
    return [this.snapshotEnvelope(
      event,
      `child/${kind ?? 'activity'}`,
      binding.ownerNativeTurnId,
      childExecutionId,
      itemIndex,
    )];
  }

  private mapChildThreadNotification(
    method: string,
    params: Record<string, unknown>,
    childThreadId: string,
  ) {
    const binding = this.childRegistry.get(childThreadId);
    if (!binding || binding.parentExecutionId !== this.executionId) return [];
    const childExecutionId = binding.executionId;
    if (method === 'turn/completed') {
      const turn = record(params.turn);
      const nativeChildTurnId = string(turn?.id);
      if (!nativeChildTurnId) return [];
      const outcome = turnOutcome(turn?.status);
      const completed = this.childRegistry.completeAttempt(childThreadId, nativeChildTurnId, outcome);
      if (completed?.terminalNativeTurnId !== nativeChildTurnId || completed.outcome !== outcome) return [];
      return [this.envelope({
        type: 'child.completed',
        childExecutionId,
        outcome,
      }, 'child/completed', binding.ownerNativeTurnId, childExecutionId,
      `child-turn-${nativeChildTurnId}`, ++this.liveSequence)];
    }
    if (method === 'thread/started') return [];
    if (method === 'turn/started') {
      const nativeChildTurnId = string(record(params.turn)?.id);
      if (!nativeChildTurnId) return [];
      if (!this.childRegistry.beginAttempt(childThreadId, nativeChildTurnId)) return [];
      return [this.envelope({
        type: 'child.started',
        child: {
          executionId: childExecutionId,
          ownership: 'native',
          provider: 'codex',
          providerInstanceId: this.providerInstanceId,
          title: 'Codex subagent',
          nativeSessionId: childThreadId,
          transcriptAvailable: true,
        },
      }, 'child/started', binding.ownerNativeTurnId, childExecutionId,
      `turn-started-${nativeChildTurnId}`, ++this.liveSequence)];
    }
    return [];
  }

  private bindChild(childThreadId: string, ownerNativeTurnId: string): CodexChildBinding {
    return this.childRegistry.bindSpawn({
      nativeThreadId: childThreadId,
      executionId: codexStableChildExecutionId(this.executionId, childThreadId),
      parentExecutionId: this.executionId,
      nativeParentThreadId: this.nativeSessionId,
      ownerTurnId: this.remuxTurnId(ownerNativeTurnId),
      ownerNativeTurnId,
    });
  }

  private liveEnvelope(
    event: MapperEvent,
    kind: string,
    nativeTurnId?: string,
    itemId?: string,
  ) {
    return this.envelope(event, kind, nativeTurnId, itemId, `live-${++this.liveSequence}`, this.liveSequence);
  }

  private usageEnvelope(
    event: MapperEvent & { usage: unknown },
    nativeTurnId: string,
    remuxTurnId: string,
  ) {
    const nativeSequence = ++this.liveSequence;
    const usage = record(event.usage);
    const context = record(usage?.context);
    const { observedAt: _observedAt, ...stableContext } = context ?? {};
    // A mapper is recreated whenever a native session is resumed, so its
    // sequence starts over. Key usage by the provider payload instead of that
    // process-local sequence: identical restore probes deduplicate, while a
    // changed cached value (for example after native compaction) is persisted
    // even when it is anchored to the same latest visible turn.
    const usageIdentity = hashJson({
      type: event.type,
      usage: usage
        ? { ...usage, context: context ? stableContext : null }
        : null,
    }).slice(0, 24);
    const envelope = parseProviderEventEnvelope({
      contractVersion: PROVIDER_RUNTIME_CONTRACT_VERSION,
      eventId: stableEventId(
        this.nativeSessionId,
        nativeTurnId,
        undefined,
        'thread/tokenUsage/updated',
        `usage-${usageIdentity}`,
      ),
      provider: 'codex',
      scope: {
        kind: 'turn',
        providerInstanceId: this.providerInstanceId,
        conversationId: this.conversationId,
        executionId: this.executionId,
        turnId: remuxTurnId,
      },
      native: {
        sessionId: this.nativeSessionId,
        turnId: nativeTurnId,
        position: { kind: 'native-sequence', sequence: nativeSequence, subIndex: 0 },
        kind: 'thread/tokenUsage/updated',
      },
      observedAt: this.observedAt(),
      event: this.normalizeEvent(event, nativeTurnId),
    });
    return envelope;
  }

  private compactionEnvelope(
    event: Extract<ProviderEvent, { type: `context.compaction.${string}` }>,
    kind: string,
    nativeTurnId?: string,
    itemId?: string,
    itemIndex?: number,
    compactionOrdinal?: number,
    timeline?: NativeTimelineBoundary,
  ) {
    const phase = event.type.slice('context.compaction.'.length);
    const subject = nativeTurnId && compactionOrdinal !== undefined
      ? this.compactionSubject(nativeTurnId, compactionOrdinal)
      : undefined;
    const observedAt = this.observedAt();
    const buildEnvelope = (candidate: ProviderEvent) => ({
      contractVersion: PROVIDER_RUNTIME_CONTRACT_VERSION,
      // App Server item ids are not durable: the live stream reports a UUID,
      // while thread/read synthesizes positional ids such as `item-43`. Key
      // canonical compaction controls by their occurrence within the native
      // turn so live delivery and a resumed snapshot converge on one event.
      eventId: compactionOrdinal === undefined
        ? stableEventId(this.nativeSessionId, nativeTurnId, itemId, kind, '')
        : stableEventId(
            this.conversationId,
            nativeTurnId,
            undefined,
            `context/compaction/${phase}`,
            `occurrence-${compactionOrdinal}`,
          ),
      provider: 'codex',
      scope: {
        kind: 'conversation',
        providerInstanceId: this.providerInstanceId,
        conversationId: this.conversationId,
        executionId: this.executionId,
      },
      native: {
        sessionId: this.nativeSessionId,
        ...(nativeTurnId ? { turnId: nativeTurnId } : {}),
        ...(itemId ? { itemId } : {}),
        ...(itemIndex === undefined
          ? {}
          : { position: { kind: 'snapshot-index', itemIndex, subIndex: 0 } }),
        ...(subject ? { subject: { kind: 'context-compaction', key: subject } } : {}),
        ...(timeline ? { timeline } : {}),
        kind,
      },
      observedAt,
      event: candidate,
    });
    const fitted = fitProviderEventDisplay({
      event,
      maxBytes: PROVIDER_RUNTIME_LIMITS.eventBytes,
      buildEnvelope,
      hashJson,
    });
    return parseProviderEventEnvelope(buildEnvelope(fitted));
  }

  private compactionOrdinal(
    nativeTurnId: string,
    itemId: string,
    hint?: number,
  ) {
    const itemIdentity = `${nativeTurnId}\0${itemId}`;
    const existing = this.compactionOrdinalByItem.get(itemIdentity);
    if (existing !== undefined) return existing;
    const next = this.nextCompactionOrdinalByTurn.get(nativeTurnId) ?? 0;
    const ordinal = hint ?? next;
    this.compactionOrdinalByItem.set(itemIdentity, ordinal);
    this.nextCompactionOrdinalByTurn.set(nativeTurnId, Math.max(next, ordinal + 1));
    return ordinal;
  }

  private compactionOperation(
    nativeTurnId: string,
    ordinal: number,
    claimPendingManual: boolean,
  ) {
    const occurrenceIdentity = `${nativeTurnId}\0${ordinal}`;
    const existing = this.compactionOperationByOccurrence.get(occurrenceIdentity);
    if (existing) return existing;
    const pendingManualCompactionId = claimPendingManual ? this.pendingManualCompactionId : null;
    const operation = pendingManualCompactionId
      ? { operationId: pendingManualCompactionId, trigger: 'manual' as const }
      : {
          operationId: `codex-auto-compact-${digest([
            this.conversationId, nativeTurnId, `occurrence-${ordinal}`,
          ].join('\0')).slice(0, 24)}`,
          trigger: 'automatic' as const,
        };
    this.compactionOperationByOccurrence.set(occurrenceIdentity, operation);
    return operation;
  }

  private compactionSubject(nativeTurnId: string, ordinal: number) {
    return `codex:context-compaction:${nativeTurnId}:${ordinal}`;
  }

  private seedDeltaOffset(
    nativeTurnId: string,
    itemId: string,
    kind: 'assistant' | 'commentary' | 'reasoning',
    offset: number,
  ) {
    const key = `${nativeTurnId}:${itemId}:${kind}`;
    this.deltaOffsets.set(key, Math.max(this.deltaOffsets.get(key) ?? 0, offset));
  }

  private flushPendingAgentMessage(
    nativeTurnId: string,
    itemId: string,
    kind: AgentMessageStreamKind,
  ) {
    const identity = agentMessageIdentity(nativeTurnId, itemId);
    const delta = this.pendingAgentMessageDeltas.get(identity);
    if (!delta) return [];
    this.pendingAgentMessageDeltas.delete(identity);
    return this.mapTextDelta({ turnId: nativeTurnId, itemId, delta }, kind);
  }

  private clearAgentMessageState(nativeTurnId: string) {
    const prefix = `${nativeTurnId}\0`;
    for (const identity of this.agentMessageKinds.keys()) {
      if (identity.startsWith(prefix)) this.agentMessageKinds.delete(identity);
    }
    for (const identity of this.pendingAgentMessageDeltas.keys()) {
      if (identity.startsWith(prefix)) this.pendingAgentMessageDeltas.delete(identity);
    }
  }

  private snapshotEnvelope(
    event: MapperEvent,
    kind: string,
    nativeTurnId?: string,
    itemId?: string,
    itemIndex?: number,
  ) {
    // Live item lifecycle notifications have stable item identity but no
    // snapshot index. Preserve their replay-stable event ID while recording
    // the native delivery position, so a new turn does not become
    // `live-provisional` merely because its terminal snapshot arrives later.
    const nativeSequence = itemIndex === undefined && itemId
      ? ++this.liveSequence
      : undefined;
    return this.envelope(
      event,
      kind,
      nativeTurnId,
      itemId,
      `snapshot-${hashJson(event).slice(0, 16)}`,
      nativeSequence,
      false,
      itemIndex,
    );
  }

  private envelope(
    event: MapperEvent,
    kind: string,
    nativeTurnId?: string,
    itemId?: string,
    discriminator = '',
    nativeSequence?: number,
    turnAlreadyRemux = false,
    itemIndex?: number,
  ) {
    const remuxTurnId = nativeTurnId
      ? (turnAlreadyRemux ? nativeTurnId : this.remuxTurnId(nativeTurnId))
      : undefined;
    const normalized = this.normalizeEvent(event, nativeTurnId, itemId, itemIndex);
    const observedAt = this.observedAt();
    const buildEnvelope = (candidate: ProviderEvent) => ({
      contractVersion: PROVIDER_RUNTIME_CONTRACT_VERSION,
      eventId: stableEventId(
        this.nativeSessionId,
        nativeTurnId,
        itemId,
        kind,
        discriminator,
      ),
      provider: 'codex',
      scope: remuxTurnId ? {
        kind: 'turn',
        providerInstanceId: this.providerInstanceId,
        conversationId: this.conversationId,
        executionId: this.executionId,
        turnId: remuxTurnId,
      } : {
        kind: 'conversation',
        providerInstanceId: this.providerInstanceId,
        conversationId: this.conversationId,
        executionId: this.executionId,
      },
      native: {
        sessionId: this.nativeSessionId,
        ...(nativeTurnId && !turnAlreadyRemux ? { turnId: nativeTurnId } : {}),
        ...(itemId ? { itemId } : {}),
        ...(nativeSequence === undefined && itemIndex === undefined ? {} : {
          position: itemIndex === undefined
            ? { kind: 'native-sequence', sequence: nativeSequence!, subIndex: 0 }
            : { kind: 'snapshot-index', itemIndex, subIndex: 0 },
        }),
        kind,
      },
      observedAt,
      event: candidate,
    });
    const fitted = fitProviderEventDisplay({
      event: normalized,
      maxBytes: PROVIDER_RUNTIME_LIMITS.eventBytes,
      buildEnvelope,
      hashJson,
    });
    const envelope = parseProviderEventEnvelope(buildEnvelope(fitted));
    this.commitReasoningParts(event, nativeTurnId, itemId);
    this.commitBlockEvent(envelope.event, nativeTurnId, itemId);
    return envelope;
  }

  private normalizeEvent(
    input: MapperEvent,
    nativeTurnId?: string,
    itemId?: string,
    itemIndex?: number,
  ): ProviderEvent {
    const event = input as Record<string, unknown> & { type: string };
    switch (event.type) {
      case 'assistant.reasoning': {
        const completed = event.summary !== undefined;
        const reasoningKey = this.blockKey(nativeTurnId, itemId, 'reasoning-summary');
        const previous = this.blocks.get(this.blockKey(nativeTurnId, itemId, 'reasoning-summary'));
        const previousPayload = previous?.block.payload.kind === 'reasoning-summary'
          ? previous.block.payload
          : undefined;
        const completedParts = arrayOfStrings(event.parts);
        if (!completed && previousPayload?.truncated) {
          return this.blockEvent(
            nativeTurnId, itemId, itemIndex, 'reasoning-summary', previousPayload, 'streaming', false,
          );
        }
        const parts = completed
          ? (completedParts.length > 0
              ? completedParts
              : [string(event.summary) ?? ''])
          : [...(this.reasoningParts.get(reasoningKey) ?? [])];
        if (!completed) {
          const partIndex = nonnegative(event.partIndex) ?? 0;
          if (partIndex >= 256) {
            const boundedParts = (previousPayload?.parts ?? []).slice(0, 256);
            if (boundedParts.length === 0) boundedParts.push(DISPLAY_TRUNCATION_MARKER);
            else boundedParts[boundedParts.length - 1] = `${boundedParts.at(-1)}${DISPLAY_TRUNCATION_MARKER}`;
            return this.blockEvent(nativeTurnId, itemId, itemIndex, 'reasoning-summary', {
              kind: 'reasoning-summary',
              text: boundedParts.join('\n'),
              parts: boundedParts,
              truncated: true,
            }, 'streaming', false);
          }
          while (parts.length <= partIndex) parts.push('');
          parts[partIndex] = `${parts[partIndex] ?? ''}${string(event.delta) ?? ''}`;
        }
        const visibleParts = parts.filter((part) => part.length > 0);
        return this.blockEvent(nativeTurnId, itemId, itemIndex, 'reasoning-summary', {
          kind: 'reasoning-summary',
          text: visibleParts.join('\n'),
          ...(visibleParts.length > 0 ? { parts: visibleParts } : {}),
          truncated: completed ? false : previousPayload?.truncated ?? false,
        }, completed ? 'completed' : 'streaming', completed);
      }
      case 'assistant.text': {
        const kind = event.phase === 'commentary' ? 'commentary' : 'final-message';
        const text = string(event.text) ?? string(event.delta) ?? '';
        return this.textBlockEvent(nativeTurnId, itemId, itemIndex, kind, text, event.text !== undefined);
      }
      case 'tool.started': {
        const tool = event.tool as Extract<TurnBlockPayload, { kind: 'tool' }>['tool'];
        const callId = itemId ?? tool.callId;
        const previous = this.blocks.get(this.blockKey(nativeTurnId, callId, 'tool'));
        const payload = previous?.block.payload.kind === 'tool'
          ? previous.block.payload
          : { kind: 'tool' as const, tool };
        return this.blockEvent(nativeTurnId, itemId ?? tool.callId, itemIndex, 'tool', {
          ...payload,
          tool,
          ...(event.inputPreview === undefined
            ? {}
            : { inputPreview: fitJsonPreview(event.inputPreview) }),
        }, 'running', false);
      }
      case 'tool.updated': {
        const callId = string(event.toolCallId) ?? itemId;
        const previous = this.blocks.get(this.blockKey(nativeTurnId, callId, 'tool'));
        const payload = previous?.block.payload.kind === 'tool'
          ? previous.block.payload
          : {
              kind: 'tool' as const,
              tool: { callId: callId ?? 'unknown', name: 'tool', category: 'other' as const },
            };
        return this.blockEvent(nativeTurnId, callId, itemIndex, 'tool', {
          ...payload,
          ...(event.outputPreview === undefined ? {} : {
            outputPreview: event.replaceOutputPreview === true
              ? mergeJsonPreview(undefined, event.outputPreview as JsonValue)
              : mergeJsonPreview(payload.outputPreview, event.outputPreview as JsonValue),
          }),
        }, 'running', false);
      }
      case 'tool.completed': {
        const callId = string(event.toolCallId) ?? itemId;
        const previous = this.blocks.get(this.blockKey(nativeTurnId, callId, 'tool'));
        const payload = previous?.block.payload.kind === 'tool'
          ? previous.block.payload
          : {
              kind: 'tool' as const,
              tool: { callId: callId ?? 'unknown', name: 'tool', category: 'other' as const },
            };
        return this.blockEvent(
          nativeTurnId,
          callId,
          itemIndex,
          'tool',
          {
            ...payload,
            ...(string(event.detailRef) ? { detailRef: string(event.detailRef)! } : {}),
          },
          event.outcome === 'failed' ? 'failed' : 'completed',
          true,
        );
      }
      case 'file.changed':
        return { type: 'turn.file-changed', change: event.change as ProviderFileChange,
          ...(itemId ? { blockId: this.blockId(nativeTurnId, itemId, 'tool') } : {}) };
      case 'web.activity':
        return this.blockEvent(nativeTurnId, itemId, itemIndex, 'web', {
          kind: 'web',
          activity: event.activity as Extract<TurnBlockPayload, { kind: 'web' }>['activity'],
        }, 'completed', true);
      case 'child.started': {
        const child = event.child as ChildExecutionDisplay;
        return this.blockEvent(nativeTurnId, child.executionId, itemIndex, 'native-child', {
          kind: 'native-child', child, executionState: 'running',
        }, 'running', false);
      }
      case 'child.status':
      case 'child.summary':
      case 'child.completed': {
        const childExecutionId = string(event.childExecutionId) ?? itemId;
        const key = this.blockKey(nativeTurnId, childExecutionId, 'native-child');
        const previous = this.blocks.get(key);
        const payload = previous?.block.payload.kind === 'native-child'
          ? previous.block.payload
          : {
              kind: 'native-child' as const,
              child: {
                executionId: childExecutionId ?? 'unknown',
                ownership: 'native' as const,
                provider: 'codex' as const,
                providerInstanceId: this.providerInstanceId,
              },
              executionState: 'running' as const,
            };
        const completed = event.type === 'child.completed';
        const outcome = completed ? event.outcome as ProviderTurnOutcome : payload.outcome;
        const executionState = event.type === 'child.status'
          ? event.state as Extract<TurnBlockPayload, { kind: 'native-child' }>['executionState']
          : completed
            ? outcome === 'completed' ? 'idle' : outcome === 'interrupted' ? 'interrupted' : 'failed'
            : payload.executionState;
        return this.blockEvent(nativeTurnId, childExecutionId, itemIndex, 'native-child', {
          ...payload,
          executionState,
          ...(event.type === 'child.summary' && string(event.summary)
            ? { summary: string(event.summary)! }
            : {}),
          ...(outcome ? { outcome } : {}),
        }, completed
          ? outcome === 'completed' ? 'completed' : outcome === 'interrupted' ? 'interrupted' : 'failed'
          : 'running', completed);
      }
      case 'context.compacted': {
        const operationId = `codex-auto-compact-${digest([
          this.conversationId, nativeTurnId, itemId ?? 'thread',
        ].join('\0')).slice(0, 24)}`;
        return {
          type: 'context.compaction.completed',
          trigger: 'automatic',
          operationId,
          beforeTokens: null,
          afterTokens: null,
        };
      }
      case 'usage.updated':
        return { type: 'turn.usage-updated', usage: event.usage as never };
      case 'compatibility.notice':
        return this.blockEvent(nativeTurnId, itemId ?? `notice-${hashJson(event).slice(0, 12)}`, itemIndex,
          'compatibility-notice', {
            kind: 'compatibility-notice',
            code: String(event.code),
            message: String(event.message),
          }, 'completed', true);
      default:
        return input as ProviderEvent;
    }
  }

  private commitReasoningParts(event: MapperEvent, nativeTurnId?: string, itemId?: string) {
    if (event.type !== 'assistant.reasoning') return;
    const source = event as Record<string, unknown>;
    const key = this.blockKey(nativeTurnId, itemId, 'reasoning-summary');
    if (source.summary !== undefined) {
      this.reasoningParts.delete(key);
      return;
    }
    const committed = this.blocks.get(key);
    if (committed?.block.payload.kind === 'reasoning-summary' && committed.block.payload.truncated) return;
    const parts = [...(this.reasoningParts.get(key) ?? [])];
    const partIndex = nonnegative(source.partIndex) ?? 0;
    if (partIndex >= 256) return;
    while (parts.length <= partIndex) parts.push('');
    const retainedChars = parts.reduce((sum, part) => sum + [...part].length, 0);
    const available = Math.max(0, PROVIDER_RUNTIME_LIMITS.messageChars - retainedChars);
    parts[partIndex] = `${parts[partIndex] ?? ''}${[...(string(source.delta) ?? '')].slice(0, available).join('')}`;
    this.reasoningParts.set(key, parts);
  }

  private textBlockEvent(
    nativeTurnId: string | undefined,
    itemId: string | undefined,
    itemIndex: number | undefined,
    kind: 'reasoning-summary' | 'commentary' | 'final-message',
    text: string,
    completed: boolean,
  ) {
    const previous = this.blocks.get(this.blockKey(nativeTurnId, itemId, kind));
    const previousText = previous?.block.payload.kind === kind ? previous.block.payload.text : '';
    return this.blockEvent(
      nativeTurnId,
      itemId,
      itemIndex,
      kind,
      kind === 'reasoning-summary'
        ? { kind, text: completed ? text : `${previousText}${text}`, truncated: false }
        : { kind, text: completed ? text : `${previousText}${text}` },
      completed ? 'completed' : 'streaming',
      completed,
    );
  }

  private blockEvent(
    nativeTurnId: string | undefined,
    itemId: string | undefined,
    itemIndex: number | undefined,
    kind: TurnBlockKind,
    payload: TurnBlockPayload,
    state: TurnBlockSnapshot['state'],
    completed: boolean,
  ): ProviderEvent {
    const key = this.blockKey(nativeTurnId, itemId, kind);
    const previous = this.blocks.get(key);
    const structure = previous?.structure ?? this.structure(nativeTurnId, itemId, kind, itemIndex);
    const revision = previous ? previous.revision + 1 : completed ? 1 : 0;
    const block = { kind, state, payload } as TurnBlockSnapshot;
    if (!previous && !completed) return { type: 'turn.block.started', structure, block };
    const contentHash = hashJson(block);
    return completed
      ? { type: 'turn.block.completed', structure, revision, contentHash, block }
      : { type: 'turn.block.revised', structure, revision, contentHash, block };
  }

  private structure(
    nativeTurnId: string | undefined,
    itemId: string | undefined,
    kind: TurnBlockKind,
    itemIndex?: number,
  ): TurnStructure {
    const turn = nativeTurnId ?? 'conversation';
    const next = this.nextOrdinalByTurn.get(turn) ?? 0;
    const blockOrdinal = itemIndex ?? next;
    return {
      passId: `codex-pass-${digest(`${this.nativeSessionId}\0${turn}`).slice(0, 24)}`,
      blockId: this.blockId(nativeTurnId, itemId, kind),
      passOrdinal: 0,
      blockOrdinal,
    };
  }

  private commitBlockEvent(
    event: ProviderEvent,
    nativeTurnId: string | undefined,
    itemId: string | undefined,
  ) {
    if (event.type !== 'turn.block.started' &&
        event.type !== 'turn.block.revised' &&
        event.type !== 'turn.block.completed') return;
    const identity = event.block.payload.kind === 'tool'
      ? event.block.payload.tool.callId
      : event.block.payload.kind === 'native-child' || event.block.payload.kind === 'federated-child'
        ? event.block.payload.child.executionId
        : itemId;
    const key = this.blockKey(nativeTurnId, identity, event.block.kind);
    const revision = event.type === 'turn.block.started' ? 0 : event.revision;
    this.blocks.set(key, {
      structure: event.structure,
      block: event.block,
      revision,
    });
    const turn = nativeTurnId ?? 'conversation';
    const next = this.nextOrdinalByTurn.get(turn) ?? 0;
    this.nextOrdinalByTurn.set(turn, Math.max(next, event.structure.blockOrdinal + 1));
  }

  private blockKey(nativeTurnId: string | undefined, itemId: string | undefined, kind: TurnBlockKind) {
    const identityKind = codexBlockIdentityKind(kind);
    return `${nativeTurnId ?? 'conversation'}\0${itemId ?? identityKind}\0${identityKind}`;
  }

  private blockId(nativeTurnId: string | undefined, itemId: string | undefined, kind: TurnBlockKind) {
    const identityKind = codexBlockIdentityKind(kind);
    return `codex-block-${digest([
      this.nativeSessionId, nativeTurnId ?? 'conversation', itemId ?? identityKind, identityKind,
    ].join('\0')).slice(0, 32)}`;
  }
}

function codexBlockIdentityKind(kind: TurnBlockKind) {
  // Keep both text phases on one native identity so an authoritative snapshot
  // can still repair malformed, legacy, or reordered provider streams in place.
  return kind === 'commentary' || kind === 'final-message'
    ? 'assistant-text'
    : kind;
}

function agentMessageIdentity(nativeTurnId: string, itemId: string) {
  return `${nativeTurnId}\0${itemId}`;
}

function agentMessageStreamKind(value: unknown): AgentMessageStreamKind | undefined {
  if (value === 'commentary') return 'commentary';
  if (value === 'final_answer') return 'assistant';
  return undefined;
}

function threadIdFromNotification(method: string, params: Record<string, unknown>) {
  if (method === 'thread/started') return string(record(params.thread)?.id);
  return string(params.threadId);
}

function mapCodexUserContent(value: unknown): UserContentPart[] {
  const item = record(value);
  const type = string(item?.type);
  if (!item || !type) return [];
  if (type === 'text') {
    const text = string(item.text);
    return text ? [{ type: 'text', text }] : [];
  }
  if (type === 'localImage') {
    const path = string(item.path);
    return path ? [{ type: 'file-reference', path }] : [];
  }
  if (type === 'mention' || type === 'skill') {
    const path = string(item.path);
    return path ? [{ type: 'file-reference', path }] : [];
  }
  if (type === 'image') {
    const url = string(item.url);
    return url ? [{
      type: 'text',
      text: url.startsWith('data:') ? '[Attached image]' : `[Attached image: ${url}]`,
    }] : [];
  }
  if (type === 'remuxImageArtifact') {
    const artifactId = string(item.artifactId);
    const mimeType = string(item.mimeType);
    const byteLength = nonnegative(item.byteLength);
    return artifactId && mimeType ? [{
      type: 'image-artifact',
      artifactId,
      mimeType,
      ...(byteLength === undefined ? {} : { byteLength }),
    }] : [];
  }
  return [];
}

function mapFileChange(value: unknown): ProviderFileChange[] {
  const change = record(value);
  const path = string(change?.path);
  const kind = record(change?.kind);
  const kindType = string(change?.kind) ?? string(kind?.type);
  const diff = string(change?.diff) ?? string(kind?.unified_diff);
  if (!path || !kindType) return [];
  if (kindType === 'add' || kindType === 'delete') {
    return [{ path, kind: kindType, ...(diff ? { diff } : {}) }];
  }
  if (kindType === 'update') {
    const oldPath = string(kind?.move_path);
    return [{
      path,
      kind: oldPath ? 'move' : 'update',
      ...(oldPath ? { oldPath } : {}),
      ...(diff ? { diff } : {}),
    }];
  }
  return [];
}

function fileChangeStartedEvent(
  itemId: string,
  changes: readonly ProviderFileChange[],
  completed: boolean,
): MapperEvent {
  const names = [...new Set(changes.map(({ path }) => fileName(path)).filter(Boolean))];
  const verb = completed ? 'Edited' : 'Editing';
  const title = names.length === 1
    ? `${verb} ${names[0]}`
    : names.length > 1 ? `${verb} ${names.length} files` : `${verb} files`;
  return {
    type: 'tool.started',
    tool: { callId: itemId, name: 'file_change', category: 'file', title },
    inputPreview: { paths: changes.map(({ path }) => path) },
  };
}

function displayShellCommand(command: string) {
  const trimmed = command.trim();
  const match = /^(?:\/usr\/bin\/|\/bin\/)?(?:ba|z|)sh\s+-(?:l?c|cl)\s+(['"])([\s\S]*)\1$/u.exec(trimmed);
  if (!match?.[2]) return trimmed;
  return match[1] === "'" ? match[2].replace(/'\\''/gu, "'") : match[2];
}


function fileName(path: string) {
  return path.replace(/\\/gu, '/').split('/').filter(Boolean).at(-1) ?? path;
}

function turnOutcome(value: unknown): ProviderTurnOutcome {
  return value === 'completed'
    ? 'completed'
    : value === 'interrupted'
      ? 'interrupted'
      : 'failed';
}

function childStatus(value: string): 'running' | 'recovering' | 'idle' | 'failed' | 'interrupted' {
  if (value === 'completed' || value === 'shutdown') return 'idle';
  if (value === 'interrupted') return 'interrupted';
  if (value === 'errored' || value === 'notFound') return 'failed';
  if (value === 'pendingInit') return 'recovering';
  return 'running';
}

export function codexStableNativeTurnId(nativeTurnId: string) {
  return `codex-turn-${digest(nativeTurnId).slice(0, 24)}`;
}

export function codexStableChildExecutionId(parentExecutionId: string, nativeThreadId: string) {
  return `${parentExecutionId}:codex-child-${digest(nativeThreadId).slice(0, 20)}`;
}

function stableEventId(
  sessionId: string,
  turnId: string | undefined,
  itemId: string | undefined,
  kind: string,
  discriminator: string,
) {
  return `codex-event-${digest([sessionId, turnId, itemId, kind, discriminator].join('\0'))}`;
}

function hashJson(value: unknown) {
  return digest(JSON.stringify(value));
}

function digest(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function dedupe(events: readonly ProviderEventEnvelope[]) {
  return [...new Map(events.map((event) => [event.eventId, event])).values()];
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function string(value: unknown) {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function nonnegative(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function tokenBreakdown(value: Record<string, unknown>) {
  return {
    inputTokens: nonnegative(value.inputTokens) ?? null,
    cachedInputTokens: nonnegative(value.cachedInputTokens) ?? null,
    cacheWriteInputTokens: nonnegative(value.cacheWriteInputTokens) ?? null,
    outputTokens: nonnegative(value.outputTokens) ?? null,
    reasoningOutputTokens: nonnegative(value.reasoningOutputTokens) ?? null,
    totalTokens: nonnegative(value.totalTokens) ?? null,
  };
}

export function normalizeCodexAccountUsage(
  value: unknown,
  source: ProviderAccountUsage['source'],
  observedAt: number,
): ProviderAccountUsage {
  const response = record(value);
  const primarySnapshot = record(response?.rateLimits) ?? response;
  const byLimitId = record(response?.rateLimitsByLimitId);
  const snapshots = [
    primarySnapshot,
    ...Object.values(byLimitId ?? {}).map(record),
  ].filter((snapshot): snapshot is Record<string, unknown> => Boolean(snapshot));
  const windowsById = new Map<string, AccountUsageWindow>();
  for (const snapshot of snapshots) {
    const limitId = string(snapshot.limitId) ?? 'codex';
    const model = string(snapshot.limitName) ?? null;
    const windows = [
      codexUsageWindow(record(snapshot.primary), `${limitId}:primary`, 'Primary limit', model),
      codexUsageWindow(record(snapshot.secondary), `${limitId}:secondary`, 'Secondary limit', model),
    ].filter((window): window is NonNullable<typeof window> => Boolean(window));
    for (const window of windows) windowsById.set(window.id, window);
  }
  const windows = [...windowsById.values()];
  return {
    availability: windows.length > 0 ? 'available' : 'unknown',
    windows,
    source,
    freshness: 'live',
    observedAt,
  };
}

function codexUsageWindow(
  value: Record<string, unknown> | null,
  id: string,
  fallbackLabel: string,
  model: string | null,
) {
  const usedPercent = nonnegative(value?.usedPercent);
  if (usedPercent === undefined) return null;
  const duration = nonnegative(value?.windowDurationMins);
  const kind = duration !== undefined && duration >= 7 * 24 * 60 ? 'weekly' as const : 'rolling' as const;
  const label = formatCodexWindowLabel(duration, fallbackLabel);
  const resetsAt = nonnegative(value?.resetsAt);
  return {
    id,
    label,
    kind,
    model,
    usedPercent: Math.min(100, usedPercent),
    resetsAt: resetsAt === undefined ? null : resetsAt * 1_000,
  };
}

function formatCodexWindowLabel(durationMins: number | undefined, fallbackLabel: string) {
  if (!durationMins) return fallbackLabel;
  const weekMins = 7 * 24 * 60;
  const dayMins = 24 * 60;
  if (durationMins === weekMins) return 'Weekly';
  if (durationMins % weekMins === 0) {
    const weeks = durationMins / weekMins;
    return `${weeks} weeks`;
  }
  if (durationMins % dayMins === 0) {
    const days = durationMins / dayMins;
    return `${days} ${days === 1 ? 'day' : 'days'}`;
  }
  if (durationMins % 60 === 0) {
    const hours = durationMins / 60;
    return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  }
  return `${durationMins} min`;
}

function arrayOfStrings(value: unknown) {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}
