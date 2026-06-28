import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppState, Platform } from 'react-native';
import * as Notifications from 'expo-notifications';

import { useBrowserStore, matchesBrowserTabTarget } from '../browser/browserStore';
import type { BrowserTabTarget, ViewerTab } from '../browser/browserTypes';
import { logRemuxDebug } from '../remote/remuxDebug';
import { useRemuxConnection, type RemuxConnection } from '../remote/RemuxConnectionProvider';
import { useRemuxSettingsStore } from '../remote/remuxSettingsStore';

const clientIdStorageKey = 'remux.notifications.clientId.v1';
const remuxClientRegisterMethod = 'remux/clients/register';
const remuxNotificationDataKey = 'remuxNotificationIntent';
const remuxVisibilityCheckMethod = 'remux/notifications/visibility/check';
const remuxNotificationChannelId = 'remux-extension-events';
const registrationTimeoutMs = 3_000;

export type RemuxNotificationIntent = {
  body: string | null;
  extensionId: string;
  id: string;
  target: RemuxNotificationTarget;
  title: string;
  viewId: string;
};

type RemuxNotificationTarget = {
  focusId: string | null;
  focusKind: string | null;
  handlerId: string | null;
  launch: string | null;
  resourceId: string | null;
  resourceKind: string | null;
};

type RemuxClientRegistration = {
  activeTarget: BrowserTabTarget | null;
  appState: string;
  clientId: string;
  expoPushToken?: string;
  platform: typeof Platform.OS;
  sessionId: string;
};

let androidChannelPromise: Promise<void> | null = null;

Notifications.setNotificationHandler({
  handleNotification: async (notification) => {
    const intent = parseNotificationIntentFromData(notification.request.content.data);
    const suppress = Boolean(intent && shouldSuppressIntentForCurrentView(intent));

    return {
      shouldPlaySound: false,
      shouldSetBadge: false,
      shouldShowBanner: !suppress,
      shouldShowList: !suppress,
    };
  },
});

