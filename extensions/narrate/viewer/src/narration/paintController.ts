import type { NarrationSentence, NarrationWordCue } from '@remux/narration-client';

import { useNarrationStore } from './client';
import {
  getNarrationDomSnapshot,
  subscribeNarrationDom,
  type NarrationDomBlock,
  type NarrationDomLeaf,
} from './domIndex';
import { focusNarration } from './followController';
import { setNarrationPaintSnapshot } from './paintSnapshot';

type PaintKind = 'context' | 'word';

class NarrationPaintController {
  private activeBlock: HTMLElement | null = null;
  private currentKey = '';
  private layer: HTMLElement | null = null;
  private resizeObserver = new ResizeObserver(() => this.schedule(true));
  private scheduledFrame = 0;

  sync(force = false) {
    const state = useNarrationStore.getState();
    const dom = getNarrationDomSnapshot();
    const sentence = state.currentSentence;
    const word = state.currentWordCue;
    const targetMatches = Boolean(
      state.target
      && dom.status === 'ready'
      && dom.sourceHash === state.target.sourceHash,
    );
    const key = [
      state.artifactKey ?? '',
      targetMatches ? dom.sourceHash ?? '' : '',
      sentence?.id ?? '',
      word ? `${word.textStart}:${word.textEnd}` : '',
      state.focusIntent?.id ?? 0,
    ].join('\0');
    if (!force && key === this.currentKey) {
      return;
    }
    this.currentKey = key;
    this.clear();
    if (!targetMatches || !state.artifact || !sentence) {
      return;
    }
    const block = dom.blocks.get(sentence.blockId);
    if (!block) {
      return;
    }

    const hasWords = state.artifact.wordCues.some((cue) => cue.sentenceId === sentence.id);
    const focusRects = block.model.highlightMode === 'block' || !hasWords
      ? this.paintStructuralBlock(block, sentence)
      : this.paintTextBlock(block, sentence, word);
    const visibleRects = focusRects.filter((rect) => rect.width > 0 || rect.height > 0);
    const fallback = block.surface.getBoundingClientRect();
    const targetRects = visibleRects.length > 0 ? visibleRects : [fallback];
    focusNarration({
      block: block.surface,
      bounds: {
        bottom: Math.max(...targetRects.map((rect) => rect.bottom)),
        top: Math.min(...targetRects.map((rect) => rect.top)),
      },
      followEnabled: state.followEnabled,
      intent: state.focusIntent,
    });
  }

  destroy() {
    if (this.scheduledFrame) {
      window.cancelAnimationFrame(this.scheduledFrame);
      this.scheduledFrame = 0;
    }
    this.resizeObserver.disconnect();
    this.clear();
  }

  schedule(force = false) {
    if (this.scheduledFrame) {
      return;
    }
    this.scheduledFrame = window.requestAnimationFrame(() => {
      this.scheduledFrame = 0;
      this.sync(force);
    });
  }

  private paintStructuralBlock(block: NarrationDomBlock, sentence: NarrationSentence) {
    this.activeBlock = block.surface;
    block.surface.classList.add('remux-markdown-narration-block-active');
    this.resizeObserver.observe(block.surface);
    setNarrationPaintSnapshot({
      blockId: block.model.id,
      sentenceId: sentence.id,
      wordRange: null,
    });
    return [block.surface.getBoundingClientRect()];
  }

