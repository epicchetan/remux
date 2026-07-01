import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import * as Clipboard from 'expo-clipboard';
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';
import {
  ActivityIndicator,
  AppState,
  Keyboard,
  Pressable,
  StyleSheet,
  Text,
  View,
  type KeyboardEvent,
} from 'react-native';
import WebView, {
  type WebViewMessageEvent,
} from 'react-native-webview';
import type {
  ShouldStartLoadRequest,
  WebViewErrorEvent,
  WebViewHttpErrorEvent,
  WebViewNavigationEvent,
  WebViewRenderProcessGoneEvent,
  WebViewTerminatedEvent,
} from 'react-native-webview/lib/WebViewTypes';

import { logRemuxDebug } from '../../remote/remuxDebug';
import {
  useRemuxConnection,
  type RemuxConnectionStatus,
} from '../../remote/RemuxConnectionProvider';
import type { RemuxRpcMessage } from '../../remote/remuxRpcClient';
import { useTheme, type RemuxTheme, type RemuxThemeName } from '../../theme/ThemeProvider';
import type { BrowserPendingNavigation, BrowserSection, ViewerTab } from '../../browser/browserTypes';
import { serializedResourceKey } from '../../browser/resourceKeys';

let nextWebViewInstanceId = 1;

type JsonRpcId = number | string;

type RemuxViewHostStatus =
  | { type: 'idle' }
  | { type: 'connecting' }
  | { cwd: string | null; type: 'connected' }
  | { type: 'reconnecting'; attempt: number }
  | { type: 'closed'; reason?: string }
  | { type: 'error'; message: string };

type WebViewToNativeMessage =
  | {
      id: JsonRpcId;
      method: string;
      params?: unknown;
      timeoutMs?: number;
      type: 'remux/request';
    }
  | {
      id: string;
      type: 'remux/health/pong';
    }
  | {
      type: 'remux/ready';
    }
  | {
      method: string;
      params?: unknown;
      type: 'remux/notify';
    }
  | {
      level: 'debug' | 'error' | 'info' | 'log' | 'warn';
      message: string;
      type: 'remux/webview-log';
    };

type InvalidWebViewRequest = {
  id?: JsonRpcId;
  message: string;
  type: 'remux/invalid-request';
};

type NativeToWebViewMessage =
  | {
      id: JsonRpcId;
      result: unknown;
      type: 'remux/response';
    }
  | {
      error: {
        code?: number;
        data?: unknown;
        message: string;
      };
      id?: JsonRpcId;
      type: 'remux/error';
    }
  | {
      message: RemuxRpcMessage;
      type: 'remux/event';
    }
  | {
      message: {
        method: 'host/viewport/changed';
        params: HostViewportMetrics;
      };
      type: 'remux/event';
    }
  | {
      message: {
        method: 'host/theme';
        params: { theme: RemuxThemeName };
      };
      type: 'remux/event';
    }
  | {
      error: string | null;
      status: RemuxViewHostStatus;
      type: 'remux/status';
    }
  | {
      id: string;
      type: 'remux/health/ping';
    };

type WebViewPageState =
  | { type: 'loading' }
  | { type: 'ready' }
  | { message: string; type: 'failed' };

type WebViewFrame = {
  height: number;
  width: number;
  x: number;
  y: number;
};

type KeyboardFrame = {
  height: number;
  screenY: number;
  visible: boolean;
};

type HostViewportMetrics = {
  keyboardHeight: number;
  keyboardVisible: boolean;
  visibleBottom: number;
  visibleTop: number;
  viewportHeight: number;
  viewportWidth: number;
};

type HostAttachmentPickParams = {
  multiple?: boolean;
  picker?: 'files' | 'photo-library';
  type?: 'any' | 'image';
};

type HostAttachmentPickResult = {
  assets: Array<{
    dataUrl: string;
    mimeType: string;
    name: string;
    sizeBytes: number;
  }>;
  canceled: boolean;
};

type HostOverviewOpenParams = {
  section?: BrowserSection;
};

type HostFileOpenParams = {
  line?: number | null;
  path: string;
};

type HostFileOpenResult = {
  ok: boolean;
  reason?: string;
};

export type ExtensionTabUpdate = {
  handlerId?: string | null;
  launch?: string | null;
  resourceId?: string | null;
  resourceKind?: string | null;
  status?: string | null;
  title?: string | null;
};

const dismissKeyboardScript = `
(() => {
  const activeElement = document.activeElement;
  if (activeElement && typeof activeElement.blur === 'function') {
    activeElement.blur();
  }

  const selection = window.getSelection && window.getSelection();
  if (selection && typeof selection.removeAllRanges === 'function') {
    selection.removeAllRanges();
  }
})();
true;
`;

const healthPingTimeoutMs = 1500;
const maxAutomaticReloadAttempts = 2;
const previewKeyboardSettleTimeoutMs = 600;
const webViewReadyTimeoutMs = 8000;

