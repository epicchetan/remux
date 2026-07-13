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
import {
  readGuardianExtensions,
  runGuardianAction,
  type GuardianExtension,
} from '../remote/remuxGuardianClient';
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
const recoveryGraceMs = 1_000;

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
  const [guardianExtensions, setGuardianExtensions] = useState<GuardianExtension[]>([]);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [recoveryVisible, setRecoveryVisible] = useState(false);
  const guardianAvailable = remux.guardian.state === 'available';
  const runtimeUnavailable = remux.status.type !== 'connected';

  useEffect(() => {
    if (!runtimeUnavailable || !guardianAvailable) {
      setRecoveryVisible(false);
      return undefined;
    }
    const timer = setTimeout(() => setRecoveryVisible(true), recoveryGraceMs);
    return () => clearTimeout(timer);
  }, [guardianAvailable, runtimeUnavailable]);

  useEffect(() => {
    if (!recoveryVisible) {
      setGuardianExtensions([]);
      return;
    }
    void readGuardianExtensions(remuxOrigin, remuxToken)
      .then(setGuardianExtensions)
      .catch(() => setGuardianExtensions([]));
  }, [recoveryVisible, remuxOrigin, remuxToken]);

  const performRecoveryAction = useCallback(async (action: string) => {
    setRecoveryError(null);
    try {
      await runGuardianAction(remuxOrigin, remuxToken, action);
      if (action.startsWith('extensions/')) {
        setGuardianExtensions(await readGuardianExtensions(remuxOrigin, remuxToken));
      }
    } catch (error) {
      setRecoveryError(error instanceof Error ? error.message : String(error));
    }
  }, [remuxOrigin, remuxToken]);

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
      {recoveryVisible ? (
        <View style={styles.recovery}>
          <Text style={styles.recoveryTitle}>Remux recovery</Text>
          <Text style={styles.recoveryBody}>
            {guardianRecoverySummary(remux.guardian)}
          </Text>
          <View style={styles.recoveryActions}>
            <Pressable
              onPress={() => void performRecoveryAction('protection/release')}
              style={styles.recoveryButton}
            >
              <Text style={styles.recoveryButtonText}>Resume work</Text>
            </Pressable>
            <Pressable
              onPress={() => void performRecoveryAction('worker/restart')}
              style={styles.recoveryButton}
            >
              <Text style={styles.recoveryButtonText}>Restart Remux</Text>
            </Pressable>
          </View>
          {recoveryError ? <Text style={styles.recoveryError}>{recoveryError}</Text> : null}
          {guardianExtensions.map((extension) => (
            <View key={extension.id} style={styles.recoveryExtension}>
              <Text style={styles.recoveryExtensionName}>{extension.name}</Text>
              {extension.error ? (
                <Text style={styles.recoveryBody}>{extension.error}</Text>
              ) : null}
              {extension.state === 'valid' ? (
                <>
                  <Pressable
                    onPress={() => void performRecoveryAction(`extensions/${extension.id}/pause`)}
                    style={styles.recoveryButton}
                  >
                    <Text style={styles.recoveryButtonText}>Pause</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => void performRecoveryAction(`extensions/${extension.id}/resume`)}
                    style={styles.recoveryButton}
                  >
                    <Text style={styles.recoveryButtonText}>Resume</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => void performRecoveryAction(`extensions/${extension.id}/stop`)}
                    style={styles.recoveryButton}
                  >
                    <Text style={styles.recoveryButtonText}>Stop</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => void performRecoveryAction(`extensions/${extension.id}/restart`)}
                    style={styles.recoveryButton}
                  >
                    <Text style={styles.recoveryButtonText}>Restart</Text>
                  </Pressable>
                </>
              ) : null}
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
  recoveryError: {
    color: theme.danger,
    fontSize: 13,
    lineHeight: 18,
  },
  recoveryTitle: {
    color: theme.text,
    fontSize: 17,
    fontWeight: '800',
  },
  });
}

function guardianRecoverySummary(guardian: ReturnType<typeof useRemuxConnection>['guardian']) {
  if (guardian.state !== 'available' || !guardian.status) {
    return 'The core app is unavailable, but its guardian is responding.';
  }
  const failures = guardian.status.consecutiveBootFailures;
  const failureText = failures > 0
    ? ` · ${failures} failed ${failures === 1 ? 'start' : 'starts'}`
    : '';
  return `Runtime ${guardian.status.workerState}${failureText}. Guardian controls remain available.`;
}
