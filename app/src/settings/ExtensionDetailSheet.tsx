import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useRemuxConnection } from '../remote/RemuxConnectionProvider';
import { alpha, useTheme, type RemuxTheme } from '../theme/ThemeProvider';
import {
  extensionLogsDidAppendMethod,
  parseExtensionLogsDidAppend,
  readExtensionLogs,
  subscribeExtensionLogs,
  unsubscribeExtensionLogs,
  type ExtensionLogLine,
  type ExtensionServerStatus,
} from './extensionServerApi';
import {
  formatBytes,
  formatLastExit,
  formatUptime,
  serverStateLabel,
  serverStateTone,
  type ServerStateTone,
} from './formatters';
import type { ExtensionResourceSample } from './systemResourcesApi';

const logRingLines = 500;

export type ExtensionDetailAction = 'start' | 'stop' | 'restart' | 'rebuild';

export function ExtensionDetailSheet({
  busyAction,
  name,
  onAction,
  onClose,
  resources,
  status,
  visible,
}: {
  busyAction: ExtensionDetailAction | null;
  name: string;
  onAction: (action: ExtensionDetailAction) => void;
  onClose: () => void;
  resources: ExtensionResourceSample | null;
  status: ExtensionServerStatus | null;
  visible: boolean;
}) {
  const { styles, theme } = useSheetTheme();
  const insets = useSafeAreaInsets();
  const connection = useRemuxConnection();
  const extensionId = status?.extensionId ?? null;
  const [logLines, setLogLines] = useState<ExtensionLogLine[]>([]);
  const [logsError, setLogsError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const logScrollRef = useRef<ScrollView | null>(null);
  const stickToBottomRef = useRef(true);

  // Live log tail: snapshot, then subscribe; the subscription dies with the
  // sheet (and, server-side, with the socket).
  useEffect(() => {
    if (!visible || !extensionId || connection.status.type !== 'connected') {
      return undefined;
    }

    let cancelled = false;
    setLogLines([]);
    setLogsError(null);
    stickToBottomRef.current = true;

    void (async () => {
      try {
        await subscribeExtensionLogs(connection.request, extensionId);
        const snapshot = await readExtensionLogs(connection.request, extensionId, logRingLines);
        if (!cancelled) {
          setLogLines((current) => trimLog([...snapshot, ...current]));
        }
      } catch (error) {
        if (!cancelled) {
          setLogsError(error instanceof Error ? error.message : String(error));
        }
      }
    })();

    const unsubscribeMessages = connection.subscribe((message) => {
      if (message.method !== extensionLogsDidAppendMethod) {
        return;
      }
      const batch = parseExtensionLogsDidAppend(message.params);
      if (!batch || batch.extensionId !== extensionId) {
        return;
      }
      setLogLines((current) => trimLog([...current, ...batch.lines]));
    });

    return () => {
      cancelled = true;
      unsubscribeMessages();
      void unsubscribeExtensionLogs(connection.request, extensionId).catch(() => undefined);
    };
  }, [connection, extensionId, visible]);

  // Seconds tick for the uptime row while the sheet is open.
  useEffect(() => {
    if (!visible) {
      return undefined;
    }
    setNowMs(Date.now());
    const timer = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [visible]);

  useEffect(() => {
    if (stickToBottomRef.current) {
      logScrollRef.current?.scrollToEnd({ animated: false });
    }
  }, [logLines]);

  const onLogScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const distanceFromBottom = contentSize.height - layoutMeasurement.height - contentOffset.y;
    stickToBottomRef.current = distanceFromBottom < 48;
  }, []);

  const busy = busyAction !== null;
  const state = status?.state ?? 'stopped';
  const uptime = formatUptime(status?.startedAtMs ?? null, nowMs);
  const lastExit = formatLastExit(status?.lastExit ?? null);
  const resourceText = resources && status?.running
    ? `${resources.cpuPercent.toFixed(1)}% CPU · ${formatBytes(resources.rssBytes)} · ${resources.processCount} ${resources.processCount === 1 ? 'process' : 'processes'}`
    : null;

  return (
    <Modal animationType="slide" onRequestClose={onClose} transparent visible={visible}>
      <View style={styles.backdropContainer}>
        <Pressable accessibilityLabel="Close extension details" onPress={onClose} style={styles.backdrop} />
        <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 16) }]}>
          <View style={styles.grabber} />
          <View style={styles.headerRow}>
            <Text numberOfLines={1} style={styles.title}>{name}</Text>
            <StateBadge state={state} />
          </View>

          <View style={styles.statusBlock}>
            <StatusRow label="State" value={serverStateLabel(state)} />
            <StatusRow label="PID" value={status?.pid !== null && status?.pid !== undefined ? String(status.pid) : '—'} />
            <StatusRow label="Uptime" value={uptime ?? '—'} />
            <StatusRow label="Restarts" value={String(status?.restartCount ?? 0)} />
            <StatusRow label="Last exit" value={lastExit ?? '—'} />
            {resourceText ? <StatusRow label="Resources" value={resourceText} /> : null}
          </View>

          <View style={styles.actionsRow}>
            {status?.running ? (
              <SheetButton
                busy={busyAction === 'stop'}
                disabled={busy}
                label="Stop"
                onPress={() => onAction('stop')}
              />
            ) : (
              <SheetButton
                busy={busyAction === 'start'}
                disabled={busy}
                label="Start"
                onPress={() => onAction('start')}
              />
            )}
            <SheetButton
              busy={busyAction === 'restart'}
              disabled={busy || !status?.running}
              label="Restart"
              onPress={() => onAction('restart')}
            />
            {status?.hasBuild ? (
              <SheetButton
                busy={busyAction === 'rebuild'}
                disabled={busy}
                label={busyAction === 'rebuild' ? 'Rebuilding' : 'Rebuild & Restart'}
                onPress={() => onAction('rebuild')}
                variant="primary"
              />
            ) : null}
          </View>

          <Text style={styles.logsTitle}>Logs</Text>
          {logsError ? <Text style={styles.errorText}>{logsError}</Text> : null}
          <View style={styles.logPanel}>
            <ScrollView
              onScroll={onLogScroll}
              ref={logScrollRef}
              scrollEventThrottle={64}
              style={styles.logScroll}
            >
              {logLines.length === 0 ? (
                <Text style={styles.logEmpty}>No log output yet.</Text>
              ) : (
                logLines.map((line, index) => (
                  <Text key={`${line.ts}:${index}`} style={styles.logLine}>
                    <Text style={styles.logStream}>{`[${line.stream}] `}</Text>
                    {line.line}
                  </Text>
                ))
              )}
            </ScrollView>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function trimLog(lines: ExtensionLogLine[]): ExtensionLogLine[] {
  return lines.length > logRingLines ? lines.slice(lines.length - logRingLines) : lines;
}

