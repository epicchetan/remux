import type { AgentRuntimeResource, NativeMessageSendResult } from '../../../../shared/native-agent-protocol.ts';
import type { AgentPendingQueueValue } from '../../../../shared/protocol.ts';
import type { ProviderAccess } from '../../../../shared/provider-runtime.ts';

export type ComposerDeliveryInput = {
  runtime: AgentRuntimeResource | null;
  queue: AgentPendingQueueValue | null;
  model: string | null;
  effort: string | null;
  serviceTier: string | null;
  access: ProviderAccess;
};
/** Explanations only. Automatic delivery is always routed by the coordinator. */
export function composerDeliveryReason({ runtime, queue, model, effort, serviceTier, access }: ComposerDeliveryInput): string | null {
  const active = Boolean(runtime?.activeTurnId);
  if (runtime?.deliveryHeld) return 'Previous delivery is unconfirmed. Resolve the delivery hold before sending another message.';
  if (runtime && ((active && queue?.conversationId !== runtime.conversationId) || runtime.state === 'recovering')) {
    return 'Checking conversation delivery status…';
  }
  if (runtime?.compaction.operation.state === 'running') return 'This message must wait for compaction and any earlier queued work.';
  if (runtime && queue?.conversationId === runtime.conversationId && queue.entries.length) return 'Earlier queued work goes first.';
  if (!active || !runtime) return null;
  if (model !== runtime.activeConfiguration.model || effort !== (runtime.activeConfiguration.effort ?? null) ||
      serviceTier !== (runtime.activeConfiguration.serviceTier ?? null) || access !== runtime.activeConfiguration.access) {
    return 'The draft uses different settings from the current turn.';
  }
  if (!runtime.capabilities.turns.activeInput) return 'This provider cannot accept a message into the current turn.';
  return null;
}

export function composerDeliveryNotice(reason: NativeMessageSendResult['reason']): string | null {
  if (reason === 'federation-wait') return 'Message queued because this turn is waiting on a federated child.';
  if (reason === 'steer-unavailable') return 'Message queued because this provider cannot steer the current turn.';
  return null;
}
