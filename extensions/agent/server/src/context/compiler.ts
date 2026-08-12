import { createHash } from 'node:crypto';

import {
  logicalMessageSemanticValue,
  type LogicalContextMessage,
} from '../logical-context.ts';
import { canonicalJson, canonicalJsonHash } from '../storage/canonical-json.ts';
import {
  CONTEXT_COMPILER_VERSION,
  CONTEXT_POLICY_VERSION,
  type ContextOmission,
  type ThreadContextFrameCandidate,
  type ThreadContextLayer,
} from './manifest.ts';

export type ThreadContextSource = {
  basisSequence: number;
  projectId: string;
  conversationId: string;
  strandId: string;
  turnId: string;
  scopeId: string;
  scopeKind: 'turn' | 'work_unit';
  threadVersionId: string;
  threadMarkdown: string;
  messages: readonly LogicalContextMessage[];
  pressureNoticed: boolean;
};

export type ThreadContextProfile = {
  contextWindow: number;
  recentDialogueTokens?: number;
};

export type CompiledThreadContext = {
  frame: ThreadContextFrameCandidate;
  messages: LogicalContextMessage[];
};

/**
 * Completed turns contribute only exact user/visible-assistant pairs. Active
 * scope scratch stays exact, while all omitted internals remain cold in the
 * journal. The mutable thread document is rendered between recent dialogue
 * and the active turn by the provider adapter.
 */
export function compileThreadContext(
  source: ThreadContextSource,
  profile: ThreadContextProfile,
): CompiledThreadContext {
  assertPositiveInteger(profile.contextWindow, 'contextWindow');
  const dialogueBudget = boundedBudget(
    profile.recentDialogueTokens,
    Math.min(64_000, Math.max(16_000, Math.floor(profile.contextWindow * 0.2))),
    'recentDialogueTokens',
  );

  const active = source.messages.filter((message) => message.turnId === source.turnId);
  if (!active.some((message) => message.role === 'user')) {
    throw new Error(`Thread context has no user message for active turn ${source.turnId}.`);
  }

  const priorGroups = groupCompletedTurns(
    source.messages.filter((message) => message.turnId !== source.turnId),
  );
  const selectedDialogueGroups = selectNewestWholeGroups(priorGroups, dialogueBudget);
  const selectedDialogue = selectedDialogueGroups.flatMap((group) => group.messages);
  const selectedDialogueIds = selectedDialogueGroups.map((group) => group.turnId);
  const omittedDialogueTurns = priorGroups.length - selectedDialogueGroups.length;
  const control = renderThreadControl(source, omittedDialogueTurns);
  const messages = [...selectedDialogue, ...active];
  const orderedMessageHashes = messages.map((message) =>
    canonicalJsonHash(logicalMessageSemanticValue(message)));
  const omissions: ContextOmission[] = [
    ...(omittedDialogueTurns > 0 ? [{
      source: `agent://conversation/${encodeURIComponent(source.conversationId)}/dialogue`,
      reason: 'recent-dialogue-budget' as const,
      retrieval: `journal://conversation/${encodeURIComponent(source.conversationId)}`,
      count: omittedDialogueTurns,
    }] : []),
    ...(priorGroups.length > 0 ? [{
      source: `agent://conversation/${encodeURIComponent(source.conversationId)}/turn-scratch`,
      reason: 'prior-turn-scratch' as const,
      retrieval: `journal://conversation/${encodeURIComponent(source.conversationId)}`,
      count: priorGroups.length,
    }, {
      source: `agent://conversation/${encodeURIComponent(source.conversationId)}/reasoning`,
      reason: 'prior-turn-reasoning' as const,
      retrieval: `journal://conversation/${encodeURIComponent(source.conversationId)}`,
      count: priorGroups.length,
    }] : []),
  ];
  const threadTokens = estimateTextTokens(source.threadMarkdown);
  const dialogueTokens = estimateMessagesTokens(selectedDialogue);
  const activeTokens = estimateMessagesTokens(active);
  const layers: ThreadContextLayer[] = [
    {
      kind: 'recent_dialogue',
      estimatedTokens: dialogueTokens,
      hash: canonicalJsonHash(selectedDialogue.map(logicalMessageSemanticValue)),
      sources: selectedDialogueIds.map((turnId) => `journal://turn/${encodeURIComponent(turnId)}`),
    },
    {
      kind: 'thread_document',
      estimatedTokens: threadTokens,
      hash: sha256(source.threadMarkdown),
      sources: [`journal://document-version/${encodeURIComponent(source.threadVersionId)}`],
    },
    {
      kind: 'active_scope',
      estimatedTokens: activeTokens,
      hash: canonicalJsonHash(active.map(logicalMessageSemanticValue)),
      sources: [
        `journal://turn/${encodeURIComponent(source.turnId)}`,
        `journal://scope/${encodeURIComponent(source.scopeId)}`,
      ],
    },
  ];
  const controlHash = sha256(control);
  const softContextLimit = contextSoftLimit(profile.contextWindow);
  const hardContextLimit = contextHardLimit(profile.contextWindow);
  const semanticHash = canonicalJsonHash({
    basisSequence: source.basisSequence,
    compilerVersion: CONTEXT_COMPILER_VERSION,
    controlHash,
    orderedMessageHashes,
    policyVersion: CONTEXT_POLICY_VERSION,
    pressureNoticed: source.pressureNoticed,
    threadVersionId: source.threadVersionId,
  });
  return {
    messages,
    frame: {
      compilerVersion: CONTEXT_COMPILER_VERSION,
      policyVersion: CONTEXT_POLICY_VERSION,
      basisSequence: source.basisSequence,
      threadVersionId: source.threadVersionId,
      bootstrap: control,
      bootstrapHash: controlHash,
      semanticHash,
      estimatedInputTokens: estimateTextTokens(control) + dialogueTokens + activeTokens,
      orderedMessageHashes,
      selectedTurnIds: [...selectedDialogueIds, source.turnId],
      dialogueTurnIds: selectedDialogueIds,
      omittedDialogueTurns,
      threadDocumentBytes: Buffer.byteLength(source.threadMarkdown, 'utf8'),
      scopeKind: source.scopeKind,
      softContextLimit,
      hardContextLimit,
      pressureNoticed: source.pressureNoticed,
      layers,
      omissions,
    },
  };
}

