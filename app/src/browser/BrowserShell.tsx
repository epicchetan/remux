import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  StyleSheet,
  View,
} from 'react-native';

import { useRemuxConnection } from '../remote/RemuxConnectionProvider';
import {
  remuxOriginFromSettings,
  useRemuxSettingsStore,
} from '../remote/remuxSettingsStore';
import type { ExtensionWebViewHandle } from '../surfaces/viewer/ExtensionWebView';
import { useTheme, type RemuxTheme } from '../theme/ThemeProvider';
import { ActiveSurface } from './ActiveSurface';
import { BrowserOverview } from './BrowserOverview';
import { useBrowserStore } from './browserStore';
import type { BrowserSection, BrowserTab } from './browserTypes';
import {
  flushDirtyTabPreviews,
  markAllTabPreviewsDirty,
  markTabPreviewDirty,
  requestTabPreviewCapture,
} from './tabPreviewCapture';

const previewInvalidateMethod = 'remux/previews/invalidate';
// Webviews re-theme via an injected script; give them a beat to repaint
// before photographing the new appearance.
const themeRepaintGraceMs = 300;

export function BrowserShell() {
  const catalogOrigin = useBrowserStore((state) => state.catalogOrigin);
  const catalogStatus = useBrowserStore((state) => state.catalogStatus);
  const loadExtensions = useBrowserStore((state) => state.loadExtensions);
  const mode = useBrowserStore((state) => state.mode);
  const openOverview = useBrowserStore((state) => state.openOverview);
  const remux = useRemuxConnection();
  const remuxHost = useRemuxSettingsStore((state) => state.host);
  const remuxPort = useRemuxSettingsStore((state) => state.port);
  const remuxOrigin = remuxOriginFromSettings({ host: remuxHost, port: remuxPort });
  const theme = useTheme();
  const activeSurfaceRef = useRef<ExtensionWebViewHandle | null>(null);
  const styles = useMemo(() => createStyles(theme), [theme]);

  const refreshTabPreview = useCallback(async (tabId: string) => {
    const prepared = await (activeSurfaceRef.current?.prepareForPreviewCapture() ?? Promise.resolve(true));
    if (!prepared) {
      return;
    }

    requestTabPreviewCapture(tabId);
  }, []);

  const openHostOverview = useCallback(async (section?: BrowserSection) => {
    const tabId = useBrowserStore.getState().activeTabId;
    openOverview(section);
    if (tabId) {
      void refreshTabPreview(tabId);
    }
  }, [openOverview, refreshTabPreview]);

  useEffect(() => {
    if (
      remux.status.type === 'connected'
      && catalogStatus !== 'loading'
      && (catalogStatus !== 'ready' || catalogOrigin !== remuxOrigin)
    ) {
      void loadExtensions({ force: catalogOrigin !== remuxOrigin });
    }
  }, [catalogOrigin, catalogStatus, loadExtensions, remuxOrigin, remux.status.type]);

  // Theme flips re-render every mounted webview, so previews captured in the
  // old appearance are stale everywhere. Re-shoot what's on screen and leave
  // the rest marked for the next overview entry.
  const previousThemeNameRef = useRef(theme.name);
  useEffect(() => {
    if (previousThemeNameRef.current === theme.name) {
      return undefined;
    }

    previousThemeNameRef.current = theme.name;
    markAllTabPreviewsDirty();
    const timer = setTimeout(() => {
      if (useBrowserStore.getState().mode === 'overview') {
        flushDirtyTabPreviews();
      }
    }, themeRepaintGraceMs);

    return () => clearTimeout(timer);
  }, [theme.name]);

  // Entering the overview re-shoots every stale card. The active tab is
  // skipped: the tab-out path captures it after the keyboard settles.
  const previousModeRef = useRef(mode);
  useEffect(() => {
    const previousMode = previousModeRef.current;
    previousModeRef.current = mode;
    if (mode !== 'overview' || previousMode === 'overview') {
      return;
    }

    flushDirtyTabPreviews(useBrowserStore.getState().activeTabId);
  }, [mode]);

  useEffect(() => remux.subscribe((message) => {
    if (message.method !== previewInvalidateMethod) {
      return;
    }

    const target = parsePreviewInvalidation(message.params);
    if (!target) {
      return;
    }

    const state = useBrowserStore.getState();
    for (const tab of state.tabs) {
      if (!previewInvalidationMatchesTab(target, tab)) {
        continue;
      }

      markTabPreviewDirty(tab.id);
      if (state.mode === 'overview') {
        requestTabPreviewCapture(tab.id);
      }
    }
  }), [remux]);

  return (
    <View style={styles.screen}>
      <View style={styles.surface}>
        <ActiveSurface onOpenOverview={openHostOverview} surfaceRef={activeSurfaceRef} />
      </View>

      {mode === 'overview' ? <BrowserOverview /> : null}
    </View>
  );
}

type PreviewInvalidationTarget = {
  extensionId: string;
  resourceId: string | null;
  resourceKind: string | null;
  viewId: string | null;
};

function parsePreviewInvalidation(params: unknown): PreviewInvalidationTarget | null {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    return null;
  }

  const record = params as Record<string, unknown>;
  const extensionId = optionalString(record.extensionId);
  if (!extensionId) {
    return null;
  }

  return {
    extensionId,
    resourceId: optionalString(record.resourceId),
    resourceKind: optionalString(record.resourceKind),
    viewId: optionalString(record.viewId),
  };
}

function previewInvalidationMatchesTab(target: PreviewInvalidationTarget, tab: BrowserTab) {
  return tab.extensionId === target.extensionId
    && (!target.viewId || tab.viewId === target.viewId)
    && (!target.resourceKind || tab.resourceKind === target.resourceKind)
    && (!target.resourceId || tab.resourceId === target.resourceId);
}

function optionalString(value: unknown) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function createStyles(theme: RemuxTheme) {
  return StyleSheet.create({
  screen: {
    backgroundColor: theme.surface,
    flex: 1,
  },
  surface: {
    backgroundColor: theme.surface,
    flex: 1,
    overflow: 'hidden',
  },
  });
}