  private paintTextBlock(
    block: NarrationDomBlock,
    sentence: NarrationSentence,
    word: NarrationWordCue | null,
  ) {
    const contextRanges = resolveCueRanges(block, sentence.textStart, sentence.textEnd);
    const wordRanges = word && word.sentenceId === sentence.id
      ? resolveCueRanges(block, word.textStart, word.textEnd)
      : [];
    const contextRects = visibleRangeRects(contextRanges);
    const wordRects = visibleRangeRects(wordRanges);
    const layer = document.createElement('span');
    layer.className = 'remux-markdown-narration-paint-layer';
    layer.setAttribute('aria-hidden', 'true');
    block.element.classList.add('remux-markdown-narration-text-active');
    block.element.append(layer);
    const blockRect = block.element.getBoundingClientRect();
    appendRangePaint(layer, blockRect, contextRects, 'context');
    appendRangePaint(layer, blockRect, wordRects, 'word');
    this.activeBlock = block.element;
    this.layer = layer;
    this.resizeObserver.observe(block.element);
    setNarrationPaintSnapshot({
      blockId: block.model.id,
      sentenceId: sentence.id,
      wordRange: word ? `${word.textStart}:${word.textEnd}` : null,
    });
    return wordRects.length > 0 ? wordRects : contextRects;
  }

  private clear() {
    this.resizeObserver.disconnect();
    this.layer?.remove();
    this.layer = null;
    if (this.activeBlock) {
      this.activeBlock.classList.remove(
        'remux-markdown-narration-block-active',
        'remux-markdown-narration-text-active',
      );
    }
    this.activeBlock = null;
    setNarrationPaintSnapshot({
      blockId: null,
      sentenceId: null,
      wordRange: null,
    });
  }
}

export function installNarrationPaintController() {
  const controller = new NarrationPaintController();
  const unsubscribeStore = useNarrationStore.subscribe(() => controller.sync());
  const unsubscribeDom = subscribeNarrationDom(() => controller.schedule(true));
  const onViewportChange = () => controller.schedule(true);
  window.addEventListener('resize', onViewportChange);
  void document.fonts?.ready.then(() => controller.schedule(true));
  controller.sync();
  return () => {
    unsubscribeStore();
    unsubscribeDom();
    window.removeEventListener('resize', onViewportChange);
    controller.destroy();
  };
}

function resolveCueRanges(block: NarrationDomBlock, start: number, end: number) {
  if (start < 0 || end <= start || end > block.model.text.length) {
    return [];
  }
  const ranges: Range[] = [];
  for (const leaf of block.leaves) {
    const intersectionStart = Math.max(start, leaf.start);
    const intersectionEnd = Math.min(end, leaf.end);
    if (intersectionEnd <= intersectionStart) {
      continue;
    }
    const range = rangeForLeaf(
      leaf,
      intersectionStart - leaf.start,
      intersectionEnd - leaf.start,
    );
    if (range) {
      ranges.push(range);
    }
  }
  return ranges;
}

function rangeForLeaf(leaf: NarrationDomLeaf, start: number, end: number) {
  const range = document.createRange();
  if (leaf.kind === 'element') {
    range.selectNode(leaf.element);
    return range;
  }
  const startBoundary = textBoundary(leaf.element, start);
  const endBoundary = textBoundary(leaf.element, end);
  if (!startBoundary || !endBoundary) {
    return null;
  }
  range.setStart(startBoundary.node, startBoundary.offset);
  range.setEnd(endBoundary.node, endBoundary.offset);
  return range;
}

function textBoundary(element: HTMLElement, offset: number) {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let remaining = offset;
  let node = walker.nextNode();
  while (node) {
    const length = node.textContent?.length ?? 0;
    if (remaining <= length) {
      return { node, offset: remaining };
    }
    remaining -= length;
    node = walker.nextNode();
  }
  return null;
}

function appendRangePaint(
  layer: HTMLElement,
  blockRect: DOMRect,
  rects: DOMRect[],
  kind: PaintKind,
) {
  for (const rect of rects) {
    const paint = document.createElement('span');
    paint.className = `remux-markdown-narration-${kind}-rect`;
    paint.style.height = `${rect.height}px`;
    paint.style.transform = `translate3d(${rect.left - blockRect.left}px, ${rect.top - blockRect.top}px, 0)`;
    paint.style.width = `${rect.width}px`;
    layer.append(paint);
  }
}

function visibleRangeRects(ranges: Range[]) {
  return ranges.flatMap((range) => [...range.getClientRects()])
    .filter((rect) => rect.width > 0 && rect.height > 0);
}
