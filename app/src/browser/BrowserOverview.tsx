import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Animated,
  Image,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { FilesOverview } from '../files/FilesOverview';
import { useRemuxConnection, type RemuxConnection } from '../remote/RemuxConnectionProvider';
import { remuxImageSource, themedIconUrl } from '../remote/remuxExtensions';
import { SettingsOverview } from '../settings/SettingsOverview';
import { useTheme, type RemuxTheme } from '../theme/ThemeProvider';
import { BrowserBottomBar } from './BrowserBottomBar';
import { LauncherMenu } from './LauncherMenu';
import {
  getBottomBarHeight,
  getTabCardHeight,
  getTabCardWidth,
  getTabGridHeight,
  getTabSlotIndexForPosition,
  getTabSlotPosition,
  tabCardBorderWidth,
  tabGridColumns,
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
  const scrollOffsetRef = useRef(0);
  const closeTab = useBrowserStore((state) => state.closeTab);
  const moveTab = useBrowserStore((state) => state.moveTab);
  const remux = useRemuxConnection();
  const section = useBrowserStore((state) => state.section);
  const selectTab = useBrowserStore((state) => state.selectTab);
  const tabs = useBrowserStore((state) => state.tabs);
  const theme = useTheme();
  const [launchersOpen, setLaunchersOpen] = useState(false);
  const [dragTabId, setDragTabId] = useState<string | null>(null);
  const [dragOrder, setDragOrder] = useState<string[] | null>(null);
  const dragOrderRef = useRef<string[] | null>(null);
  const { height, width } = useWindowDimensions();
  const previewSourceAspectRatio = width / Math.max(height, 1);
  const orderedTabs = dragOrder
    ? dragOrder.flatMap((tabId) => tabs.filter((tab) => tab.id === tabId))
    : tabs;
  const tabCardWidth = getTabCardWidth(width);
  const tabCardHeight = getTabCardHeight(tabCardWidth);
  const tabGridHeight = getTabGridHeight(orderedTabs.length, tabCardHeight);
  const bottomChromePadding = getBottomBarHeight(insets.bottom) + tabGridGap;
  const gridPaddingTop = Math.max(insets.top + 16, 28);
  const styles = useMemo(() => createStyles(theme), [theme]);

  const applyDragOrder = useCallback((order: string[] | null) => {
    dragOrderRef.current = order;
    setDragOrder(order);
  }, []);

  const handleDragStart = useCallback((tabId: string) => {
    setDragTabId(tabId);
    applyDragOrder(useBrowserStore.getState().tabs.map((tab) => tab.id));
  }, [applyDragOrder]);

  const handleDragMove = useCallback((tabId: string, x: number, y: number) => {
    const order = dragOrderRef.current;
    if (!order) {
      return;
    }

    const targetIndex = getTabSlotIndexForPosition({
      cardHeight: tabCardHeight,
      cardWidth: tabCardWidth,
      tabCount: order.length,
      x,
      y,
    });
    const fromIndex = order.indexOf(tabId);
    if (fromIndex === -1 || fromIndex === targetIndex) {
      return;
    }

    const next = [...order];
    next.splice(fromIndex, 1);
    next.splice(targetIndex, 0, tabId);
    applyDragOrder(next);
  }, [applyDragOrder, tabCardHeight, tabCardWidth]);

  const handleDragEnd = useCallback((tabId: string) => {
    const order = dragOrderRef.current;
    if (order) {
      const targetIndex = order.indexOf(tabId);
      if (targetIndex !== -1) {
        moveTab(tabId, targetIndex);
      }
    }

    applyDragOrder(null);
    setDragTabId(null);
  }, [applyDragOrder, moveTab]);

  // If the dragged tab disappears mid-drag (for example, closed remotely) its
  // card unmounts and can never deliver onDragEnd, so unwind the drag here.
  useEffect(() => {
    const order = dragOrderRef.current;
    if (!order) {
      return;
    }

    if (dragTabId && !tabs.some((tab) => tab.id === dragTabId)) {
      applyDragOrder(null);
      setDragTabId(null);
      return;
    }

    if (order.some((tabId) => !tabs.some((tab) => tab.id === tabId))) {
      applyDragOrder(order.filter((tabId) => tabs.some((tab) => tab.id === tabId)));
    }
  }, [applyDragOrder, dragTabId, tabs]);

  // Arrive framed on the active tab: center its card when the grid overflows
  // the screen, clamped so short grids and edge rows never over-scroll.
  useEffect(() => {
    if (section !== 'tabs') {
      return undefined;
    }

    const frame = requestAnimationFrame(() => {
      const state = useBrowserStore.getState();
      const activeIndex = state.tabs.findIndex((tab) => tab.id === state.activeTabId);
      if (activeIndex === -1) {
        return;
      }

      const cardWidth = getTabCardWidth(width);
      const cardHeight = getTabCardHeight(cardWidth);
      const gridHeight = getTabGridHeight(state.tabs.length, cardHeight);
      const row = Math.floor(activeIndex / tabGridColumns);
      const cardTop = gridPaddingTop + gridHeight - cardHeight - row * (cardHeight + tabGridGap);
      const maxOffset = Math.max(0, gridPaddingTop + gridHeight + bottomChromePadding - height);
      const centered = cardTop - (height - cardHeight) / 2;
      const offset = Math.min(Math.max(centered, 0), maxOffset);
      scrollOffsetRef.current = offset;
      scrollViewRef.current?.scrollTo({ animated: false, y: offset });
    });

    return () => cancelAnimationFrame(frame);
  }, [bottomChromePadding, gridPaddingTop, height, section, width]);

  // Cards are anchored to the grid's bottom edge, so a row-count change moves
  // every card by the height delta inside the scroll content. Shift the offset
  // by the same delta to keep the view glued to the cards.
  const prevGridHeightRef = useRef(tabGridHeight);
  useEffect(() => {
    const previousGridHeight = prevGridHeightRef.current;
    prevGridHeightRef.current = tabGridHeight;
    if (section !== 'tabs' || previousGridHeight === tabGridHeight) {
      return undefined;
    }

    const delta = tabGridHeight - previousGridHeight;
    const frame = requestAnimationFrame(() => {
      const maxOffset = Math.max(0, gridPaddingTop + tabGridHeight + bottomChromePadding - height);
      const offset = Math.min(Math.max(scrollOffsetRef.current + delta, 0), maxOffset);
      scrollOffsetRef.current = offset;
      scrollViewRef.current?.scrollTo({ animated: false, y: offset });
    });

    return () => cancelAnimationFrame(frame);
  }, [bottomChromePadding, gridPaddingTop, height, section, tabGridHeight]);

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
          onScroll={(event) => {
            scrollOffsetRef.current = event.nativeEvent.contentOffset.y;
          }}
          ref={scrollViewRef}
          scrollEnabled={dragTabId === null}
          scrollEventThrottle={16}
          contentContainerStyle={[
            styles.tabScrollContent,
            {
              paddingBottom: bottomChromePadding,
              paddingTop: gridPaddingTop,
            },
          ]}
          showsVerticalScrollIndicator={false}
          style={styles.tabScroller}
        >
          <View style={{ height: tabGridHeight }}>
            {orderedTabs.map((tab, index) => {
              const slot = getTabSlotPosition({
                cardHeight: tabCardHeight,
                cardWidth: tabCardWidth,
                index,
              });

              return (
                <TabGridCard
                  cardStyle={[
                    styles.tabCard,
                    tab.id === activeTabId ? styles.activeTabCard : null,
                    tab.id === hiddenTabId ? styles.hiddenTabCard : null,
                  ]}
                  key={tab.id}
                  onDragEnd={handleDragEnd}
                  onDragMove={handleDragMove}
                  onDragStart={handleDragStart}
                  onPress={() => selectTab(tab.id)}
                  slotX={slot.x}
                  slotY={slot.y}
                  styles={styles}
                  tabId={tab.id}
                  width={tabCardWidth}
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
                          command: remux.command,
                        });
                      }}
                      style={styles.tabClose}
                    >
                      <Text style={styles.tabCloseText}>×</Text>
                    </Pressable>
                  </View>
                  <TabPreview previewSourceAspectRatio={previewSourceAspectRatio} styles={styles} tab={tab} />
                </TabGridCard>
              );
            })}
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
    command: RemuxConnection['command'];
  },
) {
  if (tab.extensionId === 'terminal' && tab.resourceKind === 'terminalSession' && tab.resourceId) {
    void options.command(
      'remux/terminal/session/kill',
      { sessionId: tab.resourceId },
    ).catch(() => undefined);
  }

  options.closeTab(tab.id);
}

