import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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
  type CodexAppServerStatus,
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
const sheetPresentationModifiers = [
  presentationDetents(['medium']),
  presentationDragIndicator('visible'),
];

export type ExtensionDetailAction =
  | 'start'
  | 'stop'
  | 'restart'
  | 'server-build'
  | 'views-build'
  | 'watch-start'
  | 'watch-stop'
  | 'app-server-start'
  | 'app-server-stop'
  | 'app-server-restart'
  | 'app-server-update';

export function ExtensionDetailSheet({
  appServerStatus,
  busyAction,
  name,
  onAction,
  onClose,
  resources,
  status,
  visible,
}: {
  appServerStatus: CodexAppServerStatus | null;
  busyAction: ExtensionDetailAction | null;
  name: string;
  onAction: (action: ExtensionDetailAction) => void;
  onClose: () => void;
  resources: ExtensionResourceSample | null;
  status: ExtensionServerStatus | null;
  visible: boolean;
}) {
  const { styles } = useSheetTheme();
  const insets = useSafeAreaInsets();
  const {
    command,
    query,
    status: connectionStatus,
    subscribe,
    subscribeRequest,
  } = useRemuxConnection();
  const extensionId = status?.extensionId ?? null;
  const [logLines, setLogLines] = useState<ExtensionLogLine[]>([]);
  const [logsError, setLogsError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  // A different extension gets a fresh local tail. Connection transitions do
  // not blank a visible panel; its next snapshot is merged into what the user
  // was already reading.
  useEffect(() => {
    setLogLines([]);
    setLogsError(null);
  }, [extensionId]);

  // Live log tail: subscribe first, then merge the snapshot so entries that
  // arrive in between are neither lost nor duplicated.
  useEffect(() => {
    if (!visible || !extensionId || connectionStatus.type !== 'connected') {
      return undefined;
    }

    let cancelled = false;
    setLogsError(null);

    void (async () => {
      try {
        await subscribeExtensionLogs(subscribeRequest, extensionId);
        const snapshot = await readExtensionLogs(query, extensionId, logRingLines);
        if (!cancelled) {
          setLogLines((current) => mergeLogLines(snapshot, current));
        }
      } catch (error) {
        if (!cancelled) {
          setLogsError(error instanceof Error ? error.message : String(error));
        }
      }
    })();

    const unsubscribeMessages = subscribe((message) => {
      if (message.method !== extensionLogsDidAppendMethod) {
        return;
      }
      const batch = parseExtensionLogsDidAppend(message.params);
      if (!batch || batch.extensionId !== extensionId) {
        return;
      }
      setLogLines((current) => mergeLogLines(current, batch.lines));
    });

    return () => {
      cancelled = true;
      unsubscribeMessages();
      void unsubscribeExtensionLogs(command, extensionId).catch(() => undefined);
    };
  }, [command, connectionStatus.type, extensionId, query, subscribe, subscribeRequest, visible]);

  // Uptime is diagnostic context, not a stopwatch. Avoid rebuilding the
  // native SwiftUI host and its RN subtree every second.
  useEffect(() => {
    if (!visible) {
      return undefined;
    }
    setNowMs(Date.now());
    const timer = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [visible]);

  const busy = busyAction !== null;
  const state = status?.state ?? 'stopped';
  const uptime = formatUptime(status?.startedAtMs ?? null, nowMs);
  const lastExit = formatLastExit(status?.lastExit ?? null);
  const serverResources = resources?.roles.server ?? null;
  const watchResources = resources?.roles.watch ?? null;
  const aggregateResourceText = resources && !serverResources && !watchResources
    ? formatResourceSample(resources)
    : null;
  const serverResourceText = serverResources ? formatResourceSample(serverResources) : null;
  const watchResourceText = watchResources ? formatResourceSample(watchResources) : null;
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
  const extensionServerLines = useMemo(
    () => logLines.filter((entry) => entry.componentId === 'extension-server'),
    [logLines],
  );
  const appServerLines = useMemo(
    () => logLines.filter((entry) => entry.componentId === 'codex-app-server'),
    [logLines],
  );
  const viewerLines = useMemo(
    () => logLines.filter((entry) => entry.area === 'viewer'),
    [logLines],
  );
  const showViewer = (status?.views.declared ?? 0) > 0 || Boolean(watch?.declared);
  const activeAppTurns = appServerStatus?.activeTurnIds.length ?? 0;

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
        <Group modifiers={sheetPresentationModifiers}>
          <RNHostView>
            <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 16) }]}>
              <View style={styles.sheetHeader}>
                <View style={styles.headerRow}>
                  <Text numberOfLines={1} style={styles.title}>{name}</Text>
                  <StateBadge state={state} />
                </View>

                {aggregateResourceText ? (
                  <Text style={styles.sharedResources}>{aggregateResourceText}</Text>
                ) : null}
                {logsError ? <Text style={styles.errorText}>{logsError}</Text> : null}
              </View>

              <ScrollView
                contentInsetAdjustmentBehavior="never"
                contentContainerStyle={styles.sectionContent}
                nestedScrollEnabled
                style={styles.sectionScroll}
              >
                {hasServer ? (
                  <OperationalSection
                    actions={(
                      <>
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
                            label={busyAction === 'server-build' ? 'Building' : 'Build'}
                            onPress={() => onAction('server-build')}
                            variant="primary"
                          />
                        ) : null}
                      </>
                    )}
                    emptyText="No Extension Server output yet."
                    logs={extensionServerLines}
                    status={(
                      <>
                        <StatusRow label="State" value={serverStateLabel(state)} />
                        <StatusRow label="PID" value={status?.pid !== null && status?.pid !== undefined ? String(status.pid) : '—'} />
                        <StatusRow label="Uptime" value={uptime ?? '—'} />
                        <StatusRow label="Restarts" value={String(status?.restartCount ?? 0)} />
                        <StatusRow label="Last exit" value={lastExit ?? '—'} />
                        {serverResourceText ? <StatusRow label="Resources" value={serverResourceText} /> : null}
                      </>
                    )}
                    title="Extension Server"
                  />
                ) : null}

                {appServerStatus ? (
                  <OperationalSection
                    actions={(
                      <>
                        {appServerStatus.state === 'running' ? (
                          <SheetButton
                            busy={busyAction === 'app-server-stop'}
                            disabled={busy || activeAppTurns > 0}
                            label="Stop"
                            onPress={() => onAction('app-server-stop')}
                          />
                        ) : (
                          <SheetButton
                            busy={busyAction === 'app-server-start'}
                            disabled={busy}
                            label="Start"
                            onPress={() => onAction('app-server-start')}
                          />
                        )}
                        <SheetButton
                          busy={busyAction === 'app-server-restart'}
                          disabled={busy || appServerStatus.state !== 'running' || activeAppTurns > 0}
                          label="Restart"
                          onPress={() => onAction('app-server-restart')}
                        />
                        <SheetButton
                          busy={busyAction === 'app-server-update'}
                          disabled={busy}
                          label={busyAction === 'app-server-update' ? 'Updating' : 'Update Codex'}
                          onPress={() => onAction('app-server-update')}
                          variant="primary"
                        />
                      </>
                    )}
                    emptyText="No Codex App Server output yet."
                    logs={appServerLines}
                    status={(
                      <>
                        <StatusRow label="State" value={capitalize(appServerStatus.state)} />
                        <StatusRow label="Installed" value={appServerStatus.installedVersion ?? '—'} />
                        <StatusRow label="Running" value={appServerStatus.runningVersion ?? '—'} />
                        {appServerStatus.restartRequired ? (
                          <StatusRow label="Update" value="Restart required to apply" />
                        ) : null}
                        {activeAppTurns > 0 ? (
                          <StatusRow
                            label="Active turns"
                            value={String(activeAppTurns)}
                          />
                        ) : null}
                        {appServerStatus.lastError ? (
                          <StatusRow label="Last error" value={appServerStatus.lastError} />
                        ) : null}
                      </>
                    )}
                    title="Codex App Server"
                  />
                ) : null}

                {showViewer ? (
                  <OperationalSection
                    actions={(
                      <>
                        {(status?.views.declared ?? 0) > 0 ? (
                          <SheetButton
                            busy={busyAction === 'views-build'}
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
                      </>
                    )}
                    emptyText="No Viewer output yet — Build or start Watch to see output here."
                    logs={viewerLines}
                    status={(
                      <>
                        {(status?.views.declared ?? 0) > 0 ? (
                          <StatusRow label="Build" value={status?.views.built ? 'Built' : 'Not built'} />
                        ) : null}
                        {status?.views.lastBuildAtMs ? (
                          <StatusRow label="Last build" value={formatStatusTime(status.views.lastBuildAtMs)} />
                        ) : null}
                        {watchText ? <StatusRow label="Watch" value={watchText} /> : null}
                        {watchResourceText ? <StatusRow label="Resources" value={watchResourceText} /> : null}
                      </>
                    )}
                    title="Viewer"
                  />
                ) : null}
              </ScrollView>
            </View>
          </RNHostView>
        </Group>
      </BottomSheet>
    </Host>
  );
}

