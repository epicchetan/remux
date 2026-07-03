import { useEffect, useMemo, useRef, useState } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { FilesOverview } from '../files/FilesOverview';
import { useRemuxConnection } from '../remote/RemuxConnectionProvider';
import { themedIconUrl } from '../remote/remuxExtensions';
import { SettingsOverview } from '../settings/SettingsOverview';
import { useTheme, type RemuxTheme } from '../theme/ThemeProvider';
import { BrowserBottomBar } from './BrowserBottomBar';
import { LauncherMenu } from './LauncherMenu';
import {
  getBottomBarHeight,
  getTabCardWidth,
  tabCardBorderWidth,
  tabGridGap,
  tabGridHorizontalPadding,
  tabHeaderHeight,
  tabPreviewAspectRatio,
} from './browserLayout';
import { useBrowserStore } from './browserStore';
import type { BrowserTab } from './browserTypes';

type BrowserOverviewProps = {
  hiddenTabId?: string | null;
  layer?: 'behind' | 'front';
};

export function BrowserOverview({
  hiddenTabId = null,
  layer = 'front',
}: BrowserOverviewProps) {
  const activeTabId = useBrowserStore((state) => state.activeTabId);
  const insets = useSafeAreaInsets();
  const scrollViewRef = useRef<ScrollView | null>(null);
  const closeTab = useBrowserStore((state) => state.closeTab);
  const remux = useRemuxConnection();
  const section = useBrowserStore((state) => state.section);
  const selectTab = useBrowserStore((state) => state.selectTab);
  const tabs = useBrowserStore((state) => state.tabs);
  const theme = useTheme();
  const [launchersOpen, setLaunchersOpen] = useState(false);
  const { height, width } = useWindowDimensions();
  const previewSourceAspectRatio = width / Math.max(height, 1);
  const orderedTabs = [...tabs].sort((first, second) => {
    if (first.id === activeTabId) {
      return -1;
    }
    if (second.id === activeTabId) {
      return 1;
    }

    return second.lastActiveAt - first.lastActiveAt;
  });
  const tabCardWidth = getTabCardWidth(width);
  const tabRows = bottomAnchoredRows(orderedTabs, 2);
  const bottomChromePadding = getBottomBarHeight(insets.bottom) + tabGridGap;
  const styles = useMemo(() => createStyles(theme), [theme]);

  useEffect(() => {
    if (section !== 'tabs') {
      return undefined;
    }

    const frame = requestAnimationFrame(() => {
      scrollViewRef.current?.scrollToEnd({ animated: false });
    });

    return () => cancelAnimationFrame(frame);
  }, [section, tabs.length]);

  return (
    <View
      pointerEvents={layer === 'behind' ? 'none' : 'auto'}
      style={[
        styles.overview,
        layer === 'behind' ? styles.overviewBehind : styles.overviewFront,
      ]}
    >
      {section === 'tabs' ? (
        <ScrollView
          contentInsetAdjustmentBehavior="never"
          ref={scrollViewRef}
          contentContainerStyle={[
            styles.tabScrollContent,
            {
              paddingBottom: bottomChromePadding,
              paddingTop: Math.max(insets.top + 16, 28),
            },
          ]}
          showsVerticalScrollIndicator={false}
          style={styles.tabScroller}
        >
          <View style={styles.tabGrid}>
            {tabRows.map((row) => (
              <View key={row.map((tab) => tab.id).join(':')} style={styles.tabRow}>
                {row.map((tab) => (
                  <Pressable
                    accessibilityRole="button"
                    key={tab.id}
                    onPress={() => selectTab(tab.id)}
                    style={[
                      styles.tabCard,
                      { width: tabCardWidth },
                      tab.id === activeTabId ? styles.activeTabCard : null,
                      tab.id === hiddenTabId ? styles.hiddenTabCard : null,
                    ]}
                  >
	                    <View style={styles.tabHeader}>
	                      <TabIcon styles={styles} tab={tab} />
	                      <Text numberOfLines={1} style={styles.tabTitle}>{tab.title}</Text>
	                      <Pressable
                        accessibilityLabel={`Close ${tab.title}`}
                        accessibilityRole="button"
                        hitSlop={10}
                        onPress={(event) => {
                          event.stopPropagation();
                          closeViewerTab(tab, {
                            closeTab,
                            request: remux.request,
                          });
                        }}
                        style={styles.tabClose}
                      >
                        <Text style={styles.tabCloseText}>×</Text>
                      </Pressable>
                    </View>
                    <TabPreview previewSourceAspectRatio={previewSourceAspectRatio} styles={styles} tab={tab} />
                  </Pressable>
                ))}
              </View>
            ))}
          </View>
        </ScrollView>
      ) : section === 'files' ? <FilesOverview /> : <SettingsOverview />}

      <BrowserBottomBar onOpenLaunchers={() => setLaunchersOpen(true)} />
      <LauncherMenu onClose={() => setLaunchersOpen(false)} visible={launchersOpen} />
    </View>
  );
}

