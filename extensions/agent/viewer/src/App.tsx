import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';

import {
  type AgentRuntimeValue,
  type ConversationSummary,
  type ConversationValue,
  type ModelsValue,
  type ReasoningEffort,
} from '../../shared/protocol.ts';
import type { AgentProvidersResource, AgentRuntimeResource } from '../../shared/native-agent-protocol.ts';
import type { ProviderAccess } from '../../shared/provider-runtime.ts';
import { ComposerContent } from './composer/content.tsx';
import { AgentAuthScreen } from './auth/AgentAuthScreen.tsx';
import { createEmptyComposerSnapshot } from './composer/model/composerModel.ts';
import { composerResourcesFromSnapshot } from './composer/model/userInputInterop.ts';
import { ComposerMentionPicker } from './composer/mentions/MentionPicker.tsx';
import { parseComposerMentionQuery } from './composer/mentions/mentionSearch.ts';
import { preferredReasoning, preferredServiceTier, resolveModel } from './composer/config/modelSelection.ts';
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
import { viewerModelId } from './nativeViewModel.ts';
import { useComposerViewport } from './app/useComposerViewport.ts';
import { useAgentResources } from './app/useAgentResources.ts';
import { AgentExecutionsView } from './agents/AgentExecutionsView.tsx';
import { useAgentExecutions } from './agents/useAgentExecutions.ts';
import { readInitialTarget, useAgentNavigation } from './app/useAgentNavigation.ts';
import { useConversationActions } from './app/useConversationActions.ts';
import { AgentTranscript } from './transcript/index.ts';
import {
  getTranscriptResourceState,
  retryActiveTranscriptHistorySync,
} from './transcript/resourceStore.ts';
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
    error,
    nativeRuntime,
    providers,
    queue,
    refresh,
    runtime,
    setError,
  } = useAgentResources(activeConversationId, activeConversationIdRef);
  const agentExecutions = useAgentExecutions(
    activeConversationId,
    nativeRuntime?.executionId ?? null,
  );
  const [agentsOpen, setAgentsOpen] = useState(false);
  const [selectedAgentExecutionId, setSelectedAgentExecutionId] = useState<string | null>(null);
  const authProvider = providers?.providers.find(({ state }) => state === 'ready')
    ?? providers?.providers.find(({ provider }) => provider === 'codex')
    ?? providers?.providers[0]
    ?? null;
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
  const serviceTier = useComposerStore((state) => state.serviceTier);
  const providerInstanceId = useComposerStore((state) => state.providerInstanceId);
  const access = useComposerStore((state) => state.access);
  const composerModels = useComposerStore((state) => state.models);
  const composerSnapshot = useComposerStore((state) => state.snapshot);
  const composerPresentationRequest = useComposerStore((state) => state.composerPresentationRequest);
  const blurComposer = useComposerStore((state) => state.blurComposer);
  const clearComposerMode = useComposerStore((state) => state.clearMode);
  const editTarget = useComposerStore((state) => state.editTarget);
  const focusComposer = useComposerStore((state) => state.focusComposer);
  const forkTarget = useComposerStore((state) => state.forkTarget);
  const mentionSession = useComposerStore((state) => state.mentionSession);
  const setComposerDocument = useComposerStore((state) => state.setComposerDocument);
  const setModelId = useComposerStore((state) => state.setModelId);
  const setReasoning = useComposerStore((state) => state.setReasoning);
  const setServiceTier = useComposerStore((state) => state.setServiceTier);
  const setProviderInstanceId = useComposerStore((state) => state.setProviderInstanceId);
  const setAccess = useComposerStore((state) => state.setAccess);
  const composerRestorePendingRef = useRef<string | null>(null);
  const draftConfigurationsRef = useRef(new Map<string, DraftComposerConfiguration>());
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
    blurComposer,
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

  useEffect(() => {
    setAgentsOpen(false);
    setSelectedAgentExecutionId(null);
  }, [activeConversationId, activeDraftId]);

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
      setAccess(currentDraft.access);
      const configuration = draftConfigurationsRef.current.get(activeDraftId);
      if (configuration) {
        setProviderInstanceId(configuration.providerInstanceId);
        setModelId(configuration.modelId);
        setReasoning(configuration.reasoning);
        setServiceTier(configuration.serviceTier);
        setAccess(configuration.access);
      }
      restoreComposerSnapshot(currentDraft.snapshot);
    } else if (activeConversationId) {
      const currentDraft = loadConversationDraft(activeConversationId);
      restoreComposerSnapshot(currentDraft.snapshot);
    }
  }, [
    activeConversationId,
    activeDraftId,
    restoreComposerSnapshot,
    setAccess,
    setCwd,
    setModelId,
    setProviderInstanceId,
    setReasoning,
    setServiceTier,
  ]);

  useEffect(() => {
    if (!activeDraftId || activeConversationId || !providers || !composerModels) return;
    const current = draftConfigurationsRef.current.get(activeDraftId);
    const configuration = current
      && providers.providers.some(({ providerInstanceId: id, state }) =>
        id === current.providerInstanceId && state === 'ready')
      && composerModels.models.some(({ id }) => id === current.modelId)
      ? current
      : (() => {
          const fallback = defaultDraftConfiguration(providers, composerModels);
          const persisted = draftRef.current?.id === activeDraftId
            ? draftRef.current
            : loadNewChatDraft(activeDraftId);
          return fallback && persisted ? { ...fallback, access: persisted.access } : fallback;
        })();
    if (!configuration) return;
    draftConfigurationsRef.current.set(activeDraftId, configuration);
    setProviderInstanceId(configuration.providerInstanceId);
    setModelId(configuration.modelId);
    setReasoning(configuration.reasoning);
    setServiceTier(configuration.serviceTier);
    setAccess(configuration.access);
  }, [
    activeConversationId,
    activeDraftId,
    composerModels,
    providers,
    setAccess,
    setModelId,
    setProviderInstanceId,
    setReasoning,
    setServiceTier,
  ]);

  useEffect(() => {
    const pendingRestore = composerRestorePendingRef.current;
    if (pendingRestore !== null) {
      if (composerSnapshot.contentKey !== pendingRestore) return;
      composerRestorePendingRef.current = null;
      return;
    }
    if (!activeDraftId || draft?.id !== activeDraftId) {
      if (activeConversationId) {
        persistConversationDraft(activeConversationId, composerSnapshot);
      }
      return;
    }
    draftConfigurationsRef.current.set(activeDraftId, {
      access,
      modelId,
      providerInstanceId,
      reasoning,
      serviceTier,
    });
    if (
      draft.access === access &&
      draft.cwd === cwd &&
      draft.snapshot.contentKey === composerSnapshot.contentKey
    ) return;
    const next = {
      ...draft,
      access,
      cwd,
      snapshot: composerSnapshot,
      updatedAt: Date.now(),
    };
    draftRef.current = next;
    setDraft(next);
    persistNewChatDraft(next);
  }, [
    access,
    activeConversationId,
    activeDraftId,
    composerSnapshot,
    cwd,
    draft,
    modelId,
    providerInstanceId,
    reasoning,
    serviceTier,
  ]);

  useEffect(() => {
    if (!activeConversationId || !conversationSummary) return;
    setCwd(conversationSummary.cwd);
    if (nativeRuntime?.conversationId === activeConversationId) {
      setProviderInstanceId(nativeRuntime.providerInstanceId);
      setModelId(viewerModelId(
        nativeRuntime.providerInstanceId,
        nativeRuntime.composer.nextTurn.model,
      ));
      setReasoning(nativeRuntime.composer.nextTurn.effort ?? null);
      setServiceTier(nativeRuntime.composer.nextTurn.serviceTier);
      setAccess(nativeRuntime.composer.nextTurn.access);
      return;
    }
    if (conversationSummary.providerInstanceId) {
      setProviderInstanceId(conversationSummary.providerInstanceId);
    }
    setModelId(conversationSummary.modelId);
    setReasoning(conversationSummary.reasoning);
    setServiceTier(conversationSummary.serviceTier);
    if (conversationSummary.access) setAccess(conversationSummary.access);
  }, [
    activeConversationId,
    conversationSummary,
    nativeRuntime,
    setAccess,
    setCwd,
    setModelId,
    setProviderInstanceId,
    setReasoning,
    setServiceTier,
  ]);

  const saveCurrentTargetDraft = useCallback(() => {
    const snapshot = useComposerStore.getState().snapshot;
    const currentDraftId = activeDraftIdRef.current;
    if (currentDraftId) {
      const current = draftRef.current ?? initialDraft(currentDraftId);
      const next: AgentNewChatDraft = {
        ...current,
        access: useComposerStore.getState().access,
        cwd: useConversationStore.getState().cwd,
        snapshot,
        updatedAt: Date.now(),
      };
      const composer = useComposerStore.getState();
      draftConfigurationsRef.current.set(currentDraftId, {
        access: composer.access,
        modelId: composer.modelId,
        providerInstanceId: composer.providerInstanceId,
        reasoning: composer.reasoning,
        serviceTier: composer.serviceTier,
      });
      draftRef.current = next;
      setDraft(next);
      persistNewChatDraft(next);
      return;
    }
    const currentConversationId = activeConversationIdRef.current;
    if (currentConversationId) {
      persistConversationDraft(currentConversationId, snapshot);
    }
  }, []);

  const activateDraft = useCallback((nextDraft: AgentNewChatDraft) => {
    blurComposer();
    clearComposerMode();
    activeConversationIdRef.current = null;
    activeDraftIdRef.current = nextDraft.id;
    draftRef.current = nextDraft;
    setActiveConversationId(null);
    setActiveDraftId(nextDraft.id);
    setDraft(nextDraft);
    setCwd(nextDraft.cwd);
    const configuration = draftConfigurationsRef.current.get(nextDraft.id)
      ?? (providers && composerModels
        ? (() => {
            const fallback = defaultDraftConfiguration(providers, composerModels);
            return fallback ? { ...fallback, access: nextDraft.access } : null;
          })()
        : null);
    if (configuration) {
      draftConfigurationsRef.current.set(nextDraft.id, configuration);
      setProviderInstanceId(configuration.providerInstanceId);
      setModelId(configuration.modelId);
      setReasoning(configuration.reasoning);
      setServiceTier(configuration.serviceTier);
      setAccess(configuration.access);
    }
    restoreComposerSnapshot(nextDraft.snapshot);
    setError(null);
    void getTranscriptResourceState().setActiveConversationId(null);
  }, [
    blurComposer,
    clearComposerMode,
    composerModels,
    providers,
    restoreComposerSnapshot,
    setAccess,
    setCwd,
    setModelId,
    setProviderInstanceId,
    setReasoning,
    setServiceTier,
  ]);

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
      access: useComposerStore.getState().access,
      cwd: selected?.cwd ?? useConversationStore.getState().cwd,
      id,
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
      blurComposer();
      clearComposerMode();
      activeConversationIdRef.current = normalized;
      activeDraftIdRef.current = null;
      setActiveConversationId(normalized);
      setActiveDraftId(null);
      const currentDraft = loadConversationDraft(normalized);
      restoreComposerSnapshot(currentDraft.snapshot);
      setError(null);
      void getTranscriptResourceState().setActiveConversationId(normalized);
      void ensureConversation(normalized);
    }
    if (focusTurnId) requestTranscriptTurnScroll(normalized, focusTurnId);
  }, [
    blurComposer,
    clearComposerMode,
    ensureConversation,
    restoreComposerSnapshot,
    saveCurrentTargetDraft,
  ]);

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

  const retryHistorySync = useCallback(async () => {
    const conversationId = activeConversationIdRef.current;
    if (!conversationId) return;
    setError(null);
    try {
      await retryActiveTranscriptHistorySync();
      await refresh([
        `agent/conversation:${conversationId}`,
        `agent/runtime:${conversationId}`,
      ]);
    } catch (reason) {
      setError(messageOf(reason));
    }
  }, [refresh, setError]);

  const updateComposerPreference = useCallback(async (input: {
    providerInstanceId: string;
    modelId: string;
    reasoning: ReasoningEffort;
    serviceTier: string | null;
  }) => {
    const selected = resolveModel(composerModels, input.modelId);
    if (!selected?.nativeId || selected.providerInstanceId !== input.providerInstanceId) {
      setError('The selected native provider model is unavailable.');
      return;
    }
    setError(null);
    try {
      if (activeConversationId) {
        if (!nativeRuntime || nativeRuntime.conversationId !== activeConversationId) {
          throw new Error('Conversation configuration is still loading.');
        }
        await agentCommands.setConversationPreference({
          conversationId: activeConversationId,
          expectedRevision: nativeRuntime.composer.revision,
          nativeModelId: selected.nativeId,
          reasoning: input.reasoning,
          serviceTier: input.serviceTier,
        });
        await refresh([
          'agent/providers',
          `agent/runtime:${activeConversationId}`,
        ]);
        return;
      }
      setProviderInstanceId(input.providerInstanceId);
      setModelId(input.modelId);
      setReasoning(input.reasoning);
      setServiceTier(input.serviceTier);
      if (activeDraftId) {
        draftConfigurationsRef.current.set(activeDraftId, {
          access,
          modelId: input.modelId,
          providerInstanceId: input.providerInstanceId,
          reasoning: input.reasoning,
          serviceTier: input.serviceTier,
        });
      }
      if (!providers) throw new Error('Provider catalog is still loading.');
      await agentCommands.setProviderPreference({
        providerInstanceId: input.providerInstanceId,
        expectedProvidersRevision: providers.preferenceRevision,
        nativeModelId: selected.nativeId,
        reasoning: input.reasoning,
        serviceTier: input.serviceTier,
      });
      await refresh([
        'agent/providers',
        `agent/models:${input.providerInstanceId}`,
      ]);
    } catch (reason) {
      setError(messageOf(reason));
      await refresh(activeConversationId
        ? ['agent/providers', `agent/runtime:${activeConversationId}`]
        : ['agent/providers']);
    }
  }, [
    access,
    activeConversationId,
    activeDraftId,
    composerModels,
    nativeRuntime,
    providers,
    refresh,
    setError,
    setModelId,
    setProviderInstanceId,
    setReasoning,
    setServiceTier,
  ]);

  const updateComposerAccess = useCallback(async (nextAccess: ProviderAccess) => {
    if (activeConversationId) {
      if (!nativeRuntime || nativeRuntime.conversationId !== activeConversationId) {
        setError('Conversation configuration is still loading.');
        return;
      }
      setError(null);
      try {
        await agentCommands.setConversationAccess({
          conversationId: activeConversationId,
          expectedRevision: nativeRuntime.composer.revision,
          access: nextAccess,
        });
        setAccess(nextAccess);
        await refresh([`agent/runtime:${activeConversationId}`]);
      } catch (reason) {
        setError(messageOf(reason));
      }
      return;
    }
    setAccess(nextAccess);
    if (!activeDraftId) return;
    const composer = useComposerStore.getState();
    draftConfigurationsRef.current.set(activeDraftId, {
      access: nextAccess,
      modelId: composer.modelId,
      providerInstanceId: composer.providerInstanceId,
      reasoning: composer.reasoning,
      serviceTier: composer.serviceTier,
    });
  }, [activeConversationId, activeDraftId, nativeRuntime, refresh, setAccess, setError]);

  const { branchMessage, compact, interrupt, send } = useConversationActions({
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
  });

  if (!auth) {
    if (error) {
      return (
        <main className="agent-app agent-center">
          <section className="agent-auth-card" aria-live="polite">
            <div className="agent-auth-kicker">Remux Agent</div>
            <h1>Agent runtime unavailable</h1>
            <p className="agent-error" role="alert">{error}</p>
            <p>Your conversation is safe. Retry will reconnect and reload its current resources.</p>
            <div className="agent-auth-actions">
              <button
                type="button"
                onClick={() => {
                  setError(null);
                  void refresh();
                }}
              >
                Retry
              </button>
            </div>
          </section>
        </main>
      );
    }
    return (
      <main className="agent-app agent-center" aria-live="polite">
        <p>{connectionStatus.type === 'connected'
          ? 'Connecting to agent runtime…'
          : 'Reconnecting to Remux…'}</p>
      </main>
    );
  }

  if (auth.state !== 'signed-in') {
    return (
      <AgentAuthScreen
        auth={auth}
        busy={authBusy}
        error={error}
        loginMode={authProvider?.capabilities?.authentication.login ?? 'none'}
        providerInstanceId={authProvider?.providerInstanceId ?? null}
        run={(action) => void runAuth(action)}
      />
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
          <div className="agent-chat-view">
            {conversation ? <div className={agentsOpen ? 'agent-chat-transcript is-hidden' : 'agent-chat-transcript'}>
              <AgentTranscript conversationId={conversation.id} />
            </div> : null}
            {conversation && agentsOpen ? (
              <AgentExecutionsView
                conversationId={conversation.id}
                {...agentExecutions}
                onClose={() => {
                  setAgentsOpen(false);
                  setSelectedAgentExecutionId(null);
                }}
                onRefresh={agentExecutions.refresh}
                onSelect={setSelectedAgentExecutionId}
                providers={providers}
                selectedExecutionId={selectedAgentExecutionId}
              />
            ) : !conversation ? (
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
            ) : null}
          </div>
        </div>
        <div className={agentsOpen ? 'remux-bottom-bar-slot is-hidden' : 'remux-bottom-bar-slot'} ref={bottomBarSlotRef}>
          <ComposerContent
            connected={connectionStatus.type === 'connected'}
            childExecutionCount={agentExecutions.executions.length}
            conversation={conversation}
            conversationSelected={Boolean(activeConversationId)}
            onInterrupt={interrupt}
            onOpenAgents={() => {
              blurComposer();
              setAgentsOpen(true);
            }}
            onCompact={compact}
            onEdit={(target, input, setPhase) => branchMessage('edit', target, input, setPhase)}
            onFork={(target, input, setPhase) => branchMessage('fork', target, input, setPhase)}
            onQueueChanged={() => activeConversationId
              ? refresh([`agent/queue:${activeConversationId}`])
              : Promise.resolve()}
            onRetryHistory={retryHistorySync}
            onSend={send}
            onProviderLogin={(providerInstanceId, mode) => {
              void runAuth(() => agentCommands.login(providerInstanceId, mode));
            }}
            onProviderLogout={(providerInstanceId) => {
              void runAuth(() => agentCommands.logout(providerInstanceId));
            }}
            onPreferenceChange={updateComposerPreference}
            onAccessChange={updateComposerAccess}
            providers={providers}
            runtime={nativeRuntime}
            runtimeError={error ?? conversation?.error ?? nativeRuntime?.lifecycle.stopError ?? null}
            queue={queue}
          />
        </div>
        {!agentsOpen && pickerOverlayVisible ? (
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
    access: 'workspace-write',
    cwd: '',
    id,
    snapshot: createEmptyComposerSnapshot(),
    updatedAt: Date.now(),
  };
}

type DraftComposerConfiguration = {
  access: ProviderAccess;
  modelId: string;
  providerInstanceId: string;
  reasoning: ReasoningEffort;
  serviceTier: string | null;
};

function defaultDraftConfiguration(
  providers: AgentProvidersResource,
  models: ModelsValue,
): DraftComposerConfiguration | null {
  const providerInstanceId = providers.defaultProviderInstanceId
    ?? providers.providers.find(({ state }) => state === 'ready')?.providerInstanceId;
  if (!providerInstanceId) return null;
  const provider = providers.providers.find((entry) => entry.providerInstanceId === providerInstanceId);
  const providerModels = models.models.filter((model) => model.providerInstanceId === providerInstanceId);
  const sticky = provider?.stickyPreference
    ? providerModels.find(({ nativeId }) => nativeId === provider.stickyPreference?.model)
    : undefined;
  const selected = sticky
    ?? providerModels.find(({ id }) => id === models.defaultModelId)
    ?? providerModels[0];
  if (!selected) return null;
  const stickyReasoning = provider?.stickyPreference?.effort ?? null;
  return {
    access: 'workspace-write',
    modelId: selected.id,
    providerInstanceId,
    reasoning: stickyReasoning !== null && selected.supportedReasoning.includes(stickyReasoning)
      ? stickyReasoning
      : preferredReasoning(selected),
    serviceTier: preferredServiceTier(selected, provider?.stickyPreference?.serviceTier),
  };
}

function projectConversation(summary: ConversationSummary, runtime: AgentRuntimeValue | null): ConversationValue {
  const loaded = runtime?.conversationId === summary.id;
  const liveStatus = loaded && runtime.state !== 'unloaded' ? runtime.state : null;
  return {
    ...summary,
    status: liveStatus ?? summary.status,
    activeTurnId: loaded ? runtime.activeTurnId : null,
    activeTurnElapsedMs: loaded ? runtime.activeTurnElapsedMs : null,
    error: loaded ? runtime.error : null,
    capabilities: loaded ? runtime.capabilities : null,
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
