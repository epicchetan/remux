import type { Terminal } from '@xterm/xterm';

const momentumDecay = 0.994;
const momentumStopVelocity = 100;
const momentumStartVelocity = 50;
const tapMaxDurationMs = 300;
const tapMaxDistancePx = 10;
const velocitySampleCount = 5;

type TouchSample = {
  time: number;
  y: number;
};

const textEncoder = new TextEncoder();

export function setupTouchScroll(
  container: HTMLElement,
  term: Terminal,
  sendInput: (data: Uint8Array) => void,
  options: { disabled?: () => boolean; onTap?: () => void } = {},
) {
  let cellHeight = container.clientHeight / Math.max(term.rows, 1);
  let scrollAccum = 0;
  let altBufferAccum = 0;
  let momentumId: number | null = null;
  let velocity = 0;

  let lastTouchY = 0;
  let touchStartY = 0;
  let touchStartTime = 0;
  const recentMoves: TouchSample[] = [];

  const resizeDisposable = term.onResize(() => {
    cellHeight = container.clientHeight / Math.max(term.rows, 1);
  });

  function cancelMomentum() {
    if (momentumId !== null) {
      window.cancelAnimationFrame(momentumId);
      momentumId = null;
    }
  }

  function doScroll(deltaPixels: number) {
    if (options.disabled?.()) {
      return;
    }

    if (!cellHeight || cellHeight <= 0) {
      return;
    }

    const lines = -deltaPixels / cellHeight;

    if (term.buffer.active.type === 'alternate') {
      altBufferAccum += lines;
      const wholeLines = Math.trunc(altBufferAccum);
      if (wholeLines !== 0) {
        altBufferAccum -= wholeLines;
        const key = wholeLines < 0 ? '\x1b[A' : '\x1b[B';
        for (let index = 0; index < Math.abs(wholeLines); index += 1) {
          sendInput(textEncoder.encode(key));
        }
      }
      return;
    }

    scrollAccum += lines;
    const wholeLines = Math.trunc(scrollAccum);
    if (wholeLines !== 0) {
      scrollAccum -= wholeLines;
      term.scrollLines(wholeLines);
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

      doScroll(velocity * (elapsed / 1000));
      momentumId = window.requestAnimationFrame(frame);
    }

    momentumId = window.requestAnimationFrame(frame);
  }

  function onTouchStart(event: TouchEvent) {
    if (options.disabled?.()) {
      return;
    }

    const touch = event.touches[0];
    if (!touch) {
      return;
    }

    cancelMomentum();
    scrollAccum = 0;
    altBufferAccum = 0;
    lastTouchY = touch.clientY;
    touchStartY = touch.clientY;
    touchStartTime = Date.now();
    recentMoves.length = 0;
    event.preventDefault();
  }

  function onTouchMove(event: TouchEvent) {
    if (options.disabled?.()) {
      return;
    }

    const touch = event.touches[0];
    if (!touch) {
      return;
    }

    const y = touch.clientY;
    const deltaY = y - lastTouchY;
    lastTouchY = y;

    recentMoves.push({ time: Date.now(), y });
    if (recentMoves.length > velocitySampleCount) {
      recentMoves.shift();
    }

    doScroll(deltaY);
    event.preventDefault();
  }

  function onTouchEnd(event: TouchEvent) {
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
      options.onTap?.();
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
    cancelMomentum();
    resizeDisposable.dispose();
  };
}
