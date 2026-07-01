import {
  getIpcStatusSnapshot,
  requestIpc,
  subscribeIpcEvents,
  subscribeIpcStatus,
  type IpcStatusSnapshot,
  type JsonRpcMessage,
  type RemuxViewHostStatus,
} from './ipc';

export type HostOverviewOpenParams = {
  section?: 'files' | 'tabs';
};

export type HostFileOpenParams = {
  line?: number | null;
  path: string;
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
  return requestIpc('host/keyboard/dismiss', undefined, 1_000);
}

export function readHostClipboardText() {
  return requestIpc<{ text: string }>('host/clipboard/read', undefined, 3_000);
}

export function getHostViewportMetrics() {
  return requestIpc<RemuxHostViewportMetrics>('host/viewport/get', undefined, 1_000);
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
  return requestIpc<{ ok: boolean }>('host/overview/open', params, 3_000);
}

export function openHostFile(params: HostFileOpenParams) {
  return requestIpc<{ ok: boolean; reason?: string }>('host/file/open', params, 3_000);
}

export function pickHostAttachments(params: HostAttachmentPickParams = {}) {
  return requestIpc<HostAttachmentPickResult>('host/attachments/pick', params, 120_000);
}

export function reloadHostView() {
  return requestIpc<{ ok: boolean }>('host/view/reload', undefined, 1_000);
}

export function updateHostTab(params: HostTabUpdate) {
  return requestIpc<{ ok: boolean }>('host/tab/update', params, 1_000);
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

export function subscribeHostConnection(subscriber: (status: RemuxHostConnectionStatus) => void) {
  return subscribeIpcEvents((events) => {
    for (const event of events) {
      if (event.method !== 'host/connection') {
        continue;
      }

      const status = paramsOf<{ status?: unknown }>(event).status;
      if (
        status === 'connected' ||
        status === 'connecting' ||
        status === 'reconnecting' ||
        status === 'disconnected'
      ) {
        subscriber(status);
      }
    }
  });
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
