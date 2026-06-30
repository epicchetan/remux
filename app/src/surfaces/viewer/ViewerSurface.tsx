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
  const openExtensionTab = useBrowserStore((state) => state.openExtensionTab);
  const updateTab = useBrowserStore((state) => state.updateTab);
  const sourceUrlRef = useRef(tab.url);
  const descriptorRef = useRef({
    extensionId: tab.extensionId,
    id: tab.id,
    reloadNonce: tab.reloadNonce,
    title: tab.title,
    url: tab.url,
  });
  const openFile = useCallback(({ path }: { line?: number | null; path: string }) => {
    const name = fileNameFromPath(path);
    const fileHandler = matchingFileHandlers(extensions, { kind: 'file', name })[0] ?? null;
    if (!fileHandler) {
      return {
        ok: false,
        reason: 'no-file-handler',
      };
    }

    openExtensionTab(fileHandler.extensionId, {
      handlerId: fileHandler.id,
      resourceId: path,
      resourceKind: 'file',
      title: name,
      viewId: fileHandler.view,
    });
    return {
      ok: true,
    };
  }, [extensions, openExtensionTab]);

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
      onOpenFile={openFile}
      onOpenOverview={onOpenOverview}
      ref={surfaceRef}
      onTabUpdate={(patch) => updateTab(tab.id, patch)}
      reloadSourceUrl={tab.url}
      sourceUrl={sourceUrlRef.current}
      title={tab.title}
    />
  );
}

function fileNameFromPath(path: string) {
  return path.split(/[\\/]/u).filter(Boolean).at(-1) || path;
}