export function RemuxNotificationProvider({ children }: { children: ReactNode }) {
  const remux = useRemuxConnection();
  const settingsLoaded = useRemuxSettingsStore((state) => state.loaded);
  const activeTabId = useBrowserStore((state) => state.activeTabId);
  const mode = useBrowserStore((state) => state.mode);
  const tabs = useBrowserStore((state) => state.tabs);
  const [appState, setAppState] = useState(AppState.currentState);
  const [clientId, setClientId] = useState<string | null>(null);
  const [expoPushToken, setExpoPushToken] = useState<string | null>(null);
  const handledNotificationResponsesRef = useRef(new Set<string>());
  const lastSuccessfulRegistrationKeyRef = useRef<string | null>(null);
  const pendingRegistrationKeyRef = useRef<string | null>(null);
  const sessionIdRef = useRef(nextSessionId());
  const activeTarget = useMemo(
    () => activeBrowserTabTarget({ activeTabId, mode, tabs }),
    [activeTabId, mode, tabs],
  );

  useEffect(() => {
    void loadOrCreateClientId()
      .then(setClientId)
      .catch((error: unknown) => {
        logRemuxDebug('notifications:client-id:failed', errorMessage(error));
      });
  }, []);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      setAppState(state);
    });

    return () => {
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    void ensureAndroidNotificationChannel();
  }, []);

  useEffect(() => {
    if (!settingsLoaded || !clientId) {
      return;
    }

    void resolveExpoPushToken()
      .then(setExpoPushToken)
      .catch((error: unknown) => {
        logRemuxDebug('notifications:expo-token:failed', errorMessage(error));
      });
  }, [clientId, settingsLoaded]);

  useEffect(() => subscribeVisibilityChecks(remux), [remux]);

  useEffect(() => {
    if (remux.status.type !== 'connected') {
      lastSuccessfulRegistrationKeyRef.current = null;
      pendingRegistrationKeyRef.current = null;
    }
  }, [remux.status.type]);

  useEffect(() => {
    if (remux.status.type !== 'connected' || !clientId) {
      return;
    }

    const registration: RemuxClientRegistration = {
      activeTarget,
      appState,
      clientId,
      ...(expoPushToken ? { expoPushToken } : {}),
      platform: Platform.OS,
      sessionId: sessionIdRef.current,
    };
    const registrationKey = JSON.stringify(registration);
    if (
      registrationKey === lastSuccessfulRegistrationKeyRef.current ||
      registrationKey === pendingRegistrationKeyRef.current
    ) {
      return;
    }

    let cancelled = false;
    pendingRegistrationKeyRef.current = registrationKey;
    void registerClient(remux, registration)
      .then((registered) => {
        if (!cancelled && registered) {
          lastSuccessfulRegistrationKeyRef.current = registrationKey;
        }
      })
      .finally(() => {
        if (!cancelled && pendingRegistrationKeyRef.current === registrationKey) {
          pendingRegistrationKeyRef.current = null;
        }
      });

    return () => {
      cancelled = true;
      if (pendingRegistrationKeyRef.current === registrationKey) {
        pendingRegistrationKeyRef.current = null;
      }
    };
  }, [activeTarget, appState, clientId, expoPushToken, remux, remux.status.type]);

  const handleNotificationResponse = useCallback(async (response: Notifications.NotificationResponse) => {
    if (response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) {
      return;
    }

    if (!useRemuxSettingsStore.getState().loaded) {
      logRemuxDebug('notifications:response:deferred-settings');
      return;
    }

    const responseId = response.notification.request.identifier;
    if (handledNotificationResponsesRef.current.has(responseId)) {
      return;
    }
    handledNotificationResponsesRef.current.add(responseId);

    const intent = parseNotificationIntentFromData(response.notification.request.content.data);
    if (!intent) {
      logRemuxDebug('notifications:response:invalid', { responseId });
      return;
    }

    const result = await useBrowserStore.getState().openNotificationTarget(tabTargetFromIntent(intent));
    Notifications.clearLastNotificationResponse();
    logRemuxDebug('notifications:response:opened', {
      ...notificationLogDetail(intent),
      result,
    });
  }, []);

  useEffect(() => {
    if (!settingsLoaded) {
      return undefined;
    }

    const response = Notifications.getLastNotificationResponse();
    if (response) {
      void handleNotificationResponse(response);
    }

    const subscription = Notifications.addNotificationResponseReceivedListener((nextResponse) => {
      void handleNotificationResponse(nextResponse);
    });

    return () => {
      subscription.remove();
    };
  }, [handleNotificationResponse, settingsLoaded]);

  return children;
}

function subscribeVisibilityChecks(remux: RemuxConnection) {
  return remux.subscribe((message) => {
    if (message.method !== remuxVisibilityCheckMethod || message.id === undefined) {
      return;
    }

    const intent = parseNotificationIntent(message.params);
    if (!intent) {
      remux.respondError(message.id, {
        code: -32602,
        message: 'Invalid visibility check params',
      });
      return;
    }

    remux.respond(message.id, {
      visible: shouldSuppressIntentForCurrentView(intent),
    });
  });
}

async function registerClient(remux: RemuxConnection, registration: RemuxClientRegistration) {
  try {
    await remux.request(remuxClientRegisterMethod, registration, registrationTimeoutMs);
    logRemuxDebug('notifications:client:registered', {
      appState: registration.appState,
      clientId: registration.clientId,
      hasExpoPushToken: Boolean(registration.expoPushToken),
      sessionId: registration.sessionId,
      target: registration.activeTarget,
    });
    return true;
  } catch (error) {
    logRemuxDebug('notifications:client:register-failed', {
      clientId: registration.clientId,
      error: errorMessage(error),
      sessionId: registration.sessionId,
    });
    return false;
  }
}

async function resolveExpoPushToken() {
  await ensureAndroidNotificationChannel();

  const allowed = await ensureNotificationPermission();
  if (!allowed) {
    return null;
  }

  const token = await Notifications.getExpoPushTokenAsync();
  return token.data;
}

async function ensureNotificationPermission() {
  let permission = await Notifications.getPermissionsAsync();
  if (notificationPermissionAllowsAlerts(permission)) {
    return true;
  }

  if (
    permission.status === Notifications.PermissionStatus.DENIED ||
    permission.ios?.status === Notifications.IosAuthorizationStatus.DENIED
  ) {
    return false;
  }

  if (AppState.currentState !== 'active') {
    return false;
  }

  permission = await Notifications.requestPermissionsAsync({
    android: {},
    ios: {
      allowAlert: true,
      allowBadge: false,
      allowSound: false,
    },
  });

  return notificationPermissionAllowsAlerts(permission);
}

