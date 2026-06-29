import { useCallback, useEffect, useRef } from 'react';
import {
  StyleSheet,
  View,
} from 'react-native';
import { captureRef } from 'react-native-view-shot';

import { useRemuxConnection } from '../remote/RemuxConnectionProvider';
import {
  remuxOriginFromSettings,
  useRemuxSettingsStore,
} from '../remote/remuxSettingsStore';
import type { ExtensionWebViewHandle } from '../surfaces/viewer/ExtensionWebView';
import { colors } from '../theme/tokens';
import { ActiveSurface } from './ActiveSurface';
import { BrowserOverview } from './BrowserOverview';
import { useBrowserStore } from './browserStore';
import type { BrowserSection } from './browserTypes';

export function BrowserShell() {
  const catalogOrigin = useBrowserStore((state) => state.catalogOrigin);
  const catalogStatus = useBrowserStore((state) => state.catalogStatus);
  const loadExtensions = useBrowserStore((state) => state.loadExtensions);
  const mode = useBrowserStore((state) => state.mode);
  const openOverview = useBrowserStore((state) => state.openOverview);
  const setTabPreview = useBrowserStore((state) => state.setTabPreview);
  const remuxStatus = useRemuxConnection().status;
  const remuxHost = useRemuxSettingsStore((state) => state.host);
  const remuxPort = useRemuxSettingsStore((state) => state.port);
  const remuxOrigin = remuxOriginFromSettings({ host: remuxHost, port: remuxPort });
  const activeSurfaceRef = useRef<ExtensionWebViewHandle | null>(null);
  const previewCaptureSerialRef = useRef(0);
  const surfaceShotRef = useRef<View | null>(null);

  const refreshTabPreview = useCallback(async (tabId: string) => {
    const captureSerial = previewCaptureSerialRef.current + 1;
    previewCaptureSerialRef.current = captureSerial;

    const prepared = await (activeSurfaceRef.current?.prepareForPreviewCapture() ?? Promise.resolve(true));
    if (!prepared || previewCaptureSerialRef.current !== captureSerial) {
      return;
    }

    const currentState = useBrowserStore.getState();
    if (
      currentState.activeTabId !== tabId ||
      !currentState.tabs.some((tab) => tab.id === tabId) ||
      !surfaceShotRef.current
    ) {
      return;
    }

    try {
      const previewUri = await captureRef(surfaceShotRef, {
        format: 'jpg',
        handleGLSurfaceViewOnAndroid: true,
        quality: 0.72,
        result: 'tmpfile',
      });
      if (
        previewCaptureSerialRef.current === captureSerial &&
        useBrowserStore.getState().activeTabId === tabId
      ) {
        await setTabPreview(tabId, previewUri);
      }
    } catch {
      // Snapshot support can vary by native view type; the tab card has a fallback.
    }
  }, [setTabPreview]);

  const openHostOverview = useCallback(async (section?: BrowserSection) => {
    const tabId = useBrowserStore.getState().activeTabId;
    openOverview(section);
    if (tabId) {
      void refreshTabPreview(tabId);
    }
  }, [openOverview, refreshTabPreview]);

  useEffect(() => {
    if (
      remuxStatus.type === 'connected'
      && catalogStatus !== 'loading'
      && (catalogStatus !== 'ready' || catalogOrigin !== remuxOrigin)
    ) {
      void loadExtensions({ force: catalogOrigin !== remuxOrigin });
    }
  }, [catalogOrigin, catalogStatus, loadExtensions, remuxOrigin, remuxStatus.type]);

  return (
    <View style={styles.screen}>
      <View style={styles.surface}>
        <View
          collapsable={false}
          ref={surfaceShotRef}
          style={styles.surfaceShot}
        >
          <ActiveSurface onOpenOverview={openHostOverview} surfaceRef={activeSurfaceRef} />
        </View>
      </View>

      {mode === 'overview' ? <BrowserOverview /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    backgroundColor: colors.background,
    flex: 1,
  },
  surface: {
    backgroundColor: colors.background,
    flex: 1,
    overflow: 'hidden',
  },
  surfaceShot: {
    backgroundColor: colors.background,
    flex: 1,
  },
});
