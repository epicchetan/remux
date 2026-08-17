import {
  DEFAULT_TURN_CONTEXT_DIALOGUE_TURNS,
  type TurnContextPlan,
} from '../../../shared/protocol.ts';
import {
  logicalMessageSemanticValue,
  type LogicalContextMessage,
} from '../logical-context.ts';
import type { ProviderCompactionCheckpoint } from './compaction.ts';
import { canonicalJson, canonicalJsonHash } from '../storage/canonical-json.ts';
import {
  CONTEXT_COMPILER_VERSION,
  CONTEXT_POLICY_VERSION,
  type ContextOmission,
  type ResolvedTurnContextSource,
  type TurnContextFrameCandidate,
  type TurnContextLayer,
} from './manifest.ts';

export type TurnContextSource = {
  basisSequence: number;
  projectId: string;
  conversationId: string;
  turnId: string;
  scopeId: string;
  scopeKind: 'turn' | 'work_unit';
  contextPlan: TurnContextPlan;
  omittedPriorWorkUnits?: number;
  messages: readonly LogicalContextMessage[];
};

export type CompiledTurnContext = {
  frame: TurnContextFrameCandidate;
  messages: LogicalContextMessage[];
};

type TurnGroup = {
  turnId: string;
  messages: LogicalContextMessage[];
  dialogue: LogicalContextMessage[] | null;
};

/**
 * Compile explicit prior-turn selections plus the exact active execution scope.
 * The compiler never drops context for a token budget and never mutates the
 * user's requested plan.
 */
export function compileTurnContext(source: TurnContextSource): CompiledTurnContext {
  const requestedPlan = normalizeTurnContextPlan(source.contextPlan);
  const active = source.messages.filter((message) => message.turnId === source.turnId);
  if (!active.some((message) => message.role === 'user')) {
    throw new Error(`Turn context has no user message for active turn ${source.turnId}.`);
  }

  const priorGroups = groupPriorTurns(
    source.messages.filter((message) => message.turnId !== source.turnId),
  );
  const resolvedTurns = resolveTurnContextPlan(priorGroups, requestedPlan);
  const byTurn = new Map(priorGroups.map((group) => [group.turnId, group]));
  const selectedGroups = resolvedTurns.map((selection) => {
    const group = byTurn.get(selection.turnId);
    if (!group) throw new Error(`Selected context turn ${selection.turnId} is unavailable.`);
    const messages = selection.resolution === 'dialogue' ? group.dialogue : group.messages;
    if (!messages) throw new Error(`Selected context turn ${selection.turnId} has no visible dialogue.`);
    return { selection, messages };
  });
  const selectedMessages = selectedGroups.flatMap((group) => group.messages);
  const messages = [...selectedMessages, ...active];
  const orderedMessageHashes = messages.map((message) =>
    canonicalJsonHash(logicalMessageSemanticValue(message)));

  const dialogueMessages = selectedGroups
    .filter(({ selection }) => selection.resolution === 'dialogue')
    .flatMap(({ messages: selected }) => selected);
  const fullMessages = selectedGroups
    .filter(({ selection }) => selection.resolution === 'full')
    .flatMap(({ messages: selected }) => selected);
  const layers: TurnContextLayer[] = [
    contextLayer('selected_dialogue', dialogueMessages, resolvedTurns
      .filter(({ resolution }) => resolution === 'dialogue')
      .map(({ turnId }) => `history://turn/${encodeURIComponent(turnId)}`)),
    contextLayer('selected_full_turns', fullMessages, resolvedTurns
      .filter(({ resolution }) => resolution === 'full')
      .map(({ turnId }) => `history://turn/${encodeURIComponent(turnId)}`)),
    contextLayer('active_scope', active, [
      `history://turn/${encodeURIComponent(source.turnId)}`,
      `history://scope/${encodeURIComponent(source.scopeId)}`,
    ]),
  ];
  const selectedIds = new Set(resolvedTurns.map(({ turnId }) => turnId));
  const omittedTurns = priorGroups.filter(({ turnId }) => !selectedIds.has(turnId)).length;
  const omissions: ContextOmission[] = [
    ...(omittedTurns > 0 ? [{
      source: `agent://conversation/${encodeURIComponent(source.conversationId)}/turns`,
      reason: 'not-selected' as const,
      retrieval: `history://conversation/${encodeURIComponent(source.conversationId)}`,
      count: omittedTurns,
    }] : []),
    ...((source.omittedPriorWorkUnits ?? 0) > 0 ? [{
      source: `agent://conversation/${encodeURIComponent(source.conversationId)}/work-units`,
      reason: 'prior-work-unit-trace' as const,
      retrieval: `history://conversation/${encodeURIComponent(source.conversationId)}`,
      count: source.omittedPriorWorkUnits!,
    }] : []),
  ];
  const estimatedInputTokens = estimateMessagesTokens(messages);
  const semanticHash = canonicalJsonHash({
    basisSequence: source.basisSequence,
    compilerVersion: CONTEXT_COMPILER_VERSION,
    orderedMessageHashes,
    policyVersion: CONTEXT_POLICY_VERSION,
    requestedPlan,
    resolvedTurns,
  });

  return {
    messages,
    frame: {
      compilerVersion: CONTEXT_COMPILER_VERSION,
      policyVersion: CONTEXT_POLICY_VERSION,
      basisSequence: source.basisSequence,
      requestedPlan,
      resolvedTurns,
      semanticHash,
      estimatedInputTokens,
      orderedMessageHashes,
      selectedTurnIds: [...resolvedTurns.map(({ turnId }) => turnId), source.turnId],
      scopeKind: source.scopeKind,
      layers,
      omissions,
    },
  };
}

