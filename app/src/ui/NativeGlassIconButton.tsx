import type { ComponentProps } from 'react';
import { Button, Host, Image as SwiftImage, ZStack } from '@expo/ui/swift-ui';
import {
  accessibilityLabel as swiftAccessibilityLabel,
  buttonStyle,
  disabled as swiftDisabled,
  frame,
  glassEffect,
} from '@expo/ui/swift-ui/modifiers';
import type { StyleProp, ViewStyle } from 'react-native';

import { useTheme } from '../theme/ThemeProvider';

type NativeGlassIconButtonProps = {
  accessibilityLabel: string;
  color?: string;
  disabled?: boolean;
  iconSize?: number;
  onPress?: () => void;
  size: number;
  style?: StyleProp<ViewStyle>;
  systemImage: ComponentProps<typeof SwiftImage>['systemName'];
};

export function NativeGlassIconButton({
  accessibilityLabel,
  color,
  disabled = false,
  iconSize = 16,
  onPress,
  size,
  style,
  systemImage,
}: NativeGlassIconButtonProps) {
  const theme = useTheme();
  const iconColor = color ?? theme.text;

  return (
    <Host matchContents style={[{ height: size, width: size }, style]}>
      <Button
        modifiers={[
          buttonStyle('plain'),
          swiftAccessibilityLabel(accessibilityLabel),
          swiftDisabled(disabled),
        ]}
        onPress={disabled ? undefined : onPress}
      >
        <ZStack
          modifiers={[
            frame({
              alignment: 'center',
              height: size,
              width: size,
            }),
            glassEffect({
              glass: {
                interactive: true,
                variant: 'regular',
              },
              shape: 'circle',
            }),
          ]}
        >
          <SwiftImage color={iconColor} size={iconSize} systemName={systemImage} />
        </ZStack>
      </Button>
    </Host>
  );
}

type NativeGlassCircleProps = {
  size: number;
  style?: StyleProp<ViewStyle>;
  tint?: string;
};

export function NativeGlassCircle({
  size,
  style,
  tint,
}: NativeGlassCircleProps) {
  return (
    <Host matchContents style={[{ height: size, width: size }, style]}>
      <ZStack
        modifiers={[
          frame({
            alignment: 'center',
            height: size,
            width: size,
          }),
          glassEffect({
            glass: {
              interactive: true,
              tint,
              variant: 'regular',
            },
            shape: 'circle',
          }),
        ]}
      >
        <SwiftImage color="transparent" size={1} systemName="circle" />
      </ZStack>
    </Host>
  );
}

type NativeGlassRoundedRectProps = {
  cornerRadius: number;
  height: number;
  style?: StyleProp<ViewStyle>;
  tint?: string;
  width: number;
};

export function NativeGlassRoundedRect({
  cornerRadius,
  height,
  style,
  tint,
  width,
}: NativeGlassRoundedRectProps) {
  return (
    <Host matchContents style={[{ height, width }, style]}>
      <ZStack
        modifiers={[
          frame({
            alignment: 'center',
            height,
            width,
          }),
          glassEffect({
            cornerRadius,
            glass: {
              interactive: true,
              tint,
              variant: 'regular',
            },
            shape: 'roundedRectangle',
          }),
        ]}
      >
        <SwiftImage color="transparent" size={1} systemName="circle" />
      </ZStack>
    </Host>
  );
}

type NativeGlassCapsuleProps = {
  height: number;
  style?: StyleProp<ViewStyle>;
  tint?: string;
  width: number;
};

export function NativeGlassCapsule({
  height,
  style,
  tint,
  width,
}: NativeGlassCapsuleProps) {
  return (
    <Host matchContents style={[{ height, width }, style]}>
      <ZStack
        modifiers={[
          frame({
            alignment: 'center',
            height,
            width,
          }),
          glassEffect({
            glass: {
              interactive: true,
              tint,
              variant: 'regular',
            },
            shape: 'capsule',
          }),
        ]}
      >
        <SwiftImage color="transparent" size={1} systemName="circle" />
      </ZStack>
    </Host>
  );
}
