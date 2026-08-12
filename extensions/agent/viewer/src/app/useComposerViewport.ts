import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from 'react';

import type { RemuxHostViewportMetrics } from '../ipc/types.ts';

type ComposerViewportOptions = {
  bottomBarSlotRef: RefObject<HTMLDivElement | null>;
  composerPresentationRequestId: number;
  directoryPickerOpen: boolean;
  focusComposer: () => void;
  getHostViewportMetrics: () => Promise<RemuxHostViewportMetrics | null>;
  hostViewportMetrics: RemuxHostViewportMetrics | null;
  mainPaneRef: RefObject<HTMLElement | null>;
  mentionPickerVisible: boolean;
  presentationActive: boolean;
};

export function useComposerViewport(options: ComposerViewportOptions) {
  const {
    bottomBarSlotRef,
    composerPresentationRequestId,
    directoryPickerOpen,
    focusComposer,
    getHostViewportMetrics,
    hostViewportMetrics,
    mainPaneRef,
    mentionPickerVisible,
    presentationActive,
  } = options;
  const metricsRef = useRef<RemuxHostViewportMetrics | null>(hostViewportMetrics);
  const presentationActiveRef = useRef(false);
  const [composerDomFocused, setComposerDomFocused] = useState(false);
  const [composerLiftPx, setComposerLiftPx] = useState(0);
  const [pickerOverlayStyle, setPickerOverlayStyle] = useState<CSSProperties | null>(null);
  const pickerOverlayVisible = mentionPickerVisible || directoryPickerOpen;
  const composerShouldLift = presentationActive || directoryPickerOpen || composerDomFocused;

  const updatePickerGeometry = useCallback(() => {
    if (!pickerOverlayVisible) {
      setPickerOverlayStyle(null);
      return;
    }
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      const mainPane = mainPaneRef.current;
      const bottomBar = bottomBarSlotRef.current;
      if (!mainPane || !bottomBar) return;
      const mainRect = mainPane.getBoundingClientRect();
      const bottomBarRect = bottomBar.getBoundingClientRect();
      void getHostViewportMetrics()
        .then((metrics) => setPickerOverlayStyle(measurePickerOverlay(mainRect, bottomBarRect, metrics)))
        .catch(() => setPickerOverlayStyle(measurePickerOverlay(mainRect, bottomBarRect, null)));
    }));
  }, [bottomBarSlotRef, getHostViewportMetrics, mainPaneRef, pickerOverlayVisible]);

  const updateComposerLiftGeometry = useCallback(() => {
    window.requestAnimationFrame(() => {
      const mainPane = mainPaneRef.current;
      if (!mainPane || !presentationActiveRef.current) return;
      const mainRect = mainPane.getBoundingClientRect();
      const metrics = metricsRef.current;
      if (metrics) {
        setComposerLiftPx(measureComposerLift(mainRect, metrics));
        return;
      }
      void getHostViewportMetrics()
        .then((next) => {
          if (presentationActiveRef.current) setComposerLiftPx(measureComposerLift(mainRect, next));
        })
        .catch(() => {
          if (presentationActiveRef.current) setComposerLiftPx(measureVisualViewportComposerLift(mainRect));
        });
    });
  }, [getHostViewportMetrics, mainPaneRef]);

  useEffect(() => {
    metricsRef.current = hostViewportMetrics;
    presentationActiveRef.current = composerShouldLift;
    if (composerShouldLift) updateComposerLiftGeometry();
  }, [composerShouldLift, hostViewportMetrics, updateComposerLiftGeometry]);

  useEffect(() => {
    let frame = 0;
    const update = () => setComposerDomFocused(activeElementInComposer());
    const schedule = () => {
      if (frame) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        update();
      });
    };
    document.addEventListener('focusin', update);
    document.addEventListener('focusout', schedule);
    update();
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      document.removeEventListener('focusin', update);
      document.removeEventListener('focusout', schedule);
    };
  }, []);

  useEffect(() => {
    if (!composerShouldLift) {
      setComposerLiftPx(0);
      return;
    }
    updateComposerLiftGeometry();
    const viewport = window.visualViewport;
    const observer = new ResizeObserver(updateComposerLiftGeometry);
    if (mainPaneRef.current) observer.observe(mainPaneRef.current);
    if (bottomBarSlotRef.current) observer.observe(bottomBarSlotRef.current);
    const timers = [50, 150, 300, 500]
      .map((delay) => window.setTimeout(updateComposerLiftGeometry, delay));
    window.addEventListener('resize', updateComposerLiftGeometry);
    viewport?.addEventListener('resize', updateComposerLiftGeometry);
    viewport?.addEventListener('scroll', updateComposerLiftGeometry);
    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
      observer.disconnect();
      window.removeEventListener('resize', updateComposerLiftGeometry);
      viewport?.removeEventListener('resize', updateComposerLiftGeometry);
      viewport?.removeEventListener('scroll', updateComposerLiftGeometry);
    };
  }, [bottomBarSlotRef, composerShouldLift, mainPaneRef, updateComposerLiftGeometry]);

  useEffect(() => {
    if (composerPresentationRequestId === 0) return;
    let cancelled = false;
    const frames: number[] = [];
    const timers: number[] = [];
    const present = () => {
      if (cancelled) return;
      updateComposerLiftGeometry();
      const first = window.requestAnimationFrame(() => {
        const second = window.requestAnimationFrame(() => {
          if (!cancelled) focusComposer();
        });
        frames.push(second);
      });
      frames.push(first);
    };
    present();
    for (const delay of [50, 150, 300]) timers.push(window.setTimeout(present, delay));
    return () => {
      cancelled = true;
      frames.forEach((frame) => window.cancelAnimationFrame(frame));
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [composerPresentationRequestId, focusComposer, updateComposerLiftGeometry]);

  useEffect(() => {
    if (!pickerOverlayVisible) {
      setPickerOverlayStyle(null);
      return;
    }
    updatePickerGeometry();
    const viewport = window.visualViewport;
    const observer = new ResizeObserver(updatePickerGeometry);
    if (mainPaneRef.current) observer.observe(mainPaneRef.current);
    if (bottomBarSlotRef.current) observer.observe(bottomBarSlotRef.current);
    window.addEventListener('resize', updatePickerGeometry);
    viewport?.addEventListener('resize', updatePickerGeometry);
    viewport?.addEventListener('scroll', updatePickerGeometry);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updatePickerGeometry);
      viewport?.removeEventListener('resize', updatePickerGeometry);
      viewport?.removeEventListener('scroll', updatePickerGeometry);
    };
  }, [bottomBarSlotRef, mainPaneRef, pickerOverlayVisible, updatePickerGeometry]);

  useEffect(() => {
    if (pickerOverlayVisible) updatePickerGeometry();
  }, [composerLiftPx, hostViewportMetrics, pickerOverlayVisible, updatePickerGeometry]);

  return {
    composerLiftPx,
    mainPaneStyle: { '--remux-composer-lift': `${composerLiftPx}px` } as CSSProperties,
    pickerOverlayStyle,
    pickerOverlayVisible,
  };
}

