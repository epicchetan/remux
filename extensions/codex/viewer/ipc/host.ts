import type { JsonRpcMessage } from './rpcTypes';
import type { RemuxHostViewportMetrics } from './types';
import { requestIpc, subscribeIpcEvents } from './client';

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
  launch?: string | null;
  resourceId?: string | null;
  resourceKind?: string | null;
  status?: string | null;
  subtitle?: string | null;
  title?: string | null;
};

export type HostOverviewOpenParams = {
  section?: 'files' | 'tabs';
};

export type HostFileOpenParams = {
  line?: number | null;
  path: string;
};

export function dismissHostKeyboard() {
  return requestIpc('host/keyboard/dismiss', undefined, 1_000);
}

export function getHostViewportMetrics() {
  return requestIpc<RemuxHostViewportMetrics>('host/viewport/get', undefined, 1_000);
}

export function pickHostAttachments(params: HostAttachmentPickParams = {}) {
  return requestIpc<HostAttachmentPickResult>('host/attachments/pick', params, 120_000);
}

export function updateHostTab(params: HostTabUpdate) {
  return requestIpc<{ ok: boolean }>('host/tab/update', params, 1_000);
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
