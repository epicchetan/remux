import { useLayoutEffect, useRef, type RefCallback } from 'react';

import type { CodexNarrationTextTarget } from '../../shared/narration';

export type NarrationTextLeaf = {
  assistantMessageId: string;
  blockId: string;
  displayEnd: number;
  displayStart: number;
  textEnd: number;
  textNode: Text;
  textStart: number;
};

type ResolvedTextPaint = {
  ranges: Range[];
};

const leavesByBlock = new Map<string, Set<NarrationTextLeaf>>();
const listeners = new Set<() => void>();
let diagnosticCount = 0;

function blockKey(assistantMessageId: string, blockId: string) {
  return `${assistantMessageId}\0${blockId}`;
}

export function registerNarrationTextLeaf(leaf: NarrationTextLeaf) {
  const key = blockKey(leaf.assistantMessageId, leaf.blockId);
  const leaves = leavesByBlock.get(key) ?? new Set<NarrationTextLeaf>();
  leaves.add(leaf);
  leavesByBlock.set(key, leaves);
  notifyListeners();
  return () => {
    leaves.delete(leaf);
    if (leaves.size === 0) leavesByBlock.delete(key);
    notifyListeners();
  };
}

export function subscribeNarrationTextLeaves(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function resolveNarrationTextPaint(
  assistantMessageId: string,
  target: CodexNarrationTextTarget,
): ResolvedTextPaint {
  const leaves = [...(leavesByBlock.get(blockKey(assistantMessageId, target.blockId)) ?? [])]
    .filter((leaf) => leaf.textNode.isConnected)
    .sort((left, right) => left.displayStart - right.displayStart || left.displayEnd - right.displayEnd);
  const ranges: Range[] = [];
  for (const leaf of leaves) {
    const displayStart = Math.max(target.displayStart, leaf.displayStart);
    const displayEnd = Math.min(target.displayEnd, leaf.displayEnd);
    if (displayEnd <= displayStart) continue;
    const start = leaf.textStart + displayStart - leaf.displayStart;
    const end = leaf.textStart + displayEnd - leaf.displayStart;
    if (start < leaf.textStart || end > leaf.textEnd || end <= start) continue;
    const range = document.createRange();
    range.setStart(leaf.textNode, start);
    range.setEnd(leaf.textNode, end);
    ranges.push(range);
  }
  return { ranges };
}

export function useNarrationTextLeafRegistration({
  assistantMessageId,
  blockId,
  displayEnd,
  displayStart,
  expectedText,
}: {
  assistantMessageId: string | null;
  blockId: string;
  displayEnd: number;
  displayStart: number;
  expectedText: string;
}) {
  const textElementRef = useRef<HTMLElement | null>(null);
  const setTextElement: RefCallback<HTMLElement> = (element) => {
    textElementRef.current = element;
  };

  useLayoutEffect(() => {
    const element = textElementRef.current;
    if (!assistantMessageId || !element) return;
    const textNode = [...element.childNodes].find((node): node is Text => node.nodeType === Node.TEXT_NODE) ?? null;
    if (!textNode || textNode.data !== expectedText) {
      if (import.meta.env.DEV && diagnosticCount < 20) {
        diagnosticCount += 1;
        console.warn('[codex:narration] Markdown text leaf did not expose the expected stable text node', {
          blockId,
          displayEnd,
          displayStart,
        });
      }
      return;
    }
    return registerNarrationTextLeaf({
      assistantMessageId,
      blockId,
      displayEnd,
      displayStart,
      textEnd: textNode.data.length,
      textNode,
      textStart: 0,
    });
  }, [assistantMessageId, blockId, displayEnd, displayStart, expectedText]);

  return { setTextElement };
}

function notifyListeners() {
  for (const listener of listeners) listener();
}
