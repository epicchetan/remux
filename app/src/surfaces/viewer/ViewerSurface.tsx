import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode, type Ref } from 'react';
import { View } from 'react-native';
import { SafeAreaInsetsContext, useSafeAreaInsets } from 'react-native-safe-area-context';

import { useBrowserStore } from '../../browser/browserStore';
import type { BrowserSection, ViewerTab } from '../../browser/browserTypes';
import { matchingFileHandlers } from '../../files/fileHandlers';
import { logRemuxDebug } from '../../remote/remuxDebug';
import { useRemuxConnection } from '../../remote/RemuxConnectionProvider';
import { HtmlFilePreview, HtmlFileSourceHeader } from '../html-preview/HtmlFilePreview';
import { htmlPreviewModeForTarget, htmlPreviewPath } from '../html-preview/htmlPreviewControllerHook';
import { HtmlPreviewLoadController } from '../html-preview/htmlPreviewLoad';
import { ExtensionWebView, type ExtensionWebViewHandle } from './ExtensionWebView';

type ViewerSurfaceProps = {
  active: boolean;
  onOpenOverview?: (section?: BrowserSection) => Promise<void> | void;
  surfaceRef?: Ref<ExtensionWebViewHandle>;
  tab: ViewerTab;
};

export function ViewerSurface({ active, onOpenOverview, surfaceRef, tab }: ViewerSurfaceProps) {
  const extensions = useBrowserStore((state) => state.extensions);
  const clearPendingNavigation = useBrowserStore((state) => state.clearPendingNavigation);
  const closeTab = useBrowserStore((state) => state.closeTab);
  const loadExtensions = useBrowserStore((state) => state.loadExtensions);
  const openResource = useBrowserStore((state) => state.openResource);
  const updateTab = useBrowserStore((state) => state.updateTab);
  const hostChrome = extensions
    .find((extension) => extension.id === tab.extensionId)
    ?.views[tab.viewId]?.hostChrome ?? 'none';
  const sourceUrlRef = useRef(tab.url);
  const descriptorRef = useRef({
    extensionId: tab.extensionId,
    id: tab.id,
    reloadNonce: tab.reloadNonce,
    title: tab.title,
    url: tab.url,
  });
  const htmlFilePath = htmlPreviewPath(tab);
  const openFile = useCallback(({ line, path }: { line?: number | null; path: string }) => {
    const name = fileNameFromPath(path);
    const fileHandler = matchingFileHandlers(extensions, { kind: 'file', name })[0] ?? null;
    if (!fileHandler) {
      return {
        ok: false,
        reason: 'no-file-handler',
      };
    }

    void openResource({
      extensionId: fileHandler.extensionId,
      focusId: line ? String(line) : null,
      focusKind: line ? 'line' : null,
      handlerId: fileHandler.id,
      resourceId: path,
      resourceKind: 'file',
      title: name,
      viewId: fileHandler.view,
    });
    return {
      ok: true,
    };
  }, [extensions, openResource]);
  const closeCurrentTab = useCallback(() => {
    closeTab(tab.id, { returnToOverview: true });
  }, [closeTab, tab.id]);
  const refreshViewerRevision = useCallback(async () => {
    await loadExtensions({ force: true });
    return useBrowserStore.getState().tabs.find((candidate) => candidate.id === tab.id)?.url ?? null;
  }, [loadExtensions, tab.id]);
  const recoverUnavailableViewerBundle = useCallback(async () => {
    const before = useBrowserStore.getState().tabs.find((candidate) => candidate.id === tab.id);
    await refreshViewerRevision();
    const after = useBrowserStore.getState().tabs.find((candidate) => candidate.id === tab.id);
    return Boolean(
      before
      && after
      && (
        after.reloadNonce !== before.reloadNonce
        || after.viewRevision !== before.viewRevision
        || after.url !== before.url
      )
    );
  }, [refreshViewerRevision, tab.id]);

  useEffect(() => {
    const descriptor = descriptorRef.current;
    logRemuxDebug('surface:viewer:mount', descriptor);

    return () => {
      logRemuxDebug('surface:viewer:unmount', descriptor);
    };
  }, []);

  const renderSource = (sourceUrl: string): ReactNode => (
    <ExtensionWebView
      active={active}
      hostChrome={hostChrome}
      onCloseTab={closeCurrentTab}
      onOpenFile={openFile}
      onOpenOverview={onOpenOverview}
      onReloadView={refreshViewerRevision}
      onViewerBundleUnavailable={recoverUnavailableViewerBundle}
      onNavigationDelivered={(nonce) => clearPendingNavigation(tab.id, nonce)}
      ref={surfaceRef}
      onTabUpdate={(patch) => updateTab(tab.id, patch)}
      pendingNavigation={tab.pendingNavigation}
      reloadSourceUrl={tab.url}
      sourceUrl={sourceUrl}
      tab={tab}
      title={tab.title}
    />
  );

  if (!htmlFilePath) return renderSource(sourceUrlRef.current);

  return (
    <HtmlFileSurface
      active={active}
      onClose={closeCurrentTab}
      onOpenFile={openFile}
      onOpenOverview={onOpenOverview}
      path={htmlFilePath}
      renderSource={() => renderSource(tab.url)}
      tab={tab}
    />
  );
}

