import { useCallback, useMemo, useRef, type Ref } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { ExtensionWebViewHandle } from '../surfaces/viewer/ExtensionWebView';
import { ViewerSurface } from '../surfaces/viewer/ViewerSurface';
import { useTheme, type RemuxTheme } from '../theme/ThemeProvider';
import { useBrowserStore } from './browserStore';
import type { BrowserSection } from './browserTypes';
import { setTabPreviewCaptureTarget } from './tabPreviewCapture';

type ActiveSurfaceProps = {
  onOpenOverview?: (section?: BrowserSection) => Promise<void> | void;
  surfaceActive: boolean;
  surfaceRef?: Ref<ExtensionWebViewHandle>;
};

export function ActiveSurface({ onOpenOverview, surfaceActive, surfaceRef }: ActiveSurfaceProps) {
  const theme = useTheme();
  const tabs = useBrowserStore((state) => state.tabs);
  const activeTab = useBrowserStore((state) => (
    state.activeTabId ? state.tabs.find((tab) => tab.id === state.activeTabId) : null
  ));
  const catalogError = useBrowserStore((state) => state.catalogError);
  const catalogStatus = useBrowserStore((state) => state.catalogStatus);
  const styles = useMemo(() => createStyles(theme), [theme]);
  const previewTargetRefs = useRef(new Map<
    string,
    (view: Parameters<typeof setTabPreviewCaptureTarget>[1]) => void
  >());
  const previewTargetRef = useCallback((tabId: string) => {
    const existing = previewTargetRefs.current.get(tabId);
    if (existing) return existing;
    const callback = (view: Parameters<typeof setTabPreviewCaptureTarget>[1]) => {
      setTabPreviewCaptureTarget(tabId, view);
      if (!view) previewTargetRefs.current.delete(tabId);
    };
    previewTargetRefs.current.set(tabId, callback);
    return callback;
  }, []);

  if (!activeTab) {
    if (catalogStatus === 'idle' || catalogStatus === 'loading') {
      return (
        <View style={styles.emptySurface}>
          <Text style={styles.emptyTitle}>Loading Remux</Text>
        </View>
      );
    }

    if (catalogStatus === 'error') {
      return (
        <View style={styles.emptySurface}>
          <Text style={styles.emptyTitle}>Remux unavailable</Text>
          <Text style={styles.emptyMessage}>{catalogError ?? 'Extension catalog could not be loaded.'}</Text>
        </View>
      );
    }

    return (
      <View style={styles.emptySurface}>
        <Text style={styles.emptyTitle}>No tab open</Text>
      </View>
    );
  }

  const viewerTabs = tabs.filter((tab) => tab.kind === 'viewer');

  return (
    <View style={styles.surfaceHost}>
      {viewerTabs.map((tab) => {
        const selected = activeTab.kind === 'viewer' && activeTab.id === tab.id;
        const interactive = selected && surfaceActive;
        return (
          <View
            key={`${tab.id}:${tab.reloadNonce}`}
            pointerEvents={interactive ? 'auto' : 'none'}
            style={[
              styles.extensionSurface,
              selected ? styles.visibleSurface : styles.hiddenSurface,
            ]}
          >
            {/* Preview snapshots target this inner view: capturing a subtree
                ignores the ancestor's opacity, so hidden tabs photograph too. */}
            <View
              collapsable={false}
              ref={previewTargetRef(tab.id)}
              style={styles.captureTarget}
            >
              <ViewerSurface
                active={interactive}
                onOpenOverview={onOpenOverview}
                surfaceRef={selected ? surfaceRef : undefined}
                tab={tab}
              />
            </View>
          </View>
        );
      })}
    </View>
  );
}

function createStyles(theme: RemuxTheme) {
  return StyleSheet.create({
  emptySurface: {
    alignItems: 'center',
    backgroundColor: theme.surface,
    flex: 1,
    justifyContent: 'center',
  },
  emptyTitle: {
    color: theme.text,
    fontSize: 18,
    fontWeight: '700',
    lineHeight: 24,
  },
  emptyMessage: {
    color: theme.textMuted,
    fontSize: 14,
    lineHeight: 20,
    marginTop: 8,
    maxWidth: 280,
    textAlign: 'center',
  },
  captureTarget: {
    backgroundColor: theme.surface,
    flex: 1,
  },
  extensionSurface: {
    backgroundColor: theme.surface,
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  hiddenSurface: {
    opacity: 0,
    zIndex: 0,
  },
  surfaceHost: {
    backgroundColor: theme.surface,
    flex: 1,
  },
  visibleSurface: {
    opacity: 1,
    zIndex: 1,
  },
  });
}
