import type { CodexNarrationSourceTarget } from '../../shared/narration';
import { focusTranscriptNarration } from '../transcript/viewportStore';
import { useNarrationStore } from './store';
import {
  resolveNarrationTargetElements,
  subscribeNarrationTargets,
} from './targetRegistry';
import {
  resolveNarrationTextPaint,
  subscribeNarrationTextLeaves,
} from './textLeafRegistry';

export const NARRATION_PAINT_RENDERER_VERSION = '4';

type OverlayPaint = {
  kind: 'context' | 'word';
  rect: DOMRect;
};

class NarrationPaintController {
  private appliedClasses = new Map<HTMLElement, Set<string>>();
  private appliedOverlayLayers = new Set<HTMLElement>();
  private currentKey = '';
  private frame = 0;
  private indexedManifest: object | null = null;
  private indexedTargets = new Map<string, CodexNarrationSourceTarget>();
  private requestToken = 0;

  constructor() {
    void NARRATION_PAINT_RENDERER_VERSION;
  }

  sync(force = false) {
    const state = useNarrationStore.getState();
    const messageId = state.target?.assistantMessageId ?? '';
    const key = [
      state.artifactKey ?? '',
      messageId,
      state.focusIntent?.id ?? 0,
      ...state.currentTargetIds,
    ].join('\0');
    if (!force && key === this.currentKey) return;
    this.currentKey = key;
    this.requestToken += 1;
    const token = this.requestToken;
    this.clearPaint();
    if (!state.target || !state.manifest || state.currentTargetIds.length === 0) return;
    this.paint(token, state.focusIntent?.reason ?? null);
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
    focusReason: 'explicitSeek' | 'explicitSeekInPlace' | 'follow' | 'followReenabled' | null,
  ) {
    const state = useNarrationStore.getState();
    const { manifest, target } = state;
    if (!manifest || !target || token !== this.requestToken) return;
    if (this.indexedManifest !== manifest) {
      this.indexedManifest = manifest;
      this.indexedTargets = new Map(manifest.targets.map((candidate) => [candidate.id, candidate]));
    }
    const selected = state.currentTargetIds
      .map((id) => this.indexedTargets.get(id))
      .filter((candidate): candidate is CodexNarrationSourceTarget => Boolean(candidate));
    const targets = primaryTargets(selected, state.currentCue?.granularity ?? null);
    if (targets.length === 0) return;

    const ranges: Range[] = [];
    const geometryElements = new Set<HTMLElement>();
    const proseContextElements = new Set<HTMLElement>();
    for (const sourceTarget of targets) {
      if (sourceTarget.kind === 'textRange') {
        const resolved = resolveNarrationTextPaint(target.assistantMessageId, sourceTarget);
        const contextElements = this.paintProseContext(
          target.assistantMessageId,
          manifest.targets,
          sourceTarget.blockId,
          resolved.ranges,
        );
        ranges.push(...resolved.ranges);
        for (const element of contextElements) proseContextElements.add(element);
        if (resolved.ranges.length === 0) {
          for (const element of contextElements) geometryElements.add(element);
        }
        continue;
      }
      const elements = resolveNarrationTargetElements(target.assistantMessageId, [sourceTarget.id]);
      for (const element of elements) geometryElements.add(element);
      switch (sourceTarget.kind) {
        case 'block':
          for (const element of elements) {
            const surface = narrationSurface(element);
            if (surface.dataset.narrationSurface === 'prose') {
              proseContextElements.add(surface);
            } else {
              this.addClass(surface, 'codex-md-structural-target-narrating');
            }
            geometryElements.delete(element);
            geometryElements.add(surface);
          }
          break;
        case 'codeLines':
          for (const element of elements) this.addClass(element, 'codex-md-code-line-narrating');
          break;
        case 'diagramNode':
          for (const element of elements) this.addClass(element, 'codex-md-diagram-node-narrating');
          break;
        case 'tableCell':
          for (const element of elements) {
            this.addClass(element, 'codex-md-table-cell-narrating');
            this.addClass(element, 'codex-md-table-cell-edge-top');
            this.addClass(element, 'codex-md-table-cell-edge-right');
            this.addClass(element, 'codex-md-table-cell-edge-bottom');
            this.addClass(element, 'codex-md-table-cell-edge-left');
          }
          break;
        case 'tableRegion':
          for (const element of elements) {
            this.addClass(element, 'codex-md-table-cell-narrating');
            const row = Number(element.dataset.narrationRow);
            const column = Number(element.dataset.narrationColumn);
            if (row === sourceTarget.rowStart) this.addClass(element, 'codex-md-table-cell-edge-top');
            if (column === sourceTarget.columnEnd) this.addClass(element, 'codex-md-table-cell-edge-right');
            if (row === sourceTarget.rowEnd) this.addClass(element, 'codex-md-table-cell-edge-bottom');
            if (column === sourceTarget.columnStart) this.addClass(element, 'codex-md-table-cell-edge-left');
          }
          break;
      }
    }
    this.paintTextOverlays(ranges, proseContextElements);

    const rects = [
      ...ranges.flatMap((range) => [...range.getClientRects()]),
      ...[...geometryElements].map((element) => element.getBoundingClientRect()),
    ].filter((rect) => rect.width > 0 || rect.height > 0);
    const blockTargetIds = blockTargetsFor(targets, manifest.targets);
    if (rects.length === 0) {
      if (blockTargetIds.length > 0) {
        focusTranscriptNarration({
          assistantMessageId: target.assistantMessageId,
          materializeOnly: true,
          reason: focusReason ?? 'follow',
          targetIds: blockTargetIds,
          threadId: target.threadId,
          turnId: target.turnId,
        });
      }
      return;
    }
    if (focusReason && blockTargetIds.length > 0 && token === this.requestToken) {
      focusTranscriptNarration({
        assistantMessageId: target.assistantMessageId,
        bounds: {
          bottom: Math.max(...rects.map((rect) => rect.bottom)),
          top: Math.min(...rects.map((rect) => rect.top)),
        },
        reason: focusReason,
        targetIds: blockTargetIds,
        threadId: target.threadId,
        turnId: target.turnId,
      });
    }
  }

