import type {
  ConversationListValue,
  ConversationSummary,
  ReasoningLevel,
} from '../../shared/protocol.ts';

export const CONVERSATION_LIST_LIMIT = 50;
export const CONVERSATION_TITLE_CODE_POINTS = 48;
export const CONVERSATION_PREVIEW_CODE_POINTS = 120;

export type ConversationSummaryMessage = {
  role: 'user' | 'assistant';
  text: string;
  sequence: number;
  turnId: string;
};

export type ConversationSummaryInput = {
  id: string;
  cwd: string;
  modelId: string;
  reasoning: ReasoningLevel;
  conversationState: string;
  latestTurn: { id: string; state: string } | null;
  createdAt: number;
  updatedAt: number;
  messages: ConversationSummaryMessage[];
};

export function renderConversationSummary(input: ConversationSummaryInput): ConversationSummary {
  const messages = [...input.messages].sort((left, right) =>
    left.sequence - right.sequence || compareStrings(left.turnId, right.turnId));
  const firstUser = messages.find((message) => message.role === 'user');
  const newestAssistant = messages.findLast((message) =>
    message.role === 'assistant' && normalizeConversationText(message.text).length > 0);
  const newestUser = messages.findLast((message) =>
    message.role === 'user' && normalizeConversationText(message.text).length > 0);

  return {
    id: input.id,
    title: truncateCodePoints(
      firstUser ? normalizeConversationText(firstUser.text) : 'New conversation',
      CONVERSATION_TITLE_CODE_POINTS,
    ),
    preview: truncateCodePoints(
      normalizeConversationText(newestAssistant?.text ?? newestUser?.text ?? ''),
      CONVERSATION_PREVIEW_CODE_POINTS,
    ),
    cwd: input.cwd,
    modelId: input.modelId,
    reasoning: input.reasoning,
    status: durableConversationStatus(input.conversationState, input.latestTurn?.state ?? null),
    latestTurnId: input.latestTurn?.id ?? null,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
  };
}

export function renderConversationList(
  summaries: readonly ConversationSummary[],
): ConversationListValue {
  const sorted = [...summaries]
    .sort((left, right) => right.updatedAt - left.updatedAt || compareStrings(right.id, left.id));
  return {
    conversations: sorted.slice(0, CONVERSATION_LIST_LIMIT),
    truncated: sorted.length > CONVERSATION_LIST_LIMIT,
  };
}

function compareStrings(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function normalizeConversationText(text: string) {
  return text.replace(/\p{White_Space}+/gu, ' ').trim();
}

function truncateCodePoints(text: string, limit: number) {
  return [...text].slice(0, limit).join('');
}

function durableConversationStatus(
  conversationState: string,
  latestTurnState: string | null,
): ConversationSummary['status'] {
  if (conversationState === 'running') return 'running';
  if (latestTurnState === 'failed') return 'error';
  return 'idle';
}
