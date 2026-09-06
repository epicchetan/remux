import type { AgentRuntimeResource } from '../../../../shared/native-agent-protocol.ts';
import type { AgentPendingQueueValue, ConversationValue } from '../../../../shared/protocol.ts';

export function canManuallyCompact(
  conversation: ConversationValue | null,
  runtime: AgentRuntimeResource | null,
  queue: AgentPendingQueueValue | null,
) {
  return Boolean(
    conversation?.resumable
    && runtime?.conversationId === conversation.id
    && runtime.deliveryHeld === false
    && queue?.conversationId === conversation.id
    && runtime.capabilities.compaction.manualNative
    && runtime.compaction.operation.state !== 'running'
    && !queue.entries.some((entry) => entry.kind === 'compact'),
  );
}
