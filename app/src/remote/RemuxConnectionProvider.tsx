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
import {
  rpcPolicies,
  type RpcRequestPolicy,
} from '@remux/viewer-kit/rpc-policy';

import { logRemuxDebug, setRemuxDebugSink, type RemuxDebugEntry } from './remuxDebug';
import {
  RemuxConnectionClosedError,
  RemuxRequestTimeoutError,
  RemuxRpcClient,
  type JsonRpcId,
  type RemuxRpcMessage,
  type RemuxRpcRequestContext,
} from './remuxRpcClient';
import {
  remuxOriginFromSettings,
  useRemuxSettingsStore,
  websocketUrl,
} from './remuxSettingsStore';

const reconnectDelaysMs = [400, 900, 1800, 3500, 5000];
const remuxWebSocketConnectTimeoutMs = 6_000;
const requestReconnectWaitMs = 8000;
const maxRequestReconnectRetries = 1;
const maxPendingLogEntries = 200;
const foregroundIdlePingMs = 10_000;
const heartbeatCheckMs = 1_000;
const drainingClientCloseDelayMs = 250;

type ReconnectOptions = {
  immediate?: boolean;
};

type ConnectedWaiter = {
  reject: (error: Error) => void;
  resolve: (client: RemuxRpcClient) => void;
  timer: ReturnType<typeof setTimeout>;
};

type DesiredRegistration = {
  params: unknown;
  revision: number;
};

export type RemuxConnectionStatus =
  | { type: 'connecting' }
  | { cwd: string | null; generation: number; type: 'connected' }
  | { attempt: number; type: 'reconnecting' }
  | { type: 'disconnected' };

