import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';

import {
  AGENT_RESOURCE_KEYS,
  queueResourceKey,
  type AgentResourceKey,
  type ConversationValue,
} from '../../../shared/protocol.ts';
import type { TurnSubmissionInput } from '../composer/actions/turnAction.ts';
import type { ComposerEditTarget, ComposerForkTarget } from '../composer/store.ts';
import {
  clearConversationDraftContent,
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
    refresh,
    selectConversation,
    setActiveConversationId,
    setActiveDraftId,
    setDraft,
    setError,
  } = options;
  const ensureConversation = useConversationHistoryStore((state) => state.ensureConversation);
  const createConversation = useCallback(async (
    modelId: TurnSubmissionInput['modelId'],
    reasoning: TurnSubmissionInput['reasoning'],
  ) => {
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
    setActiveConversationId,
    setActiveDraftId,
    setDraft,
  ]);

  const send = useCallback(async (
    input: TurnSubmissionInput,
    setPhase: (phase: ComposerPhase) => void,
  ) => {
    setError(null);
    const activeId = activeConversationIdRef.current
      ?? await createConversation(input.modelId, input.reasoning);
    setPhase('sending');
    const clientMessageId = createViewerUuid();
    trackTranscriptUserMessage(activeId, clientMessageId);
    let sent;
    try {
      sent = await agentCommands.sendMessage({
        operationId: createViewerUuid(),
        conversationId: activeId,
        clientMessageId,
        modelId: input.modelId,
        contextPlan: input.contextPlan,
        parts: input.parts,
        reasoning: input.reasoning,
        text: input.displayText,
      });
    } catch (reason) {
      discardTranscriptUserMessage(clientMessageId);
      throw reason;
    }
    if (sent.turnId) trackTranscriptUserMessage(activeId, clientMessageId, sent.turnId);
    else discardTranscriptUserMessage(clientMessageId);
    setPhase('updating-transcript');
    clearConversationDraftContent(activeId);
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
    input: TurnSubmissionInput,
    setPhase: (phase: ComposerPhase) => void,
  ) => {
    setError(null);
    setPhase('sending');
    const clientMessageId = createViewerUuid();
    const result = await agentCommands.branchMessage({
      mode,
      operationId: createViewerUuid(),
      clientMessageId,
      modelId: input.modelId,
      contextPlan: input.contextPlan,
      parts: input.parts,
      reasoning: input.reasoning,
      text: input.displayText,
      sourceConversationId: target.conversationId,
      sourceMessageId: mode === 'edit'
        ? (target as ComposerEditTarget).userMessageId
        : (target as ComposerForkTarget).assistantMessageId,
      sourceTurnId: target.turnId,
    });
    clearConversationDraftContent(target.conversationId);
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
