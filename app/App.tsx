import { useKeepAwake } from 'expo-keep-awake';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { RemuxConnectionProvider } from './src/remote/RemuxConnectionProvider';
import { RemuxApp } from './src/remux/RemuxApp';
import { RemuxNotificationProvider } from './src/notifications/RemuxNotificationProvider';

export default function App() {
  useKeepAwake();

  return (
    <SafeAreaProvider>
      <RemuxConnectionProvider>
        <RemuxNotificationProvider>
          <RemuxApp />
        </RemuxNotificationProvider>
      </RemuxConnectionProvider>
      <StatusBar style="light" />
    </SafeAreaProvider>
  );
}
