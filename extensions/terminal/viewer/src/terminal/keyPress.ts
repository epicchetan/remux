import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';

const keyPressSlopPx = 10;
const keyRowScrollSuppressMs = 150;
const syntheticClickWindowMs = 500;

let lastKeyRowScrollMs = Number.NEGATIVE_INFINITY;

// Wire this to onScroll of the scrollable key rows. A touch that lands while
// the row is still moving is a fling-stop, not a key press, so gestures that
// start within the suppress window are swallowed.
export function markTerminalKeyRowScroll() {
  lastKeyRowScrollMs = performance.now();
}

export type TerminalKeyRepeatConfig = {
  holdDelayMs: number;
  intervalMs: number;
};

type TerminalKeyGesture = {
  pointerId: number;
  repeating: boolean;
  startX: number;
  startY: number;
};

// Keyboard-key press handling: fires exactly once per tap on pointerup with no
// time-based debounce (so rapid taps all land), cancels when the pointer moves
// past the slop radius or the browser claims the gesture for scrolling, and
// optionally auto-repeats while held.
export function useTerminalKeyPress(
  onPress: () => void,
  options: { repeat?: TerminalKeyRepeatConfig } = {},
) {
  const gestureRef = useRef<TerminalKeyGesture | null>(null);
  const holdTimerRef = useRef<number | null>(null);
  const intervalRef = useRef<number | null>(null);
  const lastPointerActivityMsRef = useRef(Number.NEGATIVE_INFINITY);
  const onPressRef = useRef(onPress);
  const repeatRef = useRef(options.repeat);
  const [pressed, setPressed] = useState(false);

  useEffect(() => {
    onPressRef.current = onPress;
    repeatRef.current = options.repeat;
  });

  const clearTimers = useCallback(() => {
    if (holdTimerRef.current !== null) {
      window.clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
    if (intervalRef.current !== null) {
      window.clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  const endGesture = useCallback(() => {
    gestureRef.current = null;
    clearTimers();
    setPressed(false);
  }, [clearTimers]);

  useEffect(() => clearTimers, [clearTimers]);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) {
      return;
    }

    // Canceling pointerdown keeps focus on the terminal textarea (so the soft
    // keyboard stays open) without blocking the row's native horizontal pan,
    // which is governed by touch-action.
    event.preventDefault();
    event.stopPropagation();
    lastPointerActivityMsRef.current = performance.now();
    if (performance.now() - lastKeyRowScrollMs < keyRowScrollSuppressMs) {
      return;
    }

    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture is best-effort; move/up handlers still cover normal browsers.
    }

    gestureRef.current = {
      pointerId: event.pointerId,
      repeating: false,
      startX: event.clientX,
      startY: event.clientY,
    };
    setPressed(true);

    const repeat = repeatRef.current;
    if (repeat) {
      holdTimerRef.current = window.setTimeout(() => {
        holdTimerRef.current = null;
        const gesture = gestureRef.current;
        if (!gesture) {
          return;
        }

        gesture.repeating = true;
        onPressRef.current();
        intervalRef.current = window.setInterval(() => onPressRef.current(), repeat.intervalMs);
      }, repeat.holdDelayMs);
    }
  }, []);

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId || gesture.repeating) {
      return;
    }

    const dx = event.clientX - gesture.startX;
    const dy = event.clientY - gesture.startY;
    if ((dx * dx) + (dy * dy) > keyPressSlopPx * keyPressSlopPx) {
      endGesture();
    }
  }, [endGesture]);

  const onPointerUp = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    const gesture = gestureRef.current;
    lastPointerActivityMsRef.current = performance.now();
    if (!gesture || gesture.pointerId !== event.pointerId) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    const shouldFire = !gesture.repeating;
    endGesture();
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {
      // Ignore browsers that do not expose capture state for synthetic events.
    }

    if (shouldFire) {
      onPressRef.current();
    }
  }, [endGesture]);

  const onPointerCancel = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    const gesture = gestureRef.current;
    lastPointerActivityMsRef.current = performance.now();
    if (!gesture || gesture.pointerId !== event.pointerId) {
      return;
    }

    endGesture();
  }, [endGesture]);

  const onClick = useCallback((event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    // Pointer gestures already fired on pointerup; only activate for clicks
    // with no recent pointer activity (keyboard or assistive-tech activation).
    if (performance.now() - lastPointerActivityMsRef.current > syntheticClickWindowMs) {
      onPressRef.current();
    }
  }, []);

  return {
    pressed,
    handlers: {
      onClick,
      onLostPointerCapture: endGesture,
      onMouseDown: (event: ReactMouseEvent<HTMLButtonElement>) => event.preventDefault(),
      onPointerCancel,
      onPointerDown,
      onPointerMove,
      onPointerUp,
    },
  };
}