type DialogueGroup = { turnId: string; messages: LogicalContextMessage[]; estimatedTokens: number };

function groupCompletedTurns(messages: readonly LogicalContextMessage[]): DialogueGroup[] {
  const order: string[] = [];
  const groups = new Map<string, LogicalContextMessage[]>();
  for (const message of messages) {
    if (!groups.has(message.turnId)) {
      groups.set(message.turnId, []);
      order.push(message.turnId);
    }
    groups.get(message.turnId)!.push(message);
  }
  return order.flatMap((turnId): DialogueGroup[] => {
    const group = groups.get(turnId)!;
    const user = group.find((message) => message.role === 'user');
    const assistant = [...group].reverse().find((message) =>
      message.role === 'assistant' && message.state === 'completed' && message.text.trim().length > 0);
    if (!user || !assistant || assistant.role !== 'assistant') return [];
    const dialogue: LogicalContextMessage[] = [
      user,
      {
        ...assistant,
        reasoning: '',
        toolCalls: [],
        providerMessage: undefined,
      },
    ];
    return [{ turnId, messages: dialogue, estimatedTokens: estimateMessagesTokens(dialogue) }];
  });
}

function selectNewestWholeGroups(groups: readonly DialogueGroup[], budget: number) {
  const selected: DialogueGroup[] = [];
  let used = 0;
  for (const group of [...groups].reverse()) {
    if (used + group.estimatedTokens > budget) break;
    selected.push(group);
    used += group.estimatedTokens;
  }
  return selected.reverse();
}

function renderThreadControl(source: ThreadContextSource, omittedDialogueTurns: number) {
  const history = omittedDialogueTurns > 0
    ? `${omittedDialogueTurns} older completed conversation turn(s) are not currently shown.`
    : 'All eligible completed conversation turns are currently shown.';
  const sections = [
    `<thread version=${JSON.stringify(source.threadVersionId)}>`,
    source.threadMarkdown,
    '</thread>',
    '<history>',
    history,
    'Use history_search and history_read when an exact earlier detail matters. Reading History does not change the Thread.',
    '</history>',
  ];
  return `${sections.join('\n')}\n`;
}

function estimateMessagesTokens(messages: readonly LogicalContextMessage[]) {
  return estimateTextTokens(canonicalJson(messages.map(logicalMessageSemanticValue)));
}

function estimateTextTokens(text: string) {
  return Math.max(1, Math.ceil(Buffer.byteLength(text, 'utf8') / 4));
}

function boundedBudget(value: number | undefined, fallback: number, label: string) {
  if (value === undefined) return fallback;
  assertPositiveInteger(value, label);
  return value;
}

function assertPositiveInteger(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
}

function sha256(text: string) {
  return createHash('sha256').update(text).digest('hex');
}

export function contextSoftLimit(contextWindow: number) {
  return Math.max(1, Math.min(200_000, contextWindow - 60_000));
}

export function contextHardLimit(contextWindow: number) {
  return Math.max(0, contextWindow - 30_000);
}
