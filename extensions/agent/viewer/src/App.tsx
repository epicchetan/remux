import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';

import {
  queueResourceKey,
  type AgentRuntimeValue,
  type ConversationSummary,
  type ConversationValue,
} from '../../shared/protocol.ts';
import { ComposerContent } from './composer/content.tsx';
import { AgentAuthScreen } from './auth/AgentAuthScreen.tsx';
import { createEmptyComposerSnapshot } from './composer/model/composerModel.ts';
import { createDefaultTurnContextPlan } from './composer/context/contextPlan.ts';
import { composerResourcesFromSnapshot } from './composer/model/userInputInterop.ts';
import { ComposerMentionPicker } from './composer/mentions/MentionPicker.tsx';
import { parseComposerMentionQuery } from './composer/mentions/mentionSearch.ts';
import { useComposerStore } from './composer/store.ts';
import { AgentDirectoryPicker } from './conversation/DirectoryPicker.tsx';
import {
  loadConversationDraft,
  loadNewChatDraft,
  persistConversationDraft,
  persistNewChatDraft,
  type AgentNewChatDraft,
} from './conversation/drafts.ts';
import { shortenPath } from './conversation/format.ts';
import { useConversationHistoryStore } from './conversation/historyStore.ts';
import { AgentSidebar } from './conversation/Sidebar.tsx';
import { useConversationStore } from './conversation/store.ts';
import {
  activateDraftOperationId,
  isViewerUuid,
  replaceDraftOperationId,
} from './identity.ts';
import { useHostStore } from './ipc/hostStore.ts';
import { agentCommands } from './ipc/agentCommands.ts';
import { useComposerViewport } from './app/useComposerViewport.ts';
import { useAgentResources } from './app/useAgentResources.ts';
import { readInitialTarget, useAgentNavigation } from './app/useAgentNavigation.ts';
import { useConversationActions } from './app/useConversationActions.ts';
import { AgentTranscript } from './transcript/index.ts';
import { getTranscriptResourceState } from './transcript/resourceStore.ts';
import {
  requestTranscriptTurnScroll,
} from './transcript/viewportStore.ts';

