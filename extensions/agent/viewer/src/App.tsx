import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import {
  openHostLink,
  parseRemuxViewerRoute,
  rpc,
  subscribeHostStatus,
  updateHostTab,
} from '@remux/viewer-kit';

import {
  AGENT_METHODS,
  AGENT_RESOURCE_KEYS,
  conversationResourceKey,
  type AgentResourceKey,
  type AuthValue,
  type ConversationValue,
  type ModelsValue,
} from '../../shared/protocol.ts';
import { ComposerContent } from './composer/content.tsx';
import { useComposerStore } from './composer/store.ts';
import { AgentDirectoryPicker } from './conversation/DirectoryPicker.tsx';
import { shortenPath } from './conversation/format.ts';
import { useConversationStore } from './conversation/store.ts';
import { createViewerUuid } from './identity.ts';
import { setConversationRuntime } from './conversation/runtimeStore.ts';
import { useHostStore } from './ipc/hostStore.ts';
import { subscribeAgentResourceInvalidations } from './ipc/resourceInvalidations.ts';
import { AgentResourceReader } from './ipc/resources.ts';
import type { RemuxHostViewportMetrics } from './ipc/types.ts';
import { useAgentResumeSync } from './resumeSync.ts';
import { AgentTranscript } from './transcript/index.ts';
import {
  getTranscriptResourceState,
  refreshActiveTranscriptResources,
} from './transcript/resourceStore.ts';
import { trackTranscriptUserMessage } from './transcript/viewportStore.ts';