type HealthPingWaiter = {
  epoch: number;
  reason: string;
  resolve: (healthy: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
};

type ExtensionWebViewProps = {
  active: boolean;
  onNavigationDelivered?: (nonce: string) => void;
  onOpenFile?: (params: HostFileOpenParams) => HostFileOpenResult | Promise<HostFileOpenResult>;
  onOpenOverview?: (section?: BrowserSection) => Promise<void> | void;
  onTabUpdate?: (patch: ExtensionTabUpdate) => void;
  pendingNavigation?: BrowserPendingNavigation | null;
  reloadSourceUrl?: string;
  sourceUrl: string;
  tab: ViewerTab;
  title: string;
};

export type ExtensionWebViewHandle = {
  dismissKeyboard: () => void;
  prepareForPreviewCapture: () => Promise<boolean>;
};

export const ExtensionWebView = forwardRef<ExtensionWebViewHandle, ExtensionWebViewProps>(function ExtensionWebView(
  {
    active,
    onNavigationDelivered,
    onOpenFile,
    onOpenOverview,
    onTabUpdate,
    pendingNavigation = null,
    reloadSourceUrl,
    sourceUrl,
    tab,
    title,
  },
  ref,
) {
  const remux = useRemuxConnection();
  const theme = useTheme();
  const [pageState, setPageState] = useState<WebViewPageState>({ type: 'loading' });
  const [reloadNonce, setReloadNonce] = useState(0);
  const [reloadTargetUrl, setReloadTargetUrl] = useState(sourceUrl);
  const automaticReloadAttemptsRef = useRef(0);
  const activeRef = useRef(active);
  const healthPingIdRef = useRef(0);
  const healthPingWaitersRef = useRef(new Map<string, HealthPingWaiter>());
  const pageEpochRef = useRef(0);
  const pageStateRef = useRef<WebViewPageState>({ type: 'loading' });
  const readyRef = useRef(false);
  const readyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const webViewRef = useRef<WebView>(null);
  const instanceIdRef = useRef(nextWebViewInstanceId++);
  const containerRef = useRef<View>(null);
  const descriptorRef = useRef({
    instanceId: instanceIdRef.current,
    reloadSourceUrl: reloadSourceUrl ?? null,
    sourceUrl,
    title,
  });
  const webViewFrameRef = useRef<WebViewFrame>({ height: 0, width: 0, x: 0, y: 0 });
  const keyboardFrameRef = useRef<KeyboardFrame>({ height: 0, screenY: 0, visible: false });
  const styles = useMemo(() => createStyles(theme), [theme]);
  const remuxRequestContext = useMemo(() => ({
    resourceKey: serializedResourceKey(tab),
    tabId: tab.id,
  }), [tab.extensionId, tab.id, tab.resourceId, tab.resourceKind, tab.viewId]);
  const injectedBeforeContentLoaded = useMemo(
    () => createWebViewBeforeContentLoadedScript(theme.name),
    [theme.name],
  );

  const clearReadyTimeout = useCallback(() => {
    if (readyTimeoutRef.current !== null) {
      clearTimeout(readyTimeoutRef.current);
      readyTimeoutRef.current = null;
    }
  }, []);

  useEffect(() => {
    pageStateRef.current = pageState;
  }, [pageState]);

  const resolveHealthPingWaiters = useCallback((healthy: boolean, reason: string) => {
    for (const [id, waiter] of healthPingWaitersRef.current) {
      clearTimeout(waiter.timer);
      logRemuxDebug('webview:health:resolve', {
        healthy,
        id,
        instanceId: instanceIdRef.current,
        pingReason: waiter.reason,
        reason,
      });
      waiter.resolve(healthy);
    }
    healthPingWaitersRef.current.clear();
  }, []);

  const advancePageEpoch = useCallback((reason: string) => {
    pageEpochRef.current += 1;
    resolveHealthPingWaiters(false, `epoch:${reason}`);
    logRemuxDebug('webview:epoch', {
      epoch: pageEpochRef.current,
      instanceId: instanceIdRef.current,
      reason,
    });
  }, [resolveHealthPingWaiters]);

  const postToWebView = useCallback((message: NativeToWebViewMessage, options: { epoch?: number } = {}) => {
    if (options.epoch !== undefined && options.epoch !== pageEpochRef.current) {
      logRemuxDebug('webview:post:dropped-stale', {
        currentEpoch: pageEpochRef.current,
        expectedEpoch: options.epoch,
        instanceId: instanceIdRef.current,
        type: message.type,
      });
      return false;
    }

    if (!readyRef.current || !webViewRef.current) {
      return false;
    }

    try {
      webViewRef.current.postMessage(JSON.stringify(message));
      return true;
    } catch (postError) {
      logRemuxDebug('webview:post:failed', {
        instanceId: instanceIdRef.current,
        message: errorMessage(postError),
        type: message.type,
      });
      return false;
    }
  }, []);

  const pingWebView = useCallback((reason: string) => {
    const epoch = pageEpochRef.current;
    const id = `health:${instanceIdRef.current}:${epoch}:${healthPingIdRef.current += 1}`;

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        healthPingWaitersRef.current.delete(id);
        logRemuxDebug('webview:health:timeout', {
          epoch,
          id,
          instanceId: instanceIdRef.current,
          reason,
        });
        resolve(false);
      }, healthPingTimeoutMs);

      healthPingWaitersRef.current.set(id, {
        epoch,
        reason,
        resolve,
        timer,
      });

      const sent = postToWebView({
        id,
        type: 'remux/health/ping',
      }, { epoch });

      logRemuxDebug('webview:health:ping', {
        epoch,
        id,
        instanceId: instanceIdRef.current,
        reason,
        sent,
      });

      if (!sent) {
        clearTimeout(timer);
        healthPingWaitersRef.current.delete(id);
        resolve(false);
      }
    });
  }, [postToWebView]);

  const postStatus = useCallback(() => {
    const message: Extract<NativeToWebViewMessage, { type: 'remux/status' }> = {
      error: remux.error,
      status: mapConnectionStatus(remux.status, remux.error),
      type: 'remux/status',
    };

    postToWebView(message);
  }, [postToWebView, remux.error, remux.status]);

  const postConnection = useCallback(() => {
    postToWebView({
      message: {
        method: 'host/connection',
        params: { status: remux.status.type },
      },
      type: 'remux/event',
    });
  }, [postToWebView, remux.status.type]);

  const postActive = useCallback((nextActive: boolean) => {
    postToWebView({
      message: {
        method: 'host/active',
        params: { active: nextActive },
      },
      type: 'remux/event',
    });
  }, [postToWebView]);

  const captureWebViewFrame = useCallback(() => {
    requestAnimationFrame(() => {
      containerRef.current?.measureInWindow((x, y, width, height) => {
        webViewFrameRef.current = { height, width, x, y };
      });
    });
  }, []);

  const hostViewportMetrics = useCallback((): HostViewportMetrics => {
    const webView = webViewFrameRef.current;
    const keyboard = keyboardFrameRef.current;
    const keyboardTop = keyboard.visible ? keyboard.screenY - webView.y : webView.height;
    const visibleBottom = clamp(keyboardTop, 0, webView.height);
    const keyboardHeight = keyboard.visible ? Math.max(0, webView.height - visibleBottom) : 0;

    return {
      keyboardHeight,
      keyboardVisible: keyboard.visible,
      visibleBottom,
      visibleTop: 0,
      viewportHeight: webView.height,
      viewportWidth: webView.width,
    };
  }, []);

  const postViewportMetrics = useCallback(() => {
    postToWebView({
      message: {
        method: 'host/viewport/changed',
        params: hostViewportMetrics(),
      },
      type: 'remux/event',
    });
  }, [hostViewportMetrics, postToWebView]);

  const postTheme = useCallback(() => {
    postToWebView({
      message: {
        method: 'host/theme',
        params: { theme: theme.name },
      },
      type: 'remux/event',
    });
  }, [postToWebView, theme.name]);

  const postPendingNavigation = useCallback(() => {
    if (!active || !pendingNavigation) {
      return;
    }

    const posted = postToWebView({
      message: {
        method: 'host/navigate',
        params: pendingNavigation,
      },
      type: 'remux/event',
    });

    if (posted) {
      onNavigationDelivered?.(pendingNavigation.nonce);
    }
  }, [active, onNavigationDelivered, pendingNavigation, postToWebView]);

  const dismissKeyboard = useCallback(() => {
    webViewRef.current?.injectJavaScript(dismissKeyboardScript);
    Keyboard.dismiss();
    captureWebViewFrame();
    setTimeout(postViewportMetrics, 0);
    setTimeout(postViewportMetrics, 120);
  }, [captureWebViewFrame, postViewportMetrics]);

  const prepareForPreviewCapture = useCallback(async () => {
    const keyboardWasVisible = keyboardFrameRef.current.visible;
    dismissKeyboard();

    if (keyboardWasVisible) {
      const keyboardSettled = await waitForKeyboardToHide(previewKeyboardSettleTimeoutMs);
      await waitForAnimationFrames(2);
      captureWebViewFrame();
      postViewportMetrics();
      return keyboardSettled && !keyboardFrameRef.current.visible;
    }

    await waitForAnimationFrames(2);
    captureWebViewFrame();
    postViewportMetrics();
    return true;
  }, [captureWebViewFrame, dismissKeyboard, postViewportMetrics]);

  useImperativeHandle(ref, () => ({
    dismissKeyboard,
    prepareForPreviewCapture,
  }), [dismissKeyboard, prepareForPreviewCapture]);

  const pickAttachments = useCallback(async (params?: HostAttachmentPickParams): Promise<HostAttachmentPickResult> => {
    if (params?.picker === 'photo-library') {
      const result = await ImagePicker.launchImageLibraryAsync({
        allowsMultipleSelection: params.multiple ?? true,
        base64: true,
        mediaTypes: ['images'],
        orderedSelection: true,
        quality: 1,
      });

      if (result.canceled) {
        return { assets: [], canceled: true };
      }

      const assets = await Promise.all(result.assets.map(imagePickerAssetToHostAttachment));
      return { assets, canceled: false };
    }

    const result = await DocumentPicker.getDocumentAsync({
      copyToCacheDirectory: true,
      multiple: params?.multiple ?? true,
      type: params?.type === 'any' ? '*/*' : 'image/*',
    });

    if (result.canceled) {
      return { assets: [], canceled: true };
    }

    const assets = await Promise.all(result.assets.map(async (asset) => {
      const mimeType = asset.mimeType || mimeTypeFromFileName(asset.name) || 'application/octet-stream';
      const base64 = await new File(asset.uri).base64();

      return {
        dataUrl: `data:${mimeType};base64,${base64}`,
        mimeType,
        name: asset.name || 'Attachment',
        sizeBytes: asset.size ?? 0,
      };
    }));

    return { assets, canceled: false };
  }, []);

  const resetWebViewReadiness = useCallback((reason = 'reset') => {
    clearReadyTimeout();
    readyRef.current = false;
    advancePageEpoch(reason);
  }, [advancePageEpoch, clearReadyTimeout]);

  const reloadWebView = useCallback((options: { automatic?: boolean; reason?: string } = {}) => {
    const reason = options.reason ?? 'manual';
    if (!options.automatic) {
      automaticReloadAttemptsRef.current = 0;
    }

    const targetUrl = reloadSourceUrl ?? sourceUrl;
    logRemuxDebug('webview:reload:requested', {
      automatic: options.automatic === true,
      instanceId: instanceIdRef.current,
      reason,
      targetUrl,
    });
    resetWebViewReadiness(`reload:${reason}`);
    setReloadTargetUrl(targetUrl);
    setPageState({ type: 'loading' });
    setReloadNonce((current) => {
      const next = current + 1;
      logRemuxDebug('webview:reload:nonce', {
        current,
        instanceId: instanceIdRef.current,
        next,
        targetUrl,
      });
      return next;
    });
  }, [reloadSourceUrl, resetWebViewReadiness, sourceUrl]);

  const activeSourceUrl = reloadNonce === 0 ? sourceUrl : reloadTargetUrl;
  const webViewSourceUrl = useMemo(
    () => sourceUrlWithReloadNonce(activeSourceUrl, reloadNonce),
    [activeSourceUrl, reloadNonce],
  );

  const failWebView = useCallback((message: string) => {
    resetWebViewReadiness('failed');
    logRemuxDebug('webview:failed', {
      instanceId: instanceIdRef.current,
      message,
    });
    setPageState({ message, type: 'failed' });
  }, [resetWebViewReadiness]);

  const autoReloadWebView = useCallback((reason: string, failureMessage: string) => {
    if (
      AppState.currentState !== 'active' ||
      automaticReloadAttemptsRef.current >= maxAutomaticReloadAttempts
    ) {
      failWebView(failureMessage);
      return;
    }

    automaticReloadAttemptsRef.current += 1;
    logRemuxDebug('webview:auto-reload', {
      attempt: automaticReloadAttemptsRef.current,
      instanceId: instanceIdRef.current,
      maxAttempts: maxAutomaticReloadAttempts,
      reason,
    });
    reloadWebView({ automatic: true, reason });
  }, [failWebView, reloadWebView]);

  const checkWebViewHealth = useCallback((reason: string) => {
    if (pageStateRef.current.type !== 'ready' || !readyRef.current) {
      logRemuxDebug('webview:health:skipped', {
        instanceId: instanceIdRef.current,
        pageState: pageStateRef.current.type,
        reason,
        ready: readyRef.current,
      });
      return;
    }

    void pingWebView(reason).then((healthy) => {
      logRemuxDebug('webview:health:result', {
        healthy,
        instanceId: instanceIdRef.current,
        reason,
      });

      if (!healthy) {
        autoReloadWebView(`health:${reason}`, `${title} stopped responding.`);
      }
    });
  }, [autoReloadWebView, pingWebView, title]);

  const handleMessage = useCallback(
    (event: WebViewMessageEvent) => {
      const message = parseWebViewMessage(event.nativeEvent.data);
      if (!message) {
        return;
      }

      switch (message.type) {
        case 'remux/ready':
          clearReadyTimeout();
          automaticReloadAttemptsRef.current = 0;
          logRemuxDebug('webview:ready', {
            epoch: pageEpochRef.current,
            instanceId: instanceIdRef.current,
          });
          readyRef.current = true;
          setPageState({ type: 'ready' });
          postStatus();
          postConnection();
          postActive(active);
          postTheme();
          break;
        case 'remux/health/pong': {
          const waiter = healthPingWaitersRef.current.get(message.id);
          if (!waiter) {
            break;
          }

          healthPingWaitersRef.current.delete(message.id);
          clearTimeout(waiter.timer);
          const healthy = waiter.epoch === pageEpochRef.current;
          logRemuxDebug('webview:health:pong', {
            currentEpoch: pageEpochRef.current,
            healthy,
            id: message.id,
            instanceId: instanceIdRef.current,
            pingEpoch: waiter.epoch,
            reason: waiter.reason,
          });
          waiter.resolve(healthy);
          break;
        }
        case 'remux/webview-log':
          logRemuxDebug(`webview:console:${message.level}`, message.message);
          break;
        case 'remux/notify':
          remux.notify(message.method, message.params);
          break;
        case 'remux/invalid-request':
          if (message.id !== undefined) {
            postToWebView({
              error: {
                code: -32600,
                message: message.message,
              },
              id: message.id,
              type: 'remux/error',
            });
          }
          break;
        case 'remux/request': {
          const requestEpoch = pageEpochRef.current;
          if (message.method === 'host/viewport/get') {
            postToWebView({
              id: message.id,
              result: hostViewportMetrics(),
              type: 'remux/response',
            }, { epoch: requestEpoch });
            break;
          }

          if (message.method === 'host/theme/get') {
            postToWebView({
              id: message.id,
              result: { theme: theme.name },
              type: 'remux/response',
            }, { epoch: requestEpoch });
            break;
          }

          if (message.method === 'host/keyboard/dismiss') {
            dismissKeyboard();
            postToWebView({
              id: message.id,
              result: hostViewportMetrics(),
              type: 'remux/response',
            }, { epoch: requestEpoch });
            break;
          }

          if (message.method === 'host/clipboard/read') {
            void Clipboard.getStringAsync()
              .then((text) => {
                postToWebView({
                  id: message.id,
                  result: { text },
                  type: 'remux/response',
                }, { epoch: requestEpoch });
              })
              .catch((requestError) => {
                postToWebView({
                  error: {
                    code: -32000,
                    message: errorMessage(requestError),
                  },
                  id: message.id,
                  type: 'remux/error',
                }, { epoch: requestEpoch });
              });
            break;
          }

          if (message.method === 'host/view/reload') {
            postToWebView({
              id: message.id,
              result: { ok: true },
              type: 'remux/response',
            }, { epoch: requestEpoch });
            setTimeout(() => reloadWebView({ reason: 'host-request' }), 0);
            break;
          }

          if (message.method === 'host/attachments/pick') {
            void pickAttachments(parseAttachmentPickParams(message.params))
              .then((result) => {
                postToWebView({
                  id: message.id,
                  result,
                  type: 'remux/response',
                }, { epoch: requestEpoch });
              })
              .catch((requestError) => {
                postToWebView({
                  error: {
                    code: -32000,
                    message: errorMessage(requestError),
                  },
                  id: message.id,
                  type: 'remux/error',
                }, { epoch: requestEpoch });
              });
            break;
          }

          if (message.method === 'host/tab/update') {
            onTabUpdate?.(parseTabUpdateParams(message.params));
            postToWebView({
              id: message.id,
              result: { ok: true },
              type: 'remux/response',
            }, { epoch: requestEpoch });
            break;
          }

          if (message.method === 'host/overview/open') {
            void Promise.resolve(onOpenOverview?.(parseOverviewOpenParams(message.params).section))
              .then(() => {
                postToWebView({
                  id: message.id,
                  result: { ok: true },
                  type: 'remux/response',
                }, { epoch: requestEpoch });
              })
              .catch((requestError) => {
                postToWebView({
                  error: {
                    code: -32000,
                    message: errorMessage(requestError),
                  },
                  id: message.id,
                  type: 'remux/error',
                }, { epoch: requestEpoch });
              });
            break;
          }

          if (message.method === 'host/file/open') {
            const params = parseFileOpenParams(message.params);
            if (!params) {
              postToWebView({
                error: {
                  code: -32602,
                  message: 'Invalid file open params',
                },
                id: message.id,
                type: 'remux/error',
              }, { epoch: requestEpoch });
              break;
            }

            void Promise.resolve(onOpenFile?.(params) ?? { ok: false, reason: 'unavailable' })
              .then((result) => {
                postToWebView({
                  id: message.id,
                  result,
                  type: 'remux/response',
                }, { epoch: requestEpoch });
              })
              .catch((requestError) => {
                postToWebView({
                  error: {
                    code: -32000,
                    message: errorMessage(requestError),
                  },
                  id: message.id,
                  type: 'remux/error',
                }, { epoch: requestEpoch });
              });
            break;
          }

          void remux
            .request(message.method, message.params, message.timeoutMs, remuxRequestContext)
            .then((result) => {
              postToWebView({
                id: message.id,
                result,
                type: 'remux/response',
              }, { epoch: requestEpoch });
            })
            .catch((requestError) => {
              postToWebView({
                error: {
                  code: -32000,
                  message: errorMessage(requestError),
                },
                id: message.id,
                type: 'remux/error',
              }, { epoch: requestEpoch });
            });
          break;
        }
        default:
          break;
      }
    },
    [
      clearReadyTimeout,
      dismissKeyboard,
      hostViewportMetrics,
      onOpenFile,
      onOpenOverview,
      onTabUpdate,
      pickAttachments,
      active,
      postActive,
      postConnection,
      postStatus,
      postTheme,
      postToWebView,
      reloadWebView,
      remux,
      remuxRequestContext,
      theme.name,
    ],
  );

  useEffect(() => remux.subscribe((message) => {
    if (!activeRef.current) {
      return;
    }

    postToWebView(
      {
        message,
        type: 'remux/event',
      },
    );
  }), [postToWebView, remux]);

  useEffect(() => {
    const wasActive = activeRef.current;
    activeRef.current = active;
    postActive(active);
    if (active && !wasActive) {
      postConnection();
    }
  }, [active, postActive, postConnection]);

  useEffect(() => {
    postStatus();
    postConnection();
    postTheme();
  }, [postConnection, postStatus, postTheme]);

  useEffect(() => {
    postPendingNavigation();
  }, [pageState.type, postPendingNavigation]);

  useEffect(() => {
    webViewRef.current?.injectJavaScript(createWebViewThemeUpdateScript(theme.name));
    postTheme();
  }, [postTheme, theme.name]);

  useEffect(() => {
    if (remux.status.type === 'connected') {
      checkWebViewHealth('connection-connected');
    }
  }, [checkWebViewHealth, remux.status.type]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') {
        return;
      }

      if (pageStateRef.current.type === 'loading' && !readyRef.current) {
        logRemuxDebug('webview:active-while-loading', {
          instanceId: instanceIdRef.current,
        });
        if (readyTimeoutRef.current === null) {
          autoReloadWebView('active-after-deferred-ready-timeout', `${title} loaded, but did not signal readiness.`);
        }
        return;
      }
      checkWebViewHealth('app-active');
    });

    return () => {
      subscription.remove();
    };
  }, [autoReloadWebView, checkWebViewHealth, title]);

  useEffect(() => {
    const descriptor = descriptorRef.current;
    logRemuxDebug('webview:mount', descriptor);

    return () => {
      logRemuxDebug('webview:unmount', descriptor);
    };
  }, []);

  const handleLoadStart = useCallback((event: WebViewNavigationEvent) => {
    logRemuxDebug('webview:load:start', {
      instanceId: instanceIdRef.current,
      navigationType: event.nativeEvent.navigationType,
      sourceUrl: webViewSourceUrl,
      url: event.nativeEvent.url,
    });
    resetWebViewReadiness('load-start');
    setPageState({ type: 'loading' });

    readyTimeoutRef.current = setTimeout(() => {
      readyTimeoutRef.current = null;
      if (!readyRef.current) {
        const message = `${title} loaded, but did not signal readiness.`;
        if (AppState.currentState !== 'active') {
          logRemuxDebug('webview:ready-timeout:deferred', {
            instanceId: instanceIdRef.current,
            message,
            state: AppState.currentState,
          });
          return;
        }

        autoReloadWebView('ready-timeout', message);
      }
    }, webViewReadyTimeoutMs);
  }, [autoReloadWebView, resetWebViewReadiness, title, webViewSourceUrl]);

  const handleLoadEnd = useCallback((event: WebViewNavigationEvent | WebViewErrorEvent) => {
    const nativeEvent = event.nativeEvent as { url?: string };
    logRemuxDebug('webview:load:end', {
      instanceId: instanceIdRef.current,
      sourceUrl: webViewSourceUrl,
      url: nativeEvent.url ?? null,
    });
  }, [webViewSourceUrl]);

  const handleLoadError = useCallback((event: WebViewErrorEvent) => {
    logRemuxDebug('webview:load:error', {
      instanceId: instanceIdRef.current,
      nativeEvent: event.nativeEvent,
    });
    autoReloadWebView('load-error', event.nativeEvent.description || `${title} could not be loaded.`);
  }, [autoReloadWebView, title]);

  const handleHttpError = useCallback((event: WebViewHttpErrorEvent) => {
    logRemuxDebug('webview:http:error', {
      instanceId: instanceIdRef.current,
      nativeEvent: event.nativeEvent,
    });
    autoReloadWebView('http-error', `HTTP ${event.nativeEvent.statusCode}`);
  }, [autoReloadWebView]);

  const handleContentProcessTerminated = useCallback((event: WebViewTerminatedEvent) => {
    logRemuxDebug('webview:process:terminated', {
      instanceId: instanceIdRef.current,
      nativeEvent: event.nativeEvent,
    });
    autoReloadWebView('process-terminated', `${title} stopped responding.`);
  }, [autoReloadWebView, title]);

  const handleRenderProcessGone = useCallback((event: WebViewRenderProcessGoneEvent) => {
    logRemuxDebug('webview:render-process:gone', {
      instanceId: instanceIdRef.current,
      nativeEvent: event.nativeEvent,
    });
    autoReloadWebView('render-process-gone', `${title} stopped responding.`);
  }, [autoReloadWebView, title]);

  const handleShouldStartLoadWithRequest = useCallback((request: ShouldStartLoadRequest) => {
    const shouldAllow = shouldAllowWebViewNavigation({
      requestUrl: request.url,
      sourceUrl: webViewSourceUrl,
    });

    if (!shouldAllow) {
      logRemuxDebug('webview:navigation-blocked', request.url);
    }

    return shouldAllow;
  }, [webViewSourceUrl]);

  useEffect(() => () => {
    clearReadyTimeout();
    resolveHealthPingWaiters(false, 'unmount');
  }, [clearReadyTimeout, resolveHealthPingWaiters]);

  useEffect(() => {
    const updateKeyboardFrame = (event: KeyboardEvent) => {
      const webView = webViewFrameRef.current;
      const keyboardBottom = webView.y + webView.height;
      const visible = event.endCoordinates.height > 0 && event.endCoordinates.screenY < keyboardBottom;

      keyboardFrameRef.current = {
        height: event.endCoordinates.height,
        screenY: event.endCoordinates.screenY,
        visible,
      };
      captureWebViewFrame();
      requestAnimationFrame(postViewportMetrics);
    };

    const clearKeyboardFrame = () => {
      keyboardFrameRef.current = { height: 0, screenY: 0, visible: false };
      captureWebViewFrame();
      requestAnimationFrame(postViewportMetrics);
    };

    const subscriptions = [
      Keyboard.addListener('keyboardWillChangeFrame', updateKeyboardFrame),
      Keyboard.addListener('keyboardDidShow', updateKeyboardFrame),
      Keyboard.addListener('keyboardWillHide', clearKeyboardFrame),
      Keyboard.addListener('keyboardDidHide', clearKeyboardFrame),
    ];

    return () => {
      subscriptions.forEach((subscription) => subscription.remove());
    };
  }, [captureWebViewFrame, postViewportMetrics]);

  return (
    <View onLayout={captureWebViewFrame} ref={containerRef} style={styles.container}>
      <WebView
        allowsBackForwardNavigationGestures={false}
        allowsInlineMediaPlayback
        applicationNameForUserAgent="RemuxMobile"
        bounces={false}
        domStorageEnabled
        hideKeyboardAccessoryView
        javaScriptEnabled
        keyboardDisplayRequiresUserAction={false}
        injectedJavaScriptBeforeContentLoaded={injectedBeforeContentLoaded}
        onContentProcessDidTerminate={handleContentProcessTerminated}
        onError={handleLoadError}
        onHttpError={handleHttpError}
        onLoadEnd={handleLoadEnd}
        onLoadStart={handleLoadStart}
        onMessage={handleMessage}
        onShouldStartLoadWithRequest={handleShouldStartLoadWithRequest}
        onRenderProcessGone={handleRenderProcessGone}
        originWhitelist={['*']}
        overScrollMode="never"
        ref={webViewRef}
        setSupportMultipleWindows={false}
        key={`${activeSourceUrl}:${reloadNonce}`}
        source={{ uri: webViewSourceUrl }}
        style={styles.webView}
      />
      {pageState.type === 'loading' ? (
        <View style={styles.loadingOverlay}>
          <ActivityIndicator color={theme.textMuted} />
          <Text style={styles.loadingTitle}>Loading {title}</Text>
          <Text style={styles.loadingMessage}>{webViewSourceUrl}</Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              void onOpenOverview?.('tabs');
            }}
            style={[styles.overlayButton, styles.overlaySecondaryButton]}
          >
            <Text style={styles.overlayButtonText}>Exit to Tabs</Text>
          </Pressable>
        </View>
      ) : null}
      {pageState.type === 'failed' ? (
        <View style={styles.failureOverlay}>
          <Text style={styles.failureTitle}>{title} unavailable</Text>
          <Text style={styles.failureMessage}>{pageState.message}</Text>
          <View style={styles.overlayButtonRow}>
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                reloadWebView({ reason: 'manual' });
              }}
              style={styles.overlayButton}
            >
              <Text style={styles.overlayButtonText}>Retry</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                void onOpenOverview?.('tabs');
              }}
              style={styles.overlayButton}
            >
              <Text style={styles.overlayButtonText}>Exit</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
    </View>
  );
});