export function App() {
  const [initialTarget] = useState(readInitialTarget);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(
    initialTarget.kind === 'conversation' ? initialTarget.id : null,
  );
  const [activeDraftId, setActiveDraftId] = useState<string | null>(
    initialTarget.kind === 'draft' ? initialTarget.id : null,
  );
  const [draft, setDraft] = useState<AgentNewChatDraft | null>(() =>
    initialTarget.kind === 'draft' ? initialDraft(initialTarget.id) : null);
  useEffect(() => {
    if (initialTarget.kind === 'conversation' && initialTarget.focusTurnId) {
      requestTranscriptTurnScroll(initialTarget.id, initialTarget.focusTurnId);
    }
  }, [initialTarget]);
  const activeConversationIdRef = useRef(activeConversationId);
  const activeDraftIdRef = useRef(activeDraftId);
  const draftRef = useRef(draft);
  const conversationSummary = useConversationHistoryStore((state) =>
    activeConversationId ? state.conversationsById[activeConversationId] ?? null : null);
  const conversationMissing = useConversationHistoryStore((state) =>
    activeConversationId ? Boolean(state.missingById[activeConversationId]) : false);
  const ensureConversation = useConversationHistoryStore((state) => state.ensureConversation);
  const {
    auth,
    connectionStatus,
    contextInspector,
    error,
    queue,
    refresh,
    runtime,
    setError,
  } = useAgentResources(activeConversationId, activeConversationIdRef);
  const conversation = useMemo(
    () => conversationSummary ? projectConversation(conversationSummary, runtime) : null,
    [conversationSummary, runtime],
  );
  const [authBusy, setAuthBusy] = useState(false);
  const hostViewportMetrics = useHostStore((state) => state.hostViewportMetrics);
  const getHostViewportMetrics = useHostStore((state) => state.getHostViewportMetrics);
  const cwd = useConversationStore((state) => state.cwd);
  const directoryPickerOpen = useConversationStore((state) => state.directoryPickerOpen);
  const setCwd = useConversationStore((state) => state.setCwd);
  const modelId = useComposerStore((state) => state.modelId);
  const reasoning = useComposerStore((state) => state.reasoning);
  const composerSnapshot = useComposerStore((state) => state.snapshot);
  const contextPlan = useComposerStore((state) => state.contextPlan);
  const composerPresentationRequest = useComposerStore((state) => state.composerPresentationRequest);
  const editTarget = useComposerStore((state) => state.editTarget);
  const focusComposer = useComposerStore((state) => state.focusComposer);
  const forkTarget = useComposerStore((state) => state.forkTarget);
  const mentionSession = useComposerStore((state) => state.mentionSession);
  const setComposerDocument = useComposerStore((state) => state.setComposerDocument);
  const setContextPlan = useComposerStore((state) => state.setContextPlan);
  const setModelId = useComposerStore((state) => state.setModelId);
  const setReasoning = useComposerStore((state) => state.setReasoning);
  const composerRestorePendingRef = useRef<string | null>(null);
  const mainPaneRef = useRef<HTMLElement | null>(null);
  const bottomBarSlotRef = useRef<HTMLDivElement | null>(null);
  const mentionQuery = mentionSession
    ? parseComposerMentionQuery(mentionSession.query).normalizedQuery
    : '';
  const mentionPickerVisible = mentionQuery.length > 0;
  const composerPresentationActive = Boolean(editTarget || forkTarget || mentionSession);
  const {
    mainPaneStyle,
    pickerOverlayStyle,
    pickerOverlayVisible,
  } = useComposerViewport({
    bottomBarSlotRef,
    composerPresentationRequestId: composerPresentationRequest.id,
    directoryPickerOpen,
    focusComposer,
    getHostViewportMetrics,
    hostViewportMetrics,
    mainPaneRef,
    mentionPickerVisible,
    presentationActive: composerPresentationActive,
  });

  useEffect(() => {
    activeConversationIdRef.current = activeConversationId;
    activeDraftIdRef.current = activeDraftId;
    draftRef.current = draft;
  }, [activeConversationId, activeDraftId, draft]);

  const restoreComposerSnapshot = useCallback((snapshot: ReturnType<typeof createEmptyComposerSnapshot>) => {
    composerRestorePendingRef.current = snapshot.contentKey;
    setComposerDocument(snapshot.document, composerResourcesFromSnapshot(snapshot));
  }, [setComposerDocument]);

  useEffect(() => {
    if (activeDraftId) {
      const currentDraft = draftRef.current?.id === activeDraftId
        ? draftRef.current
        : loadNewChatDraft(activeDraftId);
      if (!currentDraft) return;
      if (currentDraft.cwd) setCwd(currentDraft.cwd);
      if (currentDraft.modelId) setModelId(currentDraft.modelId);
      setReasoning(currentDraft.reasoning);
      setContextPlan(currentDraft.contextPlan);
      restoreComposerSnapshot(currentDraft.snapshot);
    } else if (activeConversationId) {
      const currentDraft = loadConversationDraft(activeConversationId);
      setContextPlan(currentDraft.contextPlan);
      restoreComposerSnapshot(currentDraft.snapshot);
    } else {
      setContextPlan(createDefaultTurnContextPlan());
    }
  }, [activeConversationId, activeDraftId, restoreComposerSnapshot, setContextPlan, setCwd, setModelId, setReasoning]);

  useEffect(() => {
    const pendingRestore = composerRestorePendingRef.current;
    if (pendingRestore !== null) {
      if (composerSnapshot.contentKey !== pendingRestore) return;
      composerRestorePendingRef.current = null;
    }
    if (!activeDraftId || draft?.id !== activeDraftId) {
      if (activeConversationId) {
        persistConversationDraft(activeConversationId, composerSnapshot, contextPlan);
      }
      return;
    }
    if (
      draft.cwd === cwd &&
      draft.modelId === modelId &&
      draft.reasoning === reasoning &&
      sameContextPlan(draft.contextPlan, contextPlan) &&
      draft.snapshot.contentKey === composerSnapshot.contentKey
    ) return;
    const next = {
      ...draft,
      cwd,
      modelId,
      reasoning,
      contextPlan,
      snapshot: composerSnapshot,
      updatedAt: Date.now(),
    };
    draftRef.current = next;
    setDraft(next);
    persistNewChatDraft(next);
  }, [activeConversationId, activeDraftId, composerSnapshot, contextPlan, cwd, draft, modelId, reasoning]);

  useEffect(() => {
    if (!activeConversationId || !conversationSummary) return;
    setCwd(conversationSummary.cwd);
    setModelId(conversationSummary.modelId);
    setReasoning(conversationSummary.reasoning);
  }, [activeConversationId, conversationSummary, setCwd, setModelId, setReasoning]);

  const saveCurrentTargetDraft = useCallback(() => {
    const snapshot = useComposerStore.getState().snapshot;
    const currentDraftId = activeDraftIdRef.current;
    if (currentDraftId) {
      const current = draftRef.current ?? initialDraft(currentDraftId);
      const next: AgentNewChatDraft = {
        ...current,
        cwd: useConversationStore.getState().cwd,
        modelId: useComposerStore.getState().modelId,
        reasoning: useComposerStore.getState().reasoning,
        contextPlan: useComposerStore.getState().contextPlan,
        snapshot,
        updatedAt: Date.now(),
      };
      draftRef.current = next;
      setDraft(next);
      persistNewChatDraft(next);
      return;
    }
    const currentConversationId = activeConversationIdRef.current;
    if (currentConversationId) {
      persistConversationDraft(currentConversationId, snapshot, useComposerStore.getState().contextPlan);
    }
  }, []);

  const activateDraft = useCallback((nextDraft: AgentNewChatDraft) => {
    activeConversationIdRef.current = null;
    activeDraftIdRef.current = nextDraft.id;
    draftRef.current = nextDraft;
    setActiveConversationId(null);
    setActiveDraftId(nextDraft.id);
    setDraft(nextDraft);
    setCwd(nextDraft.cwd);
    if (nextDraft.modelId) setModelId(nextDraft.modelId);
    setReasoning(nextDraft.reasoning);
    setContextPlan(nextDraft.contextPlan);
    restoreComposerSnapshot(nextDraft.snapshot);
    setError(null);
    void getTranscriptResourceState().setActiveConversationId(null);
  }, [restoreComposerSnapshot, setContextPlan, setCwd, setModelId, setReasoning]);

  const selectDraft = useCallback(() => {
    const nextDraft = draftRef.current;
    if (!nextDraft || activeDraftIdRef.current === nextDraft.id) return;
    saveCurrentTargetDraft();
    activateDraft(nextDraft);
  }, [activateDraft, saveCurrentTargetDraft]);

  const startNewChat = useCallback((preferredDraftId?: string | null) => {
    saveCurrentTargetDraft();
    const existing = preferredDraftId && isViewerUuid(preferredDraftId)
      ? loadNewChatDraft(preferredDraftId)
      : draftRef.current;
    if (existing) {
      activateDraft(existing);
      return;
    }
    const id = preferredDraftId && isViewerUuid(preferredDraftId)
      ? activateDraftOperationId(preferredDraftId)
      : replaceDraftOperationId();
    const selected = activeConversationIdRef.current
      ? useConversationHistoryStore.getState().conversationsById[activeConversationIdRef.current]
      : null;
    const nextDraft: AgentNewChatDraft = {
      cwd: selected?.cwd ?? useConversationStore.getState().cwd,
      id,
      modelId: selected?.modelId ?? useComposerStore.getState().modelId,
      reasoning: selected?.reasoning ?? useComposerStore.getState().reasoning,
      contextPlan: createDefaultTurnContextPlan(),
      snapshot: createEmptyComposerSnapshot(),
      updatedAt: Date.now(),
    };
    persistNewChatDraft(nextDraft);
    activateDraft(nextDraft);
  }, [activateDraft, saveCurrentTargetDraft]);

  const selectConversation = useCallback((conversationId: string, focusTurnId?: string | null) => {
    const normalized = conversationId.trim();
    if (!normalized) return;
    if (activeConversationIdRef.current !== normalized || activeDraftIdRef.current) {
      saveCurrentTargetDraft();
      activeConversationIdRef.current = normalized;
      activeDraftIdRef.current = null;
      setActiveConversationId(normalized);
      setActiveDraftId(null);
      const currentDraft = loadConversationDraft(normalized);
      setContextPlan(currentDraft.contextPlan);
      restoreComposerSnapshot(currentDraft.snapshot);
      setError(null);
      void getTranscriptResourceState().setActiveConversationId(normalized);
      void ensureConversation(normalized);
    }
    if (focusTurnId) requestTranscriptTurnScroll(normalized, focusTurnId);
  }, [ensureConversation, restoreComposerSnapshot, saveCurrentTargetDraft, setContextPlan]);

  useAgentNavigation({
    activeConversationId,
    activeDraftId,
    conversation,
    conversationMissing,
    conversationSummary,
    selectConversation,
    startNewChat,
  });

  const runAuth = useCallback(async (action: () => Promise<unknown>) => {
    setAuthBusy(true);
    setError(null);
    try {
      await action();
      await refresh();
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setAuthBusy(false);
    }
  }, [refresh]);

  const { branchMessage, interrupt, send } = useConversationActions({
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
  });

  if (!auth) {
    return <main className="agent-app agent-center"><p>Connecting to agent runtime…</p></main>;
  }

  if (auth.state !== 'signed-in') {
    return <AgentAuthScreen auth={auth} busy={authBusy} error={error} run={(action) => void runAuth(action)} />;
  }

  return (
    <main className="agent-app" data-connection={connectionStatus.type} onPointerDownCapture={blurComposerOnOutsideTap}>
      <AgentSidebar
        activeConversationId={activeConversationId}
        activeDraftId={activeDraftId}
        draft={draft}
        onSelectConversation={selectConversation}
        onSelectDraft={selectDraft}
        onStartNewChat={() => startNewChat()}
      />
      <AgentSidebar.Mobile
        activeConversationId={activeConversationId}
        activeDraftId={activeDraftId}
        draft={draft}
        onSelectConversation={selectConversation}
        onSelectDraft={selectDraft}
        onStartNewChat={() => startNewChat()}
      />
      <section className="remux-main-pane" ref={mainPaneRef} style={mainPaneStyle}>
        <div className="remux-transcript-slot">
          <div className="agent-chat-view">
            {conversation ? <AgentTranscript conversationId={conversation.id} /> : (
            <div className="remux-new-chat-empty">
              <div className="remux-new-chat-empty-card">
                <div className="remux-new-chat-empty-title">
                  {conversationMissing ? 'Conversation unavailable' : activeConversationId ? 'Loading conversation…' : 'New chat'}
                </div>
                <div className="remux-new-chat-empty-path">
                  {conversationMissing
                    ? 'This durable conversation could not be found.'
                    : cwd ? shortenPath(cwd) : 'Pick a working directory to start'}
                </div>
              </div>
            </div>
            )}
          </div>
        </div>
        <div className="remux-bottom-bar-slot" ref={bottomBarSlotRef}>
          <ComposerContent
            conversation={conversation}
            contextInspector={contextInspector}
            conversationSelected={Boolean(activeConversationId)}
            onInterrupt={interrupt}
            onEdit={(target, input, setPhase) => branchMessage('edit', target, input, setPhase)}
            onFork={(target, input, setPhase) => branchMessage('fork', target, input, setPhase)}
            onQueueChanged={() => activeConversationId
              ? refresh([queueResourceKey(activeConversationId)])
              : Promise.resolve()}
            onSend={send}
            onSignOut={() => void runAuth(() => agentCommands.logout())}
            runtimeError={error ?? conversation?.error ?? null}
            queue={queue}
          />
        </div>
        {pickerOverlayVisible ? (
          <div className="remux-file-mention-overlay" data-remux-no-composer-focus style={pickerOverlayStyle ?? undefined}>
            {mentionPickerVisible && mentionSession
              ? <ComposerMentionPicker session={mentionSession} />
              : directoryPickerOpen ? <AgentDirectoryPicker /> : null}
          </div>
        ) : null}
      </section>
    </main>
  );
}

