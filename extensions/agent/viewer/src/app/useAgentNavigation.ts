import {
  parseRemuxViewerRoute,
  subscribeHostNavigate,
  updateHostTab,
} from '@remux/viewer-kit';
import { useEffect } from 'react';

import type { ConversationSummary, ConversationValue } from '../../../shared/protocol.ts';
import {
  activateDraftOperationId,
  isViewerUuid,
  loadOrCreateDraftOperationId,
} from '../identity.ts';

export type AgentInitialTarget =
  | { focusTurnId: string | null; id: string; kind: 'conversation' }
  | { id: string; kind: 'draft' };

export function readInitialTarget(): AgentInitialTarget {
  const route = parseRemuxViewerRoute(window.location.href);
  if (route.resourceKind === 'agentConversation' && route.resourceId) {
    return {
      focusTurnId: route.focusKind === 'turn' ? route.focusId : null,
      id: route.resourceId,
      kind: 'conversation',
    };
  }
  if (route.resourceKind === 'agentDraft' && isViewerUuid(route.resourceId)) {
    return { id: activateDraftOperationId(route.resourceId), kind: 'draft' };
  }
  if (route.launch === 'new-chat' && isViewerUuid(route.resourceId)) {
    return { id: activateDraftOperationId(route.resourceId), kind: 'draft' };
  }
  return { id: loadOrCreateDraftOperationId(), kind: 'draft' };
}

export function useAgentNavigation(options: {
  activeConversationId: string | null;
  activeDraftId: string | null;
  conversation: ConversationValue | null;
  conversationMissing: boolean;
  conversationSummary: ConversationSummary | null;
  selectConversation: (conversationId: string, focusTurnId?: string | null) => void;
  startNewChat: (preferredDraftId?: string | null) => void;
}) {
  const {
    activeConversationId,
    activeDraftId,
    conversation,
    conversationMissing,
    conversationSummary,
    selectConversation,
    startNewChat,
  } = options;

  useEffect(() => subscribeHostNavigate((navigation) => {
    if (navigation.resourceKind === 'agentConversation' && navigation.resourceId) {
      selectConversation(
        navigation.resourceId,
        navigation.focusKind === 'turn' ? navigation.focusId : null,
      );
      return;
    }
    if (navigation.resourceKind === 'agentDraft' && navigation.resourceId) {
      startNewChat(navigation.resourceId);
    }
  }), [selectConversation, startNewChat]);

  useEffect(() => {
    if (!activeDraftId) return;
    void syncAgentTabLocation({
      resourceId: activeDraftId,
      resourceKind: 'agentDraft',
      status: 'Draft',
      title: 'New chat',
    }).catch(() => undefined);
  }, [activeDraftId]);

  useEffect(() => {
    if (!activeConversationId) return;
    void syncAgentTabLocation({
      resourceId: activeConversationId,
      resourceKind: 'agentConversation',
      status: conversation ? conversationStatusLabel(conversation.status) : null,
      title: conversationSummary?.title || (conversationMissing ? 'Conversation unavailable' : 'Agent'),
    }).catch(() => undefined);
  }, [activeConversationId, conversation, conversationMissing, conversationSummary?.title]);
}

type AgentTabLocation = {
  resourceId: string;
  resourceKind: 'agentConversation' | 'agentDraft';
  status: string | null;
  title: string;
};

async function syncAgentTabLocation(location: AgentTabLocation) {
  replaceAgentLocation(location);
  await updateHostTab({ ...location, launch: null });
}

function replaceAgentLocation(location: AgentTabLocation) {
  const url = new URL(window.location.href);
  url.searchParams.delete('remuxLaunch');
  url.searchParams.delete('remuxFocusKind');
  url.searchParams.delete('remuxFocusId');
  url.searchParams.set('remuxResourceKind', location.resourceKind);
  url.searchParams.set('remuxResourceId', location.resourceId);
  window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
}

function conversationStatusLabel(status: ConversationValue['status']) {
  if (status === 'running') return 'Working';
  if (status === 'interrupting') return 'Stopping';
  if (status === 'loading') return 'Loading';
  if (status === 'error') return 'Failed';
  return null;
}