function trimLog(lines: ExtensionLogLine[]): ExtensionLogLine[] {
  const keptPerComponent = new Map<string, number>();
  const kept: ExtensionLogLine[] = [];
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const entry = lines[index];
    const count = keptPerComponent.get(entry.componentId) ?? 0;
    if (count >= logRingLines) {
      continue;
    }
    keptPerComponent.set(entry.componentId, count + 1);
    kept.push(entry);
  }
  kept.reverse();
  return kept;
}

function mergeLogLines(
  before: ExtensionLogLine[],
  after: ExtensionLogLine[],
): ExtensionLogLine[] {
  const seen = new Set<string>();
  return trimLog([...before, ...after].filter((entry) => {
    const key = [
      entry.ts,
      entry.componentId,
      entry.source,
      entry.channel ?? '',
      entry.level ?? '',
      entry.line,
    ].join('\u0000');
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  }));
}

function OperationalSection({
  actions,
  emptyText,
  logs,
  status,
  title,
}: {
  actions: ReactNode;
  emptyText: string;
  logs: ExtensionLogLine[];
  status: ReactNode;
  title: string;
}) {
  const { styles } = useSheetTheme();
  return (
    <View style={styles.operationalSection}>
      <Text style={styles.groupTitle}>{title}</Text>
      <View style={styles.statusBlock}>{status}</View>
      <View style={styles.actionsRow}>{actions}</View>
      <Text style={styles.logsTitle}>Logs</Text>
      <LogPanel emptyText={emptyText} lines={logs} />
    </View>
  );
}

