import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';

import {
  type ConversationValue,
} from '../../../shared/protocol.ts';
import type { AgentRuntimeResource, NativeAgentResourceKey } from '../../../shared/native-agent-protocol.ts';
import type { TurnSubmissionInput } from '../composer/actions/turnAction.ts';
import type { ComposerEditTarget, ComposerForkTarget } from '../composer/store.ts';
import {
  clearConversationDraftContent,
  persistConversationDraft,
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
import { useComposerStore } from '../composer/store.ts';
import { resolveModel } from '../composer/config/modelSelection.ts';
import {
  getTranscriptResourceState,
  recoverActiveTranscriptResources,
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
  nativeRuntime: AgentRuntimeResource | null;
  cwd: string;
  draftRef: MutableRefObject<AgentNewChatDraft | null>;
  refresh: (keys?: NativeAgentResourceKey[]) => Promise<void>;
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
    nativeRuntime,
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
    input: TurnSubmissionInput,
  ) => {
    if (!input.modelId || !input.providerInstanceId || !cwd) {
      throw new Error('Choose a workspace, provider, and model first.');
    }
    const selected = resolveModel(useComposerStore.getState().models, input.modelId);
    if (!selected?.nativeId || selected.providerInstanceId !== input.providerInstanceId) {
      throw new Error('The selected native provider model is unavailable.');
    }
    const operationId = activeDraftIdRef.current ?? loadOrCreateDraftOperationId();
    const sourceDraftId = activeDraftIdRef.current;
    const result = await agentCommands.createConversation({
      operationId,
      providerInstanceId: input.providerInstanceId,
      cwd,
      nativeModelId: selected.nativeId,
      reasoning: input.reasoning,
      serviceTier: input.serviceTier,
      access: input.access,
    });
    persistConversationDraft(
      result.conversationId,
      useComposerStore.getState().snapshot,
    );
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
    return {
      conversationId: result.conversationId,
      runtime: await agentCommands.readRuntime(result.conversationId),
    };
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
    const currentId = activeConversationIdRef.current;
    const created = currentId ? null : await createConversation(input);
    const activeId = currentId ?? created!.conversationId;
    const submissionRuntime = created?.runtime
      ?? (nativeRuntime?.conversationId === activeId ? nativeRuntime : null);
    if (!submissionRuntime) throw new Error('Conversation configuration is still loading.');
    const submittedProviderInstanceId = created
      ? submissionRuntime.providerInstanceId
      : input.providerInstanceId;
    const submittedAccess = created
      ? submissionRuntime.composer.nextTurn.access
      : input.access;
    const submittedConfigurationRevision = created
      ? submissionRuntime.composer.revision
      : input.configurationRevision;
    if (!submittedConfigurationRevision) {
      throw new Error('Conversation configuration is still loading.');
    }
    setPhase('sending');
    const clientMessageId = createViewerUuid();
    const selected = resolveModel(useComposerStore.getState().models, input.modelId);
    if (!selected?.nativeId || selected.providerInstanceId !== submittedProviderInstanceId) {
      throw new Error('The selected native provider model is unavailable.');
    }
    let sent;
    try {
      sent = await agentCommands.sendMessage({
        operationId: createViewerUuid(),
        conversationId: activeId,
        clientMessageId,
        parts: input.parts,
        nativeModelId: selected.nativeId,
        reasoning: input.reasoning,
        serviceTier: created
          ? submissionRuntime.composer.nextTurn.serviceTier
          : input.serviceTier,
        providerInstanceId: submittedProviderInstanceId,
        access: submittedAccess,
        configurationRevision: submittedConfigurationRevision,
        delivery: input.delivery,
      });
    } catch (reason) {
      throw reason;
    }
    const transcriptFence = 'transcriptFence' in sent ? sent.transcriptFence : undefined;
    if (sent.delivery === 'sent' && sent.turnId) {
      trackTranscriptUserMessage(activeId, clientMessageId, sent.turnId);
    } else {
      discardTranscriptUserMessage(clientMessageId);
    }
    setPhase('updating-transcript');
    clearConversationDraftContent(activeId);
    await Promise.all([
      refresh([`agent/runtime:${activeId}`, `agent/queue:${activeId}`]),
      ensureConversation(activeId, true),
      ...(activeConversationIdRef.current === activeId && sent.delivery !== 'queued'
        ? [recoverActiveTranscriptResources({
            attempts: 4,
            forceFullMeasure: false,
            preserveReady: true,
            requiredBasisSequence: transcriptFence?.basisSequence ?? null,
            requiredServerGeneration: transcriptFence?.serverGeneration ?? null,
            requiredTurnId: sent.turnId,
            windowPolicy: 'tail',
          })]
        : []),
    ]);
  }, [activeConversationIdRef, createConversation, ensureConversation, nativeRuntime, refresh, setError]);

  const branchMessage = useCallback(async (
    mode: 'edit' | 'fork',
    target: ComposerEditTarget | ComposerForkTarget,
    input: TurnSubmissionInput,
    setPhase: (phase: ComposerPhase) => void,
  ) => {
    setError(null);
    setPhase('sending');
    if (!nativeRuntime || nativeRuntime.conversationId !== target.conversationId) {
      throw new Error('Conversation configuration is still loading.');
    }
    if (!input.configurationRevision) {
      throw new Error('Conversation configuration is still loading.');
    }
    const selected = resolveModel(useComposerStore.getState().models, input.modelId);
    if (!selected?.nativeId || selected.providerInstanceId !== input.providerInstanceId) {
      throw new Error('The selected native provider model is unavailable.');
    }
    const clientMessageId = createViewerUuid();
    const result = await agentCommands.branchMessage({
      mode,
      operationId: createViewerUuid(),
      clientMessageId,
      parts: input.parts,
      sourceConversationId: target.conversationId,
      sourceStrandId: target.strandId,
      sourcePathEntryId: target.pathEntryId,
      expectedHeadRevision: target.headRevision,
      providerInstanceId: input.providerInstanceId,
      nativeModelId: selected.nativeId,
      reasoning: input.reasoning,
      serviceTier: input.serviceTier,
      access: input.access,
      configurationRevision: input.configurationRevision,
    });
    clearConversationDraftContent(target.conversationId);
    trackTranscriptUserMessage(result.conversationId, clientMessageId, result.turnId);
    setPhase('updating-transcript');
    await ensureConversation(result.conversationId, true);
    selectConversation(result.conversationId, result.turnId);
    await getTranscriptResourceState().setActiveConversationId(result.conversationId);
    await Promise.all([
      refresh([
        `agent/runtime:${result.conversationId}`,
        `agent/queue:${result.conversationId}`,
      ]),
      recoverActiveTranscriptResources({
        attempts: 4,
        // Editing replaces the active strand inside the same conversation. Keep
        // the previous revision mounted until the replacement topology arrives,
        // then let the layout reconciler reuse every inherited turn measurement.
        // A fork selects a new conversation with no destination cache, so its
        // first transcript read remains a cold/full layout initialization.
        forceFullMeasure: mode === 'fork',
        preserveReady: mode === 'edit',
        requiredTurnId: result.turnId,
        windowPolicy: 'tail',
      }),
    ]);
  }, [ensureConversation, nativeRuntime, refresh, selectConversation, setError]);

  const interrupt = useCallback(async () => {
    if (!conversation?.activeTurnId) return;
    setError(null);
    try {
      await agentCommands.interrupt(conversation.id, conversation.activeTurnId);
      await refresh([`agent/runtime:${conversation.id}`]);
    } catch (reason) {
      setError(messageOf(reason));
      throw reason;
    }
  }, [conversation?.activeTurnId, conversation?.id, refresh, setError]);

  const compact = useCallback(async () => {
    if (!conversation?.id || nativeRuntime?.conversationId !== conversation.id) return;
    setError(null);
    try {
      await agentCommands.compact(conversation.id);
      await refresh([
        `agent/runtime:${conversation.id}`,
        `agent/queue:${conversation.id}`,
      ]);
    } catch (reason) {
      setError(messageOf(reason));
      throw reason;
    }
  }, [conversation?.id, nativeRuntime?.conversationId, refresh, setError]);

  return { branchMessage, compact, interrupt, send };
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
