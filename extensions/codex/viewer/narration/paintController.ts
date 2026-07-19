import { focusTranscriptNarration } from '../transcript/viewportStore';
import { useNarrationStore, type NarrationFocusReason } from './client';
import {
  resolveNarrationBlockElements,
  subscribeNarrationBlocks,
} from './blockRegistry';
import {
  resolveNarrationTextPaint,
  subscribeNarrationTextLeaves,
} from './textLeafRegistry';

export const NARRATION_PAINT_RENDERER_VERSION = '5';

type OverlayPaint = {
  kind: 'context' | 'word';
  rect: DOMRect;
};

type FocusIntent = {
  id: number;
  reason: NarrationFocusReason;
};

class NarrationPaintController {
  private appliedClasses = new Map<HTMLElement, Set<string>>();
  private appliedOverlayLayers = new Set<HTMLElement>();
  private currentKey = '';
  private focusedIntentId = 0;
  private frame = 0;
  private requestToken = 0;

  sync(force = false) {
    const state = useNarrationStore.getState();
    const sentence = state.currentSentence;
    const word = state.currentWordCue;
    const key = [
      state.artifactKey ?? '',
      state.target?.assistantMessageId ?? '',
      sentence?.id ?? '',
      word ? `${word.textStart}:${word.textEnd}` : '',
      state.focusIntent?.id ?? 0,
    ].join('\0');
    if (!force && key === this.currentKey) return;
    this.currentKey = key;
    this.requestToken += 1;
    const token = this.requestToken;
    this.clearPaint();
    if (!state.target || !state.artifact || !sentence) return;
    this.paint(token, state.focusIntent);
  }

  scheduleRetry() {
    if (this.frame) return;
    this.frame = window.requestAnimationFrame(() => {
      this.frame = 0;
      this.sync(true);
    });
  }

  destroy() {
    this.requestToken += 1;
    if (this.frame) window.cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.clearPaint();
  }

  private paint(
    token: number,
    focusIntent: FocusIntent | null,
  ) {
    const state = useNarrationStore.getState();
    const { artifact, currentSentence: sentence, currentWordCue: word, target } = state;
    if (!artifact || !sentence || !target || token !== this.requestToken) return;
    const sentenceHasWords = artifact.wordCues.some((cue) => cue.sentenceId === sentence.id);
    const rects: DOMRect[] = [];

    if (sentenceHasWords) {
      const context = resolveNarrationTextPaint(target.assistantMessageId, sentence);
      const foreground = word && word.sentenceId === sentence.id
        ? resolveNarrationTextPaint(target.assistantMessageId, word)
        : { ranges: [] };
      this.paintTextOverlays(context.ranges, foreground.ranges);
      rects.push(...foreground.ranges.flatMap((range) => [...range.getClientRects()]));
      if (rects.length === 0) {
        rects.push(...context.ranges.flatMap((range) => [...range.getClientRects()]));
      }
    } else {
      for (const frame of resolveNarrationBlockElements(target.assistantMessageId, [sentence.blockId])) {
        const surface = narrationSurface(frame);
        this.addClass(surface, 'codex-md-structural-target-narrating');
        rects.push(surface.getBoundingClientRect());
      }
    }

    const visibleRects = rects.filter((rect) => rect.width > 0 || rect.height > 0);
    if (visibleRects.length === 0) {
      focusTranscriptNarration({
        assistantMessageId: target.assistantMessageId,
        materializeOnly: true,
        reason: focusIntent?.reason ?? 'follow',
        blockIds: [sentence.blockId],
        threadId: target.threadId,
        turnId: target.turnId,
      });
      return;
    }
    if (
      focusIntent &&
      focusIntent.id !== this.focusedIntentId &&
      token === this.requestToken
    ) {
      this.focusedIntentId = focusIntent.id;
      focusTranscriptNarration({
        assistantMessageId: target.assistantMessageId,
        bounds: {
          bottom: Math.max(...visibleRects.map((rect) => rect.bottom)),
          top: Math.min(...visibleRects.map((rect) => rect.top)),
        },
        reason: focusIntent.reason,
        blockIds: [sentence.blockId],
        threadId: target.threadId,
        turnId: target.turnId,
      });
    }
  }

