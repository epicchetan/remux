import { getHostStatusSnapshot, subscribeHostStatus } from '@remux/viewer-kit';
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

import {
  NATIVE_AGENT_RESOURCE_KEYS,
  type AgentModelsResource,
  type AgentProvidersResource,
  type AgentQueueResource,
  type AgentRuntimeResource,
  type NativeAgentResourceKey,
} from '../../../shared/native-agent-protocol.ts';
import type {
  AgentPendingQueueValue,
  AgentRuntimeValue,
  AuthValue,
} from '../../../shared/protocol.ts';
import { useComposerStore } from '../composer/store.ts';
import { useConversationHistoryStore } from '../conversation/historyStore.ts';
import { setConversationRuntime } from '../conversation/runtimeStore.ts';
import { useConversationStore } from '../conversation/store.ts';
import { useHostStore } from '../ipc/hostStore.ts';
import { subscribeAgentResourceInvalidations } from '../ipc/resourceInvalidations.ts';
import { AgentResourceReader } from '../ipc/resources.ts';
import {
  projectNativeAuth,
  projectNativeModels,
  projectNativeQueue,
  projectNativeRuntime,
} from '../nativeViewModel.ts';
import { useAgentResumeSync } from '../resumeSync.ts';
import { observeTranscriptServerGeneration } from '../transcript/resourceStore.ts';
import { ResourceRefreshQueue } from './resourceRefreshQueue.ts';

const RESOURCE_READ_TIMEOUT_MS = 15_000;

