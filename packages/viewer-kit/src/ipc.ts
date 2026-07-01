export type JsonRpcId = number | string;

export type JsonRpcMessage = {
  id?: JsonRpcId;
  jsonrpc?: '2.0';
  method?: string;
  params?: unknown;
  result?: unknown;
};

type WebViewReady = { type: 'remux/ready' };

type WebViewRequest =
  | WebViewReady
  | {
      method: string;
      params?: unknown;
      type: 'remux/notify';
    }
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

export type RemuxViewHostStatus =
  | { type: 'idle' }
  | { type: 'connecting' }
  | { cwd: string | null; type: 'connected' }
  | { type: 'reconnecting'; attempt: number }
  | { type: 'closed'; reason?: string }
  | { type: 'error'; message: string };

type WebViewStatus = {
  error: string | null;
  status: RemuxViewHostStatus;
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
  status: RemuxViewHostStatus;
};

const requestIdPrefix = 'remux-extension-viewer';
const defaultRequestTimeoutMs = 300_000;

let initialized = false;
let nextId = 1;
let eventFlushScheduled = false;
let statusSnapshot: IpcStatusSnapshot = {
  error: null,
  status: { type: 'connecting' },
};
const eventQueue: JsonRpcMessage[] = [];
const eventSubscribers = new Set<IpcEventSubscriber>();
const pendingRequests = new Map<JsonRpcId, PendingRequest>();
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

export function notifyIpc(method: string, params?: unknown) {
  initializeIpc();
  postMessage(
    params === undefined
      ? { method, type: 'remux/notify' }
      : { method, params, type: 'remux/notify' },
  );
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

  postMessage({ type: 'remux/ready' });
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
  eventQueue.push(message);

  if (eventFlushScheduled) {
    return;
  }

  eventFlushScheduled = true;
  queueMicrotask(() => {
    eventFlushScheduled = false;
    const events = eventQueue.splice(0);
    for (const subscriber of eventSubscribers) {
      subscriber(events);
    }
  });
}

function parseNativeMessage(data: unknown): NativeMessage | null {
  try {
    const parsed = typeof data === 'string' ? JSON.parse(data) : data;
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }

    const message = parsed as NativeMessage;
    if (
      message.type === 'remux/response' ||
      message.type === 'remux/error' ||
      message.type === 'remux/event' ||
      message.type === 'remux/status'
    ) {
      return message;
    }
  } catch {
    return null;
  }

  return null;
}

function postMessage(message: WebViewRequest) {
  const serialized = JSON.stringify(message);

  if (window.ReactNativeWebView) {
    window.ReactNativeWebView.postMessage(serialized);
    return;
  }

  window.parent?.postMessage(serialized, '*');
}

function isRequestId(id: JsonRpcId) {
  return typeof id === 'string' && id.startsWith(`${requestIdPrefix}:`);
}

function errorFromUnknown(error: unknown) {
  return error instanceof Error ? error : new Error(String(error));
}
