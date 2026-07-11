import { useCallback, useRef } from 'react';

const targets = new Map<string, Set<HTMLElement>>();
const listeners = new Set<() => void>();

function registryKey(assistantMessageId: string, targetId: string) {
  return `${assistantMessageId}\0${targetId}`;
}

export function registerNarrationTargets(
  assistantMessageId: string,
  targetIds: string[],
  element: HTMLElement | null,
) {
  for (const targetId of targetIds) {
    const key = registryKey(assistantMessageId, targetId);
    if (element) {
      const elements = targets.get(key) ?? new Set<HTMLElement>();
      elements.add(element);
      targets.set(key, elements);
    }
  }
  notifyListeners();
}

export function unregisterNarrationTargets(
  assistantMessageId: string,
  targetIds: string[],
  element: HTMLElement,
) {
  for (const targetId of targetIds) {
    const key = registryKey(assistantMessageId, targetId);
    const elements = targets.get(key);
    elements?.delete(element);
    if (elements?.size === 0) targets.delete(key);
  }
  notifyListeners();
}

export function useNarrationTargetRef(assistantMessageId: string | null, targetIds: string[]) {
  const previousRef = useRef<{ element: HTMLElement; messageId: string; targetIds: string[] } | null>(null);
  const targetKey = targetIds.join('\0');
  return useCallback((element: HTMLElement | null) => {
    const previous = previousRef.current;
    if (previous) {
      unregisterNarrationTargets(previous.messageId, previous.targetIds, previous.element);
      previousRef.current = null;
    }
    if (assistantMessageId && element && targetIds.length > 0) {
      registerNarrationTargets(assistantMessageId, targetIds, element);
      previousRef.current = { element, messageId: assistantMessageId, targetIds };
    }
  }, [assistantMessageId, targetKey]);
}

export function resolveNarrationTargetElements(assistantMessageId: string, targetIds: string[]) {
  const elements: HTMLElement[] = [];
  const seen = new Set<HTMLElement>();
  for (const targetId of targetIds) {
    const candidates = [...(targets.get(registryKey(assistantMessageId, targetId)) ?? [])]
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

export function subscribeNarrationTargets(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notifyListeners() {
  for (const listener of listeners) listener();
}
