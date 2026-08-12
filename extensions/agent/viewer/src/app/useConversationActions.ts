import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';

import {
  AGENT_RESOURCE_KEYS,
  queueResourceKey,
  type AgentComposerMessagePart,
  type AgentResourceKey,
  type ConversationValue,
  type ReasoningLevel,
} from '../../../shared/protocol.ts';
import type { ComposerEditTarget, ComposerForkTarget } from '../composer/store.ts';
import {
  removeConversationDraft,
  removeNewChatDraft,
  type AgentNewChatDraft,
} from '../conversation/drafts.ts';
import { useConversationHistoryStore } from '../conversation/historyStore.ts';
import {
  confirmDraftOperationId,
  createViewerUuid,
  loadOrCreateDraftOperationId,
} from '../identity.ts';
import { agentCommands } from '../ipc/agentCommands.ts';
import {
  getTranscriptResourceState,
  refreshActiveTranscriptResources,
} from '../transcript/resourceStore.ts';
import {
  discardTranscriptUserMessage,
  trackTranscriptUserMessage,
} from '../transcript/viewportStore.ts';

type ComposerPhase = 'sending' | 'updating-transcript';

export function useConversationActions(options: {
  activeConversationIdRef: MutableRefObject<string | null>;
  activeDraftIdRef: MutableRefObject<string | null>;
  conversation: ConversationValue | null;
  cwd: string;
  draftRef: MutableRefObject<AgentNewChatDraft | null>;
  modelId: string;
  reasoning: ReasoningLevel;
  refresh: (keys?: AgentResourceKey[]) => Promise<void>;
  selectConversation: (conversationId: string, focusTurnId?: string | null) => void;
  setActiveConversationId: Dispatch<SetStateAction<string | null>>;
  setActiveDraftId: Dispatch<SetStateAction<string | null>>;
  setDraft: Dispatch<SetStateAction<AgentNewChatDraft | null>>;
  setError: Dispatch<SetStateAction<string | null>>;
}) {
  const {
    activeConversationIdRef,
    activeDraftIdRef,
    conversation,
    cwd,
    draftRef,
    modelId,
    reasoning,
    refresh,
    selectConversation,
    setActiveConversationId,
    setActiveDraftId,
    setDraft,
    setError,
  } = options;
  const ensureConversation = useConversationHistoryStore((state) => state.ensureConversation);
  const createConversation = useCallback(async () => {
    if (!modelId || !cwd) throw new Error('Choose a workspace and model first.');
    const operationId = activeDraftIdRef.current ?? loadOrCreateDraftOperationId();
    const sourceDraftId = activeDraftIdRef.current;
    const result = await agentCommands.createConversation({ operationId, cwd, modelId, reasoning });
    confirmDraftOperationId(operationId);
    if (sourceDraftId) removeNewChatDraft(sourceDraftId);
    if (draftRef.current?.id === sourceDraftId) {
      draftRef.current = null;
      setDraft(null);
    }
    await ensureConversation(result.conversationId, true);
    if (activeDraftIdRef.current === sourceDraftId) {
      activeDraftIdRef.current = null;
      activeConversationIdRef.current = result.conversationId;
      setActiveDraftId(null);
      setActiveConversationId(result.conversationId);
      await getTranscriptResourceState().setActiveConversationId(result.conversationId);
    }
    return result.conversationId;
  }, [
    activeConversationIdRef,
    activeDraftIdRef,
    cwd,
    draftRef,
    ensureConversation,
    modelId,
    reasoning,
    setActiveConversationId,
    setActiveDraftId,
    setDraft,
  ]);

  const send = useCallback(async (
    input: { displayText: string; parts: AgentComposerMessagePart[] },
    setPhase: (phase: ComposerPhase) => void,
  ) => {
    setError(null);
    const activeId = activeConversationIdRef.current ?? await createConversation();
    setPhase('sending');
    const clientMessageId = createViewerUuid();
    trackTranscriptUserMessage(activeId, clientMessageId);
    let sent;
    try {
      sent = await agentCommands.sendMessage({
        operationId: createViewerUuid(),
        conversationId: activeId,
        clientMessageId,
        parts: input.parts,
        text: input.displayText,
      });
    } catch (reason) {
      discardTranscriptUserMessage(clientMessageId);
      throw reason;
    }
    if (sent.turnId) trackTranscriptUserMessage(activeId, clientMessageId, sent.turnId);
    else discardTranscriptUserMessage(clientMessageId);
    setPhase('updating-transcript');
    removeConversationDraft(activeId);
    await Promise.all([
      refresh([AGENT_RESOURCE_KEYS.runtime, queueResourceKey(activeId)]),
      ensureConversation(activeId, true),
      ...(activeConversationIdRef.current === activeId
        ? [refreshActiveTranscriptResources({
            forceFullMeasure: false,
            preserveReady: true,
            windowPolicy: 'tail',
          })]
        : []),
    ]);
  }, [activeConversationIdRef, createConversation, ensureConversation, refresh, setError]);

  const branchMessage = useCallback(async (
    mode: 'edit' | 'fork',
    target: ComposerEditTarget | ComposerForkTarget,
    input: { displayText: string; parts: AgentComposerMessagePart[] },
    setPhase: (phase: ComposerPhase) => void,
  ) => {
    setError(null);
    setPhase('sending');
    const clientMessageId = createViewerUuid();
    const result = await agentCommands.branchMessage({
      mode,
      operationId: createViewerUuid(),
      clientMessageId,
      parts: input.parts,
      text: input.displayText,
      sourceConversationId: target.conversationId,
      sourceMessageId: mode === 'edit'
        ? (target as ComposerEditTarget).userMessageId
        : (target as ComposerForkTarget).assistantMessageId,
      sourceTurnId: target.turnId,
    });
    removeConversationDraft(target.conversationId);
    trackTranscriptUserMessage(result.conversationId, clientMessageId, result.turnId);
    setPhase('updating-transcript');
    await ensureConversation(result.conversationId, true);
    selectConversation(result.conversationId, result.turnId);
    await getTranscriptResourceState().setActiveConversationId(result.conversationId);
    await Promise.all([
      refresh([AGENT_RESOURCE_KEYS.runtime, queueResourceKey(result.conversationId)]),
      refreshActiveTranscriptResources({
        forceFullMeasure: true,
        preserveReady: false,
        windowPolicy: 'tail',
      }),
    ]);
  }, [ensureConversation, refresh, selectConversation, setError]);

  const interrupt = useCallback(async () => {
    if (!conversation?.activeTurnId) return;
    setError(null);
    try {
      await agentCommands.interrupt(conversation.id, conversation.activeTurnId);
      await refresh([AGENT_RESOURCE_KEYS.runtime]);
    } catch (reason) {
      setError(messageOf(reason));
      throw reason;
    }
  }, [conversation?.activeTurnId, conversation?.id, refresh, setError]);

  return { branchMessage, interrupt, send };
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