function initialDraft(id: string): AgentNewChatDraft {
  return loadNewChatDraft(id) ?? {
    cwd: '',
    id,
    modelId: '',
    reasoning: 'high',
    contextPlan: createDefaultTurnContextPlan(),
    snapshot: createEmptyComposerSnapshot(),
    updatedAt: Date.now(),
  };
}

function sameContextPlan(
  left: AgentNewChatDraft['contextPlan'],
  right: AgentNewChatDraft['contextPlan'],
) {
  return left.automaticDialogueTurns === right.automaticDialogueTurns &&
    left.overrides.length === right.overrides.length &&
    left.overrides.every((override, index) => {
      const candidate = right.overrides[index];
      return candidate?.turnId === override.turnId && candidate.resolution === override.resolution;
    });
}

function projectConversation(summary: ConversationSummary, runtime: AgentRuntimeValue | null): ConversationValue {
  const loaded = runtime?.conversationId === summary.id;
  const liveStatus = loaded && runtime.state !== 'unloaded' ? runtime.state : null;
  return {
    ...summary,
    status: liveStatus ?? summary.status,
    activeTurnId: loaded ? runtime.activeTurnId : null,
    activeTurnElapsedMs: loaded ? runtime.activeTurnElapsedMs : null,
    contextProbe: loaded && runtime.contextProbe ? runtime.contextProbe : emptyContextProbe(summary.modelId),
    error: loaded ? runtime.error : null,
  };
}

function emptyContextProbe(modelId: string): ConversationValue['contextProbe'] {
  return {
    hookVersion: 'agent-durable-v1',
    modelCallCount: 0,
    messageCount: 0,
    messageHash: null,
    orderedMessageHashes: [],
    estimatedBytes: 0,
    provider: 'openai-codex',
    modelId,
    providerRequestMode: 'none',
  };
}

function blurComposerOnOutsideTap(event: PointerEvent<HTMLElement>) {
  if (event.defaultPrevented || event.button !== 0) return;
  const target = event.target;
  if (!(target instanceof Element) || target.closest('.remux-bottom-bar, .remux-file-mention-picker, [data-remux-no-composer-focus]')) return;
  const active = document.activeElement;
  if (active instanceof HTMLElement && (active.isContentEditable || active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement)) active.blur();
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
