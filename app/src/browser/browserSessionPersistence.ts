import AsyncStorage from '@react-native-async-storage/async-storage';

import type { BrowserSection } from './browserTypes';

const browserSessionVersion = 1;
const browserSessionKey = 'remux.browser.session.v1';

export type PersistedBrowserSession = {
  activeTabId: string | null;
  section: BrowserSection;
  tabs: PersistedViewerTab[];
  version: typeof browserSessionVersion;
};

export type PersistedViewerTab = {
  createdAt: number;
  extensionId: string;
  handlerId: string | null;
  hostId: string | null;
  id: string;
  launch: string | null;
  lastActiveAt: number;
  previewFileName: string | null;
  resourceId: string | null;
  resourceKind: string | null;
  status: string | null;
  subtitle: string | null;
  title: string;
  viewId: string;
};

export async function readBrowserSession(): Promise<PersistedBrowserSession | null> {
  const text = await AsyncStorage.getItem(browserSessionKey);
  if (!text) {
    return null;
  }

  return parseBrowserSession(text);
}

export async function writeBrowserSession(session: PersistedBrowserSession) {
  await AsyncStorage.setItem(browserSessionKey, JSON.stringify(session));
}

export function browserSessionSnapshot({
  activeTabId,
  section,
  tabs,
}: {
  activeTabId: string | null;
  section: BrowserSection;
  tabs: Array<PersistedViewerTab & { kind?: string; previewUri?: string | null; url?: string }>;
}): PersistedBrowserSession {
  return {
    activeTabId,
    section,
    tabs: tabs.map((tab) => ({
      createdAt: tab.createdAt,
      extensionId: tab.extensionId,
      handlerId: tab.handlerId,
      hostId: tab.hostId,
      id: tab.id,
      launch: tab.launch,
      lastActiveAt: tab.lastActiveAt,
      previewFileName: tab.previewFileName,
      resourceId: tab.resourceId,
      resourceKind: tab.resourceKind,
      status: tab.status,
      subtitle: tab.subtitle,
      title: tab.title,
      viewId: tab.viewId,
    })),
    version: browserSessionVersion,
  };
}

function parseBrowserSession(text: string): PersistedBrowserSession | null {
  try {
    const value: unknown = JSON.parse(text);
    if (!isRecord(value) || value.version !== browserSessionVersion || !Array.isArray(value.tabs)) {
      return null;
    }

    const activeTabId = typeof value.activeTabId === 'string' ? value.activeTabId : null;
    const section = parseSection(value.section);
    const tabs = value.tabs.map(parseViewerTab).filter((tab): tab is PersistedViewerTab => Boolean(tab));

    return {
      activeTabId,
      section,
      tabs,
      version: browserSessionVersion,
    };
  } catch {
    return null;
  }
}

function parseViewerTab(value: unknown): PersistedViewerTab | null {
  if (!isRecord(value)) {
    return null;
  }

  const createdAt = numberOrNow(value.createdAt);
  const extensionId = stringOrNull(value.extensionId);
  const id = stringOrNull(value.id);
  const lastActiveAt = numberOrNow(value.lastActiveAt);
  const title = stringOrNull(value.title);
  const viewId = stringOrNull(value.viewId) ?? 'main';

  if (!extensionId || !id || !title) {
    return null;
  }

  return {
    createdAt,
    extensionId,
    handlerId: stringOrNull(value.handlerId),
    hostId: stringOrNull(value.hostId),
    id,
    launch: stringOrNull(value.launch),
    lastActiveAt,
    previewFileName: stringOrNull(value.previewFileName),
    resourceId: stringOrNull(value.resourceId),
    resourceKind: stringOrNull(value.resourceKind),
    status: stringOrNull(value.status),
    subtitle: stringOrNull(value.subtitle),
    title,
    viewId,
  };
}

function numberOrNow(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : Date.now();
}

function stringOrNull(value: unknown) {
  return typeof value === 'string' ? value : null;
}

function parseSection(value: unknown): BrowserSection {
  switch (value) {
    case 'files':
    case 'settings':
    case 'tabs':
      return value;
    default:
      return 'tabs';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
