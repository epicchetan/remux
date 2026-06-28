import { useEffect, useRef, useState } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { FilesOverview } from '../files/FilesOverview';
import { SettingsOverview } from '../settings/SettingsOverview';
import { BrowserBottomBar } from './BrowserBottomBar';
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
  const section = useBrowserStore((state) => state.section);
  const selectTab = useBrowserStore((state) => state.selectTab);
  const tabs = useBrowserStore((state) => state.tabs);
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
                      <TabIcon tab={tab} />
                      <Text numberOfLines={1} style={styles.tabTitle}>{tab.title}</Text>
                      <Pressable
                        accessibilityLabel={`Close ${tab.title}`}
                        accessibilityRole="button"
                        hitSlop={10}
                        onPress={(event) => {
                          event.stopPropagation();
                          closeTab(tab.id);
                        }}
                        style={styles.tabClose}
                      >
                        <Text style={styles.tabCloseText}>×</Text>
                      </Pressable>
                    </View>
                    <TabPreview previewSourceAspectRatio={previewSourceAspectRatio} tab={tab} />
                  </Pressable>
                ))}
              </View>
            ))}
          </View>
        </ScrollView>
      ) : section === 'files' ? <FilesOverview /> : <SettingsOverview />}

      <BrowserBottomBar />
    </View>
  );
}

function bottomAnchoredRows<T>(items: T[], columns: number) {
  const rows: T[][] = [];
  for (let index = 0; index < items.length; index += columns) {
    rows.push(items.slice(index, index + columns));
  }

  return rows.reverse();
}

function TabIcon({ tab }: { tab: BrowserTab }) {
  const [imageFailed, setImageFailed] = useState(false);

  return (
    <View style={styles.tabIcon}>
      {tab.iconUrl && !imageFailed ? (
        <Image
          accessibilityIgnoresInvertColors
          onError={() => setImageFailed(true)}
          resizeMode="contain"
          source={{ uri: tab.iconUrl }}
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
  tab,
}: {
  previewSourceAspectRatio: number;
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
      <TabIcon tab={tab} />
    </View>
  );
}

const styles = StyleSheet.create({
  activeTabCard: {
    borderColor: '#5f97ff',
  },
  overview: {
    backgroundColor: '#000000',
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
    backgroundColor: '#111112',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  tabCard: {
    backgroundColor: '#272729',
    borderColor: '#272729',
    borderRadius: 20,
    borderWidth: tabCardBorderWidth,
    overflow: 'hidden',
  },
  hiddenTabCard: {
    opacity: 0,
  },
  tabCloseText: {
    color: '#c9c9ce',
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
    backgroundColor: '#272729',
    flexDirection: 'row',
    gap: 4,
    height: tabHeaderHeight,
    paddingHorizontal: 8,
  },
  tabIcon: {
    alignItems: 'center',
    backgroundColor: '#3a3a3d',
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
    color: '#ffffff',
    fontSize: 9,
    fontWeight: '900',
    lineHeight: 11,
  },
  tabPreviewImage: {
    backgroundColor: '#111112',
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
    width: '100%',
  },
  tabTitle: {
    color: '#f1f1f3',
    flex: 1,
    fontSize: 12,
    fontWeight: '700',
    lineHeight: 14,
  },
});

function tabIconText(title: string) {
  return title.trim().slice(0, 1).toUpperCase() || 'R';
}
