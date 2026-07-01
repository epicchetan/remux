import { useKeepAwake } from 'expo-keep-awake';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { RemuxConnectionProvider } from './src/remote/RemuxConnectionProvider';
import { RemuxApp } from './src/remux/RemuxApp';
import { RemuxNotificationProvider } from './src/notifications/RemuxNotificationProvider';
import { RemuxThemeProvider, useTheme } from './src/theme/ThemeProvider';

export default function App() {
  useKeepAwake();

  return (
    <SafeAreaProvider>
      <RemuxThemeProvider>
        <RemuxConnectionProvider>
          <RemuxNotificationProvider>
            <RemuxApp />
          </RemuxNotificationProvider>
        </RemuxConnectionProvider>
        <ThemedStatusBar />
      </RemuxThemeProvider>
    </SafeAreaProvider>
  );
}

function ThemedStatusBar() {
  const theme = useTheme();
  return <StatusBar style={theme.statusBarStyle} />;
}