export function useAgentResources(
  activeConversationId: string | null,
  activeConversationIdRef: RefObject<string | null>,
) {
  const [auth, setAuth] = useState<AuthValue | null>(null);
  const [providers, setProviders] = useState<AgentProvidersResource | null>(null);
  const [nativeRuntime, setNativeRuntime] = useState<AgentRuntimeResource | null>(null);
  const [runtime, setRuntime] = useState<AgentRuntimeValue | null>(null);
  const [queue, setQueue] = useState<AgentPendingQueueValue | null>(null);
  const [error, setError] = useState<string | null>(null);
  const setModels = useComposerStore((state) => state.setModels);
  const ensureConversation = useConversationHistoryStore((state) => state.ensureConversation);
  const invalidateHistory = useConversationHistoryStore((state) => state.invalidate);
  const loadHistory = useConversationHistoryStore((state) => state.load);
  const connectionStatus = useHostStore((state) => state.connectionStatus);
  const initializeHost = useHostStore((state) => state.initialize);
  const initializeCwd = useConversationStore((state) => state.initializeCwd);
  const resourceReader = useRef(new AgentResourceReader());
  const providersRef = useRef<AgentProvidersResource | null>(null);
  const modelsByProvider = useRef(new Map<string, AgentModelsResource>());
  const runtimeByConversation = useRef(new Map<string, AgentRuntimeResource>());
  const queueByConversation = useRef(new Map<string, AgentQueueResource>());
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryAttempt = useRef(0);
  const activeReadController = useRef<AbortController | null>(null);
  const pendingRefreshKeys = useRef(new Set<NativeAgentResourceKey>());
  const performRefreshRef = useRef<(keys?: NativeAgentResourceKey[]) => Promise<void>>(
    async () => undefined,
  );
  const refreshQueue = useRef(
    new ResourceRefreshQueue<NativeAgentResourceKey>((keys) => performRefreshRef.current(keys)),
  );

  const applyUpdate = useCallback((update: Awaited<ReturnType<AgentResourceReader['read']>>) => {
    const currentConversationId = activeConversationIdRef.current;
    observeTranscriptServerGeneration(update.serverGeneration);
    if (update.generationChanged) {
      setRuntime(null);
      setNativeRuntime(null);
      setQueue(null);
      modelsByProvider.current.clear();
      runtimeByConversation.current.clear();
      queueByConversation.current.clear();
    }
    let nextProviders = providersRef.current;
    for (const key of update.missing) {
      if (key === NATIVE_AGENT_RESOURCE_KEYS.providers) nextProviders = null;
      if (key.startsWith('agent/models:')) modelsByProvider.current.delete(key.slice('agent/models:'.length));
      if (key.startsWith('agent/runtime:')) {
        const conversationId = key.slice('agent/runtime:'.length);
        runtimeByConversation.current.delete(conversationId);
        if (conversationId === currentConversationId) {
          setNativeRuntime(null);
          setRuntime(null);
        }
      }
      if (key.startsWith('agent/queue:')) {
        const conversationId = key.slice('agent/queue:'.length);
        queueByConversation.current.delete(conversationId);
        if (conversationId === currentConversationId) setQueue(null);
      }
    }
    for (const [key, value] of update.values) {
      if (key === NATIVE_AGENT_RESOURCE_KEYS.providers && 'providers' in value) {
        nextProviders = value as AgentProvidersResource;
      } else if (key.startsWith('agent/models:') && 'models' in value) {
        modelsByProvider.current.set(key.slice('agent/models:'.length), value as AgentModelsResource);
      } else if (key.startsWith('agent/runtime:')) {
        const conversationId = key.slice('agent/runtime:'.length);
        const nextRuntime = value as AgentRuntimeResource;
        if (nextRuntime.conversationId !== conversationId) continue;
        runtimeByConversation.current.set(conversationId, nextRuntime);
        if (conversationId === currentConversationId) {
          setNativeRuntime(nextRuntime);
          setRuntime(projectNativeRuntime(nextRuntime));
        }
      } else if (key.startsWith('agent/queue:')) {
        const conversationId = key.slice('agent/queue:'.length);
        const nextQueue = value as AgentQueueResource;
        if (nextQueue.conversationId !== conversationId) continue;
        queueByConversation.current.set(conversationId, nextQueue);
        if (conversationId === currentConversationId) setQueue(projectNativeQueue(nextQueue));
      }
    }
    if (nextProviders !== providersRef.current) {
      providersRef.current = nextProviders;
      setProviders(nextProviders);
    }
    if (nextProviders) setAuth(projectNativeAuth(nextProviders));
    setModels(projectNativeModels([...modelsByProvider.current.values()]));
  }, [activeConversationIdRef, setModels]);

  const performRefresh = useCallback(async (keys?: NativeAgentResourceKey[]) => {
    const controller = new AbortController();
    activeReadController.current = controller;
    const timeout = setTimeout(() => {
      controller.abort('agent-resource-timeout');
    }, RESOURCE_READ_TIMEOUT_MS);
    try {
      const currentConversationId = activeConversationIdRef.current;
      const requestedKeys = keys ?? baseResourceKeys(providersRef.current, currentConversationId);
      const update = await resourceReader.current.read(requestedKeys, {
        ...(currentConversationId ? { focusedConversationId: currentConversationId } : {}),
        signal: controller.signal,
        visibility: 'foreground',
      });
      applyUpdate(update);
      const catalog = update.values.get(NATIVE_AGENT_RESOURCE_KEYS.providers) as
        | AgentProvidersResource
        | undefined;
      const missingModelKeys = (catalog ?? providersRef.current)?.providers.flatMap(({ providerInstanceId }) => {
        const key = `agent/models:${providerInstanceId}` as const;
        return requestedKeys.includes(key) || modelsByProvider.current.has(providerInstanceId) ? [] : [key];
      }) ?? [];
      if (missingModelKeys.length > 0) {
        applyUpdate(await resourceReader.current.read(missingModelKeys, {
          signal: controller.signal,
          visibility: 'foreground',
        }));
      }
      retryAttempt.current = 0;
      if (retryTimer.current) {
        clearTimeout(retryTimer.current);
        retryTimer.current = null;
      }
      setError(null);
    } catch (refreshError) {
      if (controller.signal.aborted && controller.signal.reason !== 'agent-resource-timeout') {
        return;
      }
      setError(controller.signal.reason === 'agent-resource-timeout'
        ? 'Agent runtime did not respond. Retry the connection.'
        : messageOf(refreshError));
      if (getHostStatusSnapshot().status.type === 'connected' && !retryTimer.current) {
        const delay = Math.min(1_000 * (2 ** retryAttempt.current), 10_000);
        retryAttempt.current += 1;
        retryTimer.current = setTimeout(() => {
          retryTimer.current = null;
          void refreshQueue.current.enqueue();
        }, delay);
      }
    } finally {
      clearTimeout(timeout);
      if (activeReadController.current === controller) activeReadController.current = null;
    }
  }, [activeConversationIdRef, applyUpdate]);
  performRefreshRef.current = performRefresh;

  const refresh = useCallback((keys?: NativeAgentResourceKey[]) => (
    refreshQueue.current.enqueue(keys)
  ), []);

  useEffect(() => setConversationRuntime(runtime), [runtime]);

  const scheduleRefresh = useCallback((keys: NativeAgentResourceKey[]) => {
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
    void loadHistory().then(() => {
      const conversationId = activeConversationIdRef.current;
      return conversationId ? ensureConversation(conversationId) : null;
    });
    const unsubscribeEvents = subscribeAgentResourceInvalidations((keys) => {
      void invalidateHistory(keys);
      const conversationId = activeConversationIdRef.current ?? '';
      const relevant = keys.filter((key) =>
        key === NATIVE_AGENT_RESOURCE_KEYS.providers ||
        key.startsWith('agent/models:') ||
        key === `agent/runtime:${conversationId}` ||
        key === `agent/queue:${conversationId}`);
      if (relevant.length > 0) scheduleRefresh(relevant);
    });
    const unsubscribeStatus = subscribeHostStatus((status) => {
      if (status.status.type === 'connected' && status.status.cwd) initializeCwd(status.status.cwd);
    });
    return () => {
      unsubscribeEvents();
      unsubscribeStatus();
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      if (retryTimer.current) clearTimeout(retryTimer.current);
      activeReadController.current?.abort('agent-view-unmounted');
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
    if (connectionStatus.type === 'connected') {
      void refresh();
    }
  }, [connectionStatus, initializeCwd, refresh]);

  useAgentResumeSync(useCallback(async (reason) => {
    const conversationId = activeConversationIdRef.current;
    if (reason === 'tab-active') {
      if (!conversationId) return;
      await refresh([
        `agent/runtime:${conversationId}`,
        `agent/queue:${conversationId}`,
      ]);
      return;
    }

    await Promise.all([
      refresh(),
      loadHistory({ preserveReady: true }),
      ...(conversationId
        ? [ensureConversation(conversationId, true)]
        : []),
    ]);
  }, [activeConversationIdRef, ensureConversation, loadHistory, refresh]));

  useEffect(() => {
    const cachedRuntime = activeConversationId
      ? runtimeByConversation.current.get(activeConversationId) ?? null
      : null;
    const cachedQueue = activeConversationId
      ? queueByConversation.current.get(activeConversationId) ?? null
      : null;
    setNativeRuntime(cachedRuntime);
    setRuntime(projectNativeRuntime(cachedRuntime));
    setQueue(projectNativeQueue(cachedQueue));
    if (activeConversationId) {
      void refresh([
        `agent/runtime:${activeConversationId}`,
        `agent/queue:${activeConversationId}`,
      ]);
    }
  }, [activeConversationId, refresh]);

  return {
    auth,
    connectionStatus,
    error,
    providers,
    nativeRuntime,
    queue,
    refresh,
    runtime,
    setError,
  };
}

function baseResourceKeys(
  providers: AgentProvidersResource | null,
  activeConversationId: string | null,
): NativeAgentResourceKey[] {
  return [
    NATIVE_AGENT_RESOURCE_KEYS.providers,
    ...(providers?.providers.map(({ providerInstanceId }) =>
      `agent/models:${providerInstanceId}` as const) ?? []),
    ...(activeConversationId
      ? [
          `agent/runtime:${activeConversationId}` as const,
          `agent/queue:${activeConversationId}` as const,
        ]
      : []),
  ];
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
