import {
  isRegisteredRpcRequestMethod,
  type RpcRequestPolicy,
} from './rpcPolicy';

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
      policy: string;
      timeoutMs: number;
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
  | { cwd: string | null; generation: number; type: 'connected' }
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
  method: string;
  policyName: string;
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

export class IpcRequestTimeoutError extends Error {
  constructor(
    readonly method: string,
    readonly policyName: string,
    readonly timeoutMs: number,
  ) {
    super(`${method} timed out after ${timeoutMs}ms (${policyName})`);
    this.name = 'IpcRequestTimeoutError';
  }
}

export function requestIpc<T>(policy: RpcRequestPolicy, params?: unknown) {
  initializeIpc();

  const id = `${requestIdPrefix}:${nextId++}`;
  const { method } = policy;
  const timeoutMs = policy.budget.totalMs;

  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      pendingRequests.delete(id);
      reject(new IpcRequestTimeoutError(method, policy.name, timeoutMs));
    }, timeoutMs);

    pendingRequests.set(id, {
      method,
      policyName: policy.name,
      reject,
      resolve: resolve as (value: unknown) => void,
      timer,
    });

    try {
      postMessage(
        params === undefined
          ? { id, method, policy: policy.name, timeoutMs, type: 'remux/request' }
          : { id, method, params, policy: policy.name, timeoutMs, type: 'remux/request' },
      );
    } catch (error) {
      window.clearTimeout(timer);
      pendingRequests.delete(id);
      reject(errorFromUnknown(error));
    }
  });
}

export function notifyIpc(method: string, params?: unknown) {
  if (isRegisteredRpcRequestMethod(method)) {
    throw new Error(`${method} requires an acknowledged request policy`);
  }
  initializeIpc();
  postMessage(
    params === undefined
      ? { method, type: 'remux/notify' }
      : { method, params, type: 'remux/notify' },
  );
}

// Tells the host this view's rendered content changed so it can refresh the
// tab's preview snapshot. Throttled, and aligned to the frame after paint so
// the host photographs settled pixels — never a mid-render state.
export function signalIpcPreviewChanged() {
  if (previewSignalTimer !== null) {
    return;
  }

  previewSignalTimer = window.setTimeout(() => {
    previewSignalTimer = null;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        notifyIpc('host/preview/invalidate');
      });
    });
  }, previewSignalThrottleMs);
}

const previewSignalThrottleMs = 300;
let previewSignalTimer: number | null = null;

// DOM-rendered views get preview signals for free; canvas-rendered content
// (e.g. xterm) is invisible to mutation observers and must call
// signalIpcPreviewChanged from its own render hook.
function observePreviewMutations() {
  if (typeof MutationObserver === 'undefined' || !document.documentElement) {
    return;
  }

  const observer = new MutationObserver(() => {
    signalIpcPreviewChanged();
  });
  observer.observe(document.documentElement, {
    attributes: true,
    characterData: true,
    childList: true,
    subtree: true,
  });
}

// Fires when this view has plausibly missed events: the webview became
// visible again after a suspension, the page was restored, or the host's
// socket (re)connected. A suspended webview receives nothing and there is no
// replay, so views that stream state (rather than re-reading it) must treat
// resume as "verify against the server". Bursts coalesce: a leading fire,
// then at most one trailing fire per throttle window.
export function subscribeIpcResume(subscriber: IpcResumeSubscriber) {
  initializeIpc();
  resumeSubscribers.add(subscriber);
  return () => {
    resumeSubscribers.delete(subscriber);
  };
}

export type IpcResumeReason = 'connected' | 'pageshow' | 'visible';

type IpcResumeSubscriber = (reason: IpcResumeReason) => void;

const resumeThrottleMs = 2_500;
const resumeSubscribers = new Set<IpcResumeSubscriber>();
let resumeLastDispatchedAt = 0;
let resumeTrailingTimer: number | null = null;
let resumeTrailingReason: IpcResumeReason | null = null;

function dispatchResume(reason: IpcResumeReason) {
  if (resumeSubscribers.size === 0) {
    return;
  }

  const elapsed = Date.now() - resumeLastDispatchedAt;
  if (elapsed < resumeThrottleMs) {
    resumeTrailingReason = reason;
    if (resumeTrailingTimer === null) {
      resumeTrailingTimer = window.setTimeout(() => {
        resumeTrailingTimer = null;
        const trailing = resumeTrailingReason;
        resumeTrailingReason = null;
        if (trailing !== null) {
          dispatchResume(trailing);
        }
      }, resumeThrottleMs - elapsed);
    }
    return;
  }

  resumeLastDispatchedAt = Date.now();
  for (const subscriber of resumeSubscribers) {
    subscriber(reason);
  }
}

function observeResumeSignals() {
  if (typeof document === 'undefined') {
    return;
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      dispatchResume('visible');
    }
  });
  window.addEventListener('pageshow', () => {
    dispatchResume('pageshow');
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

  observePreviewMutations();
  observeResumeSignals();
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
    // A request may have timed out locally or belonged to a prior WebView
    // epoch. Late results are method-local evidence, never bridge health.
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
  const wasConnected = statusSnapshot.status.type === 'connected';
  statusSnapshot = snapshot;
  for (const subscriber of statusSubscribers) {
    subscriber(statusSnapshot);
  }

  // Dispatched after the status subscribers so a resume handler that reads
  // the snapshot sees the connected state it is reacting to.
  if (!wasConnected && snapshot.status.type === 'connected') {
    dispatchResume('connected');
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
