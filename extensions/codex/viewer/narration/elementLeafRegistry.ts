import { useLayoutEffect, useRef, type RefCallback } from 'react';

export type NarrationElementLeaf = {
  assistantMessageId: string;
  blockId: string;
  displayEnd: number;
  displayStart: number;
  element: HTMLElement;
};

const leavesByBlock = new Map<string, Set<NarrationElementLeaf>>();
const listeners = new Set<() => void>();

function blockKey(assistantMessageId: string, blockId: string) {
  return assistantMessageId + '\0' + blockId;
}

export function registerNarrationElementLeaf(leaf: NarrationElementLeaf) {
  const key = blockKey(leaf.assistantMessageId, leaf.blockId);
  const leaves = leavesByBlock.get(key) ?? new Set<NarrationElementLeaf>();
  leaves.add(leaf);
  leavesByBlock.set(key, leaves);
  notifyListeners();
  return () => {
    leaves.delete(leaf);
    if (leaves.size === 0) leavesByBlock.delete(key);
    notifyListeners();
  };
}

export function subscribeNarrationElementLeaves(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function resolveNarrationElementPaint(
  assistantMessageId: string,
  target: { blockId: string; textEnd: number; textStart: number },
) {
  return [...(leavesByBlock.get(blockKey(assistantMessageId, target.blockId)) ?? [])]
    .filter((leaf) => (
      leaf.element.isConnected &&
      Math.min(target.textEnd, leaf.displayEnd) > Math.max(target.textStart, leaf.displayStart)
    ))
    .sort((left, right) => left.displayStart - right.displayStart)
    .map((leaf) => leaf.element);
}

export function useNarrationElementLeafRegistration({
  assistantMessageId,
  blockId,
  displayEnd,
  displayStart,
}: {
  assistantMessageId: string | null;
  blockId: string;
  displayEnd: number;
  displayStart: number;
}) {
  const elementRef = useRef<HTMLElement | null>(null);
  const setElement: RefCallback<HTMLElement> = (element) => {
    elementRef.current = element;
  };

  useLayoutEffect(() => {
    const element = elementRef.current;
    if (!assistantMessageId || !element) return;
    return registerNarrationElementLeaf({
      assistantMessageId,
      blockId,
      displayEnd,
      displayStart,
      element,
    });
  }, [assistantMessageId, blockId, displayEnd, displayStart]);

  return { setElement };
}

function notifyListeners() {
  for (const listener of listeners) listener();
}
