import type { NarrationFocusIntent } from '@remux/narration-client';

import { useNarrationStore } from './client';

type NarrationFocusRequest = {
  block: HTMLElement;
  bounds: { bottom: number; top: number };
  followEnabled: boolean;
  intent: NarrationFocusIntent | null;
};

let focusedIntentId = 0;

export function focusNarration(request: NarrationFocusRequest) {
  const { block, bounds, followEnabled, intent } = request;
  if (!intent || intent.id === focusedIntentId) {
    return;
  }
  focusedIntentId = intent.id;
  if (intent.reason === 'follow' && !followEnabled) {
    return;
  }

  const shell = block.closest<HTMLElement>('.remux-markdown-content-shell');
  if (!shell) {
    return;
  }
  const viewport = shell.getBoundingClientRect();
  const usableHeight = Math.max(1, viewport.height);
  const bandTop = viewport.top + usableHeight * 0.22;
  const bandBottom = viewport.top + usableHeight * 0.65;
  if (intent.reason === 'follow' && bounds.top >= bandTop && bounds.bottom <= bandBottom) {
    return;
  }
  if (
    intent.reason === 'explicitSeekInPlace'
    && bounds.top >= viewport.top
    && bounds.bottom <= viewport.bottom
  ) {
    return;
  }

  const desiredTop = shell.scrollTop
    + bounds.top
    - viewport.top
    - usableHeight * 0.30;
  shell.scrollTo({
    behavior: intent.reason === 'follow' ? 'auto' : 'smooth',
    top: Math.max(0, desiredTop),
  });
}

export function installNarrationFollowController() {
  let pointer: { id: number; x: number; y: number } | null = null;
  const suspend = () => {
    const state = useNarrationStore.getState();
    if (
      state.followEnabled
      && ['buffering', 'paused', 'playing', 'ready'].includes(state.phase)
    ) {
      state.suspendFollowByUser();
    }
  };
  const withinContent = (target: EventTarget | null) => (
    target instanceof Element && Boolean(target.closest('.remux-markdown-content-shell'))
  );
  const onWheel = (event: WheelEvent) => {
    if (withinContent(event.target)) suspend();
  };
  const onTouchMove = (event: TouchEvent) => {
    if (withinContent(event.target)) suspend();
  };
  const onPointerDown = (event: PointerEvent) => {
    if (!event.isPrimary || !withinContent(event.target)) return;
    pointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
  };
  const onPointerMove = (event: PointerEvent) => {
    if (!pointer || event.pointerId !== pointer.id) return;
    if (Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) >= 6) {
      pointer = null;
      suspend();
    }
  };
  const clearPointer = (event: PointerEvent) => {
    if (pointer?.id === event.pointerId) pointer = null;
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (!['ArrowDown', 'ArrowUp', 'End', 'Home', 'PageDown', 'PageUp', ' '].includes(event.key)) {
      return;
    }
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('a, button, input, select, textarea, [contenteditable="true"]')) {
      return;
    }
    const shell = document.querySelector('.remux-markdown-content-shell');
    if (shell && (!target || target === document.body || shell.contains(target))) suspend();
  };

  document.addEventListener('keydown', onKeyDown, { capture: true });
  document.addEventListener('pointercancel', clearPointer, { capture: true });
  document.addEventListener('pointerdown', onPointerDown, { capture: true, passive: true });
  document.addEventListener('pointermove', onPointerMove, { capture: true, passive: true });
  document.addEventListener('pointerup', clearPointer, { capture: true });
  document.addEventListener('touchmove', onTouchMove, { capture: true, passive: true });
  document.addEventListener('wheel', onWheel, { capture: true, passive: true });

  return () => {
    focusedIntentId = 0;
    document.removeEventListener('keydown', onKeyDown, { capture: true });
    document.removeEventListener('pointercancel', clearPointer, { capture: true });
    document.removeEventListener('pointerdown', onPointerDown, { capture: true });
    document.removeEventListener('pointermove', onPointerMove, { capture: true });
    document.removeEventListener('pointerup', clearPointer, { capture: true });
    document.removeEventListener('touchmove', onTouchMove, { capture: true });
    document.removeEventListener('wheel', onWheel, { capture: true });
  };
}