function parseWebViewMessage(data: string): WebViewToNativeMessage | InvalidWebViewRequest | null {
  try {
    const parsed: unknown = JSON.parse(data);
    if (!isRecord(parsed)) {
      return null;
    }

    if (parsed.type === 'remux/ready') {
      return { type: 'remux/ready' };
    }

    if (parsed.type === 'remux/health/pong' && typeof parsed.id === 'string') {
      return {
        id: parsed.id,
        type: 'remux/health/pong',
      };
    }

    if (
      parsed.type === 'remux/webview-log' &&
      typeof parsed.message === 'string' &&
      isWebViewLogLevel(parsed.level)
    ) {
      return {
        level: parsed.level,
        message: parsed.message,
        type: 'remux/webview-log',
      };
    }

    if (parsed.type === 'remux/notify') {
      if (typeof parsed.method !== 'string') {
        return null;
      }

      return {
        method: parsed.method,
        params: parsed.params,
        type: 'remux/notify',
      };
    }

    if (parsed.type !== 'remux/request') {
      return null;
    }

    const id = parsed.id;
    if (!isJsonRpcId(id)) {
      return {
        message: 'Invalid Remux request id',
        type: 'remux/invalid-request',
      };
    }

    if (typeof parsed.method !== 'string') {
      return {
        id,
        message: 'Invalid Remux request method',
        type: 'remux/invalid-request',
      };
    }

    if (parsed.timeoutMs !== undefined && typeof parsed.timeoutMs !== 'number') {
      return {
        id,
        message: 'Invalid Remux request timeout',
        type: 'remux/invalid-request',
      };
    }

    return {
      id,
      method: parsed.method,
      params: parsed.params,
      timeoutMs: parsed.timeoutMs,
      type: 'remux/request',
    };
  } catch {
    return null;
  }
}

