import { subscribeHostStatus } from '@remux/viewer-kit';
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

import {
  AGENT_RESOURCE_KEYS,
  contextResourceKey,
  queueResourceKey,
  type AgentPendingQueueValue,
  type AgentResourceKey,
  type AgentRuntimeValue,
  type AuthValue,
  type ContextInspectorValue,
  type ModelsValue,
} from '../../../shared/protocol.ts';
import { useComposerStore } from '../composer/store.ts';
import { useConversationHistoryStore } from '../conversation/historyStore.ts';
import { setConversationRuntime } from '../conversation/runtimeStore.ts';
import { useConversationStore } from '../conversation/store.ts';
import { useHostStore } from '../ipc/hostStore.ts';
import { subscribeAgentResourceInvalidations } from '../ipc/resourceInvalidations.ts';
import { AgentResourceReader } from '../ipc/resources.ts';
import { useAgentResumeSync } from '../resumeSync.ts';
import { observeTranscriptServerGeneration } from '../transcript/resourceStore.ts';

export function useAgentResources(
  activeConversationId: string | null,
  activeConversationIdRef: RefObject<string | null>,
) {
  const [auth, setAuth] = useState<AuthValue | null>(null);
  const [runtime, setRuntime] = useState<AgentRuntimeValue | null>(null);
  const [contextInspector, setContextInspector] = useState<ContextInspectorValue | null>(null);
  const [queue, setQueue] = useState<AgentPendingQueueValue | null>(null);
  const [error, setError] = useState<string | null>(null);
  const setModels = useComposerStore((state) => state.setModels);
  const ensureConversation = useConversationHistoryStore((state) => state.ensureConversation);
  const invalidateHistory = useConversationHistoryStore((state) => state.invalidate);
  const loadHistory = useConversationHistoryStore((state) => state.load);
  const resetHistoryReader = useConversationHistoryStore((state) => state.resetReader);
  const connectionStatus = useHostStore((state) => state.connectionStatus);
  const initializeHost = useHostStore((state) => state.initialize);
  const initializeCwd = useConversationStore((state) => state.initializeCwd);
  const resourceReader = useRef(new AgentResourceReader());
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRefreshKeys = useRef(new Set<AgentResourceKey>());

  const refresh = useCallback(async (keys?: AgentResourceKey[]) => {
    const requestedKeys = keys ?? baseResourceKeys();
    try {
      const update = await resourceReader.current.read(requestedKeys);
      observeTranscriptServerGeneration(update.serverGeneration);
      if (update.generationChanged) {
        setRuntime(null);
        setContextInspector(null);
        setQueue(null);
      }
      for (const key of update.missing) {
        if (key === AGENT_RESOURCE_KEYS.runtime) setRuntime(null);
        if (key.startsWith('context:')) setContextInspector(null);
        if (key.startsWith('queue:')) setQueue(null);
      }
      for (const [key, value] of update.values) {
        if (key === AGENT_RESOURCE_KEYS.auth) setAuth(value as AuthValue);
        if (key === AGENT_RESOURCE_KEYS.models) setModels(value as ModelsValue);
        if (key === AGENT_RESOURCE_KEYS.runtime) setRuntime(value as AgentRuntimeValue);
        if (key.startsWith('context:')) setContextInspector(value as ContextInspectorValue);
        if (key.startsWith('queue:')) setQueue(value as AgentPendingQueueValue);
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
      const conversationId = activeConversationIdRef.current;
      return conversationId ? ensureConversation(conversationId) : null;
    });
    const unsubscribeEvents = subscribeAgentResourceInvalidations((invalidations) => {
      const resources = invalidations.filter((invalidation) => invalidation.type === 'resource');
      void invalidateHistory(resources);
      const conversationId = activeConversationIdRef.current ?? '';
      const keys = resources
        .map((invalidation) => invalidation.key as AgentResourceKey)
        .filter((key) => key === AGENT_RESOURCE_KEYS.auth ||
          key === AGENT_RESOURCE_KEYS.models || key === AGENT_RESOURCE_KEYS.runtime ||
          key === contextResourceKey(conversationId) || key === queueResourceKey(conversationId));
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
  }, [
    activeConversationIdRef,
    ensureConversation,
    initializeCwd,
    initializeHost,
    invalidateHistory,
    loadHistory,
    refresh,
    scheduleRefresh,
  ]);

  useEffect(() => {
    if (connectionStatus.type === 'connected' && connectionStatus.cwd) {
      initializeCwd(connectionStatus.cwd);
    }
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
  }, [activeConversationIdRef, ensureConversation, loadHistory, refresh, resetHistoryReader]));

  useEffect(() => {
    setContextInspector(null);
    setQueue(null);
    if (activeConversationId) {
      void refresh([
        contextResourceKey(activeConversationId),
        queueResourceKey(activeConversationId),
      ]);
    }
  }, [activeConversationId, refresh]);

  return {
    auth,
    connectionStatus,
    contextInspector,
    error,
    queue,
    refresh,
    runtime,
    setError,
  };
}

function baseResourceKeys(): AgentResourceKey[] {
  return [
    AGENT_RESOURCE_KEYS.auth,
    AGENT_RESOURCE_KEYS.models,
    AGENT_RESOURCE_KEYS.runtime,
  ];
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
