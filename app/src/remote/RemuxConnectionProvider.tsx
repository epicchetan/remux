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
  createAbortError,
  type RpcCommandOptions,
  type RpcContract,
  type RpcJobOptions,
  type RpcQueryOptions,
  type RpcRequestOptions,
  type RpcSubscriptionOptions,
} from '@remux/viewer-kit/rpc';

import { logRemuxDebug, setRemuxDebugSink, type RemuxDebugEntry } from './remuxDebug';
import {
  RemuxConnectionClosedError,
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
const maxRequestReconnectRetries = 1;
const maxPendingLogEntries = 200;
const foregroundIdlePingMs = 10_000;
const heartbeatCheckMs = 1_000;
const drainingClientCloseDelayMs = 30_000;

type ReconnectOptions = {
  immediate?: boolean;
};

type ConnectedWaiter = {
  abortCleanup: (() => void) | null;
  reject: (error: Error) => void;
  resolve: (client: RemuxRpcClient) => void;
};

type DesiredRegistration = {
  params: unknown;
  revision: number;
};

export type RemuxConnectionStatus =
  | { type: 'connecting' }
  | {
      cwd: string | null;
      generation: number;
      serverInstanceId: string | null;
      type: 'connected';
    }
  | { attempt: number; type: 'reconnecting' }
  | { type: 'disconnected' };

export type RemuxConnection = {
  command: <T>(method: string, params?: unknown, options?: RpcCommandOptions) => Promise<T>;
  error: string | null;
  guardianAvailable: boolean;
  notify: (method: string, params?: unknown) => void;
  query: <T>(method: string, params?: unknown, options?: RpcQueryOptions) => Promise<T>;
  routeRequest: <T>(
    method: string,
    params?: unknown,
    contract?: RpcContract,
    context?: RemuxRpcRequestContext | null,
    options?: RpcRequestOptions,
  ) => Promise<T>;
  respond: (id: JsonRpcId, result: unknown) => void;
  respondError: (id: JsonRpcId, error: { code: number; data?: unknown; message: string }) => void;
  status: RemuxConnectionStatus;
  startJob: <T>(method: string, params: unknown, options: RpcJobOptions) => Promise<T>;
  subscribe: (handler: (message: RemuxRpcMessage) => void) => () => void;
  subscribeRequest: <T>(
    method: string,
    params?: unknown,
    options?: RpcSubscriptionOptions,
  ) => Promise<T>;
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
  const [guardianAvailable, setGuardianAvailable] = useState(false);
  const clientRef = useRef<RemuxRpcClient | null>(null);
  const candidateRef = useRef<RemuxRpcClient | null>(null);
  const connectedWaitersRef = useRef(new Set<ConnectedWaiter>());
  const connectionGenerationRef = useRef(0);
  const generationRef = useRef(0);
  const desiredRegistrationRef = useRef<DesiredRegistration | null>(null);
  const lastInboundAtRef = useRef(Date.now());
  const openConnectionRef = useRef<(() => Promise<void>) | null>(null);
  const pendingLogEntriesRef = useRef<RemuxDebugEntry[]>([]);
  const promotionTimesRef = useRef<number[]>([]);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resourceQueriesRef = useRef(new Map<string, AbortController>());
  const resumePingInFlightRef = useRef(false);
  const retryInFlightRef = useRef(0);
  const serverInstanceIdRef = useRef<string | null>(null);
  const durableCommandProtocolVersionRef = useRef<number | null>(null);
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

  const probeGuardian = useCallback(() => {
    void classifyHttpHealth(origin, token).then((classification) => {
      logRemuxDebug('connection:http-classification', classification);
      setGuardianAvailable(classification.guardianHealth.ok);
    });
  }, [origin, token]);

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const resolveConnectedWaiters = useCallback((client: RemuxRpcClient) => {
    for (const waiter of connectedWaitersRef.current) {
      waiter.abortCleanup?.();
      waiter.resolve(client);
    }

    connectedWaitersRef.current.clear();
  }, []);

  const rejectConnectedWaiters = useCallback((message: string) => {
    for (const waiter of connectedWaitersRef.current) {
      waiter.abortCleanup?.();
      waiter.reject(new Error(message));
    }

    connectedWaitersRef.current.clear();
  }, []);

  const completeConnection = useCallback(async (client: RemuxRpcClient, generation: number) => {
    const handshake = new AbortController();
    const handshakeTimer = setTimeout(
      () => handshake.abort('candidate-handshake-timeout'),
      remuxWebSocketConnectTimeoutMs,
    );
    let info: RemuxSystemInfo;
    try {
      await client.ping();
      info = await readRemuxSystemInfo(client, handshake.signal);
      for (;;) {
        const registration = desiredRegistrationRef.current;
        if (!registration) {
          break;
        }
        await client.request(
          'remux/clients/register',
          withRegistrationMetadata(
            registration.params,
            connectionGenerationRef.current + 1,
            registration.revision,
          ),
          { kind: 'subscription', resourceKey: 'client-registration' },
          null,
          { signal: handshake.signal },
        );
        if (desiredRegistrationRef.current?.revision === registration.revision) {
          break;
        }
      }
    } finally {
      clearTimeout(handshakeTimer);
    }
    if (candidateRef.current !== client || generationRef.current !== generation) {
      return;
    }

    const oldClient = clientRef.current;
    const now = Date.now();
    promotionTimesRef.current = promotionTimesRef.current.filter((at) => now - at < 30_000);
    if (oldClient && oldClient !== client && oldClient.isOpen() && promotionTimesRef.current.length >= 2) {
      try {
        await oldClient.ping();
        candidateRef.current = null;
        client.close('Promotion breaker retained healthy active connection');
        setError(null);
        const retainedStatus = statusRef.current;
        setConnectionStatus({
          cwd: retainedStatus.type === 'connected' ? retainedStatus.cwd : info.cwd,
          generation: connectionGenerationRef.current,
          serverInstanceId: serverInstanceIdRef.current,
          type: 'connected',
        });
        resolveConnectedWaiters(oldClient);
        logRemuxDebug('connection:breaker-opened', {
          promotions: promotionTimesRef.current.length,
          windowMs: 30_000,
        });
        return;
      } catch {
        // The active generation failed its reserved liveness probe, so the
        // breaker must not strand the app on it.
      }
    }
    clientRef.current = client;
    candidateRef.current = null;
    connectionGenerationRef.current += 1;
    serverInstanceIdRef.current = info.serverInstanceId;
    durableCommandProtocolVersionRef.current = info.durableCommandProtocolVersion;
    lastInboundAtRef.current = Date.now();
    reconnectAttemptRef.current = 0;
    setError(null);
    setGuardianAvailable(false);
    setConnectionStatus({
      cwd: info.cwd,
      generation: connectionGenerationRef.current,
      serverInstanceId: info.serverInstanceId,
      type: 'connected',
    });
    flushPendingLogEntries(client);
    resolveConnectedWaiters(client);
    logRemuxDebug('connection:candidate:promoted', {
      generation: connectionGenerationRef.current,
      replacedActive: Boolean(oldClient && oldClient !== client),
    });
    if (oldClient && oldClient !== client) {
      promotionTimesRef.current.push(now);
      drainOldClient(oldClient, drainingClientCloseDelayMs);
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
            probeGuardian();
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
            probeGuardian();
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
    probeGuardian,
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
    probeGuardian();
    if (shouldReconnectRef.current) {
      scheduleReconnect(generationRef.current, reason, options);
    } else {
      setConnectionStatus({ type: 'disconnected' });
      rejectConnectedWaiters(reason);
    }
  }, [probeGuardian, rejectConnectedWaiters, scheduleReconnect, setConnectionStatus]);

  const verifyResumedConnection = useCallback((client: RemuxRpcClient) => {
    if (resumePingInFlightRef.current) {
      return;
    }

    resumePingInFlightRef.current = true;
    client.ping()
      .then(() => {
        logRemuxDebug('connection:resume-ping:ok');
      })
      .catch((pingError) => {
        // A JSON-RPC method error still proves the socket is alive. An abort
        // from the transport-owned ping deadline means the socket is suspect.
        const timedOut = pingError instanceof Error && pingError.name === 'AbortError';
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
      for (const controller of resourceQueriesRef.current.values()) {
        controller.abort('connection-provider-unmounted');
      }
      resourceQueriesRef.current.clear();
      clientRef.current?.close();
      clientRef.current = null;
      candidateRef.current?.close();
      candidateRef.current = null;
      rejectConnectedWaiters('WebSocket closed');
    };
  }, [clearReconnectTimer, openConnection, origin, rejectConnectedWaiters, settingsLoaded, wsUrl]);

  const waitForConnectedClient = useCallback((signal?: AbortSignal) => {
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

    if (signal?.aborted) {
      return Promise.reject(createAbortError(signal.reason));
    }

    if (!clientRef.current && reconnectTimerRef.current === null) {
      void openConnectionRef.current?.();
    }

    return new Promise<RemuxRpcClient>((resolve, reject) => {
      let waiter: ConnectedWaiter;
      let abort: (() => void) | null = null;
      if (signal) {
        abort = () => {
          connectedWaitersRef.current.delete(waiter);
          if (abort) {
            signal.removeEventListener('abort', abort);
          }
          reject(createAbortError(signal.reason));
        };
      }
      waiter = {
        abortCleanup: abort && signal
          ? () => signal.removeEventListener('abort', abort)
          : null,
        reject,
        resolve,
      };

      connectedWaitersRef.current.add(waiter);
      signal?.addEventListener('abort', abort!, { once: true });
    });
  }, [markClientConnectionLost]);

  const routeRequest = useCallback<RemuxConnection['routeRequest']>(async (
    method,
    params,
    contract = { kind: 'query' },
    context,
    options = {},
  ) => {
    let requestParams = params;
    if (method === 'remux/clients/register') {
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
    const retryableQuery = contract.kind === 'query';
    const durableCommand = contract.kind === 'command' && Boolean(contract.operationId);
    let retryCount = 0;
    let holdsRetryPermit = false;
    let admittedServerInstanceId: string | null | undefined;

    try {
      for (;;) {
        const client = await waitForConnectedClient(options.signal);
        if (durableCommand && admittedServerInstanceId !== undefined) {
          if (serverInstanceIdRef.current !== admittedServerInstanceId) {
            throw new Error(
              'Remux restarted while the command outcome was unknown; reconcile server state before retrying.',
            );
          }
        }
        if (durableCommand && admittedServerInstanceId === undefined) {
          admittedServerInstanceId = serverInstanceIdRef.current;
        }
        try {
          return await client.request(
            method,
            requestParams,
            contract,
            context,
            options,
          );
        } catch (requestError) {
          const mayRetryQuery = retryableQuery && retryCount < maxRequestReconnectRetries;
          const mayRetryDurableCommand = durableCommand
            && durableCommandProtocolVersionRef.current === 1
            && admittedServerInstanceId !== null;
          if (
            (mayRetryQuery || mayRetryDurableCommand) &&
            requestError instanceof RemuxConnectionClosedError &&
            shouldReconnectRef.current &&
            (holdsRetryPermit || retryInFlightRef.current < 8)
          ) {
            retryCount += 1;
            if (!holdsRetryPermit) {
              retryInFlightRef.current += 1;
              holdsRetryPermit = true;
            }
            markClientConnectionLost(client, requestError.message, { immediate: true });
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
    } finally {
      if (holdsRetryPermit) {
        retryInFlightRef.current = Math.max(0, retryInFlightRef.current - 1);
      }
    }
  }, [markClientConnectionLost, waitForConnectedClient]);

  const query = useCallback(<T,>(
    method: string,
    params?: unknown,
    options: RpcQueryOptions = {},
  ): Promise<T> => {
    if (!options.resourceKey) {
      return routeRequest<T>(method, params, { kind: 'query' }, null, options);
    }
    const key = options.resourceKey;
    resourceQueriesRef.current.get(key)?.abort('resource-superseded');
    const controller = new AbortController();
    resourceQueriesRef.current.set(key, controller);
    const callerAbort = options.signal
      ? () => controller.abort(options.signal?.reason)
      : null;
    options.signal?.addEventListener('abort', callerAbort!, { once: true });
    return routeRequest<T>(
      method,
      params,
      { kind: 'query', resourceKey: key },
      null,
      { signal: controller.signal },
    ).finally(() => {
      if (resourceQueriesRef.current.get(key) === controller) {
        resourceQueriesRef.current.delete(key);
      }
      if (callerAbort) {
        options.signal?.removeEventListener('abort', callerAbort);
      }
    });
  }, [routeRequest]);

  const command = useCallback<RemuxConnection['command']>((method, params, options = {}) =>
    routeRequest(
      method,
      params,
      {
        kind: 'command',
        ...(options.operationId ? { operationId: options.operationId } : {}),
        ...(options.preconditionRevision !== undefined
          ? { preconditionRevision: options.preconditionRevision }
          : {}),
      },
      null,
      options,
    ), [routeRequest]);

  const startJob = useCallback<RemuxConnection['startJob']>((method, params, options) =>
    routeRequest(
      method,
      params,
      { kind: 'job-start', operationId: options.operationId },
      null,
      options,
    ), [routeRequest]);

  const subscribeRequest = useCallback<RemuxConnection['subscribeRequest']>((
    method,
    params,
    options = {},
  ) => routeRequest(
    method,
    params,
    {
      kind: 'subscription',
      ...(options.resourceKey ? { resourceKey: options.resourceKey } : {}),
    },
    null,
    options,
  ), [routeRequest]);

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
      command,
      error,
      guardianAvailable,
      notify,
      query,
      routeRequest,
      respond,
      respondError,
      startJob,
      status,
      subscribe,
      subscribeRequest,
    }),
    [
      command,
      error,
      guardianAvailable,
      notify,
      query,
      respond,
      respondError,
      routeRequest,
      startJob,
      status,
      subscribe,
      subscribeRequest,
    ],
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

type RemuxSystemInfo = {
  cwd: string | null;
  durableCommandProtocolVersion: number | null;
  serverInstanceId: string | null;
};

async function readRemuxSystemInfo(
  client: RemuxRpcClient,
  signal?: AbortSignal,
): Promise<RemuxSystemInfo> {
  const response = await client.request<unknown>(
    'remux/system/info',
    undefined,
    { kind: 'query', resourceKey: 'system-info' },
    null,
    { signal },
  );
  if (!isRecord(response) || (typeof response.cwd !== 'string' && response.cwd !== null)) {
    throw new Error('Invalid remux/system/info response');
  }
  return {
    cwd: typeof response.cwd === 'string' && response.cwd.trim().length > 0 ? response.cwd : null,
    durableCommandProtocolVersion: isRecord(response.capabilities)
      && response.capabilities.durableCommandProtocolVersion === 1
      ? 1
      : null,
    serverInstanceId: typeof response.serverInstanceId === 'string'
      && response.serverInstanceId.trim().length > 0
      ? response.serverInstanceId
      : null,
  };
}

function drainOldClient(client: RemuxRpcClient, ceilingMs: number) {
  const startedAt = Date.now();
  const timer = setInterval(() => {
    if (client.pendingCount() === 0) {
      clearInterval(timer);
      client.close('Connection generation drained');
      return;
    }
    if (Date.now() - startedAt >= ceilingMs) {
      clearInterval(timer);
      client.close('Connection generation drain ceiling reached');
    }
  }, 50);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function classifyHttpHealth(origin: string, token: string | null) {
  const request = async (base: string, path: string, authenticated: boolean) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    try {
      const response = await fetch(`${base}${path}`, {
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

  const guardian = guardianOrigin(origin);
  const [health, status, guardianHealth, guardianStatus] = await Promise.all([
    request(origin, '/healthz', false),
    request(origin, '/api/status', true),
    request(guardian, '/healthz', false),
    request(guardian, '/control/v1/status', true),
  ]);
  return { guardianHealth, guardianStatus, health, status };
}

function guardianOrigin(origin: string) {
  try {
    const url = new URL(origin);
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    url.port = String(port + 1);
    return url.origin;
  } catch {
    return origin;
  }
}

function withRegistrationMetadata(params: unknown, connectionGeneration: number, revision: number) {
  return isRecord(params)
    ? { ...params, connectionGeneration, registrationRevision: revision }
    : params;
}
