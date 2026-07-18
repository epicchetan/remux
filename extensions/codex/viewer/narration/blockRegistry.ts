import { useCallback, useRef } from 'react';

const blocks = new Map<string, Set<HTMLElement>>();
const listeners = new Set<() => void>();

function registryKey(assistantMessageId: string, blockId: string) {
  return `${assistantMessageId}\0${blockId}`;
}

export function registerNarrationBlocks(
  assistantMessageId: string,
  blockIds: string[],
  element: HTMLElement | null,
) {
  for (const blockId of blockIds) {
    const key = registryKey(assistantMessageId, blockId);
    if (element) {
      const elements = blocks.get(key) ?? new Set<HTMLElement>();
      elements.add(element);
      blocks.set(key, elements);
    }
  }
  notifyListeners();
}

export function unregisterNarrationBlocks(
  assistantMessageId: string,
  blockIds: string[],
  element: HTMLElement,
) {
  for (const blockId of blockIds) {
    const key = registryKey(assistantMessageId, blockId);
    const elements = blocks.get(key);
    elements?.delete(element);
    if (elements?.size === 0) blocks.delete(key);
  }
  notifyListeners();
}

export function useNarrationBlockRef(assistantMessageId: string | null, blockIds: string[]) {
  const previousRef = useRef<{ blockIds: string[]; element: HTMLElement; messageId: string } | null>(null);
  const blockKey = blockIds.join('\0');
  return useCallback((element: HTMLElement | null) => {
    const previous = previousRef.current;
    if (previous) {
      unregisterNarrationBlocks(previous.messageId, previous.blockIds, previous.element);
      previousRef.current = null;
    }
    if (assistantMessageId && element && blockIds.length > 0) {
      registerNarrationBlocks(assistantMessageId, blockIds, element);
      previousRef.current = { blockIds, element, messageId: assistantMessageId };
    }
  }, [assistantMessageId, blockKey]);
}

export function resolveNarrationBlockElements(assistantMessageId: string, blockIds: string[]) {
  const elements: HTMLElement[] = [];
  const seen = new Set<HTMLElement>();
  for (const blockId of blockIds) {
    const candidates = [...(blocks.get(registryKey(assistantMessageId, blockId)) ?? [])]
      .filter((element) => element.isConnected)
      .sort((left, right) => {
        const leftBounds = left.getBoundingClientRect();
        const rightBounds = right.getBoundingClientRect();
        return leftBounds.width * leftBounds.height - rightBounds.width * rightBounds.height;
      });
    const element = candidates[0];
    if (element && !seen.has(element)) {
      seen.add(element);
      elements.push(element);
    }
  }
  return elements;
}

export function subscribeNarrationBlocks(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notifyListeners() {
  for (const listener of listeners) listener();
}
