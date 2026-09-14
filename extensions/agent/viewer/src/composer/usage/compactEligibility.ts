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

export function compactActionLabel(runtime: AgentRuntimeResource | null, idleLabel = 'Compact') {
  if (runtime?.compaction.operation.state !== 'running') return idleLabel;
  if (runtime.compaction.pendingPhase === 'queued') return 'Compaction queued';
  if (runtime.compaction.pendingPhase === 'requested') return 'Compaction requested';
  return 'Compacting…';
}