/**
 * Compile only activity after an installed provider-native checkpoint. The
 * checkpoint already represents every selected turn and active-scope item at
 * compactedThroughSequence, while the journal remains complete for History.
 */
export function compileCompactedTurnContext(
  source: TurnContextSource,
  checkpoint: ProviderCompactionCheckpoint,
): CompiledTurnContext {
  const requestedPlan = normalizeTurnContextPlan(source.contextPlan);
  const messages = [...source.messages];
  const orderedMessageHashes = messages.map((message) =>
    canonicalJsonHash(logicalMessageSemanticValue(message)));
  const active = messages.filter((message) => message.turnId === source.turnId);
  const checkpointValue = {
    epoch: checkpoint.epoch,
    inputHash: checkpoint.inputHash,
    installedSequence: checkpoint.installedSequence,
    compactedThroughSequence: checkpoint.compactedThroughSequence,
  };
  const checkpointTokens = checkpoint.retainedInputTokens + (checkpoint.usage.outputTokens ?? 0);
  const layers: TurnContextLayer[] = [
    {
      kind: 'provider_checkpoint',
      estimatedTokens: checkpointTokens,
      hash: canonicalJsonHash(checkpointValue),
      sources: [`history://compaction/${encodeURIComponent(String(checkpoint.installedSequence))}`],
    },
    contextLayer('active_scope', active, [
      `history://turn/${encodeURIComponent(source.turnId)}`,
      `history://scope/${encodeURIComponent(source.scopeId)}`,
    ]),
  ];
  const estimatedInputTokens = checkpointTokens + estimateMessagesTokens(messages);
  return {
    messages,
    frame: {
      compilerVersion: CONTEXT_COMPILER_VERSION,
      policyVersion: CONTEXT_POLICY_VERSION,
      basisSequence: source.basisSequence,
      requestedPlan,
      resolvedTurns: checkpoint.resolvedTurns,
      semanticHash: canonicalJsonHash({
        basisSequence: source.basisSequence,
        checkpoint: checkpointValue,
        orderedMessageHashes,
        policyVersion: CONTEXT_POLICY_VERSION,
        requestedPlan,
      }),
      estimatedInputTokens,
      orderedMessageHashes,
      selectedTurnIds: checkpoint.selectedTurnIds,
      scopeKind: source.scopeKind,
      layers,
      omissions: [],
    },
  };
}

