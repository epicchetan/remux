import { create } from 'zustand';

import {
  fetchRemuxExtensionCatalog,
  type RemuxExtension,
} from '../remote/remuxExtensions';
import { currentRemuxOrigin } from '../remote/remuxSettingsStore';
import {
  deleteTabPreview,
  persistTabPreview,
  resolveTabPreview,
} from './browserPreviewStorage';
import {
  browserSessionSnapshot,
  readBrowserSession,
  writeBrowserSession,
  type PersistedBrowserSession,
  type PersistedViewerTab,
} from './browserSessionPersistence';
import type { BrowserMode, BrowserSection, BrowserTab, BrowserTabTarget, ViewerTab } from './browserTypes';

type BrowserCatalogStatus = 'error' | 'idle' | 'loading' | 'ready';

type BrowserStore = {
  activeTabId: string | null;
  catalogError: string | null;
  catalogOrigin: string | null;
  catalogStatus: BrowserCatalogStatus;
  closeOverview: () => void;
  closeTab: (tabId: string) => void;
  defaultExtensionId: string | null;
  extensions: RemuxExtension[];
  loadExtensions: (options?: { force?: boolean }) => Promise<void>;
  mode: BrowserMode;
  openExtensionTab: (extensionId: string, options?: BrowserOpenExtensionTabOptions) => void;
  openNotificationTarget: (target: BrowserTabTarget) => Promise<BrowserOpenNotificationTargetResult>;
  openOverview: (section?: BrowserSection) => void;
  reloadExtensionTabs: (extensionId: string) => void;
  section: BrowserSection;
  selectTab: (tabId: string) => void;
  setSection: (section: BrowserSection) => void;
  setTabPreview: (tabId: string, previewUri: string) => Promise<void>;
  tabs: BrowserTab[];
  updateTab: (tabId: string, patch: BrowserTabUpdate) => void;
};

export type BrowserOpenExtensionTabOptions = {
  handlerId?: string | null;
  resourceId?: string | null;
  resourceKind?: string | null;
  launch?: string | null;
  title?: string | null;
  viewId?: string | null;
};

export type BrowserOpenNotificationTargetResult =
  | { tabId: string; type: 'created' | 'selected' }
  | { reason: 'extension-not-found' | 'invalid-target'; type: 'ignored' };

let extensionLoadPromise: Promise<void> | null = null;
let extensionLoadOrigin: string | null = null;
let tabSequence = 0;
let sessionLoadPromise: Promise<PersistedBrowserSession | null> | null = null;

type BrowserTabUpdate = {
  handlerId?: string | null;
  launch?: string | null;
  resourceId?: string | null;
  resourceKind?: string | null;
  title?: string | null;
};

