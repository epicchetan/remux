import type { AgentRuntimeResource } from '../../../../shared/native-agent-protocol.ts';
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
export type ComposerDeliveryState = {
  menu: boolean;
  currentAllowed: boolean;
  queueAllowed: boolean;
  active: boolean;
  reason: string | null;
  queueLabel: string;
  queueDescription: string;
};

/** UI eligibility only. The coordinator rechecks ordering and captured settings at dispatch. */
export function composerDeliveryState({ runtime, queue, model, effort, serviceTier, access }: ComposerDeliveryInput): ComposerDeliveryState {
  const active = Boolean(runtime?.activeTurnId);
  const base = { menu: true, currentAllowed: false, queueAllowed: true, active,
    reason: null, queueLabel: 'Queue for next turn',
    queueDescription: active ? 'Let this response finish first.' : 'Start the next turn with this message.' };
  if (runtime?.deliveryHeld) return { ...base, queueAllowed: false,
    reason: 'Previous delivery is unconfirmed. Resolve the delivery hold before sending another message.' };
  if (runtime && ((active && queue?.conversationId !== runtime.conversationId) || runtime.state === 'recovering')) {
    return { ...base, queueAllowed: false, reason: 'Checking conversation delivery status…' };
  }
  if (runtime?.compaction.operation.state === 'running') return { ...base,
    reason: 'This message must wait for compaction and any earlier queued work.',
    queueLabel: 'Queue after pending work', queueDescription: 'Send after compaction and earlier queued work.' };
  if (runtime && queue?.conversationId === runtime.conversationId && queue.entries.length) return { ...base,
    reason: 'Earlier queued work goes first.', queueLabel: 'Queue after pending work',
    queueDescription: 'Preserve the order of pending messages and operations.' };
  if (!active || !runtime) return { ...base, menu: false, currentAllowed: true };
  if (model !== runtime.activeConfiguration.model || effort !== (runtime.activeConfiguration.effort ?? null) ||
      serviceTier !== (runtime.activeConfiguration.serviceTier ?? null) || access !== runtime.activeConfiguration.access) {
    return { ...base, reason: 'The draft uses different settings from the current turn.',
      queueDescription: 'Start the next turn with the selected settings.' };
  }
  if (!runtime.capabilities.turns.activeInput) return { ...base,
    reason: 'This provider cannot accept a message into the current turn.' };
  return { ...base, currentAllowed: true };
}
