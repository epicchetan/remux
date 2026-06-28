import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';

const settingsVersion = 1;
const settingsStorageKey = 'remux.connection.settings.v1';
const fallbackOrigin = process.env.EXPO_PUBLIC_REMUX_ORIGIN || 'http://100.65.220.71:48123';
const fallbackSettings = settingsFromOrigin(fallbackOrigin);

type RemuxSettingsStatus = 'idle' | 'loading' | 'ready' | 'saving' | 'error';

type RemuxSettingsState = {
  error: string | null;
  host: string;
  loaded: boolean;
  loadSettings: () => Promise<void>;
  port: number;
  saveSettings: (settings: { host: string; port: number | string }) => Promise<void>;
  status: RemuxSettingsStatus;
};

export const useRemuxSettingsStore = create<RemuxSettingsState>((set, get) => ({
  error: null,
  host: fallbackSettings.host,
  loaded: false,
  loadSettings: async () => {
    if (get().loaded || get().status === 'loading') {
      return;
    }

    set({ error: null, status: 'loading' });
    try {
      const stored = await AsyncStorage.getItem(settingsStorageKey);
      const parsed = stored ? parseStoredSettings(stored) : null;
      set({
        error: null,
        host: parsed?.host ?? fallbackSettings.host,
        loaded: true,
        port: parsed?.port ?? fallbackSettings.port,
        status: 'ready',
      });
    } catch (error) {
      set({
        error: errorMessage(error),
        host: fallbackSettings.host,
        loaded: true,
        port: fallbackSettings.port,
        status: 'error',
      });
    }
  },
  port: fallbackSettings.port,
  saveSettings: async (settings) => {
    const normalized = normalizeSettings(settings);
    set({ error: null, status: 'saving' });
    try {
      await AsyncStorage.setItem(settingsStorageKey, JSON.stringify({
        host: normalized.host,
        port: normalized.port,
        version: settingsVersion,
      }));
      set({
        error: null,
        host: normalized.host,
        loaded: true,
        port: normalized.port,
        status: 'ready',
      });
    } catch (error) {
      set({
        error: errorMessage(error),
        status: 'error',
      });
      throw error;
    }
  },
  status: 'idle',
}));

export function currentRemuxOrigin() {
  const state = useRemuxSettingsStore.getState();
  return remuxOriginFromSettings({
    host: state.host,
    port: state.port,
  });
}

export function currentRemuxWebSocketUrl() {
  return websocketUrl(currentRemuxOrigin(), '/ws');
}

export function remuxOriginFromSettings({ host, port }: { host: string; port: number }) {
  const normalizedHost = host.includes(':') && !host.startsWith('[') && !host.endsWith(']')
    ? `[${host}]`
    : host;
  return `http://${normalizedHost}:${port}`;
}

export function websocketUrl(origin: string, path: string) {
  const protocol = origin.startsWith('https:') ? 'wss:' : 'ws:';
  return `${protocol}${origin.replace(/^https?:/u, '')}${path}`;
}

function normalizeSettings({ host, port }: { host: string; port: number | string }) {
  const normalizedHost = normalizeHost(host);
  const normalizedPort = normalizePort(port);

  return {
    host: normalizedHost,
    port: normalizedPort,
  };
}

function normalizeHost(host: string) {
  const trimmed = host.trim();
  if (!trimmed) {
    throw new Error('Host is required.');
  }

  if (/^https?:\/\//u.test(trimmed)) {
    const url = new URL(trimmed);
    if (!url.hostname) {
      throw new Error('Host is required.');
    }

    return url.hostname;
  }

  const withoutPath = trimmed.split('/')[0] ?? trimmed;
  if (!withoutPath) {
    throw new Error('Host is required.');
  }

  const ipv6Match = /^\[([^\]]+)\](?::\d+)?$/u.exec(withoutPath);
  if (ipv6Match) {
    return ipv6Match[1]!;
  }

  const hostPortMatch = /^([^:]+):\d+$/u.exec(withoutPath);
  return hostPortMatch ? hostPortMatch[1]! : withoutPath;
}

function normalizePort(port: number | string) {
  const parsedPort = typeof port === 'number' ? port : Number.parseInt(port.trim(), 10);
  if (!Number.isInteger(parsedPort) || parsedPort <= 0 || parsedPort > 65535) {
    throw new Error('Port must be between 1 and 65535.');
  }

  return parsedPort;
}

function settingsFromOrigin(origin: string) {
  try {
    const url = new URL(origin);
    return {
      host: url.hostname || '100.65.220.71',
      port: url.port ? Number.parseInt(url.port, 10) : 80,
    };
  } catch {
    return {
      host: '100.65.220.71',
      port: 48123,
    };
  }
}

function parseStoredSettings(text: string) {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed) || parsed.version !== settingsVersion) {
    return null;
  }

  if (typeof parsed.host !== 'string' || typeof parsed.port !== 'number') {
    return null;
  }

  return normalizeSettings({
    host: parsed.host,
    port: parsed.port,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
