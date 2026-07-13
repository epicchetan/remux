import { create } from 'zustand';

import {
  fetchRemuxExtensionCatalog,
  type RemuxExtension,
  type RemuxExtensionCatalog,
} from '../remote/remuxExtensions';
import {
  readCachedRemuxExtensionCatalog,
  writeCachedRemuxExtensionCatalog,
} from '../remote/remuxExtensionCatalogCache';
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
import type {
  BrowserMode,
  BrowserPendingNavigation,
  BrowserResourceTarget,
  BrowserSection,
  BrowserTab,
  ViewerTab,
} from './browserTypes';
import { serializedResourceKey } from './resourceKeys';

type BrowserCatalogStatus = 'error' | 'idle' | 'loading' | 'ready';
export type BrowserCatalogSource = 'cache' | 'network' | null;

type BrowserStore = {
  activeTabId: string | null;
  catalogError: string | null;
  catalogOrigin: string | null;
  catalogSource: BrowserCatalogSource;
  catalogStatus: BrowserCatalogStatus;
  clearPendingNavigation: (tabId: string, nonce: string) => void;
  closeOverview: () => void;
  closeTab: (tabId: string, options?: BrowserCloseTabOptions) => void;
  defaultExtensionId: string | null;
  extensions: RemuxExtension[];
  loadExtensions: (options?: { force?: boolean }) => Promise<void>;
  mode: BrowserMode;
  moveTab: (tabId: string, toIndex: number) => void;
  openResource: (target: BrowserResourceTarget, options?: BrowserOpenResourceOptions) => Promise<BrowserOpenResourceResult>;
  openOverview: (section?: BrowserSection) => void;
  reloadExtensionTabs: (extensionId: string) => void;
  section: BrowserSection;
  selectTab: (tabId: string) => void;
  setSection: (section: BrowserSection) => void;
  setTabPreview: (tabId: string, previewUri: string) => Promise<void>;
  tabs: BrowserTab[];
  updateTab: (tabId: string, patch: BrowserTabUpdate) => void;
};

export type BrowserOpenResourceOptions = {
  disposition?: 'new' | 'reuse';
};

export type BrowserCloseTabOptions = {
  returnToOverview?: boolean;
};

export type BrowserOpenResourceTargetOptions = {
  focusId?: string | null;
  focusKind?: string | null;
  handlerId?: string | null;
  launch?: string | null;
  resourceId?: string | null;
  resourceKind?: string | null;
  status?: string | null;
  title?: string | null;
  viewId?: string | null;
};

export type BrowserOpenResourceResult =
  | { tabId: string; type: 'created' | 'selected' }
  | { reason: 'extension-not-found' | 'invalid-target'; type: 'ignored' };

let extensionLoadPromise: Promise<void> | null = null;
let extensionLoadOrigin: string | null = null;
let tabSequence = 0;
let pendingNavigationSequence = 0;
let sessionLoadPromise: Promise<PersistedBrowserSession | null> | null = null;

type BrowserTabUpdate = {
  handlerId?: string | null;
  launch?: string | null;
  resourceId?: string | null;
  resourceKind?: string | null;
  status?: string | null;
  title?: string | null;
};