  private paintProseContext(
    assistantMessageId: string,
    targets: CodexNarrationSourceTarget[],
    blockId: string,
    ranges: Range[],
  ) {
    const surfaces = new Set<HTMLElement>();
    for (const range of ranges) {
      const surface = proseSurfaceForRange(range);
      if (surface) surfaces.add(surface);
    }
    if (surfaces.size === 0) {
      const blockTarget = targets.find((candidate) => candidate.kind === 'block' && candidate.blockId === blockId);
      if (blockTarget) {
        for (const frame of resolveNarrationTargetElements(assistantMessageId, [blockTarget.id])) {
          const surface = narrationSurface(frame);
          if (surface.dataset.narrationSurface === 'prose') surfaces.add(surface);
        }
      }
    }
    return [...surfaces];
  }

  private paintTextOverlays(ranges: Range[], contextElements: Set<HTMLElement>) {
    const paintsByFrame = new Map<HTMLElement, OverlayPaint[]>();
    for (const element of contextElements) {
      const frame = element.closest<HTMLElement>('.codex-md-block-frame');
      if (!frame) continue;
      addOverlayPaint(paintsByFrame, frame, {
        kind: 'context',
        rect: element.getBoundingClientRect(),
      });
    }
    for (const range of ranges) {
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
  const unsubscribeTargets = subscribeNarrationTargets(() => controller.scheduleRetry());
  const unsubscribeLeaves = subscribeNarrationTextLeaves(() => controller.scheduleRetry());
  controller.sync();
  return () => {
    unsubscribeStore();
    unsubscribeTargets();
    unsubscribeLeaves();
    controller.destroy();
  };
}

function blockTargetsFor(
  activeTargets: CodexNarrationSourceTarget[],
  sourceTargets: CodexNarrationSourceTarget[],
) {
  const blockIds = new Set(activeTargets.map((target) => target.blockId));
  return sourceTargets
    .filter((target) => target.kind === 'block' && blockIds.has(target.blockId))
    .map((target) => target.id);
}

function primaryTargets(
  targets: CodexNarrationSourceTarget[],
  granularity: string | null,
) {
  const matching = targets.filter((target) => {
    switch (granularity) {
      case 'word':
      case 'expression':
        return target.kind === 'textRange';
      case 'codeLines':
        return target.kind === 'codeLines';
      case 'diagramNode':
        return target.kind === 'diagramNode';
      case 'tableCell':
        return target.kind === 'tableCell';
      case 'tableRegion':
        return target.kind === 'tableRegion';
      case 'block':
        return target.kind === 'block';
      default:
        return target.kind !== 'block';
    }
  });
  if (matching.length > 0) return matching;
  const precise = targets.filter((target) => target.kind !== 'block');
  return precise.length > 0 ? precise : targets;
}

function narrationSurface(element: HTMLElement) {
  if (element.dataset.narrationSurface) return element;
  return element.querySelector<HTMLElement>('[data-narration-surface]') ?? element;
}

function proseSurfaceForRange(range: Range) {
  const common = range.commonAncestorContainer;
  const element = common instanceof HTMLElement ? common : common.parentElement;
  return element?.closest<HTMLElement>('[data-narration-surface="prose"]') ?? null;
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
