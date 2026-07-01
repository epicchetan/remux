import { nativeTokens, type NativeRemuxTokens } from '@remux/viewer-kit/tokens.native';
import { setBackgroundColorAsync } from 'expo-system-ui';
import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { Platform, useColorScheme } from 'react-native';
import type { StatusBarStyle } from 'expo-status-bar';

export type RemuxThemeName = 'light' | 'dark';

export type RemuxTheme = NativeRemuxTokens & {
  isDark: boolean;
  name: RemuxThemeName;
  statusBarStyle: StatusBarStyle;
};

const ThemeContext = createContext<RemuxTheme | null>(null);

export function RemuxThemeProvider({ children }: { children: ReactNode }) {
  const systemScheme = useColorScheme();
  const name: RemuxThemeName = systemScheme === 'light' ? 'light' : 'dark';
  const value = useMemo<RemuxTheme>(() => ({
    ...nativeTokens[name],
    isDark: name === 'dark',
    name,
    statusBarStyle: name === 'light' ? 'dark' : 'light',
  }), [name]);

  useEffect(() => {
    if (Platform.OS === 'web') {
      return;
    }

    void setBackgroundColorAsync(value.surface).catch(() => undefined);
  }, [value.surface]);

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const theme = useContext(ThemeContext);
  if (!theme) {
    throw new Error('useTheme must be used inside RemuxThemeProvider');
  }

  return theme;
}

export function alpha(color: string, opacity: number) {
  if (color.startsWith('rgba(')) {
    const channels = color.slice(5, -1).split(',').map((part) => part.trim());
    return `rgba(${channels[0]}, ${channels[1]}, ${channels[2]}, ${opacity})`;
  }

  const normalized = color.replace(/^#/u, '');
  if (normalized.length !== 6) {
    return color;
  }

  const integer = Number.parseInt(normalized, 16);
  const r = (integer >> 16) & 255;
  const g = (integer >> 8) & 255;
  const b = integer & 255;
  return `rgba(${r}, ${g}, ${b}, ${opacity})`;
}
