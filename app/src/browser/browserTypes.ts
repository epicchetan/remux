export type BrowserMode = 'overview' | 'surface';
export type BrowserSection = 'files' | 'settings' | 'tabs';

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
  previewFileName: string | null;
  previewUri: string | null;
  reloadNonce: number;
  resourceId: string | null;
  resourceKind: string | null;
  status: string | null;
  subtitle: string | null;
  title: string;
  url: string;
  viewId: string;
};

export type BrowserTab = ViewerTab;

export type BrowserTabTarget = {
  extensionId: string;
  handlerId?: string | null;
  launch?: string | null;
  resourceId?: string | null;
  resourceKind?: string | null;
  status?: string | null;
  subtitle?: string | null;
  title?: string | null;
  viewId?: string | null;
};