export function App() {
  const [auth, setAuth] = useState<AuthValue | null>(null);
  const [conversation, setConversation] = useState<ConversationValue | null>(null);
  const [conversationUnavailable, setConversationUnavailable] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connectionStatus = useHostStore((state) => state.connectionStatus);
  const hostViewportMetrics = useHostStore((state) => state.hostViewportMetrics);
  const getHostViewportMetrics = useHostStore((state) => state.getHostViewportMetrics);
  const initializeHost = useHostStore((state) => state.initialize);
  const cwd = useConversationStore((state) => state.cwd);
  const directoryPickerOpen = useConversationStore((state) => state.directoryPickerOpen);
  const initializeCwd = useConversationStore((state) => state.initializeCwd);
  const modelId = useComposerStore((state) => state.modelId);
  const reasoning = useComposerStore((state) => state.reasoning);
  const setModelId = useComposerStore((state) => state.setModelId);
  const setModels = useComposerStore((state) => state.setModels);
  const setReasoning = useComposerStore((state) => state.setReasoning);
  const clearComposer = useComposerStore((state) => state.clearComposer);
  const resourceReader = useRef(new AgentResourceReader());
  const conversationId = useRef(initialConversationId());
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRefreshKeys = useRef(new Set<AgentResourceKey>());
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
    const requestedKeys = keys ?? resourceKeys(conversationId.current);
    try {
      const update = await resourceReader.current.read(requestedKeys);
      if (update.generationChanged) {
        setConversation(null);
        setConversationUnavailable(Boolean(conversationId.current));
        setConversationRuntime(null);
      }
      for (const key of update.missing) {
        if (key.startsWith('conversation:')) {
          setConversation(null);
          setConversationRuntime(null);
          setConversationUnavailable(true);
        }
      }
      for (const [key, value] of update.values) {
        if (key === AGENT_RESOURCE_KEYS.auth) setAuth(value as AuthValue);
        if (key === AGENT_RESOURCE_KEYS.models) setModels(value as ModelsValue);
        if (key.startsWith('conversation:')) {
          const next = value as ConversationValue;
          setConversation(next);
          setConversationRuntime(next);
          setConversationUnavailable(false);
        }
      }
      setError(null);
    } catch (refreshError) {
      setError(messageOf(refreshError));
    }
  }, [setModels]);

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
    const unsubscribeEvents = subscribeAgentResourceInvalidations((invalidations) => {
      const keys = invalidations.map((invalidation) => invalidation.key as AgentResourceKey);
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
  }, [initializeCwd, initializeHost, refresh, scheduleRefresh]);

  useEffect(() => {
    if (connectionStatus.type === 'connected' && connectionStatus.cwd) initializeCwd(connectionStatus.cwd);
  }, [connectionStatus, initializeCwd]);

  useAgentResumeSync(useCallback(async () => {
    resourceReader.current.clear();
    await refresh();
  }, [refresh]));

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
    const result = await rpc.command<{ conversationId: string }>(AGENT_METHODS.conversationStart, { cwd, modelId, reasoning });
    conversationId.current = result.conversationId;
    setConversationUnavailable(false);
    await getTranscriptResourceState().setActiveConversationId(result.conversationId);
    replaceAgentLocation(result.conversationId);
    await updateHostTab({
      resourceId: result.conversationId,
      resourceKind: 'agentConversation',
      status: 'active',
      title: 'Agent',
    });
    return result.conversationId;
  }, [cwd, modelId, reasoning]);

  const send = useCallback(async (
    text: string,
    setPhase: (phase: 'sending' | 'updating-transcript') => void,
  ) => {
    setError(null);
    const activeId = conversation?.id ?? await createConversation();
    setPhase('sending');
    const clientMessageId = createViewerUuid();
    trackTranscriptUserMessage(activeId, clientMessageId);
    const sent = await rpc.command<{ turnId: string }>(AGENT_METHODS.messageSend, {
      conversationId: activeId,
      clientMessageId,
      text,
    });
    trackTranscriptUserMessage(activeId, clientMessageId, sent.turnId);
    setPhase('updating-transcript');
    await Promise.all([
      refresh(resourceKeys(activeId)),
      refreshActiveTranscriptResources({ forceFullMeasure: false, preserveReady: true, windowPolicy: 'tail' }),
    ]);
  }, [conversation?.id, createConversation, refresh]);

  const interrupt = useCallback(async () => {
    if (!conversation?.activeTurnId) return;
    setError(null);
    try {
      await rpc.command(AGENT_METHODS.turnInterrupt, {
        conversationId: conversation.id,
        turnId: conversation.activeTurnId,
      });
      await refresh([conversationResourceKey(conversation.id)]);
    } catch (reason) {
      setError(messageOf(reason));
      throw reason;
    }
  }, [conversation?.activeTurnId, conversation?.id, refresh]);

  const newChat = useCallback(() => {
    if (conversation) {
      setModelId(conversation.modelId);
      setReasoning(conversation.reasoning);
    }
    conversationId.current = null;
    setConversation(null);
    setConversationRuntime(null);
    setConversationUnavailable(false);
    setError(null);
    clearComposer();
    void getTranscriptResourceState().setActiveConversationId(null);
    replaceAgentDraftLocation();
  }, [clearComposer, conversation, setModelId, setReasoning]);

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
      <section className="remux-main-pane" ref={mainPaneRef} style={mainPaneStyle}>
        <div className="remux-transcript-slot">
          {conversation ? <AgentTranscript conversationId={conversation.id} /> : (
            <div className="remux-new-chat-empty">
              <div className="remux-new-chat-empty-card">
                <div className="remux-new-chat-empty-title">{conversationUnavailable ? 'Conversation unavailable' : 'New chat'}</div>
                <div className="remux-new-chat-empty-path">
                  {conversationUnavailable
                    ? 'The Agent runtime restarted; this ephemeral conversation cannot be reconstructed.'
                    : cwd ? shortenPath(cwd) : 'Pick a working directory to start'}
                </div>
              </div>
            </div>
          )}
        </div>
        <div className="remux-bottom-bar-slot" ref={bottomBarSlotRef}>
          <ComposerContent
            conversation={conversation}
            onInterrupt={interrupt}
            onNewChat={newChat}
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

function initialConversationId() {
  const route = parseRemuxViewerRoute(window.location.href);
  return route.resourceKind === 'agentConversation' ? route.resourceId : null;
}

function resourceKeys(id: string | null): AgentResourceKey[] {
  return [AGENT_RESOURCE_KEYS.auth, AGENT_RESOURCE_KEYS.models, ...(id ? [conversationResourceKey(id)] : [])];
}

function replaceAgentLocation(id: string) {
  const url = new URL(window.location.href);
  url.searchParams.set('remuxResourceKind', 'agentConversation');
  url.searchParams.set('remuxResourceId', id);
  window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
}

function replaceAgentDraftLocation() {
  const url = new URL(window.location.href);
  url.searchParams.delete('remuxResourceKind');
  url.searchParams.delete('remuxResourceId');
  window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
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
