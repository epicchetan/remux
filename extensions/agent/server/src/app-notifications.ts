import type { ConversationSummary } from '../../shared/protocol.ts';

export const REMUX_NOTIFICATION_REQUEST_METHOD = 'remux/notifications/request';

const DEFAULT_TURN_COMPLETED_BODY = 'Open the conversation to review the result.';
const DEFAULT_TURN_FAILED_BODY = 'Open the conversation to review the failure.';
const NOTIFICATION_BODY_MAX_CODE_POINTS = 150;

export type AgentTurnTerminalNotificationInput = {
  conversationId: string;
  turnId: string;
  terminalSequence: number;
  status: 'completed' | 'failed' | 'interrupted';
  error: string | null;
};

export function createAgentTurnNotification(
  input: AgentTurnTerminalNotificationInput,
  conversation: ConversationSummary,
) {
  if (
    input.status === 'interrupted' ||
    !input.conversationId.trim() ||
    !input.turnId.trim() ||
    !Number.isSafeInteger(input.terminalSequence) ||
    input.terminalSequence < 0
  ) {
    return null;
  }

  const failed = input.status === 'failed';
  const body = notificationPreview(failed ? input.error : conversation.preview) ?? (
    failed ? DEFAULT_TURN_FAILED_BODY : DEFAULT_TURN_COMPLETED_BODY
  );

  return {
    method: REMUX_NOTIFICATION_REQUEST_METHOD,
    params: {
      body,
      extensionId: 'agent',
      id: `agent-turn:${input.conversationId}:${input.turnId}:${input.terminalSequence}`,
      target: {
        focusId: input.turnId,
        focusKind: 'turn',
        resourceId: input.conversationId,
        resourceKind: 'agentConversation',
      },
      title: failed ? 'Agent turn failed' : 'Agent finished',
      viewId: 'main',
    },
  } as const;
}

function notificationPreview(text: string | null) {
  if (!text) return null;
  const withoutFences = stripFencedCodeBlocks(text);
  const cleaned = withoutFences
    .split(/\r?\n/u)
    .map(stripMarkdownLinePrefix)
    .map((line) => line.replace(/[`*\[\]]/gu, ''))
    .join(' ')
    .replace(/\p{White_Space}+/gu, ' ')
    .trim();
  if (!cleaned) return null;
  return truncatePreview(cleaned, NOTIFICATION_BODY_MAX_CODE_POINTS);
}

function stripFencedCodeBlocks(text: string) {
  const output: string[] = [];
  let inFence = false;
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) output.push(line);
  }
  return output.join('\n');
}

function stripMarkdownLinePrefix(line: string) {
  let value = line.trim();
  while (value.startsWith('#') || value.startsWith('>')) {
    value = value.slice(1).trimStart();
  }
  return value
    .replace(/^(?:[-*+]\s+|\d+\.\s+)/u, '')
    .trimStart();
}

function truncatePreview(text: string, maxCodePoints: number) {
  const codePoints = [...text];
  if (codePoints.length <= maxCodePoints) return text;

  const window = codePoints.slice(0, maxCodePoints);
  let cutoff = window.length;
  let sentenceBoundary = -1;
  let wordBoundary = -1;
  for (let index = 80; index < window.length; index += 1) {
    const point = window[index]!;
    if (point === '.' || point === '!' || point === '?') sentenceBoundary = index + 1;
    if (/\p{White_Space}/u.test(point)) wordBoundary = index;
  }
  cutoff = sentenceBoundary >= 0 ? sentenceBoundary : wordBoundary >= 0 ? wordBoundary : cutoff;
  return `${window.slice(0, cutoff).join('').trimEnd()}...`;
}