type BrowserOverviewStyles = ReturnType<typeof createStyles>;

type TabGridCardProps = {
  cardStyle: StyleProp<ViewStyle>;
  children: ReactNode;
  onDragEnd: (tabId: string) => void;
  onDragMove: (tabId: string, x: number, y: number) => void;
  onDragStart: (tabId: string) => void;
  onPress: () => void;
  slotX: number;
  slotY: number;
  styles: BrowserOverviewStyles;
  tabId: string;
  width: number;
};

function TabGridCard({
  cardStyle,
  children,
  onDragEnd,
  onDragMove,
  onDragStart,
  onPress,
  slotX,
  slotY,
  styles,
  tabId,
  width,
}: TabGridCardProps) {
  const position = useRef(new Animated.ValueXY({ x: slotX, y: slotY })).current;
  const scale = useRef(new Animated.Value(1)).current;
  const slotRef = useRef({ x: slotX, y: slotY });
  const dragRef = useRef({ armed: false, granted: false, origin: { x: slotX, y: slotY } });
  const [lifted, setLifted] = useState(false);
  const callbacksRef = useRef({ onDragEnd, onDragMove, onDragStart, tabId });
  callbacksRef.current = { onDragEnd, onDragMove, onDragStart, tabId };

  useEffect(() => {
    slotRef.current = { x: slotX, y: slotY };
    if (dragRef.current.armed) {
      // The lifted card tracks the finger; it springs home on release.
      return;
    }

    Animated.spring(position, {
      bounciness: 4,
      speed: 24,
      toValue: { x: slotX, y: slotY },
      useNativeDriver: true,
    }).start();
  }, [position, slotX, slotY]);

  const settleRef = useRef(() => {});
  settleRef.current = () => {
    if (!dragRef.current.armed) {
      return;
    }

    dragRef.current.armed = false;
    dragRef.current.granted = false;
    Animated.spring(position, {
      bounciness: 4,
      speed: 24,
      toValue: slotRef.current,
      useNativeDriver: true,
    }).start(() => setLifted(false));
    Animated.spring(scale, {
      bounciness: 4,
      speed: 24,
      toValue: 1,
      useNativeDriver: true,
    }).start();
    callbacksRef.current.onDragEnd(callbacksRef.current.tabId);
  };

  const panResponder = useMemo(() => PanResponder.create({
    // Claim the gesture only after a long press arms the drag; taps, the
    // close button, and scrolling keep their normal behavior otherwise.
    onMoveShouldSetPanResponderCapture: () => dragRef.current.armed,
    onPanResponderGrant: () => {
      dragRef.current.granted = true;
      dragRef.current.origin = { ...slotRef.current };
    },
    onPanResponderMove: (_event, gesture) => {
      const x = dragRef.current.origin.x + gesture.dx;
      const y = dragRef.current.origin.y + gesture.dy;
      position.setValue({ x, y });
      callbacksRef.current.onDragMove(callbacksRef.current.tabId, x, y);
    },
    onPanResponderRelease: () => settleRef.current(),
    onPanResponderTerminate: () => settleRef.current(),
    onPanResponderTerminationRequest: () => false,
  }), [position]);

  return (
    <Animated.View
      {...panResponder.panHandlers}
      style={[
        styles.tabCardSlot,
        lifted ? styles.tabCardSlotLifted : null,
        {
          transform: [
            { translateX: position.x },
            { translateY: position.y },
            { scale },
          ],
          width,
          zIndex: lifted ? 2 : 0,
        },
      ]}
    >
      <Pressable
        accessibilityRole="button"
        delayLongPress={250}
        onLongPress={() => {
          dragRef.current.armed = true;
          dragRef.current.granted = false;
          setLifted(true);
          callbacksRef.current.onDragStart(callbacksRef.current.tabId);
          Animated.spring(scale, {
            bounciness: 6,
            speed: 30,
            toValue: 1.04,
            useNativeDriver: true,
          }).start();
        }}
        onPress={onPress}
        onPressOut={() => {
          // A long press that never moved leaves the Pressable as responder,
          // so the pan responder can't deliver the release.
          if (dragRef.current.armed && !dragRef.current.granted) {
            settleRef.current();
          }
        }}
        style={cardStyle}
      >
        {children}
      </Pressable>
    </Animated.View>
  );
}

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
          source={remuxImageSource(iconUrl)}
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
  tabCardSlot: {
    bottom: 0,
    left: 0,
    position: 'absolute',
  },
  tabCardSlotLifted: {
    shadowColor: '#000',
    shadowOffset: { height: 12, width: 0 },
    shadowOpacity: 0.28,
    shadowRadius: 18,
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
  tabFallbackBody: {
    alignItems: 'center',
    justifyContent: 'center',
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
