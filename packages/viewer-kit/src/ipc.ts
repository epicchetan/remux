import {
  createAbortError,
  createSemanticRpcClient,
  type RpcContract,
  type RpcRequestOptions,
} from './rpc';
import { isTrustedHostMessageEvent } from './ipcSenderPolicy';

export type JsonRpcId = number | string;

export type JsonRpcMessage = {
  id?: JsonRpcId;
  jsonrpc?: '2.0';
  method?: string;
  params?: unknown;
  result?: unknown;
};

export class RemuxRpcError extends Error {
  readonly code: number | null;
  readonly data: unknown;

  constructor(error: { code?: number; data?: unknown; message: string }) {
    super(error.message);
    this.name = 'RemuxRpcError';
    this.code = typeof error.code === 'number' ? error.code : null;
    this.data = error.data;
  }
}

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
      contract: RpcContract;
      type: 'remux/request';
    }
  | {
      id: JsonRpcId;
      reason: string;
      type: 'remux/cancel';
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

export type RemuxHostLifecycleEvent = {
  epoch: number;
  inactiveForMs: number | null;
  reason: 'appState' | 'connect' | 'tabActive';
  state: 'active' | 'background' | 'inactive';
};

type WebViewLifecycle = {
  lifecycle: RemuxHostLifecycleEvent;
  type: 'remux/lifecycle';
};

type NativeMessage = WebViewEvent | WebViewLifecycle | WebViewResponse | WebViewStatus;

type PendingRequest = {
  abort: (() => void) | null;
  method: string;
  reject: (error: Error) => void;
  resolve: (value: unknown) => void;
};

type IpcEventSubscriber = (events: JsonRpcMessage[]) => void;
type IpcStatusSubscriber = (status: IpcStatusSnapshot) => void;
type IpcLifecycleSubscriber = (lifecycle: RemuxHostLifecycleEvent) => void;

export type IpcStatusSnapshot = {
  error: string | null;
  status: RemuxViewHostStatus;
};

const requestIdPrefix = 'remux-extension-viewer';
let initialized = false;
let protectedTransportRequired = false;
let legacyTransportEstablished = false;
let protectedTransportFailure: string | null = null;
const protectedTransportQueue: WebViewRequest[] = [];
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
const lifecycleSubscribers = new Set<IpcLifecycleSubscriber>();
let lifecycleSnapshot: RemuxHostLifecycleEvent = {
  epoch: 0,
  inactiveForMs: null,
  reason: 'connect',
  state: 'inactive',
};

declare global {
  interface Window {
    __REMUX_HOST_CAPABILITIES__?: {
      protectedHtmlPreviewTransport?: boolean;
    };
    __REMUX_PROTECTED_POST_MESSAGE__?: (message: string) => void;
    ReactNativeWebView?: {
      postMessage: (message: string) => void;
    };
  }
}

function requestIpc<T>(
  method: string,
  params: unknown,
  contract: RpcContract,
  options: RpcRequestOptions = {},
) {
  initializeIpc();

  const id = `${requestIdPrefix}:${nextId++}`;

  if (pendingRequests.size >= 64) {
    return Promise.reject<T>(new Error('Remux request admission is full'));
  }

  if (options.signal?.aborted) {
    return Promise.reject<T>(createAbortError(options.signal.reason));
  }

  return new Promise<T>((resolve, reject) => {
    const abort = options.signal
      ? () => {
        const pending = pendingRequests.get(id);
        if (!pending) {
          return;
        }
        pendingRequests.delete(id);
        pending.abort?.();
        postMessage({
          id,
          reason: abortReason(options.signal?.reason),
          type: 'remux/cancel',
        });
        reject(createAbortError(options.signal?.reason));
      }
      : null;

    pendingRequests.set(id, {
      abort: abort && options.signal
        ? () => options.signal?.removeEventListener('abort', abort)
        : null,
      method,
      reject,
      resolve: resolve as (value: unknown) => void,
    });
    options.signal?.addEventListener('abort', abort!, { once: true });

    try {
      postMessage(
        params === undefined
          ? { contract, id, method, type: 'remux/request' }
          : { contract, id, method, params, type: 'remux/request' },
      );
    } catch (error) {
      const pending = pendingRequests.get(id);
      pendingRequests.delete(id);
      pending?.abort?.();
      reject(errorFromUnknown(error));
    }
  });
}

export const rpc = createSemanticRpcClient(requestIpc);

function notifyIpc(method: string, params?: unknown) {
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

export type IpcResumeReason = 'app-active' | 'connected' | 'pageshow' | 'tab-active' | 'visible';

type IpcResumeSubscriber = (reason: IpcResumeReason) => void;

const resumeThrottleMs = 2_500;
const resumeSubscribers = new Set<IpcResumeSubscriber>();
let resumeLastDispatchedAt = 0;
let resumeTrailingTimer: number | null = null;
let resumeTrailingReason: IpcResumeReason | null = null;

function dispatchResume(reason: IpcResumeReason, immediate = false) {
  if (resumeSubscribers.size === 0) {
    return;
  }

  if (immediate) {
    if (resumeTrailingTimer !== null) {
      window.clearTimeout(resumeTrailingTimer);
      resumeTrailingTimer = null;
    }
    resumeTrailingReason = null;
    resumeLastDispatchedAt = Date.now();
    for (const subscriber of resumeSubscribers) {
      subscriber(reason);
    }
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
  eventSubscribers.add(subscriber);
  initializeIpc();
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

export function subscribeIpcLifecycle(subscriber: IpcLifecycleSubscriber) {
  initializeIpc();
  lifecycleSubscribers.add(subscriber);
  subscriber(lifecycleSnapshot);
  return () => {
    lifecycleSubscribers.delete(subscriber);
  };
}

export function getIpcLifecycleSnapshot() {
  return lifecycleSnapshot;
}

export function getIpcStatusSnapshot() {
  return statusSnapshot;
}

export type InitializeIpcOptions = Readonly<{
  requireProtectedTransport?: boolean;
}>;

export function initializeIpc(options: InitializeIpcOptions = {}) {
  if (options.requireProtectedTransport) {
    protectedTransportRequired = true;
  }
  if (initialized) {
    return;
  }

  window.addEventListener('message', handleNativeMessage);
  document.addEventListener('message', handleNativeMessage as EventListener);
  window.addEventListener('remux:host-capabilities-ready', flushProtectedTransportQueue);
  initialized = true;

  observePreviewMutations();
  observeResumeSignals();
  postMessage({ type: 'remux/ready' });
  if (
    protectedTransportRequired
    && !getIpcHostCapabilities().protectedHtmlPreviewTransport
  ) {
    // A harmless readiness probe lets an older host establish legacy Source /
    // Markdown transport. A protected host rejects it and waits for the wrapper.
    let attemptsRemaining = 200;
    const probe = () => {
      if (legacyTransportEstablished || getIpcHostCapabilities().protectedHtmlPreviewTransport) return;
      window.ReactNativeWebView?.postMessage(JSON.stringify({ type: 'remux/ready' }));
      attemptsRemaining -= 1;
      if (attemptsRemaining > 0) window.setTimeout(probe, 25);
      else {
        protectedTransportQueue.splice(0);
        protectedTransportFailure = 'The viewer host did not become ready. Reload the viewer to retry.';
        rejectPendingRequests(protectedTransportFailure);
      }
    };
    if (window.ReactNativeWebView || window.parent === window) probe();
  }
}

function handleNativeMessage(event: MessageEvent) {
  if (!isTrustedHostMessageEvent(event)) {
    return;
  }
  const message = parseNativeMessage(event.data);
  if (!message) {
    return;
  }
  if (
    protectedTransportRequired
    && (window.ReactNativeWebView || window.parent === window)
    && !getIpcHostCapabilities().protectedHtmlPreviewTransport
  ) {
    legacyTransportEstablished = true;
    flushProtectedTransportQueue();
  }

  if (message.type === 'remux/event') {
    enqueueEvent(message.message);
    return;
  }

  if (message.type === 'remux/lifecycle') {
    const previous = lifecycleSnapshot;
    const reportedInactiveForMs = message.lifecycle.inactiveForMs;
    lifecycleSnapshot = {
      ...message.lifecycle,
      inactiveForMs:
        typeof reportedInactiveForMs === 'number' &&
        Number.isFinite(reportedInactiveForMs) &&
        reportedInactiveForMs >= 0
          ? reportedInactiveForMs
          : null,
    };
    if (previous.epoch === lifecycleSnapshot.epoch && previous.state === lifecycleSnapshot.state) {
      return;
    }
    for (const subscriber of lifecycleSubscribers) {
      subscriber(lifecycleSnapshot);
    }
    if (message.lifecycle.state === 'active') {
      dispatchResume(message.lifecycle.reason === 'tabActive' ? 'tab-active' : 'app-active', true);
    }
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

  pendingRequests.delete(message.id);
  pending.abort?.();

  if (message.type === 'remux/error') {
    pending.reject(new RemuxRpcError(message.error));
    return;
  }

  pending.resolve(message.result);
}

export type RemuxHostCapabilities = Readonly<{
  protectedHtmlPreviewTransport: boolean;
}>;

export function getIpcHostCapabilities(): RemuxHostCapabilities {
  return {
    protectedHtmlPreviewTransport:
      window.__REMUX_HOST_CAPABILITIES__?.protectedHtmlPreviewTransport === true,
  };
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
    dispatchResume('connected', true);
  }
}

function rejectPendingRequests(reason: string) {
  for (const [id, pending] of pendingRequests) {
    pending.abort?.();
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
      message.type === 'remux/lifecycle' ||
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
  if (
    protectedTransportRequired
    && !legacyTransportEstablished
    && (window.ReactNativeWebView || window.parent === window)
    && !getIpcHostCapabilities().protectedHtmlPreviewTransport
  ) {
    if (protectedTransportFailure) throw new Error(protectedTransportFailure);
    if (protectedTransportQueue.length >= 64) {
      throw new Error('Protected Remux transport is not ready');
    }
    protectedTransportQueue.push(message);
    return;
  }
  const serialized = JSON.stringify(message);

  if (window.__REMUX_PROTECTED_POST_MESSAGE__) {
    window.__REMUX_PROTECTED_POST_MESSAGE__(serialized);
    return;
  }
  if (window.ReactNativeWebView) {
    window.ReactNativeWebView.postMessage(serialized);
    return;
  }

  window.parent?.postMessage(serialized, '*');
}

function flushProtectedTransportQueue() {
  if (!legacyTransportEstablished && !getIpcHostCapabilities().protectedHtmlPreviewTransport) return;
  protectedTransportFailure = null;
  const queued = protectedTransportQueue.splice(0);
  for (const message of queued) {
    if (message.type === 'remux/request' && !pendingRequests.has(message.id)) continue;
    postMessage(message);
  }
}

function abortReason(reason: unknown) {
  return typeof reason === 'string' && reason.length > 0 ? reason : 'caller-aborted';
}

function isRequestId(id: JsonRpcId) {
  return typeof id === 'string' && id.startsWith(`${requestIdPrefix}:`);
}

function errorFromUnknown(error: unknown) {
  return error instanceof Error ? error : new Error(String(error));
}
