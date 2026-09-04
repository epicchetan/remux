export const REMUX_NOTIFICATION_REQUEST_METHOD = 'remux/notifications/request';

const TURN_COMPLETED_BODY = 'Turn completed.';
const TURN_FAILED_BODY = 'Turn failed.';

export type AgentTurnTerminalNotificationInput = {
  conversationId: string;
  turnId: string;
  terminalSequence: number;
  status: 'completed' | 'failed' | 'interrupted';
  error: string | null;
};

export function createAgentTurnNotification(
  input: AgentTurnTerminalNotificationInput,
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

  return {
    method: REMUX_NOTIFICATION_REQUEST_METHOD,
    params: {
      body: failed ? TURN_FAILED_BODY : TURN_COMPLETED_BODY,
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
