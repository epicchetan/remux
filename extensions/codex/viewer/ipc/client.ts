import type { JsonRpcId, JsonRpcMessage } from './rpcTypes';
import type { CodexViewHostStatus } from './types';

type WebViewReady = { type: 'remux/ready' };

type WebViewRequest =
  | WebViewReady
  | {
      id: JsonRpcId;
      method: string;
      params?: unknown;
      timeoutMs?: number;
      type: 'remux/request';
    };

type WebViewResponse =
  | {
      id: JsonRpcId;
      result: unknown;
      type: 'remux/response';
    }
  | {
      error: {
        code?: number;
        data?: unknown;
        message: string;
      };
      id?: JsonRpcId;
      type: 'remux/error';
    };

type WebViewEvent = {
  message: JsonRpcMessage;
  type: 'remux/event';
};

type WebViewStatus = {
  error: string | null;
  status: CodexViewHostStatus;
  type: 'remux/status';
};

type NativeMessage = WebViewEvent | WebViewResponse | WebViewStatus;

type PendingRequest = {
  reject: (error: Error) => void;
  resolve: (value: unknown) => void;
  timer: number;
};

type IpcEventSubscriber = (events: JsonRpcMessage[]) => void;
type IpcStatusSubscriber = (status: IpcStatusSnapshot) => void;

export type IpcStatusSnapshot = {
  error: string | null;
  status: CodexViewHostStatus;
};

const requestIdPrefix = 'codex-viewer';
const defaultRequestTimeoutMs = 300_000;

let initialized = false;
let nextId = 1;
let eventFlushHandle: number | null = null;
let statusSnapshot: IpcStatusSnapshot = {
  error: null,
  status: { type: 'connecting' },
};
const eventQueue: JsonRpcMessage[] = [];
const pendingRequests = new Map<JsonRpcId, PendingRequest>();
const eventSubscribers = new Set<IpcEventSubscriber>();
const statusSubscribers = new Set<IpcStatusSubscriber>();

declare global {
  interface Window {
    ReactNativeWebView?: {
      postMessage: (message: string) => void;
    };
  }
}

export function requestIpc<T>(method: string, params?: unknown, timeoutMs = defaultRequestTimeoutMs) {
  initializeIpc();

  const id = `${requestIdPrefix}:${nextId++}`;

  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`${method} timed out`));
    }, timeoutMs);

    pendingRequests.set(id, {
      reject,
      resolve: resolve as (value: unknown) => void,
      timer,
    });

    try {
      postMessage(
        params === undefined
          ? { id, method, timeoutMs, type: 'remux/request' }
          : { id, method, params, timeoutMs, type: 'remux/request' },
      );
    } catch (error) {
      window.clearTimeout(timer);
      pendingRequests.delete(id);
      reject(errorFromUnknown(error));
    }
  });
}

export function subscribeIpcEvents(subscriber: IpcEventSubscriber) {
  initializeIpc();
  eventSubscribers.add(subscriber);
  return () => {
    eventSubscribers.delete(subscriber);
  };
}

export function subscribeIpcStatus(subscriber: IpcStatusSubscriber) {
  initializeIpc();
  statusSubscribers.add(subscriber);
  subscriber(statusSnapshot);
  return () => {
    statusSubscribers.delete(subscriber);
  };
}

export function getIpcStatusSnapshot() {
  return statusSnapshot;
}

export function initializeIpc() {
  if (initialized) {
    return;
  }

  window.addEventListener('message', handleNativeMessage);
  document.addEventListener('message', handleNativeMessage as EventListener);
  initialized = true;

  try {
    postMessage({ type: 'remux/ready' });
  } catch (error) {
    updateStatus({
      error: errorMessage(error),
      status: { message: errorMessage(error), type: 'error' },
    });
  }
}

