import {
  getIpcLifecycleSnapshot,
  getIpcStatusSnapshot,
  rpc,
  signalIpcPreviewChanged,
  subscribeIpcEvents,
  subscribeIpcLifecycle,
  subscribeIpcResume,
  subscribeIpcStatus,
  type IpcResumeReason,
  type IpcStatusSnapshot,
  type JsonRpcMessage,
  type RemuxHostLifecycleEvent,
  type RemuxViewHostStatus,
} from './ipc';

export type HostOverviewOpenParams = {
  section?: 'files' | 'tabs';
};

export type HostFileOpenParams = {
  line?: number | null;
  path: string;
};

export type HostLinkOpenParams = {
  url: string;
};

export type HostAttachmentPickParams = {
  multiple?: boolean;
  picker?: 'files' | 'photo-library';
  type?: 'any' | 'image';
};

export type HostAttachmentPickResult = {
  assets: Array<{
    dataUrl: string;
    mimeType: string;
    name: string;
    sizeBytes: number;
  }>;
  canceled: boolean;
};

export type HostTabUpdate = {
  handlerId?: string | null;
  launch?: string | null;
  resourceId?: string | null;
  resourceKind?: string | null;
  status?: string | null;
  title?: string | null;
};

export type RemuxHostViewportMetrics = {
  keyboardHeight: number;
  keyboardVisible: boolean;
  visibleBottom: number;
  visibleTop: number;
  viewportHeight: number;
  viewportWidth: number;
};

export type RemuxHostConnectionStatus = 'connected' | 'connecting' | 'reconnecting' | 'disconnected';
export type RemuxHostTheme = 'light' | 'dark';
export type RemuxHostNavigation = {
  focusId: string | null;
  focusKind: string | null;
  nonce: string;
  resourceId: string | null;
  resourceKind: string | null;
};
export type {
  IpcStatusSnapshot as RemuxHostStatusSnapshot,
  RemuxViewHostStatus,
};

export function dismissHostKeyboard() {
  return rpc.command('host/keyboard/dismiss');
}

// DOM mutations signal automatically (see viewer-kit ipc); views that render
// to canvas call this from their own render hook instead.
export function signalHostPreviewChanged() {
  signalIpcPreviewChanged();
}

export function readHostClipboardText() {
  return rpc.query<{ text: string }>('host/clipboard/read');
}

export function getHostViewportMetrics() {
  return rpc.query<RemuxHostViewportMetrics>('host/viewport/get');
}

export function getHostStatusSnapshot() {
  return getIpcStatusSnapshot();
}

export function getHostTheme(): RemuxHostTheme {
  if (typeof document === 'undefined') {
    return 'dark';
  }

  return parseHostTheme(document.documentElement.dataset.remuxTheme);
}

export function openHostOverview(params: HostOverviewOpenParams = {}) {
  return rpc.command<{ ok: boolean }>('host/overview/open', params);
}

export function openHostFile(params: HostFileOpenParams) {
  return rpc.command<{ ok: boolean; reason?: string }>('host/file/open', params);
}

// Opens a url in the device's default browser. In-page escapes like
// window.open are swallowed by the app's WebView, so this is the host's job
// (e.g. Linking.openURL on React Native).
export function openHostLink(params: HostLinkOpenParams) {
  return rpc.command<{ ok: boolean; reason?: string }>('host/link/open', params);
}

export function pickHostAttachments(params: HostAttachmentPickParams = {}) {
  return rpc.command<HostAttachmentPickResult>('host/attachments/pick', params);
}

export function reloadHostView() {
  return rpc.command<{ ok: boolean }>('host/view/reload');
}

export function closeHostTab() {
  return rpc.command<{ ok: boolean }>('host/tab/close');
}

export function updateHostTab(params: HostTabUpdate) {
  return rpc.command<{ ok: boolean }>('host/tab/update', params);
}

export function subscribeHostViewportMetrics(subscriber: (metrics: RemuxHostViewportMetrics) => void) {
  return subscribeIpcEvents((events) => {
    for (const event of events) {
      if (event.method === 'host/viewport/changed') {
        subscriber(paramsOf<RemuxHostViewportMetrics>(event));
      }
    }
  });
}

export function subscribeHostStatus(subscriber: (status: IpcStatusSnapshot) => void) {
  return subscribeIpcStatus(subscriber);
}

export function subscribeHostConnection(
  subscriber: (status: RemuxHostConnectionStatus, generation: number | null) => void,
) {
  return subscribeIpcEvents((events) => {
    for (const event of events) {
      if (event.method !== 'host/connection') {
        continue;
      }

      const params = paramsOf<{ generation?: unknown; status?: unknown }>(event);
      const status = params.status;
      if (
        status === 'connected' ||
        status === 'connecting' ||
        status === 'reconnecting' ||
        status === 'disconnected'
      ) {
        subscriber(status, typeof params.generation === 'number' ? params.generation : null);
      }
    }
  });
}

export type RemuxHostResumeReason = IpcResumeReason;
export type { RemuxHostLifecycleEvent };

export function getHostLifecycleSnapshot() {
  return getIpcLifecycleSnapshot();
}

export function subscribeHostLifecycle(
  subscriber: (lifecycle: RemuxHostLifecycleEvent) => void,
) {
  return subscribeIpcLifecycle(subscriber);
}

// The view may have missed events while iOS had the webview suspended or the
// host's socket was down — neither is replayed. Fires (coalesced) when the
// page becomes visible again, is restored, or the socket (re)connects, so
// views that stream state can re-verify against the server. Views that
// re-read full state on invalidation generally don't need this.
export function subscribeHostResume(subscriber: (reason: RemuxHostResumeReason) => void) {
  return subscribeIpcResume(subscriber);
}

export function subscribeHostActive(subscriber: (active: boolean) => void) {
  return subscribeIpcEvents((events) => {
    for (const event of events) {
      if (event.method === 'host/active') {
        subscriber(paramsOf<{ active?: unknown }>(event).active === true);
      }
    }
  });
}

export function subscribeHostTheme(subscriber: (theme: RemuxHostTheme) => void) {
  return subscribeIpcEvents((events) => {
    for (const event of events) {
      if (event.method === 'host/theme') {
        subscriber(parseHostTheme(paramsOf<{ theme?: unknown }>(event).theme));
      }
    }
  });
}

export function subscribeHostNavigate(subscriber: (navigation: RemuxHostNavigation) => void) {
  return subscribeIpcEvents((events) => {
    for (const event of events) {
      if (event.method !== 'host/navigate') {
        continue;
      }

      const navigation = parseHostNavigation(event.params);
      if (navigation) {
        subscriber(navigation);
      }
    }
  });
}

function paramsOf<T>(message: JsonRpcMessage): T {
  return ('params' in message ? message.params : {}) as T;
}

function parseHostTheme(value: unknown): RemuxHostTheme {
  return value === 'light' ? 'light' : 'dark';
}

function parseHostNavigation(value: unknown): RemuxHostNavigation | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const params = value as Record<string, unknown>;
  if (typeof params.nonce !== 'string') {
    return null;
  }

  return {
    focusId: optionalString(params.focusId),
    focusKind: optionalString(params.focusKind),
    nonce: params.nonce,
    resourceId: optionalString(params.resourceId),
    resourceKind: optionalString(params.resourceKind),
  };
}

function optionalString(value: unknown) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}
