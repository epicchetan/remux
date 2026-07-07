import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BottomSheet, Group, Host, RNHostView } from '@expo/ui/swift-ui';
import { presentationDetents, presentationDragIndicator } from '@expo/ui/swift-ui/modifiers';
import {
  ActivityIndicator,
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

export type ExtensionDetailAction =
  | 'start'
  | 'stop'
  | 'restart'
  | 'server-build'
  | 'views-build'
  | 'watch-start'
  | 'watch-stop';

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

  // Live log tail: snapshot, then subscribe; the subscription dies with the
  // sheet (and, server-side, with the socket).
  useEffect(() => {
    if (!visible || !extensionId || connection.status.type !== 'connected') {
      return undefined;
    }

    let cancelled = false;
    setLogLines([]);
    setLogsError(null);

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

  const busy = busyAction !== null;
  const state = status?.state ?? 'stopped';
  const uptime = formatUptime(status?.startedAtMs ?? null, nowMs);
  const lastExit = formatLastExit(status?.lastExit ?? null);
  const resourceText = resources && status?.running
    ? `${resources.cpuPercent.toFixed(1)}% CPU · ${formatBytes(resources.rssBytes)} · ${resources.processCount} ${resources.processCount === 1 ? 'process' : 'processes'}`
    : null;
  // Serverless extensions (view builds/watch only): the Server group is
  // meaningless — the Viewer group (Build/Watch) is all they get.
  const hasServer = status?.hasServer !== false;
  const watch = status?.watch ?? null;
  const watchRunning = watch?.state === 'running';
  const watchText = watch?.declared
    ? watch.state === 'running'
      ? ['running', watch.pid !== null ? `pid ${watch.pid}` : null, formatUptime(watch.startedAtMs, nowMs)]
          .filter(Boolean)
          .join(' · ')
      : watch.state === 'failed'
        ? `failed (${watch.restartCount} ${watch.restartCount === 1 ? 'restart' : 'restarts'})`
        : 'stopped'
    : null;
  // Watch output gets its own section — vite recompile chatter mingled with
  // server stderr made both harder to read.
  const serverLines = useMemo(
    () => logLines.filter((entry) => entry.stream !== 'watch'),
    [logLines],
  );
  const watchLines = useMemo(
    () => logLines.filter((entry) => entry.stream === 'watch'),
    [logLines],
  );
  const showWatchLogs = Boolean(watch?.declared) || watchLines.length > 0;

  // Native SwiftUI sheet: system detents, drag indicator, dimming, and the
  // liquid-glass chrome all come from UIKit. Sizing flows native → RN: the
  // detents fix the sheet height, RNHostView (no matchContents) takes the
  // sheet's proposed size and reports it into Yoga, and the RN content fills
  // it. The reverse direction (Yoga-measured content sizing the sheet via
  // fitToContents) measured near-zero — the content hangs off a zero-size
  // native anchor in the RN shadow tree.
  return (
    <Host style={styles.anchor}>
      <BottomSheet
        isPresented={visible}
        onIsPresentedChange={(isPresented) => {
          if (!isPresented) {
            onClose();
          }
        }}
      >
        <Group modifiers={[presentationDetents(['medium', 'large']), presentationDragIndicator('visible')]}>
          <RNHostView>
            <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 16) }]}>
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
                {watchText ? <StatusRow label="Watch" value={watchText} /> : null}
                {resourceText ? <StatusRow label="Resources" value={resourceText} /> : null}
              </View>

              {hasServer ? (
                <>
                  <Text style={styles.groupTitle}>Server</Text>
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
                    {status?.hasServerBuild ? (
                      <SheetButton
                        busy={busyAction === 'server-build'}
                        disabled={busy}
                        label={
                          busyAction === 'server-build'
                            ? 'Building'
                            : status?.running
                              ? 'Build & Restart'
                              : 'Build'
                        }
                        onPress={() => onAction('server-build')}
                        variant="primary"
                      />
                    ) : null}
                  </View>
                </>
              ) : null}
              {(status?.views.declared ?? 0) > 0 || watch?.declared ? (
                <>
                  <Text style={styles.groupTitle}>Viewer</Text>
                  <View style={styles.actionsRow}>
                    {(status?.views.declared ?? 0) > 0 ? (
                      <SheetButton
                        busy={busyAction === 'views-build'}
                        // The watcher owns the bundle while it runs — a
                        // manual build would be skipped anyway.
                        disabled={busy || watchRunning}
                        label={busyAction === 'views-build' ? 'Building' : 'Build'}
                        onPress={() => onAction('views-build')}
                        variant={hasServer ? 'secondary' : 'primary'}
                      />
                    ) : null}
                    {watch?.declared ? (
                      <SheetButton
                        busy={busyAction === 'watch-start' || busyAction === 'watch-stop'}
                        disabled={busy}
                        label={
                          busyAction === 'watch-start'
                            ? 'Starting Watch'
                            : busyAction === 'watch-stop'
                              ? 'Stopping Watch'
                              : watchRunning
                                ? 'Stop Watch'
                                : 'Start Watch'
                        }
                        onPress={() => onAction(watchRunning ? 'watch-stop' : 'watch-start')}
                      />
                    ) : null}
                  </View>
                </>
              ) : null}

              <Text style={styles.groupTitle}>Logs</Text>
              {logsError ? <Text style={styles.errorText}>{logsError}</Text> : null}
              <LogPanel
                emptyText="No output yet — servers only log errors, builds, and lifecycle events, so quiet is healthy."
                lines={serverLines}
              />
              {showWatchLogs ? (
                <>
                  <Text style={styles.groupTitle}>Watch</Text>
                  <LogPanel
                    emptyText="No watch output yet — start Watch to stream rebuild notices here."
                    hideTags
                    lines={watchLines}
                  />
                </>
              ) : null}
            </View>
          </RNHostView>
        </Group>
      </BottomSheet>
    </Host>
  );
}

