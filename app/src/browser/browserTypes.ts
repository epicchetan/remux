export type BrowserMode = 'overview' | 'surface';
export type BrowserSection = 'files' | 'settings' | 'tabs';

export type BrowserPendingNavigation = {
  focusId: string | null;
  focusKind: string | null;
  nonce: string;
  resourceId: string | null;
  resourceKind: string | null;
};

export type ViewerTab = {
  createdAt: number;
  extensionId: string;
  handlerId: string | null;
  hostId: string | null;
  id: string;
  iconUrl: string | null;
  kind: 'viewer';
  launch: string | null;
  lastActiveAt: number;
  pendingNavigation: BrowserPendingNavigation | null;
  previewFileName: string | null;
  previewUri: string | null;
  reloadNonce: number;
  resourceId: string | null;
  resourceKind: string | null;
  status: string | null;
  title: string;
  url: string;
  viewId: string;
};

export type BrowserTab = ViewerTab;

export type BrowserResourceOrigin = {
  resourceKey: string | null;
  tabId: string | null;
};

export type BrowserResourceTarget = {
  extensionId: string;
  focusId?: string | null;
  focusKind?: string | null;
  handlerId?: string | null;
  launch?: string | null;
  origin?: BrowserResourceOrigin | null;
  resourceId?: string | null;
  resourceKind?: string | null;
  status?: string | null;
  title?: string | null;
  viewId?: string | null;
};
