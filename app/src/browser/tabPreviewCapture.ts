import { AppState, type View } from 'react-native';
import { captureRef } from 'react-native-view-shot';

import { useBrowserStore } from './browserStore';

// Screenshots are capped at one per second per tab; bursts coalesce into a
// single trailing capture so the final state is never missed. Captures run
// one at a time so a theme flip across many tabs never floods a frame.
const captureMinIntervalMs = 1_000;

type TabCaptureThrottle = {
  lastRequestedAt: number;
  timer: ReturnType<typeof setTimeout> | null;
};

const captureTargets = new Map<string, View>();
const captureThrottles = new Map<string, TabCaptureThrottle>();
const dirtyTabIds = new Set<string>();
let captureQueue: Promise<void> = Promise.resolve();

export function setTabPreviewCaptureTarget(tabId: string, target: View | null) {
  if (target) {
    captureTargets.set(tabId, target);
    return;
  }

  captureTargets.delete(tabId);
  dirtyTabIds.delete(tabId);
  const throttle = captureThrottles.get(tabId);
  if (throttle?.timer) {
    clearTimeout(throttle.timer);
  }
  captureThrottles.delete(tabId);
}

export function markTabPreviewDirty(tabId: string) {
  dirtyTabIds.add(tabId);
}

export function markAllTabPreviewsDirty() {
  for (const tab of useBrowserStore.getState().tabs) {
    dirtyTabIds.add(tab.id);
  }
}

export function requestTabPreviewCapture(tabId: string) {
  const throttle = captureThrottles.get(tabId) ?? { lastRequestedAt: 0, timer: null };
  captureThrottles.set(tabId, throttle);
  if (throttle.timer) {
    return;
  }

  const wait = throttle.lastRequestedAt + captureMinIntervalMs - Date.now();
  if (wait <= 0) {
    enqueueCapture(tabId, throttle);
    return;
  }

  throttle.timer = setTimeout(() => {
    throttle.timer = null;
    enqueueCapture(tabId, throttle);
  }, wait);
}

// A viewer announced that its rendered content changed (fired after paint,
// so a capture taken now photographs the new state). Cards only matter in
// the overview; elsewhere the dirty mark defers the capture.
export function noteTabPreviewContentChanged(tabId: string) {
  markTabPreviewDirty(tabId);
  if (useBrowserStore.getState().mode === 'overview') {
    requestTabPreviewCapture(tabId);
  }
}

export function flushDirtyTabPreviews(skipTabId?: string | null) {
  for (const tabId of [...dirtyTabIds]) {
    if (tabId !== skipTabId) {
      requestTabPreviewCapture(tabId);
    }
  }
}

function enqueueCapture(tabId: string, throttle: TabCaptureThrottle) {
  throttle.lastRequestedAt = Date.now();
  captureQueue = captureQueue
    .then(() => captureTabPreview(tabId))
    .catch(() => undefined);
}

async function captureTabPreview(tabId: string) {
  if (AppState.currentState !== 'active') {
    // Leave the tab dirty; the next overview entry retries the capture.
    return;
  }

  const target = captureTargets.get(tabId);
  const browser = useBrowserStore.getState();
  if (!browser.tabs.some((tab) => tab.id === tabId)) {
    dirtyTabIds.delete(tabId);
    return;
  }
  if (!target) {
    return;
  }

  try {
    const previewUri = await captureRef(target, {
      format: 'jpg',
      handleGLSurfaceViewOnAndroid: true,
      quality: 0.72,
      result: 'tmpfile',
    });
    await browser.setTabPreview(tabId, previewUri);
    dirtyTabIds.delete(tabId);
  } catch {
    // Snapshot support can vary by native view type; the tab card keeps its
    // previous preview (or the icon fallback).
  }
}
