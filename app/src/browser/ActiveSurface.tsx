import type { Ref } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { colors } from '../theme/tokens';
import type { ExtensionWebViewHandle } from '../surfaces/viewer/ExtensionWebView';
import { ViewerSurface } from '../surfaces/viewer/ViewerSurface';
import { useBrowserStore } from './browserStore';
import type { BrowserSection } from './browserTypes';

type ActiveSurfaceProps = {
  onOpenOverview?: (section?: BrowserSection) => Promise<void> | void;
  surfaceRef?: Ref<ExtensionWebViewHandle>;
};

export function ActiveSurface({ onOpenOverview, surfaceRef }: ActiveSurfaceProps) {
  const tabs = useBrowserStore((state) => state.tabs);
  const activeTab = useBrowserStore((state) => (
    state.activeTabId ? state.tabs.find((tab) => tab.id === state.activeTabId) : null
  ));
  const catalogError = useBrowserStore((state) => state.catalogError);
  const catalogStatus = useBrowserStore((state) => state.catalogStatus);

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
        const visible = activeTab.kind === 'viewer' && activeTab.id === tab.id;
        return (
          <View
            key={`${tab.id}:${tab.reloadNonce}`}
            pointerEvents={visible ? 'auto' : 'none'}
            style={[
              styles.extensionSurface,
              visible ? styles.visibleSurface : styles.hiddenSurface,
            ]}
          >
            <ViewerSurface
              active={visible}
              onOpenOverview={onOpenOverview}
              surfaceRef={visible ? surfaceRef : undefined}
              tab={tab}
            />
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  emptySurface: {
    alignItems: 'center',
    backgroundColor: colors.background,
    flex: 1,
    justifyContent: 'center',
  },
  emptyTitle: {
    color: colors.text,
    fontSize: 18,
    fontWeight: '700',
    lineHeight: 24,
  },
  emptyMessage: {
    color: colors.muted,
    fontSize: 14,
    lineHeight: 20,
    marginTop: 8,
    maxWidth: 280,
    textAlign: 'center',
  },
  extensionSurface: {
    backgroundColor: colors.background,
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
    backgroundColor: colors.background,
    flex: 1,
  },
  visibleSurface: {
    opacity: 1,
    zIndex: 1,
  },
});
