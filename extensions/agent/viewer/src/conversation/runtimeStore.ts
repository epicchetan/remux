import type { AgentRuntimeValue } from '../../../shared/protocol';
import { createExternalStore } from '../transcript/externalStore';

type ConversationRuntimeStoreState = {
  activeConversationId: string | null;
  activeTurnElapsedMs: number | null;
  activeTurnId: string | null;
  error: string | null;
  canForkNative: boolean;
  status: AgentRuntimeValue['state'] | 'unavailable';
};

const runtimeStore = createExternalStore<ConversationRuntimeStoreState>({
  activeConversationId: null,
  activeTurnElapsedMs: null,
  activeTurnId: null,
  error: null,
  canForkNative: false,
  status: 'unavailable',
});

export const useConversationRuntimeStore = runtimeStore.useStore;

export function getConversationRuntimeState() {
  return runtimeStore.getState();
}

export function setConversationRuntime(runtime: AgentRuntimeValue | null) {
  runtimeStore.setState(runtime ? {
    activeConversationId: runtime.conversationId,
    activeTurnElapsedMs: runtime.activeTurnElapsedMs,
    activeTurnId: runtime.activeTurnId,
    error: runtime.error,
    canForkNative: runtime.capabilities.session.forkNative,
    status: runtime.state,
  } : {
    activeConversationId: null,
    activeTurnElapsedMs: null,
    activeTurnId: null,
    error: null,
    canForkNative: false,
    status: 'unavailable',
  });
}
