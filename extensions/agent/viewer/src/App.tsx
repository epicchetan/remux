import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import {
  openHostLink,
  parseRemuxViewerRoute,
  rpc,
  subscribeHostNavigate,
  subscribeHostStatus,
  updateHostTab,
} from '@remux/viewer-kit';

import {
  AGENT_METHODS,
  AGENT_RESOURCE_KEYS,
  type AgentResourceKey,
  type AgentRuntimeValue,
  type AuthValue,
  type ConversationSummary,
  type ConversationValue,
  type ModelsValue,
  type MessageSendResult,
} from '../../shared/protocol.ts';
import { ComposerContent } from './composer/content.tsx';
import { createEmptyComposerSnapshot } from './composer/model/composerModel.ts';
import { useComposerStore } from './composer/store.ts';
import { AgentDirectoryPicker } from './conversation/DirectoryPicker.tsx';
import {
  loadConversationDraft,
  loadNewChatDraft,
  persistConversationDraft,
  persistNewChatDraft,
  removeConversationDraft,
  removeNewChatDraft,
  type AgentNewChatDraft,
} from './conversation/drafts.ts';
import { shortenPath } from './conversation/format.ts';
import { useConversationHistoryStore } from './conversation/historyStore.ts';
import { AgentSidebar } from './conversation/Sidebar.tsx';
import { useConversationStore } from './conversation/store.ts';
import {
  activateDraftOperationId,
  confirmDraftOperationId,
  createViewerUuid,
  isViewerUuid,
  loadOrCreateDraftOperationId,
  replaceDraftOperationId,
} from './identity.ts';
import { setConversationRuntime } from './conversation/runtimeStore.ts';
import { useHostStore } from './ipc/hostStore.ts';
import { subscribeAgentResourceInvalidations } from './ipc/resourceInvalidations.ts';
import { AgentResourceReader } from './ipc/resources.ts';
import type { RemuxHostViewportMetrics } from './ipc/types.ts';
import { useAgentResumeSync } from './resumeSync.ts';
import { AgentTranscript } from './transcript/index.ts';
import {
  getTranscriptResourceState,
  observeTranscriptServerGeneration,
  refreshActiveTranscriptResources,
} from './transcript/resourceStore.ts';
import {
  discardTranscriptUserMessage,
  requestTranscriptTurnScroll,
  trackTranscriptUserMessage,
} from './transcript/viewportStore.ts';

