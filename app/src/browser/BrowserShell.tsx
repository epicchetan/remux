import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AppState,
  Pressable,
  StyleSheet,
  Text,
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
import type { BrowserSection } from './browserTypes';
import {
  flushDirtyTabPreviews,
  markAllTabPreviewsDirty,
  requestTabPreviewCapture,
} from './tabPreviewCapture';

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
  const remuxToken = useRemuxSettingsStore((state) => state.token);
  const remuxOrigin = remuxOriginFromSettings({ host: remuxHost, port: remuxPort });
  const theme = useTheme();
  const activeSurfaceRef = useRef<ExtensionWebViewHandle | null>(null);
  const styles = useMemo(() => createStyles(theme), [theme]);
  const [guardianExtensions, setGuardianExtensions] = useState<Array<{ id: string; name: string }>>([]);

  useEffect(() => {
    if (remux.status.type !== 'disconnected' || !remux.guardianAvailable) {
      setGuardianExtensions([]);
      return;
    }
    void guardianRequest(remuxOrigin, remuxToken, 'extensions')
      .then((value) => {
        const extensions = isRecord(value) && Array.isArray(value.extensions)
          ? value.extensions.flatMap((extension) => (
            isRecord(extension) && typeof extension.id === 'string'
              ? [{
                id: extension.id,
                name: typeof extension.name === 'string' ? extension.name : extension.id,
              }]
              : []
          ))
          : [];
        setGuardianExtensions(extensions);
      })
      .catch(() => setGuardianExtensions([]));
  }, [remux.guardianAvailable, remux.status.type, remuxOrigin, remuxToken]);

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

  // Captures are skipped while the app isn't foregrounded (theme flips from
  // Control Center or Settings land exactly then), so re-shoot whatever went
  // stale once the app is active again with the overview showing.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') {
        return;
      }

      setTimeout(() => {
        if (AppState.currentState === 'active' && useBrowserStore.getState().mode === 'overview') {
          flushDirtyTabPreviews();
        }
      }, themeRepaintGraceMs);
    });

    return () => subscription.remove();
  }, []);

  return (
    <View style={styles.screen}>
      <View style={styles.surface}>
        <ActiveSurface onOpenOverview={openHostOverview} surfaceRef={activeSurfaceRef} />
      </View>

      {mode === 'overview' ? <BrowserOverview /> : null}
      {remux.status.type === 'disconnected' && remux.guardianAvailable ? (
        <View style={styles.recovery}>
          <Text style={styles.recoveryTitle}>Remux recovery</Text>
          <Text style={styles.recoveryBody}>
            The core app is unavailable, but its guardian is responding.
          </Text>
          <View style={styles.recoveryActions}>
            <Pressable
              onPress={() => void guardianAction(remuxOrigin, remuxToken, 'protection/release')}
              style={styles.recoveryButton}
            >
              <Text style={styles.recoveryButtonText}>Resume work</Text>
            </Pressable>
            <Pressable
              onPress={() => void guardianAction(remuxOrigin, remuxToken, 'worker/restart')}
              style={styles.recoveryButton}
            >
              <Text style={styles.recoveryButtonText}>Restart Remux</Text>
            </Pressable>
          </View>
          {guardianExtensions.map((extension) => (
            <View key={extension.id} style={styles.recoveryExtension}>
              <Text style={styles.recoveryExtensionName}>{extension.name}</Text>
              <Pressable
                onPress={() => void guardianAction(
                  remuxOrigin,
                  remuxToken,
                  `extensions/${extension.id}/pause`,
                )}
                style={styles.recoveryButton}
              >
                <Text style={styles.recoveryButtonText}>Pause</Text>
              </Pressable>
              <Pressable
                onPress={() => void guardianAction(
                  remuxOrigin,
                  remuxToken,
                  `extensions/${extension.id}/resume`,
                )}
                style={styles.recoveryButton}
              >
                <Text style={styles.recoveryButtonText}>Resume</Text>
              </Pressable>
              <Pressable
                onPress={() => void guardianAction(
                  remuxOrigin,
                  remuxToken,
                  `extensions/${extension.id}/stop`,
                )}
                style={styles.recoveryButton}
              >
                <Text style={styles.recoveryButtonText}>Stop</Text>
              </Pressable>
              <Pressable
                onPress={() => void guardianAction(
                  remuxOrigin,
                  remuxToken,
                  `extensions/${extension.id}/restart`,
                )}
                style={styles.recoveryButton}
              >
                <Text style={styles.recoveryButtonText}>Restart</Text>
              </Pressable>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
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
  recovery: {
    backgroundColor: theme.surfaceRaised,
    borderColor: theme.border,
    borderRadius: 18,
    borderWidth: 1,
    gap: 10,
    left: 20,
    padding: 16,
    position: 'absolute',
    right: 20,
    top: 64,
  },
  recoveryActions: {
    flexDirection: 'row',
    gap: 10,
  },
  recoveryBody: {
    color: theme.textMuted,
    fontSize: 13,
    lineHeight: 18,
  },
  recoveryButton: {
    backgroundColor: theme.surfaceRaised,
    borderColor: theme.border,
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  recoveryButtonText: {
    color: theme.text,
    fontSize: 13,
    fontWeight: '700',
  },
  recoveryExtension: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  recoveryExtensionName: {
    color: theme.text,
    flexBasis: '100%',
    fontSize: 13,
    fontWeight: '700',
  },
  recoveryTitle: {
    color: theme.text,
    fontSize: 17,
    fontWeight: '800',
  },
  });
}

async function guardianAction(origin: string, token: string | null, action: string) {
  await guardianRequest(origin, token, action, 'POST');
}

async function guardianRequest(
  origin: string,
  token: string | null,
  action: string,
  method: 'GET' | 'POST' = 'GET',
) {
  const url = new URL(origin);
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  url.port = String(port + 1);
  const response = await fetch(`${url.origin}/control/v1/${action}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(method === 'POST'
        ? { 'X-Remux-Operation-Id': `phone:${action}:${Date.now()}` }
        : {}),
    },
  });
  if (!response.ok) {
    throw new Error(`Guardian request failed (${response.status})`);
  }
  return response.json() as Promise<unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
