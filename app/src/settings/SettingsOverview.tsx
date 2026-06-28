import {
  useCallback,
  useEffect,
  useState,
  type ComponentProps,
  type ReactNode,
} from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { getBottomBarHeight, tabGridGap, tabGridHorizontalPadding } from '../browser/browserLayout';
import { useBrowserStore } from '../browser/browserStore';
import { useRemuxConnection } from '../remote/RemuxConnectionProvider';
import { useRemuxSettingsStore } from '../remote/remuxSettingsStore';
import { colors } from '../theme/tokens';
import {
  readExtensionServerStatuses,
  restartExtensionServer,
  setExtensionServerRunning,
  type ExtensionServerStatus,
} from './extensionServerApi';
import { restartRemuxCli } from './remuxSystemApi';

export function SettingsOverview() {
  const catalogError = useBrowserStore((state) => state.catalogError);
  const extensions = useBrowserStore((state) => state.extensions);
  const loadExtensions = useBrowserStore((state) => state.loadExtensions);
  const reloadExtensionTabs = useBrowserStore((state) => state.reloadExtensionTabs);
  const connection = useRemuxConnection();
  const insets = useSafeAreaInsets();
  const host = useRemuxSettingsStore((state) => state.host);
  const loadSettings = useRemuxSettingsStore((state) => state.loadSettings);
  const port = useRemuxSettingsStore((state) => state.port);
  const saveSettings = useRemuxSettingsStore((state) => state.saveSettings);
  const settingsError = useRemuxSettingsStore((state) => state.error);
  const settingsStatus = useRemuxSettingsStore((state) => state.status);
  const [extensionStatuses, setExtensionStatuses] = useState<Record<string, ExtensionServerStatus>>({});
  const [extensionStatusError, setExtensionStatusError] = useState<string | null>(null);
  const [extensionStatusLoading, setExtensionStatusLoading] = useState(false);
  const [restartingExtensionId, setRestartingExtensionId] = useState<string | null>(null);
  const [restartingRemux, setRestartingRemux] = useState(false);
  const [togglingExtensionId, setTogglingExtensionId] = useState<string | null>(null);
  const [draftHost, setDraftHost] = useState(host);
  const [draftPort, setDraftPort] = useState(String(port));
  const [actionError, setActionError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const bottomPadding = getBottomBarHeight(insets.bottom) + tabGridGap;

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  useEffect(() => {
    setDraftHost(host);
    setDraftPort(String(port));
  }, [host, port]);

  const saveAndReconnect = async () => {
    setActionError(null);
    setSaving(true);
    try {
      await saveSettings({
        host: draftHost,
        port: draftPort,
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

  const restartExtension = async (extensionId: string) => {
    setActionError(null);
    setExtensionStatusError(null);
    setRestartingExtensionId(extensionId);
    try {
      const status = await restartExtensionServer(connection.request, extensionId);
      setExtensionStatuses((current) => ({
        ...current,
        [extensionId]: status,
      }));
      reloadExtensionTabs(extensionId);
    } catch (error) {
      setExtensionStatusError(error instanceof Error ? error.message : String(error));
    } finally {
      setRestartingExtensionId(null);
    }
  };

  const toggleExtension = async (extensionId: string, running: boolean) => {
    setActionError(null);
    setExtensionStatusError(null);
    setTogglingExtensionId(extensionId);
    try {
      const status = await setExtensionServerRunning(connection.request, extensionId, running);
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
      setTogglingExtensionId(null);
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
          </View>
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

        <Section title="Extensions">
          {catalogError ? <Text style={styles.errorText}>{catalogError}</Text> : null}
          {extensionStatusError ? <Text style={styles.errorText}>{extensionStatusError}</Text> : null}
          {extensionStatusLoading ? (
            <View style={styles.extensionLoadingRow}>
              <ActivityIndicator color={colors.muted} size="small" />
              <Text style={styles.extensionMeta}>Checking extension servers</Text>
            </View>
          ) : null}
          <View style={styles.extensionList}>
            {extensions.map((extension) => (
              <ExtensionRow
                iconUrl={extension.display.iconUrl}
                key={extension.id}
                name={extension.display.title}
                onRestart={() => restartExtension(extension.id)}
                onToggle={(running) => toggleExtension(extension.id, running)}
                restarting={restartingExtensionId === extension.id}
                status={extensionStatuses[extension.id] ?? null}
                toggling={togglingExtensionId === extension.id}
              />
            ))}
            {extensions.length === 0 ? (
              <Text style={styles.extensionMeta}>No extensions loaded.</Text>
            ) : null}
          </View>
        </Section>
      </ScrollView>
    </View>
  );
}

function Section({ children, title }: { children: ReactNode; title: string }) {
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
  return (
    <View style={styles.inputShell}>
      <Text style={styles.inputLabel}>{label}</Text>
      <TextInput
        {...props}
        placeholderTextColor="#696971"
        selectionColor="#7aa2ff"
        style={styles.input}
      />
    </View>
  );
}

function ConnectionPill({ status }: { status: string }) {
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
      {loading ? <ActivityIndicator color="#f4f4f5" size="small" /> : null}
      <Text style={styles.buttonText}>{label}</Text>
    </Pressable>
  );
}

function ExtensionRow({
  iconUrl,
  name,
  onRestart,
  onToggle,
  restarting,
  status,
  toggling,
}: {
  iconUrl: string | null;
  name: string;
  onRestart: () => void;
  onToggle: (running: boolean) => void;
  restarting: boolean;
  status: ExtensionServerStatus | null;
  toggling: boolean;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  const controllable = Boolean(status?.restartable);
  const busy = restarting || toggling;
  const hasServer = Boolean(status);

  return (
    <View style={styles.extensionRow}>
      <View style={styles.extensionIconFrame}>
        {iconUrl && !imageFailed ? (
          <Image
            accessibilityIgnoresInvertColors
            onError={() => setImageFailed(true)}
            resizeMode="contain"
            source={{ uri: iconUrl }}
            style={styles.extensionIcon}
          />
        ) : (
          <Text style={styles.extensionFallback}>{name.slice(0, 1)}</Text>
        )}
      </View>
      <View style={styles.extensionText}>
        <Text numberOfLines={1} style={styles.extensionName}>{name}</Text>
        <Text style={styles.extensionMeta}>{serverStatusText(status)}</Text>
      </View>
      {hasServer ? (
        <View style={styles.extensionActions}>
          {toggling ? (
            <View style={styles.extensionToggleBusy}>
              <ActivityIndicator color={colors.muted} size="small" />
            </View>
          ) : (
            <Switch
              disabled={!controllable || busy}
              ios_backgroundColor="#2b2c31"
              onValueChange={onToggle}
              thumbColor="#f4f4f5"
              trackColor={{ false: '#2b2c31', true: '#3a5f9f' }}
              value={status?.running === true}
            />
          )}
          <SettingsButton
            disabled={!controllable || !status?.running || busy}
            label={restarting ? 'Restarting' : 'Restart'}
            loading={restarting}
            onPress={onRestart}
          />
        </View>
      ) : null}
    </View>
  );
}

function serverStatusText(status: ExtensionServerStatus | null) {
  if (!status) {
    return 'No server extension';
  }

  return status.running ? 'Running' : 'Stopped';
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

const styles = StyleSheet.create({
  actionRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 14,
  },
  button: {
    alignItems: 'center',
    backgroundColor: '#202126',
    borderColor: '#32343a',
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
    color: colors.text,
    fontSize: 13,
    fontWeight: '700',
    lineHeight: 18,
  },
  connectionDot: {
    backgroundColor: '#ef4444',
    borderRadius: 4,
    height: 8,
    width: 8,
  },
  connectionDotConnected: {
    backgroundColor: '#22c55e',
  },
  connectionPill: {
    alignItems: 'center',
    backgroundColor: '#18181b',
    borderColor: '#2b2b31',
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 8,
    minHeight: 34,
    paddingHorizontal: 12,
  },
  connectionText: {
    color: colors.text,
    fontSize: 12,
    fontWeight: '700',
    lineHeight: 16,
  },
  container: {
    backgroundColor: colors.background,
    flex: 1,
  },
  content: {
    gap: 24,
    paddingHorizontal: tabGridHorizontalPadding,
  },
  errorText: {
    color: '#fca5a5',
    fontSize: 12,
    lineHeight: 17,
    marginTop: 10,
  },
  extensionFallback: {
    color: colors.text,
    fontSize: 17,
    fontWeight: '800',
    lineHeight: 22,
  },
  extensionActions: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
  },
  extensionIcon: {
    height: 24,
    width: 24,
  },
  extensionIconFrame: {
    alignItems: 'center',
    backgroundColor: '#24252b',
    borderColor: '#33353d',
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
    color: colors.muted,
    fontSize: 12,
    lineHeight: 16,
  },
  extensionName: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '700',
    lineHeight: 21,
  },
  extensionRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    minHeight: 56,
  },
  extensionText: {
    flex: 1,
    gap: 2,
  },
  extensionToggleBusy: {
    alignItems: 'center',
    height: 32,
    justifyContent: 'center',
    width: 48,
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
    color: colors.text,
    flex: 1,
    fontSize: 16,
    fontWeight: '600',
    lineHeight: 20,
    padding: 0,
  },
  inputLabel: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: '700',
    lineHeight: 16,
    width: 52,
  },
  inputShell: {
    alignItems: 'center',
    backgroundColor: '#151518',
    borderColor: '#2a2a2f',
    borderRadius: 14,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 12,
    minHeight: 48,
    paddingHorizontal: 14,
  },
  primaryButton: {
    backgroundColor: '#26324c',
    borderColor: '#3a5f9f',
  },
  section: {
    gap: 8,
  },
  sectionPanel: {
    backgroundColor: '#0f0f11',
    borderColor: '#242429',
    borderRadius: 18,
    borderWidth: 1,
    padding: 14,
  },
  sectionTitle: {
    color: colors.text,
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 0.6,
    lineHeight: 18,
    textTransform: 'uppercase',
  },
  subtitle: {
    color: colors.muted,
    fontSize: 13,
    lineHeight: 18,
    marginTop: 2,
  },
  title: {
    color: colors.text,
    fontSize: 24,
    fontWeight: '800',
    lineHeight: 30,
  },
});
