import { encodeAgentSectionFocus } from '../../shared/section-focus.ts';

export const REMUX_NOTIFICATION_REQUEST_METHOD = 'remux/notifications/request';

export type AgentTurnTerminalNotificationInput = {
  conversationId: string;
  turnId: string;
  segmentId?: string;
  status: 'completed' | 'failed' | 'interrupted';
};

export function createAgentTurnNotification(
  input: AgentTurnTerminalNotificationInput,
) {
  if (
    input.status === 'interrupted' ||
    !input.conversationId.trim() ||
    !input.turnId.trim()
  ) {
    return null;
  }

  const failed = input.status === 'failed';

  return {
    method: REMUX_NOTIFICATION_REQUEST_METHOD,
    params: {
      extensionId: 'agent',
      id: `agent-turn:${input.conversationId}:${input.turnId}`,
      target: {
        focusId: input.segmentId
          ? encodeAgentSectionFocus({ turnId: input.turnId, segmentId: input.segmentId }) : input.turnId,
        focusKind: input.segmentId ? 'section' : 'turn',
        resourceId: input.conversationId,
        resourceKind: 'agentConversation',
      },
      title: failed ? 'Failed' : 'Done',
      viewId: 'main',
    },
  } as const;
}
