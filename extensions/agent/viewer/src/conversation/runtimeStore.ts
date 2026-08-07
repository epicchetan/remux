import type { ConversationValue } from '../../../shared/protocol';
import { createExternalStore } from '../transcript/externalStore';

type ConversationRuntimeStoreState = {
  activeConversationId: string | null;
  activeTurnElapsedMs: number | null;
  activeTurnId: string | null;
  error: string | null;
  status: ConversationValue['status'] | 'unavailable';
};

const runtimeStore = createExternalStore<ConversationRuntimeStoreState>({
  activeConversationId: null,
  activeTurnElapsedMs: null,
  activeTurnId: null,
  error: null,
  status: 'unavailable',
});

export const useConversationRuntimeStore = runtimeStore.useStore;

export function getConversationRuntimeState() {
  return runtimeStore.getState();
}

export function setConversationRuntime(conversation: ConversationValue | null) {
  runtimeStore.setState(conversation ? {
    activeConversationId: conversation.id,
    activeTurnElapsedMs: conversation.activeTurnElapsedMs,
    activeTurnId: conversation.activeTurnId,
    error: conversation.error,
    status: conversation.status,
  } : {
    activeConversationId: null,
    activeTurnElapsedMs: null,
    activeTurnId: null,
    error: null,
    status: 'unavailable',
  });
}
