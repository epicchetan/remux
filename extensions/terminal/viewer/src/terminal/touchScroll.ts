import type { Terminal } from '@xterm/xterm';

const momentumDecay = 0.994;
const momentumStopVelocity = 100;
const momentumStartVelocity = 50;
const tapMaxDurationMs = 300;
const tapMaxDistancePx = 10;
const tapScrollSuppressMs = 150;
// Shared with the selection drag's hold-to-select-line timer so a hold means
// the same thing whichever layer owns the gesture.
export const longPressMs = 500;
const velocitySampleCount = 5;
const maxTicksPerEmit = 8;

type TouchSample = {
  time: number;
  y: number;
};

export function setupTouchScroll(
  container: HTMLElement,
  term: Terminal,
  options: {
    disabled?: () => boolean;
    // When true, always scroll the xterm buffer directly instead of handing the
    // gesture to the app via wheel reports (used while selecting text).
    forcePlainScroll?: () => boolean;
    onLongPress?: (clientX: number, clientY: number) => void;
    onTap?: (clientX: number, clientY: number) => void;
  } = {},
) {
  let cellHeight = container.clientHeight / Math.max(term.rows, 1);
  let scrollAccum = 0;
  let wheelAccum = 0;
  let momentumId: number | null = null;
  let velocity = 0;

  let lastTouchX = 0;
  let lastTouchY = 0;
  let touchStartX = 0;
  let touchStartY = 0;
  let touchStartTime = 0;
  let longPressTimer: number | null = null;
  let longPressFired = false;
  let lastScrollMs = Number.NEGATIVE_INFINITY;
  let flingStopTouch = false;
  const recentMoves: TouchSample[] = [];

  function clearLongPressTimer() {
    if (longPressTimer !== null) {
      window.clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  }

  const resizeDisposable = term.onResize(() => {
    cellHeight = container.clientHeight / Math.max(term.rows, 1);
  });

  function screenElement() {
    return container.querySelector('.xterm-screen') as HTMLElement | null;
  }

  // Hand the gesture to xterm as a real wheel event so it picks the wire format:
  // a mouse report in the app's negotiated protocol (SGR/X10/urxvt) when mouse
  // tracking is on, or DECCKM-correct arrow keys on the alternate buffer.
  function dispatchWheelTick(up: boolean, clientX: number, clientY: number) {
    const element = screenElement();
    if (!element) {
      return;
    }

    element.dispatchEvent(new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      clientX,
      clientY,
      deltaMode: WheelEvent.DOM_DELTA_LINE,
      deltaY: up ? -1 : 1,
    }));
  }

  function clampToScreen(clientX: number, clientY: number) {
    const rect = screenElement()?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) {
      return { x: clientX, y: clientY };
    }

    return {
      x: Math.min(Math.max(clientX, rect.left + 1), rect.right - 1),
      y: Math.min(Math.max(clientY, rect.top + 1), rect.bottom - 1),
    };
  }

  function cancelMomentum() {
    if (momentumId !== null) {
      window.cancelAnimationFrame(momentumId);
      momentumId = null;
    }
  }

  function doScroll(deltaPixels: number, clientX: number, clientY: number) {
    if (options.disabled?.()) {
      return;
    }

    if (!cellHeight || cellHeight <= 0) {
      return;
    }

    const lines = -deltaPixels / cellHeight;
    const plain = options.forcePlainScroll?.() ?? false;
    const mouseMode = !plain && term.modes.mouseTrackingMode !== 'none';
    const alternate = !plain && term.buffer.active.type === 'alternate';

    if (!mouseMode && !alternate) {
      scrollAccum += lines;
      const wholeLines = Math.trunc(scrollAccum);
      if (wholeLines !== 0) {
        scrollAccum -= wholeLines;
        lastScrollMs = performance.now();
        term.scrollLines(wholeLines);
      }
      return;
    }

    wheelAccum += lines;
    const wholeLines = Math.trunc(wheelAccum);
    if (wholeLines === 0) {
      return;
    }

    wheelAccum -= wholeLines;
    lastScrollMs = performance.now();
    const point = clampToScreen(clientX, clientY);
    const ticks = Math.min(Math.abs(wholeLines), maxTicksPerEmit);
    for (let index = 0; index < ticks; index += 1) {
      dispatchWheelTick(wholeLines < 0, point.x, point.y);
    }
  }

  function startMomentum(nextVelocity: number) {
    velocity = nextVelocity;
    let lastFrameTime = performance.now();

    function frame() {
      const now = performance.now();
      const elapsed = now - lastFrameTime;
      lastFrameTime = now;
      velocity *= Math.pow(momentumDecay, elapsed);

      if (Math.abs(velocity) < momentumStopVelocity) {
        momentumId = null;
        return;
      }

      doScroll(velocity * (elapsed / 1000), lastTouchX, lastTouchY);
      momentumId = window.requestAnimationFrame(frame);
    }

    momentumId = window.requestAnimationFrame(frame);
  }

  function onTouchStart(event: TouchEvent) {
    clearLongPressTimer();
    longPressFired = false;
    // Stop any fling and drop stale velocity samples even when another layer
    // (a selection drag) claims the gesture — otherwise momentum keeps
    // scrolling the buffer underneath it.
    flingStopTouch = momentumId !== null;
    cancelMomentum();
    recentMoves.length = 0;
    if (options.disabled?.()) {
      return;
    }

    const touch = event.touches[0];
    if (!touch) {
      return;
    }

    scrollAccum = 0;
    wheelAccum = 0;
    lastTouchX = touch.clientX;
    lastTouchY = touch.clientY;
    touchStartX = touch.clientX;
    touchStartY = touch.clientY;
    touchStartTime = Date.now();
    if (options.onLongPress && event.touches.length === 1) {
      const { clientX, clientY } = touch;
      longPressTimer = window.setTimeout(() => {
        longPressTimer = null;
        longPressFired = true;
        options.onLongPress?.(clientX, clientY);
      }, longPressMs);
    }
    event.preventDefault();
  }

  function onTouchMove(event: TouchEvent) {
    // A fired long-press owns the rest of the gesture; don't also scroll.
    if (longPressFired) {
      event.preventDefault();
      return;
    }

    if (options.disabled?.()) {
      return;
    }

    const touch = event.touches[0];
    if (!touch) {
      return;
    }

    const y = touch.clientY;
    const deltaY = y - lastTouchY;
    lastTouchX = touch.clientX;
    lastTouchY = y;

    if (
      longPressTimer !== null
      && Math.hypot(touch.clientX - touchStartX, y - touchStartY) > tapMaxDistancePx
    ) {
      clearLongPressTimer();
    }

    recentMoves.push({ time: Date.now(), y });
    if (recentMoves.length > velocitySampleCount) {
      recentMoves.shift();
    }

    doScroll(deltaY, touch.clientX, touch.clientY);
    event.preventDefault();
  }

  function onTouchEnd(event: TouchEvent) {
    clearLongPressTimer();
    if (longPressFired) {
      longPressFired = false;
      event.preventDefault();
      return;
    }

    if (options.disabled?.()) {
      return;
    }

    const touch = event.changedTouches[0];
    if (!touch) {
      return;
    }

    const elapsed = Date.now() - touchStartTime;
    const distance = Math.abs(touch.clientY - touchStartY);
    if (elapsed < tapMaxDurationMs && distance < tapMaxDistancePx) {
      // A touch landing while the buffer is (or was just) scrolling is a
      // fling-stop, not a tap — mirror the key rows' scroll suppression.
      if (!flingStopTouch && performance.now() - lastScrollMs > tapScrollSuppressMs) {
        options.onTap?.(touch.clientX, touch.clientY);
      }
      event.preventDefault();
      return;
    }

    if (recentMoves.length >= 2) {
      const first = recentMoves[0]!;
      const last = recentMoves[recentMoves.length - 1]!;
      const dt = last.time - first.time;
      if (dt > 0) {
        const nextVelocity = ((last.y - first.y) / dt) * 1000;
        if (Math.abs(nextVelocity) > momentumStartVelocity) {
          startMomentum(nextVelocity);
        }
      }
    }
  }

  container.addEventListener('touchstart', onTouchStart, { passive: false });
  container.addEventListener('touchmove', onTouchMove, { passive: false });
  container.addEventListener('touchend', onTouchEnd);

  return () => {
    container.removeEventListener('touchstart', onTouchStart);
    container.removeEventListener('touchmove', onTouchMove);
    container.removeEventListener('touchend', onTouchEnd);
    clearLongPressTimer();
    cancelMomentum();
    resizeDisposable.dispose();
  };
}