function hostKeyboardActive(metrics: RemuxHostViewportMetrics | null) {
  return Boolean(metrics && (
    metrics.keyboardVisible || metrics.keyboardHeight > 0 ||
    metrics.visibleBottom < metrics.viewportHeight
  ));
}

function measureComposerLift(mainRect: DOMRect, metrics: RemuxHostViewportMetrics | null) {
  if (!hostKeyboardActive(metrics) || !metrics || metrics.viewportHeight <= 0) {
    return measureVisualViewportComposerLift(mainRect);
  }
  const visibleBottom = Math.max(0, Math.min(metrics.viewportHeight, metrics.visibleBottom));
  return visibleBottom > 0
    ? Math.max(0, Math.ceil(mainRect.bottom - visibleBottom))
    : measureVisualViewportComposerLift(mainRect);
}

function measureVisualViewportComposerLift(mainRect: DOMRect) {
  const viewport = window.visualViewport;
  return viewport
    ? Math.max(0, Math.ceil(mainRect.bottom - (viewport.offsetTop + viewport.height)))
    : 0;
}

function measurePickerOverlay(
  mainRect: DOMRect,
  bottomBarRect: DOMRect,
  metrics: RemuxHostViewportMetrics | null,
): CSSProperties {
  const top = Math.max(0, -mainRect.top);
  const fallbackBottom = Math.max(top, bottomBarRect.top - mainRect.top);
  const maxBottom = Math.max(top, mainRect.height - bottomBarRect.height);
  const hostBottom = metrics && metrics.viewportHeight > 0
    ? metrics.visibleBottom - bottomBarRect.height - mainRect.top
    : fallbackBottom;
  const bottom = Math.max(
    top,
    Math.min(hostKeyboardActive(metrics) ? hostBottom : fallbackBottom, maxBottom),
  );
  return { height: Math.max(0, bottom - top), top };
}

function activeElementInComposer() {
  const active = document.activeElement;
  return active instanceof Element && Boolean(active.closest('[data-remux-composer-root]'));
}
