import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AppState } from 'react-native';

import { logRemuxDebug, setRemuxDebugSink, type RemuxDebugEntry } from './remuxDebug';
import {
  RemuxConnectionClosedError,
  RemuxRpcClient,
  type JsonRpcId,
  type RemuxRpcMessage,
} from './remuxRpcClient';
import {
  remuxOriginFromSettings,
  useRemuxSettingsStore,
  websocketUrl,
} from './remuxSettingsStore';

const reconnectDelaysMs = [400, 900, 1800, 3500, 5000];
const requestReconnectWaitMs = 8000;
const maxRequestReconnectRetries = 1;
const maxPendingLogEntries = 200;

type ConnectedWaiter = {
  reject: (error: Error) => void;
  resolve: (client: RemuxRpcClient) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type RemuxConnectionStatus =
  | { type: 'connecting' }
  | { type: 'connected' }
  | { attempt: number; type: 'reconnecting' }
  | { type: 'disconnected' };

export type RemuxConnection = {
  error: string | null;
  request: <T>(method: string, params?: unknown, timeoutMs?: number) => Promise<T>;
  respond: (id: JsonRpcId, result: unknown) => void;
  respondError: (id: JsonRpcId, error: { code: number; data?: unknown; message: string }) => void;
  status: RemuxConnectionStatus;
  subscribe: (handler: (message: RemuxRpcMessage) => void) => () => void;
};

const RemuxConnectionContext = createContext<RemuxConnection | null>(null);

export function RemuxConnectionProvider({ children }: { children: ReactNode }) {
  const host = useRemuxSettingsStore((state) => state.host);
  const loadSettings = useRemuxSettingsStore((state) => state.loadSettings);
  const port = useRemuxSettingsStore((state) => state.port);
  const settingsLoaded = useRemuxSettingsStore((state) => state.loaded);
  const [status, setStatus] = useState<RemuxConnectionStatus>({ type: 'connecting' });
  const [error, setError] = useState<string | null>(null);
  const clientRef = useRef<RemuxRpcClient | null>(null);
  const connectedWaitersRef = useRef(new Set<ConnectedWaiter>());
  const generationRef = useRef(0);
  const openConnectionRef = useRef<(() => Promise<void>) | null>(null);
  const pendingLogEntriesRef = useRef<RemuxDebugEntry[]>([]);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shouldReconnectRef = useRef(false);
  const statusRef = useRef<RemuxConnectionStatus>({ type: 'connecting' });
  const subscribersRef = useRef(new Set<(message: RemuxRpcMessage) => void>());
  const origin = remuxOriginFromSettings({ host, port });
  const wsUrl = websocketUrl(origin, '/ws');

  const setConnectionStatus = useCallback((nextStatus: RemuxConnectionStatus) => {
    statusRef.current = nextStatus;
    setStatus(nextStatus);
    logRemuxDebug('connection:status', nextStatus);
  }, []);

  const queueLogEntry = useCallback((entry: RemuxDebugEntry) => {
    pendingLogEntriesRef.current.push(entry);
    if (pendingLogEntriesRef.current.length > maxPendingLogEntries) {
      pendingLogEntriesRef.current.splice(
        0,
        pendingLogEntriesRef.current.length - maxPendingLogEntries,
      );
    }
  }, []);

  const sendLogEntry = useCallback((client: RemuxRpcClient, entry: RemuxDebugEntry) => {
    return client.tryNotify('remux/app/log', entry);
  }, []);

  const flushPendingLogEntries = useCallback((client: RemuxRpcClient) => {
    const entries = pendingLogEntriesRef.current.splice(0);
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]!;
      if (!sendLogEntry(client, entry)) {
        for (const remainingEntry of entries.slice(index)) {
          queueLogEntry(remainingEntry);
        }
        break;
      }
    }
  }, [queueLogEntry, sendLogEntry]);

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const resolveConnectedWaiters = useCallback((client: RemuxRpcClient) => {
    for (const waiter of connectedWaitersRef.current) {
      clearTimeout(waiter.timer);
      waiter.resolve(client);
    }

    connectedWaitersRef.current.clear();
  }, []);

  const rejectConnectedWaiters = useCallback((message: string) => {
    for (const waiter of connectedWaitersRef.current) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(message));
    }

    connectedWaitersRef.current.clear();
  }, []);

  const scheduleReconnect = useCallback((generation: number, reason: string) => {
    if (!shouldReconnectRef.current || reconnectTimerRef.current !== null) {
      return;
    }

    const attempt = reconnectAttemptRef.current + 1;
    reconnectAttemptRef.current = attempt;
    setError(reason);
    setConnectionStatus({ attempt, type: 'reconnecting' });

    const delay = reconnectDelaysMs[Math.min(attempt - 1, reconnectDelaysMs.length - 1)]!;
    logRemuxDebug('connection:reconnect:scheduled', {
      attempt,
      delayMs: delay,
      reason,
    });
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      if (generationRef.current === generation && shouldReconnectRef.current) {
        void openConnectionRef.current?.();
      }
    }, delay);
  }, [setConnectionStatus]);

  const openConnection = useCallback(async () => {
    if (!settingsLoaded) {
      return;
    }

    clearReconnectTimer();
    const generation = generationRef.current;
    const reconnecting = reconnectAttemptRef.current > 0;
    logRemuxDebug('connection:open', {
      reconnecting,
      url: wsUrl,
    });
    setConnectionStatus(
      reconnecting
        ? { attempt: reconnectAttemptRef.current, type: 'reconnecting' }
        : { type: 'connecting' },
    );

    const client = new RemuxRpcClient({
      onMessage: (message) => {
        if (clientRef.current !== client) {
          return;
        }

        for (const handler of subscribersRef.current) {
          handler(message);
        }
      },
      onStatus: (nextStatus) => {
        if (clientRef.current !== client) {
          return;
        }

        logRemuxDebug('client:status', nextStatus);
        switch (nextStatus.type) {
          case 'connected':
            reconnectAttemptRef.current = 0;
            setError(null);
            setConnectionStatus({ type: 'connected' });
            flushPendingLogEntries(client);
            resolveConnectedWaiters(client);
            break;
          case 'connecting':
            setConnectionStatus(
              reconnectAttemptRef.current > 0
                ? { attempt: reconnectAttemptRef.current, type: 'reconnecting' }
                : { type: 'connecting' },
            );
            break;
          case 'closed':
            if (shouldReconnectRef.current) {
              scheduleReconnect(generation, nextStatus.reason ?? 'WebSocket closed');
            } else {
              setConnectionStatus({ type: 'disconnected' });
              rejectConnectedWaiters(nextStatus.reason ?? 'WebSocket closed');
            }
            break;
          case 'error':
            if (shouldReconnectRef.current) {
              scheduleReconnect(generation, nextStatus.message);
            } else {
              setError(nextStatus.message);
              setConnectionStatus({ type: 'disconnected' });
              rejectConnectedWaiters(nextStatus.message);
            }
            break;
          default:
            break;
        }
      },
      url: wsUrl,
    });

    clientRef.current = client;

    try {
      await client.connect();
    } catch (connectError) {
      if (clientRef.current === client && generationRef.current === generation) {
        scheduleReconnect(generation, errorMessage(connectError));
      }
    }
  }, [
    clearReconnectTimer,
    flushPendingLogEntries,
    rejectConnectedWaiters,
    resolveConnectedWaiters,
    scheduleReconnect,
    setConnectionStatus,
    settingsLoaded,
    wsUrl,
  ]);

  openConnectionRef.current = openConnection;

  const markClientConnectionLost = useCallback((client: RemuxRpcClient, reason: string) => {
    if (clientRef.current !== client) {
      return;
    }

    clientRef.current = null;
    if (shouldReconnectRef.current) {
      scheduleReconnect(generationRef.current, reason);
    } else {
      setConnectionStatus({ type: 'disconnected' });
      rejectConnectedWaiters(reason);
    }
  }, [rejectConnectedWaiters, scheduleReconnect, setConnectionStatus]);

  const ensureConnectionAfterResume = useCallback(() => {
    if (!settingsLoaded || !shouldReconnectRef.current) {
      return;
    }

    const client = clientRef.current;
    if (client?.isOpen()) {
      return;
    }

    if (client) {
      markClientConnectionLost(client, 'App resumed with closed WebSocket');
      return;
    }

    if (reconnectTimerRef.current === null) {
      void openConnectionRef.current?.();
    }
  }, [markClientConnectionLost, settingsLoaded]);

  useEffect(() => {
    setRemuxDebugSink((entry) => {
      const client = clientRef.current;
      if (client && statusRef.current.type === 'connected' && sendLogEntry(client, entry)) {
        return;
      }

      queueLogEntry(entry);
    });
    logRemuxDebug('app:diagnostics:attached');

    return () => {
      logRemuxDebug('app:diagnostics:detached');
      setRemuxDebugSink(null);
    };
  }, [queueLogEntry, sendLogEntry]);

  useEffect(() => {
    logRemuxDebug('app:state:initial', {
      state: AppState.currentState,
    });

    const appStateSubscription = AppState.addEventListener('change', (state) => {
      logRemuxDebug('app:state:change', { state });
      if (state === 'active') {
        ensureConnectionAfterResume();
      }
    });
    const memoryWarningSubscription = AppState.addEventListener('memoryWarning', () => {
      logRemuxDebug('app:memory-warning');
    });

    return () => {
      appStateSubscription.remove();
      memoryWarningSubscription.remove();
    };
  }, [ensureConnectionAfterResume]);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  useEffect(() => {
    if (!settingsLoaded) {
      return undefined;
    }

    shouldReconnectRef.current = true;
    generationRef.current += 1;
    reconnectAttemptRef.current = 0;
    logRemuxDebug('connection:mount', {
      origin,
      wsUrl,
    });
    void openConnection();

    return () => {
      logRemuxDebug('connection:unmount');
      shouldReconnectRef.current = false;
      generationRef.current += 1;
      clearReconnectTimer();
      clientRef.current?.close();
      clientRef.current = null;
      rejectConnectedWaiters('WebSocket closed');
    };
  }, [clearReconnectTimer, openConnection, origin, rejectConnectedWaiters, settingsLoaded, wsUrl]);

  const waitForConnectedClient = useCallback((timeoutMs = requestReconnectWaitMs) => {
    const client = clientRef.current;
    if (client && statusRef.current.type === 'connected' && client.isOpen()) {
      return Promise.resolve(client);
    }

    if (client && statusRef.current.type === 'connected' && !client.isOpen()) {
      markClientConnectionLost(client, 'Connected client socket is closed');
    }

    if (!shouldReconnectRef.current) {
      return Promise.reject(new Error('Remux is not connected'));
    }

    if (!clientRef.current && reconnectTimerRef.current === null) {
      void openConnectionRef.current?.();
    }

    return new Promise<RemuxRpcClient>((resolve, reject) => {
      const waiter: ConnectedWaiter = {
        reject,
        resolve,
        timer: setTimeout(() => {
          connectedWaitersRef.current.delete(waiter);
          reject(new Error('Remux is not connected'));
        }, timeoutMs),
      };

      connectedWaitersRef.current.add(waiter);
    });
  }, [markClientConnectionLost]);

  const request = useCallback<RemuxConnection['request']>(async (method, params, timeoutMs) => {
    const retryable = isRetryableRemuxRequest(method);
    let retryCount = 0;

    for (;;) {
      const client = await waitForConnectedClient(timeoutMs);
      try {
        return await client.request(method, params, timeoutMs);
      } catch (requestError) {
        if (
          retryable &&
          retryCount < maxRequestReconnectRetries &&
          requestError instanceof RemuxConnectionClosedError &&
          shouldReconnectRef.current
        ) {
          retryCount += 1;
          markClientConnectionLost(client, requestError.message);
          logRemuxDebug('connection:request:retry-after-reconnect', {
            method,
            phase: requestError.phase,
            retryCount,
          });
          continue;
        }

        throw requestError;
      }
    }
  }, [markClientConnectionLost, waitForConnectedClient]);

  const respond = useCallback<RemuxConnection['respond']>((id, result) => {
    try {
      clientRef.current?.respond(id, result);
    } catch (error) {
      logRemuxDebug('connection:response:failed', {
        error: errorMessage(error),
        id,
      });
    }
  }, []);

  const respondError = useCallback<RemuxConnection['respondError']>((id, error) => {
    try {
      clientRef.current?.respondError(id, error);
    } catch (responseError) {
      logRemuxDebug('connection:response:failed', {
        error: errorMessage(responseError),
        id,
      });
    }
  }, []);

  const subscribe = useCallback<RemuxConnection['subscribe']>((handler) => {
    subscribersRef.current.add(handler);
    return () => {
      subscribersRef.current.delete(handler);
    };
  }, []);

  const value = useMemo<RemuxConnection>(
    () => ({
      error,
      request,
      respond,
      respondError,
      status,
      subscribe,
    }),
    [error, request, respond, respondError, status, subscribe],
  );

  return (
    <RemuxConnectionContext.Provider value={value}>
      {children}
    </RemuxConnectionContext.Provider>
  );
}

export function useRemuxConnection() {
  const connection = useContext(RemuxConnectionContext);

  if (!connection) {
    throw new Error('useRemuxConnection must be used inside RemuxConnectionProvider');
  }

  return connection;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isRetryableRemuxRequest(method: string) {
  if (
    method === 'remux/codex/files' ||
    method === 'remux/extensions/status'
  ) {
    return true;
  }

  return method.endsWith('/read') ||
    method.endsWith('/status') ||
    method.includes('/resources/read') ||
    method.startsWith('remux/fs/read');
}