export type RemuxConnection = {
  error: string | null;
  notify: (method: string, params?: unknown) => void;
  request: <T>(
    policy: RpcRequestPolicy,
    params?: unknown,
    context?: RemuxRpcRequestContext | null,
  ) => Promise<T>;
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
  const token = useRemuxSettingsStore((state) => state.token);
  const [status, setStatus] = useState<RemuxConnectionStatus>({ type: 'connecting' });
  const [error, setError] = useState<string | null>(null);
  const clientRef = useRef<RemuxRpcClient | null>(null);
  const candidateRef = useRef<RemuxRpcClient | null>(null);
  const connectedWaitersRef = useRef(new Set<ConnectedWaiter>());
  const connectionGenerationRef = useRef(0);
  const generationRef = useRef(0);
  const desiredRegistrationRef = useRef<DesiredRegistration | null>(null);
  const lastInboundAtRef = useRef(Date.now());
  const openConnectionRef = useRef<(() => Promise<void>) | null>(null);
  const pendingLogEntriesRef = useRef<RemuxDebugEntry[]>([]);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resumePingInFlightRef = useRef(false);
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

  const completeConnection = useCallback(async (client: RemuxRpcClient, generation: number) => {
    await client.request(rpcPolicies['system-ping']);
    const info = await readRemuxSystemInfo(client);
    for (;;) {
      const registration = desiredRegistrationRef.current;
      if (!registration) {
        break;
      }
      await client.request(
        rpcPolicies['client-register'],
        withRegistrationMetadata(
          registration.params,
          connectionGenerationRef.current + 1,
          registration.revision,
        ),
      );
      if (desiredRegistrationRef.current?.revision === registration.revision) {
        break;
      }
    }
    if (candidateRef.current !== client || generationRef.current !== generation) {
      return;
    }

    const oldClient = clientRef.current;
    clientRef.current = client;
    candidateRef.current = null;
    connectionGenerationRef.current += 1;
    lastInboundAtRef.current = Date.now();
    reconnectAttemptRef.current = 0;
    setError(null);
    setConnectionStatus({
      cwd: info.cwd,
      generation: connectionGenerationRef.current,
      type: 'connected',
    });
    flushPendingLogEntries(client);
    resolveConnectedWaiters(client);
    logRemuxDebug('connection:candidate:promoted', {
      generation: connectionGenerationRef.current,
      replacedActive: Boolean(oldClient && oldClient !== client),
    });
    if (oldClient && oldClient !== client) {
      setTimeout(() => oldClient.close('Superseded by healthy connection'), drainingClientCloseDelayMs);
    }
  }, [flushPendingLogEntries, resolveConnectedWaiters, setConnectionStatus]);

  const scheduleReconnect = useCallback((
    generation: number,
    reason: string,
    options: ReconnectOptions = {},
  ) => {
    if (!shouldReconnectRef.current) {
      return;
    }

    if (reconnectTimerRef.current !== null) {
      if (!options.immediate) {
        return;
      }

      clearReconnectTimer();
    }

    const attempt = reconnectAttemptRef.current + 1;
    reconnectAttemptRef.current = attempt;
    setError(reason);
    setConnectionStatus({ attempt, type: 'reconnecting' });

    const baseDelay = reconnectDelaysMs[Math.min(attempt - 1, reconnectDelaysMs.length - 1)]!;
    const delay = options.immediate
      ? 0
      : Math.floor(Math.random() * (baseDelay + 1));
    logRemuxDebug('connection:reconnect:scheduled', {
      attempt,
      delayMs: delay,
      immediate: options.immediate === true,
      reason,
    });
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      if (generationRef.current === generation && shouldReconnectRef.current) {
        void openConnectionRef.current?.();
      }
    }, delay);
  }, [clearReconnectTimer, setConnectionStatus]);

  const openConnection = useCallback(async () => {
    if (!settingsLoaded) {
      return;
    }
    if (candidateRef.current) {
      return;
    }

    clearReconnectTimer();
    const generation = generationRef.current;
    const reconnecting = reconnectAttemptRef.current > 0 || clientRef.current !== null;
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
      connectionGeneration: connectionGenerationRef.current + 1,
      onMessage: (message) => {
        if (clientRef.current !== client) {
          return;
        }

        for (const handler of subscribersRef.current) {
          handler(message);
        }
      },
      onInbound: (receivedAt) => {
        lastInboundAtRef.current = Math.max(lastInboundAtRef.current, receivedAt);
      },
      onStatus: (nextStatus) => {
        const isCandidate = candidateRef.current === client;
        const isActive = clientRef.current === client;
        if (!isCandidate && !isActive) {
          return;
        }

        logRemuxDebug('client:status', nextStatus);
        switch (nextStatus.type) {
          case 'connected':
            if (isCandidate) {
              void completeConnection(client, generation).catch((handshakeError) => {
                if (candidateRef.current !== client) {
                  return;
                }
                candidateRef.current = null;
                client.close(errorMessage(handshakeError));
                scheduleReconnect(generation, errorMessage(handshakeError));
              });
            }
            break;
          case 'connecting':
            setConnectionStatus(
              reconnectAttemptRef.current > 0
                ? { attempt: reconnectAttemptRef.current, type: 'reconnecting' }
                : { type: 'connecting' },
            );
            break;
          case 'closed':
            if (isCandidate) {
              candidateRef.current = null;
            }
            if (isActive) {
              clientRef.current = null;
            }
            if (shouldReconnectRef.current) {
              scheduleReconnect(generation, nextStatus.reason ?? 'WebSocket closed');
            } else {
              setConnectionStatus({ type: 'disconnected' });
              rejectConnectedWaiters(nextStatus.reason ?? 'WebSocket closed');
            }
            break;
          case 'error':
            if (isCandidate) {
              candidateRef.current = null;
            }
            if (isActive && !client.isOpen()) {
              clientRef.current = null;
            }
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
      connectTimeoutMs: remuxWebSocketConnectTimeoutMs,
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      url: wsUrl,
    });

    candidateRef.current = client;

    try {
      await client.connect();
    } catch (connectError) {
      if (candidateRef.current === client && generationRef.current === generation) {
        candidateRef.current = null;
        scheduleReconnect(generation, errorMessage(connectError));
      }
    }
  }, [
    clearReconnectTimer,
    completeConnection,
    rejectConnectedWaiters,
    scheduleReconnect,
    setConnectionStatus,
    settingsLoaded,
    token,
    wsUrl,
  ]);

  openConnectionRef.current = openConnection;

  const markClientConnectionLost = useCallback((
    client: RemuxRpcClient,
    reason: string,
    options: ReconnectOptions = {},
  ) => {
    if (clientRef.current !== client) {
      return;
    }

    const socketClosed = !client.isOpen();
    if (socketClosed) {
      clientRef.current = null;
      client.close(reason);
    }
    logRemuxDebug('connection:client:suspect', { reason, socketClosed });
    void classifyHttpHealth(origin, token).then((classification) => {
      logRemuxDebug('connection:http-classification', classification);
    });
    if (shouldReconnectRef.current) {
      scheduleReconnect(generationRef.current, reason, options);
    } else {
      setConnectionStatus({ type: 'disconnected' });
      rejectConnectedWaiters(reason);
    }
  }, [origin, rejectConnectedWaiters, scheduleReconnect, setConnectionStatus, token]);

  const verifyResumedConnection = useCallback((client: RemuxRpcClient) => {
    if (resumePingInFlightRef.current) {
      return;
    }

    resumePingInFlightRef.current = true;
    client.request(rpcPolicies['system-ping'])
      .then(() => {
        logRemuxDebug('connection:resume-ping:ok');
      })
      .catch((pingError) => {
        // Any response — even an error from an older daemon without the ping
        // route — proves the socket is alive; only silence means it is dead.
        const timedOut = pingError instanceof RemuxRequestTimeoutError;
        if (!timedOut) {
          logRemuxDebug('connection:resume-ping:ok', { error: errorMessage(pingError) });
          return;
        }

        markClientConnectionLost(client, 'App resumed with unresponsive WebSocket', { immediate: true });
      })
      .finally(() => {
        resumePingInFlightRef.current = false;
      });
  }, [markClientConnectionLost]);

  const ensureConnectionAfterResume = useCallback(() => {
    if (!settingsLoaded || !shouldReconnectRef.current) {
      return;
    }

    const client = clientRef.current;
    if (client?.isOpen()) {
      // readyState still reports OPEN on a half-open socket (TCP died without
      // a close frame while backgrounded — common across network changes).
      // Trusting it would leave the app "connected" while the daemon
      // broadcasts into the void, so prove liveness before moving on.
      verifyResumedConnection(client);
      return;
    }

    if (client) {
      markClientConnectionLost(client, 'App resumed with closed WebSocket', { immediate: true });
      return;
    }

    scheduleReconnect(generationRef.current, 'App resumed without WebSocket', { immediate: true });
  }, [markClientConnectionLost, scheduleReconnect, settingsLoaded, verifyResumedConnection]);

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
    const timer = setInterval(() => {
      if (AppState.currentState !== 'active' || statusRef.current.type !== 'connected') {
        return;
      }
      const client = clientRef.current;
      if (!client?.isOpen() || Date.now() - lastInboundAtRef.current < foregroundIdlePingMs) {
        return;
      }
      logRemuxDebug('connection:heartbeat:idle', {
        idleMs: Date.now() - lastInboundAtRef.current,
      });
      verifyResumedConnection(client);
    }, heartbeatCheckMs);

    return () => clearInterval(timer);
  }, [verifyResumedConnection]);

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
      candidateRef.current?.close();
      candidateRef.current = null;
      rejectConnectedWaiters('WebSocket closed');
    };
  }, [clearReconnectTimer, openConnection, origin, rejectConnectedWaiters, settingsLoaded, wsUrl]);

  const waitForConnectedClient = useCallback((timeoutMs = requestReconnectWaitMs) => {
    const client = clientRef.current;
    if (client && statusRef.current.type === 'connected' && client.isOpen()) {
      return Promise.resolve(client);
    }

    if (client && statusRef.current.type === 'connected' && !client.isOpen()) {
      markClientConnectionLost(client, 'Connected client socket is closed', { immediate: true });
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

  const request = useCallback<RemuxConnection['request']>(async (policy, params, context) => {
    let requestParams = params;
    if (policy.name === 'client-register') {
      const registration = {
        params,
        revision: (desiredRegistrationRef.current?.revision ?? 0) + 1,
      };
      desiredRegistrationRef.current = registration;
      requestParams = withRegistrationMetadata(
        params,
        connectionGenerationRef.current,
        registration.revision,
      );
    }
    const startedAt = Date.now();
    const deadlineAt = startedAt + policy.budget.totalMs;
    const retryable = policy.retry === 'read-safe';
    let retryCount = 0;

    for (;;) {
      const remainingBeforeConnect = deadlineAt - Date.now();
      if (remainingBeforeConnect <= 0) {
        throw new RemuxRequestTimeoutError(policy, 'connection-wait', policy.budget.totalMs, {
          connectionGeneration: connectionGenerationRef.current,
          lastInboundAt: lastInboundAtRef.current,
          sentAt: startedAt,
        });
      }
      const client = await waitForConnectedClient(Math.min(
        policy.budget.connectWaitMs,
        remainingBeforeConnect,
      ));
      try {
        const remaining = deadlineAt - Date.now();
        if (remaining <= 0) {
          throw new RemuxRequestTimeoutError(policy, 'before-send', policy.budget.totalMs, {
            connectionGeneration: connectionGenerationRef.current,
            lastInboundAt: lastInboundAtRef.current,
            sentAt: startedAt,
          });
        }
        const phaseBudget = policy.budget.queueMs
          + policy.budget.executionMs
          + policy.budget.transferMs;
        return await client.request(
          policy,
          requestParams,
          context,
          Math.min(remaining, phaseBudget),
          remaining,
        );
      } catch (requestError) {
        let timedOutConnection = false;
        if (requestError instanceof RemuxRequestTimeoutError) {
          const shouldRecoverConnection = policy.timeoutHealth === 'connection-failed' || (
            policy.timeoutHealth === 'probe-connection' &&
            lastInboundAtRef.current <= startedAt
          );
          if (shouldRecoverConnection) {
            timedOutConnection = true;
            markClientConnectionLost(client, requestError.message, { immediate: true });
          }
        }
        if (
          retryable &&
          retryCount < maxRequestReconnectRetries &&
          (requestError instanceof RemuxConnectionClosedError || timedOutConnection) &&
          shouldReconnectRef.current
        ) {
          retryCount += 1;
          const reconnectError = requestError as
            | RemuxConnectionClosedError
            | RemuxRequestTimeoutError;
          markClientConnectionLost(client, reconnectError.message, { immediate: true });
          logRemuxDebug('connection:request:retry-after-reconnect', {
            method: policy.method,
            policy: policy.name,
            phase: reconnectError.phase,
            retryCount,
          });
          continue;
        }

        throw requestError;
      }
    }
  }, [markClientConnectionLost, waitForConnectedClient]);

  const notify = useCallback<RemuxConnection['notify']>((method, params) => {
    clientRef.current?.tryNotify(method, params);
  }, []);

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
      notify,
      request,
      respond,
      respondError,
      status,
      subscribe,
    }),
    [error, notify, request, respond, respondError, status, subscribe],
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

async function readRemuxSystemInfo(client: RemuxRpcClient): Promise<{ cwd: string | null }> {
  const response = await client.request<unknown>(rpcPolicies['system-info']);
  if (!isRecord(response) || (typeof response.cwd !== 'string' && response.cwd !== null)) {
    throw new Error('Invalid remux/system/info response');
  }
  return {
    cwd: typeof response.cwd === 'string' && response.cwd.trim().length > 0 ? response.cwd : null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function classifyHttpHealth(origin: string, token: string | null) {
  const request = async (path: string, authenticated: boolean) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    try {
      const response = await fetch(`${origin}${path}`, {
        cache: 'no-store',
        headers: authenticated && token ? { Authorization: `Bearer ${token}` } : undefined,
        signal: controller.signal,
      });
      return { ok: response.ok, status: response.status };
    } catch (error) {
      return {
        error: controller.signal.aborted ? 'timeout' : errorMessage(error),
        ok: false,
        status: null,
      };
    } finally {
      clearTimeout(timeout);
    }
  };

  const [health, status] = await Promise.all([
    request('/healthz', false),
    request('/api/status', true),
  ]);
  return { health, status };
}

function withRegistrationMetadata(params: unknown, connectionGeneration: number, revision: number) {
  return isRecord(params)
    ? { ...params, connectionGeneration, registrationRevision: revision }
    : params;
}