function StatusRow({ label, value }: { label: string; value: string }) {
  const { styles } = useSheetTheme();

  return (
    <View style={styles.statusRow}>
      <Text style={styles.statusLabel}>{label}</Text>
      <Text selectable style={styles.statusValue}>{value}</Text>
    </View>
  );
}

export function StateBadge({ state }: { state: ExtensionServerStatus['state'] }) {
  const { styles } = useSheetTheme();
  const tone = serverStateTone(state);

  return (
    <View style={[styles.badge, badgeShellStyle(styles, tone)]}>
      <View style={[styles.badgeDot, badgeDotStyle(styles, tone)]} />
      <Text style={styles.badgeText}>{serverStateLabel(state)}</Text>
    </View>
  );
}

type SheetStyles = ReturnType<typeof createStyles>;

function badgeShellStyle(styles: SheetStyles, tone: ServerStateTone) {
  switch (tone) {
    case 'ok':
      return styles.badgeOk;
    case 'bad':
      return styles.badgeBad;
    case 'busy':
      return styles.badgeBusy;
    default:
      return styles.badgeIdle;
  }
}

function badgeDotStyle(styles: SheetStyles, tone: ServerStateTone) {
  switch (tone) {
    case 'ok':
      return styles.badgeDotOk;
    case 'bad':
      return styles.badgeDotBad;
    case 'busy':
      return styles.badgeDotBusy;
    default:
      return styles.badgeDotIdle;
  }
}

function SheetButton({
  busy,
  disabled,
  label,
  onPress,
  variant = 'secondary',
}: {
  busy: boolean;
  disabled: boolean;
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary';
}) {
  const { styles, theme } = useSheetTheme();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        variant === 'primary' ? styles.primaryButton : null,
        pressed && !disabled ? styles.buttonPressed : null,
        disabled && !busy ? styles.buttonDisabled : null,
      ]}
    >
      {busy ? <ActivityIndicator color={theme.text} size="small" /> : null}
      <Text style={styles.buttonText}>{label}</Text>
    </Pressable>
  );
}