export function App() {
  const [initialTarget] = useState(readInitialTarget);
  const [auth, setAuth] = useState<AuthValue | null>(null);
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
  const invalidateHistory = useConversationHistoryStore((state) => state.invalidate);
  const loadHistory = useConversationHistoryStore((state) => state.load);
  const resetHistoryReader = useConversationHistoryStore((state) => state.resetReader);
  const [runtime, setRuntime] = useState<AgentRuntimeValue | null>(null);
  const conversation = useMemo(
    () => conversationSummary ? projectConversation(conversationSummary, runtime) : null,
    [conversationSummary, runtime],
  );
  const [authBusy, setAuthBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connectionStatus = useHostStore((state) => state.connectionStatus);
  const hostViewportMetrics = useHostStore((state) => state.hostViewportMetrics);
  const getHostViewportMetrics = useHostStore((state) => state.getHostViewportMetrics);
  const initializeHost = useHostStore((state) => state.initialize);
  const cwd = useConversationStore((state) => state.cwd);
  const directoryPickerOpen = useConversationStore((state) => state.directoryPickerOpen);
  const initializeCwd = useConversationStore((state) => state.initializeCwd);
  const setCwd = useConversationStore((state) => state.setCwd);
  const modelId = useComposerStore((state) => state.modelId);
  const reasoning = useComposerStore((state) => state.reasoning);
  const composerSnapshot = useComposerStore((state) => state.snapshot);
  const setComposerDocument = useComposerStore((state) => state.setDocument);
  const setModelId = useComposerStore((state) => state.setModelId);
  const setModels = useComposerStore((state) => state.setModels);
  const setReasoning = useComposerStore((state) => state.setReasoning);
  const resourceReader = useRef(new AgentResourceReader());
  const conversationOperationId = useRef<string | null>(activeDraftId);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRefreshKeys = useRef(new Set<AgentResourceKey>());
  const composerRestorePendingRef = useRef<string | null>(null);
  const mainPaneRef = useRef<HTMLElement | null>(null);
  const bottomBarSlotRef = useRef<HTMLDivElement | null>(null);
  const hostViewportMetricsRef = useRef<RemuxHostViewportMetrics | null>(hostViewportMetrics);
  const composerPresentationActiveRef = useRef(false);
  const [composerDomFocused, setComposerDomFocused] = useState(false);
  const [composerLiftPx, setComposerLiftPx] = useState(0);
  const [pickerOverlayStyle, setPickerOverlayStyle] = useState<CSSProperties | null>(null);
  const composerShouldLift = directoryPickerOpen || composerDomFocused;
  const mainPaneStyle = { '--remux-composer-lift': `${composerLiftPx}px` } as CSSProperties;

  const refresh = useCallback(async (keys?: AgentResourceKey[]) => {
    const requestedKeys = keys ?? baseResourceKeys();
    try {
      const update = await resourceReader.current.read(requestedKeys);
      observeTranscriptServerGeneration(update.serverGeneration);
      if (update.generationChanged) {
        setRuntime(null);
      }
      for (const key of update.missing) {
        if (key === AGENT_RESOURCE_KEYS.runtime) setRuntime(null);
      }
      for (const [key, value] of update.values) {
        if (key === AGENT_RESOURCE_KEYS.auth) setAuth(value as AuthValue);
        if (key === AGENT_RESOURCE_KEYS.models) setModels(value as ModelsValue);
        if (key === AGENT_RESOURCE_KEYS.runtime) setRuntime(value as AgentRuntimeValue);
      }
      setError(null);
    } catch (refreshError) {
      setError(messageOf(refreshError));
    }
  }, [setModels]);

  useEffect(() => setConversationRuntime(runtime), [runtime]);

  const scheduleRefresh = useCallback((keys: AgentResourceKey[]) => {
    for (const key of keys) pendingRefreshKeys.current.add(key);
    if (refreshTimer.current) return;
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      const pending = [...pendingRefreshKeys.current];
      pendingRefreshKeys.current.clear();
      void refresh(pending);
    }, 16);
  }, [refresh]);

  useEffect(() => {
    initializeHost();
    void refresh();
    void loadHistory().then(() => {
      if (activeConversationIdRef.current) {
        return ensureConversation(activeConversationIdRef.current);
      }
      return null;
    });
    const unsubscribeEvents = subscribeAgentResourceInvalidations((invalidations) => {
      const resources = invalidations.filter((invalidation) => invalidation.type === 'resource');
      void invalidateHistory(resources);
      const keys = resources
        .map((invalidation) => invalidation.key as AgentResourceKey)
        .filter((key) => key === AGENT_RESOURCE_KEYS.auth ||
          key === AGENT_RESOURCE_KEYS.models || key === AGENT_RESOURCE_KEYS.runtime);
      if (keys.length > 0) scheduleRefresh(keys);
    });
    const unsubscribeStatus = subscribeHostStatus((status) => {
      if (status.status.type === 'connected' && status.status.cwd) initializeCwd(status.status.cwd);
    });
    return () => {
      unsubscribeEvents();
      unsubscribeStatus();
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, [ensureConversation, initializeCwd, initializeHost, invalidateHistory, loadHistory, refresh, scheduleRefresh]);

  useEffect(() => {
    if (connectionStatus.type === 'connected' && connectionStatus.cwd) initializeCwd(connectionStatus.cwd);
  }, [connectionStatus, initializeCwd]);

  useAgentResumeSync(useCallback(async () => {
    resourceReader.current.clear();
    resetHistoryReader();
    await Promise.all([
      refresh(),
      loadHistory({ preserveReady: true }),
      ...(activeConversationIdRef.current
        ? [ensureConversation(activeConversationIdRef.current, true)]
        : []),
    ]);
  }, [ensureConversation, loadHistory, refresh, resetHistoryReader]));

  useEffect(() => {
    activeConversationIdRef.current = activeConversationId;
    activeDraftIdRef.current = activeDraftId;
    draftRef.current = draft;
  }, [activeConversationId, activeDraftId, draft]);

  const restoreComposerSnapshot = useCallback((snapshot: ReturnType<typeof createEmptyComposerSnapshot>) => {
    composerRestorePendingRef.current = snapshot.contentKey;
    setComposerDocument(snapshot.document);
  }, [setComposerDocument]);

  useEffect(() => {
    if (activeDraftId && draft?.id === activeDraftId) {
      if (draft.cwd) setCwd(draft.cwd);
      if (draft.modelId) setModelId(draft.modelId);
      setReasoning(draft.reasoning);
      restoreComposerSnapshot(draft.snapshot);
    } else if (activeConversationId) {
      restoreComposerSnapshot(loadConversationDraft(activeConversationId) ?? createEmptyComposerSnapshot());
    }
  }, []);

  useEffect(() => {
    const pendingRestore = composerRestorePendingRef.current;
    if (pendingRestore !== null) {
      if (composerSnapshot.contentKey !== pendingRestore) return;
      composerRestorePendingRef.current = null;
    }
    if (!activeDraftId || draft?.id !== activeDraftId) {
      if (activeConversationId) {
        persistConversationDraft(activeConversationId, composerSnapshot);
      }
      return;
    }
    if (
      draft.cwd === cwd &&
      draft.modelId === modelId &&
      draft.reasoning === reasoning &&
      draft.snapshot.contentKey === composerSnapshot.contentKey
    ) return;
    const next = {
      ...draft,
      cwd,
      modelId,
      reasoning,
      snapshot: composerSnapshot,
      updatedAt: Date.now(),
    };
    draftRef.current = next;
    setDraft(next);
    persistNewChatDraft(next);
  }, [activeConversationId, activeDraftId, composerSnapshot, cwd, draft, modelId, reasoning]);

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
        snapshot,
        updatedAt: Date.now(),
      };
      draftRef.current = next;
      setDraft(next);
      persistNewChatDraft(next);
      return;
    }
    const currentConversationId = activeConversationIdRef.current;
    if (currentConversationId) persistConversationDraft(currentConversationId, snapshot);
  }, []);

  const activateDraft = useCallback((nextDraft: AgentNewChatDraft) => {
    activeConversationIdRef.current = null;
    activeDraftIdRef.current = nextDraft.id;
    draftRef.current = nextDraft;
    conversationOperationId.current = activateDraftOperationId(nextDraft.id);
    setActiveConversationId(null);
    setActiveDraftId(nextDraft.id);
    setDraft(nextDraft);
    setCwd(nextDraft.cwd);
    if (nextDraft.modelId) setModelId(nextDraft.modelId);
    setReasoning(nextDraft.reasoning);
    restoreComposerSnapshot(nextDraft.snapshot);
    setError(null);
    void getTranscriptResourceState().setActiveConversationId(null);
  }, [restoreComposerSnapshot, setCwd, setModelId, setReasoning]);

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
      conversationOperationId.current = null;
      setActiveConversationId(normalized);
      setActiveDraftId(null);
      restoreComposerSnapshot(loadConversationDraft(normalized) ?? createEmptyComposerSnapshot());
      setError(null);
      void getTranscriptResourceState().setActiveConversationId(normalized);
      void ensureConversation(normalized);
    }
    if (focusTurnId) requestTranscriptTurnScroll(normalized, focusTurnId);
  }, [ensureConversation, restoreComposerSnapshot, saveCurrentTargetDraft]);

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

  const updatePickerGeometry = useCallback(() => {
    if (!directoryPickerOpen) {
      setPickerOverlayStyle(null);
      return;
    }
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      const mainPane = mainPaneRef.current;
      const bottomBar = bottomBarSlotRef.current;
      if (!mainPane || !bottomBar) return;
      const mainRect = mainPane.getBoundingClientRect();
      const bottomBarRect = bottomBar.getBoundingClientRect();
      void getHostViewportMetrics()
        .then((metrics) => setPickerOverlayStyle(measurePickerOverlay(mainRect, bottomBarRect, metrics)))
        .catch(() => setPickerOverlayStyle(measurePickerOverlay(mainRect, bottomBarRect, null)));
    }));
  }, [directoryPickerOpen, getHostViewportMetrics]);

  const updateComposerLiftGeometry = useCallback(() => {
    window.requestAnimationFrame(() => {
      const mainPane = mainPaneRef.current;
      if (!mainPane || !composerPresentationActiveRef.current) return;
      const mainRect = mainPane.getBoundingClientRect();
      const metrics = hostViewportMetricsRef.current;
      if (metrics) {
        setComposerLiftPx(measureComposerLift(mainRect, metrics));
        return;
      }
      void getHostViewportMetrics()
        .then((next) => {
          if (composerPresentationActiveRef.current) setComposerLiftPx(measureComposerLift(mainRect, next));
        })
        .catch(() => {
          if (composerPresentationActiveRef.current) setComposerLiftPx(measureVisualViewportComposerLift(mainRect));
        });
    });
  }, [getHostViewportMetrics]);

  useEffect(() => {
    hostViewportMetricsRef.current = hostViewportMetrics;
    composerPresentationActiveRef.current = composerShouldLift;
    if (composerShouldLift) updateComposerLiftGeometry();
  }, [composerShouldLift, hostViewportMetrics, updateComposerLiftGeometry]);

  useEffect(() => {
    let frame = 0;
    const update = () => setComposerDomFocused(activeElementInComposer());
    const schedule = () => {
      if (frame) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        update();
      });
    };
    document.addEventListener('focusin', update);
    document.addEventListener('focusout', schedule);
    update();
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      document.removeEventListener('focusin', update);
      document.removeEventListener('focusout', schedule);
    };
  }, []);

  useEffect(() => {
    if (!composerShouldLift) {
      setComposerLiftPx(0);
      return;
    }
    updateComposerLiftGeometry();
    const viewport = window.visualViewport;
    const observer = new ResizeObserver(updateComposerLiftGeometry);
    if (mainPaneRef.current) observer.observe(mainPaneRef.current);
    if (bottomBarSlotRef.current) observer.observe(bottomBarSlotRef.current);
    const timers = [50, 150, 300, 500].map((delay) => window.setTimeout(updateComposerLiftGeometry, delay));
    window.addEventListener('resize', updateComposerLiftGeometry);
    viewport?.addEventListener('resize', updateComposerLiftGeometry);
    viewport?.addEventListener('scroll', updateComposerLiftGeometry);
    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
      observer.disconnect();
      window.removeEventListener('resize', updateComposerLiftGeometry);
      viewport?.removeEventListener('resize', updateComposerLiftGeometry);
      viewport?.removeEventListener('scroll', updateComposerLiftGeometry);
    };
  }, [composerShouldLift, updateComposerLiftGeometry]);

  useEffect(() => {
    if (!directoryPickerOpen) {
      setPickerOverlayStyle(null);
      return;
    }
    updatePickerGeometry();
    const viewport = window.visualViewport;
    const observer = new ResizeObserver(updatePickerGeometry);
    if (mainPaneRef.current) observer.observe(mainPaneRef.current);
    if (bottomBarSlotRef.current) observer.observe(bottomBarSlotRef.current);
    window.addEventListener('resize', updatePickerGeometry);
    viewport?.addEventListener('resize', updatePickerGeometry);
    viewport?.addEventListener('scroll', updatePickerGeometry);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updatePickerGeometry);
      viewport?.removeEventListener('resize', updatePickerGeometry);
      viewport?.removeEventListener('scroll', updatePickerGeometry);
    };
  }, [directoryPickerOpen, updatePickerGeometry]);

  useEffect(() => {
    if (directoryPickerOpen) updatePickerGeometry();
  }, [composerLiftPx, directoryPickerOpen, hostViewportMetrics, updatePickerGeometry]);

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

  const createConversation = useCallback(async () => {
    if (!modelId || !cwd) throw new Error('Choose a workspace and model first.');
    const operationId = conversationOperationId.current ?? loadOrCreateDraftOperationId();
    const sourceDraftId = activeDraftIdRef.current;
    conversationOperationId.current = operationId;
    const result = await rpc.command<{ conversationId: string }>(AGENT_METHODS.conversationCreate, {
      operationId,
      cwd,
      modelId,
      reasoning,
    });
    conversationOperationId.current = null;
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
  }, [cwd, ensureConversation, modelId, reasoning]);

  const send = useCallback(async (
    text: string,
    setPhase: (phase: 'sending' | 'updating-transcript') => void,
  ) => {
    setError(null);
    const activeId = activeConversationIdRef.current ?? await createConversation();
    setPhase('sending');
    const clientMessageId = createViewerUuid();
    const operationId = createViewerUuid();
    trackTranscriptUserMessage(activeId, clientMessageId);
    let sent: MessageSendResult;
    try {
      sent = await rpc.command<MessageSendResult>(AGENT_METHODS.messageSend, {
        operationId,
        conversationId: activeId,
        clientMessageId,
        text,
      });
    } catch (reason) {
      discardTranscriptUserMessage(clientMessageId);
      throw reason;
    }
    trackTranscriptUserMessage(activeId, clientMessageId, sent.turnId);
    setPhase('updating-transcript');
    removeConversationDraft(activeId);
    await Promise.all([
      refresh([AGENT_RESOURCE_KEYS.runtime]),
      ensureConversation(activeId, true),
      ...(activeConversationIdRef.current === activeId
        ? [refreshActiveTranscriptResources({ forceFullMeasure: false, preserveReady: true, windowPolicy: 'tail' })]
        : []),
    ]);
  }, [conversation?.id, createConversation, ensureConversation, refresh]);

  const interrupt = useCallback(async () => {
    if (!conversation?.activeTurnId) return;
    setError(null);
    try {
      await rpc.command(AGENT_METHODS.turnInterrupt, {
        conversationId: conversation.id,
        turnId: conversation.activeTurnId,
      });
      await refresh([AGENT_RESOURCE_KEYS.runtime]);
    } catch (reason) {
      setError(messageOf(reason));
      throw reason;
    }
  }, [conversation?.activeTurnId, conversation?.id, refresh]);

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

  if (!auth) {
    return <main className="agent-app agent-center"><p>Connecting to agent runtime…</p></main>;
  }

  if (auth.state !== 'signed-in') {
    return (
      <main className="agent-app agent-center">
        <section className="agent-auth-card">
          <div className="agent-auth-kicker">Remux Agent</div>
          <h1>Connect your OpenAI subscription</h1>
          <p>This runtime reads Pi’s OpenAI Codex OAuth credential store. Tokens never enter the viewer.</p>
          {auth.userCode ? <code className="agent-device-code">{auth.userCode}</code> : null}
          {auth.progress ? <p className="agent-muted">{auth.progress}</p> : null}
          {auth.error || error ? <p className="agent-error" role="alert">{auth.error ?? error}</p> : null}
          <div className="agent-auth-actions">
            {auth.verificationUri ? (
              <button type="button" onClick={() => void openHostLink({ url: auth.verificationUri! })}>Open verification page</button>
            ) : null}
            {auth.state === 'signing-in' ? (
              <button type="button" className="agent-secondary" onClick={() => {
                if (auth.operationId) void runAuth(() => rpc.command(AGENT_METHODS.authLoginCancel, { operationId: auth.operationId }));
              }}>Cancel</button>
            ) : (
              <button type="button" onClick={() => void runAuth(() => rpc.command(AGENT_METHODS.authLoginStart))} disabled={authBusy}>Sign in with device code</button>
            )}
          </div>
        </section>
      </main>
    );
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
        <div className="remux-bottom-bar-slot" ref={bottomBarSlotRef}>
          <ComposerContent
            conversation={conversation}
            conversationSelected={Boolean(activeConversationId)}
            onInterrupt={interrupt}
            onNewChat={() => startNewChat()}
            onSend={send}
            onSignOut={() => void runAuth(() => rpc.command(AGENT_METHODS.authLogout))}
            runtimeError={error ?? conversation?.error ?? null}
          />
        </div>
        {directoryPickerOpen ? (
          <div className="remux-file-mention-overlay" data-remux-no-composer-focus style={pickerOverlayStyle ?? undefined}>
            <AgentDirectoryPicker />
          </div>
        ) : null}
      </section>
    </main>
  );
}

