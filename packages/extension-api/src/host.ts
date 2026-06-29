import { requestIpc, subscribeIpcEvents, type JsonRpcMessage } from './ipc';

export type HostOverviewOpenParams = {
  section?: 'files' | 'tabs';
};

export type HostFileOpenParams = {
  line?: number | null;
  path: string;
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

export function dismissHostKeyboard() {
  return requestIpc('host/keyboard/dismiss', undefined, 1_000);
}

export function readHostClipboardText() {
  return requestIpc<{ text: string }>('host/clipboard/read', undefined, 3_000);
}

export function getHostViewportMetrics() {
  return requestIpc<RemuxHostViewportMetrics>('host/viewport/get', undefined, 1_000);
}

export function openHostOverview(params: HostOverviewOpenParams = {}) {
  return requestIpc<{ ok: boolean }>('host/overview/open', params, 3_000);
}

export function openHostFile(params: HostFileOpenParams) {
  return requestIpc<{ ok: boolean; reason?: string }>('host/file/open', params, 3_000);
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

function paramsOf<T>(message: JsonRpcMessage): T {
  return ('params' in message ? message.params : {}) as T;
}