function mapConnectionStatus(
  status: RemuxConnectionStatus,
  error: string | null,
): RemuxViewHostStatus {
  switch (status.type) {
    case 'connected':
      return { cwd: status.cwd, type: 'connected' };
    case 'reconnecting':
      return { attempt: status.attempt, type: 'reconnecting' };
    case 'disconnected':
      return { reason: error ?? undefined, type: 'closed' };
    case 'connecting':
    default:
      return { type: 'connecting' };
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function sourceUrlWithReloadNonce(sourceUrl: string, reloadNonce: number) {
  if (reloadNonce === 0) {
    return sourceUrl;
  }

  try {
    const url = new URL(sourceUrl);
    url.searchParams.set('remuxReload', String(reloadNonce));
    return url.toString();
  } catch {
    const separator = sourceUrl.includes('?') ? '&' : '?';
    return `${sourceUrl}${separator}remuxReload=${reloadNonce}`;
  }
}

function parseAttachmentPickParams(params: unknown): HostAttachmentPickParams | undefined {
  if (!isRecord(params)) {
    return undefined;
  }

  return {
    multiple: typeof params.multiple === 'boolean' ? params.multiple : undefined,
    picker: params.picker === 'files' || params.picker === 'photo-library' ? params.picker : undefined,
    type: params.type === 'any' || params.type === 'image' ? params.type : undefined,
  };
}

function parseTabUpdateParams(params: unknown): ExtensionTabUpdate {
  if (!isRecord(params)) {
    return {};
  }

  return {
    handlerId: parseOptionalStringOrNull(params.handlerId),
    launch: parseOptionalStringOrNull(params.launch),
    resourceId: parseOptionalStringOrNull(params.resourceId),
    resourceKind: parseOptionalStringOrNull(params.resourceKind),
    status: parseOptionalStringOrNull(params.status),
    title: parseOptionalStringOrNull(params.title),
  };
}

function parseOverviewOpenParams(params: unknown): HostOverviewOpenParams {
  if (!isRecord(params)) {
    return {};
  }

  return {
    section: params.section === 'files' || params.section === 'tabs' ? params.section : undefined,
  };
}

function parseFileOpenParams(params: unknown): HostFileOpenParams | null {
  if (
    !isRecord(params)
    || typeof params.path !== 'string'
    || params.path.trim().length === 0
    || !isHostFilePath(params.path)
  ) {
    return null;
  }

  return {
    line: typeof params.line === 'number' && Number.isFinite(params.line)
      ? Math.max(1, Math.floor(params.line))
      : null,
    path: params.path,
  };
}

function isHostFilePath(filePath: string) {
  return /^[a-z]:[\\/]/iu.test(filePath)
    || (!/^(?:[a-z][a-z\d+.-]*:)?\/\//iu.test(filePath)
    && !/^(?:mailto:|tel:)/iu.test(filePath)
    && !/^[a-z][a-z\d+.-]*:/iu.test(filePath));
}

function parseOptionalStringOrNull(value: unknown) {
  if (value === null) {
    return null;
  }

  return typeof value === 'string' ? value : undefined;
}

function waitForAnimationFrames(count: number) {
  return new Promise<void>((resolve) => {
    const wait = (remaining: number) => {
      if (remaining <= 0) {
        resolve();
        return;
      }

      requestAnimationFrame(() => wait(remaining - 1));
    };

    wait(count);
  });
}

function waitForKeyboardToHide(timeoutMs: number) {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    let subscription: { remove: () => void };
    const finish = (hidden: boolean) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      subscription.remove();
      resolve(hidden);
    };
    timer = setTimeout(() => finish(false), timeoutMs);
    subscription = Keyboard.addListener('keyboardDidHide', () => finish(true));
  });
}

