import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useMemo } from 'react';
import {
  bottomBarControlHeight,
  bottomBarMinPaddingBottom,
  bottomBarPaddingTop,
  tabGridHorizontalPadding,
} from './browserLayout';
import type { BrowserSection } from './browserTypes';
import { useBrowserStore } from './browserStore';
import {
  NativeGlassCapsule,
  NativeGlassCircle,
  NativeGlassIconButton,
} from '../ui/NativeGlassIconButton';
import { useTheme, type RemuxTheme } from '../theme/ThemeProvider';

const sectionControlHeight = 30;
const sectionControlWidth = 132;
const sectionOptionWidth = sectionControlWidth / 2;
const sectionSelectedInset = 2;
const sections: BrowserSection[] = ['tabs', 'files'];

export function BrowserBottomBar() {
  const insets = useSafeAreaInsets();
  const activeTabId = useBrowserStore((state) => state.activeTabId);
  const closeOverview = useBrowserStore((state) => state.closeOverview);
  const extensions = useBrowserStore((state) => state.extensions);
  const openResource = useBrowserStore((state) => state.openResource);
  const section = useBrowserStore((state) => state.section);
  const setSection = useBrowserStore((state) => state.setSection);
  const theme = useTheme();
  const visibleLaunchers = extensions.flatMap((extension) => extension.launchers).slice(0, 4);
  const selectedOverviewSection = section === 'tabs' || section === 'files' ? section : null;
  const styles = useMemo(() => createStyles(theme), [theme]);

  return (
    <View
      pointerEvents="box-none"
      style={[styles.bottomChrome, { paddingBottom: Math.max(insets.bottom, bottomBarMinPaddingBottom) }]}
    >
      <View style={styles.leadingControls}>
        {activeTabId ? (
          <NativeGlassIconButton
            accessibilityLabel="Return to tab"
            iconSize={17}
            onPress={closeOverview}
            size={bottomBarControlHeight}
            systemImage="arrow.uturn.backward"
          />
        ) : null}
        <View style={styles.sectionControl}>
          <View pointerEvents="none" style={styles.sectionGlass}>
            <NativeGlassCapsule
              height={sectionControlHeight}
              width={sectionControlWidth}
            />
          </View>
          {selectedOverviewSection ? (
            <View
              pointerEvents="none"
              style={[
                styles.sectionSelected,
                selectedOverviewSection === 'files' ? styles.sectionSelectedFiles : null,
              ]}
            >
              <NativeGlassCapsule
                height={sectionControlHeight - sectionSelectedInset * 2}
                width={sectionOptionWidth - sectionSelectedInset * 2}
              />
            </View>
          ) : null}
          {sections.map((item) => {
            const selected = section === item;

            return (
              <Pressable
                accessibilityLabel={item === 'tabs' ? 'Show tabs' : 'Show files'}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                key={item}
                onPress={() => setSection(item)}
                style={({ pressed }) => [
                  styles.sectionButton,
                  pressed ? styles.sectionButtonPressed : null,
                ]}
              >
                <Text style={[styles.sectionLabel, selected ? styles.sectionLabelSelected : null]}>
                  {item === 'tabs' ? 'Tabs' : 'Files'}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      <View style={styles.actions}>
        {visibleLaunchers.map((launcher) => (
          <Pressable
            accessibilityLabel={`Open ${launcher.label}`}
            accessibilityRole="button"
            key={`${launcher.extensionId}:${launcher.id}`}
            onPress={() => {
              void openResource({
                extensionId: launcher.extensionId,
                launch: launcher.route?.launch ?? null,
                resourceKind: launcher.route?.resourceKind ?? null,
                title: launcher.label,
                viewId: launcher.view,
              }, { disposition: 'new' });
            }}
            style={({ pressed }) => [
              styles.extensionButton,
              pressed ? styles.extensionButtonPressed : null,
            ]}
          >
            <View pointerEvents="none" style={styles.extensionGlass}>
              <NativeGlassCircle size={bottomBarControlHeight} />
            </View>
            {launcher.iconUrl ? (
              <Image
                accessibilityIgnoresInvertColors
                source={{ uri: launcher.iconUrl }}
                style={styles.extensionIcon}
              />
            ) : (
              <Text style={styles.extensionFallback}>{launcher.label.slice(0, 1)}</Text>
            )}
          </Pressable>
        ))}
        <NativeGlassIconButton
          accessibilityLabel="Settings"
          iconSize={17}
          onPress={() => setSection('settings')}
          size={bottomBarControlHeight}
          systemImage="gearshape"
        />
      </View>
    </View>
  );
}

function createStyles(theme: RemuxTheme) {
  return StyleSheet.create({
  actions: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 14,
    height: bottomBarControlHeight,
  },
  bottomChrome: {
    alignItems: 'center',
    backgroundColor: 'transparent',
    bottom: 0,
    flexDirection: 'row',
    justifyContent: 'space-between',
    left: 0,
    paddingHorizontal: tabGridHorizontalPadding,
    paddingTop: bottomBarPaddingTop,
    position: 'absolute',
    right: 0,
    zIndex: 3,
  },
  leadingControls: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
  },
  sectionButton: {
    alignItems: 'center',
    height: sectionControlHeight,
    justifyContent: 'center',
    width: sectionOptionWidth,
  },
  sectionButtonPressed: {
    opacity: 0.7,
  },
  sectionControl: {
    alignItems: 'center',
    flexDirection: 'row',
    height: sectionControlHeight,
    position: 'relative',
    width: sectionControlWidth,
  },
  sectionGlass: {
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  sectionLabel: {
    color: theme.text,
    fontSize: 16,
    fontWeight: '700',
    lineHeight: 20,
    opacity: 0.92,
  },
  sectionLabelSelected: {
    opacity: 1,
  },
  sectionSelected: {
    height: sectionControlHeight - sectionSelectedInset * 2,
    left: sectionSelectedInset,
    position: 'absolute',
    top: sectionSelectedInset,
    width: sectionOptionWidth - sectionSelectedInset * 2,
  },
  sectionSelectedFiles: {
    left: sectionOptionWidth + sectionSelectedInset,
  },
  extensionButton: {
    alignItems: 'center',
    height: bottomBarControlHeight,
    justifyContent: 'center',
    opacity: 0.88,
    position: 'relative',
    width: bottomBarControlHeight,
  },
  extensionButtonPressed: {
    opacity: 0.58,
  },
  extensionFallback: {
    color: theme.text,
    fontSize: 17,
    fontWeight: '800',
    lineHeight: 22,
  },
  extensionIcon: {
    borderRadius: 6,
    height: 22,
    width: 22,
  },
  extensionGlass: {
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  });
}