export const useBrowserStore = create<BrowserStore>((set, get) => ({
  activeTabId: null,
  catalogError: null,
  catalogOrigin: null,
  catalogStatus: 'idle',
  closeOverview: () => {
    set((state) => ({ mode: state.activeTabId ? 'surface' : 'overview' }));
    persistCurrentBrowserSession(get());
  },
  closeTab: (tabId) => {
    const closedTab = get().tabs.find((tab) => tab.id === tabId);
    set((state) => {
      const tabs = state.tabs.filter((tab) => tab.id !== tabId);
      const activeTabId = state.activeTabId === tabId
        ? nextActiveTabId(tabs)
        : state.activeTabId;

      return {
        activeTabId,
        mode: activeTabId ? state.mode : 'overview',
        tabs,
      };
    });
    persistCurrentBrowserSession(get());
    void deleteTabPreview(closedTab?.previewFileName).catch(() => undefined);
  },
  defaultExtensionId: null,
  extensions: [],
  loadExtensions: (options = {}) => {
    const origin = currentRemuxOrigin();
    if (extensionLoadPromise && extensionLoadOrigin === origin) {
      return extensionLoadPromise;
    }

    const currentStatus = get().catalogStatus;
    if (!options.force && currentStatus === 'ready' && get().catalogOrigin === origin) {
      return Promise.resolve();
    }

    set({ catalogError: null, catalogStatus: 'loading' });
    extensionLoadOrigin = origin;
    extensionLoadPromise = fetchRemuxExtensionCatalog(origin)
      .then(async (catalog) => {
        const persistedSession = await loadPersistedBrowserSession();
        set((state) => {
          const restoredSession =
            state.tabs.length === 0 && persistedSession
              ? restoreBrowserSession(persistedSession, catalog.extensions)
              : null;
          const tabs = restoredSession?.tabs ?? rebuildBrowserTabs(state.tabs, catalog.extensions);
          const activeTab = state.activeTabId
            ? tabs.find((tab) => tab.id === state.activeTabId)
            : null;
          const activeTabId = restoredSession
            ? restoredSession.activeTabId
            : activeTab?.id ?? nextActiveTabId(tabs);

          return {
            activeTabId,
            catalogError: null,
            catalogOrigin: origin,
            catalogStatus: 'ready',
            defaultExtensionId: catalog.defaultExtensionId,
            extensions: catalog.extensions,
            mode: restoredSession ? 'overview' : activeTabId ? state.mode : 'overview',
            section: restoredSession?.section ?? state.section,
            tabs,
          };
        });
        persistCurrentBrowserSession(get());
      })
      .catch((error: unknown) => {
        set({
          catalogError: error instanceof Error ? error.message : String(error),
          catalogStatus: 'error',
          defaultExtensionId: null,
          extensions: [],
        });
      })
      .finally(() => {
        extensionLoadPromise = null;
        extensionLoadOrigin = null;
      });

    return extensionLoadPromise;
  },
  mode: 'overview',
  openExtensionTab: (extensionId, options = {}) => {
    set((state) => {
      const extension = state.extensions.find((candidate) => candidate.id === extensionId);
      if (!extension) {
        return {};
      }

      const tab = createViewerTab(extension, options);
      return {
        activeTabId: tab.id,
        mode: 'surface',
        tabs: [...state.tabs, tab],
      };
    });
    persistCurrentBrowserSession(get());
  },
  openNotificationTarget: async (target) => {
    const extensionId = target.extensionId.trim();
    if (!extensionId) {
      return { reason: 'invalid-target', type: 'ignored' };
    }

    const state = get();
    if (state.catalogStatus !== 'ready') {
      await state.loadExtensions();
    }

    let result: BrowserOpenNotificationTargetResult = {
      reason: 'extension-not-found',
      type: 'ignored',
    };

    set((currentState) => {
      const extension = currentState.extensions.find((candidate) => candidate.id === extensionId);
      if (!extension) {
        return {};
      }

      const options = normalizeBrowserTabTarget(target, extension);
      const existingTab = currentState.tabs.find((tab) => matchesBrowserTabTarget(tab, extensionId, options));
      const now = Date.now();

      if (existingTab) {
        result = { tabId: existingTab.id, type: 'selected' };
        return {
          activeTabId: existingTab.id,
          mode: 'surface',
          tabs: currentState.tabs.map((tab) => (
            tab.id === existingTab.id
              ? { ...tab, lastActiveAt: now }
              : tab
          )),
        };
      }

      const tab = createViewerTab(extension, options);
      result = { tabId: tab.id, type: 'created' };
      return {
        activeTabId: tab.id,
        mode: 'surface',
        tabs: [...currentState.tabs, tab],
      };
    });

    persistCurrentBrowserSession(get());
    return result;
  },
  openOverview: (section) => {
    set((state) => ({
      mode: 'overview',
      section: section ?? state.section,
    }));
    persistCurrentBrowserSession(get());
  },
  reloadExtensionTabs: (extensionId) => {
    set((state) => ({
      tabs: state.tabs.map((tab) => (
        tab.extensionId === extensionId
          ? {
              ...tab,
              reloadNonce: tab.reloadNonce + 1,
            }
          : tab
      )),
    }));
  },
  section: 'tabs',
  selectTab: (tabId) => {
    set((state) => ({
      activeTabId: tabId,
      mode: 'surface',
      tabs: state.tabs.map((tab) => (
        tab.id === tabId
          ? {
              ...tab,
              lastActiveAt: Date.now(),
            }
          : tab
      )),
    }));
    persistCurrentBrowserSession(get());
  },
  setSection: (section) => {
    set({ section });
    persistCurrentBrowserSession(get());
  },
  setTabPreview: async (tabId, previewUri) => {
    const preview = await persistTabPreview(tabId, previewUri);
    if (!preview) {
      return;
    }

    const tabStillExists = get().tabs.some((tab) => tab.id === tabId);
    if (!tabStillExists) {
      await deleteTabPreview(preview.previewFileName);
      return;
    }

    set((state) => ({
      tabs: state.tabs.map((tab) => (
        tab.id === tabId
          ? {
              ...tab,
              previewFileName: preview.previewFileName,
              previewUri: preview.previewUri,
            }
          : tab
      )),
    }));
    persistCurrentBrowserSession(get());
  },
  tabs: [],
  updateTab: (tabId, patch) => {
    set((state) => ({
      tabs: state.tabs.map((tab) => {
        if (tab.id !== tabId) {
          return tab;
        }

        const nextTab = {
          ...tab,
          launch: patch.launch === undefined
            ? (patch.resourceKind === 'thread' ? null : tab.launch)
            : patch.launch,
          handlerId: patch.handlerId === undefined ? tab.handlerId : patch.handlerId,
          resourceId: patch.resourceId === undefined ? tab.resourceId : patch.resourceId,
          resourceKind: patch.resourceKind === undefined ? tab.resourceKind : patch.resourceKind,
          title: patch.title?.trim() || tab.title,
        };

        return {
          ...nextTab,
          url: withViewerTabParams(tab.url, nextTab),
        };
      }),
    }));
    persistCurrentBrowserSession(get());
  },
}));

