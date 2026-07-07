import { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { remuxImageSource, themedIconUrl, type RemuxExtensionLauncher } from '../remote/remuxExtensions';
import { useTheme, type RemuxTheme } from '../theme/ThemeProvider';
import { NativeGlassRoundedRect } from '../ui/NativeGlassIconButton';
import { getBottomBarHeight, tabGridHorizontalPadding } from './browserLayout';
import { useBrowserStore } from './browserStore';

const menuWidth = 250;
const menuRowHeight = 46;
const menuVerticalPadding = 6;
const menuCornerRadius = 24;
const menuMaxVisibleRows = 6.5;
const menuBottomGap = 10;
const menuClosedScale = 0.55;

type LauncherMenuProps = {
  onClose: () => void;
  visible: boolean;
};

export function LauncherMenu({ onClose, visible }: LauncherMenuProps) {
  const insets = useSafeAreaInsets();
  const extensions = useBrowserStore((state) => state.extensions);
  const openResource = useBrowserStore((state) => state.openResource);
  const theme = useTheme();
  const progress = useRef(new Animated.Value(0)).current;
  const [rendered, setRendered] = useState(visible);
  const launchers = extensions.flatMap((extension) => extension.launchers);
  const styles = useMemo(() => createStyles(theme), [theme]);

  useEffect(() => {
    if (visible) {
      setRendered(true);
      Animated.spring(progress, {
        bounciness: 5,
        speed: 24,
        toValue: 1,
        useNativeDriver: true,
      }).start();
      return;
    }

    Animated.timing(progress, {
      duration: 140,
      toValue: 0,
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished) {
        setRendered(false);
      }
    });
  }, [progress, visible]);

  if (!rendered || launchers.length === 0) {
    return null;
  }

  const menuHeight = Math.min(
    launchers.length * menuRowHeight,
    Math.floor(menuMaxVisibleRows * menuRowHeight),
  ) + menuVerticalPadding * 2;
  // Fake a bottom-right transform origin: offset by half the size lost to scaling.
  const originShift = (1 - menuClosedScale) / 2;
  const panelTransform = [
    {
      translateX: progress.interpolate({
        inputRange: [0, 1],
        outputRange: [menuWidth * originShift, 0],
      }),
    },
    {
      translateY: progress.interpolate({
        inputRange: [0, 1],
        outputRange: [menuHeight * originShift, 0],
      }),
    },
    {
      scale: progress.interpolate({
        inputRange: [0, 1],
        outputRange: [menuClosedScale, 1],
      }),
    },
  ];

  return (
    <View style={styles.overlay}>
      <Animated.View style={[StyleSheet.absoluteFill, { opacity: progress }]}>
        <Pressable
          accessibilityLabel="Close launcher menu"
          onPress={onClose}
          style={[StyleSheet.absoluteFill, styles.scrim]}
        />
      </Animated.View>
      <Animated.View
        style={[
          styles.panel,
          {
            bottom: getBottomBarHeight(insets.bottom) + menuBottomGap,
            height: menuHeight,
            opacity: progress,
            transform: panelTransform,
          },
        ]}
      >
        <View pointerEvents="none" style={styles.panelGlass}>
          <NativeGlassRoundedRect cornerRadius={menuCornerRadius} height={menuHeight} width={menuWidth} />
        </View>
        <ScrollView
          bounces={false}
          contentContainerStyle={styles.rows}
          showsVerticalScrollIndicator={false}
          style={styles.rowScroller}
        >
          {launchers.map((launcher, index) => (
            <LauncherRow
              first={index === 0}
              key={`${launcher.extensionId}:${launcher.id}`}
              launcher={launcher}
              onPress={() => {
                onClose();
                void openResource({
                  extensionId: launcher.extensionId,
                  launch: launcher.route?.launch ?? null,
                  resourceKind: launcher.route?.resourceKind ?? null,
                  title: launcher.label,
                  viewId: launcher.view,
                }, { disposition: 'new' });
              }}
              styles={styles}
            />
          ))}
        </ScrollView>
      </Animated.View>
    </View>
  );
}

type LauncherMenuStyles = ReturnType<typeof createStyles>;

function LauncherRow({
  first,
  launcher,
  onPress,
  styles,
}: {
  first: boolean;
  launcher: RemuxExtensionLauncher;
  onPress: () => void;
  styles: LauncherMenuStyles;
}) {
  const theme = useTheme();
  const [imageFailed, setImageFailed] = useState(false);
  const iconUrl = themedIconUrl(launcher, theme.isDark);

  return (
    <Pressable
      accessibilityLabel={`Open ${launcher.label}`}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        first ? null : styles.rowDivided,
        pressed ? styles.rowPressed : null,
      ]}
    >
      <View style={styles.rowIcon}>
        {iconUrl && !imageFailed ? (
          <Image
            accessibilityIgnoresInvertColors
            onError={() => setImageFailed(true)}
            resizeMode="cover"
            source={remuxImageSource(iconUrl)}
            style={styles.rowIconImage}
          />
        ) : (
          <Text style={styles.rowIconFallback}>
            {launcher.label.trim().slice(0, 1).toUpperCase() || 'R'}
          </Text>
        )}
      </View>
      <Text numberOfLines={1} style={styles.rowLabel}>{launcher.label}</Text>
    </Pressable>
  );
}

function createStyles(theme: RemuxTheme) {
  return StyleSheet.create({
    overlay: {
      bottom: 0,
      left: 0,
      position: 'absolute',
      right: 0,
      top: 0,
      zIndex: 4,
    },
    panel: {
      position: 'absolute',
      right: tabGridHorizontalPadding,
      width: menuWidth,
    },
    panelGlass: {
      bottom: 0,
      left: 0,
      position: 'absolute',
      right: 0,
      top: 0,
    },
    row: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: 12,
      height: menuRowHeight,
      paddingHorizontal: 16,
    },
    rowDivided: {
      borderTopColor: theme.borderSubtle,
      borderTopWidth: StyleSheet.hairlineWidth,
    },
    rowIcon: {
      alignItems: 'center',
      backgroundColor: theme.surfaceHover,
      borderRadius: 7,
      height: 28,
      justifyContent: 'center',
      overflow: 'hidden',
      width: 28,
    },
    rowIconFallback: {
      color: theme.text,
      fontSize: 15,
      fontWeight: '800',
      lineHeight: 19,
    },
    rowIconImage: {
      height: 28,
      width: 28,
    },
    rowLabel: {
      color: theme.text,
      flex: 1,
      fontSize: 16,
      fontWeight: '600',
      lineHeight: 20,
    },
    rowPressed: {
      backgroundColor: theme.overlay,
    },
    rows: {
      paddingVertical: menuVerticalPadding,
    },
    rowScroller: {
      borderRadius: menuCornerRadius,
      flex: 1,
      overflow: 'hidden',
    },
    scrim: {
      backgroundColor: theme.isDark ? 'rgba(0, 0, 0, 0.35)' : 'rgba(0, 0, 0, 0.12)',
    },
  });
}