function handleNativeMessage(event: MessageEvent) {
  const message = parseNativeMessage(event.data);
  if (!message) {
    return;
  }

  if (message.type === 'remux/event') {
    enqueueEvent(message.message);
    return;
  }

  if (message.type === 'remux/status') {
    updateStatus({
      error: message.error,
      status: message.status,
    });
    if (message.status.type === 'closed') {
      rejectPendingRequests(message.status.reason ?? 'Remux is not connected');
    } else if (message.status.type === 'error') {
      rejectPendingRequests(message.status.message);
    }
    return;
  }

  if (!message.id || !isRequestId(message.id)) {
    if (message.type === 'remux/error') {
      updateStatus({
        error: message.error.message,
        status: { message: message.error.message, type: 'error' },
      });
      rejectPendingRequests(message.error.message);
    }
    return;
  }

  const pending = pendingRequests.get(message.id);
  if (!pending) {
    if (message.type === 'remux/error') {
      updateStatus({
        error: message.error.message,
        status: { message: message.error.message, type: 'error' },
      });
      rejectPendingRequests(message.error.message);
    }
    return;
  }

  window.clearTimeout(pending.timer);
  pendingRequests.delete(message.id);

  if (message.type === 'remux/error') {
    pending.reject(new Error(message.error.message));
    return;
  }

  pending.resolve(message.result);
}

function updateStatus(snapshot: IpcStatusSnapshot) {
  statusSnapshot = snapshot;
  for (const subscriber of statusSubscribers) {
    subscriber(statusSnapshot);
  }
}

function rejectPendingRequests(reason: string) {
  for (const [id, pending] of pendingRequests) {
    window.clearTimeout(pending.timer);
    pending.reject(new Error(reason));
    pendingRequests.delete(id);
  }
}

function enqueueEvent(message: JsonRpcMessage) {
  if (eventSubscribers.size === 0) {
    return;
  }

  eventQueue.push(message);
  if (eventFlushHandle !== null) {
    return;
  }

  const schedule = typeof window.requestAnimationFrame === 'function'
    ? window.requestAnimationFrame
    : (callback: FrameRequestCallback) => window.setTimeout(() => callback(Date.now()), 16);

  eventFlushHandle = schedule(() => {
    eventFlushHandle = null;
    flushEvents();
  });
}

function flushEvents() {
  if (eventQueue.length === 0 || eventSubscribers.size === 0) {
    eventQueue.length = 0;
    return;
  }

  const events = eventQueue.splice(0);
  for (const subscriber of eventSubscribers) {
    subscriber(events);
  }
}

function postMessage(message: WebViewRequest) {
  const bridge = typeof window === 'undefined' ? null : window.ReactNativeWebView;
  if (!bridge) {
    throw new Error('React Native WebView bridge is not available');
  }

  bridge.postMessage(JSON.stringify(message));
}

function parseNativeMessage(data: unknown): NativeMessage | null {
  if (typeof data !== 'string') {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(data);
    return isNativeMessage(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isNativeMessage(value: unknown): value is NativeMessage {
  return isWebViewResponse(value) || isWebViewEvent(value) || isWebViewStatus(value);
}

function isWebViewResponse(value: unknown): value is WebViewResponse {
  if (!value || typeof value !== 'object' || !('type' in value)) {
    return false;
  }

  const type = (value as { type?: unknown }).type;
  return type === 'remux/response' || type === 'remux/error';
}

function isWebViewEvent(value: unknown): value is WebViewEvent {
  return Boolean(
    value &&
    typeof value === 'object' &&
    (value as { type?: unknown }).type === 'remux/event' &&
    (value as { message?: unknown }).message &&
    typeof (value as { message?: unknown }).message === 'object',
  );
}

function isWebViewStatus(value: unknown): value is WebViewStatus {
  if (!value || typeof value !== 'object' || !('type' in value)) {
    return false;
  }

  return (value as { type?: unknown }).type === 'remux/status';
}

function isRequestId(id: JsonRpcId) {
  return typeof id === 'string' && id.startsWith(`${requestIdPrefix}:`);
}

function errorFromUnknown(error: unknown) {
  return error instanceof Error ? error : new Error(String(error));
}

function errorMessage(error: unknown) {
  return errorFromUnknown(error).message;
}