export function matchesBrowserTabTarget(
  tab: ViewerTab,
  extensionId: string,
  target: BrowserOpenExtensionTabOptions,
) {
  const viewId = target.viewId?.trim() || 'main';
  if (tab.extensionId !== extensionId || tab.viewId !== viewId) {
    return false;
  }

  return nullableStringMatches(tab.handlerId, target.handlerId) &&
    nullableStringMatches(tab.launch, target.launch) &&
    nullableStringMatches(tab.resourceKind, target.resourceKind) &&
    nullableStringMatches(tab.resourceId, target.resourceId);
}

function normalizeBrowserTabTarget(
  target: BrowserTabTarget,
  extension: RemuxExtension,
): BrowserOpenExtensionTabOptions {
  const viewId = target.viewId?.trim() || 'main';

  return {
    handlerId: target.handlerId?.trim() || null,
    launch: target.launch?.trim() || null,
    resourceId: target.resourceId?.trim() || null,
    resourceKind: target.resourceKind?.trim() || null,
    title: target.title?.trim() || extension.display.title,
    viewId: extension.views[viewId] ? viewId : 'main',
  };
}

function nullableStringMatches(actual: string | null, expected: string | null | undefined) {
  return (expected?.trim() || null) === actual;
}

function nextActiveTabId(tabs: BrowserTab[]) {
  return [...tabs].sort((first, second) => second.lastActiveAt - first.lastActiveAt)[0]?.id ?? null;
}

function createViewerTab(extension: RemuxExtension, options: BrowserOpenExtensionTabOptions = {}): ViewerTab {
  const createdAt = Date.now();
  const sequence = nextTabSequence();
  const launch = options.launch?.trim() || null;
  const handlerId = options.handlerId?.trim() || null;
  const resourceKind = options.resourceKind?.trim() || null;
  const viewId = options.viewId?.trim() || 'main';
  const view = extension.views[viewId] ?? extension.views.main;
  const resourceId = options.resourceId?.trim() || defaultResourceId({
    createdAt,
    extensionId: extension.id,
    launch,
    resourceKind,
    sequence,
  });
  const id = `${extension.id}-${createdAt}-${sequence}`;

  const tab: Omit<ViewerTab, 'url'> = {
    createdAt,
    extensionId: extension.id,
    handlerId,
    hostId: null,
    id,
    iconUrl: extension.display.iconUrl,
    kind: 'viewer',
    launch,
    lastActiveAt: createdAt,
    previewFileName: null,
    previewUri: null,
    reloadNonce: 0,
    resourceId,
    resourceKind,
    title: options.title?.trim() || extension.display.title,
    viewId: extension.views[viewId] ? viewId : 'main',
  };

  return {
    ...tab,
    url: withViewerTabParams(view.url, tab),
  };
}

