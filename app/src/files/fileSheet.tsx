import { useMemo, type ReactNode } from 'react';
import { BottomSheet, Group, Host, RNHostView } from '@expo/ui/swift-ui';
import {
  interactiveDismissDisabled,
  presentationDetents,
  presentationDragIndicator,
  type PresentationDetent,
} from '@expo/ui/swift-ui/modifiers';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { alpha, useTheme, type RemuxTheme } from '../theme/ThemeProvider';

export const fileSheetTopPadding = 20;

/** Sheet padding a caller has to add to its content height to pick a detent. */
export function fileSheetChromeHeight(bottomInset: number) {
  return fileSheetTopPadding + Math.max(bottomInset, 16);
}

/**
 * Native SwiftUI sheet, same shape as the extension detail sheet: a zero-size
 * RN anchor hosts it, the detents fix its height, and `RNHostView` (no
 * matchContents) reports that height back into Yoga so the RN content fills
 * it. Content is top-anchored because a detent list that includes `large`
 * lets UIKit grow the sheet when the keyboard appears.
 */
export function FileSheet({
  children,
  detents,
  dismissDisabled = false,
  onClose,
  onDismissed,
  visible,
}: {
  children: ReactNode;
  detents: PresentationDetent[];
  /** Held while a mutation is in flight so its result cannot land unseen. */
  dismissDisabled?: boolean;
  onClose: () => void;
  onDismissed?: () => void;
  visible: boolean;
}) {
  const insets = useSafeAreaInsets();
  const { styles } = useFileSheetTheme();
  const presentationModifiers = useMemo(() => [
    presentationDetents(detents),
    presentationDragIndicator('visible'),
    interactiveDismissDisabled(dismissDisabled),
  ], [detents, dismissDisabled]);

  return (
    <Host style={styles.anchor}>
      <BottomSheet
        isPresented={visible}
        onDismiss={onDismissed}
        onIsPresentedChange={(isPresented) => {
          if (!isPresented) {
            onClose();
          }
        }}
      >
        <Group modifiers={presentationModifiers}>
          <RNHostView>
            <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 16) }]}>
              {children}
            </View>
          </RNHostView>
        </Group>
      </BottomSheet>
    </Host>
  );
}

export function FileSheetHeader({
  subtitle,
  title,
}: {
  subtitle?: string | null;
  title: string;
}) {
  const { styles } = useFileSheetTheme();

  return (
    <View style={styles.header}>
      <Text numberOfLines={2} style={styles.title}>{title}</Text>
      {subtitle ? (
        <Text numberOfLines={3} style={styles.subtitle}>{subtitle}</Text>
      ) : null}
    </View>
  );
}

export function FileSheetMessage({ text }: { text: string }) {
  const { styles } = useFileSheetTheme();

  return <Text style={styles.message}>{text}</Text>;
}

export function FileSheetFooter({ children }: { children: ReactNode }) {
  const { styles } = useFileSheetTheme();

  return <View style={styles.footer}>{children}</View>;
}

export function FileSheetButton({
  busy = false,
  disabled = false,
  label,
  onPress,
  tone = 'neutral',
}: {
  busy?: boolean;
  disabled?: boolean;
  label: string;
  onPress: () => void;
  tone?: 'destructive' | 'neutral' | 'primary';
}) {
  const { styles, theme } = useFileSheetTheme();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        tone === 'destructive' ? styles.destructiveButton : null,
        tone === 'primary' ? styles.primaryButton : null,
        pressed && !disabled ? styles.buttonPressed : null,
        disabled && !busy ? styles.buttonDisabled : null,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={tone === 'destructive' ? theme.danger : theme.text} size="small" />
      ) : null}
      <Text
        style={[styles.buttonText, tone === 'destructive' ? styles.destructiveButtonText : null]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export function useFileSheetTheme() {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  return { styles, theme };
}

function createStyles(theme: RemuxTheme) {
  return StyleSheet.create({
    anchor: {
      height: 0,
      position: 'absolute',
      width: 0,
    },
    button: {
      alignItems: 'center',
      backgroundColor: theme.surfaceHover,
      borderColor: theme.border,
      borderRadius: 999,
      borderWidth: 1,
      flexDirection: 'row',
      gap: 8,
      justifyContent: 'center',
      minHeight: 44,
      paddingHorizontal: 18,
    },
    buttonDisabled: {
      opacity: 0.45,
    },
    buttonPressed: {
      opacity: 0.72,
    },
    buttonText: {
      color: theme.text,
      fontSize: 15,
      fontWeight: '700',
      lineHeight: 20,
    },
    destructiveButton: {
      backgroundColor: alpha(theme.danger, 0.16),
      borderColor: alpha(theme.danger, 0.5),
    },
    destructiveButtonText: {
      color: theme.danger,
    },
    footer: {
      flexDirection: 'row',
      gap: 10,
      marginTop: 18,
      paddingHorizontal: 18,
    },
    header: {
      paddingHorizontal: 18,
    },
    message: {
      color: theme.danger,
      fontSize: 13,
      lineHeight: 18,
      marginTop: 12,
      paddingHorizontal: 18,
    },
    primaryButton: {
      backgroundColor: alpha(theme.focusRing, 0.16),
      borderColor: theme.focusRing,
    },
    // Background, corner radius, and grabber belong to the native sheet;
    // painting over them would cover the system glass.
    sheet: {
      flex: 1,
      paddingTop: fileSheetTopPadding,
    },
    subtitle: {
      color: theme.textMuted,
      fontSize: 14,
      lineHeight: 19,
      marginTop: 6,
    },
    title: {
      color: theme.text,
      fontSize: 20,
      fontWeight: '800',
      lineHeight: 26,
    },
  });
}