function trimLog(lines: ExtensionLogLine[]): ExtensionLogLine[] {
  return lines.length > logRingLines ? lines.slice(lines.length - logRingLines) : lines;
}

/**
 * One scrolling log section with its own stick-to-bottom tracking. The
 * native sheet unmounts its children on dismiss, so the refs reset on every
 * open for free.
 */
function LogPanel({
  emptyText,
  hideTags = false,
  lines,
}: {
  emptyText: string;
  hideTags?: boolean;
  lines: ExtensionLogLine[];
}) {
  const { styles } = useSheetTheme();
  const scrollRef = useRef<ScrollView | null>(null);
  const stickToBottomRef = useRef(true);

  useEffect(() => {
    if (stickToBottomRef.current) {
      scrollRef.current?.scrollToEnd({ animated: false });
    }
  }, [lines]);

  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const distanceFromBottom = contentSize.height - layoutMeasurement.height - contentOffset.y;
    stickToBottomRef.current = distanceFromBottom < 48;
  }, []);

  return (
    <View style={styles.logPanel}>
      <ScrollView
        onScroll={onScroll}
        ref={scrollRef}
        scrollEventThrottle={64}
        style={styles.logScroll}
      >
        {lines.length === 0 ? (
          <Text style={styles.logEmpty}>{emptyText}</Text>
        ) : (
          lines.map((entry, index) => (
            <LogEntryLine entry={entry} hideTag={hideTags} key={`${entry.ts}:${index}`} />
          ))
        )}
      </ScrollView>
    </View>
  );
}

/**
 * One log entry: muted timestamp, colored stream tag, wrapped message.
 * Lifecycle lines are runtime narration and render fully muted with no tag;
 * single-stream panels (Watch) hide the tag — it would repeat on every line.
 */
function LogEntryLine({ entry, hideTag = false }: { entry: ExtensionLogLine; hideTag?: boolean }) {
  const { styles } = useSheetTheme();
  const tag = hideTag ? null : logStreamTag(entry.stream);

  return (
    <Text selectable style={styles.logLine}>
      <Text style={styles.logTime}>{`${formatLogTime(entry.ts)} `}</Text>
      {tag ? <Text style={[styles.logTag, logTagStyle(styles, tag.tone)]}>{`${tag.label} `}</Text> : null}
      <Text style={entry.stream === 'lifecycle' ? styles.logTextMuted : styles.logText}>
        {logMessage(entry)}
      </Text>
    </Text>
  );
}

type LogTagTone = 'bad' | 'build' | 'muted';

function logStreamTag(stream: string): { label: string; tone: LogTagTone } | null {
  switch (stream) {
    case 'lifecycle':
      return null;
    case 'stderr':
      return { label: 'err', tone: 'bad' };
    case 'build':
      return { label: 'build', tone: 'build' };
    default:
      return { label: stream, tone: 'muted' };
  }
}

function logTagStyle(styles: SheetStyles, tone: LogTagTone) {
  switch (tone) {
    case 'bad':
      return styles.logTagBad;
    case 'build':
      return styles.logTagBuild;
    default:
      return styles.logTagMuted;
  }
}

// Ring build/watch lines carry the runtime's own "[build] "/"[watch] "
// prefix; the tag already says it.
function logMessage(entry: ExtensionLogLine): string {
  const prefix = `[${entry.stream}] `;
  return (entry.stream === 'build' || entry.stream === 'watch') && entry.line.startsWith(prefix)
    ? entry.line.slice(prefix.length)
    : entry.line;
}

/** Local HH:MM:SS, with a MM-DD prefix once the entry is from another day. */
function formatLogTime(ts: string): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) {
    return '--:--:--';
  }
  const pad = (value: number) => String(value).padStart(2, '0');
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  const now = new Date();
  const sameDay = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
  return sameDay ? time : `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`;
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
    anchor: {
      height: 0,
      position: 'absolute',
      width: 0,
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
      fontFamily: 'Menlo',
      fontSize: 11,
      lineHeight: 17,
      marginBottom: 2,
    },
    // Flexes into whatever the active detent leaves over: a sliver at
    // medium, the full remainder at large.
    logPanel: {
      backgroundColor: theme.surface,
      borderColor: theme.border,
      borderRadius: 14,
      borderWidth: 1,
      flex: 1,
      marginTop: 8,
      minHeight: 96,
      overflow: 'hidden',
    },
    logScroll: {
      paddingHorizontal: 12,
      paddingVertical: 8,
    },
    logTag: {
      fontWeight: '700',
    },
    logTagBad: {
      color: theme.danger,
    },
    logTagBuild: {
      color: theme.focusRing,
    },
    logTagMuted: {
      color: theme.textMuted,
    },
    logText: {
      color: theme.text,
    },
    logTextMuted: {
      color: theme.textMuted,
    },
    logTime: {
      color: alpha(theme.textMuted, 0.8),
    },
    groupTitle: {
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
    // Background, corner radius, and grabber belong to the native sheet;
    // painting over them would cover the system glass. flex: 1 fills the
    // detent-sized RNHostView.
    sheet: {
      flex: 1,
      paddingHorizontal: 18,
      paddingTop: 20,
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