export const useBrowserStore = create<BrowserStore>((set, get) => ({
  activeTabId: null,
  catalogError: null,
  catalogOrigin: null,
  catalogSource: null,
  catalogStatus: 'idle',
  clearPendingNavigation: (tabId, nonce) => {
    set((state) => ({
      tabs: state.tabs.map((tab) => (
        tab.id === tabId && tab.pendingNavigation?.nonce === nonce
          ? { ...tab, pendingNavigation: null }
          : tab
      )),
    }));
    persistCurrentBrowserSession(get());
  },
  closeOverview: () => {
    set((state) => ({ mode: state.activeTabId ? 'surface' : 'overview' }));
    persistCurrentBrowserSession(get());
  },
  closeTab: (tabId, options = {}) => {
    const closedTab = get().tabs.find((tab) => tab.id === tabId);
    set((state) => {
      const tabs = state.tabs.filter((tab) => tab.id !== tabId);
      const activeTabClosed = state.activeTabId === tabId;
      const activeTabId = state.activeTabId === tabId
        ? nextActiveTabId(tabs)
        : state.activeTabId;

      return {
        activeTabId,
        mode: activeTabClosed && options.returnToOverview
          ? 'overview'
          : activeTabId ? state.mode : 'overview',
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
    extensionLoadPromise = (async () => {
      const persistedSessionPromise = loadPersistedBrowserSession();
      let cachedCatalog: RemuxExtensionCatalog | null = null;
      try {
        cachedCatalog = await readCachedRemuxExtensionCatalog(origin);
      } catch {
        cachedCatalog = null;
      }

      // A forced refresh is used to recover immutable viewer URLs that no
      // longer exist. Applying the cache first would briefly move tabs back
      // onto the same stale revision before the network catalog arrives.
      if (!options.force && cachedCatalog && currentRemuxOrigin() === origin) {
        applyExtensionCatalog(
          set,
          get,
          cachedCatalog,
          origin,
          'cache',
          await persistedSessionPromise,
        );
      }

      try {
        const catalog = await fetchRemuxExtensionCatalog(origin);
        if (currentRemuxOrigin() !== origin) {
          return;
        }
        applyExtensionCatalog(set, get, catalog, origin, 'network', await persistedSessionPromise);
        await writeCachedRemuxExtensionCatalog(origin, catalog).catch(() => undefined);
      } catch (error) {
        if (currentRemuxOrigin() !== origin) {
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        if (cachedCatalog) {
          set({ catalogError: message, catalogStatus: 'ready' });
          return;
        }
        set({
          catalogError: message,
          catalogSource: null,
          catalogStatus: 'error',
          defaultExtensionId: null,
          extensions: [],
        });
      }
    })()
      .finally(() => {
        if (extensionLoadOrigin === origin) {
          extensionLoadPromise = null;
          extensionLoadOrigin = null;
        }
      });

    return extensionLoadPromise;
  },
  mode: 'overview',
  moveTab: (tabId, toIndex) => {
    set((state) => {
      const fromIndex = state.tabs.findIndex((tab) => tab.id === tabId);
      if (fromIndex === -1) {
        return {};
      }

      const targetIndex = Math.max(0, Math.min(toIndex, state.tabs.length - 1));
      if (targetIndex === fromIndex) {
        return {};
      }

      const tabs = [...state.tabs];
      const [movedTab] = tabs.splice(fromIndex, 1);
      tabs.splice(targetIndex, 0, movedTab);

      return { tabs };
    });
    persistCurrentBrowserSession(get());
  },
  openResource: async (target, openOptions = {}) => {
    const extensionId = target.extensionId.trim();
    if (!extensionId) {
      return { reason: 'invalid-target', type: 'ignored' };
    }

    const state = get();
    if (state.catalogStatus !== 'ready') {
      await state.loadExtensions();
    }

    let result: BrowserOpenResourceResult = {
      reason: 'extension-not-found',
      type: 'ignored',
    };

    set((currentState) => {
      const extension = currentState.extensions.find((candidate) => candidate.id === extensionId);
      if (!extension) {
        return {};
      }

      const options = normalizeBrowserResourceTarget(target, extension);
      const disposition = openOptions.disposition ?? 'reuse';
      const targetKey = serializedResourceKey({
        extensionId,
        resourceId: options.resourceId,
        resourceKind: options.resourceKind,
        viewId: options.viewId,
      });
      const now = Date.now();

      if (disposition === 'reuse' && targetKey) {
        const existingTab = mostRecentlyActiveTabWithKey(currentState.tabs, targetKey);
        if (existingTab) {
          result = { tabId: existingTab.id, type: 'selected' };
          return {
            activeTabId: existingTab.id,
            mode: 'surface',
            tabs: currentState.tabs.map((tab) => (
              tab.id === existingTab.id
                ? {
                    ...tab,
                    lastActiveAt: now,
                    pendingNavigation: pendingNavigationFromTarget(options),
                  }
                : tab
            )),
          };
        }
      }

      if (disposition === 'reuse' && target.origin?.tabId && target.origin.resourceKey && targetKey) {
        const originTab = currentState.tabs.find((tab) => tab.id === target.origin?.tabId);
        if (originTab && serializedResourceKey(originTab) === target.origin.resourceKey) {
          const nextTab = applyTabResourceTarget(originTab, options, extension);
          result = { tabId: originTab.id, type: 'selected' };
          return {
            activeTabId: originTab.id,
            mode: 'surface',
            tabs: currentState.tabs.map((tab) => (
              tab.id === originTab.id
                ? {
                    ...nextTab,
                    lastActiveAt: now,
                    pendingNavigation: pendingNavigationFromTarget(options),
                  }
                : tab
            )),
          };
        }
      }

      const tab = createViewerTab(extension, options, initialNavigationFromTarget(options));
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
          ? adoptLatestViewRevision(tab, state.extensions, true)
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
              ...adoptLatestViewRevision(tab, state.extensions),
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

    const currentTab = get().tabs.find((tab) => tab.id === tabId);
    if (!currentTab) {
      await deleteTabPreview(preview.previewFileName);
      return;
    }

    const replacedFileName = currentTab.previewFileName;
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
    if (replacedFileName && replacedFileName !== preview.previewFileName) {
      void deleteTabPreview(replacedFileName).catch(() => undefined);
    }
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
          launch: patch.launch === undefined ? tab.launch : patch.launch,
          handlerId: patch.handlerId === undefined ? tab.handlerId : patch.handlerId,
          resourceId: patch.resourceId === undefined ? tab.resourceId : patch.resourceId,
          resourceKind: patch.resourceKind === undefined ? tab.resourceKind : patch.resourceKind,
          status: optionalMetadataValue(tab.status, patch.status),
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

function normalizeBrowserResourceTarget(
  target: BrowserResourceTarget,
  extension: RemuxExtension,
): BrowserOpenResourceTargetOptions {
  const viewId = target.viewId?.trim() || 'main';

  return {
    focusId: target.focusId?.trim() || null,
    focusKind: target.focusKind?.trim() || null,
    handlerId: target.handlerId?.trim() || null,
    launch: target.launch?.trim() || null,
    resourceId: target.resourceId?.trim() || null,
    resourceKind: target.resourceKind?.trim() || null,
    status: target.status?.trim() || null,
    title: target.title?.trim() || extension.display.title,
    viewId: extension.views[viewId] ? viewId : 'main',
  };
}

function mostRecentlyActiveTabWithKey(tabs: BrowserTab[], key: string) {
  return tabs
    .filter((tab) => serializedResourceKey(tab) === key)
    .sort((first, second) => second.lastActiveAt - first.lastActiveAt)[0] ?? null;
}

function pendingNavigationFromTarget(target: BrowserOpenResourceTargetOptions): BrowserPendingNavigation | null {
  const resourceKind = target.resourceKind?.trim() || null;
  const resourceId = target.resourceId?.trim() || null;
  const focusKind = target.focusKind?.trim() || null;
  const focusId = target.focusId?.trim() || null;

  if (!resourceKind && !resourceId && !focusKind && !focusId) {
    return null;
  }

  return {
    focusId,
    focusKind,
    nonce: nextPendingNavigationNonce(),
    resourceId,
    resourceKind,
  };
}

function initialNavigationFromTarget(target: BrowserOpenResourceTargetOptions): BrowserPendingNavigation | null {
  const focusKind = target.focusKind?.trim() || null;
  const focusId = target.focusId?.trim() || null;
  if (!focusKind && !focusId) {
    return null;
  }

  return pendingNavigationFromTarget(target);
}

function nextPendingNavigationNonce() {
  pendingNavigationSequence += 1;
  return `nav:${Date.now()}:${pendingNavigationSequence}`;
}

function optionalMetadataValue(current: string | null, next: string | null | undefined) {
  if (next === undefined) {
    return current;
  }

  return next?.trim() || null;
}

function nextActiveTabId(tabs: BrowserTab[]) {
  return [...tabs].sort((first, second) => second.lastActiveAt - first.lastActiveAt)[0]?.id ?? null;
}

function createViewerTab(
  extension: RemuxExtension,
  options: BrowserOpenResourceTargetOptions = {},
  initialNavigation: BrowserPendingNavigation | null = null,
): ViewerTab {
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
    iconDarkUrl: extension.display.iconDarkUrl,
    iconUrl: extension.display.iconUrl,
    kind: 'viewer',
    launch,
    lastActiveAt: createdAt,
    pendingNavigation: null,
    previewFileName: null,
    previewUri: null,
    reloadNonce: 0,
    resourceId,
    resourceKind,
    status: options.status?.trim() || null,
    title: options.title?.trim() || extension.display.title,
    viewId: extension.views[viewId] ? viewId : 'main',
    viewRevision: view.revision,
  };

  return {
    ...tab,
    url: withViewerTabParams(view.url, tab, initialNavigation),
  };
}

function applyTabResourceTarget(
  tab: ViewerTab,
  target: BrowserOpenResourceTargetOptions,
  extension: RemuxExtension,
): ViewerTab {
  const viewId = target.viewId?.trim() || 'main';
  const view = extension.views[viewId] ?? extension.views.main;
  const nextTab = {
    ...tab,
    handlerId: target.handlerId?.trim() || tab.handlerId,
    launch: target.launch?.trim() || tab.launch,
    resourceId: target.resourceId?.trim() || null,
    resourceKind: target.resourceKind?.trim() || null,
    status: target.status?.trim() || tab.status,
    title: target.title?.trim() || tab.title,
    viewId: extension.views[viewId] ? viewId : 'main',
    viewRevision: view.revision,
  };

  return {
    ...nextTab,
    url: withViewerTabParams(view.url, nextTab),
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
    iconDarkUrl: extension.display.iconDarkUrl,
    iconUrl: extension.display.iconUrl,
    kind: 'viewer',
    launch: tab.launch,
    lastActiveAt: tab.lastActiveAt,
    pendingNavigation: tab.pendingNavigation ?? null,
    previewFileName: preview?.previewFileName ?? null,
    previewUri: preview?.previewUri ?? null,
    reloadNonce: tab.reloadNonce ?? 0,
    resourceId: tab.resourceId,
    resourceKind: tab.resourceKind,
    status: tab.status?.trim() || null,
    title: tab.title.trim() || extension.display.title,
    viewId: extension.views[tab.viewId] ? tab.viewId : 'main',
    viewRevision: view.revision,
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

  if (resourceKind === 'terminalSession') {
    return `${extensionId}:session:${createdAt}:${sequence}`;
  }

  return null;
}

function withViewerTabParams(
  url: string,
  tab: Omit<ViewerTab, 'url'>,
  navigation: BrowserPendingNavigation | null = null,
) {
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

  if (navigation?.focusKind) {
    target.searchParams.set('remuxFocusKind', navigation.focusKind);
  } else {
    target.searchParams.delete('remuxFocusKind');
  }

  if (navigation?.focusId) {
    target.searchParams.set('remuxFocusId', navigation.focusId);
  } else {
    target.searchParams.delete('remuxFocusId');
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

function applyExtensionCatalog(
  set: typeof useBrowserStore.setState,
  get: typeof useBrowserStore.getState,
  catalog: RemuxExtensionCatalog,
  origin: string,
  source: BrowserCatalogSource,
  persistedSession: PersistedBrowserSession | null,
) {
  set((state) => {
    const restoredSession = state.tabs.length === 0 && persistedSession
      ? restoreBrowserSession(persistedSession, catalog.extensions)
      : null;
    const tabs = restoredSession?.tabs ?? reconcileBrowserTabs(state.tabs, catalog.extensions);
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
      catalogSource: source,
      catalogStatus: 'ready',
      defaultExtensionId: catalog.defaultExtensionId,
      extensions: catalog.extensions,
      mode: restoredSession ? 'overview' : activeTabId ? state.mode : 'overview',
      section: restoredSession?.section ?? state.section,
      tabs,
    };
  });
  persistCurrentBrowserSession(get());
}

function reconcileBrowserTabs(tabs: BrowserTab[], extensions: RemuxExtension[]) {
  return tabs.flatMap((tab) => {
    const extension = extensions.find((candidate) => candidate.id === tab.extensionId);
    if (!extension || !extension.views[tab.viewId]) {
      return [];
    }
    return [{
      ...adoptLatestViewRevision(tab, extensions),
      iconDarkUrl: extension.display.iconDarkUrl,
      iconUrl: extension.display.iconUrl,
    }];
  });
}

function adoptLatestViewRevision(
  tab: ViewerTab,
  extensions: RemuxExtension[],
  forceReload = false,
): ViewerTab {
  const extension = extensions.find((candidate) => candidate.id === tab.extensionId);
  const view = extension?.views[tab.viewId];
  if (!view) {
    return forceReload ? { ...tab, reloadNonce: tab.reloadNonce + 1 } : tab;
  }

  const revisionChanged = tab.viewRevision !== view.revision;
  if (!revisionChanged && !forceReload) {
    return tab;
  }

  return {
    ...tab,
    reloadNonce: tab.reloadNonce + 1,
    url: withViewerTabParams(view.url, { ...tab, viewRevision: view.revision }),
    viewRevision: view.revision,
  };
}

function persistCurrentBrowserSession(state: Pick<BrowserStore, 'activeTabId' | 'section' | 'tabs'>) {
  void writeBrowserSession(browserSessionSnapshot(state)).catch(() => undefined);
}
