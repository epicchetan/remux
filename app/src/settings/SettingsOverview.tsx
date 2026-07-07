import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ComponentProps,
  type ReactNode,
} from 'react';
import Constants from 'expo-constants';
import { Host, SecureField, TextField, useNativeState } from '@expo/ui/swift-ui';
import {
  autocorrectionDisabled,
  font,
  foregroundStyle,
  textFieldStyle,
  textInputAutocapitalization,
} from '@expo/ui/swift-ui/modifiers';
import * as Updates from 'expo-updates';
import {
  ActivityIndicator,
  Image,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { getBottomBarHeight, tabGridGap, tabGridHorizontalPadding } from '../browser/browserLayout';
import { useBrowserStore } from '../browser/browserStore';
import { useRemuxConnection, type RemuxConnection } from '../remote/RemuxConnectionProvider';
import { remuxImageSource, themedIconUrl } from '../remote/remuxExtensions';
import { useRemuxSettingsStore } from '../remote/remuxSettingsStore';
import { alpha, useTheme, type RemuxTheme } from '../theme/ThemeProvider';
import { ExtensionDetailSheet, type ExtensionDetailAction } from './ExtensionDetailSheet';
import {
  extensionDidChangeStatusMethod,
  parseExtensionServerStatus,
  readExtensionServerStatuses,
  restartExtensionServer,
  setExtensionServerRunning,
  type ExtensionServerStatus,
} from './extensionServerApi';
import { formatBytes, formatDurationMs, formatLastExit, formatUptime, serverStateLabel, serverStateTone } from './formatters';
import { restartRemuxCli } from './remuxSystemApi';
import {
  parseSystemResourcesSample,
  readSystemResources,
  subscribeSystemResources,
  systemResourcesDidSampleMethod,
  unsubscribeSystemResources,
  type SystemResourcesSample,
} from './systemResourcesApi';

export function SettingsOverview() {
  const catalogError = useBrowserStore((state) => state.catalogError);
  const extensions = useBrowserStore((state) => state.extensions);
  const reloadExtensionTabs = useBrowserStore((state) => state.reloadExtensionTabs);
  const connection = useRemuxConnection();
  const insets = useSafeAreaInsets();
  const [extensionStatuses, setExtensionStatuses] = useState<Record<string, ExtensionServerStatus>>({});
  const [extensionStatusError, setExtensionStatusError] = useState<string | null>(null);
  const [extensionStatusLoading, setExtensionStatusLoading] = useState(false);
  const [detailExtensionId, setDetailExtensionId] = useState<string | null>(null);
  const [detailBusyAction, setDetailBusyAction] = useState<ExtensionDetailAction | null>(null);
  const resources = useSystemResources(connection);
  const nowMinuteMs = useMinuteTick();
  const bottomPadding = getBottomBarHeight(insets.bottom) + tabGridGap;
  const { styles, theme } = useSettingsTheme();
  const { availableUpdate, currentlyRunning, isUpdatePending } = Updates.useUpdates();
  const [updateAction, setUpdateAction] = useState<'idle' | 'checking' | 'downloading' | 'restarting'>('idle');
  const [updateStatus, setUpdateStatus] = useState<string | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const updateInfo = useMemo(() => deployedUpdateInfo(currentlyRunning), [currentlyRunning]);

  const refreshServerStatuses = useCallback(async () => {
    if (connection.status.type !== 'connected') {
      setExtensionStatuses({});
      return;
    }

    setExtensionStatusLoading(true);
    setExtensionStatusError(null);
    try {
      const statuses = await readExtensionServerStatuses(connection.request);
      setExtensionStatuses(Object.fromEntries(statuses.map((status) => [status.extensionId, status])));
    } catch (error) {
      setExtensionStatusError(error instanceof Error ? error.message : String(error));
    } finally {
      setExtensionStatusLoading(false);
    }
  }, [connection.request, connection.status.type]);

  useEffect(() => {
    void refreshServerStatuses();
  }, [extensions.length, refreshServerStatuses]);

  // Live states: merge `didChangeStatus` broadcasts so crash → backingOff →
  // running is visible without a manual refresh.
  useEffect(() => connection.subscribe((message) => {
    if (message.method !== extensionDidChangeStatusMethod) {
      return;
    }
    const status = parseExtensionServerStatus(message.params);
    if (!status) {
      return;
    }
    setExtensionStatuses((current) => ({
      ...current,
      [status.extensionId]: status,
    }));
  }), [connection]);

  const runDetailAction = async (extensionId: string, action: ExtensionDetailAction) => {
    setExtensionStatusError(null);
    setDetailBusyAction(action);
    try {
      const status = action === 'restart' || action === 'rebuild'
        ? await restartExtensionServer(connection.request, extensionId, { rebuild: action === 'rebuild' })
        : await setExtensionServerRunning(connection.request, extensionId, action === 'start');
      setExtensionStatuses((current) => ({
        ...current,
        [extensionId]: status,
      }));
      if (status.running) {
        reloadExtensionTabs(extensionId);
      }
    } catch (error) {
      setExtensionStatusError(error instanceof Error ? error.message : String(error));
    } finally {
      setDetailBusyAction(null);
    }
  };

  // One button drives the whole flow: an already-downloaded update restarts
  // straight into place, otherwise check, download, and restart.
  const applyUpdate = async () => {
    setUpdateError(null);
    setUpdateStatus(null);
    try {
      if (!isUpdatePending) {
        setUpdateAction('checking');
        const check = await Updates.checkForUpdateAsync();
        if (!check.isAvailable) {
          setUpdateStatus('Already up to date.');
          return;
        }

        setUpdateAction('downloading');
        await Updates.fetchUpdateAsync();
      }

      setUpdateAction('restarting');
      await Updates.reloadAsync();
    } catch (error) {
      setUpdateError(error instanceof Error ? error.message : String(error));
    } finally {
      setUpdateAction('idle');
    }
  };

  return (
    <View style={styles.container}>
      <ScrollView
        contentContainerStyle={[
          styles.content,
          {
            paddingBottom: bottomPadding,
            paddingTop: Math.max(insets.top + 12, 28),
          },
        ]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.header}>
          <View>
            <Text style={styles.title}>Settings</Text>
            <Text style={styles.subtitle}>Remux host and extensions</Text>
          </View>
          <ConnectionPill status={connection.status.type} />
        </View>

        <ConnectionSection />

        <Section title="Extensions">
          {catalogError ? <Text style={styles.errorText}>{catalogError}</Text> : null}
          {extensionStatusError ? <Text style={styles.errorText}>{extensionStatusError}</Text> : null}
          {extensionStatusLoading ? (
            <View style={styles.extensionLoadingRow}>
              <ActivityIndicator color={theme.textMuted} size="small" />
              <Text style={styles.extensionMeta}>Checking extension servers</Text>
            </View>
          ) : null}
          <View style={styles.extensionList}>
            {extensions.map((extension) => (
              <ExtensionRow
                extensionId={extension.id}
                iconDarkUrl={extension.display.iconDarkUrl}
                iconUrl={extension.display.iconUrl}
                key={extension.id}
                name={extension.display.title}
                nowMs={nowMinuteMs}
                onOpenDetails={setDetailExtensionId}
                status={extensionStatuses[extension.id] ?? null}
              />
            ))}
            {extensions.length === 0 ? (
              <Text style={styles.extensionMeta}>No extensions loaded.</Text>
            ) : null}
          </View>
        </Section>

        {resources ? <SystemSection sample={resources} /> : null}

        <Section title="Updates">
          <View style={styles.infoList}>
            {updateInfo.map((item) => (
              <InfoRow key={item.label} label={item.label} value={item.value} />
            ))}
          </View>
          <View style={styles.actionRow}>
            <SettingsButton
              disabled={!Updates.isEnabled || updateAction !== 'idle'}
              label={updateButtonLabel(updateAction, isUpdatePending)}
              loading={updateAction !== 'idle'}
              onPress={applyUpdate}
              variant="primary"
            />
          </View>
          {availableUpdate ? (
            <Text style={styles.updateStatusText}>
              {`Available: ${updateMessageFromManifest(availableUpdate.manifest) ?? availableUpdate.updateId ?? 'new update'}`}
            </Text>
          ) : null}
          {!Updates.isEnabled ? (
            <Text style={styles.updateStatusText}>Updates are disabled in this build.</Text>
          ) : null}
          {updateStatus ? <Text style={styles.updateStatusText}>{updateStatus}</Text> : null}
          {updateError ? <Text style={styles.errorText}>{updateError}</Text> : null}
        </Section>
      </ScrollView>

      <ExtensionDetailSheet
        busyAction={detailBusyAction}
        name={extensions.find((extension) => extension.id === detailExtensionId)?.display.title ?? detailExtensionId ?? ''}
        onAction={(action) => {
          if (detailExtensionId) {
            void runDetailAction(detailExtensionId, action);
          }
        }}
        onClose={() => setDetailExtensionId(null)}
        resources={resources?.extensions.find((entry) => entry.extensionId === detailExtensionId) ?? null}
        status={detailExtensionId ? extensionStatuses[detailExtensionId] ?? null : null}
        visible={detailExtensionId !== null}
      />
    </View>
  );
}

/**
 * Memoized with no props so the overview's periodic re-renders (5s resource
 * samples, 30s uptime ticks) never reach these inputs: iOS visibly flashes a
 * focused controlled `secureTextEntry` field every time its value is re-set.
 */
const ConnectionSection = memo(function ConnectionSection() {
  const { styles, theme } = useSettingsTheme();
  const connection = useRemuxConnection();
  const loadExtensions = useBrowserStore((state) => state.loadExtensions);
  const host = useRemuxSettingsStore((state) => state.host);
  const loadSettings = useRemuxSettingsStore((state) => state.loadSettings);
  const port = useRemuxSettingsStore((state) => state.port);
  const saveSettings = useRemuxSettingsStore((state) => state.saveSettings);
  const settingsError = useRemuxSettingsStore((state) => state.error);
  const settingsStatus = useRemuxSettingsStore((state) => state.status);
  const token = useRemuxSettingsStore((state) => state.token);
  const [draftHost, setDraftHost] = useState(host);
  const [draftPort, setDraftPort] = useState(String(port));
  // The token draft lives in native ObservableState on the UI thread, not in
  // React state: RN's controlled secureTextEntry input redraws its dots every
  // time a render re-sets `value`, which reads as flicker. The SwiftUI field
  // bound to this state never sees React renders at all.
  const tokenState = useNativeState(token);
  const [showToken, setShowToken] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [restartingRemux, setRestartingRemux] = useState(false);
  const tokenFieldModifiers = useMemo(() => [
    textFieldStyle('plain'),
    font({ size: 16, weight: 'semibold' }),
    foregroundStyle(theme.text),
    autocorrectionDisabled(),
    textInputAutocapitalization('never'),
  ], [theme.text]);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  useEffect(() => {
    setDraftHost(host);
    setDraftPort(String(port));
  }, [host, port]);

  useEffect(() => {
    tokenState.set(token);
  }, [token, tokenState]);

  const saveAndReconnect = async () => {
    setActionError(null);
    setSaving(true);
    try {
      await saveSettings({
        host: draftHost,
        port: draftPort,
        token: tokenState.get(),
      });
      await loadExtensions({ force: true });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const restartRemux = async () => {
    setActionError(null);
    setRestartingRemux(true);
    try {
      const result = await restartRemuxCli(connection.request);
      if (!result.restartable) {
        throw new Error('Remux CLI restart is unavailable');
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setRestartingRemux(false);
    }
  };

  return (
    <Section title="Connection">
      <View style={styles.fieldGroup}>
        <LabeledInput
          autoCapitalize="none"
          autoCorrect={false}
          label="Host"
          onChangeText={setDraftHost}
          placeholder="100.65.220.71"
          value={draftHost}
        />
        <LabeledInput
          keyboardType="number-pad"
          label="Port"
          onChangeText={setDraftPort}
          placeholder="48123"
          value={draftPort}
        />
        <View style={styles.inputShell}>
          <Text style={styles.inputLabel}>Token</Text>
          <Host style={styles.tokenFieldHost}>
            {showToken ? (
              <TextField
                modifiers={tokenFieldModifiers}
                placeholder="run: remux token"
                text={tokenState}
              />
            ) : (
              <SecureField
                modifiers={tokenFieldModifiers}
                placeholder="run: remux token"
                text={tokenState}
              />
            )}
          </Host>
        </View>
      </View>
      <Pressable hitSlop={8} onPress={() => setShowToken((visible) => !visible)}>
        <Text style={styles.tokenToggle}>{showToken ? 'Hide token' : 'Show token'}</Text>
      </Pressable>
      <View style={styles.actionRow}>
        <SettingsButton
          disabled={saving || settingsStatus === 'saving'}
          label={saving || settingsStatus === 'saving' ? 'Saving' : 'Save & Reconnect'}
          loading={saving || settingsStatus === 'saving'}
          onPress={saveAndReconnect}
          variant="primary"
        />
        <SettingsButton
          disabled={connection.status.type !== 'connected' || restartingRemux}
          label={restartingRemux ? 'Restarting' : 'Restart Remux'}
          loading={restartingRemux}
          onPress={restartRemux}
        />
      </View>
      {connection.error ? <Text style={styles.errorText}>{connection.error}</Text> : null}
      {settingsError ? <Text style={styles.errorText}>{settingsError}</Text> : null}
      {actionError ? <Text style={styles.errorText}>{actionError}</Text> : null}
    </Section>
  );
});

/**
 * Sampler feed, alive exactly while Settings is mounted (the overview
 * unmounts this surface when it is not visible). `null` against a pass-1
 * runtime — the System section hides.
 */
function useSystemResources(connection: RemuxConnection) {
  const [sample, setSample] = useState<SystemResourcesSample | null>(null);
  const connected = connection.status.type === 'connected';

  useEffect(() => {
    if (!connected) {
      setSample(null);
      return undefined;
    }

    let cancelled = false;
    let subscribed = false;
    void (async () => {
      try {
        const snapshot = await readSystemResources(connection.request);
        if (cancelled || !snapshot) {
          return; // Unsupported runtime — leave the section hidden.
        }
        setSample(snapshot);
        await subscribeSystemResources(connection.request);
        subscribed = true;
      } catch {
        // Snapshot/subscribe failure just leaves the section static/hidden.
      }
    })();

    const unsubscribeMessages = connection.subscribe((message) => {
      if (message.method !== systemResourcesDidSampleMethod) {
        return;
      }
      const next = parseSystemResourcesSample(message.params);
      if (next) {
        setSample(next);
      }
    });

    return () => {
      cancelled = true;
      unsubscribeMessages();
      if (subscribed) {
        void unsubscribeSystemResources(connection.request).catch(() => undefined);
      }
    };
  }, [connected, connection]);

  return sample;
}

/** Minute-granularity clock for the row uptime labels. */
function useMinuteTick() {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  return nowMs;
}

function SystemSection({ sample }: { sample: SystemResourcesSample }) {
  const { styles } = useSettingsTheme();
  const memUsed = Math.max(0, sample.system.memTotalBytes - sample.system.memAvailableBytes);

  return (
    <Section title="System">
      <View style={styles.infoList}>
        <InfoRow
          label="Load"
          value={`${sample.system.load1.toFixed(2)} · ${sample.system.load5.toFixed(2)} · ${sample.system.load15.toFixed(2)}`}
        />
        <InfoRow
          label="Memory"
          value={`${formatBytes(memUsed)} of ${formatBytes(sample.system.memTotalBytes)}`}
        />
        <InfoRow
          label="Disk free"
          value={`${formatBytes(sample.system.diskFreeBytes)} of ${formatBytes(sample.system.diskTotalBytes)}`}
        />
        <InfoRow
          label="Runtime"
          value={`${sample.runtime.cpuPercent.toFixed(1)}% CPU · ${formatBytes(sample.runtime.rssBytes)} · up ${formatDurationMs(sample.runtime.uptimeMs)}`}
        />
      </View>
    </Section>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  const { styles } = useSettingsTheme();

  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text selectable style={styles.infoValue}>{value}</Text>
    </View>
  );
}

function Section({ children, title }: { children: ReactNode; title: string }) {
  const { styles } = useSettingsTheme();

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={styles.sectionPanel}>{children}</View>
    </View>
  );
}

function LabeledInput({
  label,
  ...props
}: ComponentProps<typeof TextInput> & {
  label: string;
}) {
  const { styles, theme } = useSettingsTheme();

  return (
    <View style={styles.inputShell}>
      <Text style={styles.inputLabel}>{label}</Text>
      <TextInput
        {...props}
        placeholderTextColor={alpha(theme.textMuted, 0.72)}
        selectionColor={theme.focusRing}
        style={styles.input}
      />
    </View>
  );
}

function ConnectionPill({ status }: { status: string }) {
  const { styles } = useSettingsTheme();

  return (
    <View style={styles.connectionPill}>
      <View style={[styles.connectionDot, status === 'connected' ? styles.connectionDotConnected : null]} />
      <Text style={styles.connectionText}>{statusLabel(status)}</Text>
    </View>
  );
}

function SettingsButton({
  disabled = false,
  label,
  loading = false,
  onPress,
  variant = 'secondary',
}: {
  disabled?: boolean;
  label: string;
  loading?: boolean;
  onPress: () => void | Promise<void>;
  variant?: 'primary' | 'secondary';
}) {
  const { styles, theme } = useSettingsTheme();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={() => {
        void onPress();
      }}
      style={({ pressed }) => [
        styles.button,
        variant === 'primary' ? styles.primaryButton : null,
        pressed && !disabled ? styles.buttonPressed : null,
        disabled ? styles.buttonDisabled : null,
      ]}
    >
      {loading ? <ActivityIndicator color={variant === 'primary' ? theme.accentForeground : theme.text} size="small" /> : null}
      <Text style={styles.buttonText}>{label}</Text>
    </Pressable>
  );
}

const ExtensionRow = memo(function ExtensionRow({
  extensionId,
  iconDarkUrl,
  iconUrl,
  name,
  nowMs,
  onOpenDetails,
  status,
}: {
  extensionId: string;
  iconDarkUrl: string | null;
  iconUrl: string | null;
  name: string;
  nowMs: number;
  onOpenDetails: (extensionId: string) => void;
  status: ExtensionServerStatus | null;
}) {
  const { styles, theme } = useSettingsTheme();
  const [imageFailed, setImageFailed] = useState(false);
  const hasServer = Boolean(status);
  const themedUrl = themedIconUrl({ iconDarkUrl, iconUrl }, theme.isDark);

  return (
    <Pressable
      accessibilityLabel={`${name} server details`}
      accessibilityRole="button"
      disabled={!hasServer}
      onPress={() => onOpenDetails(extensionId)}
      style={({ pressed }) => [styles.extensionRow, pressed && hasServer ? styles.extensionRowPressed : null]}
    >
      <View style={styles.extensionIconFrame}>
        {themedUrl && !imageFailed ? (
          <Image
            accessibilityIgnoresInvertColors
            onError={() => setImageFailed(true)}
            resizeMode="contain"
            source={remuxImageSource(themedUrl)}
            style={styles.extensionIcon}
          />
        ) : (
          <Text style={styles.extensionFallback}>{name.slice(0, 1)}</Text>
        )}
      </View>
      <View style={styles.extensionText}>
        <Text numberOfLines={1} style={styles.extensionName}>{name}</Text>
        <View style={styles.extensionMetaRow}>
          {status ? <StateDot state={status.state} /> : null}
          <Text numberOfLines={1} style={styles.extensionMeta}>{serverStatusText(status, nowMs)}</Text>
        </View>
      </View>
      {hasServer ? <Text style={styles.extensionChevron}>›</Text> : null}
    </Pressable>
  );
});

function StateDot({ state }: { state: ExtensionServerStatus['state'] }) {
  const { styles, theme } = useSettingsTheme();
  const tone = serverStateTone(state);
  const color = tone === 'ok'
    ? theme.success
    : tone === 'bad'
      ? theme.danger
      : tone === 'busy'
        ? theme.warning
        : theme.textMuted;

  return <View style={[styles.stateDot, { backgroundColor: color }]} />;
}

function serverStatusText(status: ExtensionServerStatus | null, nowMs: number) {
  if (!status) {
    return 'No server extension';
  }

  const parts: string[] = [serverStateLabel(status.state)];
  const uptime = status.running ? formatUptime(status.startedAtMs, nowMs) : null;
  if (uptime) {
    parts.push(uptime);
  }
  if (status.state === 'failed') {
    const lastExit = formatLastExit(status.lastExit);
    if (lastExit) {
      parts.push(lastExit);
    }
  }
  if (status.restartCount > 0) {
    parts.push(`${status.restartCount} ${status.restartCount === 1 ? 'restart' : 'restarts'}`);
  }
  return parts.join(' · ');
}

function statusLabel(status: string) {
  switch (status) {
    case 'connected':
      return 'Connected';
    case 'connecting':
      return 'Connecting';
    case 'reconnecting':
      return 'Reconnecting';
    default:
      return 'Offline';
  }
}

function deployedUpdateInfo(currentlyRunning: Updates.CurrentlyRunningInfo) {
  const message = updateMessageFromManifest(currentlyRunning.manifest)
    ?? configExtraString(Constants.expoConfig?.extra, 'updateMessage');
  const rows = [
    { label: 'Message', value: message ?? (currentlyRunning.isEmbeddedLaunch ? 'Embedded build' : 'None') },
    { label: 'Published', value: currentlyRunning.createdAt ? formatDateTime(currentlyRunning.createdAt) : 'Unknown' },
    { label: 'Source', value: currentlyRunning.isEmbeddedLaunch ? 'Embedded bundle' : 'OTA update' },
    { label: 'Channel', value: currentlyRunning.channel ?? 'None' },
    { label: 'Runtime', value: currentlyRunning.runtimeVersion ?? 'Unknown' },
    { label: 'Update ID', value: currentlyRunning.updateId ?? 'None' },
    { label: 'App version', value: `${Constants.expoConfig?.version ?? 'Unknown'} (${nativeBuildText()})` },
  ];

  if (currentlyRunning.isEmergencyLaunch) {
    rows.push({
      label: 'Emergency',
      value: currentlyRunning.emergencyLaunchReason ?? 'Fell back to the embedded bundle',
    });
  }

  return rows;
}

// The publish flow embeds `--message` at extra.updateMessage via app.config.js;
// EAS itself never delivers the message to devices.
function updateMessageFromManifest(manifest: Partial<Updates.Manifest> | undefined) {
  if (!manifest || !('extra' in manifest)) {
    return null;
  }

  return configExtraString(manifest.extra?.expoClient?.extra, 'updateMessage');
}

function configExtraString(extra: Record<string, unknown> | null | undefined, key: string) {
  const value = extra?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function updateButtonLabel(action: 'idle' | 'checking' | 'downloading' | 'restarting', isUpdatePending: boolean) {
  switch (action) {
    case 'checking':
      return 'Checking';
    case 'downloading':
      return 'Downloading';
    case 'restarting':
      return 'Restarting';
    default:
      return isUpdatePending ? 'Restart to update' : 'Check for updates';
  }
}

// Local time without Intl (Hermes builds vary in locale support).
function formatDateTime(date: Date) {
  if (Number.isNaN(date.getTime())) {
    return 'Unknown';
  }

  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function nativeBuildText() {
  if (Platform.OS === 'ios') {
    return Constants.platform?.ios?.buildNumber
      ?? Constants.expoConfig?.ios?.buildNumber
      ?? 'Unavailable';
  }

  if (Platform.OS === 'android') {
    const versionCode = Constants.platform?.android?.versionCode
      ?? Constants.expoConfig?.android?.versionCode
      ?? null;
    return versionCode === null || versionCode === undefined ? 'Unavailable' : String(versionCode);
  }

  return 'Unavailable';
}

function useSettingsTheme() {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  return { styles, theme };
}

function createStyles(theme: RemuxTheme) {
  return StyleSheet.create({
  actionRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 14,
  },
  button: {
    alignItems: 'center',
    backgroundColor: theme.surfaceHover,
    borderColor: theme.border,
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 8,
    minHeight: 38,
    paddingHorizontal: 14,
  },
  buttonDisabled: {
    opacity: 0.45,
  },
  buttonPressed: {
    opacity: 0.72,
  },
  buttonText: {
    color: theme.text,
    fontSize: 13,
    fontWeight: '700',
    lineHeight: 18,
  },
  connectionDot: {
    backgroundColor: theme.danger,
    borderRadius: 4,
    height: 8,
    width: 8,
  },
  connectionDotConnected: {
    backgroundColor: theme.success,
  },
  connectionPill: {
    alignItems: 'center',
    backgroundColor: theme.surfaceRaised,
    borderColor: theme.border,
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 8,
    minHeight: 34,
    paddingHorizontal: 12,
  },
  connectionText: {
    color: theme.text,
    fontSize: 12,
    fontWeight: '700',
    lineHeight: 16,
  },
  container: {
    backgroundColor: theme.surface,
    flex: 1,
  },
  content: {
    gap: 24,
    paddingHorizontal: tabGridHorizontalPadding,
  },
  errorText: {
    color: theme.danger,
    fontSize: 12,
    lineHeight: 17,
    marginTop: 10,
  },
  extensionFallback: {
    color: theme.text,
    fontSize: 17,
    fontWeight: '800',
    lineHeight: 22,
  },
  extensionChevron: {
    color: theme.textMuted,
    fontSize: 22,
    fontWeight: '600',
    lineHeight: 26,
  },
  extensionIcon: {
    height: 24,
    width: 24,
  },
  extensionIconFrame: {
    alignItems: 'center',
    backgroundColor: theme.surfaceHover,
    borderColor: theme.border,
    borderRadius: 12,
    borderWidth: 1,
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  extensionList: {
    gap: 10,
  },
  extensionLoadingRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
    marginBottom: 10,
  },
  extensionMeta: {
    color: theme.textMuted,
    flexShrink: 1,
    fontSize: 12,
    lineHeight: 16,
  },
  extensionName: {
    color: theme.text,
    fontSize: 16,
    fontWeight: '700',
    lineHeight: 21,
  },
  extensionMetaRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 6,
  },
  extensionRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    minHeight: 56,
  },
  extensionRowPressed: {
    opacity: 0.72,
  },
  extensionText: {
    flex: 1,
    gap: 2,
  },
  stateDot: {
    borderRadius: 3.5,
    height: 7,
    width: 7,
  },
  fieldGroup: {
    gap: 10,
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  input: {
    color: theme.text,
    flex: 1,
    fontSize: 16,
    fontWeight: '600',
    lineHeight: 20,
    padding: 0,
  },
  tokenFieldHost: {
    flex: 1,
    height: 22,
  },
  tokenToggle: {
    alignSelf: 'flex-end',
    color: theme.textMuted,
    fontSize: 12,
    fontWeight: '600',
    lineHeight: 16,
  },
  inputLabel: {
    color: theme.textMuted,
    fontSize: 12,
    fontWeight: '700',
    lineHeight: 16,
    width: 52,
  },
  inputShell: {
    alignItems: 'center',
    backgroundColor: theme.surfaceRaised,
    borderColor: theme.border,
    borderRadius: 14,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 12,
    minHeight: 48,
    paddingHorizontal: 14,
  },
  infoLabel: {
    color: theme.textMuted,
    flexShrink: 0,
    fontSize: 12,
    fontWeight: '700',
    lineHeight: 16,
    width: 116,
  },
  infoList: {
    gap: 10,
  },
  infoRow: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: 12,
  },
  infoValue: {
    color: theme.text,
    flex: 1,
    fontSize: 13,
    fontWeight: '600',
    lineHeight: 18,
  },
  primaryButton: {
    backgroundColor: alpha(theme.focusRing, 0.16),
    borderColor: theme.focusRing,
  },
  section: {
    gap: 8,
  },
  sectionPanel: {
    backgroundColor: theme.surfaceRaised,
    borderColor: theme.border,
    borderRadius: 18,
    borderWidth: 1,
    padding: 14,
  },
  sectionTitle: {
    color: theme.text,
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 0.6,
    lineHeight: 18,
    textTransform: 'uppercase',
  },
  subtitle: {
    color: theme.textMuted,
    fontSize: 13,
    lineHeight: 18,
    marginTop: 2,
  },
  title: {
    color: theme.text,
    fontSize: 24,
    fontWeight: '800',
    lineHeight: 30,
  },
  updateStatusText: {
    color: theme.textMuted,
    fontSize: 12,
    lineHeight: 17,
    marginTop: 10,
  },
  });
}