function createRestoredViewerTab(
  tab: PersistedViewerTab & { reloadNonce?: number },
  extension: RemuxExtension,
): ViewerTab {
  const preview = resolveTabPreview(tab.previewFileName);
  const view = extension.views[tab.viewId] ?? extension.views.main;
  const restored: Omit<ViewerTab, 'url'> = {
    createdAt: tab.createdAt,
    extensionId: extension.id,
    handlerId: tab.handlerId,
    hostId: tab.hostId,
    id: tab.id,
    iconUrl: extension.display.iconUrl,
    kind: 'viewer',
    launch: tab.launch,
    lastActiveAt: tab.lastActiveAt,
    previewFileName: preview?.previewFileName ?? null,
    previewUri: preview?.previewUri ?? null,
    reloadNonce: tab.reloadNonce ?? 0,
    resourceId: tab.resourceId,
    resourceKind: tab.resourceKind,
    title: tab.title.trim() || extension.display.title,
    viewId: extension.views[tab.viewId] ? tab.viewId : 'main',
  };

  return {
    ...restored,
    url: withViewerTabParams(view.url, restored),
  };
}

function nextTabSequence() {
  tabSequence += 1;
  return tabSequence;
}

function defaultResourceId({
  createdAt,
  extensionId,
  launch,
  resourceKind,
  sequence,
}: {
  createdAt: number;
  extensionId: string;
  launch: string | null;
  resourceKind: string | null;
  sequence: number;
}) {
  if (resourceKind === 'draft' || launch === 'new-chat') {
    return `${extensionId}:draft:${createdAt}:${sequence}`;
  }

  return null;
}

function withViewerTabParams(url: string, tab: Omit<ViewerTab, 'url'>) {
  const target = new URL(url);
  target.searchParams.set('remuxTabId', tab.id);

  if (tab.launch) {
    target.searchParams.set('remuxLaunch', tab.launch);
  } else {
    target.searchParams.delete('remuxLaunch');
  }

  if (tab.handlerId) {
    target.searchParams.set('remuxHandler', tab.handlerId);
  } else {
    target.searchParams.delete('remuxHandler');
  }

  if (tab.resourceKind) {
    target.searchParams.set('remuxResourceKind', tab.resourceKind);
  } else {
    target.searchParams.delete('remuxResourceKind');
  }

  if (tab.resourceId) {
    target.searchParams.set('remuxResourceId', tab.resourceId);
  } else {
    target.searchParams.delete('remuxResourceId');
  }

  return target.toString();
}

function loadPersistedBrowserSession() {
  if (!sessionLoadPromise) {
    sessionLoadPromise = readBrowserSession().catch(() => null);
  }

  return sessionLoadPromise;
}

function restoreBrowserSession(
  session: PersistedBrowserSession,
  extensions: RemuxExtension[],
): { activeTabId: string | null; section: BrowserSection; tabs: BrowserTab[] } {
  const tabs = rebuildBrowserTabs(session.tabs, extensions);
  const activeTabId = session.activeTabId && tabs.some((tab) => tab.id === session.activeTabId)
    ? session.activeTabId
    : nextActiveTabId(tabs);

  return {
    activeTabId,
    section: session.section,
    tabs,
  };
}

function rebuildBrowserTabs(
  tabs: Array<PersistedViewerTab & { reloadNonce?: number }>,
  extensions: RemuxExtension[],
) {
  return tabs.flatMap((tab) => {
    const extension = extensions.find((candidate) => candidate.id === tab.extensionId);
    if (!extension) {
      return [];
    }

    return [createRestoredViewerTab(tab, extension)];
  });
}

function persistCurrentBrowserSession(state: Pick<BrowserStore, 'activeTabId' | 'section' | 'tabs'>) {
  void writeBrowserSession(browserSessionSnapshot(state)).catch(() => undefined);
}