function HtmlFileSurface({ active, onClose, onOpenFile, onOpenOverview, path, renderSource, tab }: {
  active: boolean;
  onClose: () => void;
  onOpenFile: (target: { line?: number | null; path: string }) => { ok: boolean; reason?: string };
  onOpenOverview?: (section?: BrowserSection) => Promise<void> | void;
  path: string;
  renderSource: () => ReactNode;
  tab: ViewerTab;
}) {
  const remux = useRemuxConnection();
  const safeAreaInsets = useSafeAreaInsets();
  const initialLineFocus = useRef(tabUrlHasLineFocus(tab.url)).current;
  const pendingLineNonce = tab.pendingNavigation?.focusKind === 'line'
    ? tab.pendingNavigation.nonce
    : null;
  const connectionGeneration = remux.status.type === 'connected'
    ? remux.status.generation
    : remux.status.type;
  const previousPathRef = useRef(path);
  const [controller] = useState(() => new HtmlPreviewLoadController({
    connectionGeneration,
    mode: pendingLineNonce || initialLineFocus ? 'source' : 'preview',
    path,
  }));
  const state = useSyncExternalStore(
    useCallback((listener) => controller.subscribe(listener), [controller]),
    useCallback(() => controller.snapshot(), [controller]),
  );

  useEffect(() => {
    const previousPath = previousPathRef.current;
    previousPathRef.current = path;
    controller.retarget({
      connectionGeneration,
      mode: htmlPreviewModeForTarget({
        currentMode: controller.snapshot().mode,
        focusKind: pendingLineNonce ? 'line' : null,
        nextPath: path,
        previousPath,
      }),
      path,
    });
  }, [connectionGeneration, controller, path, pendingLineNonce]);

  useEffect(() => () => {
    controller.retire();
  }, [controller]);

  if (state.path !== path || state.connectionGeneration !== connectionGeneration) {
    return <View style={{ flex: 1 }} />;
  }

  if (state.mode === 'preview') {
    return (
      <HtmlFilePreview
        active={active}
        canLoad={remux.status.type === 'connected'}
        controller={controller}
        onClose={onClose}
        onOpenFile={onOpenFile}
        onOpenOverview={onOpenOverview}
        query={remux.query}
        tab={tab}
      />
    );
  }

  return (
    <View style={{ flex: 1 }}>
      <HtmlFileSourceHeader onPreview={() => controller.setMode('preview')} />
      <SafeAreaInsetsContext.Provider value={{ ...safeAreaInsets, top: 0 }}>
        <View style={{ flex: 1 }}>{renderSource()}</View>
      </SafeAreaInsetsContext.Provider>
    </View>
  );
}

function fileNameFromPath(path: string) {
  return path.split(/[\\/]/u).filter(Boolean).at(-1) || path;
}

function tabUrlHasLineFocus(url: string) {
  try {
    return new URL(url).searchParams.get('remuxFocusKind') === 'line';
  } catch {
    return false;
  }
}