function shouldAllowWebViewNavigation({
  requestUrl,
  sourceUrl,
}: {
  requestUrl: string;
  sourceUrl: string;
}) {
  if (!requestUrl || requestUrl === 'about:blank') {
    return true;
  }

  let request;
  let source;
  try {
    request = new URL(requestUrl);
    source = new URL(sourceUrl);
  } catch {
    return false;
  }

  if (request.protocol !== source.protocol || request.host !== source.host) {
    return false;
  }

  const sourcePath = source.pathname.endsWith('/')
    ? source.pathname
    : source.pathname.slice(0, source.pathname.lastIndexOf('/') + 1);
  return request.pathname.startsWith(sourcePath);
}

async function imagePickerAssetToHostAttachment(
  asset: ImagePicker.ImagePickerAsset,
): Promise<HostAttachmentPickResult['assets'][number]> {
  const mimeType = asset.mimeType || mimeTypeFromFileName(asset.fileName ?? '') || 'image/jpeg';
  const base64 = asset.base64 ?? await new File(asset.uri).base64();

  return {
    dataUrl: `data:${mimeType};base64,${base64}`,
    mimeType,
    name: asset.fileName || fileNameFromUri(asset.uri) || 'Photo',
    sizeBytes: asset.fileSize ?? 0,
  };
}