type AgentInitialTarget =
  | { focusTurnId: string | null; id: string; kind: 'conversation' }
  | { id: string; kind: 'draft' };

function readInitialTarget(): AgentInitialTarget {
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

function initialDraft(id: string): AgentNewChatDraft {
  return loadNewChatDraft(id) ?? {
    cwd: '',
    id,
    modelId: '',
    reasoning: 'high',
    snapshot: createEmptyComposerSnapshot(),
    updatedAt: Date.now(),
  };
}

function baseResourceKeys(): AgentResourceKey[] {
  return [
    AGENT_RESOURCE_KEYS.auth,
    AGENT_RESOURCE_KEYS.models,
    AGENT_RESOURCE_KEYS.runtime,
  ];
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

function hostKeyboardActive(metrics: RemuxHostViewportMetrics | null) {
  return Boolean(metrics && (metrics.keyboardVisible || metrics.keyboardHeight > 0 || metrics.visibleBottom < metrics.viewportHeight));
}

function measureComposerLift(mainRect: DOMRect, metrics: RemuxHostViewportMetrics | null) {
  if (!hostKeyboardActive(metrics) || !metrics || metrics.viewportHeight <= 0) return measureVisualViewportComposerLift(mainRect);
  const visibleBottom = Math.max(0, Math.min(metrics.viewportHeight, metrics.visibleBottom));
  return visibleBottom > 0 ? Math.max(0, Math.ceil(mainRect.bottom - visibleBottom)) : measureVisualViewportComposerLift(mainRect);
}

function measureVisualViewportComposerLift(mainRect: DOMRect) {
  const viewport = window.visualViewport;
  return viewport ? Math.max(0, Math.ceil(mainRect.bottom - (viewport.offsetTop + viewport.height))) : 0;
}

function measurePickerOverlay(mainRect: DOMRect, bottomBarRect: DOMRect, metrics: RemuxHostViewportMetrics | null): CSSProperties {
  const top = Math.max(0, -mainRect.top);
  const fallbackBottom = Math.max(top, bottomBarRect.top - mainRect.top);
  const maxBottom = Math.max(top, mainRect.height - bottomBarRect.height);
  const hostBottom = metrics && metrics.viewportHeight > 0
    ? metrics.visibleBottom - bottomBarRect.height - mainRect.top
    : fallbackBottom;
  const bottom = Math.max(top, Math.min(hostKeyboardActive(metrics) ? hostBottom : fallbackBottom, maxBottom));
  return { height: Math.max(0, bottom - top), top };
}

function activeElementInComposer() {
  const active = document.activeElement;
  return active instanceof Element && Boolean(active.closest('[data-remux-composer-root]'));
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