function closeViewerTab(
  tab: BrowserTab,
  options: {
    closeTab: (tabId: string) => void;
    request: (method: string, params?: unknown, timeoutMs?: number) => Promise<unknown>;
  },
) {
  if (tab.extensionId === 'terminal' && tab.resourceKind === 'terminalSession' && tab.resourceId) {
    void options.request(
      'remux/terminal/session/kill',
      { sessionId: tab.resourceId },
      1_000,
    ).catch(() => undefined);
  }

  options.closeTab(tab.id);
}

function bottomAnchoredRows<T>(items: T[], columns: number) {
  const rows: T[][] = [];
  for (let index = 0; index < items.length; index += columns) {
    rows.push(items.slice(index, index + columns));
  }

  return rows.reverse();
}

type BrowserOverviewStyles = ReturnType<typeof createStyles>;

function TabIcon({ styles, tab }: { styles: BrowserOverviewStyles; tab: BrowserTab }) {
  const theme = useTheme();
  const [imageFailed, setImageFailed] = useState(false);
  const iconUrl = themedIconUrl(tab, theme.isDark);

  return (
    <View style={styles.tabIcon}>
      {iconUrl && !imageFailed ? (
        <Image
          accessibilityIgnoresInvertColors
          onError={() => setImageFailed(true)}
          resizeMode="contain"
          source={{ uri: iconUrl }}
          style={styles.tabIconImage}
        />
      ) : (
        <Text style={styles.tabIconText}>{tabIconText(tab.title)}</Text>
      )}
    </View>
  );
}

function TabPreview({
  previewSourceAspectRatio,
  styles,
  tab,
}: {
  previewSourceAspectRatio: number;
  styles: BrowserOverviewStyles;
  tab: BrowserTab;
}) {
  const [imageFailed, setImageFailed] = useState(false);

  if (tab.previewUri && !imageFailed) {
    return (
      <View style={[styles.tabBody, { aspectRatio: tabPreviewAspectRatio }]}>
        <Image
          accessibilityIgnoresInvertColors
          onError={() => setImageFailed(true)}
          source={{ uri: tab.previewUri }}
          style={[styles.tabPreviewImage, { aspectRatio: previewSourceAspectRatio }]}
        />
      </View>
    );
  }

  return (
    <View style={[styles.tabBody, styles.tabFallbackBody, { aspectRatio: tabPreviewAspectRatio }]}>
      <TabIcon styles={styles} tab={tab} />
    </View>
  );
}

function createStyles(theme: RemuxTheme) {
  return StyleSheet.create({
  activeTabCard: {
    borderColor: theme.focusRing,
  },
  overview: {
    backgroundColor: theme.surface,
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  overviewBehind: {
    zIndex: 0,
  },
  overviewFront: {
    zIndex: 10,
  },
  tabBody: {
    alignItems: 'center',
    backgroundColor: theme.surface,
    justifyContent: 'center',
    overflow: 'hidden',
  },
  tabCard: {
    backgroundColor: theme.surfaceRaised,
    borderColor: theme.surfaceRaised,
    borderRadius: 20,
    borderWidth: tabCardBorderWidth,
    overflow: 'hidden',
  },
  hiddenTabCard: {
    opacity: 0,
  },
  tabCloseText: {
    color: theme.textMuted,
    fontSize: 18,
    fontWeight: '300',
    lineHeight: 20,
  },
  tabClose: {
    alignItems: 'center',
    height: 20,
    justifyContent: 'center',
    width: 20,
  },
  tabGrid: {
    gap: tabGridGap,
  },
  tabFallbackBody: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  tabScrollContent: {
    flexGrow: 1,
    justifyContent: 'flex-end',
    paddingHorizontal: tabGridHorizontalPadding,
  },
  tabScroller: {
    flex: 1,
  },
	  tabHeader: {
	    alignItems: 'center',
	    backgroundColor: theme.surfaceRaised,
	    flexDirection: 'row',
	    gap: 4,
	    height: tabHeaderHeight,
	    paddingHorizontal: 8,
	  },
  tabIcon: {
    alignItems: 'center',
    backgroundColor: theme.surfaceHover,
    borderRadius: 6,
    height: 16,
    justifyContent: 'center',
    overflow: 'hidden',
    width: 16,
  },
  tabIconImage: {
    height: 12,
    width: 12,
  },
  tabIconText: {
    color: theme.text,
    fontSize: 9,
    fontWeight: '900',
    lineHeight: 11,
  },
	  tabPreviewImage: {
    backgroundColor: theme.surface,
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
    width: '100%',
  },
	  tabTitle: {
	    color: theme.text,
	    flex: 1,
	    fontSize: 12,
	    fontWeight: '700',
	    lineHeight: 14,
	  },
  });
}

function tabIconText(title: string) {
  return title.trim().slice(0, 1).toUpperCase() || 'R';
}