/**
 * One scrolling log section with its own stick-to-bottom tracking. The
 * native sheet unmounts its children on dismiss, so the refs reset on every
 * open for free.
 */
const LogPanel = memo(function LogPanel({
  emptyText,
  lines,
}: {
  emptyText: string;
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
        contentContainerStyle={styles.logScrollContent}
        nestedScrollEnabled
        onScroll={onScroll}
        ref={scrollRef}
        scrollEventThrottle={64}
        style={styles.logScroll}
      >
        {lines.length === 0 ? (
          <Text style={styles.logEmpty}>{emptyText}</Text>
        ) : (
          lines.map((entry, index) => (
            <LogEntryLine entry={entry} key={`${entry.ts}:${index}`} />
          ))
        )}
      </ScrollView>
    </View>
  );
});

/**
 * One log entry: muted timestamp, structured source/channel tag, and wrapped
 * message. Severity comes only from `level`; raw stderr remains neutral.
 */
const LogEntryLine = memo(function LogEntryLine({ entry }: { entry: ExtensionLogLine }) {
  const { styles } = useSheetTheme();
  const tag = logEntryTag(entry);
  const messageStyle = entry.level === 'error'
    ? styles.logTextBad
    : entry.level === 'warn'
      ? styles.logTextWarn
      : entry.source === 'lifecycle' || entry.source === 'connection'
        ? styles.logTextMuted
        : styles.logText;

  return (
    <Text selectable style={styles.logLine}>
      <Text style={styles.logTime}>{`${formatLogTime(entry.ts)} `}</Text>
      {tag ? <Text style={[styles.logTag, logTagStyle(styles, tag.tone)]}>{`${tag.label} `}</Text> : null}
      <Text style={messageStyle}>{logMessage(entry)}</Text>
    </Text>
  );
});

type LogTagTone = 'bad' | 'warn' | 'build' | 'muted';

function logEntryTag(entry: ExtensionLogLine): { label: string; tone: LogTagTone } | null {
  const label = entry.channel ? `${entry.source}·${entry.channel}` : entry.source;
  const tone = entry.level === 'error'
    ? 'bad'
    : entry.level === 'warn'
      ? 'warn'
      : entry.source === 'build' || entry.source === 'update'
        ? 'build'
        : 'muted';
  return { label, tone };
}

function logTagStyle(styles: SheetStyles, tone: LogTagTone) {
  switch (tone) {
    case 'bad':
      return styles.logTagBad;
    case 'warn':
      return styles.logTagWarn;
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

function formatResourceSample(sample: {
  cpuPercent: number;
  rssBytes: number;
  processCount: number;
}): string {
  return `${sample.cpuPercent.toFixed(1)}% CPU · ${formatBytes(sample.rssBytes)} · ${sample.processCount} ${sample.processCount === 1 ? 'process' : 'processes'}`;
}

function formatStatusTime(value: number): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

function capitalize(value: string): string {
  return value.length > 0 ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
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
    logPanel: {
      backgroundColor: theme.surface,
      borderColor: theme.border,
      borderRadius: 14,
      borderWidth: 1,
      height: 160,
      marginTop: 8,
      overflow: 'hidden',
    },
    logScroll: {
      flex: 1,
    },
    logScrollContent: {
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
    logTagWarn: {
      color: theme.warning,
    },
    logTagMuted: {
      color: theme.textMuted,
    },
    logText: {
      color: theme.text,
    },
    logTextBad: {
      color: theme.danger,
    },
    logTextMuted: {
      color: theme.textMuted,
    },
    logTextWarn: {
      color: theme.warning,
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
    logsTitle: {
      color: theme.textMuted,
      fontSize: 12,
      fontWeight: '700',
      lineHeight: 17,
      marginTop: 14,
    },
    operationalSection: {
      flexShrink: 0,
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
      paddingTop: 20,
    },
    sectionContent: {
      paddingBottom: 16,
      paddingHorizontal: 18,
    },
    sectionScroll: {
      flex: 1,
    },
    sheetHeader: {
      paddingHorizontal: 18,
    },
    sharedResources: {
      color: theme.textMuted,
      fontSize: 12,
      lineHeight: 17,
      marginTop: 8,
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