function useSheetTheme() {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  return { styles, theme };
}

function createStyles(theme: RemuxTheme) {
  return StyleSheet.create({
    actionsRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 10,
      marginTop: 14,
    },
    backdrop: {
      backgroundColor: alpha('#000000', theme.isDark ? 0.55 : 0.35),
      bottom: 0,
      left: 0,
      position: 'absolute',
      right: 0,
      top: 0,
    },
    backdropContainer: {
      flex: 1,
      justifyContent: 'flex-end',
    },
    badge: {
      alignItems: 'center',
      borderRadius: 999,
      borderWidth: 1,
      flexDirection: 'row',
      gap: 6,
      minHeight: 26,
      paddingHorizontal: 10,
    },
    badgeBad: {
      backgroundColor: alpha(theme.danger, 0.14),
      borderColor: alpha(theme.danger, 0.5),
    },
    badgeBusy: {
      backgroundColor: alpha(theme.warning, 0.14),
      borderColor: alpha(theme.warning, 0.5),
    },
    badgeDot: {
      borderRadius: 3,
      height: 6,
      width: 6,
    },
    badgeDotBad: {
      backgroundColor: theme.danger,
    },
    badgeDotBusy: {
      backgroundColor: theme.warning,
    },
    badgeDotIdle: {
      backgroundColor: theme.textMuted,
    },
    badgeDotOk: {
      backgroundColor: theme.success,
    },
    badgeIdle: {
      backgroundColor: theme.surfaceHover,
      borderColor: theme.border,
    },
    badgeOk: {
      backgroundColor: alpha(theme.success, 0.14),
      borderColor: alpha(theme.success, 0.5),
    },
    badgeText: {
      color: theme.text,
      fontSize: 12,
      fontWeight: '700',
      lineHeight: 16,
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
    errorText: {
      color: theme.danger,
      fontSize: 12,
      lineHeight: 17,
      marginTop: 6,
    },
    grabber: {
      alignSelf: 'center',
      backgroundColor: theme.border,
      borderRadius: 3,
      height: 5,
      marginBottom: 12,
      width: 40,
    },
    headerRow: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: 12,
      justifyContent: 'space-between',
    },
    logEmpty: {
      color: theme.textMuted,
      fontSize: 12,
      lineHeight: 17,
      padding: 12,
    },
    logLine: {
      color: theme.text,
      fontFamily: 'Menlo',
      fontSize: 11,
      lineHeight: 16,
    },
    logPanel: {
      backgroundColor: theme.surface,
      borderColor: theme.border,
      borderRadius: 14,
      borderWidth: 1,
      flexGrow: 0,
      height: 260,
      marginTop: 8,
      overflow: 'hidden',
    },
    logScroll: {
      paddingHorizontal: 12,
      paddingVertical: 8,
    },
    logStream: {
      color: theme.textMuted,
    },
    logsTitle: {
      color: theme.text,
      fontSize: 13,
      fontWeight: '800',
      letterSpacing: 0.6,
      lineHeight: 18,
      marginTop: 18,
      textTransform: 'uppercase',
    },
    primaryButton: {
      backgroundColor: alpha(theme.focusRing, 0.16),
      borderColor: theme.focusRing,
    },
    sheet: {
      backgroundColor: theme.surfaceRaised,
      borderColor: theme.border,
      borderTopLeftRadius: 24,
      borderTopRightRadius: 24,
      borderWidth: 1,
      maxHeight: '88%',
      paddingHorizontal: 18,
      paddingTop: 10,
    },
    statusBlock: {
      gap: 8,
      marginTop: 14,
    },
    statusLabel: {
      color: theme.textMuted,
      flexShrink: 0,
      fontSize: 12,
      fontWeight: '700',
      lineHeight: 16,
      width: 84,
    },
    statusRow: {
      alignItems: 'flex-start',
      flexDirection: 'row',
      gap: 12,
    },
    statusValue: {
      color: theme.text,
      flex: 1,
      fontSize: 13,
      fontWeight: '600',
      lineHeight: 18,
    },
    title: {
      color: theme.text,
      flexShrink: 1,
      fontSize: 20,
      fontWeight: '800',
      lineHeight: 26,
    },
  });
}