export function normalizeTurnContextPlan(value: TurnContextPlan): TurnContextPlan {
  if (value.version !== 1) throw new TypeError('Turn context plan version must be 1.');
  if (!Number.isSafeInteger(value.automaticDialogueTurns) || value.automaticDialogueTurns < 0) {
    throw new TypeError('automaticDialogueTurns must be a non-negative safe integer.');
  }
  const seen = new Set<string>();
  const overrides = value.overrides.map((override, index) => {
    if (!override.turnId.trim()) throw new TypeError(`Context override ${index + 1} requires a turnId.`);
    if (seen.has(override.turnId)) throw new TypeError(`Context override ${override.turnId} is duplicated.`);
    seen.add(override.turnId);
    if (override.resolution !== 'off' && override.resolution !== 'dialogue' && override.resolution !== 'full') {
      throw new TypeError(`Context override ${override.turnId} has an invalid resolution.`);
    }
    return { turnId: override.turnId, resolution: override.resolution };
  });
  return { version: 1, automaticDialogueTurns: value.automaticDialogueTurns, overrides };
}

export function defaultTurnContextPlan(): TurnContextPlan {
  return {
    version: 1,
    automaticDialogueTurns: DEFAULT_TURN_CONTEXT_DIALOGUE_TURNS,
    overrides: [],
  };
}

export function resolveTurnContextPlan(
  groups: readonly Pick<TurnGroup, 'turnId' | 'dialogue'>[],
  plan: TurnContextPlan,
): ResolvedTurnContextSource[] {
  const eligible = groups.filter((group) => group.dialogue !== null);
  const automatic = new Set(
    (plan.automaticDialogueTurns === 0 ? [] : eligible.slice(-plan.automaticDialogueTurns))
      .map(({ turnId }) => turnId),
  );
  const overrides = new Map(plan.overrides.map((override) => [override.turnId, override.resolution]));
  const available = new Set(groups.map(({ turnId }) => turnId));
  for (const override of plan.overrides) {
    if (!available.has(override.turnId)) {
      throw new Error(`Context override references unavailable turn ${override.turnId}.`);
    }
  }
  return groups.flatMap(({ turnId, dialogue }): ResolvedTurnContextSource[] => {
    const explicit = overrides.get(turnId);
    const resolution = explicit ?? (automatic.has(turnId) ? 'dialogue' : 'off');
    if (resolution === 'off') return [];
    if (resolution === 'dialogue' && !dialogue) {
      throw new Error(`Context turn ${turnId} cannot be included as dialogue.`);
    }
    return [{
      turnId,
      resolution,
      origin: explicit === undefined ? 'automatic' : 'explicit',
    }];
  });
}

function groupPriorTurns(messages: readonly LogicalContextMessage[]): TurnGroup[] {
  const order: string[] = [];
  const groups = new Map<string, LogicalContextMessage[]>();
  for (const message of messages) {
    if (!groups.has(message.turnId)) {
      groups.set(message.turnId, []);
      order.push(message.turnId);
    }
    groups.get(message.turnId)!.push(message);
  }
  return order.map((turnId) => {
    const group = groups.get(turnId)!;
    return { turnId, messages: group, dialogue: dialogueProjection(group) };
  });
}

function dialogueProjection(group: readonly LogicalContextMessage[]): LogicalContextMessage[] | null {
  const user = group.find((message) => message.role === 'user');
  const assistant = [...group].reverse().find((message) =>
    message.role === 'assistant' && message.state === 'completed' && message.text.trim().length > 0);
  if (!user || !assistant || assistant.role !== 'assistant') return null;
  return [
    user,
    {
      ...assistant,
      reasoning: '',
      toolCalls: [],
      providerMessage: undefined,
    },
  ];
}

function contextLayer(
  kind: TurnContextLayer['kind'],
  messages: readonly LogicalContextMessage[],
  sources: readonly string[],
): TurnContextLayer {
  return {
    kind,
    estimatedTokens: estimateMessagesTokens(messages),
    hash: canonicalJsonHash(messages.map(logicalMessageSemanticValue)),
    sources,
  };
}

function estimateMessagesTokens(messages: readonly LogicalContextMessage[]) {
  if (messages.length === 0) return 0;
  return Math.max(1, Math.ceil(Buffer.byteLength(
    canonicalJson(messages.map(logicalMessageSemanticValue)),
    'utf8',
  ) / 4));
}
