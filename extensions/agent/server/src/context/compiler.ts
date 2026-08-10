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

export type ThreadCapsuleSource = {
  turnId: string;
  ref: string;
  markdown: string;
};

export type ThreadContextSource = {
  basisSequence: number;
  projectId: string;
  conversationId: string;
  strandId: string;
  turnId: string;
  scopeId: string;
  threadVersionId: string;
  threadMarkdown: string;
  messages: readonly LogicalContextMessage[];
  capsules: readonly ThreadCapsuleSource[];
};

export type ThreadContextProfile = {
  contextWindow: number;
  threadDocumentTokens?: number;
  capsuleTailTokens?: number;
  dialogueTailTokens?: number;
};

export type CompiledThreadContext = {
  frame: ThreadContextFrameCandidate;
  messages: LogicalContextMessage[];
};

/**
 * Selects the active context in whole-turn units. Current-turn scratch stays
 * exact. Completed turns contribute only their user/assistant dialogue; old
 * tools and reasoning remain cold in the journal. Older outcomes are carried
 * by the independent capsule tail.
 */
export function compileThreadContext(
  source: ThreadContextSource,
  profile: ThreadContextProfile,
): CompiledThreadContext {
  assertPositiveInteger(profile.contextWindow, 'contextWindow');
  const threadBudget = boundedBudget(
    profile.threadDocumentTokens,
    Math.min(20_000, Math.max(4_000, Math.floor(profile.contextWindow * 0.08))),
    'threadDocumentTokens',
  );
  const capsuleBudget = boundedBudget(
    profile.capsuleTailTokens,
    Math.min(24_000, Math.max(4_000, Math.floor(profile.contextWindow * 0.08))),
    'capsuleTailTokens',
  );
  const dialogueBudget = boundedBudget(
    profile.dialogueTailTokens,
    Math.min(48_000, Math.max(8_000, Math.floor(profile.contextWindow * 0.18))),
    'dialogueTailTokens',
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
  const omittedDialogue = priorGroups.length - selectedDialogueGroups.length;

  const selectedCapsules = selectNewestCapsules(source.capsules, capsuleBudget);
  const omittedCapsules = source.capsules.length - selectedCapsules.length;
  const threadMarkdown = truncateUtf8ByTokenBudget(source.threadMarkdown, threadBudget);
  const bootstrap = renderBootstrap(source, threadMarkdown, selectedCapsules);
  const messages = [...selectedDialogue, ...active];
  const orderedMessageHashes = messages.map((message) =>
    canonicalJsonHash(logicalMessageSemanticValue(message)));
  const omissions: ContextOmission[] = [
    ...(omittedCapsules > 0 ? [{
      source: `agent://conversation/${encodeURIComponent(source.conversationId)}/capsules`,
      reason: 'capsule-budget' as const,
      retrieval: `journal://conversation/${encodeURIComponent(source.conversationId)}`,
      count: omittedCapsules,
    }] : []),
    ...(omittedDialogue > 0 ? [{
      source: `agent://conversation/${encodeURIComponent(source.conversationId)}/dialogue`,
      reason: 'dialogue-budget' as const,
      retrieval: `journal://conversation/${encodeURIComponent(source.conversationId)}`,
      count: omittedDialogue,
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
  const threadHash = sha256(threadMarkdown);
  const capsuleHash = canonicalJsonHash(selectedCapsules.map(({ turnId, ref, markdown }) => ({
    markdown,
    ref,
    turnId,
  })));
  const dialogueHash = canonicalJsonHash(selectedDialogue.map(logicalMessageSemanticValue));
  const activeHash = canonicalJsonHash(active.map(logicalMessageSemanticValue));
  const layers: ThreadContextLayer[] = [
    {
      kind: 'thread_document',
      estimatedTokens: estimateTextTokens(threadMarkdown),
      hash: threadHash,
      sources: [`journal://document-version/${encodeURIComponent(source.threadVersionId)}`],
    },
    {
      kind: 'capsule_tail',
      estimatedTokens: selectedCapsules.reduce((total, capsule) =>
        total + estimateTextTokens(capsule.markdown), 0),
      hash: capsuleHash,
      sources: selectedCapsules.map(({ ref }) => ref),
    },
    {
      kind: 'dialogue_tail',
      estimatedTokens: estimateMessagesTokens(selectedDialogue),
      hash: dialogueHash,
      sources: selectedDialogueIds.map((turnId) => `journal://turn/${encodeURIComponent(turnId)}`),
    },
    {
      kind: 'active_turn',
      estimatedTokens: estimateMessagesTokens(active),
      hash: activeHash,
      sources: [`journal://turn/${encodeURIComponent(source.turnId)}`],
    },
  ];
  const bootstrapHash = sha256(bootstrap);
  const semanticHash = canonicalJsonHash({
    basisSequence: source.basisSequence,
    bootstrapHash,
    compilerVersion: CONTEXT_COMPILER_VERSION,
    orderedMessageHashes,
    policyVersion: CONTEXT_POLICY_VERSION,
    threadVersionId: source.threadVersionId,
  });
  return {
    messages,
    frame: {
      compilerVersion: CONTEXT_COMPILER_VERSION,
      policyVersion: CONTEXT_POLICY_VERSION,
      basisSequence: source.basisSequence,
      threadVersionId: source.threadVersionId,
      bootstrap,
      bootstrapHash,
      semanticHash,
      estimatedInputTokens: estimateTextTokens(bootstrap) + estimateMessagesTokens(messages),
      orderedMessageHashes,
      selectedTurnIds: [...selectedDialogueIds, source.turnId],
      dialogueTurnIds: selectedDialogueIds,
      capsuleTurnIds: selectedCapsules.map(({ turnId }) => turnId),
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
      message.role === 'assistant' && message.text.trim().length > 0) ??
      [...group].reverse().find((message) => message.role === 'assistant');
    if (!user || !assistant || assistant.role !== 'assistant') return [];
    const dialogue: LogicalContextMessage[] = [
      user,
      {
        ...assistant,
        reasoning: '',
        toolCalls: [],
      },
    ];
    return [{ turnId, messages: dialogue, estimatedTokens: estimateMessagesTokens(dialogue) }];
  });
}

function selectNewestWholeGroups(groups: readonly DialogueGroup[], budget: number) {
  const selected: DialogueGroup[] = [];
  let used = 0;
  for (const group of [...groups].reverse()) {
    if (selected.length > 0 && used + group.estimatedTokens > budget) break;
    if (group.estimatedTokens > budget && selected.length === 0) continue;
    selected.push(group);
    used += group.estimatedTokens;
  }
  return selected.reverse();
}

function selectNewestCapsules(capsules: readonly ThreadCapsuleSource[], budget: number) {
  const selected: ThreadCapsuleSource[] = [];
  let used = 0;
  for (const capsule of [...capsules].reverse()) {
    const tokens = estimateTextTokens(capsule.markdown);
    if (selected.length > 0 && used + tokens > budget) break;
    if (tokens > budget && selected.length === 0) continue;
    selected.push(capsule);
    used += tokens;
  }
  return selected.reverse();
}

function renderBootstrap(
  source: ThreadContextSource,
  threadMarkdown: string,
  capsules: readonly ThreadCapsuleSource[],
) {
  const sections = [
    '<remux_thread_context version="1">',
    '<thread_document>',
    threadMarkdown,
    '</thread_document>',
    '<turn_capsules>',
    ...capsules.flatMap((capsule) => [
      `<turn_capsule turn_id=${JSON.stringify(capsule.turnId)} ref=${JSON.stringify(capsule.ref)}>`,
      capsule.markdown,
      '</turn_capsule>',
    ]),
    '</turn_capsules>',
    '<retrieval>',
    'Exact omitted messages, tool operations, and evidence remain available through journal_search and journal_open.',
    '</retrieval>',
    '</remux_thread_context>',
  ];
  return `${sections.join('\n')}\n`;
}

function estimateMessagesTokens(messages: readonly LogicalContextMessage[]) {
  return estimateTextTokens(canonicalJson(messages.map(logicalMessageSemanticValue)));
}

function estimateTextTokens(text: string) {
  return Math.max(1, Math.ceil(Buffer.byteLength(text, 'utf8') / 4));
}

function truncateUtf8ByTokenBudget(text: string, tokens: number) {
  const maxBytes = tokens * 4;
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.byteLength <= maxBytes) return text;
  let truncated = bytes.subarray(0, maxBytes).toString('utf8').replace(/\uFFFD$/u, '');
  truncated += '\n\n[thread.md truncated; open its journal document version for the exact remainder]\n';
  return truncated;
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