function notificationPermissionAllowsAlerts(permission: Notifications.NotificationPermissionsStatus) {
  const iosStatus = permission.ios?.status;
  return permission.granted ||
    iosStatus === Notifications.IosAuthorizationStatus.AUTHORIZED ||
    iosStatus === Notifications.IosAuthorizationStatus.PROVISIONAL ||
    iosStatus === Notifications.IosAuthorizationStatus.EPHEMERAL;
}

function ensureAndroidNotificationChannel() {
  if (Platform.OS !== 'android') {
    return Promise.resolve();
  }

  if (!androidChannelPromise) {
    androidChannelPromise = Notifications.setNotificationChannelAsync(remuxNotificationChannelId, {
      importance: Notifications.AndroidImportance.DEFAULT,
      name: 'Extension updates',
      showBadge: false,
      sound: null,
    }).then(() => undefined);
  }

  return androidChannelPromise;
}

function shouldSuppressIntentForCurrentView(intent: RemuxNotificationIntent) {
  if (AppState.currentState !== 'active') {
    return false;
  }

  const state = useBrowserStore.getState();
  if (state.mode !== 'surface' || !state.activeTabId) {
    return false;
  }

  const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId);
  return activeTab
    ? matchesBrowserTabTarget(activeTab, intent.extensionId, tabTargetFromIntent(intent))
    : false;
}

function activeBrowserTabTarget({
  activeTabId,
  mode,
  tabs,
}: {
  activeTabId: string | null;
  mode: string;
  tabs: ViewerTab[];
}): BrowserTabTarget | null {
  if (mode !== 'surface' || !activeTabId) {
    return null;
  }

  const tab = tabs.find((candidate) => candidate.id === activeTabId);
  if (!tab) {
    return null;
  }

  return {
    extensionId: tab.extensionId,
    handlerId: tab.handlerId,
    launch: tab.launch,
    resourceId: tab.resourceId,
    resourceKind: tab.resourceKind,
    viewId: tab.viewId,
  };
}

function tabTargetFromIntent(intent: RemuxNotificationIntent): BrowserTabTarget {
  return {
    extensionId: intent.extensionId,
    handlerId: intent.target.handlerId,
    launch: intent.target.launch,
    resourceId: intent.target.resourceId,
    resourceKind: intent.target.resourceKind,
    viewId: intent.viewId,
  };
}

function parseNotificationIntentFromData(data: Record<string, unknown> | undefined): RemuxNotificationIntent | null {
  if (!data) {
    return null;
  }

  return parseNotificationIntent(data[remuxNotificationDataKey]);
}

function parseNotificationIntent(value: unknown): RemuxNotificationIntent | null {
  if (!isRecord(value)) {
    return null;
  }

  const id = requiredString(value.id);
  const extensionId = requiredString(value.extensionId);
  const title = requiredString(value.title);
  if (!id || !extensionId || !title) {
    return null;
  }

  const target = isRecord(value.target) ? value.target : {};
  return {
    body: optionalString(value.body),
    extensionId,
    id,
    target: {
      focusId: optionalString(target.focusId),
      focusKind: optionalString(target.focusKind),
      handlerId: optionalString(target.handlerId),
      launch: optionalString(target.launch),
      resourceId: optionalString(target.resourceId),
      resourceKind: optionalString(target.resourceKind),
    },
    title,
    viewId: optionalString(value.viewId) ?? 'main',
  };
}

function notificationLogDetail(intent: RemuxNotificationIntent) {
  return {
    extensionId: intent.extensionId,
    id: intent.id,
    resourceId: intent.target.resourceId,
    resourceKind: intent.target.resourceKind,
    viewId: intent.viewId,
  };
}

async function loadOrCreateClientId() {
  const stored = await AsyncStorage.getItem(clientIdStorageKey);
  if (stored && stored.trim().length > 0) {
    return stored;
  }

  const clientId = `remux-mobile:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  await AsyncStorage.setItem(clientIdStorageKey, clientId);
  return clientId;
}

function nextSessionId() {
  return `session:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

function requiredString(value: unknown) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function optionalString(value: unknown) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