  private paintTextOverlays(contextRanges: Range[], wordRanges: Range[]) {
    const paintsByFrame = new Map<HTMLElement, OverlayPaint[]>();
    for (const range of contextRanges) {
      const frame = blockFrameForRange(range);
      if (!frame) continue;
      for (const rect of range.getClientRects()) {
        if (rect.width <= 0 || rect.height <= 0) continue;
        addOverlayPaint(paintsByFrame, frame, { kind: 'context', rect });
      }
    }
    for (const range of wordRanges) {
      const frame = blockFrameForRange(range);
      if (!frame) continue;
      for (const rect of range.getClientRects()) {
        if (rect.width <= 0 || rect.height <= 0) continue;
        addOverlayPaint(paintsByFrame, frame, { kind: 'word', rect });
      }
    }
    for (const [frame, paints] of paintsByFrame) {
      const layer = narrationPaintLayer(frame);
      if (!layer) continue;
      const frameRect = frame.getBoundingClientRect();
      const fragment = document.createDocumentFragment();
      for (const paint of paints.sort((left, right) => paintOrder(left.kind) - paintOrder(right.kind))) {
        const rectangle = document.createElement('div');
        rectangle.className = `codex-narration-${paint.kind}-rect`;
        rectangle.dataset.narrationPaint = paint.kind;
        rectangle.style.height = `${paint.rect.height}px`;
        rectangle.style.transform = `translate3d(${paint.rect.left - frameRect.left}px, ${paint.rect.top - frameRect.top}px, 0)`;
        rectangle.style.width = `${paint.rect.width}px`;
        fragment.append(rectangle);
      }
      layer.replaceChildren(fragment);
      layer.hidden = false;
      this.appliedOverlayLayers.add(layer);
    }
  }

  private addClass(element: HTMLElement, className: string) {
    element.classList.add(className);
    const classes = this.appliedClasses.get(element) ?? new Set<string>();
    classes.add(className);
    this.appliedClasses.set(element, classes);
  }

  private clearPaint() {
    for (const layer of this.appliedOverlayLayers) {
      layer.replaceChildren();
      layer.hidden = true;
    }
    this.appliedOverlayLayers.clear();
    for (const [element, classes] of this.appliedClasses) {
      for (const className of classes) element.classList.remove(className);
    }
    this.appliedClasses.clear();
  }
}

export function installNarrationPaintController() {
  const controller = new NarrationPaintController();
  const unsubscribeStore = useNarrationStore.subscribe(() => controller.sync());
  const unsubscribeBlocks = subscribeNarrationBlocks(() => controller.scheduleRetry());
  const unsubscribeLeaves = subscribeNarrationTextLeaves(() => controller.scheduleRetry());
  controller.sync();
  return () => {
    unsubscribeStore();
    unsubscribeBlocks();
    unsubscribeLeaves();
    controller.destroy();
  };
}

function narrationSurface(element: HTMLElement) {
  if (element.dataset.narrationSurface) return element;
  return element.querySelector<HTMLElement>('[data-narration-surface]') ?? element;
}

function blockFrameForRange(range: Range) {
  const common = range.commonAncestorContainer;
  const element = common instanceof HTMLElement ? common : common.parentElement;
  return element?.closest<HTMLElement>('.codex-md-block-frame') ?? null;
}

function narrationPaintLayer(frame: HTMLElement) {
  return [...frame.children].find((child): child is HTMLElement => (
    child instanceof HTMLElement && child.classList.contains('codex-narration-paint-layer')
  )) ?? null;
}

function addOverlayPaint(
  paintsByFrame: Map<HTMLElement, OverlayPaint[]>,
  frame: HTMLElement,
  paint: OverlayPaint,
) {
  const paints = paintsByFrame.get(frame) ?? [];
  paints.push(paint);
  paintsByFrame.set(frame, paints);
}

function paintOrder(kind: OverlayPaint['kind']) {
  return kind === 'context' ? 0 : 1;
}
