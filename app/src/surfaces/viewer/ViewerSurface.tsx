import { useCallback, useEffect, useRef, type Ref } from 'react';

import { useBrowserStore } from '../../browser/browserStore';
import type { BrowserSection, ViewerTab } from '../../browser/browserTypes';
import { matchingFileHandlers } from '../../files/fileHandlers';
import { logRemuxDebug } from '../../remote/remuxDebug';
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
  const sourceUrlRef = useRef(tab.url);
  const descriptorRef = useRef({
    extensionId: tab.extensionId,
    id: tab.id,
    reloadNonce: tab.reloadNonce,
    title: tab.title,
    url: tab.url,
  });
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
  const recoverUnavailableViewerBundle = useCallback(async () => {
    const before = useBrowserStore.getState().tabs.find((candidate) => candidate.id === tab.id);
    await loadExtensions({ force: true });
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
  }, [loadExtensions, tab.id]);

  useEffect(() => {
    const descriptor = descriptorRef.current;
    logRemuxDebug('surface:viewer:mount', descriptor);

    return () => {
      logRemuxDebug('surface:viewer:unmount', descriptor);
    };
  }, []);

  return (
    <ExtensionWebView
      active={active}
      onCloseTab={closeCurrentTab}
      onOpenFile={openFile}
      onOpenOverview={onOpenOverview}
      onViewerBundleUnavailable={recoverUnavailableViewerBundle}
      onNavigationDelivered={(nonce) => clearPendingNavigation(tab.id, nonce)}
      ref={surfaceRef}
      onTabUpdate={(patch) => updateTab(tab.id, patch)}
      pendingNavigation={tab.pendingNavigation}
      reloadSourceUrl={tab.url}
      sourceUrl={sourceUrlRef.current}
      tab={tab}
      title={tab.title}
    />
  );
}

function fileNameFromPath(path: string) {
  return path.split(/[\\/]/u).filter(Boolean).at(-1) || path;
}