function fileNameFromUri(uri: string) {
  const path = uri.split('?')[0] ?? uri;
  const name = path.split('/').filter(Boolean).at(-1);
  return name ? decodeURIComponent(name) : null;
}

function mimeTypeFromFileName(fileName: string) {
  const extension = fileName.split('.').pop()?.trim().toLowerCase();

  switch (extension) {
    case 'gif':
      return 'image/gif';
    case 'heic':
      return 'image/heic';
    case 'heif':
      return 'image/heif';
    case 'jpeg':
    case 'jpg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'webp':
      return 'image/webp';
    default:
      return null;
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return typeof value === 'number' || typeof value === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isWebViewLogLevel(value: unknown): value is Extract<WebViewToNativeMessage, { type: 'remux/webview-log' }>['level'] {
  return value === 'debug' || value === 'error' || value === 'info' || value === 'log' || value === 'warn';
}

const webViewDiagnosticsVerboseConsole = false;

function createWebViewBeforeContentLoadedScript(theme: RemuxThemeName) {
  return `${createWebViewThemeScript(theme, false)}\n${webViewDiagnosticsScript}`;
}

function createWebViewThemeUpdateScript(theme: RemuxThemeName) {
  return createWebViewThemeScript(theme, true);
}

function createWebViewThemeScript(theme: RemuxThemeName, dispatch: boolean) {
  const serializedTheme = JSON.stringify(theme);
  return `
  (function () {
    var theme = ${serializedTheme};
    var root = document.documentElement;
    root.setAttribute('data-remux-theme', theme);
    root.style.colorScheme = theme;
    window.__remuxHostTheme = theme;
    ${dispatch ? "window.dispatchEvent(new CustomEvent('remux:theme', { detail: { theme: theme } }));" : ''}
    return true;
  })();
  true;
`;
}

const webViewDiagnosticsScript = `
  (function () {
    if (window.__remuxDiagnosticsInstalled) {
      return true;
    }
    window.__remuxDiagnosticsInstalled = true;
    var verboseConsole = ${webViewDiagnosticsVerboseConsole ? 'true' : 'false'};

    function post(level, value) {
      try {
        var text = typeof value === 'string' ? value : JSON.stringify(value);
        window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'remux/webview-log',
          level: level,
          message: text
        }));
      } catch (error) {
      }
    }

    function postLifecycle(eventName, extra) {
      post('debug', {
        event: eventName,
        extra: extra || null,
        hidden: document.hidden,
        href: window.location.href,
        kind: 'page-lifecycle',
        visibilityState: document.visibilityState
      });
    }

    function postRaw(message) {
      try {
        window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify(message));
      } catch (error) {
      }
    }

    if (verboseConsole) {
      ['debug', 'error', 'info', 'log', 'warn'].forEach(function (level) {
        var original = console[level];
        console[level] = function () {
          post(level, Array.prototype.slice.call(arguments).join(' '));
          return original && original.apply(console, arguments);
        };
      });
    }

    window.addEventListener('error', function (event) {
      post('error', event.message || 'Unhandled WebView error');
    });

    window.addEventListener('unhandledrejection', function (event) {
      post('error', event.reason && event.reason.message ? event.reason.message : String(event.reason));
    });

    document.addEventListener('visibilitychange', function () {
      postLifecycle('visibilitychange');
    });

    window.addEventListener('pagehide', function (event) {
      postLifecycle('pagehide', { persisted: Boolean(event.persisted) });
    });

    window.addEventListener('pageshow', function (event) {
      postLifecycle('pageshow', { persisted: Boolean(event.persisted) });
    });

    window.addEventListener('beforeunload', function () {
      postLifecycle('beforeunload');
    });

    function handleNativeMessage(event) {
      try {
        var message = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
        if (message && message.type === 'remux/health/ping' && typeof message.id === 'string') {
          postRaw({
            id: message.id,
            type: 'remux/health/pong'
          });
        }
      } catch (error) {
      }
    }

    window.addEventListener('message', handleNativeMessage);
    document.addEventListener('message', handleNativeMessage);

    window.addEventListener('online', function () {
      postLifecycle('online');
    });

    window.addEventListener('offline', function () {
      postLifecycle('offline');
    });

    [
      'vite:beforeFullReload',
      'vite:beforeUpdate',
      'vite:error',
      'vite:invalidate',
      'vite:ws:connect',
      'vite:ws:disconnect'
    ].forEach(function (eventName) {
      window.addEventListener(eventName, function () {
        postLifecycle(eventName);
      });
    });

    return true;
  })();
`;

function createStyles(theme: RemuxTheme) {
  return StyleSheet.create({
  container: {
    backgroundColor: theme.surface,
    flex: 1,
  },
  failureMessage: {
    color: theme.textMuted,
    fontSize: 15,
    lineHeight: 21,
    marginTop: 8,
    maxWidth: 320,
    textAlign: 'center',
  },
  failureOverlay: {
    alignItems: 'center',
    backgroundColor: theme.surface,
    bottom: 0,
    justifyContent: 'center',
    left: 0,
    padding: 24,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  failureTitle: {
    color: theme.text,
    fontSize: 20,
    fontWeight: '700',
    lineHeight: 26,
    textAlign: 'center',
  },
  loadingMessage: {
    color: theme.textMuted,
    fontSize: 12,
    lineHeight: 17,
    marginTop: 6,
    maxWidth: 320,
    textAlign: 'center',
  },
  loadingOverlay: {
    alignItems: 'center',
    backgroundColor: theme.surface,
    bottom: 0,
    justifyContent: 'center',
    left: 0,
    padding: 24,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  loadingTitle: {
    color: theme.text,
    fontSize: 17,
    fontWeight: '700',
    lineHeight: 23,
    marginTop: 14,
    textAlign: 'center',
  },
  overlayButton: {
    backgroundColor: theme.surfaceHover,
    borderColor: theme.border,
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 18,
    paddingVertical: 10,
  },
  overlayButtonRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 20,
  },
  overlayButtonText: {
    color: theme.text,
    fontSize: 15,
    fontWeight: '600',
    lineHeight: 20,
  },
  overlaySecondaryButton: {
    marginTop: 20,
  },
  webView: {
    backgroundColor: theme.surface,
    flex: 1,
  },
  });
}
